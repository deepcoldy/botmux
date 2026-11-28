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
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { Buffer } from 'node:buffer';
import { readGlobalConfig } from '../global-config.js';

/** Strip WHATWG URL brackets around IPv6 literals (`[::1]` → `::1`).
 * `node:http` passes `options.host` straight to `net.connect` / `dns.lookup`,
 * where literal brackets fail with `ENOTFOUND` on both Node and Bun. */
export function stripHostBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

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

export type ReleaseHopResult =
  | { kind: 'redirect'; statusCode: number; location: string }
  | { kind: 'response'; statusCode: number; headers: IncomingMessage['headers']; stream: IncomingMessage };

/**
 * Perform a single HTTP/HTTPS GET hop (without following redirects), supporting
 * HTTP proxy CONNECT tunnelling, NO_PROXY exclusions, and AbortSignal.
 *
 * On 3xx responses with a Location header, the current hop's socket is torn down
 * immediately so a subsequent hop over a CONNECT proxy can establish a fresh
 * TLS handshake cleanly.
 */
export function requestReleaseHop(
  rawUrl: string,
  proxy: string | undefined,
  userAgent: string,
  options: { signal?: AbortSignal; headers?: Record<string, string>; respectNoProxy?: boolean } = {},
): Promise<ReleaseHopResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error('release request aborted'));
      return;
    }
    let target: URL;
    try { target = new URL(rawUrl); } catch { reject(new Error(`URL 非法: ${rawUrl}`)); return; }
    const isHttps = target.protocol === 'https:';

    const handle = (res: IncomingMessage) => {
      const sc = res.statusCode ?? 0;
      if (sc >= 300 && sc < 400 && res.headers.location) {
        // Tear down this hop's connection before following the redirect (see header).
        res.destroy();
        res.socket?.destroy();
        resolve({ kind: 'redirect', statusCode: sc, location: res.headers.location });
        return;
      }
      resolve({ kind: 'response', statusCode: sc, headers: res.headers, stream: res });
    };

    // Re-evaluate exclusions on every redirect target. Keep the original proxy
    // available so a direct mirror can redirect back to an external CDN.
    const hopProxy = options.respectNoProxy ? proxyForUrl(rawUrl, proxy) : proxy;
    let p: URL | undefined;
    if (hopProxy) {
      try { p = new URL(hopProxy); } catch { reject(new Error(`代理地址非法: ${hopProxy}`)); return; }
    }
    const proxyHost = p ? stripHostBrackets(p.hostname) : undefined;
    const proxyPort = p ? Number(p.port || 80) : undefined;
    const proxyAuth = (): Record<string, string> => p?.username
      ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` }
      : {};

    if (p && isHttps) {
      // HTTPS via HTTP proxy: open a CONNECT tunnel, then TLS over the socket.
      const port = target.port || '443';
      const creq = httpRequest({
        host: proxyHost, port: proxyPort, method: 'CONNECT', agent: false,
        signal: options.signal,
        path: `${target.hostname}:${port}`,
        headers: { host: `${target.hostname}:${port}`, ...proxyAuth() },
      });
      creq.on('connect', (cres, socket) => {
        if (cres.statusCode !== 200) { socket.destroy(); reject(new Error(`代理 CONNECT 失败: HTTP ${cres.statusCode}`)); return; }
        if (options.signal?.aborted) { socket.destroy(); reject(options.signal.reason); return; }
        const targetHost = stripHostBrackets(target.hostname);
        // `host` sets the certificate identity even with an existing socket.
        // Without it Node verifies IP targets as localhost when SNI is omitted.
        const tls = tlsConnect({ socket, host: targetHost, ...(isIP(targetHost) ? {} : { servername: targetHost }) }, () => {
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
        host: proxyHost, port: proxyPort, method: 'GET', path: rawUrl,
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

/**
 * GET a URL and resolve with the 200 response stream, following redirects and
 * optionally tunnelling through an HTTP proxy.
 *
 * @param userAgent sent as `user-agent`; callers pass their own tag so server-side
 *                  logs can tell which feature issued the download.
 */
export async function getReleaseStream(
  rawUrl: string,
  proxy: string | undefined,
  userAgent: string,
  redirectsLeft = 5,
  options: { signal?: AbortSignal; headers?: Record<string, string>; respectNoProxy?: boolean } = {},
): Promise<IncomingMessage> {
  const hop = await requestReleaseHop(rawUrl, proxy, userAgent, options);
  if (hop.kind === 'redirect') {
    if (redirectsLeft <= 0) throw new Error('重定向次数过多');
    return getReleaseStream(new URL(hop.location, rawUrl).toString(), proxy, userAgent, redirectsLeft - 1, options);
  }
  if (hop.statusCode !== 200) {
    hop.stream.resume();
    throw new Error(`HTTP ${hop.statusCode}`);
  }
  return hop.stream;
}
