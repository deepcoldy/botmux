/**
 * Resolve where a relayed (picker-pulled) session should LAND when `/relay` is
 * invoked. This mirrors `decideRouting` (event-dispatcher) so a pulled session
 * comes to rest exactly where a normal new message at the same spot would —
 * with ONE intentional divergence: `shared` regular-group mode routes the relay
 * target as thread-scope (a fresh 话题), not chat-scope.
 *
 * Why the shared divergence: a `shared`-mode group already has a single shared
 * chat-scope session occupying the chatId anchor. Pulling another session in as
 * chat-scope would collide on that anchor. So relays into a shared group land
 * in an independent 话题 instead (anchored on the `/relay` message).
 *
 * Rules (in order):
 *   1. p2p + p2pMode 'chat'  → chat-scope, anchor = chatId (扁平连续 DM; checked
 *      BEFORE the real-thread branch — same precedence as decideRouting, so a
 *      `/relay` typed inside a leftover DM thread still lands in the flat
 *      session rather than forking a thread-scope target)
 *   2. real thread reply     → thread-scope, anchor = message.rootId
 *      (`threadId && rootId`; covers 话题群 thread replies, DM 话题内回复, and
 *       any group's in-thread reply)
 *   3. p2p (thread default)  → thread-scope, anchor = message.messageId (the
 *      `/relay` message seeds a fresh DM 话题 — same shape as a top-level DM
 *      message in decideRouting)
 *   4. 话题群 top-level       → thread-scope, anchor = message.messageId (seeds 话题)
 *   5. 普通群 new-topic/shared → thread-scope, anchor = message.messageId (seeds 话题)
 *   6. 普通群 flat (chat / chat-topic) → chat-scope, anchor = chatId (top-level,
 *      unchanged). chat-topic only diverges from chat for replies INSIDE a native
 *      topic — those carry root_id+thread_id and are already caught by rule 2.
 */
import { resolveRegularGroupMode } from '../../services/chat-reply-mode-store.js';
import { getBot } from '../../bot-registry.js';

export type RelayTargetRouting = { scope: 'thread' | 'chat'; anchor: string };

export function resolveRelayTargetRouting(input: {
  larkAppId: string;
  chatId: string;
  message: { messageId: string; rootId?: string; threadId?: string };
  /** p2p resolved from the session's authoritative chatType; group/topic via
   *  getChatNameAndMode by the caller (one API call already made). */
  chatMode: 'group' | 'topic' | 'p2p';
}): RelayTargetRouting {
  const { larkAppId, chatId, message, chatMode } = input;

  // 私聊 chat 模式（扁平连续）：整段 DM 折进同一个 chat-scope 会话，relay 目标
  // 也落在同一个 chatId 锚上。必须先于 real-thread 分支 —— 与 decideRouting
  // 同序，否则在 DM 残留 thread 里敲 /relay 会被分流成 thread 目标，破坏
  // 「连续单聊会话」语义。
  if (chatMode === 'p2p') {
    let p2pMode: 'thread' | 'chat' | undefined;
    try { p2pMode = getBot(larkAppId)?.config?.p2pMode; } catch { /* unregistered bot → default thread */ }
    if (p2pMode === 'chat') return { scope: 'chat', anchor: chatId };
  }

  // A reply *inside* an existing Lark thread carries both root_id and
  // thread_id; the thread's root is the routing anchor. Covers group 话题 AND
  // DM 话题 (thread-mode DMs thread every conversation).
  if (message.threadId && message.rootId) {
    return { scope: 'thread', anchor: message.rootId };
  }

  // 私聊默认（thread 模式）顶层消息：/relay 消息本身种一个新 DM 话题 — 跟
  // decideRouting 对 top-level DM 的处理同款。
  if (chatMode === 'p2p') {
    return { scope: 'thread', anchor: message.messageId };
  }

  // 话题群 top-level message — Lark makes this message its own 话题 root.
  if (chatMode === 'topic') {
    return { scope: 'thread', anchor: message.messageId };
  }

  // 普通群: mode decides. new-topic + shared both land in a fresh 话题 seeded
  // on the /relay message; flat 'chat' stays top-level chat-scope. 'chat-topic'
  // is flat at top level too (its per-topic divergence only applies to replies
  // inside a native topic, already handled by the real-thread branch above), so
  // a top-level /relay lands chat-scope just like plain 'chat'.
  const rg = resolveRegularGroupMode(larkAppId, chatId);
  if (rg === 'new-topic' || rg === 'shared') {
    return { scope: 'thread', anchor: message.messageId };
  }
  return { scope: 'chat', anchor: chatId };
}
