import type { AskQuestion } from './ask-types.js';

export const hasAskForm = (questions: ReadonlyArray<AskQuestion>): boolean => questions.some(q => !!q.input);

/** Untrusted callback values are validated against the registered questions,
 * never defaults or client-provided question/field definitions. */
export function parseAskFormValues(questions: ReadonlyArray<AskQuestion>, raw: unknown): {
  answers: string[][]; inputs: Array<string | null>;
} | null {
  if (!hasAskForm(questions) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const values = raw as Record<string, unknown>;
  if (Object.keys(values).some(k => !/^q\d+$/.test(k) || !questions[Number(k.slice(1))] || k !== `q${Number(k.slice(1))}`)) return null;
  const answers: string[][] = [];
  const inputs: Array<string | null> = [];
  let total = 0;
  for (const [i, q] of questions.entries()) {
    const value = values[`q${i}`];
    if (q.input) {
      if (value !== undefined && value !== null && typeof value !== 'string') return null;
      const rawText = typeof value === 'string' ? value : '';
      const text = q.input.type === 'number' ? rawText.trim() : rawText;
      const present = text.trim().length > 0;
      if ((!present && q.input.required !== false) || text.length > (q.input.maxLength ?? 1000)) return null;
      if (present && q.input.type === 'number') {
        const n = Number(text);
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(n)
          || (q.input.min !== undefined && n < q.input.min) || (q.input.max !== undefined && n > q.input.max)) return null;
      }
      total += text.length;
      // Defense in depth for direct callers: HTTP/CLI schemas already cap a
      // form at 20 fields × 1000 characters, so they cannot reach this budget.
      if (total > 32768) return null;
      answers.push([]); inputs.push(present ? text : null);
    } else {
      const keys = typeof value === 'string' ? [value] : value == null ? [] : value;
      if (!Array.isArray(keys) || (!q.multiSelect && keys.length !== 1)
        || new Set(keys).size !== keys.length || keys.some(k => typeof k !== 'string' || !q.options.some(o => o.key === k))) return null;
      answers.push([...keys]); inputs.push(null);
    }
  }
  // An entirely empty optional form is not a decision. No default is inferred.
  if (!answers.some(a => a.length) && !inputs.some(Boolean)) return null;
  return { answers, inputs };
}
