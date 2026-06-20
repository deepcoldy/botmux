import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import {
  readFileSync, existsSync, mkdirSync, chmodSync,
} from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { dirname } from 'node:path';

const NONCE_TTL_MS = 60_000;
const TS_WINDOW_S = 30;

const seenNonces = new Map<string, number>();   // nonce → expiresAt

export interface HmacAttempt { ts: string; nonce: string; sig: string; }

/**
 * Canonical "binding" string mixed into the signed payload so a captured HMAC
 * header can't be replayed against a different route or port. Without it, a
 * single set of `X-Botmux-Cli-*` headers signed only over `ts:nonce` is valid
 * for ANY `/__cli/*` route on ANY dashboard — which lets a malicious local
 * server, handed a discovery probe, forward the headers to the real dashboard
 * (e.g. a `/__cli/current` probe relayed to `/__cli/rotate` to mint a token).
 * Binding `method + path + bound-port` makes the credential single-purpose:
 *  - the verifier uses the port IT actually bound (not the attacker-controlled
 *    Host header), so a forward from port X to the dashboard on port Y mismatches;
 *  - a `/__cli/current` capture can't be replayed to `/__cli/rotate` (path differs).
 */
export function cliAuthBind(method: string, path: string, port: number | string): string {
  return `${String(method).toUpperCase()} ${path} ${port}`;
}

/** Mint the three `X-Botmux-Cli-*` header values for a loopback request.
 *  Pass the same `bind` (see {@link cliAuthBind}) the verifier will reconstruct;
 *  omit it only for the legacy daemon-IPC scheme that signs bare `ts:nonce`. */
export function signCliAuth(secretB64Url: string, bind?: string): HmacAttempt {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(8).toString('hex');
  const msg = bind ? `${ts}:${nonce}:${bind}` : `${ts}:${nonce}`;
  const sig = createHmac('sha256', secretB64Url).update(msg).digest('base64url');
  return { ts, nonce, sig };
}

/**
 * Verify a CLI rotation HMAC attempt.
 * - Source IP must be loopback (127.0.0.1 / ::1 / IPv4-mapped form).
 * - Timestamp must be within ±TS_WINDOW_S seconds of now.
 * - Nonce must not have been seen in the last NONCE_TTL_MS.
 * - HMAC-SHA256(secret, `${ts}:${nonce}` [+ `:${bind}`]) must match `sig`
 *   (timing-safe). Pass `bind` (method+path+port) to scope the credential to a
 *   single route/port; omit it for the legacy bare daemon-IPC scheme.
 */
export function verifyHmac(
  secretB64Url: string,
  attempt: HmacAttempt,
  remoteAddr: string,
  bind?: string,
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

  const msg = bind ? `${attempt.ts}:${attempt.nonce}:${bind}` : `${attempt.ts}:${attempt.nonce}`;
  const expected = createHmac('sha256', secretB64Url).update(msg).digest();
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

/**
 * Load the persisted active dashboard token from `tokenPath`, or `null` when
 * the file is absent / empty / unreadable.
 *
 * Persisting the active token lets a previously-issued dashboard URL survive a
 * `botmux restart`: on startup the dashboard hydrates `activeToken` from this
 * file instead of starting blank.  Only `botmux dashboard` rotates the token
 * (via `persistToken` with a fresh value), which is what invalidates the old
 * link.
 */
export function loadPersistedToken(tokenPath: string): string | null {
  try {
    if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf8').trim() || null;
  } catch { /* unreadable token file → behave as if none persisted */ }
  return null;
}

/** Persist the active dashboard token to `tokenPath` with 0600 perms. */
export function persistToken(tokenPath: string, token: string): void {
  mkdirSync(dirname(tokenPath), { recursive: true });
  atomicWriteFileSync(tokenPath, token, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
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

/** Tokenless-readable API paths when `config.dashboard.publicReadOnly` is on.
 *  ALLOW-LIST (fail-closed): only the "watch work" surfaces the read-only
 *  dashboard renders. Anything NOT in this set stays behind the active token
 *  even in public mode — so a newly-added GET endpoint is private by default
 *  and can't silently leak (connector configs, webhook-secret metadata,
 *  trigger logs, role/persona files, per-bot config, onboarding, raw PTY are
 *  all absent on purpose). Workflow reads + the static SPA shell are public in
 *  ALL modes and handled separately in decideDashboardAuth.
 *  口径：公开 = 会话板 / 排程(脱敏) / 设置(只读) / 群名册 / 事件流 / workflow 进度。 */
const PUBLIC_READ_PATHS: ReadonlySet<string> = new Set([
  '/api/sessions',    // session board
  '/api/schedules',   // schedules page — task prompt redacted for anon upstream
  '/api/settings',    // read-only settings — only public flags + authed:false
  '/api/groups',      // board name maps: bot friendly name + group name
  '/events',          // SSE stream — schedule prompt redacted for anon upstream
]);

export function decideDashboardAuth(opts: {
  method: string;
  pathname: string;
  hasTokenParam: boolean;
  presentedToken: string | undefined;
  activeToken: string;
  /** When true (config.dashboard.publicReadOnly), the GET/HEAD paths in
   *  PUBLIC_READ_PATHS (the "watch work" board surfaces) are readable WITHOUT
   *  a token — a tokenless (or stale-token) visitor gets a read-only dashboard
   *  instead of a 401 wall. Everything else (management/config reads, raw PTY,
   *  all writes) still requires the active token. */
  publicReadOnly?: boolean;
}): AuthDecision {
  const { method, pathname, hasTokenParam, presentedToken, activeToken, publicReadOnly } = opts;

  // `…/terminal-log/raw` streams full PTY bytes (`?stream=pty`) or worker
  // diagnostic log (`?stream=diag`). PTY transcript can leak API keys / env
  // vars / token reads that happened to scroll the terminal, so both stream
  // variants stay behind cookie auth in EVERY mode (workflow reads excluded).
  const isRawTerminalLog = pathname.endsWith('/terminal-log/raw');

  // Workflow read-only paths + static SPA shell are public in EVERY mode — the
  // dashboard must be linkable from Lark cards without forcing a
  // `botmux dashboard` round-trip.  Write actions still need a cookie / token.
  const isWorkflowReadOnly =
    method === 'GET' &&
    pathname.startsWith('/api/workflows/') &&
    !isRawTerminalLog;
  const isStaticShell =
    method === 'GET' &&
    (pathname === '/' || pathname.startsWith('/assets/') || pathname.startsWith('/game/'));

  // Public read-only mode opens ONLY the allow-listed "watch work" reads
  // (PUBLIC_READ_PATHS) — fail-closed: a path not on the list stays token-gated
  // even under publicReadOnly, so new endpoints don't silently become public.
  const isPublicRead =
    !!publicReadOnly &&
    (method === 'GET' || method === 'HEAD') &&
    PUBLIC_READ_PATHS.has(pathname);

  const authed = !!presentedToken && presentedToken === activeToken;

  if (!authed && !isWorkflowReadOnly && !isStaticShell && !isPublicRead) {
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
