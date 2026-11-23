import type { AskQuestion } from './ask-types.js';

/** Why a one-shot choice form cannot settle yet; `questionIndex` is the first offending question. */
export type AskChoiceProblem =
  /** A single-choice question with more than one ticked option. */
  | { kind: 'too_many'; questionIndex: number }
  /** Ticked options and written text on the same question. Every answer adapter lets a
   *  question's own text replace its keys, so keeping both would silently drop the ticks. */
  | { kind: 'option_and_text'; questionIndex: number }
  /** A single-choice or text question with neither a ticked option nor text. */
  | { kind: 'unanswered'; questionIndex: number };

/**
 * The per-question rules a submitted choice form must meet. Multi-choice questions may stay
 * empty (an all-empty form goes through the separate empty-submit confirmation). Pure: the
 * broker decides with it and the card handler words its warning with the same answer.
 */
export function askChoiceProblem(
  questions: ReadonlyArray<AskQuestion>,
  selections: ReadonlyArray<ReadonlyArray<string>>,
  texts: ReadonlyArray<string | null>,
): AskChoiceProblem | undefined {
  for (const [questionIndex, q] of questions.entries()) {
    const ticked = selections[questionIndex]?.length ?? 0;
    const text = !!texts[questionIndex];
    if (!q.multiSelect && ticked > 1) return { kind: 'too_many', questionIndex };
    if (ticked && text) return { kind: 'option_and_text', questionIndex };
    if (!q.multiSelect && !ticked && !text) return { kind: 'unanswered', questionIndex };
  }
  return undefined;
}
