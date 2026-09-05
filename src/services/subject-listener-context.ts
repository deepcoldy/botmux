import {
  compareSubjectListenerCreateTime,
  type SubjectListenerCursor,
} from './subject-listener-cursor-store.js';
import {
  DEFAULT_SUBJECT_FALLBACK_MESSAGES,
  MAX_SUBJECT_FALLBACK_MESSAGES,
} from '../bot-registry.js';

export type SubjectListenerContinuity = 'continuous' | 'cold_start' | 'cursor_lost';

export interface SubjectListenerContextSnapshot {
  source: 'lark';
  continuity: SubjectListenerContinuity;
  /** Chronological raw Lark messages, ending with the exact trigger event. */
  messages: any[];
  candidateCursor: SubjectListenerCursor;
}

export interface SubjectListenerMessageScanOptions {
  pageSize?: number;
  stopAfter?: (message: any, seenCount: number) => boolean;
}

export type SubjectListenerListChatMessagesUntil = (
  larkAppId: string,
  chatId: string,
  options?: SubjectListenerMessageScanOptions,
) => Promise<any[]>;

export interface LoadSubjectListenerContextInput {
  larkAppId: string;
  chatId: string;
  cursor?: SubjectListenerCursor;
  fallbackMessages: number;
  /** Provider event object; this exact object wins over a delayed REST copy. */
  triggerMessage: any;
  trigger: SubjectListenerCursor;
}

export interface SubjectListenerContextDependencies {
  listChatMessagesUntil: SubjectListenerListChatMessagesUntil;
}

function messageIdOf(message: any): string {
  return String(message?.message_id ?? message?.messageId ?? '').trim();
}

function createTimeOf(message: any): string | undefined {
  const value = message?.create_time ?? message?.createTime;
  const text = value === undefined || value === null ? '' : String(value).trim();
  return /^\d+$/.test(text) ? text : undefined;
}

function isAtOrBeforeTrigger(message: any, trigger: SubjectListenerCursor): boolean {
  if (messageIdOf(message) === trigger.messageId) return true;
  const createTime = createTimeOf(message);
  return !!createTime && compareSubjectListenerCreateTime(createTime, trigger.createTime) <= 0;
}

function dedupeChronological(messages: any[]): any[] {
  const output: any[] = [];
  const positions = new Map<string, number>();
  for (const message of messages) {
    const messageId = messageIdOf(message);
    if (!messageId) {
      output.push(message);
      continue;
    }
    const existing = positions.get(messageId);
    if (existing === undefined) {
      positions.set(messageId, output.length);
      output.push(message);
    } else {
      output[existing] = message;
    }
  }
  return output;
}

/**
 * Load Subject context from Lark only. With a cursor, scan backwards until that
 * exact message is observed; if it vanished, fall back to the configured tail.
 * The exact inbound event is then de-duplicated and appended as the upper bound.
 */
export async function loadSubjectListenerContext(
  input: LoadSubjectListenerContextInput,
  dependencies: SubjectListenerContextDependencies,
): Promise<SubjectListenerContextSnapshot> {
  const fallbackMessages = Number.isInteger(input.fallbackMessages) && input.fallbackMessages > 0
    ? Math.min(input.fallbackMessages, MAX_SUBJECT_FALLBACK_MESSAGES)
    : DEFAULT_SUBJECT_FALLBACK_MESSAGES;
  if (!input.trigger.messageId || !/^\d+$/.test(input.trigger.createTime)) {
    throw new Error('Subject listener trigger requires messageId and numeric createTime');
  }
  const eventMessageId = messageIdOf(input.triggerMessage);
  if (eventMessageId && eventMessageId !== input.trigger.messageId) {
    throw new Error('Subject listener trigger does not match the exact event message');
  }
  let eligibleSeen = 0;
  const scanned = await dependencies.listChatMessagesUntil(input.larkAppId, input.chatId, {
    pageSize: 50,
    stopAfter: (message) => {
      if (input.cursor) return messageIdOf(message) === input.cursor.messageId;
      if (isAtOrBeforeTrigger(message, input.trigger)) eligibleSeen += 1;
      return eligibleSeen >= fallbackMessages;
    },
  });

  const cursorIndex = input.cursor
    ? scanned.findIndex(message => messageIdOf(message) === input.cursor?.messageId)
    : -1;
  let continuity: SubjectListenerContinuity = 'cold_start';
  if (input.cursor) {
    continuity = cursorIndex >= 0 ? 'continuous' : 'cursor_lost';
  }
  const afterCursor = continuity === 'continuous' ? scanned.slice(cursorIndex + 1) : scanned;
  const bounded = afterCursor.filter(message => isAtOrBeforeTrigger(message, input.trigger));
  const triggerId = input.trigger.messageId;
  const withExactTrigger = bounded
    .filter(message => messageIdOf(message) !== triggerId)
    .concat(input.triggerMessage);
  const deduped = dedupeChronological(withExactTrigger);
  const messages = continuity === 'continuous'
    ? deduped
    : deduped.slice(Math.max(0, deduped.length - fallbackMessages));

  return {
    source: 'lark',
    continuity,
    messages,
    candidateCursor: { ...input.trigger },
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function serializeMessage(message: any): string {
  try {
    return JSON.stringify(message) ?? 'null';
  } catch {
    return JSON.stringify({
      message_id: messageIdOf(message) || undefined,
      create_time: createTimeOf(message),
      unreadable: true,
    });
  }
}

/** Render all provider data in one explicitly untrusted envelope. */
export function renderSubjectListenerHistory(snapshot: SubjectListenerContextSnapshot): string {
  const lines = snapshot.messages.map((message, index) => {
    const messageId = messageIdOf(message);
    const createTime = createTimeOf(message);
    return [
      `  <message index="${index}"${messageId ? ` message_id="${escapeXml(messageId)}"` : ''}${createTime ? ` create_time="${escapeXml(createTime)}"` : ''}>`,
      `    ${escapeXml(serializeMessage(message))}`,
      '  </message>',
    ].join('\n');
  });
  return [
    `<lark_history trusted="false" source="lark" continuity="${snapshot.continuity}">`,
    ...lines,
    '</lark_history>',
  ].join('\n');
}
