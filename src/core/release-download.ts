/**
 * Shared release-asset download: GET a URL through an optional proxy, following
 * redirects, and resolve with the 200 response stream.
 *
 * Used by the binary self-update (`core/binary-self-update.ts`) to fetch GitHub
 * Release assets. It needs three things the naive `fetch` version gets wrong:
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

/** Resolve an outbound proxy: GitHub downloads prefer explicit config, then
 * standard env vars. Registry requests opt out of the GitHub-only config. */
export function resolveHttpProxy(options: { includeConfig?: boolean } = {}): string | undefined {
  return (options.includeConfig !== false ? readGlobalConfig().httpProxy : undefined)
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || undefined;
}

/** Apply proxy-from-env's NO_PROXY matching rules to an already selected proxy.
 * Unlike getProxyForUrl, this also honours exclusions for the explicit
 * httpProxy config / caller-supplied proxy, without mutating process.env. */
export function proxyForUrl(rawUrl: string, proxy: string | undefined): string | undefined {
  if (!proxy) return undefined;
  const exclusions = (process.env.npm_config_no_proxy || process.env.NPM_CONFIG_NO_PROXY
    || process.env.no_proxy || process.env.NO_PROXY || '').toLowerCase();
  if (!exclusions) return proxy;
  if (exclusions === '*') return undefined;
  const target = new URL(rawUrl);
  const hostname = target.hostname.toLowerCase();
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const bypass = exclusions.split(/[,\s]/).some(entry => {
    if (!entry) return false;
    const withPort = entry.match(/^(.+):(\d+)$/);
    const host = withPort ? withPort[1] : entry;
    if (withPort && Number(withPort[2]) !== port) return false;
    if (!/^[.*]/.test(host)) return hostname === host;
    return hostname.endsWith(host.startsWith('*') ? host.slice(1) : host);
  });
  return bypass ? undefined : proxy;
}

/**
 * GET a URL and resolve with the 200 response stream, following redirects and
 * optionally tunnelling through an HTTP proxy.
 *
 * @param userAgent sent as `user-agent`; callers pass their own tag so server-side
 *                  logs can tell which feature issued the download.
 */
export function getReleaseStream(
  rawUrl: string,
  proxy: string | undefined,
  userAgent: string,
  redirectsLeft = 5,
  options: { signal?: AbortSignal; headers?: Record<string, string>; respectNoProxy?: boolean } = {},
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
        resolve(getReleaseStream(new URL(res.headers.location, rawUrl).toString(), proxy, userAgent, redirectsLeft - 1, options));
        return;
      }
      if (sc !== 200) { res.resume(); reject(new Error(`HTTP ${sc}`)); return; }
      resolve(res);
    };

    // Re-evaluate exclusions on every redirect target. Keep the original proxy
    // available so a direct mirror can redirect back to an external CDN.
    const hopProxy = options.respectNoProxy ? proxyForUrl(rawUrl, proxy) : proxy;
    let p: URL | undefined;
    if (hopProxy) {
      try { p = new URL(hopProxy); } catch { reject(new Error(`代理地址非法: ${hopProxy}`)); return; }
    }
    const proxyAuth = (): Record<string, string> => p?.username
      ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` }
      : {};

    if (p && isHttps) {
      // HTTPS via HTTP proxy: open a CONNECT tunnel, then TLS over the socket.
      const port = target.port || '443';
      const creq = httpRequest({
        host: p.hostname, port: Number(p.port || 80), method: 'CONNECT', agent: false,
        signal: options.signal,
        path: `${target.hostname}:${port}`,
        headers: { host: `${target.hostname}:${port}`, ...proxyAuth() },
      });
      creq.on('connect', (cres, socket) => {
        if (cres.statusCode !== 200) { socket.destroy(); reject(new Error(`代理 CONNECT 失败: HTTP ${cres.statusCode}`)); return; }
        if (options.signal?.aborted) { socket.destroy(); reject(options.signal.reason); return; }
        const tls = tlsConnect({ socket, servername: target.hostname }, () => {
          const greq = httpsRequest({
            method: 'GET', path: `${target.pathname}${target.search}`,
            headers: { ...options.headers, host: target.host, 'user-agent': userAgent },
            signal: options.signal,
            createConnection: () => tls,
          }, handle);
          greq.on('error', reject);
          greq.end();
        });
        // CONNECT relinquishes its request once the tunnel opens. Keep abort
        // active during the TLS handshake as well as the subsequent HTTP body.
        const abort = () => tls.destroy(new Error('release request aborted'));
        options.signal?.addEventListener('abort', abort, { once: true });
        tls.once('close', () => options.signal?.removeEventListener('abort', abort));
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
        headers: { ...options.headers, host: target.host, 'user-agent': userAgent, ...proxyAuth() },
        signal: options.signal,
      }, handle);
      greq.on('error', reject);
      greq.end();
      return;
    }

    // Direct (no proxy).
    const mod = isHttps ? httpsRequest : httpRequest;
    const greq = mod(rawUrl, {
      headers: { ...options.headers, 'user-agent': userAgent }, signal: options.signal,
    }, handle);
    greq.on('error', reject);
    greq.end();
  });
}
