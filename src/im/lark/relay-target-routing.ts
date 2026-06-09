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
 *   1. p2p chat            → reject (single chats have no relay target)
 *   2. real thread reply   → thread-scope, anchor = message.rootId
 *      (`threadId && rootId`; covers 话题群 thread replies and any group's
 *       in-thread reply)
 *   3. 话题群 top-level     → thread-scope, anchor = message.messageId (seeds 话题)
 *   4. 普通群 new-topic/shared → thread-scope, anchor = message.messageId (seeds 话题)
 *   5. 普通群 flat (chat)   → chat-scope, anchor = chatId (top-level, unchanged)
 */
import { resolveRegularGroupMode } from '../../services/chat-reply-mode-store.js';

export type RelayTargetRouting =
  | { scope: 'thread' | 'chat'; anchor: string }
  | { reject: 'p2p' };

export function resolveRelayTargetRouting(input: {
  larkAppId: string;
  chatId: string;
  message: { messageId: string; rootId?: string; threadId?: string };
  /** Resolved via getChatNameAndMode by the caller (one API call already made). */
  chatMode: 'group' | 'topic' | 'p2p';
}): RelayTargetRouting {
  const { larkAppId, chatId, message, chatMode } = input;

  if (chatMode === 'p2p') return { reject: 'p2p' };

  // A reply *inside* an existing Lark thread carries both root_id and
  // thread_id; the thread's root is the routing anchor.
  if (message.threadId && message.rootId) {
    return { scope: 'thread', anchor: message.rootId };
  }

  // 话题群 top-level message — Lark makes this message its own 话题 root.
  if (chatMode === 'topic') {
    return { scope: 'thread', anchor: message.messageId };
  }

  // 普通群: mode decides. new-topic + shared both land in a fresh 话题 seeded
  // on the /relay message; flat 'chat' stays top-level chat-scope.
  const rg = resolveRegularGroupMode(larkAppId, chatId);
  if (rg === 'new-topic' || rg === 'shared') {
    return { scope: 'thread', anchor: message.messageId };
  }
  return { scope: 'chat', anchor: chatId };
}
