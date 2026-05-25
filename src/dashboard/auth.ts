import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

const NONCE_TTL_MS = 60_000;
const TS_WINDOW_S = 30;

const seenNonces = new Map<string, number>();   // nonce → expiresAt

export interface HmacAttempt { ts: string; nonce: string; sig: string; }

/**
 * Verify a CLI rotation HMAC attempt.
 * - Source IP must be loopback (127.0.0.1 / ::1 / IPv4-mapped form).
 * - Timestamp must be within ±TS_WINDOW_S seconds of now.
 * - Nonce must not have been seen in the last NONCE_TTL_MS.
 * - HMAC-SHA256(secret, `${ts}:${nonce}`) must match `sig` (timing-safe).
 */
export function verifyHmac(
  secretB64Url: string,
  attempt: HmacAttempt,
  remoteAddr: string,
): { ok: boolean; reason?: string } {
  if (
    remoteAddr !== '127.0.0.1' &&
    remoteAddr !== '::1' &&
    !remoteAddr.endsWith('::ffff:127.0.0.1')
  ) {
    return { ok: false, reason: 'remote_not_loopback' };
  }
  const tsNum = Number(attempt.ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'bad_ts' };
  const nowS = Math.floor(Date.now() / 1000);
  if (Math.abs(nowS - tsNum) > TS_WINDOW_S) return { ok: false, reason: 'ts_window' };

  // GC nonces
  const now = Date.now();
  for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
  if (seenNonces.has(attempt.nonce)) return { ok: false, reason: 'replay' };

  const expected = createHmac('sha256', secretB64Url)
    .update(`${attempt.ts}:${attempt.nonce}`)
    .digest();
  let provided: Buffer;
  try { provided = Buffer.from(attempt.sig, 'base64url'); }
  catch { return { ok: false, reason: 'bad_sig' }; }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'sig_mismatch' };
  }
  seenNonces.set(attempt.nonce, now + NONCE_TTL_MS);
  return { ok: true };
}

/** 32 random bytes base64url-encoded (43 characters, no padding). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Extract `botmux_dashboard_token` value from a Cookie header. */
export function parseCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === 'botmux_dashboard_token') return v;
  }
  return undefined;
}

/** Build the `Set-Cookie` header value for a fresh dashboard token. */
export function buildSetCookie(token: string): string {
  return `botmux_dashboard_token=${token}; HttpOnly; SameSite=Lax; Path=/`;
}

// ─── Per-request auth decision ──────────────────────────────────────────────

/**
 * The dashboard splits incoming requests into three categories before the
 * route handlers run:
 *
 *   - `allow`            — request can proceed (auth succeeded OR endpoint
 *                          is public)
 *   - `allow+set-cookie` — `?t=<correct-token>` query: the cookie is set
 *                          and we redirect to a clean URL.  This is the
 *                          only branch that mints a Set-Cookie header.
 *   - `deny401`          — endpoint requires an authenticated session and
 *                          none was presented.
 *
 * Public surfaces today (codex review v0.1.2 → canary.3):
 *   - `GET /` and `GET /assets/*`              — static SPA shell
 *   - `GET /api/workflows/*`                   — workflow read-only API,
 *                                                EXCEPT `…/terminal-log/raw`
 *                                                which serves full PTY byte
 *                                                streams (may include keys,
 *                                                env, tokens) and requires
 *                                                cookie auth.
 *
 * Anything else (sessions, schedules, dashboard rotate, POST /api/workflows
 * /…/cancel, etc.) requires the active session token, matching the
 * "get_write_link" pattern that the chat web terminal already uses.
 */
export type AuthDecision =
  | { kind: 'allow' }
  | { kind: 'allow+set-cookie'; token: string; redirectTo: string }
  | { kind: 'deny401' };

export function decideDashboardAuth(opts: {
  method: string;
  pathname: string;
  hasTokenParam: boolean;
  presentedToken: string | undefined;
  activeToken: string;
}): AuthDecision {
  const { method, pathname, hasTokenParam, presentedToken, activeToken } = opts;

  // Workflow read-only paths + static SPA shell are public — the dashboard
  // must be linkable from Lark cards without forcing a `botmux dashboard`
  // round-trip.  Write actions still need a cookie / token.
  //
  // Carve-out: `…/terminal-log/raw` streams full PTY bytes (`?stream=pty`) or
  // worker diagnostic log (`?stream=diag`).  PTY transcript can leak API
  // keys / env vars / token reads that happened to scroll the terminal, so
  // we keep both stream variants behind cookie auth even though the rest of
  // the read-only API is link-shareable.
  const isWorkflowReadOnly =
    method === 'GET' &&
    pathname.startsWith('/api/workflows/') &&
    !pathname.endsWith('/terminal-log/raw');
  const isStaticShell =
    method === 'GET' && (pathname === '/' || pathname.startsWith('/assets/'));

  const authed = !!presentedToken && presentedToken === activeToken;

  if (!authed && !isWorkflowReadOnly && !isStaticShell) {
    return { kind: 'deny401' };
  }

  // First hit with `?t=<correct token>` sets the cookie + redirects to the
  // clean URL.  Only reached when the token matched (`authed === true`).
  if (hasTokenParam && authed && presentedToken) {
    return {
      kind: 'allow+set-cookie',
      token: presentedToken,
      redirectTo: pathname || '/',
    };
  }

  return { kind: 'allow' };
}
