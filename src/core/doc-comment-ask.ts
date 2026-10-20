import type { AskDeliveryTarget } from './ask-types.js';

interface DocumentAskSession {
  larkAppId: string;
  chatId: string;
  session: {
    docCommentTargets?: Record<string, {
      fileToken: string; commentId: string; replyToOpenId?: string; turnId: string;
    }>;
  };
}

/** The authenticated daemon supplies the session and exact turn. Never infer a
 * recipient from owner/lastCaller or accept a recipient from the agent's JSON. */
export async function resolveDocumentAskDelivery(
  ds: DocumentAskSession,
  turnId: unknown,
  verifyRecipient: (larkAppId: string, openId: string) => Promise<boolean>,
): Promise<AskDeliveryTarget | undefined> {
  if (!ds.chatId.startsWith('doc:')) return undefined;
  const source = typeof turnId === 'string' ? ds.session.docCommentTargets?.[turnId] : undefined;
  if (!source || source.turnId !== turnId || !source.fileToken || !source.commentId
    || !source.replyToOpenId?.startsWith('ou_')) {
    throw new Error('Confirmation card cannot be delivered: no verified document-turn recipient');
  }
  // Copy before awaiting a lookup: a newer comment must not retarget this ask.
  const target: AskDeliveryTarget = {
    kind: 'document-author', openId: source.replyToOpenId,
    turnId: source.turnId, fileToken: source.fileToken, commentId: source.commentId,
  };
  if (!await verifyRecipient(ds.larkAppId, target.openId)) {
    throw new Error('Confirmation card cannot be delivered: document recipient is unavailable or unauthorized');
  }
  return target;
}
