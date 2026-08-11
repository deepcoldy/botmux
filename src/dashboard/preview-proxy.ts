import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import {
  PREVIEW_CONTENT_QUERY,
  PREVIEW_ROUTE_PREFIX,
  isPreviewLoopbackHost,
  isPreviewPort,
  safeSessionPreviewTarget,
  sessionPreviewPath,
  type SessionPreviewTarget,
} from '../core/session-preview.js';
import { requestLiteralLoopback } from '../core/loopback-target.js';
import type { SessionPreviewResolution } from './preview-contract.js';

const UPSTREAM_CONNECT_TIMEOUT_MS = 2_000;
const MAX_WEBSOCKET_REJECTION_BYTES = 64 * 1024;

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
      guardedContent: boolean;
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
  const rest = slash >= 0 ? afterPrefix.slice(slash) : '/';
  const guardedContent = url.searchParams.has(PREVIEW_CONTENT_QUERY);
  let upstreamSearch = url.search;
  if (guardedContent) {
    const upstreamParams = new URLSearchParams(url.searchParams);
    upstreamParams.delete(PREVIEW_CONTENT_QUERY);
    upstreamSearch = upstreamParams.size > 0 ? `?${upstreamParams.toString()}` : '';
  }
  return {
    matched: true,
    ok: true,
    sessionId,
    upstreamPath: `${rest || '/'}${upstreamSearch}`,
    basePath: sessionPreviewPath(sessionId),
    guardedContent,
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
  guardedContent: boolean,
): string {
  const preserveGuard = (value: string): string => {
    if (!guardedContent) return value;
    const hashAt = value.indexOf('#');
    const beforeHash = hashAt >= 0 ? value.slice(0, hashAt) : value;
    const hash = hashAt >= 0 ? value.slice(hashAt) : '';
    return `${beforeHash}${beforeHash.includes('?') ? '&' : '?'}${PREVIEW_CONTENT_QUERY}=1${hash}`;
  };
  if (location.startsWith('/')) return preserveGuard(`${basePath.slice(0, -1)}${location}`);
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
      return preserveGuard(`${basePath.slice(0, -1)}${parsed.pathname}${parsed.search}${parsed.hash}`);
    }
    return location;
  } catch {
    // Relative Location values are already scoped under the current preview path.
  }
  // Relative redirects remain under the current preview prefix. Preserve the
  // private content marker as well so `Location: ./` cannot recursively load
  // the outer guard shell inside its own iframe.
  return preserveGuard(location);
}

function previewResponseHeaders(
  headers: IncomingHttpHeaders,
  target: SessionPreviewTarget,
  basePath: string,
  guardedContent: boolean,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const nominated = connectionNominatedHeaders(headers.connection);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    // A local app must not set/clear cookies or storage on the dashboard origin.
    if (lower === 'set-cookie' || lower === 'clear-site-data'
      || HOP_BY_HOP_HEADERS.has(lower) || nominated.has(lower)) continue;
    if (lower === 'location' && typeof value === 'string') {
      out[name] = localRedirectPath(value, target, basePath, guardedContent);
      continue;
    }
    if (value !== undefined) out[name] = value;
  }
  out['cache-control'] = 'no-store';
  out['referrer-policy'] = 'no-referrer';
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
    if (!options.authenticated(req)) return { ok: false, status: 401, error: 'authentication_required' };
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
        previewResponseHeaders(up.headers, target, parsed.basePath, parsed.guardedContent),
      );
      up.pipe(res);
    });
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      if (!res.headersSent) jsonError(res, 502, 'preview_unreachable');
      else res.end();
    };
    upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => upstream.destroy());
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
    upstream.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('upgrade', (upRes, upstreamSocket, upstreamHead) => {
      responded = true;
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
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      const cleanup = () => {
        upstreamSocket.destroy();
        clientSocket.destroy();
      };
      upstreamSocket.on('error', cleanup);
      clientSocket.on('error', cleanup);
      upstreamSocket.on('close', () => clientSocket.destroy());
      clientSocket.on('close', () => upstreamSocket.destroy());
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
