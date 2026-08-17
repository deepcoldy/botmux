import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_PREFIX = 'bmxg1';
const GRANT_DOMAIN = 'botmux-terminal-control-grant-v1\0';
const MAX_GRANT_BYTES = 4_096;

export type TerminalControlScope = 'read' | 'write';

/**
 * Audience of a grant that is allowed to travel in a browser-visible URL.
 * `central` means: only the central dashboard front proxy may consume it, and
 * only by presenting the matching forward proof below (P1-5). A grant without
 * an audience is an internal loopback-hop credential and may never appear in a
 * `?viewToken=`.
 */
export type TerminalGrantAudience = 'central';

export interface TerminalControlGrantClaims {
  version: 1;
  scope: TerminalControlScope;
  sessionId: string;
  userId: string;
  authSessionId: string;
  grantId: string;
  issuedAt: number;
  expiresAt: number;
  /** Set only on view capabilities minted for the browser (P1-5). */
  audience?: TerminalGrantAudience;
  /**
   * Worker boot generation the capability was minted against (P1-5). The
   * worker re-derives it from its own per-boot view token and refuses any
   * mismatch, so a restart kills every grant issued to the previous boot even
   * though verification itself stays stateless.
   */
  workerGeneration?: string;
}

export type TerminalControlGrantVerification =
  | { ok: true; claims: TerminalControlGrantClaims }
  | { ok: false; reason: 'missing' | 'malformed' | 'invalid' | 'expired' | 'session_mismatch' };

function boundedIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value);
}

const BASE_GRANT_KEYS = [
  'authSessionId', 'expiresAt', 'grantId', 'issuedAt', 'scope', 'sessionId', 'userId', 'version',
];
/** A browser-visible view capability carries exactly two extra claims. */
const AUDIENCED_GRANT_KEYS = [...BASE_GRANT_KEYS, 'audience', 'workerGeneration'].sort();

function sameKeys(keys: string[], expected: string[]): boolean {
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function exactGrantClaims(value: unknown): value is TerminalControlGrantClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const audienced = sameKeys(keys, AUDIENCED_GRANT_KEYS);
  if (!audienced && !sameKeys(keys, BASE_GRANT_KEYS)) return false;
  if (audienced) {
    // Only a READ capability may name an audience: the audience exists so a
    // grant can be handed to a browser, and a write grant never may be.
    if (record.audience !== 'central' || record.scope !== 'read') return false;
    if (typeof record.workerGeneration !== 'string'
      || !/^[A-Za-z0-9_-]{16,128}$/.test(record.workerGeneration)) {
      return false;
    }
  }
  return record.version === 1
    && (record.scope === 'read' || record.scope === 'write')
    && typeof record.sessionId === 'string' && boundedIdentity(record.sessionId)
    && typeof record.userId === 'string' && boundedIdentity(record.userId)
    && typeof record.authSessionId === 'string' && boundedIdentity(record.authSessionId)
    && typeof record.grantId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(record.grantId)
    && Number.isSafeInteger(record.issuedAt) && (record.issuedAt as number) >= 0
    && Number.isSafeInteger(record.expiresAt) && (record.expiresAt as number) > (record.issuedAt as number);
}

function signature(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(GRANT_DOMAIN).update(payload).digest();
}

/**
 * Mint a dashboard-to-worker grant. The returned capability is for the
 * loopback proxy hop only and must never be returned in an API body or URL.
 */
export function issueTerminalControlGrant(
  secret: string,
  input: Omit<TerminalControlGrantClaims, 'version' | 'grantId'> & { grantId?: string },
): string {
  if (!secret) throw new Error('terminal control secret is required');
  const claims: TerminalControlGrantClaims = {
    version: 1,
    scope: input.scope,
    sessionId: input.sessionId,
    userId: input.userId,
    authSessionId: input.authSessionId,
    grantId: input.grantId ?? randomBytes(18).toString('base64url'),
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    // Kept off the object entirely when absent so the signed key set stays
    // exactly one of the two accepted shapes.
    ...(input.audience === undefined && input.workerGeneration === undefined
      ? {}
      : { audience: input.audience, workerGeneration: input.workerGeneration }),
  };
  if (!exactGrantClaims(claims)) throw new Error('invalid terminal control grant claims');
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${TOKEN_PREFIX}.${payload}.${signature(secret, payload).toString('base64url')}`;
}

/**
 * Cheap shape probe: does this query/header value even claim to be a signed
 * terminal grant?  Lets hot paths skip the synchronous secret-file read for
 * ordinary random capability tokens (worker per-boot view token, write token)
 * that can never verify anyway.
 */
export function looksLikeTerminalControlGrant(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(`${TOKEN_PREFIX}.`);
}

/**
 * P1-5 — worker boot generation pinned into a view capability.
 *
 * Derived one-way from the worker's PER-BOOT random view token, which the
 * daemon already reports upward and which the worker still holds in memory.
 * Both sides therefore agree on a generation id without any new plumbing, and
 * the derived value is safe to publish inside a browser-visible grant: it is an
 * HMAC under the host-only dashboard secret, so it cannot be inverted back into
 * the boot token (which by itself opens the terminal read-only).
 *
 * A worker restart re-randomizes the boot token ⇒ a different generation ⇒
 * every grant minted for the previous boot fails closed, statelessly.
 * Returns null when there is nothing to derive from, or when the caller passed
 * a signed grant where a boot token was expected (fail closed, never chain).
 */
const VIEW_GENERATION_DOMAIN = 'botmux-terminal-view-generation-v1\0';

export function deriveWorkerViewGeneration(
  secret: string,
  workerViewToken: string | null | undefined,
): string | null {
  if (!secret || typeof workerViewToken !== 'string' || !workerViewToken) return null;
  if (workerViewToken.length > MAX_GRANT_BYTES) return null;
  if (looksLikeTerminalControlGrant(workerViewToken)) return null;
  return createHmac('sha256', secret)
    .update(VIEW_GENERATION_DOMAIN)
    .update(workerViewToken)
    .digest('base64url')
    .slice(0, 32);
}

/**
 * P1-5 — proof that a `?viewToken=` view capability reached the worker THROUGH
 * the central dashboard front proxy.
 *
 * The audience claim above states the intent; this header carries the evidence.
 * The worker has no channel to the dashboard's auth-session table, so it cannot
 * re-check liveness itself — but it can demand that the only component which
 * does (the front proxy) countersign the exact capability being presented. The
 * value is an HMAC of the capability under the host-only dashboard secret, so a
 * browser holding the raw URL cannot compute it and a direct dial to the worker
 * port (or to the daemon's own `/s/` reverse proxy, which is network-bound)
 * fails closed no matter what headers it forges.
 *
 * The proof is deterministic per capability, which is deliberate: it only ever
 * exists on the 127.0.0.1 hops (dashboard → daemon proxy → worker) and is never
 * written into a URL, a page or a log, so the only way to hold a (capability,
 * proof) pair is to already own loopback on this host. Binding it to a time
 * window would buy nothing against an attacker who is already there.
 */
export const TERMINAL_VIEW_FORWARD_HEADER = 'x-botmux-terminal-view';
const VIEW_FORWARD_DOMAIN = 'botmux-terminal-view-forward-v1\0';

export function signTerminalViewForward(secret: string, viewGrant: string | null | undefined): string | null {
  if (!secret || typeof viewGrant !== 'string' || !viewGrant) return null;
  if (viewGrant.length > MAX_GRANT_BYTES) return null;
  return createHmac('sha256', secret).update(VIEW_FORWARD_DOMAIN).update(viewGrant).digest('base64url');
}

export function verifyTerminalViewForward(
  secret: string,
  viewGrant: string | null | undefined,
  proof: string | string[] | undefined,
): boolean {
  if (typeof proof !== 'string' || !proof) return false;
  const expected = signTerminalViewForward(secret, viewGrant);
  if (!expected) return false;
  const provided = Buffer.from(proof, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

export function verifyTerminalControlGrant(
  secret: string,
  token: string | string[] | undefined,
  expectedSessionId: string,
  now = Date.now(),
): TerminalControlGrantVerification {
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing' };
  if (!secret || token.length > MAX_GRANT_BYTES) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1])
    || !/^[A-Za-z0-9_-]+$/.test(parts[2])) {
    return { ok: false, reason: 'malformed' };
  }
  const expected = signature(secret, parts[1]);
  const provided = Buffer.from(parts[2], 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'invalid' };
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    if (Buffer.byteLength(json) > MAX_GRANT_BYTES) return { ok: false, reason: 'malformed' };
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!exactGrantClaims(parsed)) return { ok: false, reason: 'malformed' };
  if (parsed.sessionId !== expectedSessionId) return { ok: false, reason: 'session_mismatch' };
  if (!Number.isFinite(now) || now < parsed.issuedAt - 30_000 || now >= parsed.expiresAt) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, claims: parsed };
}
