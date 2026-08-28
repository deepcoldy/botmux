/** A native Lark topic id used by client AppLinks. This is deliberately
 * distinct from Botmux's `om_...` root-message routing anchor. */
export function isNativeTopicId(value: unknown): value is string {
  return typeof value === 'string' && /^omt_[A-Za-z0-9_-]+$/.test(value);
}

/** Fill an empty session field from an inbound topic event without ever moving
 * an existing session to a different topic. */
export function fillNativeTopicId(
  session: { larkThreadId?: string },
  scope: 'thread' | 'chat',
  threadId: unknown,
): boolean {
  if (scope !== 'thread' || session.larkThreadId || !isNativeTopicId(threadId)) return false;
  session.larkThreadId = threadId;
  return true;
}
