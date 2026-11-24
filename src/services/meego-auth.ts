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
import { ensureMeegoStore, meegoHomeFor, meegoPersonRoot, MEEGO_STORE_DIR, MEEGO_TENANTS, type MeegoTenant } from './bytedcli-home.js';
import { readCliAuthEpoch } from './cli-auth-epoch.js';

/** Ours, under bytedcli's 30-minute challenge lifetime. The device code itself
 *  may expire sooner; bytedcli then reports it and a new one is started. */
const CHALLENGE_TTL_MS = 25 * 60_000;
const CHALLENGE_FILE = '.botmux-meego-challenge';
const MAX_CONSECUTIVE_POLL_ERRORS = 10;

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

/** Remove the challenge file only when it still belongs to `token`, so a stale
 *  background poller cannot erase a newer challenge written by another daemon. */
function clearChallengeIfMatches(ctx: Ctx, token: string): void {
  try {
    const raw = JSON.parse(readFileSync(challengePath(ctx), 'utf8')) as Partial<SavedChallenge>;
    if (raw.token === token) clearChallenge(ctx);
  } catch { /* already gone or unreadable */ }
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

interface AttemptOutcome {
  result: MeegoLoginRequest;
  challenge?: SavedChallenge;
}

async function begin(ctx: Ctx, now: number): Promise<AttemptOutcome> {
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
    return { result: { state: 'unavailable', detail: 'Meego login could not be started.' } };
  }
  const challenge: SavedChallenge = { token, authUrl, createdAt: now };
  writeChallenge(ctx, challenge);
  return { result: { state: 'link', authUrl }, challenge };
}

async function attempt(ctx: Ctx, now: number): Promise<AttemptOutcome> {
  const pending = readChallenge(ctx, now);
  if (pending) {
    const outcome = await completeOnce(ctx, pending.token);
    if (outcome === 'success') {
      clearChallenge(ctx);
      if (await loginStatus(ctx) === 'authorized') return { result: { state: 'ready' } };
      return { result: { state: 'unavailable', detail: 'Meego login completed but is not usable yet; retry shortly.' } };
    }
    if (outcome === 'pending') return { result: { state: 'link', authUrl: pending.authUrl }, challenge: pending };
    // A network error does not invalidate the link the person may be opening.
    if (outcome === 'error') return { result: { state: 'unavailable', detail: 'Meego authorization service unavailable; retry shortly.' } };
  }
  clearChallenge(ctx);
  const status = await loginStatus(ctx);
  if (status === 'authorized') return { result: { state: 'ready' } };
  if (status === 'unavailable') return { result: { state: 'unavailable', detail: 'Meego status could not be read; retry shortly.' } };
  return await begin(ctx, now);
}

interface PollerHandle {
  token: string;
  epoch: number;
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
  stop: () => void;
}

const activePollers = new Map<string, PollerHandle>();
const backgroundCompletionListeners = new Set<(openId: string) => void>();
let globalPollerGeneration = 0;
const userPollerGeneration = new Map<string, number>();

/** Subscribe to successful background Meego login completions (e.g. to clear
 *  stale unattended-lapse / creation-offer dedup entries). */
export function onMeegoBackgroundLoginCompleted(listener: (openId: string) => void): () => void {
  backgroundCompletionListeners.add(listener);
  return () => { backgroundCompletionListeners.delete(listener); };
}

function pollerKey(openId: string, tenant: MeegoTenant | undefined): string {
  return `${openId}\0${tenant ?? ''}`;
}

function stopPoller(key: string): void {
  activePollers.get(key)?.stop();
}

function nextPollDelayMs(elapsedMs: number, consecutiveErrors: number): number {
  const base = elapsedMs < 2 * 60_000 ? 3_000 : elapsedMs < 5 * 60_000 ? 6_000 : 15_000;
  if (consecutiveErrors <= 0) return base;
  const errorBackoff = Math.min(60_000, 3_000 * (2 ** Math.min(consecutiveErrors, 4)));
  return Math.max(base, errorBackoff);
}

/**
 * Keep one background poller per `(openId, tenant)` while a device-flow
 * challenge is open so approving in the browser persists the login without
 * requiring a second manual command (such as `/login meego`).
 */
function ensureChallengePoller(
  openId: string,
  tenant: MeegoTenant | undefined,
  challenge: SavedChallenge,
  startEpoch: number,
): void {
  const key = pollerKey(openId, tenant);
  const existing = activePollers.get(key);
  if (existing && !existing.stopped && existing.token === challenge.token && existing.epoch === startEpoch) {
    return;
  }
  existing?.stop();

  let consecutiveErrors = 0;
  const handle: PollerHandle = {
    token: challenge.token,
    epoch: startEpoch,
    stopped: false,
    stop() {
      if (this.stopped) return;
      this.stopped = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (activePollers.get(key) === this) activePollers.delete(key);
    },
  };
  activePollers.set(key, handle);

  const scheduleNext = () => {
    if (handle.stopped) return;
    if (readCliAuthEpoch(openId) !== startEpoch) {
      handle.stop();
      return;
    }
    const elapsed = Math.max(0, Date.now() - challenge.createdAt);
    const remaining = CHALLENGE_TTL_MS - elapsed;
    const delay = nextPollDelayMs(elapsed, consecutiveErrors);
    if (remaining <= 0 || delay > remaining) {
      handle.stop();
      return;
    }
    handle.timer = setTimeout(() => {
      handle.timer = undefined;
      void tick();
    }, delay);
    handle.timer.unref?.();
  };

  const tick = async () => {
    if (handle.stopped || readCliAuthEpoch(openId) !== startEpoch) {
      handle.stop();
      return;
    }
    let decision: 'continue' | 'stop';
    try {
      decision = await runSerialized(openId, async () => {
        if (handle.stopped || readCliAuthEpoch(openId) !== startEpoch) return 'stop' as const;
        // Read-only path: never recreate a deleted or revoked store directory.
        const ctx: Ctx = { home: meegoHomeFor(openId, startEpoch), tenant };
        const current = readChallenge(ctx, Date.now());
        if (!current || current.token !== challenge.token) return 'stop' as const;

        let outcome: 'success' | 'pending' | 'gone' | 'error';
        try {
          outcome = await completeOnce(ctx, current.token);
        } catch {
          outcome = 'error';
        }
        // Check revocation BEFORE handle.stopped: a revoke calls stopMeegoPollersForUser
        // while completeOnce may still be writing credentials back into the revoked HOME.
        if (readCliAuthEpoch(openId) !== startEpoch) {
          try { rmSync(ctx.home, { recursive: true, force: true }); } catch { /* best effort */ }
          return 'stop' as const;
        }
        if (handle.stopped) return 'stop' as const;

        if (outcome === 'success') {
          clearChallengeIfMatches(ctx, challenge.token);
          const status = await loginStatus(ctx).catch(() => 'unavailable' as const);
          if (readCliAuthEpoch(openId) !== startEpoch) {
            try { rmSync(ctx.home, { recursive: true, force: true }); } catch { /* best effort */ }
            return 'stop' as const;
          }
          logger.info(`[meego-auth] background login completed for ${openId}${tenant ? ` (tenant=${tenant})` : ''} (status=${status})`);
          if (status === 'authorized') {
            for (const listener of [...backgroundCompletionListeners]) {
              try { listener(openId); } catch { /* listener errors must not affect auth cleanup */ }
            }
          }
          return 'stop' as const;
        }
        if (outcome === 'gone') {
          clearChallengeIfMatches(ctx, challenge.token);
          return 'stop' as const;
        }
        if (outcome === 'error') {
          consecutiveErrors += 1;
          return consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS ? ('stop' as const) : ('continue' as const);
        }
        consecutiveErrors = 0;
        return 'continue' as const;
      });
    } catch {
      consecutiveErrors += 1;
      decision = consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS ? 'stop' : 'continue';
    }
    if (decision === 'stop') handle.stop();
    else scheduleNext();
  };

  scheduleNext();
}

/** Stop any active background Meego completion pollers for `openId` across all tenants,
 *  and fence any in-flight `requestMeegoLogin` for `openId` from arming a new one. */
export function stopMeegoPollersForUser(openId: string): void {
  userPollerGeneration.set(openId, (userPollerGeneration.get(openId) ?? 0) + 1);
  const prefix = `${openId}\0`;
  for (const [key, handle] of [...activePollers]) {
    if (key.startsWith(prefix)) handle.stop();
  }
}

/** Stop every active background Meego completion poller (daemon shutdown / tests),
 *  and fence any in-flight `requestMeegoLogin` from arming a new poller after teardown. */
export function stopAllMeegoPollers(): void {
  globalPollerGeneration += 1;
  userPollerGeneration.clear();
  for (const handle of [...activePollers.values()]) handle.stop();
}

async function request(openId: string, tenant: MeegoTenant | undefined, now: number): Promise<MeegoLoginRequest> {
  const epoch = readCliAuthEpoch(openId);
  const startGlobalGen = globalPollerGeneration;
  const startUserGen = userPollerGeneration.get(openId) ?? 0;
  const ctx: Ctx = { home: ensureMeegoStore(openId, epoch), tenant };
  const { result, challenge } = await attempt(ctx, now);
  if (readCliAuthEpoch(openId) !== epoch) {
    // Revoked meanwhile. Revoking removed the person's directory, but a provider
    // call already running here can write a login back into it afterwards. That
    // epoch is never handed out again; drop what it left.
    try { rmSync(ctx.home, { recursive: true, force: true }); } catch { /* best effort */ }
    stopPoller(pollerKey(openId, tenant));
    return { state: 'unavailable', detail: 'Meego authorization was revoked meanwhile.' };
  }
  if (result.state === 'link' && challenge) {
    // Do not arm a background poller if shutdown or per-user stop ran while attempt() was in flight.
    if (globalPollerGeneration === startGlobalGen && (userPollerGeneration.get(openId) ?? 0) === startUserGen) {
      ensureChallengePoller(openId, tenant, challenge, epoch);
    }
  } else if (result.state === 'ready') {
    stopPoller(pollerKey(openId, tenant));
  }
  return result;
}

const inFlight = new Map<string, Promise<unknown>>();

async function runSerialized<T>(openId: string, fn: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(openId);
  const work = (async () => {
    await previous?.catch(() => null);
    return await fn();
  })();
  inFlight.set(openId, work);
  try { return await work; } finally {
    if (inFlight.get(openId) === work) inFlight.delete(openId);
  }
}

/**
 * Make this person's Meego login usable, or get a link for them to approve —
 * what `bytedcli meego login` does, with the link going to botmux instead of
 * the terminal.
 *
 * A saved challenge is polled first, so the call made after the person approved
 * finds the login ready, and a background poller also completes it once the
 * person approves in the browser. Serialized per person: two sessions asking
 * at once share one challenge.
 */
export async function requestMeegoLogin(openId: string, tenant?: MeegoTenant): Promise<MeegoLoginRequest> {
  meegoPersonRoot(openId);
  if (tenant !== undefined && !MEEGO_TENANTS.includes(tenant)) throw new Error(`[meego-auth] unknown tenant: ${JSON.stringify(tenant)}`);
  return await runSerialized(openId, () => request(openId, tenant, Date.now()));
}

/** Forget this person's Meego login on this host, every epoch included.
 *  Precondition: the revocation epoch was bumped first (revoke-trigger-user-auth). */
export function clearMeegoAuth(openId: string): boolean {
  stopMeegoPollersForUser(openId);
  const root = meegoPersonRoot(openId);
  const existed = existsSync(root);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* absence is the goal */ }
  return existed && !existsSync(root);
}
