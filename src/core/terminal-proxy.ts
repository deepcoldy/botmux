import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';
import { logger } from '../utils/logger.js';

/**
 * Single fixed reverse-proxy port per daemon. Each session's xterm.js web
 * terminal runs on its own dynamically-assigned worker port, which makes SSH
 * port-forwarding painful on dev machines (one `ssh -L` per topic). This proxy
 * fronts all of a daemon's session terminals under one stable port, routing by
 * sub-path: `http://host:{proxyPort}/s/{sessionId}/...` → the worker's port.
 * Forward one port, reach every session.
 *
 * This is a RAW TCP reverse proxy, not an HTTP one: it peeks only the request
 * line of the first bytes to route + rewrite the path, then splices the two
 * sockets and copies bytes verbatim. Both a plain page load and a WebSocket
 * upgrade are just byte streams, so the same code path serves both.
 *
 * Why raw TCP rather than `http.createServer` + `http.request`: Bun's node:http
 * has two upgrade black holes (verified on Bun 1.3.14, tracked upstream as
 * oven-sh/bun#9882 / #25156, both also break `http-proxy` and `vite` dev proxy):
 *   1. a client `http.request()` never emits the `'upgrade'` event on a 101, and
 *   2. the socket handed to a server `'upgrade'` listener is write-only-to-void —
 *      `write()` returns true, its callback fires, yet no bytes reach the client.
 * Either one silently drops every terminal WebSocket. Raw sockets rely on none
 * of that machinery, so this proxy behaves identically on Node and Bun.
 */

export interface TerminalProxyOptions {
  port: number;
  host?: string;
  /** Resolve a sessionId to its live worker HTTP port (undefined if not running). */
  resolvePort: (sessionId: string) => number | undefined;
  /**
   * Optional on-demand wake: when `resolvePort` finds no live worker, re-fork it
   * (re-attaching the surviving tmux/zellij pane) and resolve once its port is
   * up. Lets terminals open after a quiet restart without first messaging the
   * session. Returns undefined when there's nothing to wake. Slow path only.
   */
  ensureWorkerPort?: (sessionId: string) => Promise<number | undefined>;
  /** Max upward port probes when `port` is taken (EADDRINUSE). Default 20; 0 disables. */
  maxProbe?: number;
}

export interface TerminalProxyHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * Split a request URL of the form `/s/{sessionId}{rest}` into its sessionId and
 * the remainder that should be forwarded to the worker. The remainder always
 * starts with `/` so the worker sees a normal request (`/`, `/?token=x`, …).
 * Returns null when the URL is not a session route.
 */
export function parseTarget(rawUrl: string): { sessionId: string; rest: string } | null {
  if (!rawUrl.startsWith('/s/')) return null;
  const after = rawUrl.slice(3);
  const m = /^([^/?#]+)(.*)$/.exec(after);
  if (!m || !m[1]) return null;
  const sessionId = m[1];
  let rest = m[2] ?? '';
  // '' → '/', '?x' → '/?x', '#x' → '/#x'; an explicit '/...' is kept as-is.
  if (rest === '' || rest[0] === '?' || rest[0] === '#') rest = '/' + rest;
  return { sessionId, rest };
}

/**
 * Parse the HTTP request line `METHOD SP request-target SP HTTP/x.y`. Returns the
 * three parts, or null when the line isn't a well-formed request line. Only the
 * request-target is rewritten; method + version are replayed verbatim.
 */
function parseRequestLine(line: string): { method: string; target: string; version: string } | null {
  // Split on single spaces; a request-target never contains a space, so a 3-part
  // split is exact for HTTP/1.x. Reject anything else (garbage / TLS bytes).
  const first = line.indexOf(' ');
  const last = line.lastIndexOf(' ');
  if (first <= 0 || last <= first) return null;
  const method = line.slice(0, first);
  const target = line.slice(first + 1, last);
  const version = line.slice(last + 1);
  if (!/^HTTP\/\d\.\d$/.test(version)) return null;
  return { method, target, version };
}

/** Minimal close-delimited HTTP response written straight to the client socket. */
function writeHttpError(sock: Socket, status: number, reason: string, body: string): void {
  const payload =
    `HTTP/1.1 ${status} ${reason}\r\n` +
    'content-type: text/plain; charset=utf-8\r\n' +
    'connection: close\r\n' +
    '\r\n' +
    body;
  try { sock.end(payload); } catch { /* client already gone */ }
}

export function startTerminalProxy(opts: TerminalProxyOptions): Promise<TerminalProxyHandle> {
  const host = opts.host ?? '0.0.0.0';

  // Fast sync lookup; fall back to the on-demand wake (slow path) only when no
  // live worker is registered. Errors in the wake collapse to "not serveable".
  const resolvePortMaybeWake = async (sessionId: string): Promise<number | undefined> => {
    const live = opts.resolvePort(sessionId);
    if (live) return live;
    if (!opts.ensureWorkerPort) return undefined;
    try { return await opts.ensureWorkerPort(sessionId); } catch { return undefined; }
  };

  // Guard against a client that opens a connection and never sends a complete
  // request line: cap the buffered preamble and give it a short deadline so a
  // stuck/hostile peer can't pin a socket + its routing timer open forever.
  const REQUEST_LINE_CAP = 64 * 1024;
  const REQUEST_LINE_TIMEOUT_MS = 30_000;

  const server: Server = createServer((client: Socket) => {
    let routed = false;
    let preamble: Buffer = Buffer.alloc(0);

    const routeTimer = setTimeout(() => {
      if (!routed) { routed = true; client.destroy(); }
    }, REQUEST_LINE_TIMEOUT_MS);
    routeTimer.unref?.();

    const onData = (chunk: Buffer) => {
      if (routed) return;
      preamble = preamble.length ? Buffer.concat([preamble, chunk]) : chunk;
      // Buffer to the END OF THE HEADER BLOCK (\r\n\r\n), not just the request
      // line: we must inspect + rewrite headers before forwarding. Routing on the
      // request line alone and byte-splicing the rest verbatim is WRONG under
      // HTTP keep-alive — the client can reuse one connection for a second
      // request to a DIFFERENT session, which would ride the splice to the first
      // request's worker (open A → 200, then open B on the same socket → served
      // by A → 403). See the fix below: force Connection: close on plain HTTP so
      // each connection serves exactly one request→response.
      const headerEnd = preamble.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (preamble.length > REQUEST_LINE_CAP) { routed = true; clearTimeout(routeTimer); client.destroy(); }
        return; // keep buffering until the full header block arrives
      }
      routed = true;
      clearTimeout(routeTimer);
      client.removeListener('data', onData);
      // Pause before the async port resolve so bytes arriving in the gap (a
      // pipelined WS client sends frames right after the handshake) are buffered,
      // not dropped; `.pipe()` resumes the socket and replays them.
      client.pause();

      const lineEnd = preamble.indexOf('\r\n');
      const requestLine = preamble.subarray(0, lineEnd).toString('latin1');
      const headerBlock = preamble.subarray(lineEnd + 2, headerEnd).toString('latin1');
      const bodyAndRest = preamble.subarray(headerEnd + 4); // bytes after \r\n\r\n
      const parsedLine = parseRequestLine(requestLine);
      const parsed = parsedLine ? parseTarget(parsedLine.target) : null;
      if (!parsedLine || !parsed) {
        writeHttpError(client, 404, 'Not Found', 'not found');
        return;
      }

      // Is this a WebSocket/Upgrade request? Then the connection legitimately
      // stays open for the upgraded protocol (a single request per connection —
      // no keep-alive reuse), so forward the headers as-is (they carry the
      // Upgrade/Connection/Sec-WebSocket-* handshake the worker needs).
      const headerLines = headerBlock.length ? headerBlock.split('\r\n') : [];
      const isUpgrade = headerLines.some((l) => /^upgrade\s*:/i.test(l));

      resolvePortMaybeWake(parsed.sessionId).then((port) => {
        if (!port) {
          writeHttpError(client, 502, 'Bad Gateway', 'session not running');
          return;
        }

        // Rewrite ONLY the request-target (strip the `/s/{sessionId}` prefix).
        const rewrittenLine = `${parsedLine.method} ${parsed.rest} ${parsedLine.version}`;
        let forwardedHeaders: string[];
        if (isUpgrade) {
          forwardedHeaders = headerLines; // verbatim — preserve the WS handshake
        } else {
          // Plain HTTP: force Connection: close so this connection serves exactly
          // one request→response and can never be reused for a second (possibly
          // different-session) request that our one-shot router would misroute.
          forwardedHeaders = headerLines.filter((l) => !/^(connection|keep-alive|proxy-connection)\s*:/i.test(l));
          forwardedHeaders.push('Connection: close');
        }
        const head = `${rewrittenLine}\r\n${forwardedHeaders.join('\r\n')}${forwardedHeaders.length ? '\r\n' : ''}\r\n`;

        const upstream = netConnect({ host: '127.0.0.1', port }, () => {
          upstream.write(head);
          if (bodyAndRest.length) upstream.write(bodyAndRest);
          // Opaque byte splice both ways from here — the response body (or every
          // WS frame) flows through untouched. For plain HTTP the upstream sees
          // Connection: close and ends the response by closing, which tears down
          // this connection — exactly one request served, no misrouting.
          upstream.pipe(client);
          client.pipe(upstream);
        });
        const cleanup = () => { upstream.destroy(); client.destroy(); };
        upstream.on('error', () => {
          if (!client.destroyed) writeHttpError(client, 502, 'Bad Gateway', 'proxy error');
          upstream.destroy();
        });
        client.on('error', cleanup);
        upstream.on('close', () => client.destroy());
        client.on('close', () => upstream.destroy());
      }).catch(() => {
        if (!client.destroyed) writeHttpError(client, 502, 'Bad Gateway', 'proxy error');
      });
    };

    client.on('data', onData);
    client.on('error', () => { clearTimeout(routeTimer); client.destroy(); });
  });

  // When the preferred port is taken, probe upward to the next free port so the
  // proxy always comes up on a single stable-ish port (the daemon advertises the
  // actually-bound port via getTerminalProxyPort, so links auto-follow). After
  // maxProbe exhausted attempts it rejects → daemon falls back to direct ports.
  const maxProbe = opts.maxProbe ?? 20;

  return new Promise<TerminalProxyHandle>((resolve, reject) => {
    let port = opts.port;
    let attempts = 0;
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempts < maxProbe) {
        attempts++;
        logger.warn(`[terminal-proxy] port ${port} in use, trying ${port + 1}`);
        port++;
        setImmediate(tryListen);
        return;
      }
      reject(err);
    };
    const tryListen = () => {
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        const bound = (server.address() as { port: number }).port;
        // Runtime error handler for post-bind failures.
        server.on('error', (err) => logger.error(`[terminal-proxy] server error: ${(err as Error).message}`));
        resolve({
          port: bound,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    };
    tryListen();
  });
}
