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
 * Credentials originate in that private HOME; a short-lived in-memory regional
 * cache is cleared on logout and used only after a fresh personal-login check.
 * The module shells out to `bytedcli` with `HOME` set to it. When a governed call finds no usable
 * login, Botmux starts the device flow automatically; after the person opens
 * that link, the next retry completes the saved challenge before minting JWTs.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import { isUsableOpenId } from '../utils/user-token.js';
import { scrubSessionTurnMarkerEnv } from '../utils/child-env.js';
import { cliAuthEpochAllows, readCliAuthEpoch, stampCliAuthEpoch } from './cli-auth-epoch.js';

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

/** Ask the credential provider whether this person's isolated login is usable.
 * Storage layout belongs to bytedcli/its SDK, not Botmux. A directory or a
 * legacy token filename is neither necessary nor sufficient authorization. */
class BytedcliAuthUnavailableError extends Error {
  constructor(operation: string) {
    super(`bytedcli authorization service unavailable (${operation}); retry after the service recovers, without starting another login`);
    this.name = 'BytedcliAuthUnavailableError';
  }
}

interface LoginObservation {
  authenticated: boolean;
  /** Provider-reported login expiry, when `auth status` includes one. */
  expiresAt?: string;
}

async function readLoginState(openId: string): Promise<LoginObservation> {
  const home = bytedcliHomeFor(openId);
  if (!existsSync(home)) return { authenticated: false };
  // A HOME rewritten after revoke has no matching stamp. Do not ask the CLI —
  // its own session files are not authority once the epoch has moved.
  if (!cliAuthEpochAllows(openId, home)) return { authenticated: false };
  const result = await runAsUser(openId, ['auth', 'status', '--json']);
  const envelope = parseEnvelope(result.stdout);
  const data = envelope?.data as Record<string, unknown> | undefined;
  if (!result.ok || envelope?.status !== 'success' || typeof data?.authenticated !== 'boolean') {
    throw new BytedcliAuthUnavailableError('status');
  }
  const sdk = data.bytecloud_auth as Record<string, unknown> | undefined;
  if (data.auth_as === 'app' || sdk?.authType === 'app') {
    throw new BytedcliAuthUnavailableError('unexpected app identity');
  }
  if (!data.authenticated && sdk?.status && sdk.status !== 'need_login') {
    throw new BytedcliAuthUnavailableError('provider not ready');
  }
  const expiresAt = providerExpiry(data, sdk);
  return { authenticated: data.authenticated, ...(expiresAt ? { expiresAt } : {}) };
}

/** ISO expiry from the status payload. Only the named expiry fields are read;
 *  JWTs and other credential fields in the same object are ignored. */
function providerExpiry(
  data: Record<string, unknown>,
  sdk: Record<string, unknown> | undefined,
): string | undefined {
  for (const source of sdk ? [sdk, data] : [data]) {
    for (const key of ['expires_at', 'expiresAt'] as const) {
      const iso = isoTimestamp(source[key]);
      if (iso) return iso;
    }
  }
  return undefined;
}

/** ECMAScript time values outside ±8.64e15 ms make `Date#toISOString` throw. */
const MAX_DATE_MS = 8.64e15;

function isoFromMs(ms: number): string | undefined {
  // A provider clock (for example a nanosecond Unix time) must not be able to
  // throw out of a status read. Login state is independent of that field.
  if (!Number.isFinite(ms) || ms < 1_000_000_000_000 || ms > MAX_DATE_MS) return undefined;
  return new Date(ms).toISOString();
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    return isoFromMs(ms);
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) return undefined;
  return isoFromMs(Date.parse(trimmed));
}

export async function hasBytedcliHome(openId: string): Promise<boolean> {
  return (await readLoginState(openId)).authenticated;
}

/**
 * This person's bytedcli login, for a status query.
 *
 * Does not start a login and does not create a HOME. `unknown` means the
 * provider could not be asked (down, malformed, or a non-personal identity);
 * an existing login is left untouched. No credential material is returned.
 */
export async function describeBytedcliAuth(openId: string): Promise<{
  state: 'authorized' | 'needs-login' | 'unknown';
  expiresAt?: string;
}> {
  try {
    const login = await readLoginState(openId);
    return {
      state: login.authenticated ? 'authorized' : 'needs-login',
      ...(login.expiresAt ? { expiresAt: login.expiresAt } : {}),
    };
  } catch {
    return { state: 'unknown' };
  }
}

/** Forget one person's bytedcli authorization entirely.
 * Precondition: persist bumpCliAuthEpoch(openId) BEFORE logout or this cleanup.
 * The durable epoch fences stale SDK writers in every daemon; clearing local
 * dedup maps does not stop an already-running child from recreating the HOME.
 */
export function clearBytedcliAuth(openId: string): void {
  beginnings.delete(openId);
  authEpochs.set(openId, authEpoch(openId) + 1);
  minting.delete(openId);
  renewing.delete(openId);
  forgetRegionalJwts(openId);
  try { rmSync(bytedcliHomeFor(openId), { recursive: true, force: true }); }
  catch { /* best-effort: absence is the desired state */ }
}

/**
 * Ask bytedcli to revoke this person's server-side login, if a HOME already
 * exists. Never creates the directory: `runAsUser` would mkdir, and a logout
 * of someone who never logged in must not leave an empty HOME behind.
 * A missing binary or a non-zero exit is a failed attempt, not an exception —
 * the caller still deletes the local HOME.
 */
export async function logoutBytedcli(openId: string): Promise<boolean> {
  try {
    if (!isUsableOpenId(openId) || !existsSync(bytedcliHomeFor(openId))) return false;
    const result = await runAsUser(openId, ['auth', 'logout', '--json']);
    return result.ok;
  } catch {
    return false;
  }
}

export interface BytedcliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run `bytedcli` as one person.
 *
 * Keep transport settings, but remove session wrappers and caller credentials.
 * The provider must read only this person's isolated HOME.
 */
async function runAsUser(openId: string, args: string[]): Promise<BytedcliResult> {
  const home = bytedcliHomeFor(openId);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = { ...process.env };
  scrubSessionTurnMarkerEnv(env);
  for (const key of [
    'BYTEDCLI_PROFILE', 'BYTEDCLI_CODEBASE_APP_ID', 'BYTEDCLI_CODEBASE_APP_SECRET',
    'AIME_WORKSPACE_PATH', 'AIME_CURRENT_USER',
    'BYTECLOUD_AUTH_ACCESS_KEY_ID', 'BYTECLOUD_AUTH_SECRET_ACCESS_KEY',
  ]) delete env[key];
  Object.assign(env, { HOME: home, BYTECLOUD_AUTH_AS: 'user', BYTEDCLI_NO_AUTO_UPGRADE: '1' });
  return await new Promise<BytedcliResult>(resolve => {
    const child = spawn('bytedcli', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      stderr += '\n[bytedcli-auth] timed out';
      // A descendant can retain the pipes after the CLI exits; do not wait for close.
      child.stdout.destroy();
      child.stderr.destroy();
      finish(false);
    }, BYTEDCLI_TIMEOUT_MS);
    child.stdout.on('data', d => { stdout += String(d); });
    child.stderr.on('data', d => { stderr += String(d); });
    // A missing binary lands here, not on a non-zero exit.
    child.on('error', err => { stderr += `\n${err.message}`; finish(false); });
    child.on('close', code => finish(!timedOut && code === 0));
  });
}

/** Parse bytedcli's `--json` envelope, which wraps everything in {status,data}. */
function parseEnvelope(stdout: string): Record<string, unknown> | null {
  // `--begin` emits progress events (`qr_image_ready`) before the envelope, one
  // JSON object per line, so take the last parseable line rather than the first.
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && 'status' in parsed) return parsed;
  } catch { /* progress lines may precede the envelope */ }
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
function pendingBytedcliLogin(openId: string): BytedcliLoginChallenge | null {
  try {
    const raw = JSON.parse(readFileSync(challengePath(openId), 'utf8')) as
      { token?: unknown; authUrl?: unknown; createdAt?: unknown };
    if (typeof raw.token !== 'string' || !raw.token || typeof raw.createdAt !== 'number'
      || !Number.isFinite(raw.createdAt) || raw.createdAt > Date.now()) return null;
    if (Date.now() - raw.createdAt > CHALLENGE_TTL_MS) return null;
    return {
      completeToken: raw.token,
      authUrl: typeof raw.authUrl === 'string' ? raw.authUrl : '',
    };
  } catch { return null; }
}

export function pendingBytedcliChallenge(openId: string): string | null {
  return pendingBytedcliLogin(openId)?.completeToken ?? null;
}

function saveChallenge(openId: string, token: string, authUrl: string): boolean {
  try {
    atomicWriteFileSync(
      challengePath(openId),
      JSON.stringify({ token, authUrl, createdAt: Date.now() }),
      { mode: 0o600 },
    );
    return true;
  } catch {
    // Never hand out a challenge that the next turn cannot resume.
    logger.warn('[bytedcli-auth] could not persist the login challenge');
    return false;
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
 * Start a login for one person and return the link to send them. An unfinished,
 * still-valid challenge is reused so repeated turns do not create new links.
 *
 * Non-blocking (`--begin`): the CLI returns immediately with a resume token
 * instead of holding a terminal open waiting for a scan, which is the only
 * shape that works when the person authorizing is on the other side of a chat.
 */
const beginnings = new Map<string, { epoch: number; durableEpoch: number; work: Promise<BytedcliLoginChallenge | null> }>();

export async function beginBytedcliLogin(openId: string): Promise<BytedcliLoginChallenge | null> {
  const epoch = authEpoch(openId);
  const durableEpoch = readCliAuthEpoch(openId);
  const existing = beginnings.get(openId);
  if (existing?.epoch === epoch && existing.durableEpoch === durableEpoch) return existing.work;
  const work = serializedCredentialWork(openId, () => credentialEpochCurrent(openId, epoch, durableEpoch)
    ? beginLogin(openId, epoch, durableEpoch) : Promise.resolve(null));
  beginnings.set(openId, { epoch, durableEpoch, work });
  try { return await work; } finally {
    if (beginnings.get(openId)?.work === work) beginnings.delete(openId);
    if (credentialWork.get(openId) === work) credentialWork.delete(openId);
  }
}

async function beginLogin(openId: string, epoch: number, durableEpoch: number): Promise<BytedcliLoginChallenge | null> {
  const home = bytedcliHomeFor(openId);
  // A revoked HOME must not resume its old challenge. Clear it before login;
  // a newer login that landed during this call is left alone below.
  // The durable epoch/stamp is shared by every daemon. A matching new login
  // must survive here even if this process performed an earlier revoke.
  // An unstamped legacy HOME is still valid at epoch zero.
  if (existsSync(home) && !cliAuthEpochAllows(openId, home)) {
    // The previous SDK child has left the shared queue. Remove any late files
    // before stamping a new login; cleanup is not a new revocation operation.
    try { rmSync(home, { recursive: true, force: true }); } catch { return null; }
    forgetRegionalJwts(openId);
  }

  const pending = pendingBytedcliLogin(openId);
  if (pending?.authUrl) return pending;

  const { ok, stdout } = await runAsUser(openId, ['auth', 'login', '--begin', '--json']);
  const env = parseEnvelope(stdout);
  const data = env?.data as Record<string, unknown> | undefined;
  const authUrl = typeof data?.verification_uri_complete === 'string'
    ? data.verification_uri_complete
    : undefined;
  const completeToken = typeof data?.complete_token === 'string' ? data.complete_token : undefined;
  if (!ok || env?.status !== 'success' || !authUrl || !completeToken) {
    logger.warn('[bytedcli-auth] could not start a login; provider failed or returned an invalid challenge');
    return null;
  }
  // Epoch moved while the CLI ran: a revoke, or a newer login, won. Do not
  // stamp or delete — the newer HOME may already be valid.
  if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  stampCliAuthEpoch(openId, home);
  if (!saveChallenge(openId, completeToken, authUrl)) return null;
  return { authUrl, completeToken };
}

export type BytedcliLoginState = 'authorized' | 'pending' | 'failed' | 'unavailable';

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
  const epoch = authEpoch(openId);
  const durableEpoch = readCliAuthEpoch(openId);
  const work = serializedCredentialWork(openId, () => completeLogin(openId, completeToken, epoch, durableEpoch));
  try { return await work; } finally {
    if (credentialWork.get(openId) === work) credentialWork.delete(openId);
  }
}

async function completeLogin(openId: string, completeToken: string, epoch: number, durableEpoch: number): Promise<{ state: BytedcliLoginState; detail?: string }> {
  const current = () => credentialEpochCurrent(openId, epoch, durableEpoch)
    && (!pendingBytedcliChallenge(openId) || pendingBytedcliChallenge(openId) === completeToken);
  const retired = () => ({ state: 'failed' as const, detail: 'Login attempt was replaced or revoked.' });
  if (!current()) return retired();
  const { ok, stdout } = await runAsUser(
    openId,
    ['auth', 'login', '--complete', completeToken, '--json'],
  );
  if (!current()) return retired();
  const env = parseEnvelope(stdout);
  const data = env?.data as Record<string, unknown> | undefined;
  const state = data?.login_status ?? data?.status;
  const error = env?.error as Record<string, unknown> | undefined;
  const errorCode = typeof error?.code === 'string' ? error.code : '';
  if ((ok && env?.status === 'success' && state === 'pending')
    || errorCode === 'BYTECLOUD_AUTH_LOGIN_PENDING') return { state: 'pending' };
  if (ok && env?.status === 'success' && (state === 'success' || state === 'ok')) {
    // Completion is not authority until the isolated provider can use the login.
    try {
      if ((await readLoginState(openId)).authenticated) {
        if (!current()) return retired();
        clearChallenge(openId);
        return { state: 'authorized' };
      }
    } catch { /* Preserve the challenge until the provider can verify it. */ }
    return { state: 'unavailable', detail: 'Login completion did not produce usable personal credentials; retry status without starting another login.' };
  }
  const terminal = ['expired', 'denied', 'invalid_ticket'].includes(String(state))
    || ['BYTECLOUD_AUTH_LOGIN_EXPIRED', 'BYTECLOUD_AUTH_LOGIN_DENIED',
      'BYTECLOUD_AUTH_LOGIN_INVALID_TICKET', 'BYTECLOUD_AUTH_LOGIN_CHALLENGE_INVALID'].includes(errorCode);
  // Network errors, timeouts and unknown output do not invalidate a challenge.
  if (!current()) return retired();
  if (terminal) clearChallenge(openId);
  return { state: terminal ? 'failed' : 'unavailable', detail: terminal
    ? 'Login challenge expired or was rejected.'
    : 'Authorization service unavailable; the existing login challenge was retained. Retry later without reauthorizing.' };
}

export interface BytedcliJwts {
  cloudJwt: string;
  /** Git pushes authenticate with this one, so commit attribution follows it. */
  codeJwt?: string;
  /** ByteCloud JWTs for non-default regions, keyed by region. */
  regionalCloudJwts?: BytedcliRegionalJwts;
}

/**
 * ByteCloud JWTs are partition-scoped: the default (cn) token is rejected by
 * i18n services with `invalid jwt token ... partition i18n`. Each entry names
 * the region and one `--site` that mints its token; the wrapper maps every
 * `--site` value onto these regions (see renderIdentityWrapper).
 */
export const BYTEDCLI_REGIONAL_SITES = [
  // The site `i18n` belongs to i18nbd; use i18n-tt for the i18n region.
  ['i18n', 'i18n-tt'],
  ['i18nbd', 'i18n-bd'],
  ['tx', 'us-ttp'],
] as const;
export type BytedcliRegion = typeof BYTEDCLI_REGIONAL_SITES[number][0];
export type BytedcliRegionalJwts = Partial<Record<BytedcliRegion, string>>;

/**
 * Mint this person's JWTs for the current turn.
 *
 * Called per turn rather than cached because the ByteCloud JWT lives only ~2
 * hours while the login behind it lives ~3 weeks: `bytedcli` refreshes it
 * internally when it is expiring, so asking each time is what keeps a person
 * from being sent back to a QR code every couple of hours.
 *
 * If an automatic device login is pending, first try to complete it. This makes
 * "open the link, then retry" sufficient; `/login bytedcli done` remains a
 * compatibility path, not a required user step.
 *
 * The completion is BEST-EFFORT, never a gate: a still-pending (or just-failed)
 * challenge says nothing about whether this person already has a valid login,
 * and returning null here would lock an already-authorized person out — a
 * single transient blip can auto-begin a challenge on the refusal path, and a
 * non-authorized poll result must not then veto the perfectly good HOME below
 * (which is also the only thing that can clear that state). So regardless of
 * the poll outcome, fall through and let the HOME / JWT read be the authority.
 */
const minting = new Map<string, Promise<BytedcliJwts | null>>();
const authEpochs = new Map<string, number>();
// Epoch invalidation must not release the HOME's operation lock while an old
// provider child can still write its SDK cache.
const credentialWork = new Map<string, Promise<unknown>>();
function serializedCredentialWork<T>(openId: string, run: () => Promise<T>): Promise<T> {
  const previous = credentialWork.get(openId);
  const work = (async () => { await previous?.catch(() => null); return await run(); })();
  credentialWork.set(openId, work);
  return work;
}

function authEpoch(openId: string): number { return authEpochs.get(openId) ?? 0; }
function credentialEpochCurrent(openId: string, epoch: number, durableEpoch: number): boolean {
  return epoch === authEpoch(openId) && durableEpoch === readCliAuthEpoch(openId);
}


/**
 * Regional JWTs reused while they keep at least half an hour of life. A fresh
 * mint gains nothing earlier: bytedcli serves its own disk-cached token until
 * that nears expiry, so re-asking every turn only adds CLI round trips — and
 * stretches the window in which a turn's identity is not yet published. Reuse
 * needs this turn's default mint to have just confirmed the login is live.
 */
const regionalJwtCache = new Map<string, { jwt: string; expiresAtMs: number; durableEpoch: number }>();
const REGIONAL_JWT_REUSE_MARGIN_MS = 30 * 60_000;

function jwtClaims(jwt: string): { exp?: unknown; region?: unknown } | null {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function regionalCloudJwt(
  openId: string, region: BytedcliRegion, site: string, forceRefresh = false, epoch = authEpoch(openId), durableEpoch = readCliAuthEpoch(openId),
): Promise<string | null> {
  if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  const key = `${openId}\0${region}`;
  const cached = regionalJwtCache.get(key);
  if (!forceRefresh && cached && cached.durableEpoch === durableEpoch && cached.expiresAtMs - Date.now() > REGIONAL_JWT_REUSE_MARGIN_MS) return cached.jwt;
  regionalJwtCache.delete(key);
  const result = await runAsUser(openId, [
    '--site', site, 'auth', 'get-bytecloud-jwt-token', ...(forceRefresh ? ['--force-refresh'] : []),
  ]);
  if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  const jwt = result.ok ? result.stdout.trim() : '';
  const claims = jwt && !/\s/.test(jwt) ? jwtClaims(jwt) : null;
  // A token for another partition would only move the failure; keep the default.
  if (!claims || claims.region !== region) {
    logger.debug(`[bytedcli-auth] no ${region} ByteCloud JWT for ${openId}; that region keeps the default token`);
    return null;
  }
  if (typeof claims.exp === 'number') regionalJwtCache.set(key, { jwt, expiresAtMs: claims.exp * 1_000, durableEpoch });
  return jwt;
}

function forgetRegionalJwts(openId: string): void {
  for (const key of regionalJwtCache.keys()) {
    if (key.startsWith(`${openId}\0`)) regionalJwtCache.delete(key);
  }
}

export async function mintBytedcliJwts(openId: string): Promise<BytedcliJwts | null> {
  const epoch = authEpoch(openId);
  const durableEpoch = readCliAuthEpoch(openId);
  const existing = minting.get(openId);
  if (existing) return existing;
  const work = serializedCredentialWork(openId, async () =>
    credentialEpochCurrent(openId, epoch, durableEpoch) ? await mintJwts(openId, epoch, durableEpoch) : null);
  minting.set(openId, work);
  try { const result = await work; return credentialEpochCurrent(openId, epoch, durableEpoch) ? result : null; }
  finally {
    if (minting.get(openId) === work) minting.delete(openId);
    if (credentialWork.get(openId) === work) credentialWork.delete(openId);
  }
}

const renewing = new Map<string, Promise<BytedcliJwts | null>>();

/**
 * Force-refresh one person's ByteCloud JWTs for a turn that outlives them.
 *
 * Turn publication mints once, and a ByteCloud JWT lives ~2h, so a long job
 * started by one turn would otherwise hit 401 mid-run. The login behind the
 * JWT (~30 days) is unchanged; this only asks the SDK for a new access token.
 * Null when no fresh default token could be obtained.
 */
export async function renewBytedcliJwts(openId: string): Promise<BytedcliJwts | null> {
  const epoch = authEpoch(openId);
  const durableEpoch = readCliAuthEpoch(openId);
  const existing = renewing.get(openId);
  if (existing) return existing;
  const work = serializedCredentialWork(openId, async () =>
    credentialEpochCurrent(openId, epoch, durableEpoch) ? await renewJwts(openId, epoch, durableEpoch) : null);
  renewing.set(openId, work);
  try { const result = await work; return credentialEpochCurrent(openId, epoch, durableEpoch) ? result : null; }
  finally {
    if (renewing.get(openId) === work) renewing.delete(openId);
    if (credentialWork.get(openId) === work) credentialWork.delete(openId);
  }
}

async function renewJwts(openId: string, epoch: number, durableEpoch: number): Promise<BytedcliJwts | null> {
  if (!(await readLoginState(openId)).authenticated || epoch !== authEpoch(openId)) return null;
  const cloud = await runAsUser(openId, ['auth', 'get-bytecloud-jwt-token', '--force-refresh']);
  if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  const cloudJwt = cloud.ok ? cloud.stdout.trim() : '';
  if (!cloudJwt || /\s/.test(cloudJwt)) return null;
  const code = await runAsUser(openId, ['auth', 'get-codebase-jwt-token']);
  if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  const codeJwt = code.ok ? code.stdout.trim() : '';
  const regionalCloudJwts: BytedcliRegionalJwts = {};
  for (const [region, site] of BYTEDCLI_REGIONAL_SITES) {
    const jwt = await regionalCloudJwt(openId, region, site, true, epoch, durableEpoch);
    if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
    if (jwt) regionalCloudJwts[region] = jwt;
  }
  if (!cliAuthEpochAllows(openId, bytedcliHomeFor(openId))) return null;
  return {
    cloudJwt,
    ...(codeJwt && !/\s/.test(codeJwt) ? { codeJwt } : {}),
    ...(Object.keys(regionalCloudJwts).length ? { regionalCloudJwts } : {}),
  };
}

async function mintJwts(openId: string, epoch: number, durableEpoch: number): Promise<BytedcliJwts | null> {
  const challenge = pendingBytedcliChallenge(openId);
  if (challenge) {
    await completeLogin(openId, challenge, epoch, durableEpoch);
  }
  if (!credentialEpochCurrent(openId, epoch, durableEpoch) || !(await readLoginState(openId)).authenticated || !credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  const cloud = await runAsUser(openId, ['auth', 'get-bytecloud-jwt-token']);
  if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  const cloudJwt = cloud.stdout.trim();
  if (!cloud.ok || !cloudJwt) {
    throw new BytedcliAuthUnavailableError('mint personal JWT');
  }
  // The Codebase JWT is optional: without it lark/bytedcli calls still work and
  // only git attribution degrades, so a failure here must not deny the turn.
  const code = await runAsUser(openId, ['auth', 'get-codebase-jwt-token']);
  if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
  const codeJwt = code.ok ? code.stdout.trim() : '';
  if (!codeJwt) {
    logger.debug(`[bytedcli-auth] no Codebase JWT for ${openId}; git attribution will fall back`);
  }
  // Regional tokens are best-effort like the Codebase JWT: without one, that
  // region's calls keep the default token. Minted one at a time — concurrent
  // mints against the same HOME were measured returning another region's token.
  const regionalCloudJwts: BytedcliRegionalJwts = {};
  for (const [region, site] of BYTEDCLI_REGIONAL_SITES) {
    const jwt = await regionalCloudJwt(openId, region, site, false, epoch, durableEpoch);
    if (!credentialEpochCurrent(openId, epoch, durableEpoch)) return null;
    if (jwt) regionalCloudJwts[region] = jwt;
  }
  // Keep master's durable revoke fence after all regional provider awaits.
  if (!cliAuthEpochAllows(openId, bytedcliHomeFor(openId))) return null;
  return {
    cloudJwt,
    ...(codeJwt ? { codeJwt } : {}),
    ...(Object.keys(regionalCloudJwts).length ? { regionalCloudJwts } : {}),
  };
}
