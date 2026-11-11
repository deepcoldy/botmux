import type { Session } from '../types.js';

/** Internal post-commit signal. Consumers cannot mint or move a conversation.
 * Runtime/profile changes are not new business tasks. */
export type ProjectAssociationEvent = {
  sessionId: string; larkAppId: string; chatId: string; rootMessageId: string;
  status: string; scope: 'chat' | 'thread';
};
let consumer: ((event: ProjectAssociationEvent) => void) | undefined;
export function setProjectAssociationConsumer(value: typeof consumer): void { consumer = value; }
export function noteProjectAssociationChanged(session: Session): void {
  if (!session.larkAppId) return;
  try {
    consumer?.({
      sessionId: session.sessionId, larkAppId: session.larkAppId,
      chatId: session.chatId, rootMessageId: session.rootMessageId,
      status: session.status, scope: session.scope ?? 'thread',
    });
  } catch { /* A projection fault must not roll back an already committed route. */ }
}
