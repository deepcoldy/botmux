/**
 * Per-person Meego login, shared by every session of that person.
 *
 * `bytedcli meego` runs the official meegle CLI, which keeps its login in
 * `$HOME/.meegle` (the OS home directory, no override). A trigger-user bytedcli
 * exec runs with a per-session scratch HOME (#2550), so a login made in one
 * session — typically the private chat the person was sent to — existed in that
 * session only: the group topic that needed it kept reporting `no local token`,
 * and the login disappeared when the session closed.
 *
 * The login now lives once per person, outside every session, in
 * `meegoHomeFor(openId)/.meegle`. Each bytedcli exec acting for that person
 * links its scratch `$HOME/.meegle` there (see renderIdentityWrapper), so every
 * session reads the same credentials and a token refresh is written back to the
 * same files — meegle serializes refreshes across processes with its own lock in
 * that directory. Another person's exec links their own directory.
 *
 * Logging in is botmux's job, not the agent's. The wrapper refuses a Meego call
 * that has no login and asks the daemon, which starts the device flow in this
 * directory and sends the link to the person privately. The next call after they
 * approve completes the saved challenge here, from whichever session it comes.
 *
 * The tenant (`dcar` or the default one) picks the meegle profile, so it comes
 * from the session that asked — the same flag, variable or saved setting its own
 * bytedcli call would have used — and is passed to bytedcli by environment. It
 * is never saved here.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import { parseEnvelope, runBytedcliInHome } from './bytedcli-auth.js';
import { ensureMeegoStore, meegoPersonRoot, MEEGO_STORE_DIR, MEEGO_TENANTS, type MeegoTenant } from './bytedcli-home.js';
import { readCliAuthEpoch } from './cli-auth-epoch.js';

/** Ours, under bytedcli's 30-minute challenge lifetime. The device code itself
 *  may expire sooner; bytedcli then reports it and a new one is started. */
const CHALLENGE_TTL_MS = 25 * 60_000;
const CHALLENGE_FILE = '.botmux-meego-challenge';

export type MeegoLoginRequest =
  /** The login works now; the refused call can simply run. */
  | { state: 'ready' }
  /** The person has to open `authUrl` (the same one until it expires). */
  | { state: 'link'; authUrl: string }
  | { state: 'unavailable'; detail: string };

interface SavedChallenge {
  token: string;
  authUrl: string;
  createdAt: number;
}

interface Ctx {
  home: string;
  tenant?: MeegoTenant;
}

function challengePath({ home, tenant }: Ctx): string {
  return join(home, tenant ? `${CHALLENGE_FILE}-${tenant}` : CHALLENGE_FILE);
}

function readChallenge(ctx: Ctx, now: number): SavedChallenge | null {
  try {
    const raw = JSON.parse(readFileSync(challengePath(ctx), 'utf8')) as Partial<SavedChallenge>;
    if (typeof raw.token !== 'string' || !raw.token || typeof raw.authUrl !== 'string' || !raw.authUrl
      || typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt) || raw.createdAt > now
      || now - raw.createdAt > CHALLENGE_TTL_MS) return null;
    return { token: raw.token, authUrl: raw.authUrl, createdAt: raw.createdAt };
  } catch { return null; }
}

function writeChallenge(ctx: Ctx, challenge: SavedChallenge): void {
  atomicWriteFileSync(challengePath(ctx), JSON.stringify(challenge), { mode: 0o600 });
}

function clearChallenge(ctx: Ctx): void {
  try { rmSync(challengePath(ctx), { force: true }); } catch { /* already gone */ }
}

function meegoEnv({ home, tenant }: Ctx): Record<string, string> {
  return {
    // `--begin` saves a QR image of the link under TMPDIR; keep it in this
    // person's 0700 HOME rather than the daemon's shared temp directory.
    TMPDIR: join(home, '.tmp'),
    // Empty is the default tenant, whatever the daemon's own environment says.
    BYTEDCLI_MEEGO_TENANT: tenant ?? '',
  };
}

async function runMeego(ctx: Ctx, args: string[]) {
  return await runBytedcliInHome(ctx.home, ['-j', 'meego', ...args], meegoEnv(ctx));
}

/** `authorized` only on the provider's own word; a file layout is not proof. */
async function loginStatus(ctx: Ctx): Promise<'authorized' | 'missing' | 'unavailable'> {
  if (!existsSync(join(ctx.home, MEEGO_STORE_DIR))) return 'missing';
  const envelope = parseEnvelope((await runMeego(ctx, ['status'])).stdout);
  const data = envelope?.data as Record<string, unknown> | undefined;
  const official = data?.official_meegle_cli_authenticated;
  const authenticated = typeof official === 'boolean' ? official : data?.authenticated;
  if (envelope?.status !== 'success' || typeof authenticated !== 'boolean') return 'unavailable';
  return authenticated ? 'authorized' : 'missing';
}

/** One poll of a saved challenge; never waits for the person. */
async function completeOnce(ctx: Ctx, token: string): Promise<'success' | 'pending' | 'gone' | 'error'> {
  // A deadline shorter than the poll interval: one poll, then MEEGO_LOGIN_TIMEOUT.
  const result = await runMeego(ctx, ['login', '--complete', token, '--max-wait-ms', '1000', '--poll-interval-ms', '2000']);
  const envelope = parseEnvelope(result.stdout);
  const data = envelope?.data as Record<string, unknown> | undefined;
  const code = (envelope?.error as Record<string, unknown> | undefined)?.code;
  if (envelope?.status === 'success' && data?.login_status === 'success') return 'success';
  if (envelope?.status === 'success' && data?.login_status === 'expired') return 'gone';
  if (code === 'MEEGO_LOGIN_TIMEOUT') return 'pending';
  if (code === 'MEEGO_LOGIN_CHALLENGE_NOT_FOUND' || code === 'MEEGO_LOGIN_CHALLENGE_INVALID') return 'gone';
  return 'error';
}

async function begin(ctx: Ctx, now: number): Promise<MeegoLoginRequest> {
  const result = await runMeego(ctx, ['login', '--begin']);
  const envelope = parseEnvelope(result.stdout);
  const data = envelope?.data as Record<string, unknown> | undefined;
  const authUrl = typeof data?.verification_uri_complete === 'string' ? data.verification_uri_complete : '';
  const token = typeof data?.complete_token === 'string' ? data.complete_token : '';
  // The image encodes the same link; nothing reads it.
  if (typeof data?.qr_image_path === 'string' && data.qr_image_path.startsWith(join(ctx.home, '.tmp'))) {
    try { rmSync(dirname(data.qr_image_path), { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (envelope?.status !== 'success' || !authUrl || !token) {
    logger.warn('[meego-auth] could not start a login; provider failed or returned an invalid challenge');
    return { state: 'unavailable', detail: 'Meego login could not be started.' };
  }
  writeChallenge(ctx, { token, authUrl, createdAt: now });
  return { state: 'link', authUrl };
}

async function attempt(ctx: Ctx, now: number): Promise<MeegoLoginRequest> {
  const pending = readChallenge(ctx, now);
  if (pending) {
    const outcome = await completeOnce(ctx, pending.token);
    if (outcome === 'success') {
      clearChallenge(ctx);
      if (await loginStatus(ctx) === 'authorized') return { state: 'ready' };
      return { state: 'unavailable', detail: 'Meego login completed but is not usable yet; retry shortly.' };
    }
    if (outcome === 'pending') return { state: 'link', authUrl: pending.authUrl };
    // A network error does not invalidate the link the person may be opening.
    if (outcome === 'error') return { state: 'unavailable', detail: 'Meego authorization service unavailable; retry shortly.' };
  }
  clearChallenge(ctx);
  const status = await loginStatus(ctx);
  if (status === 'authorized') return { state: 'ready' };
  if (status === 'unavailable') return { state: 'unavailable', detail: 'Meego status could not be read; retry shortly.' };
  return await begin(ctx, now);
}

async function request(openId: string, tenant: MeegoTenant | undefined, now: number): Promise<MeegoLoginRequest> {
  const epoch = readCliAuthEpoch(openId);
  const ctx: Ctx = { home: ensureMeegoStore(openId, epoch), tenant };
  const result = await attempt(ctx, now);
  if (readCliAuthEpoch(openId) === epoch) return result;
  // Revoked meanwhile. Revoking removed the person's directory, but a provider
  // call already running here can write a login back into it afterwards. That
  // epoch is never handed out again; drop what it left.
  try { rmSync(ctx.home, { recursive: true, force: true }); } catch { /* best effort */ }
  return { state: 'unavailable', detail: 'Meego authorization was revoked meanwhile.' };
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Make this person's Meego login usable, or get a link for them to approve —
 * what `bytedcli meego login` does, with the link going to botmux instead of
 * the terminal.
 *
 * A saved challenge is polled first, so the call made after the person approved
 * finds the login ready. Serialized per person: two sessions asking at once
 * share one challenge.
 */
export async function requestMeegoLogin(openId: string, tenant?: MeegoTenant): Promise<MeegoLoginRequest> {
  meegoPersonRoot(openId);
  if (tenant !== undefined && !MEEGO_TENANTS.includes(tenant)) throw new Error(`[meego-auth] unknown tenant: ${JSON.stringify(tenant)}`);
  const previous = inFlight.get(openId);
  const work = (async () => {
    await previous?.catch(() => null);
    return await request(openId, tenant, Date.now());
  })();
  inFlight.set(openId, work);
  try { return await work; } finally {
    if (inFlight.get(openId) === work) inFlight.delete(openId);
  }
}

/** Forget this person's Meego login on this host, every epoch included.
 *  Precondition: the revocation epoch was bumped first (revoke-trigger-user-auth). */
export function clearMeegoAuth(openId: string): boolean {
  const root = meegoPersonRoot(openId);
  const existed = existsSync(root);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* absence is the goal */ }
  return existed && !existsSync(root);
}
