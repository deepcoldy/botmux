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
import { forgetGroupSecretaryChat, noteSecretaryMarker } from '../../services/group-secretary-runtime.js';
import { readSecretaryMarker, writeSecretaryMarker } from '../../services/group-secretary-marker.js';
import { logger } from '../../utils/logger.js';

/** bot 级总开关（bots.json `groupSecretaryEnabled`，默认关）：关着时不能开启 / 接管，off 与 status 照常。 */
function secretaryAllowed(larkAppId: string): boolean {
  try { return getBot(larkAppId).config.groupSecretaryEnabled === true; } catch { return false; }
}

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
  // 权威登记 = 群描述里的 [botmux:secretary=…] 标记（跨机器可见）；本机文件只记本 bot 的开启人等细节。
  let markerAppId: string | undefined;
  try {
    markerAppId = await readSecretaryMarker(larkAppId, chatId);
  } catch {
    await reply(t('cmd.secretary.failed', { reason: 'chat_read_failed' }, loc));
    return true;
  }
  const local = getGroupSecretaryOwner(chatId);
  const isMine = markerAppId === larkAppId;
  const ownerName = markerAppId
    ? (local?.larkAppId === markerAppId && local.botName ? local.botName : markerAppId)
    : '';
  if (!arg || arg === 'status') {
    if (!canTalk) return true;
    if (!markerAppId) await reply(t('cmd.secretary.status_off', undefined, loc));
    else if (isMine && !secretaryAllowed(larkAppId)) await reply(t('cmd.secretary.status_paused', undefined, loc));
    else if (isMine) await reply(t('cmd.secretary.status_on', { at: local?.larkAppId === larkAppId ? new Date(local.enabledAt).toISOString() : '-' }, loc));
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
  let selfName: string | undefined;
  try { selfName = effectiveBotDisplayName(getBot(larkAppId)); } catch { selfName = undefined; }
  const localEntry = { larkAppId, ...(selfName ? { botName: selfName } : {}), enabledBy: senderOpenId, enabledAt: Date.now(), markerConfirmedAt: Date.now() };

  if (enable || takeover) {
    if (!secretaryAllowed(larkAppId)) {
      await reply(t('cmd.secretary.not_enabled', undefined, loc));
      return true;
    }
    if (isMine) {
      // 标记已是自己：补齐本机登记（例如换机器后重开）即可。
      if (local?.larkAppId !== larkAppId) setGroupSecretaryChat(chatId, localEntry);
      await reply(t('cmd.secretary.already_on', undefined, loc));
      return true;
    }
    // 全群只能有一个秘书（跨机器）：已有别的 bot 在当，必须显式接管。
    if (enable && markerAppId) {
      await reply(t('cmd.secretary.taken', { name: ownerName }, loc));
      return true;
    }
    const wrote = await writeSecretaryMarker(larkAppId, chatId, larkAppId);
    if (!wrote.ok) {
      await reply(t('cmd.secretary.failed', { reason: wrote.reason }, loc));
      return true;
    }
    const res = setGroupSecretaryChat(chatId, localEntry);
    if (!res.ok) {
      // 标记已写成自己但本机登记失败：回滚标记，避免出现「群里登记了秘书、却没有任何进程在当」。
      await writeSecretaryMarker(larkAppId, chatId, markerAppId ?? null);
      await reply(t('cmd.secretary.failed', { reason: res.reason }, loc));
      return true;
    }
    noteSecretaryMarker(chatId, larkAppId);
    logger.info(`[secretary] ${markerAppId ? `took over from ${markerAppId}` : 'enabled'} chat=${chatId.slice(0, 12)} by=${senderOpenId.slice(0, 12)}`);
    await reply(markerAppId
      ? t('cmd.secretary.took_over', { name: ownerName }, loc)
      : t('cmd.secretary.enabled', undefined, loc));
    return true;
  }

  // off：只有当前秘书自己能关。
  if (!isMine) {
    if (local?.larkAppId === larkAppId) setGroupSecretaryChat(chatId, null); // 清掉过期的本机登记
    await reply(markerAppId
      ? t('cmd.secretary.not_mine', { name: ownerName }, loc)
      : t('cmd.secretary.already_off', undefined, loc));
    return true;
  }
  const cleared = await writeSecretaryMarker(larkAppId, chatId, null);
  if (!cleared.ok) {
    await reply(t('cmd.secretary.failed', { reason: cleared.reason }, loc));
    return true;
  }
  if (local?.larkAppId === larkAppId) setGroupSecretaryChat(chatId, null);
  forgetGroupSecretaryChat(chatId);
  logger.info(`[secretary] disabled chat=${chatId.slice(0, 12)} by=${senderOpenId.slice(0, 12)}`);
  await reply(t('cmd.secretary.disabled', undefined, loc));
  return true;
}
