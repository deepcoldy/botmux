/**
 * Shared release-asset download: GET a URL through an optional proxy, following
 * redirects, and resolve with the 200 response stream.
 *
 * Extracted from `dashboard/hd2d-assets.ts` so the binary self-update
 * (`core/binary-self-update.ts`) reuses exactly this transport instead of
 * growing a second copy. Both callers fetch GitHub Release assets, and both need
 * the same three things the naive version gets wrong:
 *
 *  · `node:http`/`node:https` rather than `fetch`, so an explicitly configured
 *    proxy is actually honoured — undici ignores the proxy env vars, and Bun's
 *    fetch goes the other way and honours them too eagerly (see
 *    `core/loopback-fetch.ts` for that direction).
 *  · CONNECT tunnelling for HTTPS-via-HTTP-proxy.
 *  · Tearing down each hop before following a redirect: a lingering TLS socket
 *    layered over a CONNECT tunnel stalls the NEXT hop's handshake (observed:
 *    github.com → release-assets… drops with "socket disconnected before secure
 *    TLS" unless hop 1 is closed). GitHub Release downloads ALWAYS redirect, so
 *    this is the normal path, not an edge case.
 */
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { Buffer } from 'node:buffer';
import { readGlobalConfig } from '../global-config.js';

/** Resolve an outbound proxy: explicit config wins, then the standard env vars
 *  (which Node's global fetch ignores — the whole reason we hand-roll this). */
export function resolveHttpProxy(): string | undefined {
  return readGlobalConfig().httpProxy
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || undefined;
}

/**
 * GET a URL and resolve with the 200 response stream, following redirects and
 * optionally tunnelling through an HTTP proxy.
 *
 * @param userAgent sent as `user-agent`; callers pass their own tag so server-side
 *                  logs can tell the game assets apart from a self-update.
 */
export function getReleaseStream(
  rawUrl: string,
  proxy: string | undefined,
  userAgent: string,
  redirectsLeft = 5,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try { target = new URL(rawUrl); } catch { reject(new Error(`URL 非法: ${rawUrl}`)); return; }
    const isHttps = target.protocol === 'https:';

    const handle = (res: IncomingMessage) => {
      const sc = res.statusCode ?? 0;
      if (sc >= 300 && sc < 400 && res.headers.location) {
        // Tear down this hop's connection before following the redirect (see header).
        res.destroy();
        res.socket?.destroy();
        if (redirectsLeft <= 0) { reject(new Error('重定向次数过多')); return; }
        resolve(getReleaseStream(new URL(res.headers.location, rawUrl).toString(), proxy, userAgent, redirectsLeft - 1));
        return;
      }
      if (sc !== 200) { res.resume(); reject(new Error(`HTTP ${sc}`)); return; }
      resolve(res);
    };

    let p: URL | undefined;
    if (proxy) {
      try { p = new URL(proxy); } catch { reject(new Error(`代理地址非法: ${proxy}`)); return; }
    }
    const proxyAuth = (): Record<string, string> => p?.username
      ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` }
      : {};

    if (p && isHttps) {
      // HTTPS via HTTP proxy: open a CONNECT tunnel, then TLS over the socket.
      const port = target.port || '443';
      const creq = httpRequest({
        host: p.hostname, port: Number(p.port || 80), method: 'CONNECT', agent: false,
        path: `${target.hostname}:${port}`,
        headers: { host: `${target.hostname}:${port}`, ...proxyAuth() },
      });
      creq.on('connect', (cres, socket) => {
        if (cres.statusCode !== 200) { reject(new Error(`代理 CONNECT 失败: HTTP ${cres.statusCode}`)); return; }
        const tls = tlsConnect({ socket, servername: target.hostname }, () => {
          const greq = httpsRequest({
            method: 'GET', path: `${target.pathname}${target.search}`,
            headers: { host: target.host, 'user-agent': userAgent },
            createConnection: () => tls,
          }, handle);
          greq.on('error', reject);
          greq.end();
        });
        tls.on('error', reject);
      });
      creq.on('error', reject);
      creq.end();
      return;
    }

    if (p) {
      // Plain HTTP via proxy: send the absolute-form request line to the proxy.
      const greq = httpRequest({
        host: p.hostname, port: Number(p.port || 80), method: 'GET', path: rawUrl,
        headers: { host: target.host, 'user-agent': userAgent, ...proxyAuth() },
      }, handle);
      greq.on('error', reject);
      greq.end();
      return;
    }

    // Direct (no proxy).
    const mod = isHttps ? httpsRequest : httpRequest;
    const greq = mod(rawUrl, { headers: { 'user-agent': userAgent } }, handle);
    greq.on('error', reject);
    greq.end();
  });
}
