import type { AskQuestion, AskResult } from '../core/ask-types.js';
import { codexUserInputAnswer, parseCodexUserInputQuestions } from './codex-user-input.js';

export const CODEX_ASYNC_ASK_ORIGIN = 'native-user-input-async';
export interface CodexAsyncUserInput { threadId: string; itemId: string }

export function parseCodexAsyncUserInput(value: unknown): CodexAsyncUserInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => k !== 'threadId' && k !== 'itemId')) return undefined;
  if (typeof v.threadId !== 'string' || !v.threadId.trim() || v.threadId.length > 128
    || typeof v.itemId !== 'string' || !v.itemId.trim() || v.itemId.length > 128) return undefined;
  return { threadId: v.threadId, itemId: v.itemId };
}

/** Generated 0.162 protocol: agentMessage.delivery=async, questions have
 * title + string options. No JSON-RPC server request/reply exists for this path. */
export function parseCodexAsyncQuestions(item: unknown): AskQuestion[] {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid async question item');
  const v = item as Record<string, unknown>;
  if (v.type !== 'agentMessage' || v.delivery !== 'async' || !Array.isArray(v.questions)
    || v.questions.length === 0 || v.questions.length > 3) throw new Error('Invalid async question batch');
  return parseCodexUserInputQuestions({ questions: v.questions.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid async question');
    const q = raw as Record<string, unknown>;
    if (typeof q.title !== 'string' || !q.title.trim() || q.isSecret === true) throw new Error('Invalid async question title');
    if (q.options != null && (!Array.isArray(q.options) || q.options.some(o => typeof o !== 'string'))) {
      throw new Error('Invalid async question options');
    }
    return { id: `q${index}`, question: q.title,
      options: q.options == null ? null : (q.options as string[]).map(label => ({ label })) };
  }) }).map(q => q.question);
}

/** Match the native question reply envelope, preserving call id and index.
 * Escape XML delimiters inside JSON so user text cannot close the wrapper. */
export function codexAsyncAnswerText(
  input: CodexAsyncUserInput,
  questions: ReadonlyArray<AskQuestion>,
  result: AskResult,
): string {
  const entries = questions.map((question, index) => ({ id: `q${index}`, question }));
  const answers = codexUserInputAnswer(entries, result).answers;
  const replies = entries.map((entry, index) => ({
    questionItemId: JSON.stringify(['request_user_input_async', input.itemId, index]),
    question: entry.question.prompt,
    answer: answers[entry.id].answers.join('\n'),
  }));
  const json = JSON.stringify(replies).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<send_user_message_question_reply>\n${json}\n</send_user_message_question_reply>`;
}

/** A natural completion does not cancel a nonblocking question. Closing or
 * replacing its owning runner/session does. Capture + recheck around awaits. */
export async function deliverCodexAsyncAnswer(
  input: CodexAsyncUserInput,
  questions: ReadonlyArray<AskQuestion>,
  result: AskResult,
  deps: { isCurrent: () => boolean; deliver: (text: string, by: string) => Promise<boolean> },
): Promise<boolean> {
  if (result.kind !== 'answered' || !result.by || !deps.isCurrent()) return false;
  const text = codexAsyncAnswerText(input, questions, result);
  return deps.deliver(text, result.by);
}
