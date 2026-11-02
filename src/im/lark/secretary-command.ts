/**
 * `/secretary on|off|takeover|status` —— 会话外、路由前处理的命令（与 /mention-mode 同形）：
 * 开关本 bot 在当前群的「群秘书」能力。status 只要求 canTalk，开关要求 canOperate；
 * 切换不会创建任何会话。只作用于当前群，不能替别的群 / 别的 bot 开。
 */
import { isBotMentioned, canOperate, extractMessageTextForRouting } from './event-dispatcher.js';
import { stripLeadingMentions } from './message-parser.js';
import { getChatMode, replyMessage } from './client.js';
import { localeForBot, t } from '../../i18n/index.js';
import { isSessionGroup } from '../../services/session-groups-store.js';
import { getGroupSecretaryOwner, setGroupSecretaryChat } from '../../services/group-secretary-store.js';
import { getBot, effectiveBotDisplayName } from '../../bot-registry.js';
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
  const owner = getGroupSecretaryOwner(chatId);
  const ownerName = owner ? (owner.botName ?? owner.larkAppId) : '';
  const isMine = owner?.larkAppId === larkAppId;
  if (!arg || arg === 'status') {
    if (!canTalk) return true;
    if (!owner) await reply(t('cmd.secretary.status_off', undefined, loc));
    else if (isMine) await reply(t('cmd.secretary.status_on', { at: new Date(owner.enabledAt).toISOString() }, loc));
    else await reply(t('cmd.secretary.status_other', { name: ownerName }, loc));
    return true;
  }
  const enable = arg === 'on' || arg === 'enable' || arg === '开' || arg === '开启';
  const takeover = arg === 'takeover' || arg === '接管';
  const disable = arg === 'off' || arg === 'disable' || arg === '关' || arg === '关闭';
  if (!enable && !takeover && !disable) {
    await reply(t('cmd.secretary.usage', undefined, loc));
    return true;
  }
  if (!senderOpenId || !canOperate(larkAppId, chatId, senderOpenId)) {
    await reply(t('cmd.secretary.owner_only', undefined, loc));
    return true;
  }
  if ((enable || takeover) && isMine) {
    await reply(t('cmd.secretary.already_on', undefined, loc));
    return true;
  }
  // 本机同一个群只能有一个秘书：已有别的 bot 在当，必须显式接管，避免两个秘书各催各的、互相触发。
  if (enable && owner && !isMine) {
    await reply(t('cmd.secretary.taken', { name: ownerName }, loc));
    return true;
  }
  if (disable && !isMine) {
    await reply(owner
      ? t('cmd.secretary.not_mine', { name: ownerName }, loc)
      : t('cmd.secretary.already_off', undefined, loc));
    return true;
  }
  let selfName: string | undefined;
  try { selfName = effectiveBotDisplayName(getBot(larkAppId)); } catch { selfName = undefined; }
  const res = setGroupSecretaryChat(chatId, disable ? null : {
    larkAppId,
    ...(selfName ? { botName: selfName } : {}),
    enabledBy: senderOpenId,
    enabledAt: Date.now(),
  });
  if (!res.ok) {
    await reply(t('cmd.secretary.failed', { reason: res.reason }, loc));
    return true;
  }
  if (disable) forgetGroupSecretaryChat(chatId);
  logger.info(`[secretary] ${disable ? 'disabled' : takeover && owner ? `took over from ${owner.larkAppId}` : 'enabled'} `
    + `chat=${chatId.slice(0, 12)} by=${senderOpenId.slice(0, 12)}`);
  if (takeover && owner) {
    await reply(t('cmd.secretary.took_over', { name: ownerName }, loc));
    return true;
  }
  await reply(t(disable ? 'cmd.secretary.disabled' : 'cmd.secretary.enabled', undefined, loc));
  return true;
}
