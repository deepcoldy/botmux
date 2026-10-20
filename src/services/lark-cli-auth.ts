/**
 * Per-person `lark-cli` authorization via the device-code (QR) flow.
 *
 * Mirrors `bytedcli-auth.ts`: one HOME directory per person, and the CLI is
 * shelled out to with `HOME` pointed at it. See that file's header for why a
 * HOME beats capturing a token — the same reasoning applies, and lark-cli
 * resolves its config (`~/.lark-cli`) and credentials
 * (`~/.local/share/lark-cli/<appId>_<openId>.enc`) through `os.homedir()`,
 * measured in a scratch HOME (an empty HOME reports `not configured`).
 *
 * ## Why the lark-cli app instead of the bot app
 *
 * The previous trigger-user path minted a user token through **the bot's own
 * Feishu app** and injected it as env. That coupled "use lark-cli" to "your
 * account is inside that bot app's availability scope" — a person outside the
 * scope was stopped on the consent screen (`你没有…的使用权限`) before they
 * could ever authorize. The device-code flow runs against lark-cli's own app,
 * which is generally available, so no per-person allowlisting is needed.
 *
 * ## What is copied into each HOME (app material) vs. what is not (identity)
 *
 * A fresh HOME cannot initiate device flow on its own: the CLI needs a
 * configured app AND its real client secret (a dummy secret is rejected with
 * `The client secret is invalid`; a hand-written plaintext config is ignored as
 * `not configured`). So each HOME is seeded with three **machine-level** files
 * that are identical for every person:
 *
 *   <home>/.lark-cli/config.json                      minimal app entry, users:[]
 *   <home>/.local/share/lark-cli/master.key           lark-cli credential key
 *   <home>/.local/share/lark-cli/appsecret_<app>.enc  the APP secret (encrypted)
 *
 * None of those is a person. The per-person product — the user token — only
 * appears AFTER they scan, at
 * `<home>/.local/share/lark-cli/<appId>_<openId>.enc`, and is never copied
 * between HOMEs. The seed files come from the operator's own lark-cli install;
 * without one there is nothing to seed from and login reports "not configured".
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import { isUsableOpenId } from '../utils/user-token.js';

/** Root under which each authorized person gets their own lark-cli HOME.
 *  Overridable for tests so a run never touches the real data dir. */
let larkCliHomeRootOverride: string | null = null;
/** @internal test-only */
export function __setLarkCliHomeRootForTest(root: string | null): void {
  larkCliHomeRootOverride = root;
}
/** Override the OPERATOR's HOME that app material is seeded from (test-only; in
 *  production this stays null and resolves to the real `os.homedir()`). */
let machineHomeOverride: string | null = null;
/** @internal test-only */
export function __setMachineHomeForTest(home: string | null): void {
  machineHomeOverride = home;
}
const LARK_CLI_HOME_ROOT_DEFAULT = join(homedir(), '.botmux', 'data', 'lark-cli-home');

/**
 * Resolve the HOME that holds the issuing app for a given person.
 *
 * Device login has no built-in public app: it MUST bind a real self-built app,
 * and that app's availability scope decides who can authorize. The only way to
 * guarantee a person sees a link they can actually approve (rather than a
 * "you do not have permission to use this app" page) is to mint their device
 * code with an app THEY can access — best, an app they created. Resolution:
 *
 *   1. test override (`__setMachineHomeForTest`)
 *   2. BOTMUX_LARK_CLI_ISSUER_HOME (explicit env; shared by everyone)
 *   3. the per-person issuer HOME: ~/.botmux/data/lark-cli-issuer-<openId>,
 *      if provisioned (created via `lark-cli config init --new` with HOME there)
 *   4. the botmux-managed shared issuer HOME (~/.botmux/data/lark-cli-app-bootstrap)
 *   5. the operator's own lark-cli HOME (back-compat)
 *
 * A per-person issuer wins over the shared one so each person's link is bound
 * to an app they own/are scoped into; the shared issuer is only the fallback
 * when nobody has provisioned a personal app.
 */
function issuerMachineHome(openId?: string): string {
  if (machineHomeOverride) return machineHomeOverride;
  const env = process.env.BOTMUX_LARK_CLI_ISSUER_HOME?.trim();
  if (env) return env;
  if (openId) {
    // Defensive: only accept a sane open-id-shaped segment, never a traversal.
    if (/^[A-Za-z0-9_-]{8,128}$/.test(openId)) {
      const personal = join(LARK_CLI_HOME_ROOT_DEFAULT, '..', `lark-cli-issuer-${openId}`);
      if (existsSync(join(personal, '.lark-cli', 'config.json'))) return personal;
    }
  }
  const managed = join(LARK_CLI_HOME_ROOT_DEFAULT, '..', 'lark-cli-app-bootstrap');
  if (existsSync(join(managed, '.lark-cli', 'config.json'))) return managed;
  return homedir();
}

/** Last-resort app id if the issuer HOME has no readable config. Normally the
 *  app id is read from the issuer HOME's lark-cli config (BOTMUX_LARK_CLI_ISSUER_HOME
 *  or the operator HOME); a wrong default here surfaces as a device-login failure,
 *  not a silent mis-issuance. */
const DEFAULT_LARK_CLI_APP_ID = 'cli_aa8021c36af9dcde';

/** Device-code challenges live about 10 minutes (lark-cli `expires_in: 600`).
 *  Expire ours a little sooner so a resume token we hand back is not refused the
 *  instant it is used. */
const CHALLENGE_TTL_MS = 9 * 60_000;

/** How long to wait on a lark-cli invocation. The device-code calls are
 *  network-bound; generous enough for a slow network, short enough that a wedged
 *  CLI cannot hold a turn open. */
const LARK_CLI_TIMEOUT_MS = 30_000;

/** Scopes the CLI needs to do the document/drive/wiki/sheets/IM reads a
 *  triggered task performs. Kept level with the old bot-OAuth DEFAULT_SCOPES so
 *  switching the issuing app does not silently narrow what works. */
export const LARK_CLI_DEVICE_SCOPES = [
  'offline_access',
  'docx:document:readonly',
  'docs:document.content:read',
  'drive:drive.metadata:readonly',
  'drive:drive.search:readonly',
  'wiki:wiki:readonly',
  'sheets:spreadsheet:read',
  'sheets:spreadsheet.meta:read',
  'im:message:readonly',
  'im:resource',
];

/**
 * This person's private lark-cli HOME.
 *
 * Keyed by open_id so two people on one bot never share auth state. The id is
 * concatenated into a filesystem path, so a non-open-id (a `../`-shaped value)
 * must not redirect it at another directory.
 */
export function larkCliHomeFor(openId: string): string {
  if (!isUsableOpenId(openId)) {
    throw new Error(`[lark-cli-auth] unusable open_id: ${JSON.stringify(openId)}`);
  }
  return join(larkCliHomeRootOverride ?? LARK_CLI_HOME_ROOT_DEFAULT, openId);
}

function larkCliConfigPath(home: string): string {
  return join(home, '.lark-cli', 'config.json');
}
function larkCliDataDir(home: string): string {
  return join(home, '.local', 'share', 'lark-cli');
}

/** Whether this person has ever completed a lark-cli login here. Cheap enough to
 *  call per turn; says nothing about whether the token is still valid (a login
 *  can expire — the call itself reports that). */
export function hasLarkCliHome(openId: string): boolean {
  try {
    // A seeded-but-never-authorized HOME holds no per-person token yet; only a
    // real <appId>_<openId>.enc counts as "has logged in".
    return existsSync(larkCliConfigPath(larkCliHomeFor(openId)))
      && listUserTokenFiles(larkCliHomeFor(openId)).length > 0;
  } catch { return false; }
}

function listUserTokenFiles(home: string): string[] {
  try {
    return readdirSync(larkCliDataDir(home)).filter(f => /^cli_[A-Za-z0-9]+_ou_[A-Za-z0-9]+\.enc$/.test(f));
  } catch { return []; }
}

/** Forget one person's lark-cli authorization entirely. */
export function clearLarkCliAuth(openId: string): void {
  try { rmSync(larkCliHomeFor(openId), { recursive: true, force: true }); }
  catch { /* best-effort: absence is the desired state */ }
}

export interface LarkCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Test seam: replace the lark-cli invocation. Receives the argv and the HOME the
 * call would use, returns the same shape the real child reports. Production never
 * sets this; tests use it to script the device-flow conversation without lark-cli.
 */
export type LarkCliRunner = (args: string[], home: string) => Promise<LarkCliResult>;
let __runnerOverride: LarkCliRunner | null = null;
/** @internal test-only */
export function __setLarkCliRunnerForTest(runner: LarkCliRunner | null): void {
  __runnerOverride = runner;
}

/** Run `lark-cli` with HOME pointed at one person's directory. PATH and the rest
 *  of the environment are inherited (proxy/site/PATH resolution still needed);
 *  HOME is the whole identity mechanism. */
async function runAsUser(openId: string, args: string[]): Promise<LarkCliResult> {
  const home = larkCliHomeFor(openId);
  if (__runnerOverride) return __runnerOverride(args, home);
  return await new Promise<LarkCliResult>(resolve => {
    let child;
    try {
      child = spawn('lark-cli', args, {
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) });
      return;
    }
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
      stderr += '\n[lark-cli-auth] timed out';
      finish(false);
    }, LARK_CLI_TIMEOUT_MS);
    child.stdout.on('data', d => { stdout += String(d); });
    child.stderr.on('data', d => { stderr += String(d); });
    // A missing binary lands here, not on a non-zero exit.
    child.on('error', err => { stderr += `\n${err.message}`; finish(false); });
    child.on('close', code => finish(code === 0));
  });
}

/**
 * Locate the operator's own lark-cli install to seed app material from.
 *
 * Resolved from the REAL (daemon) HOME at call time, never from the per-person
 * HOME we hand to the child — otherwise the first lookup is circular.
 */
function machineLarkCliPaths(openId?: string): {
  config: string; dataDir: string; appId: string;
} | null {
  const root = issuerMachineHome(openId);
  const config = join(root, '.lark-cli', 'config.json');
  const dataDir = join(root, '.local', 'share', 'lark-cli');
  if (!existsSync(config) || !existsSync(dataDir)) return null;
  let appId = DEFAULT_LARK_CLI_APP_ID;
  try {
    const cfg = JSON.parse(readFileSync(config, 'utf8')) as { apps?: Array<{ appId?: string }> };
    const first = cfg.apps?.find(a => typeof a.appId === 'string' && a.appId.startsWith('cli_'));
    if (first?.appId) appId = first.appId;
  } catch { /* fall back to the default app id */ }
  return { config, dataDir, appId };
}

/**
 * Seed a person's HOME with the machine-level app material so device flow can
 * start. Idempotent. Returns false when the operator's lark-cli has no app to
 * seed from (the caller turns that into a clear "lark-cli not set up" message).
 */
function ensureBootstrapped(openId: string): boolean {
  const machine = machineLarkCliPaths(openId);
  if (!machine) return false;
  const home = larkCliHomeFor(openId);
  const dataDir = larkCliDataDir(home);
  mkdirSync(join(home, '.lark-cli'), { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const secretFile = join(dataDir, `appsecret_${machine.appId}.enc`);
  const masterKey = join(dataDir, 'master.key');
  try {
    if (!existsSync(secretFile)) {
      copyFileSync(join(machine.dataDir, `appsecret_${machine.appId}.enc`), secretFile);
    }
    if (!existsSync(masterKey)) {
      copyFileSync(join(machine.dataDir, 'master.key'), masterKey);
    }
  } catch (e) {
    logger.warn(`[lark-cli-auth] could not seed app material for ${openId}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }

  // Minimal app entry: the secret is referenced from the encrypted file lark-cli
  // itself wrote (source "keychain"), and there are no users until someone
  // actually scans. Built from the operator's config shape, not hand-invented.
  if (!existsSync(larkCliConfigPath(home))) {
    let appEntry: unknown = null;
    try {
      const cfg = JSON.parse(readFileSync(machine.config, 'utf8')) as
        { apps?: Array<Record<string, unknown>> };
      const src = cfg.apps?.find(a => a.appId === machine.appId);
      if (src) {
        appEntry = {
          appId: src.appId,
          appSecret: src.appSecret,
          brand: src.brand ?? 'feishu',
          lang: src.lang ?? 'zh',
          users: [],
        };
      }
    } catch { /* fall through to the minimal literal */ }
    if (!appEntry) {
      appEntry = {
        appId: machine.appId,
        brand: 'feishu',
        lang: 'zh',
        // Without a reference to the encrypted-secret pointer, the CLI treats
        // this as not configured. The encrypted files were copied above; a
        // machine lacking a readable source config never reaches this path.
        users: [],
      };
    }
    atomicWriteFileSync(larkCliConfigPath(home), JSON.stringify({ apps: [appEntry] }, null, 2), { mode: 0o600 });
  }
  return true;
}

/** Where a started-but-unfinished login's resume token lives — inside that
 *  person's HOME, for the same reasons as bytedcli's challenge. */
function challengePath(openId: string): string {
  return join(larkCliHomeFor(openId), '.botmux-login-challenge');
}

/** The resume token + link from an in-progress login if still usable. */
export function pendingLarkCliChallenge(openId: string): { deviceCode: string; authUrl?: string; createdAt: number } | null {
  try {
    const raw = JSON.parse(readFileSync(challengePath(openId), 'utf8')) as
      { deviceCode?: unknown; authUrl?: unknown; createdAt?: unknown };
    if (typeof raw.deviceCode !== 'string' || typeof raw.createdAt !== 'number') return null;
    if (Date.now() - raw.createdAt > CHALLENGE_TTL_MS) return null;
    return {
      deviceCode: raw.deviceCode,
      ...(typeof raw.authUrl === 'string' ? { authUrl: raw.authUrl } : {}),
      createdAt: raw.createdAt,
    };
  } catch { return null; }
}

function saveChallenge(openId: string, deviceCode: string, authUrl: string): void {
  try {
    atomicWriteFileSync(
      challengePath(openId),
      JSON.stringify({ deviceCode, authUrl, createdAt: Date.now() }),
      { mode: 0o600 },
    );
  } catch (e) {
    logger.debug(`[lark-cli-auth] could not persist the login challenge: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function clearChallenge(openId: string): void {
  try { rmSync(challengePath(openId), { force: true }); } catch { /* already gone */ }
}

export interface LarkCliLoginChallenge {
  /** The page the person opens to authorize. */
  authUrl: string;
}

/**
 * Start a device-code login for one person and return the link (and a QR can be
 * rendered from it). Non-blocking (`--no-wait`): the CLI returns immediately
 * with a verification_url + device_code instead of holding a turn open, which
 * is the only shape that works when the authorizer is on the other side of a
 * chat.
 */
export async function beginLarkCliLogin(openId: string): Promise<LarkCliLoginChallenge | null> {
  if (!ensureBootstrapped(openId)) {
    logger.warn('[lark-cli-auth] cannot begin login: operator lark-cli has no app to seed from');
    return null;
  }
  // Reuse a still-fresh, not-yet-completed challenge: several turns in quick
  // succession from one person who has not authorized must not mint a new code
  // (and invalidate the link already shown) on every message. A fresh scan
  // clears the challenge, so after they authorize a new code is correctly made.
  const pending = pendingLarkCliChallenge(openId);
  if (pending?.authUrl && !hasLarkCliHome(openId)) {
    return { authUrl: pending.authUrl };
  }
  const { ok, stdout, stderr } = await runAsUser(openId, [
    'auth', 'login', '--no-wait', '--json', '--scope', LARK_CLI_DEVICE_SCOPES.join(' '),
  ]);
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(stdout) as Record<string, unknown>; }
  catch { parsed = null; }
  const authUrl = typeof parsed?.verification_url === 'string' ? parsed.verification_url : undefined;
  const deviceCode = typeof parsed?.device_code === 'string' ? parsed.device_code : undefined;
  if (!ok || !authUrl || !deviceCode) {
    logger.warn(`[lark-cli-auth] could not start a login: ${stderr.trim() || stdout.trim() || 'no output'}`);
    return null;
  }
  saveChallenge(openId, deviceCode, authUrl);
  return { authUrl };
}

export type LarkCliLoginState = 'authorized' | 'pending' | 'failed';

/**
 * Poll a started login once (non-blocking). `pending` is the ordinary "the
 * person has not scanned yet" state, not an error.
 */
export async function completeLarkCliLogin(
  openId: string,
  deviceCode?: string,
): Promise<{ state: LarkCliLoginState; detail?: string }> {
  const code = deviceCode ?? pendingLarkCliChallenge(openId)?.deviceCode;
  if (!code) return { state: 'failed', detail: 'no active login — please start again' };
  const { ok, stdout, stderr } = await runAsUser(openId, ['auth', 'login', '--device-code', code, '--json']);
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(stdout) as Record<string, unknown>; } catch { parsed = null; }
  if (ok) {
    // A successful poll means the user token is now on disk under this HOME.
    if (hasLarkCliHome(openId)) { clearChallenge(openId); return { state: 'authorized' }; }
    // ok but no token file yet — treat as pending rather than authorized.
    return { state: 'pending' };
  }
  const raw = String((parsed?.error as Record<string, unknown> | undefined)?.message ?? stderr).trim();
  // "authorization_pending"-style messages are the normal not-scanned-yet case.
  if (/pending|not yet|waiting/i.test(raw)) return { state: 'pending' };
  // A terminal failure (expired / denied / unknown code) never turns into a
  // success by re-polling the same code: drop it so the next begin mints a
  // fresh link instead of reusing a dead one until the TTL expires. A transient
  // transport error costs one extra link, which the refusal hands over at once.
  clearChallenge(openId);
  return { state: 'failed', detail: raw || undefined };
}

/** Absolute HOME directory to export for this person's lark-cli calls this turn,
 *  or null when they have no per-person login (caller denies). */
export function larkCliHomeForTurn(openId: string | undefined): string | null {
  if (!openId) return null;
  try { return hasLarkCliHome(openId) ? larkCliHomeFor(openId) : null; }
  catch { return null; }
}

/**
 * Resolve the acting HOME for THIS turn, polling a pending device login once.
 *
 * A browser approval writes nothing locally: only the `--device-code` poll
 * lands the per-person token. Without this poll on the turn path, a person who
 * tapped the link and (as instructed) retried the operation would be refused
 * again until they guessed `/login done`. One poll per turn is the same shape
 * bytedcli already uses; a still-pending or failed poll resolves to null (the
 * caller refuses again with a fresh link) — it never manufactures a HOME, so
 * someone who has not approved stays refused.
 */
export async function resolveLarkCliHomeForTurn(openId: string | undefined): Promise<string | null> {
  if (!openId) return null;
  try {
    if (!hasLarkCliHome(openId) && pendingLarkCliChallenge(openId)) {
      await completeLarkCliLogin(openId);
    }
    return hasLarkCliHome(openId) ? larkCliHomeFor(openId) : null;
  } catch {
    // A poll failure must not deny someone whose HOME is already on disk.
    return hasLarkCliHome(openId) ? larkCliHomeFor(openId) : null;
  }
}
