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
  parseRawOriginFormTarget,
  parseRawPluginServiceProxyRequest,
  upstreamPathMatchesReservedEndpoint,
  validateRawHttpFraming,
  validateStrictPluginHttpPath,
} from '../core/plugins/webhooks/protocol.js';
import {
  resolveRunningPluginServiceTarget,
  samePluginLoopbackTarget,
  type PluginLoopbackTargetResult,
} from '../core/plugins/webhooks/service-target.js';
import {
  controlRequestOriginState,
  guardControlRequest,
  refererMatchesHost,
  type ControlCsrfTokens,
} from './control-csrf.js';
import type { DashboardRequestIdentity } from './request-identity.js';

export const PLUGIN_SERVICE_PROXY_HEADER = 'x-botmux-plugin-proxy';

const ALLOWED_PROXY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SAFE_PROXY_METHODS = new Set(['GET', 'HEAD']);
const BLOCKED_FETCH_DESTS = new Set(['document', 'iframe', 'frame', 'object', 'embed']);
const DEFAULT_HEADER_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_TOTAL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const CLOSE_SOCKET_GRACE_MS = 1_000;

function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && value.length > 0) return value[0]?.trim();
  return undefined;
}

function isDocumentNavigation(headers: IncomingMessage['headers']): boolean {
  const mode = singleHeaderValue(headers['sec-fetch-mode'])?.toLowerCase();
  if (mode === 'navigate') return true;
  const dest = singleHeaderValue(headers['sec-fetch-dest'])?.toLowerCase();
  if (dest && BLOCKED_FETCH_DESTS.has(dest)) return true;
  return false;
}

function queryContainsDashboardToken(rawSearch: string, activeToken: string | null | undefined): boolean {
  if (!activeToken || !rawSearch || rawSearch.length <= 1) return false;
  try {
    const params = new URLSearchParams(rawSearch.slice(1));
    for (const value of params.getAll('t')) {
      if (value === activeToken) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Block proxying Dashboard requests to host-attested internal daemon callback
 * endpoints (`/botmux/*`, `cardActions.endpoint`, `commands.endpoint`) so a
 * Dashboard principal cannot confuse the plugin service into accepting forged
 * daemon callback payloads stamped with the loopback bearer token.
 */
function isInternalHostCallbackPath(upstreamPath: string, record: InstalledPluginRecord): boolean {
  const reserved = collectReservedPluginCallbackEndpoints(record.contributions);
  return reserved.some(endpoint => upstreamPathMatchesReservedEndpoint(upstreamPath, endpoint));
}

function sendProxyErrorJson(
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

function buildServiceProxyUpstreamHeaders(
  req: IncomingMessage,
  opts: {
    port: number;
    token: string;
    pluginId: string;
    stripBodyHeaders: boolean;
  },
): Record<string, string | string[]> {
  const grouped = groupRawHeaders(req.rawHeaders, req.headers);
  const connectionNominated = collectConnectionNominatedHeaders(grouped);
  const out: Record<string, string | string[]> = {};

  let wantsEventStream = false;
  const acceptValues = grouped.get('accept');
  if (acceptValues?.some(v => v.toLowerCase().includes('text/event-stream'))) {
    wantsEventStream = true;
  }

  for (const [name, values] of grouped.entries()) {
    if (
      HOP_BY_HOP_HEADERS.has(name)
      || connectionNominated.has(name)
      || name === 'host'
      || name === 'cookie'
      || name === 'authorization'
      || name === 'proxy-authorization'
      || name === 'referer'
      || name === 'origin'
      || name === 'forwarded'
      || name.startsWith('x-forwarded-')
      || name.startsWith('x-botmux-')
      || (opts.stripBodyHeaders && name === 'content-length')
    ) {
      continue;
    }
    out[name] = values.length === 1 ? values[0] : values;
  }

  if (wantsEventStream) {
    out['accept-encoding'] = 'identity';
  }

  out.host = `127.0.0.1:${opts.port}`;
  out.authorization = `Bearer ${opts.token}`;
  out['x-botmux-plugin-id'] = opts.pluginId;
  out['x-botmux-proxy-source'] = 'dashboard';
  return out;
}

/**
 * Rewrite an upstream `Location` header ONLY when it targets a safe path on
 * this same plugin loopback service; otherwise strip it so a plugin can never
 * bounce authenticated browser requests to `/api/host-terminal` or cross-origin
 * hosts carrying `x-botmux-csrf`.
 */
export function rewritePluginServiceLocation(
  rawLocation: string,
  pluginId: string,
  upstreamPort: number,
): string | null {
  const trimmed = rawLocation.trim();
  if (!trimmed) return null;
  const prefix = `/api/plugins/${encodeURIComponent(pluginId)}/service`;

  let candidateTarget: string | null = null;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
    candidateTarget = trimmed;
  } else {
    try {
      const parsed = new URL(trimmed);
      const portNum = parsed.port ? Number(parsed.port) : (parsed.protocol === 'http:' ? 80 : -1);
      if (
        parsed.protocol === 'http:'
        && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
        && portNum === upstreamPort
        && !parsed.username
        && !parsed.password
        && !parsed.hash
      ) {
        candidateTarget = `${parsed.pathname}${parsed.search}`;
      }
    } catch {
      return null;
    }
  }
  if (!candidateTarget) return null;

  const parsedTarget = parseRawOriginFormTarget(candidateTarget);
  if (!parsedTarget) return null;
  try {
    validateStrictPluginHttpPath(parsedTarget.rawPath, {
      allowRoot: true,
      allowTrailingSlash: true,
      maxLength: 2048,
      errorCode: 'invalid_location',
    });
  } catch {
    return null;
  }

  if (parsedTarget.rawPath === prefix || parsedTarget.rawPath.startsWith(`${prefix}/`)) {
    return `${parsedTarget.rawPath}${parsedTarget.rawSearch}`;
  }
  return `${prefix}${parsedTarget.rawPath}${parsedTarget.rawSearch}`;
}

function sanitizeServiceProxyResponseHeaders(
  up: IncomingMessage,
  statusCode: number,
  pluginId: string,
  upstreamPort: number,
): { headers: Record<string, string | string[]>; isEventStream: boolean } {
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
    if (name === 'location') {
      const rewritten = values.length === 1
        ? rewritePluginServiceLocation(values[0], pluginId, upstreamPort)
        : null;
      if (rewritten) out.location = rewritten;
      continue;
    }
    out[name] = values.length === 1 ? values[0] : values;
  }

  const contentType = typeof out['content-type'] === 'string'
    ? out['content-type']
    : Array.isArray(out['content-type'])
      ? out['content-type'][0] ?? ''
      : '';
  const isEventStream = /^text\/event-stream\b/i.test(contentType);

  if (isEventStream) {
    const existingCache = typeof out['cache-control'] === 'string'
      ? out['cache-control']
      : Array.isArray(out['cache-control'])
        ? out['cache-control'].join(', ')
        : '';
    if (!existingCache) {
      out['cache-control'] = 'no-cache, no-store, no-transform';
    } else if (!/\bno-transform\b/i.test(existingCache)) {
      out['cache-control'] = `${existingCache}, no-transform`;
    }
    if (!out['x-accel-buffering']) {
      out['x-accel-buffering'] = 'no';
    }
  } else if (!out['cache-control']) {
    out['cache-control'] = 'no-store';
  }

  if (statusCode === 205) {
    // RFC 9110 §15.3.6: 205 Reset Content must explicitly indicate zero length.
    out['content-length'] = '0';
  }

  out['x-content-type-options'] = 'nosniff';
  out['content-security-policy'] = "default-src 'none'; sandbox";
  out['cross-origin-resource-policy'] = 'same-origin';
  out['referrer-policy'] = 'no-referrer';
  out[PLUGIN_SERVICE_PROXY_HEADER] = '1';
  return { headers: out, isEventStream };
}

export interface PluginServiceProxyContext {
  identity: DashboardRequestIdentity | null;
  activeToken?: string | null;
}

export interface PluginServiceProxyDeps {
  csrfTokens: ControlCsrfTokens;
  getInstalledPlugin?: (pluginId: string) => InstalledPluginRecord | undefined;
  resolveTarget?: (pluginId: string) => PluginLoopbackTargetResult;
  isAuthSessionLive?: (authSessionId: string) => boolean;
  bindStream?: (authSessionId: string, pluginId: string, close: () => void) => (() => void) | false;
  headerTimeoutMs?: number;
  uploadIdleTimeoutMs?: number;
  uploadTotalTimeoutMs?: number;
  maxUploadBytes?: number;
  requestLoopback?: typeof requestLiteralLoopback;
}

export interface PluginServiceProxyHandler {
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: PluginServiceProxyContext,
  ) => Promise<boolean>;
}

/**
 * Create the Dashboard-authenticated & CSRF-guarded plugin service proxy for
 * `/api/plugins/:id/service/*` -> `http://127.0.0.1:<port>/*`.
 *
 * Mount AFTER Dashboard authentication and global write-origin checks, and
 * OUTSIDE the `url.pathname.startsWith('/api/plugins/')` guard so raw path
 * traversals cannot bypass it.
 */
export function createPluginServiceProxyHandler(
  deps: PluginServiceProxyDeps,
): PluginServiceProxyHandler {
  const getInstalledPlugin = deps.getInstalledPlugin ?? ((id: string) => {
    const { plugins } = readPluginRegistry();
    return Object.hasOwn(plugins, id) ? plugins[id] : undefined;
  });
  const resolveTarget = deps.resolveTarget ?? ((id: string) => resolveRunningPluginServiceTarget(id));
  const headerTimeoutMs = deps.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
  const uploadIdleTimeoutMs = deps.uploadIdleTimeoutMs ?? DEFAULT_UPLOAD_IDLE_TIMEOUT_MS;
  const uploadTotalTimeoutMs = deps.uploadTotalTimeoutMs ?? DEFAULT_UPLOAD_TOTAL_TIMEOUT_MS;
  const maxUploadBytes = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const requestLoopback = deps.requestLoopback ?? requestLiteralLoopback;

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    ctx: PluginServiceProxyContext,
  ): Promise<boolean> => {
    const rawKind = detectPluginProxyRawTargetKind(req.url);
    const normalizedMatch = /^\/api\/plugins\/[^/]+\/service(?:\/|$)/i.test(url.pathname);
    if (rawKind !== 'service' && !normalizedMatch) return false;

    try {
      const parsed = parseRawPluginServiceProxyRequest(req.url);
      if (!parsed.ok && parsed.status === 400) {
        return sendProxyErrorJson(req, res, 400, { ok: false, error: parsed.error }, { closeConnection: true });
      }

      // Defense-in-depth admin auth check (never emits x-botmux-plugin-proxy).
      const identity = ctx.identity;
      if (!identity || !identity.canManageHost) {
        return sendProxyErrorJson(req, res, 401, { ok: false, error: 'unauthorized' }, { closeConnection: !req.complete });
      }

      // Block top-level document / iframe / embed navigations to eliminate
      // same-origin XSS / co-manager -> legacy-owner privilege escalation.
      if (isDocumentNavigation(req.headers)) {
        return sendProxyErrorJson(
          req,
          res,
          403,
          { ok: false, error: 'plugin_service_navigation_forbidden' },
          { closeConnection: !req.complete },
        );
      }

      const method = (req.method ?? 'GET').toUpperCase();
      if (!ALLOWED_PROXY_METHODS.has(method)) {
        return sendProxyErrorJson(
          req,
          res,
          405,
          { ok: false, error: 'method_not_allowed' },
          {
            closeConnection: !req.complete,
            extraHeaders: { allow: 'GET, HEAD, POST, PUT, PATCH, DELETE' },
          },
        );
      }

      const framing = validateRawHttpFraming(req.rawHeaders, req.headers);
      if (!framing.ok) {
        return sendProxyErrorJson(req, res, framing.status, { ok: false, error: framing.error }, { closeConnection: true });
      }
      const isSafeRead = SAFE_PROXY_METHODS.has(method);
      if (isSafeRead && (framing.chunked || (framing.contentLength ?? 0) > 0)) {
        return sendProxyErrorJson(req, res, 400, { ok: false, error: 'body_not_allowed' }, { closeConnection: true });
      }
      if (!isSafeRead && framing.contentLength !== undefined && framing.contentLength > maxUploadBytes) {
        return sendProxyErrorJson(
          req,
          res,
          413,
          { ok: false, error: 'body_too_large', maxBodyBytes: maxUploadBytes },
          { closeConnection: true },
        );
      }

      if (isSafeRead) {
        const originState = controlRequestOriginState(req.headers);
        if (originState === 'foreign') {
          return sendProxyErrorJson(
            req,
            res,
            403,
            { ok: false, error: 'control_origin_forbidden' },
            { closeConnection: !req.complete },
          );
        }
        if (originState === 'unknown' && req.headers.referer && !refererMatchesHost(req.headers)) {
          return sendProxyErrorJson(
            req,
            res,
            403,
            { ok: false, error: 'control_origin_forbidden' },
            { closeConnection: !req.complete },
          );
        }
      } else {
        const guard = guardControlRequest({
          headers: req.headers,
          authSessionId: identity.authSessionId,
          tokens: deps.csrfTokens,
        });
        if (!guard.ok) {
          return sendProxyErrorJson(
            req,
            res,
            guard.status,
            { ok: false, error: guard.error },
            { closeConnection: true },
          );
        }
      }

      if (!parsed.ok) {
        return sendProxyErrorJson(req, res, parsed.status, { ok: false, error: parsed.error }, { closeConnection: !req.complete });
      }

      if (queryContainsDashboardToken(parsed.rawSearch, ctx.activeToken)) {
        return sendProxyErrorJson(
          req,
          res,
          400,
          { ok: false, error: 'dashboard_token_param_forbidden' },
          { closeConnection: true },
        );
      }

      const record = getInstalledPlugin(parsed.pluginId);
      if (!record) {
        return sendProxyErrorJson(req, res, 404, { ok: false, error: 'plugin_not_found' }, { closeConnection: !req.complete });
      }
      if (!record.manifest.service && !record.contributions?.service) {
        return sendProxyErrorJson(
          req,
          res,
          404,
          { ok: false, error: 'plugin_service_not_configured' },
          { closeConnection: !req.complete },
        );
      }

      if (isInternalHostCallbackPath(parsed.upstreamPath, record)) {
        return sendProxyErrorJson(
          req,
          res,
          403,
          { ok: false, error: 'plugin_internal_endpoint_forbidden' },
          { closeConnection: !req.complete },
        );
      }

      const target = resolveTarget(parsed.pluginId);
      if (!target.ok) {
        return sendProxyErrorJson(
          req,
          res,
          target.status,
          { ok: false, error: target.error },
          { closeConnection: !req.complete },
        );
      }

      const outHeaders = buildServiceProxyUpstreamHeaders(req, {
        port: target.port,
        token: target.token,
        pluginId: parsed.pluginId,
        stripBodyHeaders: isSafeRead,
      });

      await new Promise<void>((resolvePromise) => {
        let settled = false;
        let timedOut = false;
        let headersReceived = false;
        let closeClientConnection = false;
        let uploadedBytes = 0;
        let unbindStream: (() => void) | undefined;
        let upstream: ReturnType<typeof requestLoopback> | undefined;
        let upstreamResponse: IncomingMessage | undefined;
        let headerTimer: NodeJS.Timeout | undefined;
        let uploadTotalTimer: NodeJS.Timeout | undefined;

        const clearTimers = () => {
          if (headerTimer) clearTimeout(headerTimer);
          if (uploadTotalTimer) clearTimeout(uploadTotalTimer);
          headerTimer = undefined;
          uploadTotalTimer = undefined;
        };

        const stopRequestUpload = () => {
          if (upstream && !isSafeRead) {
            try { req.unpipe(upstream); } catch { /* ignore */ }
          }
          if (!isSafeRead && !req.complete) {
            try { req.pause(); } catch { /* ignore */ }
          }
        };

        const scheduleClientSocketGraceClose = () => {
          stopRequestUpload();
          const clientSocket = req.socket;
          const timer = setTimeout(() => {
            try { clientSocket?.destroy(); } catch { /* ignore */ }
          }, CLOSE_SOCKET_GRACE_MS);
          timer.unref?.();
        };

        const done = () => {
          if (settled) return;
          settled = true;
          clearTimers();
          unbindStream?.();
          unbindStream = undefined;
          res.off('close', onResClose);
          res.off('error', onResError);
          req.off('aborted', onReqAborted);
          req.off('error', onReqError);
          req.off('data', onReqData);
          if (upstream) {
            if (!isSafeRead) {
              try { req.unpipe(upstream); } catch { /* ignore */ }
            }
            if ((!upstream.writableEnded || (!isSafeRead && !req.complete)) && !upstream.destroyed) {
              upstream.destroy();
            }
          }
          resolvePromise();
        };

        const fail = (status: number, errorCode: string, closeConn = !req.complete) => {
          if (settled) return;
          stopRequestUpload();
          if (!res.headersSent && !res.writableEnded) {
            sendProxyErrorJson(req, res, status, { ok: false, error: errorCode }, { closeConnection: closeConn });
          } else if (!res.writableEnded) {
            res.destroy();
          }
          done();
        };

        const abortStream = () => {
          if (settled) return;
          stopRequestUpload();
          upstreamResponse?.destroy();
          upstream?.destroy();
          if (!res.headersSent && !res.writableEnded) {
            sendProxyErrorJson(req, res, 403, { ok: false, error: 'authentication_revoked' }, { closeConnection: true });
          } else if (!res.writableEnded) {
            res.destroy();
          }
          done();
        };

        const onReqData = (chunk: Buffer | string) => {
          if (settled || isSafeRead) return;
          const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
          uploadedBytes += len;
          if (uploadedBytes > maxUploadBytes) {
            stopRequestUpload();
            upstream?.destroy();
            fail(413, 'body_too_large', true);
          }
        };

        const onResClose = () => {
          if (!res.writableEnded) {
            stopRequestUpload();
            upstreamResponse?.destroy();
            upstream?.destroy();
          }
          done();
        };
        const onResError = () => {
          stopRequestUpload();
          upstreamResponse?.destroy();
          upstream?.destroy();
          done();
        };
        const onReqAborted = () => {
          stopRequestUpload();
          upstreamResponse?.destroy();
          upstream?.destroy();
          done();
        };
        const onReqError = () => {
          stopRequestUpload();
          upstreamResponse?.destroy();
          upstream?.destroy();
          done();
        };

        // Bind BEFORE dialing upstream so auth-session revocation (token rotation,
        // platform unbind) and plugin service stop/restart tear down in-flight
        // uploads and slow pre-header dials immediately.
        if (deps.bindStream) {
          const bound = deps.bindStream(identity.authSessionId, parsed.pluginId, abortStream);
          if (bound === false) {
            fail(403, 'authentication_revoked', true);
            return;
          }
          unbindStream = bound;
        }

        const reqRef = requestLoopback(
          { host: '127.0.0.1', port: target.port },
          {
            method,
            path: `${parsed.upstreamPath}${parsed.rawSearch}`,
            headers: outHeaders,
            agent: false,
          },
          (up) => {
            if (settled) {
              up.destroy();
              reqRef.destroy();
              return;
            }
            headersReceived = true;
            upstreamResponse = up;
            clearTimers();
            reqRef.setTimeout(0);

            const status = up.statusCode ?? 502;
            if (status < 200 || status > 599) {
              up.destroy();
              reqRef.destroy();
              fail(502, 'plugin_service_invalid_response');
              return;
            }

            const upFraming = validateRawHttpFraming(up.rawHeaders, up.headers);
            if (!upFraming.ok) {
              up.destroy();
              reqRef.destroy();
              fail(502, 'plugin_service_invalid_response');
              return;
            }

            // Re-verify session liveness and target process identity before
            // exposing a single response byte to the browser.
            if (deps.isAuthSessionLive && !deps.isAuthSessionLive(identity.authSessionId)) {
              up.destroy();
              reqRef.destroy();
              fail(403, 'authentication_revoked', true);
              return;
            }
            const currentTarget = resolveTarget(parsed.pluginId);
            if (!currentTarget.ok || !samePluginLoopbackTarget(currentTarget, target)) {
              up.destroy();
              reqRef.destroy();
              fail(503, currentTarget.ok ? 'plugin_service_unavailable' : currentTarget.error, true);
              return;
            }

            const { headers: resHeaders, isEventStream } = sanitizeServiceProxyResponseHeaders(
              up,
              status,
              parsed.pluginId,
              target.port,
            );

            if (!isSafeRead && !req.complete) {
              closeClientConnection = true;
              resHeaders.connection = 'close';
              // For early 3xx/4xx/5xx responses, upstream is rejecting/redirecting
              // without consuming the remaining upload; detach req immediately so
              // continuing writes don't trigger TCP RST/EPIPE and abort `up`.
              if (status >= 300) {
                stopRequestUpload();
              }
            }

            if (isEventStream) {
              try { res.socket?.setNoDelay(true); } catch { /* ignore */ }
              try { reqRef.socket?.setNoDelay(true); } catch { /* ignore */ }
            }

            res.writeHead(status, resHeaders);
            res.flushHeaders();

            if (method === 'HEAD' || status === 204 || status === 205 || status === 304) {
              up.on('error', () => {});
              up.resume();
              if (closeClientConnection) {
                stopRequestUpload();
                res.once('finish', scheduleClientSocketGraceClose);
              }
              res.end();
              if (!isSafeRead && !req.complete && !reqRef.destroyed) reqRef.destroy();
              done();
              return;
            }

            const abortDownstream = () => {
              stopRequestUpload();
              reqRef.destroy();
              up.destroy();
              if (!res.writableEnded) res.destroy();
              done();
            };

            up.once('end', () => {
              if (!isSafeRead && !req.complete) stopRequestUpload();
            });
            up.on('error', abortDownstream);
            up.on('aborted', abortDownstream);
            up.on('close', () => {
              if (!up.complete && !res.writableEnded) {
                abortDownstream();
              }
            });
            res.once('finish', () => {
              if (closeClientConnection || (!isSafeRead && !req.complete)) {
                scheduleClientSocketGraceClose();
              }
              if (!isSafeRead && !req.complete && !reqRef.destroyed) {
                reqRef.destroy();
              }
              done();
            });
            up.pipe(res);
          },
        );
        upstream = reqRef;

        const armHeaderTimeout = () => {
          if (headersReceived || settled || headerTimer) return;
          if (uploadTotalTimer) {
            clearTimeout(uploadTotalTimer);
            uploadTotalTimer = undefined;
          }
          // Disarm the upload idle socket timeout so `headerTimeoutMs` owns
          // the post-upload wait exclusively.
          reqRef.setTimeout(0);
          headerTimer = setTimeout(() => {
            if (headersReceived || settled) return;
            timedOut = true;
            reqRef.destroy();
            fail(504, 'plugin_service_timeout');
          }, headerTimeoutMs);
          headerTimer.unref?.();
        };

        reqRef.setTimeout(uploadIdleTimeoutMs, () => {
          if (headersReceived || settled || headerTimer) return;
          timedOut = true;
          reqRef.destroy();
          fail(504, 'plugin_service_timeout', true);
        });
        reqRef.once('finish', armHeaderTimeout);

        if (!isSafeRead) {
          uploadTotalTimer = setTimeout(() => {
            if (headersReceived || settled) return;
            timedOut = true;
            stopRequestUpload();
            reqRef.destroy();
            fail(504, 'plugin_service_timeout', true);
          }, uploadTotalTimeoutMs);
          uploadTotalTimer.unref?.();
          req.on('data', onReqData);
        }

        res.on('close', onResClose);
        res.on('error', onResError);
        req.on('aborted', onReqAborted);
        req.on('error', onReqError);

        reqRef.on('upgrade', (_upRes, upSock) => {
          upSock.destroy();
          reqRef.destroy();
          fail(502, 'plugin_service_upgrade_unsupported');
        });

        reqRef.on('error', (err: NodeJS.ErrnoException) => {
          if (settled) return;
          if (timedOut) {
            fail(504, 'plugin_service_timeout');
            return;
          }
          // When upstream already sent response headers and `up` is still
          // actively draining or completed cleanly, a late upload-side EPIPE
          // must not destroy the downstream response.
          if (headersReceived && upstreamResponse && (!upstreamResponse.destroyed || upstreamResponse.complete)) {
            stopRequestUpload();
            return;
          }
          const status = err?.code === 'ECONNREFUSED' || err?.code === 'EHOSTUNREACH' || err?.code === 'ENETUNREACH'
            ? 503
            : 502;
          const code = status === 503 ? 'plugin_service_unreachable' : 'plugin_service_bad_gateway';
          fail(status, code);
        });

        if (isSafeRead) {
          reqRef.end();
        } else {
          req.pipe(reqRef);
        }
      });

      return true;
    } catch {
      if (!res.headersSent && !res.writableEnded) {
        return sendProxyErrorJson(req, res, 502, { ok: false, error: 'plugin_service_proxy_failed' }, { closeConnection: true });
      }
      if (!res.writableEnded) res.destroy();
      return true;
    }
  };

  return { handle };
}
