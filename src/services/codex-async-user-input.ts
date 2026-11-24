import type { AskQuestion, AskResult } from '../core/ask-types.js';
import { NATIVE_ASYNC_ASK_ORIGIN, NATIVE_ASYNC_RESTORE_ASK_ORIGIN } from '../core/ask-types.js';
import { codexUserInputAnswer } from './codex-user-input.js';
import type { CodexAppTurnInput } from '../types.js';

export const CODEX_ASYNC_ASK_ORIGIN = NATIVE_ASYNC_ASK_ORIGIN;
/** A card restored after a worker restart is a NEW broker identity. The dead
 *  worker's ask may still be retained as an invalidated terminal under the
 *  original key; re-registering that key would return the stale result and
 *  never post a card. */
export const CODEX_ASYNC_RESTORE_ASK_ORIGIN = NATIVE_ASYNC_RESTORE_ASK_ORIGIN;

export function isCodexAsyncAskOrigin(originKind: string | undefined): boolean {
  return originKind === CODEX_ASYNC_ASK_ORIGIN || originKind === CODEX_ASYNC_RESTORE_ASK_ORIGIN;
}
export interface CodexAsyncUserInput { threadId: string; itemId: string; nativeTurnId?: string }

export function parseCodexAsyncUserInput(value: unknown): CodexAsyncUserInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => k !== 'threadId' && k !== 'itemId' && k !== 'nativeTurnId')) return undefined;
  if (typeof v.threadId !== 'string' || !v.threadId.trim() || v.threadId.length > 128
    || typeof v.itemId !== 'string' || !v.itemId.trim() || v.itemId.length > 128) return undefined;
  if (v.nativeTurnId !== undefined && (typeof v.nativeTurnId !== 'string'
    || !v.nativeTurnId.trim() || v.nativeTurnId.length > 128)) return undefined;
  return { threadId: v.threadId, itemId: v.itemId,
    ...(typeof v.nativeTurnId === 'string' ? { nativeTurnId: v.nativeTurnId } : {}) };
}

export interface CodexAsyncAnswerSteerFacts {
  answerer: string; originalAnswerer?: string; human: boolean;
  managedLark: boolean; cleanInputAccepted: boolean;
}

/** A proven human answer remains interactive after it starts its own turn,
 * including answers from legacy cards without a native target. This grant
 * alone never permits inserting that answer into an unrelated native turn. */
export function codexAsyncAnswerSteerable(facts: CodexAsyncAnswerSteerFacts): boolean {
  return facts.human && facts.managedLark && facts.cleanInputAccepted
    && facts.originalAnswerer === facts.answerer;
}

/** In-turn answer delivery additionally requires its original native target. */
export function codexAsyncAnswerSteerTarget(input: CodexAsyncUserInput, facts: CodexAsyncAnswerSteerFacts): string | undefined {
  return codexAsyncAnswerSteerable(facts) ? input.nativeTurnId : undefined;
}

/** A TUI Codex launch has no app-server input channel: the native question
 *  reply envelope must reach its composer verbatim. Botmux's role and
 *  formatting blocks would wrap it and break the correlation. codex-app and
 *  the hybrid RPC mode keep the structured input. */
export function codexAsyncAnswerNeedsRawInput(
  cliId: string | null | undefined, codexRpcInput: boolean | undefined,
): boolean {
  return cliId === 'codex' && codexRpcInput !== true;
}

/** Which Codex launches may register an async question card. codex-app and a
 *  TUI codex launch both have a reply path; the hybrid RPC mode is excluded
 *  because its app-server handler owns the same item. */
export function codexAsyncAskOriginEligible(
  cliId: string | null | undefined, codexRpcInput: boolean | undefined,
): boolean {
  return cliId === 'codex-app' || codexAsyncAnswerNeedsRawInput(cliId, codexRpcInput);
}

/** This only narrows an existing daemon steer grant. A synthetic async answer
 * without its target (e.g. a legacy card or a stripped sidecar) stays serial. */
export function codexAsyncSteerTargetMatches(
  replyTurnId: string | undefined, input: CodexAppTurnInput | undefined, nativeTurnId: string | undefined,
): boolean {
  const target = input?.steerTargetTurnId;
  if (!target) return !replyTurnId?.startsWith('codex-async-answer-');
  return nativeTurnId !== undefined && target === nativeTurnId;
}

/** Generated 0.162 protocol: agentMessage.delivery=async, questions have
 * title + string options. No JSON-RPC server request/reply exists for this path. */
export function parseCodexAsyncQuestions(item: unknown): AskQuestion[] {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid async question item');
  const v = item as Record<string, unknown>;
  if (v.type !== 'agentMessage' || v.delivery !== 'async' || !Array.isArray(v.questions)
    || v.questions.length === 0) throw new Error('Invalid async question batch');
  return v.questions.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid async question');
    const q = raw as Record<string, unknown>;
    if (typeof q.title !== 'string' || !q.title.trim() || q.isSecret === true) throw new Error('Invalid async question title');
    if (q.options == null) return { prompt: q.title, inputMode: 'text' as const, multiSelect: false, options: [] };
    if (!Array.isArray(q.options) || !q.options.length || q.options.some(o => typeof o !== 'string')) {
      throw new Error('Invalid async question options');
    }
    // Native options are labels, not keys: index keys preserve even identical
    // (or empty) labels without introducing ambiguous broker identities.
    return { prompt: q.title, multiSelect: false,
      options: q.options.map((label, index) => ({ key: `o${index}`, label: label as string })) };
  });
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
    question: [...entry.question.prompt.replace(/[\r\n]/g, ' ')].slice(0, 512).join(''),
    answer: (result.kind === 'answered' && result.answers?.[index]?.length
      ? answers[entry.id].answers.map(value => entry.question.options.find(o => o.key === value)?.label ?? value)
      : answers[entry.id].answers).join('\n'),
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
