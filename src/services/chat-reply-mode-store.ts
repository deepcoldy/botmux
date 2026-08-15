/**
 * Per-chat reply mode for regular groups, layered over the per-bot default.
 *
 * Four modes — unifies #116 + #131 into one knob so a chat resolves
 * to EXACTLY ONE mode and the two thread-reply mechanisms can never compete:
 *   • chat        — flat chat-scope replies in the group. A native Lark topic
 *                    the user opens here folds back into this one chat-scope
 *                    session too (see maybeFoldMentionedRegularGroupThreadToChat).
 *   • topic/shared — 话题展示但复用同一个 session: reuse the bot's existing
 *                    chat-scope session/worker/cwd, but route this turn's reply
 *                    into the trigger message's thread (#131). A native topic
 *                    seed also folds into the shared session, not an independent one.
 *   • new-topic    — explicit fork mode: each top-level @mention opens a fresh
 *                    thread-scope session under the trigger (its own worker/cwd/context).
 *   • chat-topic   — hybrid (default): top-level @mentions stay flat in the one
 *                    chat-scope session (like `chat`), BUT a native Lark topic the
 *                    user opens runs its own independent thread-scope session (NOT
 *                    folded), whether the bot enters on the seed or a later reply.
 *                    "顶层平铺连续会话；群内原生话题各自独立会话".
 *
 * Native-topic isolation is chat-topic-only, honoring the /reply-mode config:
 * chat / shared deliberately fold native topics into the group session.
 *
 * Resolution: per-chat override (`chatReplyModes[chatId]`) wins; otherwise fall
 * back to the per-bot default (`regularGroupReplyMode`, default 'chat-topic'). The
 * setting is bot-scoped: Bot A can prefer topic replies in one group while Bot B
 * or another group stays flat.
 */
import { rmwBotEntry } from './config-store.js';
import { getBot, type ChatReplyMode } from '../bot-registry.js';
import { dashboardEventBus } from '../core/dashboard-events.js';
import { logger } from '../utils/logger.js';

export type { ChatReplyMode } from '../bot-registry.js';

export function normalizeChatReplyMode(raw: string | undefined): ChatReplyMode | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v || v === 'status') return undefined;
  if (v === 'chat') return 'chat';
  if (v === 'chat-topic' || v === 'chattopic' || v === 'chat_topic') return 'chat-topic';
  if (v === 'new-topic' || v === 'newtopic' || v === 'thread') return 'new-topic';
  if (v === 'topic' || v === 'shared' || v === 'share' || v === 'alias' || v === 'topic-alias' || v === 'topic_alias') return 'shared';
  return undefined;
}

function normalizeChatReplyModes(raw: unknown): Record<string, ChatReplyMode> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, ChatReplyMode> = {};
  for (const [chatId, value] of Object.entries(raw)) {
    if (!chatId.trim() || typeof value !== 'string') continue;
    const mode = normalizeChatReplyMode(value);
    if (mode) out[chatId] = mode;
  }
  return out;
}

/** Short command-word label for status / confirmation messages. */
export function replyModeLabel(mode: ChatReplyMode): 'chat' | 'topic' | 'new-topic' | 'chat-topic' {
  if (mode === 'shared') return 'topic';
  if (mode === 'new-topic') return 'new-topic';
  if (mode === 'chat-topic') return 'chat-topic';
  return 'chat';
}

/** Per-bot default regular-group mode (`regularGroupReplyMode`, default 'chat-topic'). */
export function regularGroupDefaultMode(larkAppId: string): ChatReplyMode {
  try {
    return getBot(larkAppId).config.regularGroupReplyMode ?? 'chat-topic';
  } catch {
    return 'chat-topic';
  }
}

export interface ChatReplyModeState {
  /** Explicit per-chat override. `null` means this chat inherits the bot default. */
  override: ChatReplyMode | null;
  default: ChatReplyMode;
  effective: ChatReplyMode;
  inherited: boolean;
}

/** Read the complete per bot x chat policy, including where the effective value came from. */
export function getChatReplyModeState(larkAppId: string, chatId: string): ChatReplyModeState {
  const defaultMode = regularGroupDefaultMode(larkAppId);
  let override: ChatReplyMode | undefined;
  try {
    override = getBot(larkAppId).config.chatReplyModes?.[chatId];
  } catch { /* keep the same safe default semantics as resolveRegularGroupMode */ }
  return {
    override: override ?? null,
    default: defaultMode,
    effective: override ?? defaultMode,
    inherited: override === undefined,
  };
}

export type GroupMentionMode = 'always' | 'topic' | 'never' | 'ambient';

/**
 * Per-bot (bot-global) @-requirement policy for regular groups, default 'always'.
 *   • always  — @ required everywhere (incl. inside shared topics).
 *   • topic   — @ required at top level, but non-@ continues inside shared topics.
 *   • never   — non-@ messages are always answered (where the bot has talk access).
 *   • ambient — like never, but stays quiet when the message @mentions another
 *               specific member (person/bot) without @ing this bot (redirect).
 */
export function resolveGroupMentionMode(larkAppId: string): GroupMentionMode {
  try {
    const m = getBot(larkAppId).config.regularGroupMentionMode;
    return m === 'topic' || m === 'never' || m === 'ambient' ? m : 'always';
  } catch {
    return 'always';
  }
}

/**
 * Effective regular-group reply mode for a chat — the SINGLE source of truth for
 * routing. Per-chat override first, then the per-bot default. Both the
 * `regularGroupRouting` (new-topic) and `maybeApplySharedTopicSeed` (shared)
 * code paths read this, so they are mutually exclusive by construction.
 */
export function resolveRegularGroupMode(larkAppId: string, chatId: string | undefined): ChatReplyMode {
  try {
    const perChat = chatId ? getBot(larkAppId).config.chatReplyModes?.[chatId] : undefined;
    if (perChat) return perChat;
  } catch { /* fall through to default */ }
  return regularGroupDefaultMode(larkAppId);
}

export async function setChatReplyMode(
  larkAppId: string,
  chatId: string,
  mode: ChatReplyMode,
): Promise<({ ok: true; mode: ChatReplyMode } & ChatReplyModeState) | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  // A set is always an explicit pin, even when it currently equals the bot
  // default. Otherwise a later default change would silently alter this chat.
  // Only clearChatReplyMode() restores inheritance.
  const r = await rmwBotEntry<Record<string, ChatReplyMode>>(larkAppId, (entry) => {
    const next = normalizeChatReplyModes(entry.chatReplyModes);
    next[chatId] = mode;
    entry.chatReplyModes = next;
    return { write: true, result: next };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  bot.config.chatReplyModes = r.result;
  logger.info(`[reply-mode:${larkAppId}] chat=${chatId} mode=${mode}`);
  dashboardEventBus.publish({
    type: 'groups.reply-policy.changed',
    body: { chatId },
  });
  return { ok: true, mode, ...getChatReplyModeState(larkAppId, chatId) };
}

/** Remove the explicit per-chat override so the chat follows the bot default again. */
export async function clearChatReplyMode(
  larkAppId: string,
  chatId: string,
): Promise<({ ok: true; cleared: boolean } & ChatReplyModeState) | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<{ cleared: boolean; chatReplyModes?: Record<string, ChatReplyMode> }>(larkAppId, (entry) => {
    const rawModes = entry.chatReplyModes;
    const rawRecord = rawModes && typeof rawModes === 'object' && !Array.isArray(rawModes)
      ? rawModes as Record<string, unknown>
      : undefined;
    const next = normalizeChatReplyModes(rawModes);
    const cleared = rawRecord !== undefined && Object.prototype.hasOwnProperty.call(rawRecord, chatId);
    delete next[chatId];
    const remaining = Object.keys(next).length > 0 ? next : undefined;
    const normalizedChanged = JSON.stringify(rawRecord ?? null) !== JSON.stringify(remaining ?? null);
    if (remaining) entry.chatReplyModes = remaining;
    else delete entry.chatReplyModes;
    // Even an idempotent clear returns the latest disk snapshot. This heals a
    // stale in-memory registry instead of accidentally retaining the old pin;
    // a legacy alias or invalid sibling entry is canonicalized at the same time.
    return { write: normalizedChanged, result: { cleared, chatReplyModes: remaining } };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  bot.config.chatReplyModes = r.result.chatReplyModes;
  logger.info(`[reply-mode:${larkAppId}] chat=${chatId} mode=inherit cleared=${r.result.cleared}`);
  dashboardEventBus.publish({
    type: 'groups.reply-policy.changed',
    body: { chatId },
  });
  return { ok: true, cleared: r.result.cleared, ...getChatReplyModeState(larkAppId, chatId) };
}
