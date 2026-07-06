import { platformMachineBaseUrl } from '../platform/binding.js';
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
 * `:port`. In that case `localUrl` additionally carries the local
 * `http://<externalHost>:<port>/?t=<token>` form so callers can advertise a
 * direct fallback for when the platform is unreachable. When 远程访问 is off (or
 * the machine isn't bound) the primary `url` is already the local form and
 * `localUrl` is left undefined.
 *
 * Mirrors buildTerminalUrl (terminal-url.ts) and publicWebhookUrl
 * (dashboard/connector-api.ts) so dashboard, terminal, and webhook links all
 * flip to the platform together under the single 远程访问 switch — instead of the
 * dashboard link being the one place that always stays local.
 */
export function buildDashboardUrls(opts: { host: string; port: number | string; token?: string }): DashboardUrls {
  const localOrigin = `http://${opts.host}:${opts.port}`;
  const platformBase = isRemoteAccessEnabled() ? platformMachineBaseUrl() : null;
  const primaryOrigin = platformBase ?? localOrigin;
  const suffix = opts.token ? `/?t=${opts.token}` : '/';
  return {
    url: `${primaryOrigin}${suffix}`,
    localUrl: platformBase ? `${localOrigin}${suffix}` : undefined,
  };
}

/** Convenience: just the primary dashboard URL (see {@link buildDashboardUrls}). */
export function buildDashboardUrl(opts: { host: string; port: number | string; token?: string }): string {
  return buildDashboardUrls(opts).url;
}
