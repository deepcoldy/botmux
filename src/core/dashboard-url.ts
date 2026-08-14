import {
  platformMachineBaseUrl,
  publicReverseProxyBaseUrl,
  readPlatformBinding,
} from '../platform/binding.js';
import { isRemoteAccessEnabled } from '../global-config.js';

export interface DashboardUrls {
  /**
   * The link to show first: the central-platform machine subdomain when 远程访问
   * is on and this host is bound, otherwise the local `http://<host>:<port>/`.
   */
  url: string;
  /**
   * The local `http://<host>:<port>/` direct link — populated ONLY when `url`
   * routes through the central platform (i.e. differs from the local form).
   * It's the escape hatch to reach the dashboard directly when the platform is
   * down. When `url` is already local this is undefined (nothing to add).
   */
  localUrl?: string;
}

/**
 * Format a host for use inside a URL. An IPv6 literal (contains ':', e.g. `::1`)
 * must be wrapped in brackets or `http://::1:7891/` is an invalid URL. IPv4,
 * hostnames, and already-bracketed literals pass through unchanged.
 */
export function formatUrlHost(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

/**
 * Builds the dashboard URL(s) for a token.
 *
 * When 远程访问 is enabled AND this machine is bound to the central platform, the
 * primary `url` routes through the machine subdomain
 * (`https://m-<machineId>.<platformHost>/?t=<token>`): the platform
 * reverse-proxies that subdomain to this host's local dashboard, which still
 * enforces the `?t=` token itself, so the link is reachable centrally with no
 * `:port`. Failing that, if `BOTMUX_PUBLIC_URL` is set (self-hosted reverse
 * proxy in front of the dashboard, e.g. nginx), the primary `url` uses that base
 * — same no-`:port` form, token still enforced. In either remote case `localUrl`
 * additionally carries the local `http://<externalHost>:<port>/?t=<token>` form
 * so callers can advertise a direct fallback. When neither applies the primary
 * `url` is already the local form and `localUrl` is left undefined.
 *
 * Mirrors buildTerminalUrl (terminal-url.ts) and publicWebhookUrl
 * (dashboard/connector-api.ts) so dashboard, terminal, and webhook links all
 * flip to the platform together under the single 远程访问 switch — instead of the
 * dashboard link being the one place that always stays local.
 */
export function buildDashboardUrls(opts: { host: string; port: number | string; token?: string }): DashboardUrls {
  const localOrigin = `http://${formatUrlHost(String(opts.host))}:${opts.port}`;
  const remoteBase = remotePublicBase();
  const primaryOrigin = remoteBase ?? localOrigin;
  const suffix = opts.token ? `/?t=${opts.token}` : '/';
  return {
    url: `${primaryOrigin}${suffix}`,
    localUrl: remoteBase ? `${localOrigin}${suffix}` : undefined,
  };
}

/** Convenience: just the primary dashboard URL (see {@link buildDashboardUrls}). */
export function buildDashboardUrl(opts: { host: string; port: number | string; token?: string }): string {
  return buildDashboardUrls(opts).url;
}

/**
 * The remote public base for dashboard-family links, or null when neither the
 * central platform (远程访问 on + bound) nor a self-hosted reverse proxy
 * (`BOTMUX_PUBLIC_URL`) applies — callers then fall back to local `host:port`.
 * Single source for the platform/public flip shared by {@link buildDashboardUrls}
 * and {@link buildV3RunDetailUrl}, so dashboard links and v3 card deep-links
 * flip to the platform together under the one 远程访问 switch.
 *
 * 对外基址：中心平台优先（远程访问开 + 已绑定），否则自建反代基址 BOTMUX_PUBLIC_URL。
 */
function remotePublicBase(): string | null {
  const platformBase = isRemoteAccessEnabled() ? platformMachineBaseUrl() : null;
  return platformBase ?? publicReverseProxyBaseUrl();
}

/**
 * Build the token-free deep link to a v3 run detail page (`…/#/v3/<runId>`),
 * applying the same 远程访问 flip as {@link buildDashboardUrls}: central-platform
 * machine subdomain first (远程访问 on + bound), then a self-hosted reverse proxy
 * (`BOTMUX_PUBLIC_URL`), else the local `http://<externalHost>:<port>` form.
 *
 * Workflow / gate / blocked cards advertise this as「Web 详情（需登录）」. Routing it
 * through the platform base is what lets a REMOTE recipient actually reach the
 * SPA: the page then hits the same-origin management API, gets a 401 carrying
 * `X-Botmux-Login-Url`, and offers the one-click platform owner login (see
 * {@link buildPlatformDashboardLoginUrl}). The prior local-only form was
 * unreachable off-LAN, so that login flow could never trigger for remote users.
 *
 * No token is appended: v3 run projections stay behind the dashboard auth gate
 * and are reached only after the owner login sets the cookie. `runId` is
 * URL-encoded.
 */
export function buildV3RunDetailUrl(runId: string, opts: { host: string; port: number | string }): string {
  const origin = remotePublicBase() ?? `http://${formatUrlHost(String(opts.host))}:${opts.port}`;
  return `${origin}/#/v3/${encodeURIComponent(runId)}`;
}

/**
 * Build a deep link to a v3 run's live terminal page (the mobile-friendly
 * `getTerminalHtml` view), used by the progress card's「终端」button.
 *
 * On the central HTTPS platform the same-origin `/s/<sessionId>` reverse proxy
 * reaches the worker; on a self-hosted LAN box the worker's own `webPort` is
 * used directly (mirrors `buildSessionTerminalUrl`). Returns null when no
 * reachable URL can be built (no webPort in LAN mode).
 */
export function buildV3TerminalUrl(
  sessionId: string,
  opts: { host: string; webPort?: number },
): string | null {
  const base = remotePublicBase();
  if (base) return `${base}/s/${encodeURIComponent(sessionId)}`;
  if (!opts.webPort || opts.webPort <= 0) return null;
  return `http://${formatUrlHost(String(opts.host))}:${opts.webPort}`;
}

/**
 * Build the platform owner-login URL advertised by an unauthenticated
 * Dashboard response. The SPA replaces only the hash-route `next` value, so
 * the server never exposes the Dashboard token or machine tunnel credential.
 */
export function buildPlatformDashboardLoginUrl(): string | undefined {
  if (!isRemoteAccessEnabled()) return undefined;
  const binding = readPlatformBinding();
  const machineId = binding?.machineId.trim();
  if (!binding || !machineId) return undefined;
  try {
    const platform = new URL(binding.platformUrl);
    if (!['http:', 'https:'].includes(platform.protocol) || platform.username || platform.password) {
      return undefined;
    }
    const loginUrl = new URL(`/open/${encodeURIComponent(machineId)}`, platform);
    loginUrl.searchParams.set('next', '/#/');
    return loginUrl.toString();
  } catch {
    return undefined;
  }
}
