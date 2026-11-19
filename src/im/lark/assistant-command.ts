/**
 * `/assistant` — 个人助理模式（bot.assistantMode）的归属命令。与 /mention-mode 同形：
 * sessionless、pre-routing，在会话创建之前拦截，所以「群未认领」时也能执行，且不会
 * 预建幽灵会话。
 *
 *   /assistant                 查看本群归属（status）
 *   /assistant claim           认领：本群还没有 owner（或 owner 已退群）时，发命令的人成为 owner
 *   /assistant owner @某人     bot 管理员（canOperate）把本群指定给某人；已有 owner 也能改
 *
 * 不在助理模式的 bot 一律回「未启用」；私聊永远归发消息的人，命令只回状态。
 * 设计见 docs/design/2026-11-20-assistant-mode.md §5.1。
 */
import { isBotMentioned, canOperate, extractMessageTextForRouting } from './event-dispatcher.js';
import { stripLeadingMentions } from './message-parser.js';
import { replyMessage } from './client.js';
import { localeForBot, t } from '../../i18n/index.js';
import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';
import { getSessionGroup } from '../../services/session-groups-store.js';
import { getAssistantOwner, setAssistantOwner } from '../../services/assistant-owner-store.js';
import { isValidAssistantOpenId } from '../../core/assistant-mode.js';
import { logger } from '../../utils/logger.js';

export const ASSISTANT_COMMAND_RE = /^\/assistant(?:\s|$)/i;

export async function tryHandleAssistantCommand(
  larkAppId: string,
  message: any,
  senderOpenId: string | undefined,
  canTalk: boolean,
): Promise<boolean> {
  const rawText = extractMessageTextForRouting(message);
  if (!rawText) return false;
  const text = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
  const match = /^\/assistant(?:\s+(\S+))?(?:\s+(.*))?\s*$/i.exec(text);
  if (!match) return false;

  const isP2p = message.chat_type === 'p2p';
  // 多 bot 群：只有被 @ 的 bot 接这条命令；私聊天然只对着一个 bot。
  if (!isP2p && !isBotMentioned(larkAppId, message, senderOpenId)) return true;
  if (!canTalk) return true;

  const chatId: string | undefined = message.chat_id;
  const messageId: string | undefined = message.message_id;
  const loc = localeForBot(larkAppId);
  const reply = (content: string) => messageId
    ? replyMessage(larkAppId, messageId, content, 'text', false)
        .catch(err => logger.warn(`[assistant] reply failed: ${err?.message ?? err}`))
    : Promise.resolve();
  const sub = (match[1] ?? 'status').toLowerCase();

  let assistantMode = false;
  try { assistantMode = getBot(larkAppId).config.assistantMode === true; } catch { /* unregistered → off */ }
  if (!assistantMode) {
    await reply(t('cmd.assistant.disabled', undefined, loc));
    return true;
  }
  if (isP2p || !chatId) {
    await reply(t('cmd.assistant.p2p', undefined, loc));
    return true;
  }

  const dataDir = config.session.dataDir;
  // 会话群（/group 出生）的归属由 session-groups-store 固定，不走归属表。
  const sgOwner = getSessionGroup(chatId)?.ownerOpenId;
  const current = sgOwner
    ? { openId: sgOwner, fixed: true as const }
    : (() => { const r = getAssistantOwner(dataDir, larkAppId, chatId); return r && !r.left ? { openId: r.openId, fixed: false as const } : undefined; })();

  if (sub === 'status') {
    await reply(current
      ? t('cmd.assistant.status', { owner: `<at user_id="${current.openId}"></at>` }, loc)
      : t('cmd.assistant.unclaimed', undefined, loc));
    return true;
  }

  if (sub === 'claim') {
    if (!isValidAssistantOpenId(senderOpenId)) {
      await reply(t('cmd.assistant.no_sender', undefined, loc));
      return true;
    }
    if (current) {
      await reply(current.openId === senderOpenId
        ? t('cmd.assistant.already_yours', undefined, loc)
        : t('cmd.assistant.already_claimed', { owner: `<at user_id="${current.openId}"></at>` }, loc));
      return true;
    }
    setAssistantOwner(dataDir, larkAppId, chatId, senderOpenId, 'claimed');
    logger.info(`[assistant-mode:${larkAppId}] ${chatId.slice(0, 12)} owner ← ${senderOpenId.slice(0, 12)}… (claimed)`);
    await reply(t('cmd.assistant.claimed', { owner: `<at user_id="${senderOpenId}"></at>` }, loc));
    return true;
  }

  if (sub === 'owner') {
    if (!canOperate(larkAppId, chatId, senderOpenId)) {
      await reply(t('cmd.assistant.admin_only', undefined, loc));
      return true;
    }
    if (current?.fixed) {
      await reply(t('cmd.assistant.session_group_fixed', undefined, loc));
      return true;
    }
    // 目标只认 @ 出来的真人（open_id 形状过滤掉 bot 的 app_id 形式 @）。
    const targets = ((message?.mentions ?? []) as Array<{ openId?: string }>)
      .map(m => m.openId)
      .filter((v): v is string => isValidAssistantOpenId(v));
    const target = targets.find(v => v !== senderOpenId) ?? targets[0];
    if (!target || targets.length !== 1 && !targets.every(v => v === target)) {
      await reply(t('cmd.assistant.owner_usage', undefined, loc));
      return true;
    }
    setAssistantOwner(dataDir, larkAppId, chatId, target, 'admin');
    logger.info(`[assistant-mode:${larkAppId}] ${chatId.slice(0, 12)} owner ← ${target.slice(0, 12)}… (admin ${senderOpenId?.slice(0, 12)})`);
    await reply(t('cmd.assistant.owner_set', { owner: `<at user_id="${target}"></at>` }, loc));
    return true;
  }

  await reply(t('cmd.assistant.usage', undefined, loc));
  return true;
}
