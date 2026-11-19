import type { Session } from '../types.js';

export interface SilentMessageListenerRun {
  sourceMessageId: string;
  replyMode: 'none';
}

/** Internal route only; never a Lark message/chat id. */
export function messageListenerTaskAnchor(messageId: string): string {
  return `ml:${messageId}`;
}

export function isMessageListenerTaskAnchor(anchor: string | undefined): boolean {
  return anchor?.startsWith('ml:') === true;
}

/** Frozen at birth. No TTL: trailing worker events and restore stay quiet. */
export function isSilentMessageListenerSession(
  session: Pick<Session, 'messageListenerRun' | 'rootMessageId'>,
): boolean {
  return session.messageListenerRun?.replyMode === 'none'
    || isMessageListenerTaskAnchor(session.rootMessageId);
}

/** A real destination remains available for the task's existing send tools. */
export function messageListenerSendBlocked(
  session: Pick<Session, 'messageListenerRun' | 'rootMessageId' | 'chatId'>,
  destinationChatId: string | undefined,
): boolean {
  return isSilentMessageListenerSession(session)
    && (!destinationChatId || destinationChatId === session.chatId);
}
