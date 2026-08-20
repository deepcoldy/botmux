import {
  deriveWorkerViewGeneration,
  issueTerminalControlGrant,
  looksLikeTerminalControlGrant,
  signTerminalViewForward,
  verifyTerminalControlGrant,
} from '../core/terminal-control-grant.js';

/**
 * Short-lived read capability for the `/api/sessions/:id/view-link` URL.
 *
 * The link used to embed the worker's STABLE view token — an irrevocable
 * bearer capability: an H5 viewer who fetched it once could keep reading the
 * terminal long after logout/expiry, and a worker restart re-derived the same
 * value. The view-link URL now carries a signed read grant instead, bound to
 * sessionId + authSessionId + expiresAt.
 *
 * That alone was still bypassable (P1-5, second round): the returned URL kept
 * the DAEMON/WORKER origin, so a copied raw URL — or a direct dial to the
 * worker port / the daemon's own network-bound `/s/` reverse proxy — reached a
 * stateless verifier that knew nothing about logout. Central revocation was
 * decoration on a road nobody had to drive. Two changes close it, and the
 * capability now names both of them in its own claims:
 *
 *   • CENTRAL-ONLY CONSUMPTION. `centralViewLinkPath` returns a same-origin
 *     path on the central dashboard (`/s/<id>/?viewToken=…`) — the daemon /
 *     worker origin never leaves this process. The capability is minted with
 *     `audience: 'central'`, and the front proxy countersigns each accepted
 *     capability with a forward proof the browser cannot compute. The worker
 *     demands both, so a raw URL pointed at any other entry point fails closed
 *     even though its signature and expiry are perfectly valid.
 *   • WORKER GENERATION PINNING. The capability carries the worker's per-boot
 *     generation (derived one-way from the boot view token the daemon already
 *     reports). A worker restart re-randomizes it, so grants issued to a dead
 *     boot die with it instead of surviving on the shared `.dashboard-secret`.
 *
 * Revocation therefore has two independent fences: the front proxy refuses a
 * capability whose auth session ended (and closes its bridged sockets), and the
 * worker refuses one that did not come through that proxy or that outlived the
 * boot it was minted for.
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

/** Mint the short-lived, identity-bound read capability for one session.
 *  `workerGeneration` pins the capability to the worker boot it was minted
 *  against — see `upstreamWorkerViewGeneration`. */
export function mintTerminalViewCapability(
  secret: string,
  sessionId: string,
  identity: TerminalViewCapabilityIdentity,
  workerGeneration: string,
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
        audience: 'central',
        workerGeneration,
      }),
      expiresAt,
    };
  } catch {
    // Out-of-shape identities (empty ids, control chars) and a missing/blank
    // worker generation fail closed: the caller returns an error instead of
    // falling back to any stable token or to an unpinned capability.
    return null;
  }
}

/**
 * Read the worker boot generation out of the daemon-built view-link URL.
 *
 * That upstream URL still carries the worker's per-boot card token in
 * `?viewToken=` — the one value that identifies the live worker generation and
 * that this process must never pass through to a browser. We convert it to a
 * one-way generation id here and drop the token itself.
 *
 * Fails closed (null) on a malformed URL, a non-http(s) scheme, a missing
 * token, or an upstream that already handed us a signed grant: without a
 * generation the caller must return an error rather than mint an unpinned
 * capability.
 */
export function upstreamWorkerViewGeneration(secret: string, upstreamUrl: unknown): string | null {
  if (typeof upstreamUrl !== 'string' || !upstreamUrl) return null;
  let parsed: URL;
  try { parsed = new URL(upstreamUrl); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return deriveWorkerViewGeneration(secret, parsed.searchParams.get('viewToken'));
}

/**
 * Build the browser-facing view link: a CENTRAL-ORIGIN RELATIVE path, never an
 * absolute URL. The daemon's terminal-proxy port and the worker port are both
 * reachable on the network and neither knows anything about auth-session
 * liveness, so publishing either origin is the whole bypass — a relative path
 * cannot name them, and cannot be repointed by a poisoned `Host` header the way
 * a server-rebuilt absolute URL could.
 *
 * The path shape matches the front proxy's `/s/<sessionId>` route, which is
 * also what the daemon's proxy and the worker accept after the loopback hops.
 */
export function centralViewLinkPath(sessionId: string, token: string): string | null {
  if (!sessionId || !token) return null;
  if (sessionId.length > 512 || token.length > 4_096) return null;
  if (/[\r\n\0]/.test(sessionId) || /[\r\n\0]/.test(token)) return null;
  return `/s/${encodeURIComponent(sessionId)}/?viewToken=${encodeURIComponent(token)}`;
}

/**
 * Resolve which auth session a bound `?viewToken=` capability belongs to, or
 * null when the value is not a valid bound read capability for this session.
 * Used by the front proxy to (a) refuse capabilities whose auth session was
 * already revoked and (b) index the bridged socket for logout-time closing.
 *
 * A grant without `audience: 'central'` is an internal loopback credential that
 * was never meant to travel in a URL; it resolves to null so the proxy neither
 * blesses it nor countersigns it.
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
  if (verified.claims.audience !== 'central') return null;
  return verified.claims.authSessionId;
}

/**
 * Countersign one accepted view capability for the loopback hop. Only the front
 * proxy calls this, and only after the capability's auth session was confirmed
 * live — the proof is what tells the worker "this request came through the
 * component that holds the revocation state".
 */
export function terminalViewForwardProof(secret: string, viewToken: string): string | undefined {
  return signTerminalViewForward(secret, viewToken) ?? undefined;
}
