/** Listener feedback is independent of ordinary group reply modes. */
export type MessageListenerReplyMode = 'thread' | 'chat' | 'none';

export function normalizeMessageListenerReplyMode(raw: unknown): MessageListenerReplyMode {
  return raw === 'chat' || raw === 'none' ? raw : 'thread';
}
