import { DEFAULT_SUBJECT_FALLBACK_MESSAGES } from '../bot-registry.js';
import type { ChatContext } from '../types.js';
import {
  loadSubjectListenerContext,
  type SubjectListenerListChatMessagesUntil,
} from './subject-listener-context.js';
import type { SubjectListenerCursor } from './subject-listener-cursor-store.js';
import {
  renderMessageListenerPrompt,
  type MessageListenerMatch,
} from './message-listener.js';

export interface SubjectListenerResolvedSender {
  openId: string;
  type: 'user' | 'bot';
  name?: string;
  email?: string;
}

export interface PrepareSubjectListenerTurnInput {
  larkAppId: string;
  chatId: string;
  chatType: string;
  messageId: string;
  triggerMessage: any;
  messageListener: MessageListenerMatch;
  senderOpenId?: string;
  senderType?: string;
  dataDir: string;
}

export interface PrepareSubjectListenerTurnDependencies {
  resolveSender: (
    larkAppId: string,
    openId: string | undefined,
    senderType: string | undefined,
    hint?: { name?: string; type?: 'user' | 'bot'; messageId?: string },
  ) => Promise<SubjectListenerResolvedSender | undefined>;
  getChatContext: (larkAppId: string, chatId: string) => Promise<ChatContext>;
  readSubjectListenerCursor: (
    dataDir: string,
    larkAppId: string,
    chatId: string,
  ) => SubjectListenerCursor | undefined;
  listChatMessagesUntil: SubjectListenerListChatMessagesUntil;
}

export interface PreparedSubjectListenerTurn {
  prompt: string;
  chatContext: ChatContext;
  resolvedSender?: SubjectListenerResolvedSender;
  candidateCursor: SubjectListenerCursor;
}

/**
 * Prepare one ambient Subject turn from authoritative Lark event facts.
 * Session creation, worker dispatch, completion settlement, and cursor writes
 * remain the daemon/worker execution lane's responsibility.
 */
export async function prepareSubjectListenerTurn(
  input: PrepareSubjectListenerTurnInput,
  dependencies: PrepareSubjectListenerTurnDependencies,
): Promise<PreparedSubjectListenerTurn> {
  const { messageListener, messageId } = input;
  const trigger = messageListener.trigger;
  const eventMessageId = String(
    input.triggerMessage?.message_id ?? input.triggerMessage?.messageId ?? '',
  ).trim();
  const eventCreateTime = String(
    input.triggerMessage?.create_time ?? input.triggerMessage?.createTime ?? '',
  ).trim();
  if (input.chatType !== 'group'
    || messageListener.behavior !== 'subject'
    || trigger.messageId !== messageId
    || !eventMessageId
    || eventMessageId !== messageId
    || !trigger.createTime
    || !/^\d+$/.test(trigger.createTime)
    || !eventCreateTime
    || !/^\d+$/.test(eventCreateTime)
    || eventCreateTime !== trigger.createTime) {
    throw new Error('Subject listener requires an exact numeric Lark group trigger');
  }

  const resolvedSender = await dependencies.resolveSender(
    input.larkAppId,
    input.senderOpenId,
    input.senderType,
    { messageId },
  );
  const promptMatch = !messageListener.senderName && resolvedSender?.name
    ? { ...messageListener, senderName: resolvedSender.name }
    : messageListener;
  const chatContext = await dependencies.getChatContext(input.larkAppId, input.chatId);
  const priorCursor = dependencies.readSubjectListenerCursor(
    input.dataDir,
    input.larkAppId,
    input.chatId,
  );
  const snapshot = await loadSubjectListenerContext({
    larkAppId: input.larkAppId,
    chatId: input.chatId,
    cursor: priorCursor,
    fallbackMessages: messageListener.subjectPolicy?.context.fallbackMessages
      ?? DEFAULT_SUBJECT_FALLBACK_MESSAGES,
    triggerMessage: input.triggerMessage,
    trigger: { messageId: trigger.messageId, createTime: trigger.createTime },
  }, { listChatMessagesUntil: dependencies.listChatMessagesUntil });

  return {
    prompt: renderMessageListenerPrompt(promptMatch, {
      chatId: input.chatId,
      chatName: chatContext.name ?? undefined,
      chatDescription: chatContext.description ?? undefined,
      snapshot,
    }),
    chatContext,
    resolvedSender,
    candidateCursor: snapshot.candidateCursor,
  };
}
