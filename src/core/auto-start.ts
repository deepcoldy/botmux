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
  scope: 'thread' | 'chat';
  anchor: string;
  messageId: string;
  chatType: 'group' | 'p2p';
  ownsSession: boolean;
}): boolean {
  return (
    opts.enabled &&
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

/**
 * 场景①: D7 gate with retry — wait for an allowedUser to appear in the chat.
 *
 * Alarm/oncall platforms that auto-create incident chats (e.g. ByteDance
 * Nexus) add the bot FIRST and the human members moments later. A one-shot
 * membership snapshot taken at bot.added time races against that and loses:
 * the chat looks like it has no allowedUser and auto-start is silently
 * skipped even though the owner lands in the chat a second later. Re-check
 * membership a few times with backoff before giving up.
 *
 * Attempts = retryDelaysMs.length + 1 (default 4 attempts over ~25s). Errors
 * from `listMembers` propagate to the caller on ANY attempt — same handling
 * as the previous one-shot check (warn + scope hint). Empty allowedUsers
 * short-circuits to false without calling `listMembers` (FR-2).
 */
export async function waitForAllowedUserInChat(opts: {
  listMembers: () => Promise<string[]>;
  allowedUsers: Iterable<string>;
  /** Waits BETWEEN attempts (ms). Default [3000, 7000, 15000]. */
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number) => void;
}): Promise<boolean> {
  const allowed = [...opts.allowedUsers];
  if (allowed.length === 0) return false;
  const delays = opts.retryDelaysMs ?? [3000, 7000, 15000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    if (chatHasAllowedUser(await opts.listMembers(), allowed)) return true;
    if (attempt >= delays.length) return false;
    opts.onRetry?.(attempt + 1, delays[attempt]);
    await sleep(delays[attempt]);
  }
}
