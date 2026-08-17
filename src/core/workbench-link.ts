/**
 * 「打开工作台」入口链接的单一事实源（飞书卡片侧）。
 *
 * 为什么单独一个模块：卡片按钮的链接要同时满足三件事，散落到卡片构建函数里就会
 * 各写各的——
 *   1. **base 跟着 Dashboard 走**：远程访问开 / 自建反代时必须是对外可达的基址，
 *      不能是局域网 `host:port`。这一步复用 {@link buildDashboardUrls}，和
 *      `botmux dashboard`、终端链接、v3 深链共用同一个开关。
 *   2. **token 跟着 Dashboard 进程走**：token 由 dashboard 进程写在
 *      `~/.botmux/.dashboard-token`，daemon 只读不写（读不到就退化成不带 token 的
 *      链接，让用户自己登录，而不是在这里凭空 mint 一个新 token）。
 *   3. **applink host 跟着 bot 的 brand 走**：飞书 bot → applink.feishu.cn，
 *      Lark bot → applink.larksuite.com（见 im/lark/lark-hosts.ts）。
 *
 * 安全边界：这里只是**拼链接**，不做任何权限判断。带 token 的链接等价于 Dashboard
 * 凭证，所以调用方必须自己保证只在过了权限门禁的回复里渲染它——`/dashboard` 的门禁
 * 在 `core/dashboard-command/owner-gate.ts`，卡片回调的门禁在各 card handler 的
 * invoker-lock + `isDashboardAdmin`。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getBotBrand } from '../bot-registry.js';
import { config, getDashboardExternalHost } from '../config.js';
import { loadPersistedToken } from '../dashboard/auth.js';
import { appCenterAppLink } from '../im/lark/lark-hosts.js';

import { buildDashboardUrls, workbenchSpaUrl } from './dashboard-url.js';

/**
 * 当前这台机器的工作台直达 URL（`<base>/?t=<token>#/agent-workbench`），
 * 读不到 dashboard 端口/token 或链接不可解析时返回 undefined。
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
    const token = loadPersistedToken(join(dir, '.dashboard-token')) ?? '';
    const { url } = buildDashboardUrls({
      host: getDashboardExternalHost(),
      port,
      token: token || undefined,
    });
    return workbenchSpaUrl(url) ?? undefined;
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
 * 归一到 feishu（见 `getBotBrand`）。
 */
export function resolveWorkbenchButtonLinks(
  larkAppId: string | undefined,
): WorkbenchButtonLinks | undefined {
  const webUrl = resolveWorkbenchUrl();
  if (!webUrl) return undefined;
  return { appLink: appCenterAppLink(webUrl, getBotBrand(larkAppId)), webUrl };
}
