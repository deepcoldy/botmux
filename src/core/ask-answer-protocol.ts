/**
 * Wire protocol used by an agent to answer a pending BotMux ask without
 * relying on the visible text of its reply card. The CLI emits this as a
 * native text message so Lark cannot append reply-card footer chrome to the
 * semantic value.
 */
import type { AskAnswerActor } from './ask-broker.js';
import type { AskClickOutcome, PendingAsk } from './ask-types.js';

export const ASK_ANSWER_COMMAND = '/botmux-ask-answer';

const ASK_ANSWER_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export function isValidAskAnswerKey(value: string | undefined): value is string {
  return !!value && ASK_ANSWER_KEY_RE.test(value);
}

export function formatAskAnswerCommand(key: string): string {
  if (!isValidAskAnswerKey(key)) throw new Error(`invalid ask answer key: ${key}`);
  return `${ASK_ANSWER_COMMAND} ${key}`;
}

/**
 * Address a structured answer back to the exact bot that opened this turn.
 * The target open_id comes from the sender snapshot observed by the answering
 * bot's own app, so it is already in the correct app-scoped identity domain.
 */
export function formatAddressedAskAnswerCommand(key: string, targetOpenId: string): string {
  if (!/^ou_[A-Za-z0-9_-]{1,128}$/.test(targetOpenId)) {
    throw new Error(`invalid ask answer target: ${targetOpenId}`);
  }
  return `<at user_id="${targetOpenId}"></at> ${formatAskAnswerCommand(key)}`;
}

export function parseAskAnswerCommand(text: string): string | undefined {
  const match = /^\/botmux-ask-answer\s+([^\s]+)\s*$/.exec(text.trim());
  return isValidAskAnswerKey(match?.[1]) ? match![1] : undefined;
}

/**
 * Legacy human free-text matching remains intentionally separate from the
 * structured agent protocol. It accepts only the explicit labels used by the
 * host-owned XPI asks; arbitrary prose must not settle those asks.
 */
export function allowsHumanAskChoiceText(originKind: string | undefined, text: string): boolean {
  const value = text.trim();
  return originKind === 'host_cross_principal_classification'
    ? /^(?:独立任务|对\s*A\s*的建议|建议)$/i.test(value)
    : originKind === 'host_cross_principal_wait'
      ? /^(?:继续等待|独立任务)$/i.test(value)
      : originKind === 'host_cross_principal_owner'
        ? /^(?:采纳并重新执行|不采纳|采纳|同意|拒绝)$/i.test(value)
        : true;
}

export type StructuredAskAnswerResult =
  | { kind: 'not_protocol' }
  | { kind: 'no_pending'; key: string }
  | { kind: 'unsupported_multi_question'; key: string }
  | { kind: 'submitted'; key: string; outcome: AskClickOutcome };

/**
 * Resolve the reserved command directly into an ask-broker option selection.
 * Human-readable labels and custom-reply matching deliberately never enter
 * this path; callers can mutate those matchers without changing the result.
 */
export function submitStructuredAskAnswer(args: {
  text: string;
  by: string;
  actor?: AskAnswerActor;
  findPending: () => PendingAsk | undefined;
  submit: (input: {
    askId: string;
    nonce: string;
    by: string;
    selections: ReadonlyArray<ReadonlyArray<string>>;
    actor?: AskAnswerActor;
  }) => AskClickOutcome;
}): StructuredAskAnswerResult {
  const key = parseAskAnswerCommand(args.text);
  if (!key) return { kind: 'not_protocol' };
  const pending = args.findPending();
  if (!pending) return { kind: 'no_pending', key };
  // The wire command carries exactly one option key and therefore cannot
  // faithfully represent answers for more than one question. Fail closed
  // before touching the broker: submitting [[key]] would otherwise pad every
  // trailing multi-select question with [] and silently settle the whole ask.
  if (pending.questions.length > 1) return { kind: 'unsupported_multi_question', key };
  return {
    kind: 'submitted',
    key,
    outcome: args.submit({
      askId: pending.askId,
      nonce: pending.nonce,
      by: args.by,
      selections: [[key]],
      actor: args.actor,
    }),
  };
}
