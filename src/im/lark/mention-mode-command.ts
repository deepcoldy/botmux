/**
 * `/mention-mode` is a sessionless, pre-routing command — same shape as
 * /reply-mode: per-chat @-requirement policy for regular groups, layered over
 * the per-bot `regularGroupMentionMode` default. Status is canTalk while
 * mutations stay canOperate, and toggling the group setting never creates a
 * phantom session.
 */
import { isBotMentioned, canOperate, extractMessageTextForRouting } from './event-dispatcher.js';
import { stripLeadingMentions } from './message-parser.js';
import { getChatMode, replyMessage } from './client.js';
import { localeForBot, t } from '../../i18n/index.js';
import { normalizeGroupMentionMode, resolveGroupMentionMode, setChatMentionMode } from '../../services/chat-reply-mode-store.js';
import { isSessionGroup } from '../../services/session-groups-store.js';
import { logger } from '../../utils/logger.js';

export async function tryHandleMentionModeCommand(
  larkAppId: string,
  message: any,
  senderOpenId: string | undefined,
  canTalk: boolean,
): Promise<boolean> {
  const rawText = extractMessageTextForRouting(message);
  if (!rawText) return false;
  const text = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
  const match = /^\/mention-mode(?:\s+(\S+))?\s*$/i.exec(text);
  if (!match) return false;

  const isP2p = message.chat_type === 'p2p';
  // Multi-bot groups: only the explicitly @mentioned bot owns this command.
  // p2p DMs are implicitly addressed to the sole bot — no @ required.
  if (!isP2p && !isBotMentioned(larkAppId, message, senderOpenId)) return true;

  const chatId: string | undefined = message.chat_id;
  const messageId: string | undefined = message.message_id;
  const loc = localeForBot(larkAppId);
  const reply = (content: string) => messageId
    ? replyMessage(larkAppId, messageId, content, 'text', false)
        .catch(err => logger.warn(`[mention-mode] reply failed: ${err?.message ?? err}`))
    : Promise.resolve();
  const arg = match[1]?.trim().toLowerCase();
  const isStatus = !arg || arg === 'status';

  // @ 策略只对普通群有意义：私聊天然无需 @，话题群本就是话题形态。
  if (isP2p || !chatId || (await getChatMode(larkAppId, chatId)) !== 'group') {
    await reply(t('cmd.mention_mode.unsupported', undefined, loc));
    return true;
  }

  // 会话群（p2pMode=group 出生）由 bot 自动管理 — 拒绝改动，避免 per-chat
  // 配置挂到一次性群上（与 /reply-mode 一致，见 session-groups-store）。
  if (isSessionGroup(chatId)) {
    await reply(t('sg.cmd_unsupported', { cmd: '/mention-mode' }, loc));
    return true;
  }

  if (isStatus) {
    if (!canTalk) return true;
    const mode = resolveGroupMentionMode(larkAppId, chatId);
    await reply(t('cmd.mention_mode.status', { mode }, loc));
    return true;
  }

  const mode = normalizeGroupMentionMode(arg);
  if (!mode) {
    await reply(t('cmd.mention_mode.usage', undefined, loc));
    return true;
  }
  if (!canOperate(larkAppId, chatId, senderOpenId)) {
    await reply(t('cmd.mention_mode.owner_only', undefined, loc));
    return true;
  }
  const res = await setChatMentionMode(larkAppId, chatId, mode);
  if (!res.ok) {
    await reply(t('cmd.mention_mode.failed', { reason: res.reason }, loc));
    return true;
  }
  await reply(t('cmd.mention_mode.updated', { mode }, loc));
  return true;
}
