import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import { requestLiteralLoopback } from '../core/loopback-target.js';
import type { TerminalControlManager, TerminalDashboardActor } from './terminal-control.js';

export const TERMINAL_CONTROL_HEADER = 'x-botmux-terminal-control';
/** Covers daemon wake-up (up to 10s) plus a bounded worker handshake. Cleared
 * as soon as response/upgrade headers arrive, so live streams stay unbounded. */
export const TERMINAL_UPSTREAM_RESPONSE_TIMEOUT_MS = 30_000;

export interface TerminalFrontProxyOptions {
  resolvePort(sessionId: string): number | undefined;
  resolveActor(req: IncomingMessage): TerminalDashboardActor | null;
  /** Legacy owner pages may still open an explicitly minted token/viewToken
   * link. H5 identities must never opt into this stable-capability path. */
  allowLegacyQueryCapabilities?(actor: TerminalDashboardActor): boolean;
  control: TerminalControlManager;
}

function safeDecodeSessionId(raw: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return undefined; }
  return decoded && decoded.length <= 512 && !/[\\/\0]/.test(decoded) ? decoded : undefined;
}

export function parseTerminalFrontPath(pathname: string): { sessionId: string } | null {
  if (!pathname.startsWith('/s/')) return null;
  const raw = pathname.slice(3).split('/')[0];
  const sessionId = safeDecodeSessionId(raw);
  return sessionId ? { sessionId } : null;
}

function sensitiveBrowserHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'cookie'
    || lower === 'authorization'
    || lower === 'proxy-authorization'
    || lower === 'referer'
    || lower === 'forwarded'
    || lower.startsWith('x-forwarded-')
    || lower.startsWith('x-botmux-');
}

/**
 * Authenticated Dashboard requests are converted to one signed loopback grant.
 * Client-supplied cookies/role/grant headers are removed first. Token/viewToken
 * query capabilities remain supported for legacy direct links and are handled
 * independently by the worker.
 */
export function terminalForwardHeaders(
  headers: IncomingHttpHeaders,
  grant: string | undefined,
  options: { stripBrowserCredentials?: boolean } = {},
): OutgoingHttpHeaders {
  if (!grant && !options.stripBrowserCredentials) {
    // Legacy query capabilities and platform headers retain their historical
    // behavior, but an unauthenticated browser may never supply/replay the new
    // internal grant header itself.
    const forwarded = { ...headers };
    delete forwarded[TERMINAL_CONTROL_HEADER];
    return forwarded;
  }
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || sensitiveBrowserHeader(name)) continue;
    forwarded[name] = value;
  }
  if (grant) forwarded[TERMINAL_CONTROL_HEADER] = grant;
  return forwarded;
}

function plainError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(message);
}

function socketError(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = message;
  const reason = status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'Bad Gateway';
  socket.end([
    `HTTP/1.1 ${status} ${reason}`,
    'content-type: text/plain; charset=utf-8',
    'cache-control: no-store',
    'connection: close',
    `content-length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'));
}

export function createTerminalFrontProxy(options: TerminalFrontProxyOptions): {
  handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
} {
  const prepare = (req: IncomingMessage, pathname: string) => {
    const parsed = parseTerminalFrontPath(pathname);
    if (!parsed) return null;
    const port = options.resolvePort(parsed.sessionId);
    const actor = options.resolveActor(req);
    let hasLegacyQueryCapability = false;
    if (actor && options.allowLegacyQueryCapabilities?.(actor)) {
      try {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost');
        hasLegacyQueryCapability = requestUrl.searchParams.has('token')
          || requestUrl.searchParams.has('viewToken');
      } catch {
        // The outer path parser will reject malformed requests.
      }
    }
    const proxyGrant = actor && !hasLegacyQueryCapability
      ? options.control.grantForProxy(actor, parsed.sessionId)
      : undefined;
    return {
      ...parsed,
      port,
      actor,
      proxyGrant,
      headers: terminalForwardHeaders(req.headers, proxyGrant?.token, {
        // Validate the explicit capability at the worker, but do not also send
        // the legacy management cookie: a garbage `?token=` must not become a
        // writable request merely because its opener is the owner Dashboard.
        stripBrowserCredentials: hasLegacyQueryCapability,
      }),
    };
  };

  const handleHttp = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    if (!(url.pathname === '/s' || url.pathname.startsWith('/s/'))) return false;
    const prepared = prepare(req, url.pathname);
    if (!prepared?.port) {
      plainError(res, 404, 'session terminal not available');
      return true;
    }
    const upstream = requestLiteralLoopback({ host: '127.0.0.1', port: prepared.port }, {
      method: req.method,
      path: req.url,
      headers: prepared.headers,
    }, up => {
      upstream.setTimeout(0);
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.setTimeout(TERMINAL_UPSTREAM_RESPONSE_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) plainError(res, 502, 'terminal proxy error');
      else res.end();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
    return true;
  };

  const handleUpgrade = (req: IncomingMessage, clientSocket: Duplex, head: Buffer): boolean => {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { return false; }
    if (!(url.pathname === '/s' || url.pathname.startsWith('/s/'))) return false;
    // Install this synchronously for every claimed upgrade path. Browser
    // disconnects can race DNS/connect/401/404/502 handling; an EventEmitter
    // `error` without a listener would otherwise terminate the Dashboard.
    let upstreamRequest: ReturnType<typeof requestLiteralLoopback> | undefined;
    let bridgedSocket: Duplex | undefined;
    clientSocket.on('error', () => {
      upstreamRequest?.destroy();
      bridgedSocket?.destroy();
      if (!clientSocket.destroyed) clientSocket.destroy();
    });
    const prepared = prepare(req, url.pathname);
    if (!prepared?.port) {
      socketError(clientSocket, 404, 'session terminal not available');
      return true;
    }

    let responded = false;
    const upstream = requestLiteralLoopback({ host: '127.0.0.1', port: prepared.port }, {
      method: req.method,
      path: req.url,
      headers: prepared.headers,
    });
    upstreamRequest = upstream;
    upstream.setTimeout(TERMINAL_UPSTREAM_RESPONSE_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('upgrade', (upRes, upstreamSocket, upstreamHead) => {
      responded = true;
      bridgedSocket = upstreamSocket;
      upstream.setTimeout(0);
      upstreamSocket.setTimeout(0);

      let leaseMarker: string | undefined;
      if (prepared.actor && prepared.proxyGrant?.scope === 'write' && prepared.proxyGrant.leaseMarker) {
        const registered = options.control.registerWritableSocket(
          prepared.actor,
          prepared.sessionId,
          clientSocket,
          prepared.proxyGrant.leaseMarker,
        );
        leaseMarker = registered.leaseMarker;
        if (!registered.registered) {
          // The worker may have accepted a grant that was valid when the dial
          // began but was released/expired/replaced during its async handshake.
          // Never relay that 101: revoke the matching old lease (if any) and
          // make the browser reconnect through the now-read-only path.
          options.control.disconnect(
            prepared.actor,
            prepared.sessionId,
            prepared.proxyGrant.leaseMarker,
          );
          upstreamSocket.destroy();
          socketError(clientSocket, 409, 'terminal control expired');
          return;
        }
      }

      const lines = [`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}`];
      const raw = upRes.rawHeaders;
      for (let i = 0; i + 1 < raw.length; i += 2) lines.push(`${raw[i]}: ${raw[i + 1]}`);
      lines.push('', '');
      clientSocket.write(lines.join('\r\n'));
      if (upstreamHead.length) clientSocket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);

      let disconnected = false;
      const releaseOnDisconnect = () => {
        if (disconnected || !prepared.actor || !leaseMarker) return;
        disconnected = true;
        options.control.disconnect(prepared.actor, prepared.sessionId, leaseMarker);
      };

      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      const cleanup = () => {
        releaseOnDisconnect();
        upstreamSocket.destroy();
        clientSocket.destroy();
      };
      upstreamSocket.on('error', cleanup);
      upstreamSocket.on('close', () => { releaseOnDisconnect(); clientSocket.destroy(); });
      clientSocket.on('close', () => { releaseOnDisconnect(); upstreamSocket.destroy(); });
    });
    upstream.on('response', upRes => {
      responded = true;
      upstream.setTimeout(0);
      const lines = [`HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? 'Bad Gateway'}`, 'connection: close'];
      const raw = upRes.rawHeaders;
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const name = raw[i].toLowerCase();
        if (name === 'transfer-encoding' || name === 'content-length' || name === 'connection') continue;
        lines.push(`${raw[i]}: ${raw[i + 1]}`);
      }
      lines.push('', '');
      clientSocket.write(lines.join('\r\n'));
      upRes.on('data', chunk => clientSocket.write(chunk));
      upRes.on('end', () => clientSocket.end());
      upRes.on('error', () => clientSocket.destroy());
    });
    upstream.on('error', () => {
      if (!responded) socketError(clientSocket, 502, 'terminal proxy error');
      else clientSocket.destroy();
    });
    upstream.end();
    return true;
  };

  return { handleHttp, handleUpgrade };
}
