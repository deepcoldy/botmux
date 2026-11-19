/**
 * `/dashboard link`（及裸 `/dash` 别名）：daemon 直接返回当前 Dashboard 管理首页链接。
 *
 * 安全边界：
 *  - 入口在 {@link ./index.js} 的管理员闸之后，未授权调用拿不到这里的任何信息。
 *  - 链接携带长期管理员 token，只走私人通道：p2p 直接回在私聊里；普通群优先发
 *    requester-only ephemeral 临时卡，话题群 / 话题回复（ephemeral API 不支持）或
 *    ephemeral 失败时改私信；两条私人通道都失败时只回不含链接的错误，绝不在群里
 *    公开带 token 的链接。
 *  - 审计日志固定打码 token（{@link maskDashboardToken}）。
 *
 * 链接每次现读：端口取 dashboard 实际绑定后落盘的 `~/.botmux/.dashboard-port`
 * （EADDRINUSE 探测可能落在配置端口之外），token 取当前 `~/.botmux/.dashboard-token`
 * （轮换写文件后这里立刻读到新值）。
 *
 * 链接基址**只**由 dashboard 家族唯一事实源 {@link buildDashboardUrls} 给出，本文件
 * 不自己拼 host/协议：远程访问开启且绑定中心平台时主链接翻成平台机子域（平台注入
 * 身份，`?t=` 在该链路上无效，按 {@link reportDashboardUrls} 摘掉）；配了
 * `BOTMUX_PUBLIC_URL` 反代时主链接走反代基址（无人注入身份，token 保留）；两者都没
 * 有时才是本地 `http://<host>:<port>`。host 走 {@link getDashboardExternalHost}：
 * BOTMUX_DASHBOARD_EXTERNAL_HOST 优先，其次非通配监听地址，最后局域网 IP；主链接是
 * loopback 本机形态时照旧给出但附带本机可达提示，不伪造公网地址。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { config, getDashboardExternalHost } from '../../config.js';
import { localeForBot, t } from '../../i18n/index.js';
import {
  getChatMode as defaultGetChatMode,
  sendEphemeralCard as defaultSendEphemeralCard,
  sendUserMessage as defaultSendUserMessage,
} from '../../im/lark/client.js';
import { cardHeaderTemplateFirst, larkMdDiv, wideCard } from '../../im/lark/card-primitives.js';
import type { LarkMessage } from '../../types.js';
import { loadPersistedToken } from '../../dashboard/auth.js';
import { buildDashboardUrls, reportDashboardUrls, type DashboardUrls } from '../dashboard-url.js';
import { logger } from '../../utils/logger.js';

export interface DashboardAdminLink {
  /** 管理首页完整链接；平台托管时不含 `?t=`（见 {@link platformHosted}）。 */
  url: string;
  host: string;
  port: number;
  /** 主链接是 loopback 本机形态时为 true —— 只能在运行 Dashboard 的机器本机打开。 */
  loopbackOnly: boolean;
  /**
   * 主链接走中心平台机子域：平台在边缘注入身份，链接里的 `?t=` 无效且不应进入聊天
   * 记录，因此 url 已摘掉 token。false 时（本地直连 / `BOTMUX_PUBLIC_URL` 反代）url
   * 仍带 token——反代不注入身份，token 是唯一凭证。
   */
  platformHosted: boolean;
}

export type ResolveDashboardLinkResult =
  | { ok: true; link: DashboardAdminLink }
  | { ok: false; reason: 'token_unavailable' | 'url_unavailable' };

/** resolveDashboardAdminLink 的测试注入缝；生产路径省略后走文件 / 配置默认值。 */
export interface DashboardLinkResolveSeams {
  host?: string;
  readPortFile?: () => string | null;
  readTokenFile?: () => string | null;
  /** 覆盖 dashboard 链接事实源（测试用来造平台托管 / 反代形态）。 */
  buildUrls?: (opts: { host: string; port: number; token: string }) => DashboardUrls;
}

/** 测试注入缝；生产路径省略后走文件 / 配置默认值。 */
export interface DashboardLinkSeams {
  resolveLink?: () => ResolveDashboardLinkResult;
  sendUserMessage?: (larkAppId: string, openId: string, content: string, msgType?: string) => Promise<string>;
  sendEphemeralCard?: (larkAppId: string, chatId: string, openId: string, cardJson: string) => Promise<string>;
  getChatMode?: (larkAppId: string, chatId: string) => Promise<'group' | 'topic' | 'p2p'>;
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h.startsWith('127.') || h === '::1' || h === '[::1]';
}

/** 审计日志用：只保留 token 前 4 位，永不打印完整凭证（短于 4 位全部打码）。 */
export function maskDashboardToken(token: string | null | undefined): string {
  if (!token) return '(none)';
  return token.length <= 4 ? '****' : `${token.slice(0, 4)}***`;
}

function maskTokenInUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has('t')) u.searchParams.set('t', maskDashboardToken(u.searchParams.get('t')));
    return u.toString();
  } catch {
    return '(unparseable-url)';
  }
}

/**
 * 现读当前 Dashboard 管理首页信息。端口 / token 都不缓存：dashboard 探测换端口、
 * `botmux dashboard rotate` 换 token 后，下一次调用立刻反映。
 */
export function resolveDashboardAdminLink(seams: DashboardLinkResolveSeams = {}): ResolveDashboardLinkResult {
  const botmuxDir = join(homedir(), '.botmux');
  const readPortFile = seams.readPortFile ?? (() => {
    try {
      const p = join(botmuxDir, '.dashboard-port');
      return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
    } catch {
      return null;
    }
  });
  const readTokenFile = seams.readTokenFile ?? (() => {
    try {
      return loadPersistedToken(join(botmuxDir, '.dashboard-token'));
    } catch {
      return null;
    }
  });

  const token = readTokenFile()?.trim() || null;
  if (!token) return { ok: false, reason: 'token_unavailable' };

  const port = Number(readPortFile()) || config.dashboard.port;
  const host = seams.host ?? getDashboardExternalHost();
  // 链接基址必须走 buildDashboardUrls：平台托管 / 自建反代场景下自己拼 LAN:port
  // 会给出远程根本打不开的链接（手机点飞书消息是本命令核心场景）。
  const urls = (seams.buildUrls ?? buildDashboardUrls)({ host, port, token });
  // 平台托管摘 token（身份由平台注入）；反代/本地形态原样保留。
  const reported = reportDashboardUrls(urls);
  let primary: URL;
  try {
    primary = new URL(reported.url);
  } catch {
    return { ok: false, reason: 'url_unavailable' };
  }
  primary.hash = '/'; // 管理首页，不是 workbench 等子路由。
  return {
    ok: true,
    link: {
      url: primary.toString(),
      host,
      port,
      loopbackOnly: !urls.platformHosted && isLoopbackHost(primary.hostname),
      platformHosted: urls.platformHosted,
    },
  };
}

export type DashboardLinkChannel = 'p2p' | 'ephemeral' | 'dm' | 'failed' | 'unavailable';

function linkCardJson(title: string, body: string): string {
  return JSON.stringify(wideCard({
    header: cardHeaderTemplateFirst('blue', title),
    elements: [larkMdDiv(body)],
  }));
}

/**
 * 把管理首页链接通过私人通道投递给请求的管理员。返回实际使用的通道；
 * `failed` / `unavailable` 时群里只会出现不含 token 的提示。
 */
export async function deliverDashboardAdminLink(opts: {
  larkAppId: string;
  message: LarkMessage;
  rootId: string;
  adminOpenId: string;
  reply: (content: string, msgType?: 'text' | 'interactive') => Promise<unknown>;
  seams?: DashboardLinkSeams;
}): Promise<DashboardLinkChannel> {
  const { larkAppId, message, adminOpenId, reply, seams = {} } = opts;
  const loc = localeForBot(larkAppId);
  const sendUserMessage = seams.sendUserMessage ?? defaultSendUserMessage;
  const sendEphemeralCard = seams.sendEphemeralCard ?? defaultSendEphemeralCard;
  const getChatMode = seams.getChatMode ?? defaultGetChatMode;

  const resolved = (seams.resolveLink ?? resolveDashboardAdminLink)();
  if (!resolved.ok) {
    logger.warn(`[dashboard-link] unavailable admin=${adminOpenId.substring(0, 8)}… reason=${resolved.reason}`);
    await reply(t('card.dashboard.link.unavailable', undefined, loc));
    return 'unavailable';
  }
  const { link } = resolved;
  const body = t('card.dashboard.link.body', { url: link.url }, loc)
    + (link.loopbackOnly ? `\n\n${t('card.dashboard.link.loopback_hint', undefined, loc)}` : '');
  const audit = (channel: string) => logger.info(
    `[dashboard-link] admin=${adminOpenId.substring(0, 8)}… chatType=${message.chatType ?? '?'} `
    + `channel=${channel} port=${link.port} loopbackOnly=${link.loopbackOnly} link=${maskTokenInUrl(link.url)}`,
  );

  // p2p 本身就是私聊，直接回复。
  if (message.chatType === 'p2p') {
    await reply(body);
    audit('p2p');
    return 'p2p';
  }

  // 话题回复不能用 ephemeral（只支持普通群）；话题群（chat_mode=topic）整群也是
  // thread 型，ephemeral 会被 18053 拒、或被静默收下却不渲染 —— 这两种形态都直接走
  // 私信。普通群顶层才尝试 ephemeral 临时卡，失败再 fail over 到私信。
  let ephemeralCapable = false;
  if (!message.threadId) {
    try {
      ephemeralCapable = (await getChatMode(larkAppId, message.chatId ?? '')) !== 'topic';
    } catch (err) {
      // 群形态确认失败时按「不支持 ephemeral」处理：私信同样是私人通道，直接走它。
      logger.info(`[dashboard-link] chat mode unconfirmed (${(err as Error)?.message ?? err}); delivering via DM`);
    }
  }
  if (ephemeralCapable) {
    try {
      await sendEphemeralCard(
        larkAppId,
        message.chatId ?? '',
        adminOpenId,
        linkCardJson(t('card.dashboard.link.title', undefined, loc), body),
      );
      audit('ephemeral');
      return 'ephemeral';
    } catch (err) {
      logger.info(`[dashboard-link] ephemeral unavailable (${(err as Error)?.message ?? err}); delivering via DM`);
    }
  }

  try {
    await sendUserMessage(larkAppId, adminOpenId, body, 'text');
    await reply(t('card.dashboard.link.dm_sent', undefined, loc));
    audit('dm');
    return 'dm';
  } catch (err) {
    // 私密通道全部失败：只报错，绝不把带 token 的链接降级发到多人群。
    logger.error(`[dashboard-link] private delivery failed for ${adminOpenId.substring(0, 8)}…: ${(err as Error)?.message ?? err}`);
    await reply(t('card.dashboard.link.delivery_failed', undefined, loc));
    return 'failed';
  }
}
