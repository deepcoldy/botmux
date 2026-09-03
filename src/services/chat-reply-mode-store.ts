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
import { getBot, type ChatReplyMode, type GroupMentionMode } from '../bot-registry.js';
import { logger } from '../utils/logger.js';

export type { ChatReplyMode, GroupMentionMode } from '../bot-registry.js';

export function normalizeChatReplyMode(raw: string | undefined): ChatReplyMode | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v || v === 'status') return undefined;
  if (v === 'chat') return 'chat';
  if (v === 'chat-topic' || v === 'chattopic' || v === 'chat_topic') return 'chat-topic';
  if (v === 'new-topic' || v === 'newtopic' || v === 'thread') return 'new-topic';
  if (v === 'topic' || v === 'shared' || v === 'share' || v === 'alias' || v === 'topic-alias' || v === 'topic_alias') return 'shared';
  return undefined;
}

/** Short command-word label for status / confirmation messages. */
export function replyModeLabel(mode: ChatReplyMode): 'chat' | 'topic' | 'new-topic' | 'chat-topic' {
  if (mode === 'shared') return 'topic';
  if (mode === 'new-topic') return 'new-topic';
  if (mode === 'chat-topic') return 'chat-topic';
  return 'chat';
}

/** Per-bot default regular-group mode (`regularGroupReplyMode`, default 'chat-topic'). */
function regularGroupDefaultMode(larkAppId: string): ChatReplyMode {
  try {
    return getBot(larkAppId).config.regularGroupReplyMode ?? 'chat-topic';
  } catch {
    return 'chat-topic';
  }
}

/**
 * Per-bot (bot-global) @-requirement policy for regular groups, default 'always'.
 *   • always  — @ required everywhere (incl. inside shared topics).
 *   • topic   — @ required at top level, but non-@ continues inside shared topics.
 *   • never   — non-@ messages are always answered (where the bot has talk access).
 *   • ambient — like never, but stays quiet when the message @mentions another
 *               specific member (person/bot) without @ing this bot (redirect).
 *
 * Per-chat override (`chatMentionModes[chatId]`, written by `/mention-mode`)
 * wins when present; otherwise the per-bot `regularGroupMentionMode` default.
 */
export function resolveGroupMentionMode(larkAppId: string, chatId?: string): GroupMentionMode {
  try {
    const cfg = getBot(larkAppId).config;
    const perChat = chatId ? cfg.chatMentionModes?.[chatId] : undefined;
    if (perChat === 'always' || perChat === 'topic' || perChat === 'never' || perChat === 'ambient') {
      return perChat;
    }
    const m = cfg.regularGroupMentionMode;
    return m === 'topic' || m === 'never' || m === 'ambient' ? m : 'always';
  } catch {
    return 'always';
  }
}

/** Per-bot default mention policy (`regularGroupMentionMode`, default 'always'). */
function groupMentionDefaultMode(larkAppId: string): GroupMentionMode {
  try {
    const m = getBot(larkAppId).config.regularGroupMentionMode;
    return m === 'topic' || m === 'never' || m === 'ambient' ? m : 'always';
  } catch {
    return 'always';
  }
}

/** Parse `/mention-mode` argument; 'status'/empty → undefined (status query). */
export function normalizeGroupMentionMode(raw: string | undefined): GroupMentionMode | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v || v === 'status') return undefined;
  if (v === 'always' || v === 'topic' || v === 'never' || v === 'ambient') return v;
  return undefined;
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
): Promise<{ ok: true; mode: ChatReplyMode } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  // Persist only when the per-chat mode differs from the per-bot default, so
  // bots.json stays tidy in the common default-off case while an explicit
  // opt-out (e.g. per-bot default new-topic, this chat pinned back to chat)
  // still sticks instead of being silently dropped.
  const redundant = mode === regularGroupDefaultMode(larkAppId);

  const r = await rmwBotEntry<ChatReplyMode>(larkAppId, (entry) => {
    if (!entry.chatReplyModes || typeof entry.chatReplyModes !== 'object' || Array.isArray(entry.chatReplyModes)) {
      entry.chatReplyModes = {};
    }
    if (redundant) {
      delete entry.chatReplyModes[chatId];
      if (Object.keys(entry.chatReplyModes).length === 0) delete entry.chatReplyModes;
    } else {
      entry.chatReplyModes[chatId] = mode;
    }
    return { write: true, result: mode };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  const next = { ...(bot.config.chatReplyModes ?? {}) };
  if (redundant) delete next[chatId];
  else next[chatId] = mode;
  bot.config.chatReplyModes = Object.keys(next).length > 0 ? next : undefined;
  logger.info(`[reply-mode:${larkAppId}] chat=${chatId} mode=${mode}`);
  return { ok: true, mode };
}

/**
 * Persist the per-chat @-requirement policy (`/mention-mode`). Same tidy rule as
 * setChatReplyMode: only store when it differs from the per-bot default, so
 * bots.json stays clean in the common case while an explicit opt-out still
 * sticks (e.g. per-bot default 'never', this chat pinned back to 'always').
 */
export async function setChatMentionMode(
  larkAppId: string,
  chatId: string,
  mode: GroupMentionMode,
): Promise<{ ok: true; mode: GroupMentionMode } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const redundant = mode === groupMentionDefaultMode(larkAppId);

  const r = await rmwBotEntry<GroupMentionMode>(larkAppId, (entry) => {
    if (!entry.chatMentionModes || typeof entry.chatMentionModes !== 'object' || Array.isArray(entry.chatMentionModes)) {
      entry.chatMentionModes = {};
    }
    if (redundant) {
      delete entry.chatMentionModes[chatId];
      if (Object.keys(entry.chatMentionModes).length === 0) delete entry.chatMentionModes;
    } else {
      entry.chatMentionModes[chatId] = mode;
    }
    return { write: true, result: mode };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  const next = { ...(bot.config.chatMentionModes ?? {}) };
  if (redundant) delete next[chatId];
  else next[chatId] = mode;
  bot.config.chatMentionModes = Object.keys(next).length > 0 ? next : undefined;
  logger.info(`[mention-mode:${larkAppId}] chat=${chatId} mode=${mode}`);
  return { ok: true, mode };
}
