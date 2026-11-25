import type { AskQuestion } from './ask-types.js';

/** Why a one-shot choice form cannot settle yet; `questionIndex` is the first offending question. */
export type AskChoiceProblem =
  /** A single-choice question with more than one ticked option. */
  | { kind: 'too_many'; questionIndex: number }
  /** A single-choice or text question with neither a ticked option nor text. */
  | { kind: 'unanswered'; questionIndex: number };

/**
 * The per-question rules a submitted choice form must meet. Text next to ticked options is a
 * note on them; text with nothing ticked is the question's own answer. Multi-choice questions may
 * stay empty (an all-empty form goes through the separate empty-submit confirmation). Pure: the
 * broker decides with it and the card handler words its warning with the same answer.
 */
export function askChoiceProblem(
  questions: ReadonlyArray<AskQuestion>,
  selections: ReadonlyArray<ReadonlyArray<string>>,
  texts: ReadonlyArray<string | null>,
): AskChoiceProblem | undefined {
  for (const [questionIndex, q] of questions.entries()) {
    const ticked = selections[questionIndex]?.length ?? 0;
    if (!q.multiSelect && ticked > 1) return { kind: 'too_many', questionIndex };
    if (!q.multiSelect && !ticked && !texts[questionIndex]) return { kind: 'unanswered', questionIndex };
  }
  return undefined;
}

/**
 * Splits each question's text by what it means: with ticked options it is a note on them
 * (`notes[i]`), with none it is the question's own answer (`customAnswers[i]`). Either array is
 * omitted when it holds no text, so a result without notes has exactly the older shape.
 */
export function splitAskTexts(selections: ReadonlyArray<ReadonlyArray<string>>, texts: ReadonlyArray<string | null>):
  { customAnswers?: Array<string | null>; notes?: Array<string | null> } {
  const own = texts.map((text, i) => text && !selections[i]?.length ? text : null);
  const notes = texts.map((text, i) => text && selections[i]?.length ? text : null);
  return { ...(own.some(Boolean) ? { customAnswers: own } : {}), ...(notes.some(Boolean) ? { notes } : {}) };
}
