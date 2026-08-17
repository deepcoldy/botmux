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
import { deleteChat } from '../services/groups-store.js';
import { unbindOncall } from '../services/oncall-store.js';
import { registerSessionGroup } from '../services/session-groups-store.js';
import { scheduleSessionGroupTitle } from '../services/session-group-title.js';
import { tagSessionGroup } from '../services/feed-group-tagger.js';
import { applySessionGroupAvatar } from '../services/session-group-avatar.js';
import { sendMessage, replyMessage } from '../im/lark/client.js';
import { extractMessageTextForRouting, type RoutingContext } from '../im/lark/event-dispatcher.js';
import { stripLeadingMentions } from '../im/lark/message-parser.js';
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

/**
 * Does this inbound message decline session-group birth because it is a slash
 * command? Exported so the CALLER can ask BEFORE it charges message quota.
 *
 * A command (`/help`, `/login`, `/close`, …) never reaches a CLI, so it must
 * neither spend a quota unit nor be blocked by an exhausted one — but the
 * pre-birth charge has to run before the real Feishu chat is created (a quota
 * denial must have zero external side effects), i.e. long before the router's
 * own slash parsing. Hoisting THIS predicate is what keeps both invariants.
 *
 * Single source of truth on purpose: the caller's "skip the charge" decision and
 * this function's "don't birth" decision have to be the SAME decision. A caller
 * predicate NARROWER than this one re-opens the charge-a-command bug; a WIDER
 * one silently stops births for messages this function would still birth. Both
 * sides must call this.
 *
 * Leading @mentions are stripped FIRST, with the same helper and the same
 * mention list the router later uses to build `cmdContent`. Without that step
 * this predicate and the router disagree about the exact same message: Lark
 * delivers "@Bot /help" as text "@_user_1 /help" (resolved to "@Bot /help"),
 * which does not start with "/" here — so the message was charged a quota unit
 * AND birthed a group — while the router, reading the mention-stripped text,
 * still routed it as /help and never reached a CLI. That is a pure quota loss
 * on the most natural way to type a command at a bot.
 */
export function declinesSessionGroupBirthAsSlashCommand(data: any): boolean {
  const text = extractMessageTextForRouting(data?.message);
  if (!text) return false;
  // Only mentions that actually carry a display name are usable by the
  // name-based strip; when none do, the empty list lets stripLeadingMentions
  // fall back to its best-effort `@<token>` regex, which also clears the raw
  // "@_user_1" placeholders extractMessageTextForRouting could not resolve.
  const named = (Array.isArray(data?.message?.mentions) ? data.message.mentions : [])
    .filter((m: any) => typeof m?.name === 'string' && m.name.length > 0);
  return stripLeadingMentions(text.trim(), named).startsWith('/');
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
  // Shared predicate: handleNewTopic asks the same question before charging
  // quota, so a command is neither charged nor blocked by an exhausted quota.
  if (declinesSessionGroupBirthAsSlashCommand(data)) return null;

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
      // conversation home. Disband it and revoke the oncall binding BEFORE
      // falling back, so the failed birth leaves no orphan bot-owned chat
      // behind (PR review). Best-effort: cleanup failures only log.
      await deleteChat(larkAppId, newChatId)
        .then(r => { if (!r.ok) logger.warn(`[session-group] orphan chat ${newChatId.substring(0, 12)} disband failed: ${r.error}`); })
        .catch(err => logger.warn(`[session-group] orphan chat disband threw: ${err}`));
      await unbindOncall(larkAppId, newChatId)
        .catch(err => logger.warn(`[session-group] orphan oncall unbind threw: ${err}`));
      throw new Error(`user invite rejected (${senderOpenId.substring(0, 12)}…)`);
    }

    registerSessionGroup(newChatId, { ownerOpenId: senderOpenId, lastSessionId: '' });

    // Intro message: quote the user's DM text so the group is self-explaining.
    // Its message_id becomes the turn's IN-GROUP anchor (ctx.messageId below):
    // the streaming card / replies quote THIS message, keeping every output in
    // the group — anchoring on the original DM message would leak them to the DM.
    const excerpt = trimmed
      ? Array.from(trimmed).slice(0, 500).join('')
      : t('sg.intro_no_text', undefined, locale);
    let introMessageId: string | undefined;
    try {
      introMessageId = await sendMessage(
        larkAppId,
        newChatId,
        `📥 <at user_id="${senderOpenId}"></at> ${t('sg.intro', undefined, locale)}\n${excerpt}`,
        'text',
      );
    } catch (err) {
      logger.warn(`[session-group] intro message failed for ${newChatId.substring(0, 12)}: ${err}`);
    }

    // DM receipt (default on): a share_chat 群名片 card — tap to jump into the
    // group. Falls back to a plain text link when share_chat is rejected.
    if (sg.dmReceipt !== false) {
      try {
        await replyMessage(larkAppId, messageId, JSON.stringify({ chat_id: newChatId }), 'share_chat');
      } catch (err) {
        logger.info(`[session-group] share_chat receipt failed (${err}); falling back to link text`);
        const link = `https://applink.feishu.cn/client/chat/open?openChatId=${newChatId}`;
        await replyMessage(
          larkAppId,
          messageId,
          t('sg.receipt', { link }, locale),
        ).catch(err2 => logger.warn(`[session-group] DM receipt failed: ${err2}`));
      }
    }

    // Session-group tagging + avatar branding — both fire-and-forget and
    // best-effort (tag degrades per mode/tenant support; avatar degrades to
    // the default Feishu group avatar).
    void tagSessionGroup(larkAppId, newChatId, senderOpenId);
    void applySessionGroupAvatar(larkAppId, newChatId);

    // T1 of two-phase naming: async AI title → rename (fire-and-forget).
    scheduleSessionGroupTitle({ larkAppId, chatId: newChatId, userText: trimmed });

    logger.info(
      `[session-group] born chat=${newChatId.substring(0, 12)} for dm=${dmChatId.substring(0, 12)} ` +
      `msg=${messageId.substring(0, 12)} intro=${introMessageId?.substring(0, 12) ?? '-'} ` +
      `name="${placeholder}" workingDir=${workingDir ?? '-'}`,
    );

    return {
      ...ctx,
      chatId: newChatId,
      chatType: 'group',
      scope: 'chat',
      anchor: newChatId,
      // `messageId` stays the ORIGINAL DM message id: resource keys /
      // merge-forward sub-messages belong to it, so downloads must keep using
      // it. The in-group intro message rides separately as the REPLY anchor
      // (quote target / session rootMessageId) so the first turn's outputs
      // land in the group. When the intro failed to send the anchor is left
      // unset and replies degrade to the DM, but the session still lives in
      // the group.
      replyAnchorMessageId: introMessageId,
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
