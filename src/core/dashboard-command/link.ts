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
 * （轮换写文件后这里立刻读到新值），host 走 {@link getDashboardExternalHost}：
 * BOTMUX_DASHBOARD_EXTERNAL_HOST 优先，其次非通配监听地址，最后局域网 IP；仅监听
 * loopback 时链接照旧给出但附带本机可达提示，不伪造公网地址。
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
import { formatUrlHost } from '../dashboard-url.js';
import { logger } from '../../utils/logger.js';

export interface DashboardAdminLink {
  /** 管理首页完整链接：`http://<host>:<port>/?t=<token>#/`。 */
  url: string;
  host: string;
  port: number;
  /** host 是 loopback 时为 true —— 链接只能在运行 Dashboard 的机器本机打开。 */
  loopbackOnly: boolean;
}

export type ResolveDashboardLinkResult =
  | { ok: true; link: DashboardAdminLink }
  | { ok: false; reason: 'token_unavailable' };

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
    u.searchParams.set('t', maskDashboardToken(u.searchParams.get('t')));
    return u.toString();
  } catch {
    return '(unparseable-url)';
  }
}

/**
 * 现读当前 Dashboard 管理首页信息。端口 / token 都不缓存：dashboard 探测换端口、
 * `botmux dashboard rotate` 换 token 后，下一次调用立刻反映。
 */
export function resolveDashboardAdminLink(seams: {
  host?: string;
  readPortFile?: () => string | null;
  readTokenFile?: () => string | null;
} = {}): ResolveDashboardLinkResult {
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
  const url = `http://${formatUrlHost(host)}:${port}/?t=${encodeURIComponent(token)}#/`;
  return { ok: true, link: { url, host, port, loopbackOnly: isLoopbackHost(host) } };
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
