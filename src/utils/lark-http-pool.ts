/**
 * Dedicated HTTP connection pool for large Lark media uploads (screenshots,
 * `botmux send --images`, avatars, files).
 *
 * Why this exists: the official SDK's `defaultHttpInstance` is one module-level
 * axios singleton shared by every `Client`, created with no agent options. In
 * the Bun runtime over a lossy corporate path, reusing that keep-alive pool for
 * large POSTs lets a socket the edge/LB has silently half-closed (or a
 * connection wedged after the request body was fully written but before any
 * response) stay resident. The next upload then writes its whole body, the
 * bytes are TCP-ACKed, but no HTTP response ever arrives — the request burns
 * the whole timeout and every later upload on the same pool fails identically
 * until the process restarts. A fresh short-lived process uploading the same
 * bytes succeeds, isolating the fault to the in-process pool rather than the
 * network (observed in production: ~200 KB uploads, fixed ~2 KB reply, ~5.6 s
 * timeout, rotation across many edge IPs, all failing; one-shot CLI upload of
 * 960 KB succeeding at the same moment).
 *
 * Two mitigations, deliberately small:
 *  - dedicated keep-alive agents (NOT the SDK singleton) with a short idle TTL,
 *    so pooled sockets are closed by the client before an intermediary can
 *    silently reclaim them;
 *  - {@link resetLarkUploadPool} after a transport-level failure force-destroys
 *    the agents and drops the cached instance, so a wedged connection can never
 *    serve a second request; the next call rebuilds a clean pool. Normal HTTP
 *    status responses (4xx/5xx) are NOT transport failures and do not reset.
 */
import * as http from 'node:http';
import * as https from 'node:https';

export interface LarkUploadHttpPool {
  /** axios instance to pass to `new Lark.Client({ httpInstance })`. */
  instance: any;
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
}

/** Idle keep-alive probe / TTL — kept short relative to intermediary timeouts. */
const KEEP_ALIVE_MSECS = 5_000;
/** Close a pooled socket that has been idle this long (client-side TTL). */
const KEEP_ALIVE_TIMEOUT_MSECS = 15_000;
/** Uploads are bounded and low-concurrency (screenshot single-flight per worker). */
const MAX_SOCKETS = 4;
const MAX_FREE_SOCKETS = 2;

export interface LarkHttpPoolOptions {
  /** Per-request timeout (ms) baked into the axios instance. */
  timeoutMs: number;
}

/**
 * Build an independent axios instance from the SDK's separable
 * `defaultHttpInstance`, copying its UA/response-unwrap interceptors so
 * responses behave identically. Returns null when the SDK no longer exposes a
 * separable instance (callers then degrade to the shared SDK client).
 */
export function createLarkUploadHttpPool(
  sdkNamespace: { defaultHttpInstance?: any } | null | undefined,
  opts: LarkHttpPoolOptions,
): LarkUploadHttpPool | null {
  let base: any;
  try {
    // Namespace access (not a named import): a stripped/mocked SDK that omits
    // this export yields undefined rather than throwing.
    base = sdkNamespace?.defaultHttpInstance;
  } catch {
    base = undefined;
  }
  if (!base || typeof base.create !== 'function') return null;

  const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: MAX_SOCKETS,
    maxFreeSockets: MAX_FREE_SOCKETS,
    keepAliveMsecs: KEEP_ALIVE_MSECS,
    timeout: KEEP_ALIVE_TIMEOUT_MSECS,
  });
  const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: MAX_SOCKETS,
    maxFreeSockets: MAX_FREE_SOCKETS,
    keepAliveMsecs: KEEP_ALIVE_MSECS,
    timeout: KEEP_ALIVE_TIMEOUT_MSECS,
  });

  const instance = base.create({ timeout: opts.timeoutMs, httpAgent, httpsAgent });
  try {
    for (const handler of base.interceptors?.request?.handlers ?? []) {
      if (handler) {
        instance.interceptors.request.use(handler.fulfilled, handler.rejected, {
          synchronous: handler.synchronous,
        });
      }
    }
    for (const handler of base.interceptors?.response?.handlers ?? []) {
      if (handler) {
        instance.interceptors.response.use(handler.fulfilled, handler.rejected);
      }
    }
  } catch {
    // An interceptor shape change must not brick uploads; degrade to the shared
    // instance rather than misreading unwrapped responses.
    httpAgent.destroy();
    httpsAgent.destroy();
    return null;
  }
  return { instance, httpAgent, httpsAgent };
}

/**
 * Whether a failed upload error represents a transport-level failure (stalled
 * socket / timeout / reset) rather than a normal HTTP status reply. Axios sets
 * `error.response` for any completed HTTP response, even 4xx/5xx.
 */
export function isLarkTransportError(reason: unknown): boolean {
  const err = reason as { response?: unknown } | null | undefined;
  return !(err && err.response);
}
