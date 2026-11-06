/**
 * #2004 — who may wake a worker-less session through the terminal proxy.
 *
 * The daemon's terminal proxy used to wake (fork worker → recreate pane → boot
 * the CLI) BEFORE anything looked at credentials: the worker only checks them
 * once the request reaches it. Any request that named a sessionId — a stale
 * token, no token at all, or a read-only viewer's WebSocket auto-reconnect —
 * re-forked a session the idle sweeper had just suspended, so one terminal tab
 * left open cold-started the session every idle TTL.
 *
 * Authenticate first, then decide from the result:
 *   • authenticated — a write link, or a Dashboard / platform login (including a
 *     platform visitor signed in through SSO who is only allowed to watch):
 *     wake exactly as before;
 *   • read-link — a bare read-only capability (a card link, or the platform's
 *     anonymous read-only visitor): wake an ordinary worker-less session as
 *     before (e.g. one restored after a daemon restart), but never a session
 *     that was deliberately suspended — that gets the "session suspended" page;
 *   • none — no credential, or one that does not verify: never wake. The worker
 *     would have answered 403 after the wake anyway.
 *
 * Every rule mirrors what the worker accepts for the same request, so waking is
 * never granted to a request the worker would then refuse outright.
 */
import {
  TERMINAL_WAKE_HEADER,
  verifyTerminalControlGrant,
  verifyTerminalWakeProof,
} from './terminal-control-grant.js';
import {
  authorizeTerminalStatusPage,
  deriveTerminalWriteToken,
  readDashboardCookie,
  safeTerminalTokenEqual,
} from './terminal-write-auth.js';

/** Header the dashboard front proxy carries its signed terminal grant in (the
 * worker reads the same literal). */
const TERMINAL_CONTROL_GRANT_HEADER = 'x-botmux-terminal-control';

export type TerminalWakeCredential = 'authenticated' | 'read-link' | 'none';
export type TerminalWakeDecision = 'wake' | 'suspended' | 'deny';

export interface TerminalWakeRequest {
  capability: { viewToken?: string; token?: string };
  /** Request headers keyed by lower-cased name. */
  headers: Record<string, string | string[] | undefined>;
}

export interface TerminalWakeCredentialInput extends TerminalWakeRequest {
  secret: string;
  sessionId: string;
  session: { terminalCardEpoch?: string } | undefined;
  live: {
    workerViewToken?: string | null;
    workerCardViewToken?: string | null;
  } | undefined;
  /** Live dashboard token. Read lazily — only a request carrying the dashboard
   * cookie needs it. */
  getDashboardToken: () => string | null;
  now?: number;
}

function liveDashboardToken(getDashboardToken: () => string | null): string | null {
  // Token rotation atomically replaces the file; a transient read error must
  // fail closed for this one request, never escape into the proxy.
  try { return getDashboardToken(); } catch { return null; }
}

export function classifyTerminalWakeCredential(input: TerminalWakeCredentialInput): TerminalWakeCredential {
  const { secret, sessionId, session, live, capability, headers, now } = input;
  if (!session) return 'none';
  if (capability.token
    && safeTerminalTokenEqual(capability.token, deriveTerminalWriteToken(secret, sessionId))) {
    return 'authenticated';
  }
  // The dashboard front proxy vouches for a signed-in requester even when an
  // explicit query capability makes it strip every browser credential.
  if (verifyTerminalWakeProof(secret, sessionId, headers[TERMINAL_WAKE_HEADER], now)) {
    return 'authenticated';
  }
  // A browser logged into this host's Dashboard reaching the proxy port
  // directly (the card link names the proxy port); the worker grants it read
  // through the same cookie.
  const cookieToken = readDashboardCookie(headers.cookie);
  if (cookieToken) {
    const active = liveDashboardToken(input.getDashboardToken);
    if (active && safeTerminalTokenEqual(cookieToken, active)) return 'authenticated';
  }
  const grantHeader = headers[TERMINAL_CONTROL_GRANT_HEADER];
  if (grantHeader !== undefined) {
    const grant = verifyTerminalControlGrant(secret, grantHeader, sessionId, now);
    // A write grant is only minted for a platform owner or a leased Dashboard
    // login. A read grant without the wake proof is the platform's anonymous
    // read-only visitor: it may watch, so it is a read-only capability here.
    if (grant.ok) return grant.claims.scope === 'write' ? 'authenticated' : 'read-link';
  }
  return authorizeTerminalStatusPage({
    secret,
    sessionId,
    session,
    live,
    capability: capability.viewToken ? { viewToken: capability.viewToken } : {},
  }) ? 'read-link' : 'none';
}

/**
 * Deliberately parked (idle TTL, live-worker cap, admission reclaim, …): the
 * persisted `suspendedColdResume` marker is set by `suspendWorker` and cleared
 * as soon as anything forks a worker again. A worker that is already coming up
 * costs nothing more to wait for.
 */
export function terminalSessionSuspended(ds: {
  worker?: { killed?: boolean } | null;
  session: { suspendedColdResume?: boolean };
} | undefined): boolean {
  return !!ds && ds.session.suspendedColdResume === true && (!ds.worker || ds.worker.killed === true);
}

export function decideTerminalWake(credential: TerminalWakeCredential, suspended: boolean): TerminalWakeDecision {
  if (credential === 'authenticated') return 'wake';
  if (credential === 'read-link') return suspended ? 'suspended' : 'wake';
  return 'deny';
}
