import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import {
  PREVIEW_CONTENT_SEGMENT,
  PREVIEW_ROUTE_PREFIX,
  isPreviewLoopbackHost,
  isPreviewPort,
  safeSessionPreviewTarget,
  sessionPreviewContentPath,
  sessionPreviewPath,
  type SessionPreviewTarget,
} from '../core/session-preview.js';
import { requestLiteralLoopback } from '../core/loopback-target.js';
import { PREVIEW_CONTENT_CAPABILITY_PATTERN } from './preview-content-capability.js';
import type { SessionPreviewResolution } from './preview-contract.js';

/** Dev servers commonly cold-compile their first response for 3–30 seconds.
 * This bounds only the pre-header phase and is cleared once headers arrive. */
export const PREVIEW_UPSTREAM_RESPONSE_TIMEOUT_MS = 45_000;
const MAX_WEBSOCKET_REJECTION_BYTES = 64 * 1024;

/**
 * Sandbox flags forced onto every proxied preview document.
 *
 * `allow-same-origin` is deliberately absent: without it the document is an
 * opaque origin, which is the whole point. It cannot read the dashboard DOM,
 * cannot attach dashboard cookies to any request (an opaque origin has a null
 * site-for-cookies, so even SameSite=Lax credentials stay home), and cannot
 * touch same-origin storage. The same list is applied twice on purpose:
 *
 *   • as the iframe `sandbox` attribute in the guard shell, and
 *   • as a `Content-Security-Policy: sandbox …` response header here,
 *
 * so agent-controlled HTML is opaque even when it is reached *without* the
 * shell — a lured top-level navigation to a preview URL must not hand the
 * agent a usable dashboard origin either.
 *
 * `allow-top-navigation` is absent so a preview can never navigate the
 * dashboard away, and `allow-popups-to-escape-sandbox` is absent so popups
 * the preview opens inherit the same opaque origin.
 */
export const PREVIEW_SANDBOX_TOKENS = 'allow-scripts allow-forms allow-popups';
const PREVIEW_SANDBOX_CSP = `sandbox ${PREVIEW_SANDBOX_TOKENS}`;

export type PreviewProxyResolution = SessionPreviewResolution | {
  ok: false;
  status: 503;
  error: 'daemon_offline';
};

export interface SessionPreviewProxyOptions {
  /** Management-cookie authentication. Query tokens are deliberately not
   * accepted: a preview URL must never contain the dashboard token. */
  authenticated: (req: IncomingMessage) => boolean;
  /** Positive session/daemon ownership lookup followed by registered-target
   * resolution. The URL contributes only the session id, never a target. */
  resolve: (sessionId: string) => PreviewProxyResolution;
  /**
   * Verify the path-scoped capability that authorises the sandboxed content
   * stream for exactly this session. Required, not optional: the content path
   * carries no cookie by construction, so a missing verifier would either be
   * an open proxy or a dead route — both worse than a compile error.
   */
  verifyContentCapability: (capability: string, sessionId: string) => boolean;
  /**
   * P1-8：把一条已授权的长连接（SSE / 长响应 / WebSocket 桥）挂到签发它的认证
   * 会话下，返回注销闭包（连接自然结束时调用）。认证结束时由外层索引统一
   * `close()`。返回 null 表示这条流没有可绑定的身份（不该发生，调用方自行决定
   * 是否记录），此时行为与不提供本钩子一致。
   *
   * 授权与撤销是两件事：`authenticated` / `verifyContentCapability` 只在握手那
   * 一刻说话，而预览的 SSE 与 WebSocket 一握手就能流上几个小时。没有这个钩子，
   * 登出只能等对端自己断开。
   */
  bindStream?: (
    req: IncomingMessage,
    context: { sessionId: string; contentCapability: string | null },
    close: () => void,
  ) => (() => void) | null;
}

type ParsedPreviewPath =
  | { matched: false }
  | { matched: true; ok: false; error: 'invalid_preview_path' | 'query_token_forbidden' }
  | {
      matched: true;
      ok: true;
      sessionId: string;
      upstreamPath: string;
      basePath: string;
      /** Present only on `/preview/<id>/__botmux_preview_content/<cap>/…`. */
      contentCapability: string | null;
    };

function safeDecodeSessionId(raw: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return undefined; }
  if (!decoded || decoded.length > 512 || /[\\/\0]/.test(decoded)) return undefined;
  return decoded;
}

export function parseSessionPreviewRequest(url: URL): ParsedPreviewPath {
  if (url.pathname !== PREVIEW_ROUTE_PREFIX && !url.pathname.startsWith(`${PREVIEW_ROUTE_PREFIX}/`)) {
    return { matched: false };
  }
  if (url.searchParams.has('t')) {
    return { matched: true, ok: false, error: 'query_token_forbidden' };
  }
  const afterPrefix = url.pathname.slice(PREVIEW_ROUTE_PREFIX.length + 1);
  const slash = afterPrefix.indexOf('/');
  const rawSessionId = slash >= 0 ? afterPrefix.slice(0, slash) : afterPrefix;
  const sessionId = safeDecodeSessionId(rawSessionId);
  if (!sessionId) return { matched: true, ok: false, error: 'invalid_preview_path' };
  let rest = slash >= 0 ? afterPrefix.slice(slash) : '/';
  let basePath = sessionPreviewPath(sessionId);
  let contentCapability: string | null = null;
  const contentPrefix = `/${PREVIEW_CONTENT_SEGMENT}/`;
  if (rest === `/${PREVIEW_CONTENT_SEGMENT}` || rest.startsWith(contentPrefix)) {
    // The reserved segment must be followed by a capability; a bare segment is
    // a malformed URL rather than an unauthenticated one.
    if (!rest.startsWith(contentPrefix)) {
      return { matched: true, ok: false, error: 'invalid_preview_path' };
    }
    const afterSegment = rest.slice(contentPrefix.length);
    const capabilitySlash = afterSegment.indexOf('/');
    const capability = capabilitySlash >= 0 ? afterSegment.slice(0, capabilitySlash) : afterSegment;
    if (!PREVIEW_CONTENT_CAPABILITY_PATTERN.test(capability)) {
      return { matched: true, ok: false, error: 'invalid_preview_path' };
    }
    contentCapability = capability;
    basePath = sessionPreviewContentPath(sessionId, capability);
    rest = capabilitySlash >= 0 ? afterSegment.slice(capabilitySlash) : '/';
  }
  return {
    matched: true,
    ok: true,
    sessionId,
    upstreamPath: `${rest || '/'}${url.search}`,
    basePath,
    contentCapability,
  };
}

function targetAuthority(target: SessionPreviewTarget): string {
  return target.host === '::1' ? `[::1]:${target.port}` : `${target.host}:${target.port}`;
}

function targetOrigin(target: SessionPreviewTarget): string {
  return `http://${targetAuthority(target)}`;
}

function isSensitiveRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'cookie'
    || lower === 'authorization'
    || lower === 'proxy-authorization'
    || lower === 'referer'
    || lower === 'forwarded'
    || lower.startsWith('x-forwarded-')
    || lower.startsWith('x-botmux-');
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function connectionNominatedHeaders(value: string | string[] | undefined): Set<string> {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return new Set(values.flatMap(item => item.split(',')).map(item => item.trim().toLowerCase()).filter(Boolean));
}

/** Never forward dashboard/browser credentials into agent-controlled preview
 * servers. Host and Origin are rewritten to the literal loopback target so
 * common dev servers can still perform their normal origin checks. */
export function previewRequestHeaders(
  headers: IncomingHttpHeaders,
  target: SessionPreviewTarget,
  options: { upgrade?: boolean } = {},
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const nominated = connectionNominatedHeaders(headers.connection);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || isSensitiveRequestHeader(name)
      || HOP_BY_HOP_HEADERS.has(lower) || nominated.has(lower)) continue;
    out[name] = value;
  }
  out.host = targetAuthority(target);
  if (headers.origin !== undefined) out.origin = targetOrigin(target);
  if (options.upgrade && typeof headers.upgrade === 'string' && headers.upgrade) {
    out.connection = 'Upgrade';
    out.upgrade = headers.upgrade;
  }
  return out;
}

function localRedirectPath(
  location: string,
  target: SessionPreviewTarget,
  basePath: string,
): string {
  // `basePath` already encodes whether this stream is the sandboxed content
  // path or a bare preview path, so a rewritten redirect can never escape the
  // mode it started in — in particular an app-issued `Location: /` cannot
  // bounce the sandboxed frame back onto the outer guard shell.
  if (location.startsWith('/')) return `${basePath.slice(0, -1)}${location}`;
  try {
    const parsed = new URL(location);
    const localHosts = new Set([
      target.host,
      target.host === '::1' ? '[::1]' : target.host,
      'localhost',
      '127.0.0.1',
      '[::1]',
    ]);
    const effectivePort = parsed.port
      || (parsed.protocol === 'http:' || parsed.protocol === 'ws:' ? '80' : '443');
    if (
      ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)
      && localHosts.has(parsed.hostname)
      && effectivePort === String(target.port)
    ) {
      return `${basePath.slice(0, -1)}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return location;
  } catch {
    // Relative Location values are already scoped under the current preview path.
  }
  // Relative redirects resolve against the current preview prefix client-side.
  return location;
}

/** CORS headers that let the opaque-origin document read its OWN dev server.
 *
 * Making the preview an opaque origin also makes every `fetch`/XHR it aims at
 * its own dev server a cross-origin request, which would break essentially
 * every real SPA. Echoing `null` back is safe precisely because the origin is
 * not the credential here: the path-scoped capability is, and a request from
 * any *real* web origin is refused with `preview_origin_forbidden` before it
 * ever gets this far. Credentials are deliberately never allowed — an opaque
 * origin has none to send, and `ACAO: null` plus credentials is the classic
 * CORS footgun. */
function applyOpaqueCors(out: OutgoingHttpHeaders): void {
  out['access-control-allow-origin'] = 'null';
  out['access-control-expose-headers'] = '*';
  const vary = out.vary;
  out.vary = vary === undefined
    ? 'Origin'
    : `${Array.isArray(vary) ? vary.join(', ') : String(vary)}, Origin`;
}

function previewResponseHeaders(
  headers: IncomingHttpHeaders,
  target: SessionPreviewTarget,
  basePath: string,
  opaqueRequest: boolean,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const nominated = connectionNominatedHeaders(headers.connection);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    // A local app must not set/clear cookies or storage on the dashboard origin.
    if (lower === 'set-cookie' || lower === 'clear-site-data'
      || HOP_BY_HOP_HEADERS.has(lower) || nominated.has(lower)) continue;
    // The dashboard decides the CORS answer for its own origin boundary; an
    // app-supplied one would otherwise be duplicated or widened.
    if (lower.startsWith('access-control-')) continue;
    if (lower === 'location' && typeof value === 'string') {
      out[name] = localRedirectPath(value, target, basePath);
      continue;
    }
    if (value !== undefined) out[name] = value;
  }
  out['cache-control'] = 'no-store';
  out['referrer-policy'] = 'no-referrer';
  // Append rather than replace: multiple CSP headers intersect, so an app that
  // ships its own policy keeps it AND gets the sandbox. Replacing would let an
  // agent-chosen policy decide how strict the dashboard's boundary is.
  const upstreamCsp = out['content-security-policy'];
  (out as Record<string, string | string[]>)['content-security-policy'] = upstreamCsp === undefined
    ? PREVIEW_SANDBOX_CSP
    : [...(Array.isArray(upstreamCsp) ? upstreamCsp : [String(upstreamCsp)]), PREVIEW_SANDBOX_CSP];
  if (opaqueRequest) applyOpaqueCors(out);
  return out;
}

function jsonError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({ ok: false, error }));
}

function socketError(socket: Duplex, status: number, error: string): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ ok: false, error });
  const reason = status === 400 ? 'Bad Request'
    : status === 401 ? 'Unauthorized'
    : status === 403 ? 'Forbidden'
    : status === 404 ? 'Not Found'
    : status === 409 ? 'Conflict'
    : status === 503 ? 'Service Unavailable'
    : 'Bad Gateway';
  socket.end([
    `HTTP/1.1 ${status} ${reason}`,
    'content-type: application/json; charset=utf-8',
    'cache-control: no-store',
    'connection: close',
    `content-length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'));
}

export function createSessionPreviewProxy(options: SessionPreviewProxyOptions): {
  handleHttp: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
} {
  const authorizeAndResolve = (
    req: IncomingMessage,
    parsed: Extract<ParsedPreviewPath, { matched: true; ok: true }>,
  ):
    | { ok: true; target: SessionPreviewTarget }
    | { ok: false; status: number; error: string } => {
    if (parsed.contentCapability !== null) {
      // Requests issued *by* the opaque-origin document carry `Origin: null`
      // (fetch/WebSocket) or no Origin at all (navigations, no-cors
      // subresources). A real web origin presenting a leaked capability is an
      // attacker replaying it from a page context, so refuse it outright.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== 'null') {
        return { ok: false, status: 403, error: 'preview_origin_forbidden' };
      }
      if (!options.verifyContentCapability(parsed.contentCapability, parsed.sessionId)) {
        return { ok: false, status: 401, error: 'preview_capability_invalid' };
      }
    } else if (!options.authenticated(req)) {
      return { ok: false, status: 401, error: 'authentication_required' };
    }
    const resolution = options.resolve(parsed.sessionId);
    if (!resolution.ok) return resolution;
    if (!isPreviewLoopbackHost(resolution.target.host)) {
      return { ok: false, status: 403, error: 'remote_host_forbidden' };
    }
    if (!isPreviewPort(resolution.target.port)) {
      return { ok: false, status: 409, error: 'invalid_preview_target' };
    }
    const target = safeSessionPreviewTarget(resolution.target);
    if (!target) return { ok: false, status: 409, error: 'invalid_preview_target' };
    return { ok: true, target };
  };

  const handleHttp = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const parsed = parseSessionPreviewRequest(url);
    if (!parsed.matched) return false;
    if (!parsed.ok) {
      jsonError(res, 400, parsed.error);
      return true;
    }
    const resolved = authorizeAndResolve(req, parsed);
    if (!resolved.ok) {
      jsonError(res, resolved.status, resolved.error);
      return true;
    }
    const target = resolved.target;
    const opaqueRequest = parsed.contentCapability !== null && req.headers.origin === 'null';
    // Answer the preflight here rather than forwarding it: the capability in
    // the path is what authorises this stream, so a dev server that never
    // implemented OPTIONS must not be the reason its own SPA cannot call it.
    if (opaqueRequest && req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined) {
      const preflight: OutgoingHttpHeaders = {
        'access-control-allow-methods': '*',
        'access-control-allow-headers': typeof req.headers['access-control-request-headers'] === 'string'
          ? req.headers['access-control-request-headers']
          : '*',
        'access-control-max-age': '600',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-length': '0',
      };
      applyOpaqueCors(preflight);
      res.writeHead(204, preflight);
      res.end();
      return true;
    }
    const upstream = requestLiteralLoopback(target, {
      method: req.method,
      path: parsed.upstreamPath,
      headers: previewRequestHeaders(req.headers, target),
    }, (up) => {
      // The timeout bounds the connect/header phase, not long-running preview
      // responses such as SSE. Once headers arrive, ordinary HTTP semantics win.
      upstream.setTimeout(0);
      res.writeHead(
        up.statusCode ?? 502,
        previewResponseHeaders(up.headers, target, parsed.basePath, opaqueRequest),
      );
      // P1-8：headers 之后才登记——此刻才确定这是一条真的在流的响应（预览页常
      // 见的 SSE / 长轮询都在这条路上）。短响应会立刻 close 并自行注销。
      const unbind = options.bindStream?.(
        req,
        { sessionId: parsed.sessionId, contentCapability: parsed.contentCapability },
        () => { upstream.destroy(); res.destroy(); },
      );
      if (unbind) res.on('close', unbind);
      up.pipe(res);
    });
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      if (!res.headersSent) jsonError(res, 502, 'preview_unreachable');
      else res.end();
    };
    upstream.setTimeout(PREVIEW_UPSTREAM_RESPONSE_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('error', fail);
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
    return true;
  };

  const handleUpgrade = (req: IncomingMessage, clientSocket: Duplex, head: Buffer): boolean => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); }
    catch { return false; }
    const parsed = parseSessionPreviewRequest(url);
    if (!parsed.matched) return false;
    // Attach before validation/dial so a browser disconnect on every claimed
    // 400/401/404/502 path is handled instead of becoming an uncaught process
    // `error` event.
    let upstreamRequest: ReturnType<typeof requestLiteralLoopback> | undefined;
    let bridgedSocket: Duplex | undefined;
    clientSocket.on('error', () => {
      upstreamRequest?.destroy();
      bridgedSocket?.destroy();
      if (!clientSocket.destroyed) clientSocket.destroy();
    });
    if (!parsed.ok) {
      socketError(clientSocket, 400, parsed.error);
      return true;
    }
    const resolved = authorizeAndResolve(req, parsed);
    if (!resolved.ok) {
      socketError(clientSocket, resolved.status, resolved.error);
      return true;
    }
    const target = resolved.target;
    let responded = false;
    const upstream = requestLiteralLoopback(target, {
      method: req.method,
      path: parsed.upstreamPath,
      headers: previewRequestHeaders(req.headers, target, { upgrade: true }),
    });
    upstreamRequest = upstream;
    upstream.setTimeout(PREVIEW_UPSTREAM_RESPONSE_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('upgrade', (upRes, upstreamSocket, upstreamHead) => {
      responded = true;
      bridgedSocket = upstreamSocket;
      upstream.setTimeout(0);
      upstreamSocket.setTimeout(0);
      const lines = [`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}`];
      const raw = upRes.rawHeaders;
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const name = raw[i].toLowerCase();
        if (name === 'set-cookie' || name === 'clear-site-data') continue;
        lines.push(`${raw[i]}: ${raw[i + 1]}`);
      }
      lines.push('', '');
      clientSocket.write(lines.join('\r\n'));
      if (upstreamHead.length) clientSocket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      // P1-8：预览 WebSocket 是最典型的「握手一次、流很久」——登出后不主动关，
      // 它就一直把 agent 页面的内容送给已经登出的浏览器。
      const unbind = options.bindStream?.(
        req,
        { sessionId: parsed.sessionId, contentCapability: parsed.contentCapability },
        () => { upstreamSocket.destroy(); clientSocket.destroy(); },
      );
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      const cleanup = () => {
        unbind?.();
        upstreamSocket.destroy();
        clientSocket.destroy();
      };
      upstreamSocket.on('error', cleanup);
      upstreamSocket.on('close', () => { unbind?.(); clientSocket.destroy(); });
      clientSocket.on('close', () => { unbind?.(); upstreamSocket.destroy(); });
    });
    upstream.on('response', (upRes) => {
      responded = true;
      upstream.setTimeout(0);
      const bodyChunks: Buffer[] = [];
      let bodyBytes = 0;
      upRes.on('data', chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bodyBytes += buffer.byteLength;
        if (bodyBytes > MAX_WEBSOCKET_REJECTION_BYTES) {
          upRes.destroy();
          clientSocket.destroy();
          return;
        }
        bodyChunks.push(buffer);
      });
      upRes.on('end', () => {
        const body = Buffer.concat(bodyChunks);
        const lines = [
          `HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? 'Bad Gateway'}`,
          'connection: close',
          'cache-control: no-store',
          `content-length: ${body.byteLength}`,
        ];
        for (const [name, value] of Object.entries(upRes.headers)) {
          const lower = name.toLowerCase();
          if (
            value === undefined
            || lower === 'connection'
            || lower === 'content-length'
            || lower === 'transfer-encoding'
            || lower === 'set-cookie'
            || lower === 'clear-site-data'
            || lower === 'cache-control'
          ) continue;
          const values = Array.isArray(value) ? value : [value];
          for (const item of values) lines.push(`${name}: ${item}`);
        }
        lines.push('', '');
        clientSocket.write(lines.join('\r\n'));
        if (body.length) clientSocket.write(body);
        clientSocket.end();
      });
      upRes.on('error', () => clientSocket.destroy());
    });
    upstream.on('error', () => {
      if (!responded) socketError(clientSocket, 502, 'preview_unreachable');
      else clientSocket.destroy();
    });
    upstream.end();
    return true;
  };

  return { handleHttp, handleUpgrade };
}
