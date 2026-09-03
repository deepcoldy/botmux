/**
 * `fetch`-shaped client for **loopback-only** HTTP, built on `node:http`.
 *
 * ⚠️ WHY THIS EXISTS — DO NOT "SIMPLIFY" ANY CALLER BACK TO THE GLOBAL `fetch`.
 *
 * Bun's `fetch` automatically routes through `$http_proxy`, and its `no_proxy`
 * handling is **literal-match only**: it does not parse CIDR notation and does
 * not treat `localhost` as covering `127.0.0.1`. Corporate dev machines commonly
 * export exactly that shape (`http_proxy=…` plus `no_proxy=…,127.0.0.0/8,…`), so
 * a request to our OWN loopback port gets handed to the corporate proxy, which
 * refuses to forward an internal address and answers with an nginx HTML
 * `403 Forbidden`. The user sees a failure naming a service that is running
 * perfectly well two ports away.
 *
 * Measured on Bun 1.4.0 (source AND `bun build --compile`), one fresh process per
 * row because Bun snapshots proxy configuration at startup:
 *
 *   no_proxy unset / ""        → proxied
 *   no_proxy=127.0.0.0/8       → proxied      ← the common corporate shape
 *   no_proxy=localhost         → proxied      ← does NOT cover 127.0.0.1
 *   no_proxy=127.0.0.1         → direct
 *   no_proxy=*                 → direct
 *
 * And the obvious escapes do not work:
 *
 *   fetch(…, {proxy: ''|undefined|null})  → still proxied (option exists ≠ works)
 *   delete process.env.http_proxy at run  → still proxied (startup snapshot)
 *   setting  process.env.http_proxy later → still direct  (same reason)
 *
 * `node:http` ignores proxy environment variables entirely, in both Node and Bun,
 * which is the only reliable way to guarantee a loopback dial stays loopback.
 * Related precedent: `platform/platform-http.ts` (deliberately avoids undici) and
 * `dashboard/hd2d-assets.ts` (the reverse case — it WANTS the proxy).
 */

import { Buffer } from 'node:buffer';
import { requestLiteralLoopback, type LiteralLoopbackHost } from './loopback-target.js';

/** The subset of RequestInit our loopback callers use. */
export interface LoopbackFetchInit {
  method?: string;
  headers?: HeadersInit;
  /** Accepts what `fetch` accepts; streams are the one thing we cannot forward. */
  body?: BodyInit | null;
  signal?: AbortSignal | null;
}

/** Normalise a fetch-style body to bytes. Streams are rejected loudly rather
 *  than silently sent as "[object ReadableStream]". */
function bodyToBuffer(body: BodyInit | null | undefined): Buffer | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new TypeError('loopbackFetch: unsupported body type (streams/FormData are not forwarded)');
}

function headerEntries(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  // `Headers` (and anything iterable of pairs) normalises casing for us; a plain
  // object is passed through as written.
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[k] = String(v);
    return out;
  }
  for (const [k, v] of Object.entries(headers)) out[k] = String(v);
  return out;
}

/**
 * The error an aborted request must fail with.
 *
 * ⚠️ Callers branch on `err.name === 'AbortError'` to tell "timed out" from
 * "nothing listening" — e.g. daemon.ts returns 504 `wait_timeout` vs 503
 * `daemon_offline`, and command-handler.ts reports `busy` vs `failed`. A plain
 * `new Error('aborted')` (or node:http's own ECONNRESET) silently sends every
 * timeout down the wrong branch. Measured against the global fetch these replace:
 * it rejects with `name=AbortError`, while the first version of this module gave
 * `name=Error, code=ECONNRESET`.
 *
 * `signal.reason` is what the platform puts there (a DOMException named
 * AbortError, or whatever the caller passed to `abort(reason)`); we only
 * synthesise an equivalent when it is somehow absent.
 */
function abortError(signal: AbortSignal | null | undefined): unknown {
  const reason = signal?.reason;
  if (reason !== undefined && reason !== null) return reason;
  // Node and browsers both expose DOMException; fall back to a shaped Error.
  if (typeof DOMException === 'function') {
    return new DOMException('The operation was aborted.', 'AbortError');
  }
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * Issue one request to a literal loopback host and resolve a real `Response`, so
 * call sites keep using `.ok` / `.status` / `.json()` / `.text()` unchanged.
 *
 * ⚠️ Resolves as soon as the response HEADERS arrive, with the body exposed as a
 * `ReadableStream` — it must NOT buffer to completion first. `dashboard/aggregator.ts`
 * subscribes to a never-ending SSE stream (`/api/events`) and reads frames off
 * `res.body`; a buffer-all implementation never resolves for those callers and the
 * whole session/event aggregation silently stops. Measured: a server that writes
 * one frame and holds the connection open produced no Response at all until this
 * was made streaming. `.text()`/`.json()` still work, because `Response` drains
 * the stream for them.
 *
 * Rejects the way `fetch` does (a transport failure) rather than resolving a
 * synthetic error status, because callers distinguish "no server there" from
 * "server said no".
 */
/**
 * Test-only transport override.
 *
 * ⚠️ Why this seam exists: several suites drive loopback code paths by replacing
 * `globalThis.fetch`. Moving those call sites onto node:http silently bypassed
 * that stub, so the tests began making REAL connections to ports like 4310/39003
 * — `fetchMock` recorded 0 calls and the assertions failed for a reason unrelated
 * to what they test. Rather than push every caller back onto the global fetch (the
 * whole defect), the transport itself is injectable: production keeps node:http,
 * tests install a mock here.
 *
 * Not for production use — `__setLoopbackTransportForTests(undefined)` restores the default.
 */
let transportOverride: ((url: string, init: LoopbackFetchInit) => Promise<Response>) | undefined;

/** Install (or clear, with `undefined`) the test transport. Returns the previous one. */
export function __setLoopbackTransportForTests(
  next: ((url: string, init: LoopbackFetchInit) => Promise<Response>) | undefined,
): ((url: string, init: LoopbackFetchInit) => Promise<Response>) | undefined {
  const previous = transportOverride;
  transportOverride = next;
  return previous;
}

export function loopbackFetch(
  url: string,
  init: LoopbackFetchInit = {},
): Promise<Response> {
  if (transportOverride) return transportOverride(url, init);
  const target = new URL(url);
  // ⚠️ FAIL CLOSED on the scheme. This transport IS node:http, so an `https:` URL
  // would be dialled as PLAINTEXT — measured: `loopbackFetch('https://127.0.0.1:P')`
  // against a plain HTTP server returned `200 PLAIN`, i.e. a caller that believed it
  // was using TLS would have sent its credentials in the clear. `isLoopbackUrl`
  // already refuses https, but a public helper must not depend on callers routing
  // through a predicate first.
  if (target.protocol !== 'http:') {
    return Promise.reject(new TypeError(
      `loopbackFetch: only http: is supported (got ${target.protocol})`,
    ));
  }
  // `URL.hostname` keeps IPv6 in brackets (`[::1]`), but node:http — and
  // requestLiteralLoopback's allow-list — want the bare address. Passing the
  // bracketed form through was rejected as `remote_host_forbidden`, i.e. a legal
  // IPv6 loopback URL could never be dialled (measured against a `::1` server).
  const host = normaliseLoopbackHost(target.hostname) as LiteralLoopbackHost;
  // `URL` normalises away a scheme's DEFAULT port, so both `http://127.0.0.1/x` and
  // an explicit `http://127.0.0.1:80/x` yield `port === ''` — `Number('')` is 0 and
  // was rejected as `invalid_port` (measured against a local server on :80, which the
  // native fetch reaches fine). Fill in the scheme default.
  const port = target.port ? Number(target.port) : 80;
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = headerEntries(init.headers);
  const body = bodyToBuffer(init.body);
  // A body without a length makes some servers wait for more; be explicit.
  if (body && headers['content-length'] === undefined && headers['Content-Length'] === undefined) {
    headers['content-length'] = String(body.byteLength);
  }

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    // Set once the signal fires, so the body stream can fail with the SAME
    // AbortError instead of the socket's ECONNRESET.
    let aborted: unknown;
    // ⚠️ The abort listener MUST be removed once this request can no longer be
    // aborted. `{ once: true }` only fires-and-forgets on a real abort; a request
    // that simply COMPLETED left its listener attached, and `dashboard/aggregator.ts`
    // reuses one AbortController across an unbounded SSE reconnect loop — measured,
    // 12 completed requests left 12 listeners, each pinning a finished req/res and
    // its closure, and a later abort would destroy every stale request in turn.
    let detachAbort = () => {};

    let req: ReturnType<typeof requestLiteralLoopback>;
    try {
      req = requestLiteralLoopback(
        // Dial the parsed host/port explicitly (and validated as loopback) rather
        // than handing over the URL, so nothing can re-target the request.
        { host, port },
        {
          path: `${target.pathname}${target.search}`,
          method,
          headers,
        },
        res => {
          const status = res.statusCode ?? 0;
          // Fetch's null-body statuses that can actually ARRIVE HERE are 204/205/304,
          // plus any HEAD response. 101 is deliberately absent: node:http never calls
          // this callback for it (it emits `upgrade` instead — handled below), so a
          // `status === 101` branch here would be dead code that reads as covered. `new Response(stream, {status:205})` THROWS,
          // and it throws inside this async callback — on Node that escaped as an
          // uncaught exception and killed the process, while Bun happens to tolerate
          // 205, which is exactly why it went unnoticed.
          const bodyless = status === 204 || status === 205
            || status === 304 || method === 'HEAD';
          const stream = bodyless ? null : new ReadableStream<Uint8Array>({
            start(controller) {
              res.on('data', (chunk: Buffer | string) => {
                try { controller.enqueue(new Uint8Array(Buffer.from(chunk))); }
                catch { /* already closed by a cancel() */ }
              });
              res.on('end', () => {
                detachAbort();
                try { controller.close(); } catch { /* already closed */ }
              });
              res.on('error', err => {
                detachAbort();
                // An abort must surface as AbortError, not the ECONNRESET that
                // destroying the socket produces.
                try { controller.error(aborted ?? err); } catch { /* already errored */ }
              });
            },
            // A consumer that stops reading (or aborts) must tear the socket down,
            // otherwise a never-ending SSE keeps the connection and the process alive.
            cancel() { detachAbort(); res.destroy(); req.destroy(); },
          });
          if (bodyless) detachAbort();
          // Wrapped: any status the Response constructor refuses (an upstream
          // sending something illegal) must reject this promise, never escape as an
          // uncaught exception out of an HTTP event callback.
          let response: Response;
          try {
            response = new Response(stream, {
              status,
              statusText: res.statusMessage ?? '',
              headers: Object.fromEntries(
                Object.entries(res.headers)
                  .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
              ),
            });
          } catch (err) {
            detachAbort();
            res.destroy();
            finish(() => reject(err));
            return;
          }
          finish(() => resolve(response));
        },
      );
    } catch (err) {
      // Invalid host/port (the loopback guard) — surface it, do not hang.
      detachAbort();
      finish(() => reject(err));
      return;
    }

    // ⚠️ A 101 arrives as `upgrade`, NOT as a response. Without this listener the
    // promise never settles: measured against a server answering 101, the call only
    // ended when an external AbortSignal fired at 800ms (and `requestDashboardAt`
    // passes no signal at all, so it would hang forever if the recorded port happened
    // to be a WebSocket service). The native fetch rejects such a response in ~1ms;
    // do the same, since a fetch-shaped client cannot express a protocol switch.
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      req.destroy();
      detachAbort();
      finish(() => reject(new TypeError(
        'loopbackFetch: server switched protocols (101); this client does not support upgrades',
      )));
    });

    // Only a failure BEFORE the response headers can reject the promise; once the
    // Response exists, later socket errors surface through the stream instead.
    req.on('error', err => { detachAbort(); finish(() => reject(aborted ?? err)); });
    if (init.signal) {
      const signal = init.signal;
      const onAbort = () => {
        aborted = abortError(signal);
        req.destroy();
        finish(() => reject(aborted));
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      detachAbort = () => {
        signal.removeEventListener('abort', onAbort);
        detachAbort = () => {};
      };
    }
    if (body) req.end(body); else req.end();
  });
}

/** `typeof fetch`-compatible view, for defaulting an injectable `fetchImpl`. */
export const loopbackFetchImpl = loopbackFetch as unknown as typeof fetch;

/**
 * Is this URL a literal loopback target, i.e. safe (and necessary) to send through
 * {@link loopbackFetch}? For call sites whose base URL is configurable and may
 * legitimately point at a remote host — those must keep using the global fetch,
 * which handles TLS, redirects and real proxying.
 *
 * Literal only, deliberately: a DNS name that currently resolves to 127.0.0.1
 * is not a loopback guarantee (it can be re-pointed), and `loopbackFetch`'s own
 * guard would reject it anyway.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // `http:` only — this transport IS node:http, so reporting an `https:` URL as
    // loopback-safe would steer a caller onto a transport that cannot serve it.
    if (parsed.protocol !== 'http:') return false;
    const host = normaliseLoopbackHost(parsed.hostname);
    return host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Canonicalise a hostname for the loopback allow-list.
 *
 *  · Strips the brackets `URL.hostname` keeps around IPv6 literals.
 *  · Maps `localhost` to `127.0.0.1`.
 *
 * ⚠️ `localhost` USED to be rejected here, on the reasoning that "a DNS name is
 * not a loopback guarantee". That was backwards: refusing it did not avoid a
 * lookup, it pushed the request onto the GLOBAL fetch, which then proxied it —
 * measured with a self-hosted TTS endpoint, the `Authorization: Bearer …` header
 * arrived at the stand-in proxy. `localhost` is reserved for loopback by RFC 6761,
 * and mapping it here means we dial the literal address and never resolve DNS at
 * all, which is strictly safer than the alternative. Every OTHER hostname stays
 * rejected — that is where the rebinding concern actually applies.
 */
function normaliseLoopbackHost(hostname: string): string {
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return bare === 'localhost' ? '127.0.0.1' : bare;
}
