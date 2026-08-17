import {
  issueTerminalControlGrant,
  looksLikeTerminalControlGrant,
  verifyTerminalControlGrant,
} from '../core/terminal-control-grant.js';

/**
 * Short-lived read capability for the `/api/sessions/:id/view-link` URL.
 *
 * The link used to embed the worker's STABLE view token — an irrevocable
 * bearer capability: an H5 viewer who fetched it once could keep reading the
 * terminal long after logout/expiry, and a worker restart re-derived the same
 * value. The view-link URL now carries a signed read grant instead, bound to
 * sessionId + authSessionId + expiresAt (grant `version` is the rotation
 * hook):
 *
 *   • the worker verifies it STATELESSLY (signature + expiry + session match),
 *     so no worker-side revocation state is needed — expiry alone bounds a
 *     leaked URL;
 *   • the dashboard front proxy holds the minimal revocation state: it knows
 *     which auth sessions are still alive and closes/refuses this
 *     authSession's read sockets on logout/expiry (see terminal-front-proxy).
 *
 * The TTL doubles as the periodic reconnect boundary for read sockets, so it
 * is deliberately longer than the old 60s per-request read grants (which now
 * share this constant) but still short enough that a copied URL dies quickly.
 */
export const TERMINAL_VIEW_CAPABILITY_TTL_MS = 10 * 60_000;

export interface TerminalViewCapabilityIdentity {
  userId: string;
  authSessionId: string;
  /** Authentication expiry of the requesting identity; the minted capability
   *  never outlives it. */
  expiresAt: number;
}

/** Mint the short-lived, identity-bound read capability for one session. */
export function mintTerminalViewCapability(
  secret: string,
  sessionId: string,
  identity: TerminalViewCapabilityIdentity,
  now = Date.now(),
): { token: string; expiresAt: number } | null {
  const expiresAt = Math.min(identity.expiresAt, now + TERMINAL_VIEW_CAPABILITY_TTL_MS);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  try {
    return {
      token: issueTerminalControlGrant(secret, {
        scope: 'read',
        sessionId,
        userId: identity.userId,
        authSessionId: identity.authSessionId,
        issuedAt: now,
        expiresAt,
      }),
      expiresAt,
    };
  } catch {
    // Out-of-shape identities (empty ids, control chars) fail closed: the
    // caller returns an error instead of falling back to any stable token.
    return null;
  }
}

/**
 * Replace the upstream view-link's `?viewToken=` with the bound capability.
 * The daemon-built URL still carries the worker's per-boot card token, which
 * is NOT bound to the requesting auth session — it must never be returned by
 * the view-link API. A malformed upstream URL fails closed (null) for the
 * same reason.
 */
export function rewriteViewLinkCapability(upstreamUrl: string, token: string): string | null {
  let parsed: URL;
  try { parsed = new URL(upstreamUrl); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.searchParams.set('viewToken', token);
  return parsed.toString();
}

/**
 * Resolve which auth session a bound `?viewToken=` capability belongs to, or
 * null when the value is not a valid bound read capability for this session.
 * Used by the front proxy to (a) refuse capabilities whose auth session was
 * already revoked and (b) index the bridged socket for logout-time closing.
 */
export function terminalViewCapabilityAuthSession(
  secret: string,
  sessionId: string,
  viewToken: string | null | undefined,
  now = Date.now(),
): string | null {
  if (!looksLikeTerminalControlGrant(viewToken)) return null;
  const verified = verifyTerminalControlGrant(secret, viewToken, sessionId, now);
  if (!verified.ok || verified.claims.scope !== 'read') return null;
  return verified.claims.authSessionId;
}
