import { config } from '../config.js';

/**
 * Builds the public URL for a session's web terminal. When the per-daemon
 * reverse proxy (terminal-proxy.ts) is up, URLs go through it under
 * `/s/{sessionId}` so users only forward one port. If the proxy failed to bind,
 * we fall back to the worker's own port so links never go dead — the proxy is
 * an enhancement, not a hard dependency. externalHost is read live (not
 * snapshotted) so cards stay correct across network changes.
 *
 * When WEB_EXTERNAL_PORT is configured the proxy-mode link advertises that port
 * (set via setTerminalExternalPort) instead of the local proxy port, so a relay
 * host can front the terminal on a different port number. It only applies in
 * proxy mode — the single fronting port maps cleanly to one external port; the
 * direct fallback uses per-session worker ports that one external port can't
 * represent, so the override is ignored there.
 */

interface TerminalUrlSession {
  session: { sessionId: string; webPort?: number | null };
  workerPort: number | null;
  workerToken: string | null;
}

let proxyPort = 0;
let proxyReady = false;
// Port advertised in proxy-mode links, overriding the local proxy port.
// 0 = unset → advertise the local proxy port. Set from WEB_EXTERNAL_PORT +
// botIndex so a relay can front the terminal on a different port number.
let externalPort = 0;

/** Marks the proxy live on `port`. Called only after a successful bind. */
export function setTerminalProxyPort(port: number): void {
  proxyPort = port;
  proxyReady = true;
}

/** Override the port shown in proxy-mode links (WEB_EXTERNAL_PORT + botIndex).
 *  0 reverts to advertising the local proxy port. */
export function setTerminalExternalPort(port: number): void {
  externalPort = port;
}

/** Bound proxy port, or 0 when the proxy is not available. */
export function getTerminalProxyPort(): number {
  return proxyReady ? proxyPort : 0;
}

/** Port clients should use to reach the proxy: the configured external port
 *  (WEB_EXTERNAL_PORT + botIndex) when set, else the bound proxy port; 0 when
 *  the proxy isn't up. Single source of truth for the proxy-mode port that both
 *  buildTerminalUrl (card links) and the dashboard rows advertise, so they agree
 *  on the same external port instead of diverging. */
export function getTerminalAdvertisedPort(): number {
  return proxyReady ? externalPort || proxyPort : 0;
}

/** Test/edge helper: revert to the no-proxy (direct-port) state. */
export function resetTerminalProxy(): void {
  proxyPort = 0;
  proxyReady = false;
  externalPort = 0;
}

/**
 * Returns true when the externalHost looks like an IP address (IPv4 or IPv6)
 * that needs a port appended. Domain names behind reverse-proxies or tunnels
 * (e.g. cpolar, nginx) serve on standard ports (80/443) so the port is omitted.
 */
function hostLooksLikeIp(host: string): boolean {
  // IPv4: 1.2.3.4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // IPv6: [::1], [fe80::1], etc.
  if (host.startsWith('[') && host.endsWith(']')) return true;
  // Bare IPv6 (uncommon but valid in some contexts)
  if (/^[0-9a-fA-F:]+$/.test(host) && host.includes(':')) return true;
  return false;
}

export function buildTerminalUrl(ds: TerminalUrlSession, opts: { write?: boolean } = {}): string {
  const host = config.web.externalHost;
  const hostAndPort = hostLooksLikeIp(host)
    ? `${host}:${getTerminalAdvertisedPort()}`
    : host;
  const base = proxyReady
    ? `http://${hostAndPort}/s/${ds.session.sessionId}`
    : `http://${host}:${ds.workerPort ?? ds.session.webPort}`;
  if (opts.write && ds.workerToken) return `${base}?token=${ds.workerToken}`;
  return base;
}
