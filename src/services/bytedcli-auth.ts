/**
 * Per-person `bytedcli` authorization.
 *
 * ## Why this is not the Lark token store
 *
 * `bytedcli` authenticates against ByteCloud SSO — a different identity
 * provider from Lark OAuth, with no conversion between them. A person who has
 * run `/login` for Feishu is still unauthorized here, and vice versa. So they
 * authorize twice; that is a property of the two providers, not something
 * botmux can paper over.
 *
 * ## Why we store a HOME directory instead of a token
 *
 * `bytedcli` keeps its auth state under `$HOME/.local/share/bytedcli`, resolved
 * through `os.homedir()` at call time. Measured: with `HOME` pointed at an
 * empty directory, `bytedcli auth status` reports `not logged in` even while
 * the real user is logged in on the same machine. That makes `HOME` a genuine
 * isolation boundary — one directory per person, and neither the machine's own
 * login nor anyone else's is touched.
 *
 * The alternative — capturing the ByteCloud JWT at login and storing it — looks
 * simpler and is wrong. That JWT lives 2 hours, while the login behind it lives
 * about 3 weeks (a refresh token). Storing the JWT would make everyone re-scan
 * a QR code every 2 hours to renew something that had not actually expired.
 * Keeping the directory lets `bytedcli` mint a fresh JWT per call and refresh
 * it internally; a person is only interrupted when the 3-week login really ends.
 *
 * So: nothing in this module holds a credential. It holds a path, and shells
 * out to `bytedcli` with `HOME` set to it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import { isUsableOpenId } from '../utils/user-token.js';

/** Root under which each authorized person gets their own bytedcli HOME. */
const BYTEDCLI_HOME_ROOT = join(homedir(), '.botmux', 'data', 'bytedcli-home');

/** How long to wait on a `bytedcli` invocation. The device-code calls talk to
 *  ByteCloud, so they are network-bound; the JWT reads are usually local but
 *  may refresh. Generous enough not to fail a slow network, short enough that a
 *  wedged CLI cannot hold a turn open. */
const BYTEDCLI_TIMEOUT_MS = 30_000;

/** ByteCloud gives a device-code challenge about an hour; expire ours a little
 *  sooner so we never hand back a token that is about to be refused. */
const CHALLENGE_TTL_MS = 50 * 60_000;

/**
 * This person's private bytedcli HOME.
 *
 * Keyed by open_id, so two people on one bot never share auth state — the same
 * property the per-person Lark token files give, by the same reasoning.
 */
export function bytedcliHomeFor(openId: string): string {
  if (!isUsableOpenId(openId)) {
    // The value is concatenated into a filesystem path, so a `../`-shaped id
    // must not be able to redirect it at somebody else's directory.
    throw new Error(`[bytedcli-auth] unusable open_id: ${JSON.stringify(openId)}`);
  }
  return join(BYTEDCLI_HOME_ROOT, openId);
}

/** Whether this person has ever completed a bytedcli login here. Cheap enough
 *  to call per turn; says nothing about whether that login is still valid. */
export function hasBytedcliHome(openId: string): boolean {
  try { return existsSync(bytedcliHomeFor(openId)); } catch { return false; }
}

/** Forget one person's bytedcli authorization entirely. */
export function clearBytedcliAuth(openId: string): void {
  try { rmSync(bytedcliHomeFor(openId), { recursive: true, force: true }); }
  catch { /* best-effort: absence is the desired state */ }
}

export interface BytedcliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run `bytedcli` as one person.
 *
 * `HOME` is the whole mechanism. Everything else in the environment is
 * inherited, because bytedcli needs the usual PATH/proxy/site settings to reach
 * ByteCloud at all.
 */
async function runAsUser(openId: string, args: string[]): Promise<BytedcliResult> {
  const home = bytedcliHomeFor(openId);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return await new Promise<BytedcliResult>(resolve => {
    const child = spawn('bytedcli', args, {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += '\n[bytedcli-auth] timed out';
      finish(false);
    }, BYTEDCLI_TIMEOUT_MS);
    child.stdout.on('data', d => { stdout += String(d); });
    child.stderr.on('data', d => { stderr += String(d); });
    // A missing binary lands here, not on a non-zero exit.
    child.on('error', err => { stderr += `\n${err.message}`; finish(false); });
    child.on('close', code => finish(code === 0));
  });
}

/** Parse bytedcli's `--json` envelope, which wraps everything in {status,data}. */
function parseEnvelope(stdout: string): Record<string, unknown> | null {
  // `--begin` emits progress events (`qr_image_ready`) before the envelope, one
  // JSON object per line, so take the last parseable line rather than the first.
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && 'status' in parsed) return parsed;
    } catch { /* not the envelope line */ }
  }
  return null;
}

/**
 * Where a started-but-unfinished login's resume token lives.
 *
 * Inside that person's own HOME rather than a shared pending-login store: the
 * token resumes THEIR authorization, and keeping it beside the auth state it
 * belongs to means clearing one person's authorization clears their pending
 * login with it, and no lookup can hand it to anyone else.
 */
function challengePath(openId: string): string {
  return join(bytedcliHomeFor(openId), '.botmux-login-challenge');
}

/** The resume token from this person's in-progress login, if it is still
 *  usable. ByteCloud gives the challenge about an hour; we expire slightly
 *  earlier so a token we hand back is not rejected the moment it is used. */
export function pendingBytedcliChallenge(openId: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(challengePath(openId), 'utf8')) as
      { token?: unknown; createdAt?: unknown };
    if (typeof raw.token !== 'string' || typeof raw.createdAt !== 'number') return null;
    if (Date.now() - raw.createdAt > CHALLENGE_TTL_MS) return null;
    return raw.token;
  } catch { return null; }
}

function saveChallenge(openId: string, token: string): void {
  try {
    atomicWriteFileSync(
      challengePath(openId),
      JSON.stringify({ token, createdAt: Date.now() }),
      { mode: 0o600 },
    );
  } catch (e) {
    // Non-fatal: the person can still authorize, they just cannot resume with
    // `done` and will need a fresh link.
    logger.debug(`[bytedcli-auth] could not persist the login challenge: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function clearChallenge(openId: string): void {
  try { rmSync(challengePath(openId), { force: true }); } catch { /* already gone */ }
}

export interface BytedcliLoginChallenge {
  /** The page the person opens to authorize. */
  authUrl: string;
  /** Opaque token that resumes this login; valid about an hour. */
  completeToken: string;
}

/**
 * Start a login for one person and return the link to send them.
 *
 * Non-blocking (`--begin`): the CLI returns immediately with a resume token
 * instead of holding a terminal open waiting for a scan, which is the only
 * shape that works when the person authorizing is on the other side of a chat.
 */
export async function beginBytedcliLogin(openId: string): Promise<BytedcliLoginChallenge | null> {
  const { ok, stdout, stderr } = await runAsUser(openId, ['auth', 'login', '--begin', '--json']);
  const env = parseEnvelope(stdout);
  const data = env?.data as Record<string, unknown> | undefined;
  const authUrl = typeof data?.verification_uri_complete === 'string'
    ? data.verification_uri_complete
    : undefined;
  const completeToken = typeof data?.complete_token === 'string' ? data.complete_token : undefined;
  if (!ok || !authUrl || !completeToken) {
    logger.warn(`[bytedcli-auth] could not start a login: ${stderr.trim() || stdout.trim() || 'no output'}`);
    return null;
  }
  saveChallenge(openId, completeToken);
  return { authUrl, completeToken };
}

export type BytedcliLoginState = 'authorized' | 'pending' | 'failed';

/**
 * Try to finish a started login.
 *
 * `pending` means the person has not authorized yet — an ordinary state, not an
 * error, and the caller should say so rather than reporting a failure.
 */
export async function completeBytedcliLogin(
  openId: string,
  completeToken: string,
): Promise<{ state: BytedcliLoginState; detail?: string }> {
  const { ok, stdout, stderr } = await runAsUser(
    openId,
    ['auth', 'login', '--complete', completeToken, '--json'],
  );
  const env = parseEnvelope(stdout);
  const data = env?.data as Record<string, unknown> | undefined;
  if (ok && data?.status === 'pending') return { state: 'pending' };
  if (ok) { clearChallenge(openId); return { state: 'authorized' }; }
  const detail = (env?.error as Record<string, unknown> | undefined)?.message;
  return {
    state: 'failed',
    ...(typeof detail === 'string' ? { detail } : { detail: stderr.trim() || undefined }),
  };
}

export interface BytedcliJwts {
  cloudJwt: string;
  /** Git pushes authenticate with this one, so commit attribution follows it. */
  codeJwt?: string;
}

/**
 * Mint this person's JWTs for the current turn.
 *
 * Called per turn rather than cached because the ByteCloud JWT lives only ~2
 * hours while the login behind it lives ~3 weeks: `bytedcli` refreshes it
 * internally when it is expiring, so asking each time is what keeps a person
 * from being sent back to a QR code every couple of hours.
 *
 * Returns null when the person's login has ended (or never happened), which the
 * caller turns into the ordinary "authorize, then retry" refusal.
 */
export async function mintBytedcliJwts(openId: string): Promise<BytedcliJwts | null> {
  if (!hasBytedcliHome(openId)) return null;
  const cloud = await runAsUser(openId, ['auth', 'get-bytecloud-jwt-token']);
  const cloudJwt = cloud.stdout.trim();
  if (!cloud.ok || !cloudJwt) {
    logger.debug(`[bytedcli-auth] no ByteCloud JWT for ${openId}: ${cloud.stderr.trim() || 'empty output'}`);
    return null;
  }
  // The Codebase JWT is optional: without it lark/bytedcli calls still work and
  // only git attribution degrades, so a failure here must not deny the turn.
  const code = await runAsUser(openId, ['auth', 'get-codebase-jwt-token']);
  const codeJwt = code.ok ? code.stdout.trim() : '';
  if (!codeJwt) {
    logger.debug(`[bytedcli-auth] no Codebase JWT for ${openId}; git attribution will fall back`);
  }
  return { cloudJwt, ...(codeJwt ? { codeJwt } : {}) };
}
