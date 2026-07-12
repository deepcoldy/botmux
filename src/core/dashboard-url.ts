import { platformMachineBaseUrl, publicReverseProxyBaseUrl } from '../platform/binding.js';
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
  const localOrigin = `http://${opts.host}:${opts.port}`;
  // 对外基址：中心平台优先（远程访问开 + 已绑定），否则自建反代基址 BOTMUX_PUBLIC_URL。
  const platformBase = isRemoteAccessEnabled() ? platformMachineBaseUrl() : null;
  const remoteBase = platformBase ?? publicReverseProxyBaseUrl();
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
