import type { AskQuestion } from './ask-types.js';

export const hasAskForm = (questions: ReadonlyArray<AskQuestion>): boolean => questions.some(q => !!q.input);

/** Count CHARACTERS (Unicode code points), matching the Feishu client's
 *  `max_length` accounting. `string.length` counts UTF-16 code units, so a
 *  surrogate-pair character (emoji / rare CJK) counts double and the daemon
 *  would reject input the client accepted and let the user submit. */
const charCount = (text: string): number => {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of text) n += 1;
  return n;
};

/** Why a submitted input form was refused, naming the first question at fault.
 *  `unanswered`: required field empty or single choice without a pick; `too_many`: a single
 *  choice with several picks; `invalid_input`: a field outside its format, range or length. */
export type AskFormProblem = { kind: 'unanswered' | 'too_many' | 'invalid_input'; questionIndex: number };

type AskFormCheck =
  | { ok: true; answers: string[][]; inputs: Array<string | null> }
  | { ok: false; problem?: AskFormProblem };

/** Untrusted callback values are validated against the registered questions,
 * never defaults or client-provided question/field definitions. */
export function checkAskFormValues(questions: ReadonlyArray<AskQuestion>, raw: unknown): AskFormCheck {
  const refuse = (problem?: AskFormProblem): AskFormCheck => problem ? { ok: false, problem } : { ok: false };
  if (!hasAskForm(questions) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse();
  const values = raw as Record<string, unknown>;
  if (Object.keys(values).some(k => !/^q\d+$/.test(k) || !questions[Number(k.slice(1))] || k !== `q${Number(k.slice(1))}`)) return refuse();
  const answers: string[][] = [];
  const inputs: Array<string | null> = [];
  let total = 0;
  for (const [questionIndex, q] of questions.entries()) {
    const value = values[`q${questionIndex}`];
    if (q.input) {
      if (value !== undefined && value !== null && typeof value !== 'string') return refuse();
      const rawText = typeof value === 'string' ? value : '';
      const text = q.input.type === 'number' ? rawText.trim() : rawText;
      const present = text.trim().length > 0;
      if (!present && q.input.required !== false) return refuse({ kind: 'unanswered', questionIndex });
      if (charCount(text) > (q.input.maxLength ?? 1000)) return refuse({ kind: 'invalid_input', questionIndex });
      if (present && q.input.type === 'number') {
        const n = Number(text);
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(n)
          || (q.input.min !== undefined && n < q.input.min) || (q.input.max !== undefined && n > q.input.max)) {
          return refuse({ kind: 'invalid_input', questionIndex });
        }
      }
      total += charCount(text);
      // Defense in depth for direct callers: HTTP/CLI schemas already cap a
      // form at 20 fields × 1000 characters, so they cannot reach this budget.
      if (total > 32768) return refuse();
      answers.push([]); inputs.push(present ? text : null);
    } else {
      const keys = typeof value === 'string' ? [value] : value == null ? [] : value;
      if (!Array.isArray(keys) || new Set(keys).size !== keys.length
        || keys.some(k => typeof k !== 'string' || !q.options.some(o => o.key === k))) return refuse();
      if (!q.multiSelect && keys.length !== 1) return refuse({ kind: keys.length ? 'too_many' : 'unanswered', questionIndex });
      answers.push([...keys]); inputs.push(null);
    }
  }
  // An entirely empty optional form is not a decision. No default is inferred.
  if (!answers.some(a => a.length) && !inputs.some(Boolean)) return refuse();
  return { ok: true, answers, inputs };
}

export function parseAskFormValues(questions: ReadonlyArray<AskQuestion>, raw: unknown): {
  answers: string[][]; inputs: Array<string | null>;
} | null {
  const checked = checkAskFormValues(questions, raw);
  return checked.ok ? { answers: checked.answers, inputs: checked.inputs } : null;
}
