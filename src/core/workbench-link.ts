/**
 * 「打开工作台」入口链接的单一事实源（飞书卡片侧）。
 *
 * 为什么单独一个模块：卡片按钮的链接要同时满足三件事，散落到卡片构建函数里就会
 * 各写各的——
 *   1. **base 跟着 Dashboard 走**：远程访问开 / 自建反代时必须是对外可达的基址，
 *      不能是局域网 `host:port`。这一步复用 {@link buildDashboardUrls}，和
 *      `botmux dashboard`、终端链接、v3 深链共用同一个开关。
 *   2. **凭证是短时票据，不是长期 token（P2-1）**：卡片是持久化载体——卡片历史、
 *      转发、截图都带着链接活得比首次投递久得多，所以链接里只放 30 分钟 TTL 的
 *      兑换票据（每次构建卡片现 mint，见 dashboard/workbench-ticket.ts），
 *      Dashboard 验票后才种 legacy cookie。长期 `.dashboard-token` 直拼 URL 的
 *      形态只保留给 `botmux dashboard` 的**终端输出**（cli/dashboard-command.ts
 *      经 workbenchEntryUrl 拼，终端是私人环境）；本模块不再读那份文件。
 *      （P1-6 起 mint 内部会读一次 `.dashboard-token` 算 generation 标签，把票据
 *      钉在「发票那一刻的那份 token」上——rotate 之后旧票立刻作废。token 明文
 *      既不进链接也不进票据文件，只有它的 hash 标签进。）
 *   3. **applink host 跟着 bot 的 brand 走**：飞书 bot → applink.feishu.cn，
 *      Lark bot → applink.larksuite.com（见 im/lark/lark-hosts.ts）。
 *
 * 安全边界：mint 出的票据在 TTL 内可兑换出 Dashboard 管理 cookie，所以调用方必须
 * 自己保证只在过了权限门禁的回复里渲染它——`/dashboard` 的门禁在
 * `core/dashboard-command/owner-gate.ts`，卡片回调的门禁在各 card handler 的
 * invoker-lock + `isDashboardAdmin`。票据到期后卡片历史/转发/截图里的链接自动作废，
 * 这正是它对长期 token 的改进，但**发出前**的门禁一层都不能放宽。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getBotBrand } from '../bot-registry.js';
import { config, getDashboardExternalHost } from '../config.js';
import { mintWorkbenchTicket } from '../dashboard/workbench-ticket.js';
import { appCenterAppLink } from '../im/lark/lark-hosts.js';

import { buildDashboardUrls, workbenchSpaUrl, workbenchTicketRedeemUrl } from './dashboard-url.js';

/**
 * 当前这台机器的工作台入口 URL：`<base>/workbench-ticket/<现 mint 的票据>`；
 * 票据落盘失败时退化为不带任何凭证的 `<base>/#/agent-workbench`（用户自己登录），
 * 链接整体不可解析时返回 undefined。
 *
 * 端口取 dashboard 进程落盘的 `.dashboard-port`（它可能因为端口探测落在 7891 之外），
 * 与 daemon 重启报告里的链接同源。任何 I/O 异常都吞掉——工作台入口是锦上添花，
 * 不能因为读不到一个文件就让整张 `/dashboard` 卡片发不出去。
 */
export function resolveWorkbenchUrl(): string | undefined {
  try {
    const dir = join(homedir(), '.botmux');
    const portFile = join(dir, '.dashboard-port');
    const port = (existsSync(portFile) ? readFileSync(portFile, 'utf8').trim() : '')
      || String(config.dashboard.port);
    const { url } = buildDashboardUrls({
      host: getDashboardExternalHost(),
      port,
    });
    let ticket: string | undefined;
    try {
      ticket = mintWorkbenchTicket();
    } catch {
      // 票据写不进 ~/.botmux、或者读不出当前 token 的 generation（目录形状不安全
      // 等）：dashboard 侧必然验不了票，与其发一个注定失败的死链，不如退回无凭证
      // 链接让用户走登录墙。
      ticket = undefined;
    }
    if (!ticket) return workbenchSpaUrl(url) ?? undefined;
    return workbenchTicketRedeemUrl(url, ticket) ?? undefined;
  } catch {
    return undefined;
  }
}

/** 「打开工作台」按钮的一组端上目标，undefined 表示不渲染这个按钮。 */
export interface WorkbenchButtonLinks {
  /** PC：appCenter AppLink（可右键固定到侧边栏）。 */
  appLink: string;
  /** 移动端：直接开网页。手机客户端没有 appCenter 标签页容器，走 AppLink 只会绕一圈。 */
  webUrl: string;
}

/**
 * PC 走 appCenter AppLink，移动端走裸 URL。brand 按 bot 取，未注册的 appId
 * 归一到 feishu（见 `getBotBrand`）。两端共享同一张票据：同一个管理员从 PC /
 * 手机多端点开同一张卡片都能兑换（票据非一次性，到期即死）。
 */
export function resolveWorkbenchButtonLinks(
  larkAppId: string | undefined,
): WorkbenchButtonLinks | undefined {
  const webUrl = resolveWorkbenchUrl();
  if (!webUrl) return undefined;
  return { appLink: appCenterAppLink(webUrl, getBotBrand(larkAppId)), webUrl };
}
