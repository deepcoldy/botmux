import type { GroupContextConversationScope } from './group-context-store.js';

export interface GroupContextConversationOptions {
  scope?: GroupContextConversationScope;
  rootId?: string;
  threadId?: string;
}

interface ConversationMessage {
  seq: number;
  messageId: string;
  chatId: string;
  rootId?: string;
  threadId?: string;
  parentId?: string;
  conversationScope?: GroupContextConversationScope;
}

/**
 * Select whole message identities before content deduplication or hydration.
 * Retain every revision of a selected identity so recalls can still classify
 * their preceding body. Routing omitted by PATCH/recall is recovered from the
 * other revisions without changing any caller-owned records. Extra routing
 * evidence may fall outside the visible time window; its bodies are not selected.
 */
export function selectGroupContextConversation<T extends ConversationMessage>(
  messages: readonly T[],
  options: GroupContextConversationOptions = {},
  evidence: readonly ConversationMessage[] = messages,
): T[] {
  const scope = options.scope ?? (options.rootId || options.threadId ? 'thread' : 'main');
  const identities = new Map<string, {
    scope?: GroupContextConversationScope;
    scopeSeq: number;
    rootId?: string;
    rootSeq: number;
    threadId?: string;
    threadSeq: number;
  }>();
  const key = (message: ConversationMessage): string => JSON.stringify([message.chatId, message.messageId]);
  // Source rows also supply evidence if the caller passes an incomplete set.
  const observations = evidence === messages ? messages : [...evidence, ...messages];
  for (const message of observations) {
    const id = key(message);
    let known = identities.get(id);
    if (!known) {
      known = { scopeSeq: Infinity, rootSeq: -Infinity, threadSeq: -Infinity };
      identities.set(id, known);
    }
    // Native topic identity is positive proof even in pre-provenance journals.
    // An earlier explicit main origin still permits a later topic starter.
    const observedScope = message.conversationScope ?? (message.threadId ? 'thread' : undefined);
    if (observedScope && message.seq < known.scopeSeq) {
      known.scope = observedScope;
      known.scopeSeq = message.seq;
    }
    if (message.rootId && message.seq >= known.rootSeq) {
      known.rootId = message.rootId;
      known.rootSeq = message.seq;
    }
    if (message.threadId && message.seq >= known.threadSeq) {
      known.threadId = message.threadId;
      known.threadSeq = message.seq;
    }
  }
  return messages.filter(message => {
    const known = identities.get(key(message))!;
    if (scope === 'main') {
      // Sparse PATCH/publication observations can lose all routing, including
      // real topic IDs. Only affirmative main provenance permits lobby history.
      return known.scope === 'main';
    }
    if (options.rootId && message.messageId === options.rootId) return true;
    if (known.scope === 'main') return false;
    if (options.threadId && known.threadId) return known.threadId === options.threadId;
    if (options.rootId && known.threadId === options.rootId) return true;
    return Boolean(options.rootId && known.rootId === options.rootId
      && (known.scope === 'thread' || known.threadId));
  });
}
