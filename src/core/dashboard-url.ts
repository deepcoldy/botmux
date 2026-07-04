import { platformMachineBaseUrl } from '../platform/binding.js';
import { isRemoteAccessEnabled } from '../global-config.js';

/**
 * Builds the public URL for the web dashboard, given a token.
 *
 * When 远程访问 is enabled AND this machine is bound to the central platform, the
 * URL routes through the machine subdomain
 * (`https://m-<machineId>.<platformHost>/?t=<token>`): the platform
 * reverse-proxies that subdomain to this host's local dashboard, which still
 * enforces the `?t=` token itself, so the link is reachable centrally with no
 * `:port`. When 远程访问 is off (or the machine isn't bound) the platform base is
 * null and we fall back to the local `http://<externalHost>:<port>/` form.
 *
 * Mirrors buildTerminalUrl (terminal-url.ts) and publicWebhookUrl
 * (dashboard/connector-api.ts) so dashboard, terminal, and webhook links all
 * flip to the platform together under the single 远程访问 switch — instead of the
 * dashboard link being the one place that always stays local.
 */
export function buildDashboardUrl(opts: { host: string; port: number | string; token?: string }): string {
  const platformBase = isRemoteAccessEnabled() ? platformMachineBaseUrl() : null;
  const origin = platformBase ?? `http://${opts.host}:${opts.port}`;
  return opts.token ? `${origin}/?t=${opts.token}` : `${origin}/`;
}
