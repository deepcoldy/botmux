export function groupContextConversationForTurn(message: any, routing: { scope: 'chat' | 'thread'; anchor: string }): { scope: 'main' | 'thread'; rootId?: string; threadId?: string } {
  const threadId = typeof message?.thread_id === 'string' && message.thread_id ? message.thread_id : undefined;
  if (threadId) {
    // root_id alone can be an ordinary quote bubble. Native thread_id is the
    // physical topic signal even when reply-mode folds it into a chat session.
    const rootId = typeof message.root_id === 'string' && message.root_id
      ? message.root_id : routing.scope === 'thread' ? routing.anchor : message.message_id;
    return { scope: 'thread', ...(rootId ? { rootId } : {}), threadId };
  }
  if (routing.scope === 'thread') return { scope: 'thread', rootId: routing.anchor };
  return { scope: 'main' };
}
