/**
 * Proactive auto-start policy — pure decision helpers for the two
 * "主动开工" features (see docs/specs/20260529-proactive-auto-start/).
 *
 * Two independent triggers, both opt-in per bot (default off):
 *   1. Bot added to a new chat  → spawn a session (场景① / autoStartOnGroupJoin)
 *   2. New topic in a topic group → spawn a session without @ (场景② / autoStartOnNewTopic)
 *
 * Kept side-effect-free so the routing/spawn logic stays unit-testable; the
 * I/O (member lookup, session spawn, event subscription) lives in the
 * dispatcher / daemon and calls into these predicates.
 */

/** Per-bot auto-start preferences, resolved from BotConfig. */
export interface AutoStartPrefs {
  /** 场景①: auto-start when the bot is added to a new chat. */
  autoStartOnGroupJoin: boolean;
  /** 场景①: optional pre-configured first-turn prompt. '' = empty user_message. */
  autoStartOnGroupJoinPrompt: string;
  /** 场景②: auto-start on every new topic in a topic group (no @ required). */
  autoStartOnNewTopic: boolean;
  /** 场景②: also auto-start when the new topic seed was sent by another bot. */
  autoStartOnNewTopicFromBots: boolean;
}

/**
 * 场景②: should a non-@mention message auto-start a session?
 *
 * True only for a brand-new topic seed in a 话题群 (topic mode):
 *   - the feature is enabled for this bot,
 *   - it's a group chat (not p2p),
 *   - routing landed on thread-scope anchored at this very message
 *     (decideRouting returns {scope:'thread', anchor: messageId} only for a
 *     top-level message in a topic group — a reply anchors at the thread root),
 *   - no existing session owns the anchor (a true new topic, not a reply).
 *
 * Regular groups route to chat-scope (anchor = chatId ≠ messageId), so they
 * never satisfy this — FR-7. Disabled bots never satisfy it — FR-8.
 */
export function shouldAutoStartOnNewTopic(opts: {
  enabled: boolean;
  /** Whether bot-originated topic seeds are allowed to trigger auto-start. */
  includeBotMessages?: boolean;
  /** True when the inbound message was sent by another bot/app. */
  fromBot?: boolean;
  scope: 'thread' | 'chat';
  anchor: string;
  messageId: string;
  chatType: 'group' | 'p2p';
  ownsSession: boolean;
}): boolean {
  return (
    opts.enabled &&
    (!opts.fromBot || opts.includeBotMessages === true) &&
    opts.chatType === 'group' &&
    opts.scope === 'thread' &&
    opts.anchor === opts.messageId &&
    !opts.ownsSession
  );
}

/**
 * 场景①: does the chat contain at least one of the bot's allowedUsers?
 *
 * The trigger gate per D7: auto-start only when an allowedUser is a member of
 * the chat the bot was just added to (the person who added the bot need not be
 * one). Open_ids are app-scoped, so both sides must come from the SAME bot's
 * app view. Empty allowedUsers → never triggers (FR-2).
 */
export function chatHasAllowedUser(
  memberOpenIds: Iterable<string>,
  allowedUserOpenIds: Iterable<string>,
): boolean {
  const allowed = new Set(allowedUserOpenIds);
  if (allowed.size === 0) return false;
  for (const m of memberOpenIds) {
    if (allowed.has(m)) return true;
  }
  return false;
}

/**
 * 场景①: resolve the first-turn prompt body from the configured prompt.
 * Trims whitespace; an unset / blank config yields '' (empty user_message,
 * per D8 — the model reads the group context itself). The surrounding prompt
 * envelope (role / identity) is added by buildNewTopicPrompt, so '' here still
 * produces a non-empty CLI turn (FR-11).
 */
export function resolveGroupJoinPrompt(configured: string | undefined): string {
  return (configured ?? '').trim();
}
