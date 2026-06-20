/**
 * `/reply-mode` is a sessionless, pre-routing command. Keep it out of the
 * generic daemon-command path so status can be canTalk while mutations stay
 * canOperate, and so toggling the group setting never creates a phantom session.
 */
import { isBotMentioned, canOperate, extractMessageTextForRouting } from './event-dispatcher.js';
import { stripLeadingMentions } from './message-parser.js';
import { getChatMode, replyMessage } from './client.js';
import { localeForBot, t } from '../../i18n/index.js';
import { normalizeChatReplyMode, replyModeLabel, resolveRegularGroupMode, setChatReplyMode } from '../../services/chat-reply-mode-store.js';
import { findConfigField, applyConfigField } from '../../services/bot-config-store.js';
import { getBot } from '../../bot-registry.js';
import { logger } from '../../utils/logger.js';

export async function tryHandleReplyModeCommand(
  larkAppId: string,
  message: any,
  senderOpenId: string | undefined,
  canTalk: boolean,
): Promise<boolean> {
  const rawText = extractMessageTextForRouting(message);
  if (!rawText) return false;
  const text = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
  const match = /^\/reply-mode(?:\s+(\S+))?\s*$/i.exec(text);
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
        .catch(err => logger.warn(`[reply-mode] reply failed: ${err?.message ?? err}`))
    : Promise.resolve();
  const arg = match[1]?.trim().toLowerCase();
  const isStatus = !arg || arg === 'status';

  // 私聊（1:1 DM）会话模式 — 同一个 /reply-mode 命令，per-bot 的 p2pMode 存储。
  // 私聊只有 chat | topic 两态（shared 在 1:1 无意义），与普通群 3 态区分。
  if (isP2p) {
    if (isStatus) {
      if (!canTalk) return true;
      const cur = getBot(larkAppId).config.p2pMode === 'chat' ? 'chat' : 'new-topic';
      await reply(t('cmd.reply_mode.dm_status', { mode: replyModeLabel(cur) }, loc));
      return true;
    }
    // In DMs, `topic` keeps the old meaning: each message starts its own DM
    // thread/session. In regular groups, `topic` means topic-display with the
    // same chat session (handled below by normalizeChatReplyMode → shared).
    const mode = arg === 'topic' ? 'new-topic' : normalizeChatReplyMode(arg);
    if (!mode) {
      await reply(t('cmd.reply_mode.dm_usage', undefined, loc));
      return true;
    }
    if (mode === 'shared') {
      await reply(t('cmd.reply_mode.dm_shared_unsupported', undefined, loc));
      return true;
    }
    if (!canOperate(larkAppId, chatId, senderOpenId)) {
      await reply(t('cmd.reply_mode.owner_only', undefined, loc));
      return true;
    }
    const spec = findConfigField('p2pMode');
    if (!spec) {
      await reply(t('cmd.reply_mode.failed', { reason: 'spec_missing' }, loc));
      return true;
    }
    // chat → 扁平连续 DM 会话；topic/new-topic → 清回默认（每条 DM 独立）。
    const value = mode === 'chat' ? 'chat' : null;
    const r = await applyConfigField(larkAppId, spec, value);
    if (!r.ok) {
      await reply(t('cmd.reply_mode.failed', { reason: r.reason }, loc));
      return true;
    }
    await reply(t('cmd.reply_mode.dm_updated', { mode: replyModeLabel(mode) }, loc));
    return true;
  }

  if (!chatId || (await getChatMode(larkAppId, chatId)) !== 'group') {
    await reply(t('cmd.reply_mode.unsupported', undefined, loc));
    return true;
  }

  if (isStatus) {
    if (!canTalk) return true;
    const mode = resolveRegularGroupMode(larkAppId, chatId);
    await reply(t('cmd.reply_mode.status', { mode: replyModeLabel(mode) }, loc));
    return true;
  }

  const mode = normalizeChatReplyMode(arg);
  if (!mode) {
    await reply(t('cmd.reply_mode.usage', undefined, loc));
    return true;
  }
  if (!canOperate(larkAppId, chatId, senderOpenId)) {
    await reply(t('cmd.reply_mode.owner_only', undefined, loc));
    return true;
  }
  const res = await setChatReplyMode(larkAppId, chatId, mode);
  if (!res.ok) {
    await reply(t('cmd.reply_mode.failed', { reason: res.reason }, loc));
    return true;
  }
  await reply(t('cmd.reply_mode.updated', { mode: replyModeLabel(mode) }, loc));
  return true;
}
