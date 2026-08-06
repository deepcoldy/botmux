/**
 * Session-group birth — the p2pMode='group' rerouting step.
 *
 * A top-level DM message normally seeds a DM thread session (p2pMode=thread
 * shape). Under p2pMode='group', handleNewTopic calls maybeBirthSessionGroup
 * FIRST: it creates a dedicated 1-user+1-bot chat (the bot keeps ownership),
 * registers it in session-groups-store, posts an intro quote of the user's
 * message into the new group, sends a DM receipt linking the group, kicks off
 * the async AI title, and hands back a rewritten RoutingContext pointing at
 * the new chat (chat-scope). handleNewTopic then simply recurses with that
 * context — every later step (oncall working-dir resolution via the binding
 * written at creation, session spawn, streaming card) behaves exactly like a
 * normal solo-group chat-scope session.
 *
 * Returns null to fall through to the legacy thread behavior:
 *   - the message is a slash command (never birth a group for /help, /login …)
 *   - group creation failed (a DM notice explains the fallback)
 */
import { getBot } from '../bot-registry.js';
import { createGroupWithBots } from '../services/group-creator.js';
import { registerSessionGroup } from '../services/session-groups-store.js';
import { scheduleSessionGroupTitle } from '../services/session-group-title.js';
import { sendMessage, replyMessage } from '../im/lark/client.js';
import { extractMessageTextForRouting, type RoutingContext } from '../im/lark/event-dispatcher.js';
import { t, localeForBot, type Locale } from '../i18n/index.js';
import { logger } from '../utils/logger.js';

const PLACEHOLDER_MAX_CHARS = 20;

/** Truncated placeholder chat name from the user's message text (T0 of the
 *  two-phase naming; the async AI title replaces it seconds later). */
export function buildPlaceholderName(text: string | null, prefix: string, locale: Locale): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  const base = flat
    ? Array.from(flat).slice(0, PLACEHOLDER_MAX_CHARS).join('')
    : t('sg.placeholder_untitled', undefined, locale);
  return `${prefix}${base}`;
}

export async function maybeBirthSessionGroup(
  data: any,
  ctx: RoutingContext,
): Promise<RoutingContext | null> {
  const { larkAppId, chatId: dmChatId, messageId } = ctx;
  const botCfg = getBot(larkAppId).config;
  const sg = botCfg.sessionGroup ?? {};
  const locale = localeForBot(larkAppId);
  const senderOpenId: string | undefined = data?.sender?.sender_id?.open_id;
  if (!senderOpenId) return null;

  const text = extractMessageTextForRouting(data?.message);
  const trimmed = (text ?? '').trim();
  // Slash commands (daemon or passthrough) must never birth a group — /close,
  // /login, /relay … are conversation-management, not conversations.
  if (trimmed.startsWith('/')) return null;

  const prefix = sg.namePrefix ?? '';
  const placeholder = buildPlaceholderName(text, prefix, locale);
  const workingDir = sg.workingDir?.trim() || botCfg.defaultWorkingDir?.trim() || botCfg.workingDir?.trim() || undefined;

  try {
    const result = await createGroupWithBots({
      creatorLarkAppId: larkAppId,
      larkAppIds: [larkAppId],
      name: placeholder,
      userOpenIds: [senderOpenId],
      // Deliberately NO transferOwnerTo: the bot keeps chat ownership so it
      // can rename (AI title) and later disband/archive session groups.
      bindWorkingDir: workingDir,
    });
    const newChatId = result.chatId;
    if (!newChatId) throw new Error('chat.create returned no chatId');
    if (result.invalidUserIds.includes(senderOpenId)) {
      // The group exists but the user could not be invited — useless as a
      // conversation home; fall back rather than talk into the void.
      throw new Error(`user invite rejected (${senderOpenId.substring(0, 12)}…)`);
    }

    registerSessionGroup(newChatId, { ownerOpenId: senderOpenId, lastSessionId: '' });

    // Intro message: quote the user's DM text so the group is self-explaining.
    const excerpt = trimmed
      ? Array.from(trimmed).slice(0, 500).join('')
      : t('sg.intro_no_text', undefined, locale);
    await sendMessage(
      larkAppId,
      newChatId,
      `📥 <at user_id="${senderOpenId}"></at> ${t('sg.intro', undefined, locale)}\n${excerpt}`,
      'text',
    ).catch(err => logger.warn(`[session-group] intro message failed for ${newChatId.substring(0, 12)}: ${err}`));

    // DM receipt with the group link (default on).
    if (sg.dmReceipt !== false) {
      const link = `https://applink.feishu.cn/client/chat/open?openChatId=${newChatId}`;
      await replyMessage(
        larkAppId,
        messageId,
        t('sg.receipt', { link }, locale),
      ).catch(err => logger.warn(`[session-group] DM receipt failed: ${err}`));
    }

    // T1 of two-phase naming: async AI title → rename (fire-and-forget).
    scheduleSessionGroupTitle({ larkAppId, chatId: newChatId, userText: trimmed });

    logger.info(
      `[session-group] born chat=${newChatId.substring(0, 12)} for dm=${dmChatId.substring(0, 12)} ` +
      `msg=${messageId.substring(0, 12)} name="${placeholder}" workingDir=${workingDir ?? '-'}`,
    );

    return {
      ...ctx,
      chatId: newChatId,
      chatType: 'group',
      scope: 'chat',
      anchor: newChatId,
      replyRootId: undefined,
      sessionGroupBirth: true,
    };
  } catch (err) {
    logger.error(`[session-group] birth failed for dm=${dmChatId.substring(0, 12)}: ${err}`);
    await replyMessage(
      larkAppId,
      messageId,
      t('sg.birth_failed', { error: String((err as any)?.message ?? err).slice(0, 120) }, locale),
    ).catch(() => { /* best-effort notice */ });
    return null;
  }
}
