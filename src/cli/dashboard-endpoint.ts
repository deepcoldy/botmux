import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { cliAuthBind, loadDashboardSecret, signCliAuth } from '../dashboard/auth.js';
import { loopbackFetchImpl } from '../core/loopback-fetch.js';

/**
 * Loopback HMAC client for the dashboard process's `/__cli/*` endpoints, used by
 * `botmux dashboard [current|rotate]` and the post-start/restart hint.
 *
 * Two subtleties this module exists to handle correctly:
 *
 * 1. **404 is ambiguous.** Only the dashboard's `/__cli/current` returns 404 to
 *    mean "no token minted yet" (`{ error: 'no_active_token' }`). Any *other*
 *    404 means the request hit a server that doesn't speak the `/__cli`
 *    protocol — most commonly the daemon IPC server, whose unknown-route 404 is
 *    `{ error: 'not_found', path }`. Conflating the two surfaces the infamous
 *    misleading `Rotation failed: no-active-token` when the real problem is that
 *    `.dashboard-port` points at the wrong service.
 *
 * 2. **`.dashboard-port` can go stale.** The dashboard (wildcard) and the daemon
 *    IPC servers (loopback) both `listenWithProbe` upward. Their base ports are
 *    now kept disjoint (config.dashboard.port 7891 + probe span vs ipcBasePort
 *    7950 — see config.ts, guarded by dashboard-ipc-port-range.test.ts), so a
 *    recorded dashboard port should no longer end up owned by an IPC server. The
 *    HMAC self-heal below stays as defense-in-depth: when the recorded port
 *    answers as the *wrong service* (e.g. a foreign squatter pushed the dashboard
 *    onto an unexpected port), we rediscover the real dashboard by HMAC-probing
 *    the probe range (only the genuine dashboard can validate the signature) and
 *    self-heal `.dashboard-port`.
 */

export type DashboardEndpoint = '/__cli/rotate' | '/__cli/ensure' | '/__cli/current' | '/__cli/reload-binding';

export type DashboardFailReason =
  | 'no-secret'
  | 'unreachable'
  | 'auth-failed'
  | 'http-error'
  | 'no-active-token'
  | 'wrong-service';

export type DashboardResult =
  | {
    ok: true;
    url: string;
    localUrl?: string;
    /**
     * Does `url` route through the CENTRAL PLATFORM? Reported by the dashboard
     * process that built the URL — the only process that knows, and therefore
     * the only honest source. A CLI that re-derives it from its own config can
     * disagree (config caches, or a caller that hardcodes it: `bind.ts` did,
     * and stripped tokens into dead links). Absent on older dashboards, where
     * it parses as `false` — fail-safe, since false only means "keep the token".
     */
    platformHosted?: boolean;
  }
  | { ok: false; reason: DashboardFailReason; detail?: string };

type FetchImpl = typeof fetch;

/**
 * Classify a 404 from a `/__cli/*` request. A genuine "no token yet" only comes
 * from `/__cli/current` carrying `{ error: 'no_active_token' }`; everything else
 * means the port is answering for some other service (daemon IPC, a stray HTTP
 * server, …), not one of the dashboard CLI routes.
 */
export function classifyDashboard404(path: DashboardEndpoint, bodyText: string): DashboardResult {
  let body: unknown = null;
  try { body = JSON.parse(bodyText); } catch { /* non-JSON body → wrong service */ }
  const err = (body && typeof body === 'object') ? (body as { error?: unknown }).error : undefined;
  if (path === '/__cli/current' && err === 'no_active_token') {
    return { ok: false, reason: 'no-active-token' };
  }
  return {
    ok: false,
    reason: 'wrong-service',
    detail: bodyText ? `404 ${bodyText.slice(0, 200)}` : '404',
  };
}

/**
 * A 401 sig_mismatch from the recorded port does NOT prove that we reached the
 * live dashboard. On macOS a wildcard dashboard bind can coexist with another
 * process listening on 127.0.0.1:same-port, so the CLI's loopback request may
 * hit the shadowing process or a stale dashboard. Treat it as rediscoverable.
 */
export function classifyDashboard401(bodyText: string): DashboardResult {
  let body: unknown = null;
  try { body = JSON.parse(bodyText); } catch { /* non-JSON 401 */ }
  const err = (body && typeof body === 'object') ? (body as { error?: unknown }).error : undefined;
  const authReason = (body && typeof body === 'object') ? (body as { reason?: unknown }).reason : undefined;
  if (err === 'unauthorized' && authReason === 'sig_mismatch') {
    return {
      ok: false,
      reason: 'auth-failed',
      detail: bodyText ? `401 ${bodyText.slice(0, 200)}` : '401 sig_mismatch',
    };
  }
  return {
    ok: false,
    reason: 'http-error',
    detail: bodyText ? `401 ${bodyText.slice(0, 200)}` : '401',
  };
}

/** Issue a single HMAC-authed request to one candidate port. */
export async function requestDashboardAt(opts: {
  host: string;
  port: number;
  path: DashboardEndpoint;
  secret: string;
  fetchImpl?: FetchImpl;
  /**
   * Abort the request after this long. REQUIRED for discovery: a local service
   * that accepts the TCP connection but never sends HTTP headers would otherwise
   * hang the whole serial probe loop forever (`loopbackFetch` sets no request
   * timeout of its own), so a single stalled port could permanently wedge
   * `botmux dashboard` before it ever reaches the real dashboard.
   */
  timeoutMs?: number;
}): Promise<DashboardResult> {
  const { host, port, path, secret } = opts;
  // Default is the proxy-immune loopback client above, NOT the global `fetch`.
  const fetchImpl = opts.fetchImpl ?? loopbackFetchImpl;
  // Bind the credential to method + path + the port we're dialing. A malicious
  // server handed these headers during discovery therefore can't forward them
  // to a different `/__cli/*` route or to the real dashboard on another port —
  // the verifier reconstructs the bind from the port IT bound, so any forward
  // mismatches the signature (and the attacker can't re-sign without the secret).
  const { ts, nonce, sig } = signCliAuth(secret, cliAuthBind('POST', path, port));

  const ac = opts.timeoutMs === undefined ? null : new AbortController();
  const timer = ac ? setTimeout(() => ac.abort(), opts.timeoutMs) : null;
  try {
    // The timeout must span the WHOLE exchange, not just the headers: a fetch
    // resolves its Response as soon as headers arrive, so a server that sends
    // `200 application/json` and then stalls mid-body would hang forever in
    // `.text()`/`.json()` below. MEASURED: with the timer cleared right after the
    // fetch, exactly that shape wedged the CLI (outer timeout, rc=124).
    const res = await fetchImpl(`http://${host}:${port}${path}`, {
      method: 'POST',
      headers: {
        'X-Botmux-Cli-Ts': ts,
        'X-Botmux-Cli-Nonce': nonce,
        'X-Botmux-Cli-Auth': sig,
      },
      ...(ac ? { signal: ac.signal } : {}),
    });
    // Read the body ONCE, and never swallow a failed read. Every status branch used
    // to do `.text().catch(() => '')`, which turns an ABORTED body into a normal
    // empty body — so a server answering `500 headers` + a body that never
    // completes was classified `http-error`. That matters beyond the label:
    // `reachedDashboard(http-error)` is true, so rediscovery STOPS and the stale
    // port file is kept, letting one stalled service permanently block self-heal.
    // MEASURED: recorded port returning `500` + partial body → `http-error` in
    // 305ms, port file unchanged, real dashboard never probed.
    //
    // A COMPLETE body still classifies normally even when malformed; only an
    // aborted/failed read escapes to the catch below as `unreachable`.
    const raw = await res.text();
    if (res.status === 404) return classifyDashboard404(path, raw);
    if (res.status === 401) return classifyDashboard401(raw);
    if (!res.ok) {
      return { ok: false, reason: 'http-error', detail: `${res.status} ${raw}` };
    }
    // reload-binding 不返回 url，200 即成功（仅用于「捅一下 daemon 重连」）
    if (path === '/__cli/reload-binding') return { ok: true, url: '' };
    let body: { url?: string; localUrl?: string; platformHosted?: unknown } = {};
    try {
      body = JSON.parse(raw) as { url?: string; localUrl?: string; platformHosted?: unknown };
    } catch { body = {}; }
    if (!body.url) return { ok: false, reason: 'http-error', detail: 'malformed response (no url)' };
    // localUrl is present only when the dashboard link routes through a remote
    // base — a direct host:port fallback for when that base is down.
    // platformHosted must be strictly `true` to count: a missing field (older
    // dashboard) or any non-boolean must not be read as "safe to strip".
    return {
      ok: true,
      url: body.url,
      localUrl: body.localUrl,
      platformHosted: body.platformHosted === true,
    };
  } catch {
    // Includes the abort and a body that never completes: for our purposes a
    // stalled port is indistinguishable from a dead one, and both must let the
    // probe loop move on. A malformed-but-COMPLETE body never lands here — it is
    // classified above, because only the `.text()` read itself can reject.
    return { ok: false, reason: 'unreachable' };
  } finally {
    // Always clear it — a live timer would keep the CLI's event loop alive.
    if (timer) clearTimeout(timer);
  }
}

/** A result that proves we actually reached the dashboard (vs. wrong port). */
function reachedDashboard(r: DashboardResult): boolean {
  return r.ok || (!r.ok && (r.reason === 'no-active-token' || r.reason === 'http-error'));
}

/**
 * Should a failure on the recorded port trigger a probe-range rescan?
 *
 * `wrong-service` / `auth-failed` mean SOMETHING answered but is not our
 * dashboard, so the recorded port is provably wrong and scanning is safe.
 *
 * `unreachable` is ambiguous — it is BOTH "dashboard still booting" (retry the
 * same port; scanning would be wasted work every tick) AND "the recorded port is
 * a dead value nobody listens on" (retrying can never succeed, so without a scan
 * the port file stays wrong forever). MEASURED on a box where `.dashboard-port`
 * held 7893 while the live dashboard was on 7891 with 0 processes on 7893: every
 * `botmux dashboard` failed, and the existing self-heal never ran because it is
 * gated on someone answering.
 *
 * `allowUnreachableRescan` is how the caller separates the two: a one-shot human
 * command passes true (at worst one scan per invocation); the 500ms readiness poll
 * leaves it false. It is deliberately NOT derived from "is the dashboard coming
 * up?" — that answers `true` for `online` + live pid too, which is exactly the
 * measured failure, so such a gate would never fire on the real bug.
 */
/**
 * Per-probe cap. Loopback only, so a healthy dashboard answers in milliseconds;
 * this exists purely to survive a port that accepts TCP and never replies.
 */
export const DISCOVERY_PROBE_TIMEOUT_MS = 2_000;
/**
 * Cap for the WHOLE serial scan. Without it, `probeSpan × probeTimeout`
 * (21 × 2s) would be the worst case on a host full of stalled loopback services.
 */
export const DISCOVERY_TOTAL_BUDGET_MS = 8_000;

function shouldRediscover(r: DashboardResult, allowUnreachableRescan = false): boolean {
  if (r.ok) return false;
  if (r.reason === 'wrong-service' || r.reason === 'auth-failed') return true;
  return allowUnreachableRescan && r.reason === 'unreachable';
}

/**
 * Resolve the dashboard URL for `path`, trying the recorded port first and
 * self-healing the port file when it points at the wrong service or a loopback
 * shadow returns an HMAC mismatch.
 */
export async function callDashboard(opts: {
  configDir: string;
  defaultPort: number;
  host?: string;
  envPort?: string;
  probeSpan?: number;
  persistPort?: boolean;
  path: DashboardEndpoint;
  fetchImpl?: FetchImpl;
  /**
   * Allow a rescan when the recorded port is simply not listening.
   *
   * Pass true for a ONE-SHOT human command (`botmux dashboard`), which is what
   * `executeDashboardCliCommand` does. Leave it false for the 500ms readiness
   * poll, where `unreachable` is the normal booting state and scanning the range
   * every tick would be pure waste.
   *
   * NOT gated on "the dashboard is not coming up": that observation is `true` for
   * both `launching` AND `online` + live pid, and the measured failure was the
   * latter (dashboard healthy on another port), so such a gate would never fire
   * on the bug this exists for.
   */
  rescanWhenUnreachable?: boolean;
  /** Override the per-probe timeout (default DISCOVERY_PROBE_TIMEOUT_MS). */
  probeTimeoutMs?: number;
  /**
   * Bound the FIRST (recorded-port) request even without opting into a rescan.
   *
   * The readiness poll needs this: its 90s budget is only consulted AFTER
   * `await callDashboard(...)` returns, so a recorded port that accepts the
   * connection and never answers makes the first await hang forever — the outer
   * budget and the retry loop are both unreachable. Bounding the request is the
   * only thing that can interrupt it.
   */
  requestTimeoutMs?: number;
  /** Override the whole-scan budget (default DISCOVERY_TOTAL_BUDGET_MS). */
  discoveryBudgetMs?: number;
}): Promise<DashboardResult> {
  const host = opts.host ?? '127.0.0.1';
  const probeSpan = opts.probeSpan ?? 20;
  const persistPort = opts.persistPort ?? true;
  // Same reason as in requestDashboardAt: the default must stay proxy-immune.
  const fetchImpl = opts.fetchImpl ?? loopbackFetchImpl;

  const secretPath = join(opts.configDir, '.dashboard-secret');
  let secret: string | null;
  try {
    secret = loadDashboardSecret(secretPath);
  } catch (e) {
    return { ok: false, reason: 'no-secret', detail: (e as Error).message };
  }
  if (!secret) return { ok: false, reason: 'no-secret' };

  const portFile = join(opts.configDir, '.dashboard-port');
  const recorded = (existsSync(portFile) ? readFileSync(portFile, 'utf8').trim() : '')
    || opts.envPort
    || String(opts.defaultPort);
  const candidate = Number(recorded);

  const probeTimeoutMs = opts.probeTimeoutMs ?? DISCOVERY_PROBE_TIMEOUT_MS;

  // 1. Try the recorded port. A success — or any state that proves we reached
  //    the dashboard (no-active-token / http-error) — is returned as-is.
  //
  //    This hop must be bounded whenever the caller can't otherwise interrupt it.
  //    An opted-in one-shot command gets `probeTimeoutMs`; the readiness poll
  //    passes `requestTimeoutMs` explicitly, because its own 90s budget is only
  //    checked AFTER this await returns — so a recorded port that accepts and never
  //    answers would hang the first iteration forever, with the outer budget and
  //    the retry loop both unreachable. Callers that pass neither stay unbounded.
  const firstTimeoutMs = opts.requestTimeoutMs
    ?? (opts.rescanWhenUnreachable ? probeTimeoutMs : undefined);
  const first = await requestDashboardAt({
    host, port: candidate, path: opts.path, secret, fetchImpl,
    ...(firstTimeoutMs === undefined ? {} : { timeoutMs: firstTimeoutMs }),
  });
  if (reachedDashboard(first)) return first;

  // 2. Rediscover when the recorded port provably cannot be the dashboard:
  //    something answered but failed identity checks (wrong-service 404 /
  //    sig_mismatch), or — when the caller opted in, i.e. a one-shot human
  //    command — nothing is listening there at all (a dead recorded port, which
  //    retrying the same port can never fix).
  if (!shouldRediscover(first, opts.rescanWhenUnreachable)) return first;

  const base = Number(opts.envPort || opts.defaultPort);
  // TWO bounds, and both are needed. Per-probe alone degrades to
  // `probeSpan × timeout` (21 × 2s ≈ 42s) because the loop is serial; a total
  // deadline alone would let one stalled port consume the entire budget before
  // any other candidate is tried. MEASURED without either: a local service that
  // accepts TCP and never answers made `callDashboard` hang forever.
  const deadline = Date.now() + (opts.discoveryBudgetMs ?? DISCOVERY_TOTAL_BUDGET_MS);
  for (let p = base; p <= base + probeSpan; p++) {
    if (p === candidate) continue;
    // Out of budget: stop and report the ORIGINAL failure. Never invent a reason,
    // and never rewrite the port file on the way out.
    //
    // This `break` and the `Math.min` clamp below have DISTINCT jobs:
    //  • the break stops ISSUING probes once the budget is gone — after the
    //    deadline no further connection or HMAC probe may be attempted at all;
    //  • the clamp bounds the DURATION of a probe that is still allowed to start,
    //    so the last one cannot overrun the budget by a full probeTimeoutMs.
    // Wall-clock alone cannot tell them apart (deleting either leaves a 900ms
    // budget at ~910ms, because a negative `remaining` clamps to a ~0ms timeout and
    // probes then fail instantly). Each is pinned by its own test with a criterion
    // that DOES discriminate: call-count for the break, and `budget <
    // probeTimeoutMs` for the clamp. See dashboard-endpoint.test.ts.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // Probe read-only (`/__cli/current`) so discovery never mints a token on a
    // server we're merely identifying. Only the real dashboard can answer the
    // HMAC-gated route as `ok` or `no-active-token`.
    // Clamp to what is LEFT, or the last probe could overrun the budget by a full
    // probeTimeoutMs (checking the deadline before the probe bounds when we start,
    // not when we finish) — making the "total budget" a soft target rather than a cap.
    const probe = await requestDashboardAt({
      host, port: p, path: '/__cli/current', secret, fetchImpl,
      timeoutMs: Math.min(probeTimeoutMs, remaining),
    });
    if (probe.ok || (!probe.ok && probe.reason === 'no-active-token')) {
      if (persistPort) {
        try { atomicWriteFileSync(portFile, String(p)); } catch { /* best-effort self-heal */ }
      }
      // Found the dashboard — perform the actually-requested op on its port. The
      // real request gets its own fresh timeout: it is not discovery, and it must
      // not inherit whatever the scan already spent.
      return requestDashboardAt({
        host, port: p, path: opts.path, secret, fetchImpl, timeoutMs: probeTimeoutMs,
      });
    }
  }
  // No dashboard found in the probe range; surface the original failure
  // (wrong-service, auth-failed, or unreachable) rather than inventing one.
  return first;
}
