import type { WecomInboundMessage } from '../protocol/types.js';

export interface WecomSessionMode {
  p2pMode: 'chat';
  regularGroupReplyMode: 'user' | 'chat';
  regularGroupMentionMode: 'never';
}

export const DEFAULT_WECOM_SESSION_MODE: WecomSessionMode = {
  p2pMode: 'chat',
  regularGroupReplyMode: 'user',
  regularGroupMentionMode: 'never',
};

export function validateWecomSessionMode(raw: unknown): WecomSessionMode {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('wecom_invalid_session_mode');
  }
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !['p2pMode', 'regularGroupReplyMode', 'regularGroupMentionMode'].includes(key))
    || input.p2pMode !== 'chat'
    || !['user', 'chat'].includes(String(input.regularGroupReplyMode))
    || input.regularGroupMentionMode !== 'never') {
    throw new Error('wecom_invalid_session_mode');
  }
  return {
    p2pMode: 'chat',
    regularGroupReplyMode: input.regularGroupReplyMode as 'user' | 'chat',
    regularGroupMentionMode: 'never',
  };
}

/** Native routing identity, disjoint from Lark app/chat identifiers. Epochs
 * prevent a later mode switch from resurrecting a stale conversation route. */
export function wecomRouteForMessage(
  message: Pick<WecomInboundMessage, 'chatType' | 'conversationId' | 'userId'>,
  policy: { sessionMode?: WecomSessionMode; sessionModeEpoch?: string },
): string {
  const shared = message.chatType === 'group' && policy.sessionMode?.regularGroupReplyMode === 'chat';
  const route: unknown[] = [message.chatType, message.conversationId, shared ? { scope: 'shared' } : message.userId];
  if (policy.sessionModeEpoch) {
    route.push(policy.sessionModeEpoch);
  }
  return JSON.stringify(route);
}

export function isSharedWecomRoute(route: string): boolean {
  try {
    return JSON.parse(route)?.[2]?.scope === 'shared';
  } catch {
    return false;
  }
}
