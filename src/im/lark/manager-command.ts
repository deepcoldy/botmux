import { effectiveBotDisplayName, getBot, getBotOpenId } from '../../bot-registry.js';
import { localeForBot, t } from '../../i18n/index.js';
import { changeChatManager, getChatManagerStatus } from '../../services/chat-manager.js';
import { isSessionGroup } from '../../services/session-groups-store.js';
import { logger } from '../../utils/logger.js';
import { replyMessage } from './client.js';
import { canOperate, extractMessageTextForRouting, isBotMentioned } from './event-dispatcher.js';
import { stripLeadingMentions } from './message-parser.js';

/** Human-only pre-routing command; it never borrows a running session's owner. */
export async function tryHandleManagerCommand(
  app: string, message: any, senderOpenId: string | undefined, canTalk: boolean,
): Promise<boolean> {
  const raw = extractMessageTextForRouting(message);
  if (!raw) return false;
  const text = stripLeadingMentions(raw.trim(), message?.mentions ?? []);
  const match = /^\/manager(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return false;
  if (message.chat_type !== 'p2p' && !isBotMentioned(app, message, senderOpenId)) return true;
  const loc = localeForBot(app);
  const reply = async (content: string) => {
    if (!message.message_id) return;
    try { await replyMessage(app, message.message_id, content, 'text', false); }
    catch { logger.warn('[chat-manager] command reply failed'); }
  };
  if (!canTalk) return true;
  const chat = message.chat_id;
  if (message.chat_type !== 'group' || !chat || message.root_id || message.thread_id || isSessionGroup(chat)) {
    await reply(t('cmd.manager.unsupported', undefined, loc));
    return true;
  }
  const action = match[1]?.trim().toLowerCase() || 'status';
  if (action !== 'status' && action !== 'set' && action !== 'clear') {
    await reply(t('cmd.manager.usage', undefined, loc));
    return true;
  }
  if (action !== 'status') {
    if (!canOperate(app, chat, senderOpenId)) {
      await reply(t('cmd.manager.owner_only', undefined, loc));
      return true;
    }
    const self = getBotOpenId(app);
    const others = (message.mentions ?? []).some((mention: any) => {
      const id = mention.id?.open_id;
      return id !== self && id !== 'all';
    });
    const explicitlyMentioned = (message.mentions ?? []).some((mention: any) => mention.id?.open_id === self);
    if (!self || !explicitlyMentioned || others) {
      await reply(t('cmd.manager.one_bot', undefined, loc));
      return true;
    }
  }
  const result = action === 'status'
    ? await getChatManagerStatus(app, chat)
    : await changeChatManager(app, chat, action, effectiveBotDisplayName(getBot(app)));
  if (!result.ok) {
    await reply(t('cmd.manager.failed', { reason: result.reason }, loc));
  } else {
    await reply(t('cmd.manager.status', {
      app: result.managerAppId ?? '-', active: String(result.locallyEnabled),
    }, loc));
  }
  return true;
}
