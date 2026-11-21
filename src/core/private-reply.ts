import type { Session } from '../types.js';
import { replyMessage, sendUserMessage } from '../im/lark/client.js';
import { readRoleReplyPrivately, readRolePrivateReplyNotice } from './role-resolver.js';
import { pickTurnReplyTarget } from './reply-target.js';
import { logger } from '../utils/logger.js';

// Reuse the group session and its existing per-turn sender record.
type ReplySession = Pick<Session, 'sessionId' | 'larkAppId' | 'chatId' | 'chatType' | 'scope'
  | 'rootMessageId' | 'replyTargets' | 'currentReplyTarget' | 'quoteTargetId'
  | 'quoteTargetSenderOpenId' | 'quoteTargetSenderIsBot'> & {
  turnReplyContexts?: Record<string, { replyTargetSenderIsBot?: boolean }>;
};

export function privateReplyEnabled(s: Pick<ReplySession, 'larkAppId' | 'chatId' | 'chatType' | 'scope'>): boolean {
  return s.chatType === 'group' && s.scope !== 'chat' && !!s.larkAppId
    && readRoleReplyPrivately(s.larkAppId, s.chatId);
}

/** Undefined resumes the existing group reply path, including when private delivery fails. */
export async function sendPrivateReply(
  s: ReplySession, turnId: string | undefined, content: string, msgType = 'text', uuid?: string, options?: { senderOpenId?: string; senderIsBot?: boolean; failClosed?: boolean; beforeWrite?: () => void | Promise<void> },
): Promise<string | undefined> {
  if (!privateReplyEnabled(s) || !turnId) return undefined;
  const sender = options?.senderOpenId ?? pickTurnReplyTarget(s, turnId)?.senderOpenId;
  const senderIsBot = options?.senderIsBot ?? s.turnReplyContexts?.[turnId]?.replyTargetSenderIsBot
    ?? (s.quoteTargetId === turnId && s.quoteTargetSenderIsBot);
  if (!sender?.startsWith('ou_') || senderIsBot) return undefined;
  let messageId: string;
  try {
    const args = [s.larkAppId!, sender, content, msgType, uuid] as const;
    messageId = options?.beforeWrite
      ? await sendUserMessage(...args, undefined, { beforeWrite: options.beforeWrite })
      : await sendUserMessage(...args);
  } catch (err) {
    if (options?.failClosed) throw err;
    logger.warn(`[private-reply] delivery failed for turn ${turnId}; using group reply: ${String(err)}`);
    return undefined;
  }
  const notice = readRolePrivateReplyNotice(s.larkAppId!, s.chatId);
  if (notice) {
    try {
      // A notice failure must not retry or publicly resend an already delivered answer.
      await replyMessage(s.larkAppId!, s.rootMessageId, notice, 'text', true,
        undefined, undefined, { suppressHook: true,
          ...(options?.beforeWrite ? { beforeWrite: options.beforeWrite } : {}) });
    } catch (err) {
      logger.warn(`[private-reply] notice failed after delivery ${messageId}: ${String(err)}`);
    }
  }
  return messageId;
}
