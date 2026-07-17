/**
 * Daemon-internal HTTP client (PR2 C7) — used by daemon processes to talk to
 * the dashboard's `/__daemon/*` Route B endpoints with HMAC auth.
 *
 * Retry policy (codex C7 gate):
 *   - GET defaults to N retries with exponential backoff. Each attempt mints
 *     a fresh `ts + nonce + sig`; we never reuse a signature.
 *   - Non-GET (POST/PUT/DELETE) defaults to NO retry to avoid double-effect
 *     on close/resume/leave/disband/settings-write/etc. Callers can opt in
 *     with `retryUnsafeWrites: true` when they're confident the endpoint is
 *     idempotent end-to-end.
 *   - 401 is never retried (sig will not become valid by retrying).
 *   - 4xx other than 408/429 is also never retried.
 *   - Network errors and timeouts follow the same per-method policy.
 *
 * Signed `pathWithQuery` is forwarded BYTE-FOR-BYTE to fetch; we never
 * canonicalise the query string. Callers that build URLs MUST control their
 * own parameter order.
 *
 * The client never touches the real dashboard in tests — `fetch` / `now` /
 * `randomNonce` / `secret` are all injectable.
 */

import { randomBytes } from 'node:crypto';

import { dashboardSecretPath } from '../core/dashboard-secret.js';
import { loadDashboardSecret } from './auth.js';
import { signDaemonRequest } from './daemon-internal-auth.js';

const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:7891';
const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_BASE_BACKOFF_MS = 100;
const DEFAULT_MAX_BACKOFF_MS = 5_000;

const SECRET_PATH_DEFAULT = dashboardSecretPath();

export interface DaemonClientOptions {
  /** Base URL of the dashboard process (default `http://127.0.0.1:7891`). */
  dashboardUrl?: string;
  /** Override the HMAC key. Production loads from `.dashboard-secret` if omitted. */
  secret?: string;
  /** Override `.dashboard-secret` path (tests). */
  secretPath?: string;
  /** Identifier this daemon reports in the `X-Botmux-Daemon-AppId` header (audit, not authn). */
  appId: string;
  /** Override `fetch` (tests). */
  fetch?: typeof fetch;
  /** Override `Date.now` (tests). */
  now?: () => number;
  /** Override nonce source (tests). Default 32 random bytes base64url. */
  randomNonce?: () => string;
  /** Default retry count for GETs / write+retryUnsafeWrites. Default 3. */
  retries?: number;
  /** Override backoff schedule. Default: min(100ms * 2^attempt, 5000ms). */
  backoffMs?: (attempt: number) => number;
  /** Per-request timeout default. Default 5000ms. */
  timeoutMs?: number;
  /** Skip sleeping between retries — used by tests to keep runtime O(ms). */
  skipBackoffSleep?: boolean;
}

export interface DaemonRequestOptions {
  method?: string;
  /** Path + query as a single string, e.g. '/__daemon/sessions-list?all=1'. Signed verbatim. */
  path: string;
  body?: unknown;
  retryUnsafeWrites?: boolean;
  retries?: number;
  timeoutMs?: number;
}

export interface DaemonClientResponse {
  status: number;
  /** Decoded JSON when the response was JSON; otherwise the raw text. */
  body: unknown;
  /** Raw response text (whether or not it was JSON-parseable). */
  raw: string;
}

export interface DaemonClient {
  request(opts: DaemonRequestOptions): Promise<DaemonClientResponse>;
}

function defaultBackoffMs(attempt: number): number {
  return Math.min(DEFAULT_BASE_BACKOFF_MS * 2 ** attempt, DEFAULT_MAX_BACKOFF_MS);
}

function defaultNonce(): string {
  return randomBytes(32).toString('base64url');
}

function loadSecretFromFile(secretPath: string): string {
  const secret = loadDashboardSecret(secretPath);
  if (!secret) throw new Error('dashboard_secret_missing');
  return secret;
}

/**
 * Decide whether the failed attempt is retriable.
 *  - 401 → never (signature mismatch / replay etc. — retrying with the same
 *    parameters cannot fix it).
 *  - Other 4xx except 408 (Request Timeout) and 429 (Too Many Requests) →
 *    never retry; these are caller-side errors.
 *  - 5xx / 408 / 429 / network error → retry only when `retryAllowed`.
 */
function isRetriable(status: number | undefined, retryAllowed: boolean): boolean {
  if (!retryAllowed) return false;
  if (status === undefined) return true; // network error / timeout
  if (status === 401) return false;
  if (status >= 400 && status < 500) {
    return status === 408 || status === 429;
  }
  return status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createDaemonClient(opts: DaemonClientOptions): DaemonClient {
  const dashboardUrl = opts.dashboardUrl ?? DEFAULT_DASHBOARD_URL;
  const secret = opts.secret?.trim() ?? loadSecretFromFile(opts.secretPath ?? SECRET_PATH_DEFAULT);
  if (!secret) throw new Error('dashboard_secret_missing');
  const appId = opts.appId;
  const fetchFn = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const nonceFn = opts.randomNonce ?? defaultNonce;
  const defaultRetries = opts.retries ?? DEFAULT_RETRIES;
  const backoffMs = opts.backoffMs ?? defaultBackoffMs;
  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const skipSleep = opts.skipBackoffSleep === true;

  async function request(reqOpts: DaemonRequestOptions): Promise<DaemonClientResponse> {
    const method = (reqOpts.method ?? 'GET').toUpperCase();
    const isGet = method === 'GET';
    const retryAllowed = isGet || reqOpts.retryUnsafeWrites === true;
    // `retries` is the number of EXTRA attempts on top of the initial one,
    // so `retries=0` means one attempt and no retry. Negative values clamp
    // to 0 rather than throwing — caller intent is "no retry".
    const retryCount = Math.max(0, reqOpts.retries ?? defaultRetries);
    const maxAttempts = retryAllowed ? retryCount + 1 : 1;
    const timeoutMs = reqOpts.timeoutMs ?? defaultTimeoutMs;
    const bodyRaw = reqOpts.body === undefined ? '' : JSON.stringify(reqOpts.body);
    const fetchUrl = dashboardUrl + reqOpts.path;

    let lastResponse: DaemonClientResponse | undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Every attempt MUST mint a fresh ts + nonce + sig — server enforces a
      // 10-min nonce TTL but ALSO has a ±60s ts window, and reusing the same
      // (ts, nonce) just causes a guaranteed `replay` rejection.
      const ts = String(now());
      const nonce = nonceFn();
      const { wire } = signDaemonRequest({
        secret, ts, nonce, method, pathWithQuery: reqOpts.path, bodyRaw,
      });

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetchFn(fetchUrl, {
          method,
          headers: {
            'x-botmux-daemon-ts': ts,
            'x-botmux-daemon-nonce': nonce,
            'x-botmux-daemon-sig': wire,
            'x-botmux-daemon-appid': appId,
            'content-type': 'application/json',
          },
          body: bodyRaw.length > 0 ? bodyRaw : undefined,
          signal: controller.signal,
        });
        const text = await res.text();
        let parsed: unknown;
        try { parsed = text.length > 0 ? JSON.parse(text) : undefined; }
        catch { parsed = text; }
        lastResponse = { status: res.status, body: parsed, raw: text };

        if (res.status < 400) return lastResponse;
        if (!isRetriable(res.status, retryAllowed)) return lastResponse;
        if (attempt === maxAttempts - 1) return lastResponse;
        if (!skipSleep) await sleep(backoffMs(attempt));
      } catch (error: unknown) {
        lastError = error;
        if (!isRetriable(undefined, retryAllowed)) throw error;
        if (attempt === maxAttempts - 1) throw error;
        if (!skipSleep) await sleep(backoffMs(attempt));
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    if (lastResponse) return lastResponse;
    throw lastError ?? new Error('daemon_client_unknown_error');
  }

  return { request };
}
