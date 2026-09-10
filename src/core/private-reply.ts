import type { Session } from '../types.js';
import { replyMessage, sendUserMessage } from '../im/lark/client.js';
import { readRoleReplyPrivately, readRolePrivateReplyNotice } from './role-resolver.js';
import { pickTurnReplyTarget } from './reply-target.js';
import { logger } from '../utils/logger.js';

// Reuse the group session and its existing per-turn sender record.
type ReplySession = Pick<Session, 'sessionId' | 'larkAppId' | 'chatId' | 'chatType' | 'scope'
  | 'rootMessageId' | 'replyTargets' | 'currentReplyTarget' | 'quoteTargetId'
  | 'quoteTargetSenderOpenId' | 'quoteTargetSenderIsBot'>;

export function privateReplyEnabled(s: Pick<ReplySession, 'larkAppId' | 'chatId' | 'chatType' | 'scope'>): boolean {
  return s.chatType === 'group' && s.scope !== 'chat' && !!s.larkAppId
    && readRoleReplyPrivately(s.larkAppId, s.chatId);
}

/** Undefined means ordinary delivery. Errors must propagate: never fall back to a public answer. */
export async function sendPrivateReply(
  s: ReplySession, turnId: string | undefined, content: string, msgType = 'text', uuid?: string,
): Promise<string | undefined> {
  if (!privateReplyEnabled(s)) return undefined;
  const sender = turnId ? pickTurnReplyTarget(s, turnId)?.senderOpenId : undefined;
  if (!sender?.startsWith('ou_') || (s.quoteTargetId === turnId && s.quoteTargetSenderIsBot)) {
    throw new Error('Private reply requires the questioner of the exact turn');
  }
  const messageId = await sendUserMessage(s.larkAppId!, sender, content, msgType, uuid);
  const notice = readRolePrivateReplyNotice(s.larkAppId!, s.chatId);
  if (notice) {
    try {
      // Only the configured text is public. A notice failure must not retry an already delivered answer.
      await replyMessage(s.larkAppId!, s.rootMessageId, notice, 'text', true,
        undefined, undefined, { suppressHook: true });
    } catch (err) {
      logger.warn(`[private-reply] notice failed after delivery ${messageId}: ${String(err)}`);
    }
  }
  return messageId;
}
