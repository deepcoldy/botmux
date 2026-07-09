import { canOperate, canTalk, extractMessageTextForRouting, isBotMentioned } from './event-dispatcher.js';
import { stripLeadingMentions } from './message-parser.js';
import { getChatMode, replyMessage } from './client.js';
import { isSubstituteEnabledForChat, setSubstituteEnabledForChat } from '../../services/substitute-chat-toggle-store.js';
import { localeForBot, t } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';

export async function tryHandleSubstituteCommand(
  larkAppId: string,
  message: any,
  senderOpenId: string | undefined,
): Promise<boolean> {
  const rawText = extractMessageTextForRouting(message);
  if (!rawText) return false;
  const text = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
  const match = /^\/substitute(?:\s+(\S+))?\s*$/i.exec(text);
  if (!match) return false;

  const isP2p = message.chat_type === 'p2p';
  if (!isP2p && !isBotMentioned(larkAppId, message, senderOpenId)) return true;

  const chatId: string | undefined = message.chat_id;
  const messageId: string | undefined = message.message_id;
  const loc = localeForBot(larkAppId);
  const reply = (content: string) => messageId
    ? replyMessage(larkAppId, messageId, content, 'text', false)
        .catch(err => logger.warn(`[substitute] reply failed: ${err?.message ?? err}`))
    : Promise.resolve();

  if (!chatId || isP2p || (await getChatMode(larkAppId, chatId)) !== 'group') {
    await reply(t('cmd.substitute.unsupported', undefined, loc));
    return true;
  }

  const arg = match[1]?.trim().toLowerCase() ?? 'status';
  if (!arg || arg === 'status') {
    if (!canTalk(larkAppId, chatId, senderOpenId) && !isBotMentioned(larkAppId, message, senderOpenId)) return true;
    const enabled = isSubstituteEnabledForChat(larkAppId, chatId);
    await reply(t(enabled ? 'cmd.substitute.status_on' : 'cmd.substitute.status_off', undefined, loc));
    return true;
  }

  const enable = arg === 'on' || arg === 'enable' || arg === '开启' || arg === '开';
  const disable = arg === 'off' || arg === 'disable' || arg === '关闭' || arg === '关';
  if (!enable && !disable) {
    await reply(t('cmd.substitute.usage', undefined, loc));
    return true;
  }
  if (!canOperate(larkAppId, chatId, senderOpenId)) {
    await reply(t('cmd.substitute.owner_only', undefined, loc));
    return true;
  }
  setSubstituteEnabledForChat(larkAppId, chatId, enable);
  await reply(t(enable ? 'cmd.substitute.updated_on' : 'cmd.substitute.updated_off', undefined, loc));
  return true;
}
