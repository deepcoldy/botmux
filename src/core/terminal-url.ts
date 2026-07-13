import { config } from '../config.js';
import { platformMachineBaseUrl, publicReverseProxyBaseUrl } from '../platform/binding.js';
import { isRemoteAccessEnabled } from '../global-config.js';

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

export function buildTerminalUrl(ds: TerminalUrlSession, opts: { write?: boolean } = {}): string {
  // When 远程访问 is enabled AND this daemon is bound to the central platform AND
  // the local terminal proxy is up, route terminal links through the machine
  // subdomain (`https://m-<machineId>.<platformHost>/s/<sessionId>`). The platform
  // reverse-proxies that subdomain to this daemon's dashboard, which in turn
  // proxies `/s/*` to the local terminal proxy — so terminals are reachable
  // centrally with no `:port`. Write access there is gated by the platform login
  // (not a URL token), so we deliberately omit `?token=`. When 远程访问 is off the
  // platform base is null and we fall through — first to a self-hosted reverse
  // proxy base (`BOTMUX_PUBLIC_URL`, same front-door `/s/<id>` form but token-
  // bearing since there's no platform SSO), then to the local proxy/worker port.
  if (proxyReady) {
    const platformBase = isRemoteAccessEnabled() ? platformMachineBaseUrl() : null;
    if (platformBase) return `${platformBase}/s/${ds.session.sessionId}`;
    // 自建反代（BOTMUX_PUBLIC_URL）：走 dashboard 前门 `/s/<id>`，无 per-bot 端口、
    // 对所有 bot 通。这里没有平台 SSO 兜底，故写链接必须像本地分支一样保留 token，
    // 否则终端会裸暴露在对外域名上。
    const publicBase = publicReverseProxyBaseUrl();
    if (publicBase) {
      const url = `${publicBase}/s/${ds.session.sessionId}`;
      return opts.write && ds.workerToken ? `${url}?token=${ds.workerToken}` : url;
    }
  }
  const base = proxyReady
    ? `http://${config.web.externalHost}:${getTerminalAdvertisedPort()}/s/${ds.session.sessionId}`
    : `http://${config.web.externalHost}:${ds.workerPort ?? ds.session.webPort}`;
  if (opts.write && ds.workerToken) return `${base}?token=${ds.workerToken}`;
  return base;
}
