/**
 * Daemon-internal HMAC auth (PR2 / Route B) — signs & verifies internal
 * `/__daemon/*` requests sent by botmux daemons to the dashboard process.
 *
 * Why a new module instead of `auth.ts:verifyHmac`?
 *  - `/__cli/rotate` signs only `ts:nonce` (auth.ts:43-45) — a captured signature
 *    can be replayed against a DIFFERENT path/method/body.
 *  - Route B signs the full request envelope (ts/nonce/method/pathWithQuery/body),
 *    so each signature is only valid for one specific call.
 *  - We deliberately use the SAME `.dashboard-secret` file as the HMAC key so
 *    operators don't have to manage two secrets; the differing signing material
 *    prevents cross-protocol replay.
 *
 * Wire format mirrors the existing `/__cli/rotate` convention:
 *   - sender:   `digest('base64url')` and ships sig as base64url string
 *   - receiver: `Buffer.from(sig, 'base64url')` vs raw `.digest()` Buffer with
 *               `timingSafeEqual` (see `auth.ts:43-49`)
 *
 * Body rule (B1): request body stream MUST only be read once. `verifyDaemonRequest`
 * consumes it and returns `bodyRaw`; the dispatcher consumes `bodyRaw`, NEVER
 * `req` again.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Window during which a (ts, nonce) tuple is accepted; mirrors the spec ±60s. */
export const TS_WINDOW_MS = 60_000;

/** Nonce time-to-live before it can be reused (10 minutes — well over TS_WINDOW). */
export const NONCE_TTL_MS = 10 * 60_000;

/** Hard cap on body size we'll read into memory for signing. */
export const BODY_LIMIT_BYTES = 1024 * 1024;

/** Canonical input fed into `signDaemonRequest`. All fields participate in the digest. */
export interface SignInput {
  /** `.dashboard-secret` file contents — opaque string used directly as HMAC key. */
  secret: string;
  /** Epoch milliseconds, as a string (no trimming, no normalisation). */
  ts: string;
  /** One-time random base64url string (32 random bytes recommended). */
  nonce: string;
  /** HTTP method; uppercased before being mixed into the digest. */
  method: string;
  /** Request `url` exactly as the server will receive it (path + query, including '?' and '&'). */
  pathWithQuery: string;
  /** Raw body bytes as a UTF-8 string. Empty body → ''. */
  bodyRaw: string;
}

export interface SignOutput {
  /** Wire-format signature (base64url, no padding). */
  wire: string;
  /** Raw HMAC digest bytes — used by `timingSafeEqual` on the server side. */
  raw: Buffer;
}

/**
 * Compute the HMAC signature for one request. Pure — no IO, no clock reads.
 *
 * Signing material is the canonical 5-line block:
 *   ts \n nonce \n METHOD \n pathWithQuery \n sha256(bodyRaw)
 *
 * Query string order is significant (not canonicalised). Server and client MUST
 * agree on the exact `pathWithQuery` byte-for-byte.
 */
export function signDaemonRequest(input: SignInput): SignOutput {
  const bodyHashHex = createHash('sha256').update(input.bodyRaw).digest('hex');
  const material = [
    input.ts,
    input.nonce,
    input.method.toUpperCase(),
    input.pathWithQuery,
    bodyHashHex,
  ].join('\n');
  const raw = createHmac('sha256', input.secret).update(material).digest();
  return { wire: raw.toString('base64url'), raw };
}

/**
 * Timing-safe comparison between a wire-format signature and the raw expected
 * digest. Returns `false` on any decoding error rather than throwing — the
 * caller treats a `false` result as `sig_mismatch` without leaking the reason.
 */
export function checkSig(wireSig: string, expectedRaw: Buffer): boolean {
  let provided: Buffer;
  try {
    provided = Buffer.from(wireSig, 'base64url');
  } catch {
    return false;
  }
  if (provided.length !== expectedRaw.length) return false;
  return timingSafeEqual(provided, expectedRaw);
}

/** All-or-nothing loopback predicate, identical to `auth.ts`'s inline check. */
export function isLoopback(remoteAddr: string | undefined): boolean {
  if (!remoteAddr) return false;
  if (remoteAddr === '127.0.0.1' || remoteAddr === '::1') return true;
  if (remoteAddr.endsWith('::ffff:127.0.0.1')) return true;
  return false;
}

/** Persistent (in-memory) nonce store with lazy GC. */
export interface NonceStore {
  has(nonce: string): boolean;
  add(nonce: string, expiresAt: number): void;
  /** Number of currently tracked nonces. Useful for diagnostics / tests. */
  size(): number;
}

export interface ClockLike {
  now(): number;
}

/** Default clock — wraps `Date.now`. Replace in tests via the optional `clock` arg. */
export const realClock: ClockLike = { now: () => Date.now() };

/**
 * Create an in-process nonce store. Each `has()` triggers a lazy sweep of
 * expired entries so the map cannot grow unbounded across a daemon lifetime.
 */
export function createNonceStore(clock: ClockLike = realClock): NonceStore {
  const m = new Map<string, number>();

  const gc = (now: number): void => {
    for (const [n, exp] of m) {
      if (exp <= now) m.delete(n);
    }
  };

  return {
    has(nonce: string): boolean {
      gc(clock.now());
      return m.has(nonce);
    },
    add(nonce: string, expiresAt: number): void {
      m.set(nonce, expiresAt);
    },
    size(): number {
      gc(clock.now());
      return m.size;
    },
  };
}

/**
 * Read the body stream into a single UTF-8 string, with a hard byte cap.
 * Returns `null` when the cap is exceeded (caller maps to 413).
 *
 * Body MUST only be read once per request; `verifyDaemonRequest` is the only
 * site that calls this, and downstream dispatch consumes the returned string.
 */
export async function readBodyRaw(
  req: IncomingMessage,
  opts: { maxBytes?: number } = {},
): Promise<string | null> {
  const cap = opts.maxBytes ?? BODY_LIMIT_BYTES;
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > cap) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Reasons the verifier may reject a request. Mirror these in HTTP responses. */
export type VerifyRejection =
  | 'missing_header'
  | 'remote_not_loopback'
  | 'ts_malformed'
  | 'ts_window'
  | 'replay'
  | 'sig_mismatch'
  | 'body_too_large';

export interface VerifyOk {
  ok: true;
  /** Self-reported daemon app id (audit only — NOT used for authn / authz). */
  appId: string;
  /** Body raw bytes read by verify; dispatcher MUST consume this, not `req`. */
  bodyRaw: string;
}

export interface VerifyFail {
  ok: false;
  reason: VerifyRejection;
  /** Suggested HTTP status code for the rejection. */
  httpStatus: number;
}

export type VerifyResult = VerifyOk | VerifyFail;

export interface VerifyOptions {
  /** Override the default clock — used by tests to advance time deterministically. */
  clock?: ClockLike;
  /** Override the default body cap (rare; tests use this to assert 413 quickly). */
  maxBodyBytes?: number;
}

/**
 * Read a single header value. Node normally comma-joins duplicate wire headers;
 * array-valued headers can still appear in tests/custom callers. Accept only
 * strings so malformed arrays fail as missing headers instead of picking one.
 */
function headerStr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Verify an inbound `/__daemon/*` request. Consumes the body stream exactly
 * once and returns `bodyRaw` for the dispatcher. On success, the nonce is
 * recorded with a TTL to block replays.
 */
export async function verifyDaemonRequest(
  req: IncomingMessage,
  secret: string,
  nonceStore: NonceStore,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const clock = opts.clock ?? realClock;

  const ts = headerStr(req, 'x-botmux-daemon-ts');
  const nonce = headerStr(req, 'x-botmux-daemon-nonce');
  const sig = headerStr(req, 'x-botmux-daemon-sig');
  const appId = headerStr(req, 'x-botmux-daemon-appid');
  if (!ts || !nonce || !sig || !appId) {
    return { ok: false, reason: 'missing_header', httpStatus: 400 };
  }

  if (!isLoopback(req.socket?.remoteAddress)) {
    return { ok: false, reason: 'remote_not_loopback', httpStatus: 403 };
  }

  // Stricter than parseInt — rejects '123abc' / '1.5' / '' / 'NaN' / Infinity.
  const tsMs = Number(ts);
  if (!Number.isFinite(tsMs) || !Number.isInteger(tsMs)) {
    return { ok: false, reason: 'ts_malformed', httpStatus: 401 };
  }
  if (Math.abs(clock.now() - tsMs) > TS_WINDOW_MS) {
    return { ok: false, reason: 'ts_window', httpStatus: 401 };
  }

  // Body must be read BEFORE the nonce check so that the `has → add` window
  // contains no `await` — concurrent requests with the same nonce can each
  // pass `has()` only one at a time, which then `add()`s the entry before any
  // other microtask can run. See test: "concurrent requests with the same
  // nonce — exactly one is accepted".
  const bodyRaw = await readBodyRaw(req, { maxBytes: opts.maxBodyBytes ?? BODY_LIMIT_BYTES });
  if (bodyRaw === null) {
    return { ok: false, reason: 'body_too_large', httpStatus: 413 };
  }

  // ─── Synchronous block — no `await` until `add()` finishes. ───
  if (nonceStore.has(nonce)) {
    return { ok: false, reason: 'replay', httpStatus: 401 };
  }

  const { raw: expected } = signDaemonRequest({
    secret,
    ts,
    nonce,
    method: req.method ?? 'GET',
    pathWithQuery: req.url ?? '/',
    bodyRaw,
  });
  if (!checkSig(sig, expected)) {
    return { ok: false, reason: 'sig_mismatch', httpStatus: 401 };
  }

  nonceStore.add(nonce, clock.now() + NONCE_TTL_MS);
  // ─── End synchronous block. ───
  return { ok: true, appId, bodyRaw };
}
