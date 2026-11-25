import type { IncomingMessage, ServerResponse } from 'node:http';
import { requestLiteralLoopback } from '../core/loopback-target.js';
import { readPluginRegistry } from '../services/plugin-registry-store.js';
import type { InstalledPluginRecord } from '../core/plugins/types.js';
import {
  collectConnectionNominatedHeaders,
  collectReservedPluginCallbackEndpoints,
  detectPluginProxyRawTargetKind,
  groupRawHeaders,
  HOP_BY_HOP_HEADERS,
  isLegacyPluginConnectorWebhookTarget,
  matchPluginWebhookRoute,
  parsePluginWebhooksContribution,
  parseRawPluginServiceProxyRequest,
  parseRawPluginWebhookRequest,
  PLUGIN_WEBHOOK_BODY_IDLE_TIMEOUT_MS,
  PLUGIN_WEBHOOK_BODY_READ_TIMEOUT_MS,
  PLUGIN_WEBHOOK_HARD_MAX_BODY_BYTES,
  PLUGIN_WEBHOOK_RESPONSE_MAX_BYTES,
  PLUGIN_WEBHOOK_TIMEOUT_MS,
  upstreamPathMatchesReservedEndpoint,
  validateRawHttpFraming,
} from '../core/plugins/webhooks/protocol.js';
import type { PluginLoopbackTargetResult } from '../core/plugins/webhooks/service-target.js';
import { dashboardH5ClientIp } from './h5-auth.js';

const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_IP_PER_WINDOW = 120;
const DEFAULT_MAX_PER_PLUGIN_PER_WINDOW = 600;
const DEFAULT_MAX_GLOBAL_PER_WINDOW = 1_200;
const DEFAULT_MAX_TRACKED_IPS = 4_096;
const DEFAULT_MAX_TRACKED_PLUGINS = 512;
const DEFAULT_MAX_CONCURRENT = 32;
const DEFAULT_MAX_CONCURRENT_PER_IP = 4;
const DEFAULT_MAX_CONCURRENT_PER_PLUGIN = 16;
const DEFAULT_MAX_INFLIGHT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_INFLIGHT_BYTES_PER_IP = PLUGIN_WEBHOOK_HARD_MAX_BODY_BYTES;
const DEFAULT_MAX_INFLIGHT_BYTES_PER_PLUGIN = 8 * 1024 * 1024;
const CLOSE_SOCKET_GRACE_MS = 1_000;

export type WebhookRateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

export interface PluginWebhookRateLimiterOptions {
  now?: () => number;
  windowMs?: number;
  maxPerIpPerWindow?: number;
  maxPerPluginPerWindow?: number;
  maxGlobalPerWindow?: number;
  maxTrackedIps?: number;
  maxTrackedPlugins?: number;
}

/**
 * Bounded sliding-window admission gate for unauthenticated plugin webhook
 * requests. Edge admission (`admitEdge`) runs before registry lookup and never
 * allocates an IP entry when the global ceiling is already saturated; per-plugin
 * admission (`admitPlugin`) runs only for verified installed plugin IDs so
 * fabricated IDs cannot evict real plugins from the map.
 */
export class PluginWebhookRateLimiter {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxPerIp: number;
  private readonly maxPerPlugin: number;
  private readonly maxGlobal: number;
  private readonly maxTrackedIps: number;
  private readonly maxTrackedPlugins: number;
  private readonly ipWindows = new Map<string, number[]>();
  private readonly pluginWindows = new Map<string, number[]>();
  private globalWindow: number[] = [];

  constructor(options: PluginWebhookRateLimiterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.windowMs = options.windowMs ?? DEFAULT_RATE_WINDOW_MS;
    this.maxPerIp = options.maxPerIpPerWindow ?? DEFAULT_MAX_PER_IP_PER_WINDOW;
    this.maxPerPlugin = options.maxPerPluginPerWindow ?? DEFAULT_MAX_PER_PLUGIN_PER_WINDOW;
    this.maxGlobal = options.maxGlobalPerWindow ?? DEFAULT_MAX_GLOBAL_PER_WINDOW;
    this.maxTrackedIps = options.maxTrackedIps ?? DEFAULT_MAX_TRACKED_IPS;
    this.maxTrackedPlugins = options.maxTrackedPlugins ?? DEFAULT_MAX_TRACKED_PLUGINS;
  }

  private prune(stamps: number[], cutoff: number): number[] {
    let idx = 0;
    while (idx < stamps.length && stamps[idx] <= cutoff) idx++;
    return idx > 0 ? stamps.slice(idx) : stamps;
  }

  private retryAfterSeconds(oldestStamp: number, nowMs: number): number {
    return Math.max(1, Math.ceil((oldestStamp + this.windowMs - nowMs) / 1000));
  }

  admitEdge(clientIp: string): WebhookRateLimitResult {
    const nowMs = this.now();
    const cutoff = nowMs - this.windowMs;
    this.globalWindow = this.prune(this.globalWindow, cutoff);
    if (this.globalWindow.length >= this.maxGlobal) {
      return { ok: false, retryAfterSeconds: this.retryAfterSeconds(this.globalWindow[0], nowMs) };
    }
    const existing = this.ipWindows.get(clientIp);
    const active = existing ? this.prune(existing, cutoff) : [];
    if (active.length >= this.maxPerIp) {
      this.ipWindows.delete(clientIp);
      this.ipWindows.set(clientIp, active);
      return { ok: false, retryAfterSeconds: this.retryAfterSeconds(active[0], nowMs) };
    }
    active.push(nowMs);
    this.ipWindows.delete(clientIp);
    this.ipWindows.set(clientIp, active);
    while (this.ipWindows.size > this.maxTrackedIps) {
      const oldestKey = this.ipWindows.keys().next().value;
      if (oldestKey === undefined) break;
      this.ipWindows.delete(oldestKey);
    }
    this.globalWindow.push(nowMs);
    return { ok: true };
  }

  admitPlugin(pluginId: string): WebhookRateLimitResult {
    const nowMs = this.now();
    const cutoff = nowMs - this.windowMs;
    const existing = this.pluginWindows.get(pluginId);
    const active = existing ? this.prune(existing, cutoff) : [];
    if (active.length >= this.maxPerPlugin) {
      this.pluginWindows.delete(pluginId);
      this.pluginWindows.set(pluginId, active);
      return { ok: false, retryAfterSeconds: this.retryAfterSeconds(active[0], nowMs) };
    }
    active.push(nowMs);
    this.pluginWindows.delete(pluginId);
    this.pluginWindows.set(pluginId, active);
    while (this.pluginWindows.size > this.maxTrackedPlugins) {
      const oldestKey = this.pluginWindows.keys().next().value;
      if (oldestKey === undefined) break;
      this.pluginWindows.delete(oldestKey);
    }
    return { ok: true };
  }
}

class WebhookBodyTooLargeError extends Error {
  constructor(readonly maxBodyBytes: number) {
    super('body_too_large');
  }
}

class WebhookBodyReadTimeoutError extends Error {
  constructor() {
    super('body_read_timeout');
  }
}

class WebhookTruncatedBodyError extends Error {
  constructor() {
    super('truncated_body');
  }
}

class WebhookClientAbortedError extends Error {
  constructor() {
    super('client_aborted');
  }
}

class WebhookOverloadedError extends Error {
  constructor() {
    super('webhook_overloaded');
  }
}

function sendWebhookJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  options: { closeConnection?: boolean; extraHeaders?: Record<string, string> } = {},
): true {
  if (res.headersSent || res.writableEnded) return true;
  const close = options.closeConnection === true || !req.complete;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
    ...(close ? { connection: 'close' } : {}),
    ...(options.extraHeaders ?? {}),
  };
  if (close) {
    req.pause();
    res.once('finish', () => {
      const timer = setTimeout(() => {
        try { req.socket?.destroy(); } catch { /* ignore */ }
      }, CLOSE_SOCKET_GRACE_MS);
      timer.unref?.();
    });
  }
  res.writeHead(status, headers);
  res.end(payload);
  return true;
}

/**
 * Early pre-normalization guard mounted at the top of `dashboard.ts` BEFORE
 * `new URL(req.url, ...)` collapses `..`, `.`, or `\`. Rejects malformed or
 * traversal-bearing requests targeting `/webhook/plugin*` or
 * `/api/plugins/:id/service*` with `400` + `Connection: close` before any other
 * route or auth bypass can execute on a normalized pathname.
 */
export function earlyGuardPluginProxyRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const kind = detectPluginProxyRawTargetKind(req.url);
  if (!kind) return false;
  if (kind === 'webhook') {
    // A persisted connector using the reserved id `plugin` owns the 1–2 segment
    // shape; leave it to the legacy connector router (which re-verifies its token).
    if (isLegacyPluginConnectorWebhookTarget(req.url)) return false;
    const parsed = parseRawPluginWebhookRequest(req.url);
    if (!parsed.ok && parsed.status === 400) {
      return sendWebhookJson(req, res, 400, { ok: false, error: parsed.error }, { closeConnection: true });
    }
    return false;
  }
  const parsed = parseRawPluginServiceProxyRequest(req.url);
  if (!parsed.ok && parsed.status === 400) {
    return sendWebhookJson(req, res, 400, { ok: false, error: parsed.error }, { closeConnection: true });
  }
  return false;
}

function readRawWebhookBody(
  req: IncomingMessage,
  options: {
    maxBodyBytes: number;
    declaredContentLength?: number;
    totalTimeoutMs: number;
    idleTimeoutMs: number;
    reserveBytes: (delta: number) => boolean;
  },
): Promise<Buffer> {
  if (options.declaredContentLength !== undefined) {
    if (options.declaredContentLength > options.maxBodyBytes) {
      return Promise.reject(new WebhookBodyTooLargeError(options.maxBodyBytes));
    }
    if (options.declaredContentLength === 0 && req.complete) {
      return Promise.resolve(Buffer.alloc(0));
    }
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      idleTimer = undefined;
      totalTimer = undefined;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };

    const fail = (err: Error, pauseStream = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (pauseStream) req.pause();
      reject(err);
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail(new WebhookBodyReadTimeoutError(), true);
      }, options.idleTimeoutMs);
      idleTimer.unref?.();
    };

    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (total + buf.length > options.maxBodyBytes) {
        fail(new WebhookBodyTooLargeError(options.maxBodyBytes), true);
        return;
      }
      if (!options.reserveBytes(buf.length)) {
        fail(new WebhookOverloadedError(), true);
        return;
      }
      total += buf.length;
      chunks.push(buf);
      resetIdleTimer();
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!req.complete) {
        reject(new WebhookClientAbortedError());
        return;
      }
      if (options.declaredContentLength !== undefined && total !== options.declaredContentLength) {
        reject(new WebhookTruncatedBodyError());
        return;
      }
      resolve(chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total));
    };

    const onAborted = () => fail(new WebhookClientAbortedError());
    const onError = () => fail(new WebhookClientAbortedError());
    const onClose = () => {
      if (!settled && !req.complete) fail(new WebhookClientAbortedError());
    };

    totalTimer = setTimeout(() => {
      fail(new WebhookBodyReadTimeoutError(), true);
    }, options.totalTimeoutMs);
    totalTimer.unref?.();
    resetIdleTimer();

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
    req.resume();
  });
}

function buildWebhookUpstreamHeaders(
  req: IncomingMessage,
  opts: {
    port: number;
    token: string;
    pluginId: string;
    matchedRoutePath: string;
    originalSubpath: string;
    bodyByteLength: number;
  },
): { ok: true; headers: Record<string, string | string[]> } | { ok: false; status: 400; error: string } {
  const grouped = groupRawHeaders(req.rawHeaders, req.headers);
  const connectionNominated = collectConnectionNominatedHeaders(grouped);

  const authValues = connectionNominated.has('authorization') ? undefined : grouped.get('authorization');
  if (authValues && authValues.length > 1) {
    return { ok: false, status: 400, error: 'duplicate_authorization_header' };
  }
  const forwardedAuthorization = authValues?.[0];

  const out: Record<string, string | string[]> = {};
  for (const [name, values] of grouped.entries()) {
    if (
      HOP_BY_HOP_HEADERS.has(name)
      || connectionNominated.has(name)
      || name === 'host'
      || name === 'cookie'
      || name === 'authorization'
      || name === 'proxy-authorization'
      || name === 'content-length'
      || name.startsWith('x-botmux-')
    ) {
      continue;
    }
    out[name] = values.length === 1 ? values[0] : values;
  }

  // Inject host-controlled headers last so no external header or Connection
  // nomination can strip or spoof them.
  out.host = `127.0.0.1:${opts.port}`;
  out.authorization = `Bearer ${opts.token}`;
  out['content-length'] = String(opts.bodyByteLength);
  out['x-botmux-webhook-plugin-id'] = opts.pluginId;
  out['x-botmux-webhook-route'] = opts.matchedRoutePath;
  out['x-botmux-webhook-original-path'] = opts.originalSubpath;
  if (forwardedAuthorization !== undefined) {
    out['x-botmux-webhook-forwarded-authorization'] = forwardedAuthorization;
  }

  return { ok: true, headers: out };
}

function sanitizeWebhookResponseHeaders(
  up: IncomingMessage,
  statusCode: number,
): Record<string, string | string[]> {
  const grouped = groupRawHeaders(up.rawHeaders, up.headers);
  const connectionNominated = collectConnectionNominatedHeaders(grouped);
  const out: Record<string, string | string[]> = {};

  for (const [name, values] of grouped.entries()) {
    if (
      HOP_BY_HOP_HEADERS.has(name)
      || connectionNominated.has(name)
      || name === 'set-cookie'
      || name === 'clear-site-data'
      || name === 'content-security-policy'
      || name === 'content-security-policy-report-only'
      || name.startsWith('access-control-')
      || name.startsWith('x-botmux-')
      || ((statusCode === 204 || statusCode === 205) && name === 'content-length')
    ) {
      continue;
    }
    out[name] = values.length === 1 ? values[0] : values;
  }

  if (statusCode === 205) {
    // RFC 9110 §15.3.6: 205 Reset Content must explicitly indicate zero length.
    out['content-length'] = '0';
  }
  out['x-content-type-options'] = 'nosniff';
  out['content-security-policy'] = "default-src 'none'; sandbox";
  out['cross-origin-resource-policy'] = 'same-origin';
  out['referrer-policy'] = 'no-referrer';
  out['cache-control'] = 'no-store';
  return out;
}

export interface PluginWebhookRouteDeps {
  getInstalledPlugin?: (pluginId: string) => InstalledPluginRecord | undefined;
  /** Required: production wiring injects the forbidden-port-aware resolver. */
  resolveTarget: (pluginId: string) => PluginLoopbackTargetResult;
  trustedProxyHops?: number;
  rateLimiter?: PluginWebhookRateLimiter;
  timeoutMs?: number;
  bodyReadTimeoutMs?: number;
  bodyIdleTimeoutMs?: number;
  maxResponseBytes?: number;
  maxConcurrent?: number;
  maxConcurrentPerIp?: number;
  maxConcurrentPerPlugin?: number;
  maxInflightBytes?: number;
  maxInflightBytesPerIp?: number;
  maxInflightBytesPerPlugin?: number;
  requestLoopback?: typeof requestLiteralLoopback;
}

export interface PluginWebhookRouteHandler {
  handle: (req: IncomingMessage, res: ServerResponse, url?: URL) => Promise<boolean>;
}

/**
 * Create the pre-auth `POST /webhook/plugin/:pluginId/*` route handler.
 * Mount BEFORE `handleWebhookRoute` (connector webhooks) and BEFORE the
 * Dashboard auth gate in `src/dashboard.ts`.
 */
export function createPluginWebhookRouteHandler(
  deps: PluginWebhookRouteDeps,
): PluginWebhookRouteHandler {
  const getInstalledPlugin = deps.getInstalledPlugin ?? ((id: string) => {
    const { plugins } = readPluginRegistry();
    return Object.hasOwn(plugins, id) ? plugins[id] : undefined;
  });
  const resolveTarget = deps.resolveTarget;
  const trustedProxyHops = deps.trustedProxyHops ?? 0;
  const rateLimiter = deps.rateLimiter ?? new PluginWebhookRateLimiter();
  const timeoutMs = deps.timeoutMs ?? PLUGIN_WEBHOOK_TIMEOUT_MS;
  const bodyReadTimeoutMs = deps.bodyReadTimeoutMs ?? PLUGIN_WEBHOOK_BODY_READ_TIMEOUT_MS;
  const bodyIdleTimeoutMs = deps.bodyIdleTimeoutMs ?? PLUGIN_WEBHOOK_BODY_IDLE_TIMEOUT_MS;
  const maxResponseBytes = deps.maxResponseBytes ?? PLUGIN_WEBHOOK_RESPONSE_MAX_BYTES;
  const maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const maxConcurrentPerIp = deps.maxConcurrentPerIp ?? Math.min(DEFAULT_MAX_CONCURRENT_PER_IP, maxConcurrent);
  const maxConcurrentPerPlugin = deps.maxConcurrentPerPlugin ?? Math.min(DEFAULT_MAX_CONCURRENT_PER_PLUGIN, maxConcurrent);
  const maxInflightBytes = deps.maxInflightBytes ?? DEFAULT_MAX_INFLIGHT_BYTES;
  const maxInflightBytesPerIp = deps.maxInflightBytesPerIp ?? Math.min(DEFAULT_MAX_INFLIGHT_BYTES_PER_IP, maxInflightBytes);
  const maxInflightBytesPerPlugin = deps.maxInflightBytesPerPlugin ?? Math.min(DEFAULT_MAX_INFLIGHT_BYTES_PER_PLUGIN, maxInflightBytes);
  const requestLoopback = deps.requestLoopback ?? requestLiteralLoopback;

  let inflightCount = 0;
  let inflightBytes = 0;
  const ipInflightCount = new Map<string, number>();
  const pluginInflightCount = new Map<string, number>();
  const ipInflightBytes = new Map<string, number>();
  const pluginInflightBytes = new Map<string, number>();

  async function forwardWebhook(
    req: IncomingMessage,
    res: ServerResponse,
    opts: {
      port: number;
      upstreamPathWithSearch: string;
      headers: Record<string, string | string[]>;
      rawBody: Buffer;
      onBodyFlushed?: () => void;
    },
  ): Promise<void> {
    await new Promise<void>((resolvePromise) => {
      let settled = false;
      let timedOut = false;
      let upstreamResponse: IncomingMessage | undefined;
      let bodyToSend: Buffer | undefined = opts.rawBody;

      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        res.off('close', onClientClose);
        res.off('error', onResError);
        req.off('aborted', onClientAbort);
        resolvePromise();
      };

      const fail = (status: number, errorCode: string) => {
        if (settled) return;
        if (!res.headersSent && !res.writableEnded) {
          sendWebhookJson(req, res, status, { ok: false, error: errorCode });
        } else if (!res.writableEnded) {
          res.destroy();
        }
        done();
      };

      const upstream = requestLoopback(
        { host: '127.0.0.1', port: opts.port },
        {
          method: 'POST',
          path: opts.upstreamPathWithSearch,
          headers: opts.headers,
          agent: false,
        },
        (up) => {
          upstreamResponse = up;
          const status = up.statusCode ?? 502;
          if (status < 200 || status > 599) {
            up.destroy();
            upstream.destroy();
            fail(502, 'plugin_service_invalid_response');
            return;
          }

          const upFraming = validateRawHttpFraming(up.rawHeaders, up.headers);
          if (!upFraming.ok) {
            up.destroy();
            upstream.destroy();
            fail(502, 'plugin_service_invalid_response');
            return;
          }
          if (upFraming.contentLength !== undefined && upFraming.contentLength > maxResponseBytes) {
            up.destroy();
            upstream.destroy();
            fail(502, 'plugin_service_response_too_large');
            return;
          }

          const outHeaders = sanitizeWebhookResponseHeaders(up, status);
          res.writeHead(status, outHeaders);

          if (status === 204 || status === 205 || status === 304) {
            up.on('error', () => {});
            up.resume();
            res.end();
            done();
            return;
          }

          let responseBytes = 0;
          const abortDownstream = () => {
            upstream.destroy();
            up.destroy();
            if (!res.writableEnded) res.destroy();
            done();
          };

          up.on('data', (chunk: Buffer | string) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            responseBytes += buf.length;
            if (responseBytes > maxResponseBytes) {
              abortDownstream();
              return;
            }
            if (!res.writableEnded && !res.destroyed) {
              const ok = res.write(buf);
              if (!ok) {
                up.pause();
                res.once('drain', () => { if (!up.destroyed) up.resume(); });
              }
            }
          });
          up.on('end', () => {
            if (!up.complete) {
              abortDownstream();
              return;
            }
            if (!res.writableEnded && !res.destroyed) res.end();
          });
          up.on('error', abortDownstream);
          up.on('aborted', abortDownstream);
          up.on('close', () => {
            if (!up.complete && !res.writableEnded) {
              abortDownstream();
            }
          });
          res.once('finish', done);
        },
      );

      const totalTimer = setTimeout(() => {
        timedOut = true;
        upstreamResponse?.destroy();
        upstream.destroy();
        fail(504, 'plugin_service_timeout');
      }, timeoutMs);
      totalTimer.unref?.();

      const onClientClose = () => {
        if (!res.writableEnded) {
          upstreamResponse?.destroy();
          upstream.destroy();
        }
        done();
      };
      const onResError = () => {
        upstreamResponse?.destroy();
        upstream.destroy();
        done();
      };
      const onClientAbort = () => {
        upstreamResponse?.destroy();
        upstream.destroy();
        done();
      };

      res.on('close', onClientClose);
      res.on('error', onResError);
      req.on('aborted', onClientAbort);

      upstream.on('upgrade', (_upRes, upSock) => {
        upSock.destroy();
        upstream.destroy();
        fail(502, 'plugin_service_upgrade_unsupported');
      });

      upstream.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        if (timedOut) {
          fail(504, 'plugin_service_timeout');
          return;
        }
        const status = err?.code === 'ECONNREFUSED' || err?.code === 'EHOSTUNREACH' || err?.code === 'ENETUNREACH'
          ? 503
          : 502;
        const code = status === 503 ? 'plugin_service_unreachable' : 'plugin_service_bad_gateway';
        fail(status, code);
      });

      const body = bodyToSend;
      bodyToSend = undefined;
      upstream.end(body, () => {
        opts.onBodyFlushed?.();
      });
    });
  }

  const handle = async (req: IncomingMessage, res: ServerResponse, url?: URL): Promise<boolean> => {
    const rawKind = detectPluginProxyRawTargetKind(req.url);
    const normalizedMatch = url
      ? (url.pathname === '/webhook/plugin' || url.pathname.startsWith('/webhook/plugin/'))
      : false;
    if (rawKind !== 'webhook' && !normalizedMatch) return false;

    try {
      // Legacy connector with reserved id `plugin` (1–2 segments, incl. GET
      // async polling and percent-encoded connector ids): fall through before
      // any plugin-shape rejection so the existing connector URL keeps
      // delivering after upgrade. The legacy router re-verifies its token.
      if (isLegacyPluginConnectorWebhookTarget(req.url)) {
        return false;
      }
      const parsed = parseRawPluginWebhookRequest(req.url);
      if (!parsed.ok && parsed.status === 400) {
        return sendWebhookJson(req, res, 400, { ok: false, error: parsed.error }, { closeConnection: true });
      }

      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'POST') {
        return sendWebhookJson(
          req,
          res,
          405,
          { ok: false, error: 'method_not_allowed' },
          { closeConnection: !req.complete, extraHeaders: { allow: 'POST' } },
        );
      }

      const framing = validateRawHttpFraming(req.rawHeaders, req.headers);
      if (!framing.ok) {
        return sendWebhookJson(req, res, framing.status, { ok: false, error: framing.error }, { closeConnection: true });
      }

      const clientIp = dashboardH5ClientIp(req, trustedProxyHops);
      const edgeLimit = rateLimiter.admitEdge(clientIp);
      if (!edgeLimit.ok) {
        return sendWebhookJson(
          req,
          res,
          429,
          { ok: false, error: 'rate_limited' },
          {
            closeConnection: true,
            extraHeaders: { 'retry-after': String(edgeLimit.retryAfterSeconds) },
          },
        );
      }

      if (!parsed.ok) {
        return sendWebhookJson(req, res, parsed.status, { ok: false, error: parsed.error }, { closeConnection: true });
      }

      const record = getInstalledPlugin(parsed.pluginId);
      if (!record) {
        return sendWebhookJson(req, res, 404, { ok: false, error: 'plugin_not_found' }, { closeConnection: true });
      }

      let webhooksContribution;
      try {
        if (!record.contributions?.webhooks) {
          return sendWebhookJson(req, res, 404, { ok: false, error: 'webhook_route_not_found' }, { closeConnection: true });
        }
        webhooksContribution = parsePluginWebhooksContribution(record.contributions.webhooks);
      } catch {
        return sendWebhookJson(req, res, 404, { ok: false, error: 'webhook_route_not_found' }, { closeConnection: true });
      }

      const matched = matchPluginWebhookRoute(webhooksContribution, parsed.subpath);
      if (!matched) {
        return sendWebhookJson(req, res, 404, { ok: false, error: 'webhook_route_not_found' }, { closeConnection: true });
      }

      // Defense-in-depth: never allow an external webhook route to target any
      // host-attested internal daemon callback endpoint (`/botmux/*`, cardActions, commands).
      const reservedEndpoints = collectReservedPluginCallbackEndpoints(record.contributions);
      if (reservedEndpoints.some(ep => upstreamPathMatchesReservedEndpoint(matched.upstreamPathname, ep))) {
        return sendWebhookJson(req, res, 404, { ok: false, error: 'webhook_route_not_found' }, { closeConnection: true });
      }

      const pluginLimit = rateLimiter.admitPlugin(parsed.pluginId);
      if (!pluginLimit.ok) {
        return sendWebhookJson(
          req,
          res,
          429,
          { ok: false, error: 'rate_limited' },
          {
            closeConnection: true,
            extraHeaders: { 'retry-after': String(pluginLimit.retryAfterSeconds) },
          },
        );
      }

      const target = resolveTarget(parsed.pluginId);
      if (!target.ok) {
        return sendWebhookJson(req, res, target.status, { ok: false, error: target.error }, { closeConnection: true });
      }

      if (framing.contentLength !== undefined && framing.contentLength > matched.maxBodyBytes) {
        return sendWebhookJson(
          req,
          res,
          413,
          { ok: false, error: 'body_too_large', maxBodyBytes: matched.maxBodyBytes },
          { closeConnection: true },
        );
      }

      const curIpConcurrent = ipInflightCount.get(clientIp) ?? 0;
      const curPluginConcurrent = pluginInflightCount.get(parsed.pluginId) ?? 0;
      if (
        inflightCount >= maxConcurrent
        || curIpConcurrent >= maxConcurrentPerIp
        || curPluginConcurrent >= maxConcurrentPerPlugin
      ) {
        return sendWebhookJson(
          req,
          res,
          429,
          { ok: false, error: 'webhook_concurrency_limited' },
          { closeConnection: true, extraHeaders: { 'retry-after': '1' } },
        );
      }

      inflightCount++;
      ipInflightCount.set(clientIp, curIpConcurrent + 1);
      pluginInflightCount.set(parsed.pluginId, curPluginConcurrent + 1);

      let reservedBytes = 0;
      const reserveBytes = (delta: number): boolean => {
        const curIpBytes = ipInflightBytes.get(clientIp) ?? 0;
        const curPluginBytes = pluginInflightBytes.get(parsed.pluginId) ?? 0;
        if (
          inflightBytes + delta > maxInflightBytes
          || curIpBytes + delta > maxInflightBytesPerIp
          || curPluginBytes + delta > maxInflightBytesPerPlugin
        ) {
          return false;
        }
        inflightBytes += delta;
        ipInflightBytes.set(clientIp, curIpBytes + delta);
        pluginInflightBytes.set(parsed.pluginId, curPluginBytes + delta);
        reservedBytes += delta;
        return true;
      };
      const releaseReservedBytes = (): void => {
        if (reservedBytes <= 0) return;
        const released = reservedBytes;
        reservedBytes = 0;
        inflightBytes = Math.max(0, inflightBytes - released);
        const nextIpBytes = (ipInflightBytes.get(clientIp) ?? 0) - released;
        if (nextIpBytes <= 0) ipInflightBytes.delete(clientIp);
        else ipInflightBytes.set(clientIp, nextIpBytes);
        const nextPluginBytes = (pluginInflightBytes.get(parsed.pluginId) ?? 0) - released;
        if (nextPluginBytes <= 0) pluginInflightBytes.delete(parsed.pluginId);
        else pluginInflightBytes.set(parsed.pluginId, nextPluginBytes);
      };

      try {
        let rawBody: Buffer | undefined;
        try {
          rawBody = await readRawWebhookBody(req, {
            maxBodyBytes: matched.maxBodyBytes,
            declaredContentLength: framing.contentLength,
            totalTimeoutMs: bodyReadTimeoutMs,
            idleTimeoutMs: bodyIdleTimeoutMs,
            reserveBytes,
          });
        } catch (err) {
          if (err instanceof WebhookBodyTooLargeError) {
            return sendWebhookJson(
              req,
              res,
              413,
              { ok: false, error: 'body_too_large', maxBodyBytes: err.maxBodyBytes },
              { closeConnection: true },
            );
          }
          if (err instanceof WebhookBodyReadTimeoutError) {
            return sendWebhookJson(req, res, 408, { ok: false, error: 'request_timeout' }, { closeConnection: true });
          }
          if (err instanceof WebhookOverloadedError) {
            return sendWebhookJson(
              req,
              res,
              429,
              { ok: false, error: 'webhook_buffer_exhausted' },
              { closeConnection: true, extraHeaders: { 'retry-after': '1' } },
            );
          }
          if (err instanceof WebhookTruncatedBodyError) {
            return sendWebhookJson(req, res, 400, { ok: false, error: 'truncated_request_body' }, { closeConnection: true });
          }
          if (err instanceof WebhookClientAbortedError) {
            if (!res.writableEnded) res.destroy();
            return true;
          }
          throw err;
        }

        const headerResult = buildWebhookUpstreamHeaders(req, {
          port: target.port,
          token: target.token,
          pluginId: parsed.pluginId,
          matchedRoutePath: matched.route.path,
          originalSubpath: parsed.subpath,
          bodyByteLength: rawBody.byteLength,
        });
        if (!headerResult.ok) {
          return sendWebhookJson(req, res, headerResult.status, { ok: false, error: headerResult.error }, { closeConnection: true });
        }

        const payloadToForward = rawBody;
        rawBody = undefined;
        await forwardWebhook(req, res, {
          port: target.port,
          upstreamPathWithSearch: `${matched.upstreamPathname}${parsed.rawSearch}`,
          headers: headerResult.headers,
          rawBody: payloadToForward,
          onBodyFlushed: releaseReservedBytes,
        });
        return true;
      } finally {
        releaseReservedBytes();
        inflightCount = Math.max(0, inflightCount - 1);
        const nextIpCount = (ipInflightCount.get(clientIp) ?? 1) - 1;
        if (nextIpCount <= 0) ipInflightCount.delete(clientIp);
        else ipInflightCount.set(clientIp, nextIpCount);
        const nextPluginCount = (pluginInflightCount.get(parsed.pluginId) ?? 1) - 1;
        if (nextPluginCount <= 0) pluginInflightCount.delete(parsed.pluginId);
        else pluginInflightCount.set(parsed.pluginId, nextPluginCount);
      }
    } catch {
      if (!res.headersSent && !res.writableEnded) {
        return sendWebhookJson(req, res, 502, { ok: false, error: 'webhook_forward_failed' }, { closeConnection: true });
      }
      if (!res.writableEnded) res.destroy();
      return true;
    }
  };

  return { handle };
}
