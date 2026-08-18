/**
 * 「打开工作台」入口链接的单一事实源（飞书卡片侧）。
 *
 * 为什么单独一个模块：卡片按钮的链接要同时满足三件事，散落到卡片构建函数里就会
 * 各写各的——
 *   1. **base 跟着 Dashboard 走**：远程访问开 / 自建反代时必须是对外可达的基址，
 *      不能是局域网 `host:port`。这一步复用 {@link buildDashboardUrls}，和
 *      `botmux dashboard`、终端链接、v3 深链共用同一个开关。
 *   2. **凭证是长期 token，链接常驻不过期**（产品决策，见下方小节）。
 *   3. **applink host 跟着 bot 的 brand 走**：飞书 bot → applink.feishu.cn，
 *      Lark bot → applink.larksuite.com（见 im/lark/lark-hosts.ts）。
 *
 * ─── 为什么链接里是长期 token（决策反转，别照 git 历史改回去）──────────────
 * 这里一度是 30 分钟 TTL 的短时票据（P2-1 / commit 9b176a87），理由是「卡片是
 * 持久化载体，长期 token 不该进聊天记录」。**产品 owner 明确推翻了这条红线**：
 * botmux 是自部署形态，用户就是自己实例的 owner，需要一条能收藏进书签、**永不
 * 过期**的入口；短票 30 分钟即死，意味着每次进工作台都得先回飞书发一次
 * `/dashboard`——入口形同虚设。
 *
 * 这是**有意的风险交换**，不是实现疏忽：
 *   · 收益：一条链接收藏即用，跨端、跨重启、跨升级都不失效。
 *   · 代价：链接是常驻凭证，卡片历史 / 转发 / 截图都带着它。
 *   · 兜底：`botmux dashboard rotate` —— 换掉 token，所有已发出的链接当场全废。
 *     卡片小字里就写着这条自救路径，让 owner 知道怀疑泄漏时该做什么。
 *   · **门禁一层没放宽**：`/dashboard` 命令入口仍由
 *     `core/dashboard-command/owner-gate.ts` 拦，卡片回调仍由各 handler 的
 *     invoker-lock + `isDashboardAdmin` 拦，卡片仍是私信给发起人本人。渲染这条
 *     链接的地方必须保持这个前提。
 *
 * 短时票据机制（`dashboard/workbench-ticket.ts`、兑换端点、它的全部测试）
 * **原样保留、不删**：本模块只是不再调用它。将来若要回到短票形态，机制还在。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getBotBrand } from '../bot-registry.js';
import { config, getDashboardExternalHost } from '../config.js';
import { loadPersistedToken } from '../dashboard/auth.js';
import { appCenterAppLink } from '../im/lark/lark-hosts.js';

import { buildDashboardUrls, workbenchEntryUrl, workbenchSpaUrl } from './dashboard-url.js';

/** 解析结果：链接本身 + 它到底带没带凭证（卡片据此决定小字提示的说法）。 */
export interface ResolvedWorkbenchUrl {
  url: string;
  /** true = `<base>/workbench?t=<token>`；false = 无凭证裸链接，用户需自行登录。 */
  credentialed: boolean;
}

/**
 * 当前这台机器的**常驻**工作台入口：`<base>/workbench?t=<长期 token>`。
 *
 * token 读不到时**fail open** 成不带任何凭证的 `<base>/#/agent-workbench`
 * （用户自己走登录墙），而不是不发链接——工作台入口是锦上添花，不能因为读不到
 * 一个文件就让整张 `/dashboard` 卡片发不出去。链接整体不可解析才返回 undefined。
 *
 * ─── token 从哪来（跨进程）────────────────────────────────────────────────
 * 卡片在 **daemon** 进程构建，token 由 **dashboard** 进程落盘在
 * `~/.botmux/.dashboard-token`。两个进程本来就靠这份文件交接：daemon 重启报告的
 * dashboard 链接（daemon.ts:dashboardUrlForReport）走的就是同一条路，短票时代
 * mint 内部算 generation 标签读的也是同一份文件。所以这里直接复用
 * {@link loadPersistedToken}——它走 secure-host-file 的属主 / 0600 / 拒符号链接
 * 校验，形状不安全一律 fail closed 返回 null（→ 降级无凭证链接），不需要另开
 * loopback + HMAC 通道。
 *
 * 端口同理取 dashboard 落盘的 `.dashboard-port`（端口探测可能落在 7891 之外）。
 *
 * 用 `/workbench?t=` 而不是 `/?t=…#/agent-workbench`：不带 `#` 的形态复制粘贴时
 * 不会被截断（见 dashboard-url.ts:workbenchEntryUrl）——这条链接除了当按钮目标，
 * 还会被 owner 从工作台「常驻链接」面板 / 终端 `botmux dashboard` 里复制去收藏。
 */
export function resolveWorkbenchUrl(): ResolvedWorkbenchUrl | undefined {
  try {
    const dir = join(homedir(), '.botmux');
    const portFile = join(dir, '.dashboard-port');
    const port = (existsSync(portFile) ? readFileSync(portFile, 'utf8').trim() : '')
      || String(config.dashboard.port);
    let token: string | null = null;
    try {
      token = loadPersistedToken(join(dir, '.dashboard-token'));
    } catch {
      // 凭证文件形状不安全 / 读失败：降级为无凭证链接，不阻塞卡片发送。
      token = null;
    }
    const { url } = buildDashboardUrls({
      host: getDashboardExternalHost(),
      port,
      token: token ?? undefined,
    });
    if (token) {
      const standing = workbenchEntryUrl(url);
      if (standing) return { url: standing, credentialed: true };
    }
    const bare = workbenchSpaUrl(url);
    return bare ? { url: bare, credentialed: false } : undefined;
  } catch {
    return undefined;
  }
}

/** 「打开工作台」按钮的一组端上目标，undefined 表示不渲染这个按钮。 */
export interface WorkbenchButtonLinks {
  /** PC：appCenter AppLink（在飞书导航栏开标签页，可右键固定 → 真正的常驻入口）。 */
  appLink: string;
  /** 移动端的按钮目标：手机客户端不识别 applink 的 `mode`，直接给网页 URL。
   *  卡片里**不**再单独渲染一行明文链接（产品试用后撤下，见
   *  `im/lark/overview-card.ts` 的「打开工作台」块），所以这条 URL 只出现在按钮
   *  的 `multi_url` 里；owner 想拿链接本体收藏，走工作台 `⋯` 菜单的「常驻链接」
   *  面板或终端 `botmux dashboard` 的输出。 */
  webUrl: string;
  /** 链接是否携带凭证。false 时卡片要注明「需在浏览器里登录」，别吹「常驻可收藏」。 */
  credentialed: boolean;
}

/**
 * PC 走 appCenter AppLink，移动端走裸 URL。brand 按 bot 取，未注册的 appId
 * 归一到 feishu（见 `getBotBrand`）。两端是**同一条常驻链接**，所以同一个管理员
 * 从 PC / 手机点开、或从书签进来，落到的都是同一个入口。
 */
export function resolveWorkbenchButtonLinks(
  larkAppId: string | undefined,
): WorkbenchButtonLinks | undefined {
  const resolved = resolveWorkbenchUrl();
  if (!resolved) return undefined;
  return {
    appLink: appCenterAppLink(resolved.url, getBotBrand(larkAppId)),
    webUrl: resolved.url,
    credentialed: resolved.credentialed,
  };
}
