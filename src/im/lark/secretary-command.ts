/**
 * `/secretary on|off|status` —— 会话外、路由前处理的命令（与 /mention-mode 同形）：
 * 开关本 bot 在当前群的「群秘书」能力。status 只要求 canTalk，开关要求 canOperate；
 * 切换不会创建任何会话。只作用于当前群，不能替别的群 / 别的 bot 开。
 */
import { isBotMentioned, canOperate, extractMessageTextForRouting } from './event-dispatcher.js';
import { stripLeadingMentions } from './message-parser.js';
import { getChatMode, replyMessage } from './client.js';
import { localeForBot, t } from '../../i18n/index.js';
import { isSessionGroup } from '../../services/session-groups-store.js';
import { getGroupSecretaryChat, setGroupSecretaryChat } from '../../services/group-secretary-store.js';
import { forgetGroupSecretaryChat } from '../../services/group-secretary-runtime.js';
import { logger } from '../../utils/logger.js';

export async function tryHandleSecretaryCommand(
  larkAppId: string,
  message: any,
  senderOpenId: string | undefined,
  canTalk: boolean,
): Promise<boolean> {
  const rawText = extractMessageTextForRouting(message);
  if (!rawText) return false;
  const text = stripLeadingMentions(rawText.trim(), message?.mentions ?? []);
  const match = /^\/secretary(?:\s+(\S+))?\s*$/i.exec(text);
  if (!match) return false;

  const isP2p = message.chat_type === 'p2p';
  // 多 bot 群里只有被明确 @ 的 bot 处理；私聊直接回不支持。
  if (!isP2p && !isBotMentioned(larkAppId, message, senderOpenId)) return true;

  const chatId: string | undefined = message.chat_id;
  const messageId: string | undefined = message.message_id;
  const loc = localeForBot(larkAppId);
  const reply = (content: string) => messageId
    ? replyMessage(larkAppId, messageId, content, 'text', false)
        .catch(err => logger.warn(`[secretary] reply failed: ${err?.message ?? err}`))
    : Promise.resolve();

  if (isP2p || !chatId || isSessionGroup(chatId)) {
    await reply(t('cmd.secretary.unsupported', undefined, loc));
    return true;
  }
  const mode = await getChatMode(larkAppId, chatId);
  if (mode !== 'group' && mode !== 'topic') {
    await reply(t('cmd.secretary.unsupported', undefined, loc));
    return true;
  }

  const arg = match[1]?.trim().toLowerCase();
  const current = getGroupSecretaryChat(larkAppId, chatId);
  if (!arg || arg === 'status') {
    if (!canTalk) return true;
    await reply(current
      ? t('cmd.secretary.status_on', { by: current.enabledBy, at: new Date(current.enabledAt).toISOString() }, loc)
      : t('cmd.secretary.status_off', undefined, loc));
    return true;
  }
  const enable = arg === 'on' || arg === 'enable' || arg === '开' || arg === '开启';
  const disable = arg === 'off' || arg === 'disable' || arg === '关' || arg === '关闭';
  if (!enable && !disable) {
    await reply(t('cmd.secretary.usage', undefined, loc));
    return true;
  }
  if (!senderOpenId || !canOperate(larkAppId, chatId, senderOpenId)) {
    await reply(t('cmd.secretary.owner_only', undefined, loc));
    return true;
  }
  if (enable && current) {
    await reply(t('cmd.secretary.already_on', undefined, loc));
    return true;
  }
  if (disable && !current) {
    await reply(t('cmd.secretary.already_off', undefined, loc));
    return true;
  }
  const res = setGroupSecretaryChat(larkAppId, chatId, enable ? { enabledBy: senderOpenId, enabledAt: Date.now() } : null);
  if (!res.ok) {
    await reply(t('cmd.secretary.failed', { reason: res.reason }, loc));
    return true;
  }
  if (disable) forgetGroupSecretaryChat(chatId);
  logger.info(`[secretary] ${enable ? 'enabled' : 'disabled'} chat=${chatId.slice(0, 12)} by=${senderOpenId.slice(0, 12)}`);
  await reply(t(enable ? 'cmd.secretary.enabled' : 'cmd.secretary.disabled', undefined, loc));
  return true;
}
