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

/** Agent Workbench 在 Dashboard SPA 里的 hash 路由（见 dashboard/web/dashboard-routes.ts）。 */
export const WORKBENCH_HASH_ROUTE = '#/agent-workbench';

/**
 * 把一条 Dashboard 登录 URL（`<base>/?t=<token>`，见 {@link buildDashboardUrls}）
 * 改写成**工作台直达** URL：`<base>/?t=<token>#/agent-workbench`。
 *
 * 用于飞书卡片的「打开工作台」按钮：token 留在查询串里（Dashboard 的鉴权只认
 * `?t=`），hash 只负责选路由，所以两者可以共存。非 http/https 或不可解析的
 * 输入返回 null，调用方据此不渲染按钮，绝不拼出半截链接。
 */
export function workbenchSpaUrl(dashboardUrl: string): string | null {
  const u = parseHttpUrl(dashboardUrl);
  if (!u) return null;
  u.hash = WORKBENCH_HASH_ROUTE;
  return u.toString();
}

/**
 * 无 fragment 的工作台入口：`<base>/workbench?t=<token>`。
 *
 * Dashboard 自己 302 到 `/?t=…#/agent-workbench`（见 dashboard.ts 的 `/workbench`
 * 分支）。终端/脚本里复制粘贴一条不带 `#` 的 URL 更不容易被截断或被 shell 当注释，
 * 所以 CLI 打印这一形态。同样在无法解析时返回 null。
 *
 * ⚠️ 这是**唯一**保留「长期 token 直拼进 URL」的形态，只出现在两个**私人上下文**：
 *   1. `botmux dashboard` 的终端输出（cli/dashboard-command.ts，终端是私人环境）；
 *   2. owner 在工作台里自取常驻链接的响应（`GET /api/workbench/standing-link`，
 *      仅本机完整管理身份可取、同源、`no-store`、每次落审计，见
 *      dashboard/standing-link.ts）。
 * 飞书卡片等**持久化载体**一律走 {@link workbenchTicketRedeemUrl} 的短时票据
 * （P2-1）——长期 token 不进聊天记录这条红线不变。
 */
export function workbenchEntryUrl(dashboardUrl: string): string | null {
  const u = parseHttpUrl(dashboardUrl);
  if (!u) return null;
  u.pathname = '/workbench';
  u.hash = '';
  return u.toString();
}

/**
 * 短时票据兑换入口：`<base>/workbench-ticket/<ticket>`（P2-1）。
 *
 * 飞书卡片「打开工作台」按钮的目标形态：URL 只携带 30 分钟 TTL 的票据，不再
 * 内嵌长期 Dashboard token。Dashboard 验票后按既有 `?t=` 流程种 legacy cookie
 * 并 302 到 `/#/agent-workbench`（见 dashboard/workbench-ticket.ts）。base 沿用
 * {@link buildDashboardUrls} 的远程访问翻转；查询串与 hash 一律清空——票据是
 * 这条 URL 上唯一的凭证性内容。不可解析时返回 null，调用方据此不渲染按钮。
 */
export function workbenchTicketRedeemUrl(dashboardUrl: string, ticket: string): string | null {
  const u = parseHttpUrl(dashboardUrl);
  if (!u || !ticket) return null;
  u.pathname = `/workbench-ticket/${encodeURIComponent(ticket)}`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

function parseHttpUrl(raw: string): URL | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
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
