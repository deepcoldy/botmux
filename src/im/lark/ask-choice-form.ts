import type { AskQuestion } from '../../core/ask-types.js';

/**
 * Reads the option part of a submitted Ask form. A checker is `opt_<question>_<option>`; the
 * dropdown fallback of a very large Ask is `pick_<question>`. Every other field (own-answer
 * `custom_<i>`, input `q<i>`) is passed through for its own validator.
 *
 * Feishu does not document what a checker inside a form submits; a live trial (2026-11) showed a
 * JSON boolean per checker. The value is still read tolerantly: booleans, boolean-like strings and
 * numbers, or an object with `checked`; an absent checker is unticked. Any other shape is
 * `unreadable` (fail closed: never guess a tick).
 */
export type AskChoiceFormValue =
  | { kind: 'ok'; selections: string[][]; fields: Record<string, unknown>; sawChoiceField: boolean }
  | { kind: 'stale' }
  | { kind: 'unreadable'; fieldTypes: Record<string, string> };

const TRUE = new Set(['true', '1', 'checked', 'on', 'yes']);
const FALSE = new Set(['false', '0', 'unchecked', 'off', 'no', '']);

function ticked(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1 ? true : raw === 0 ? false : undefined;
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase();
    return TRUE.has(text) ? true : FALSE.has(text) ? false : undefined;
  }
  if (typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, 'checked')) {
    return ticked((raw as { checked: unknown }).checked);
  }
  return undefined;
}

function picked(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) return raw;
  return undefined;
}

/** Field name → value type, never the value: safe to log for diagnosing the wire shape. */
export function formValueTypes(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name,
    item === null ? 'null' : Array.isArray(item) ? `array<${[...new Set(item.map(v => typeof v))].join('|')}>` : typeof item]));
}

export function parseAskChoiceFormValue(questions: ReadonlyArray<AskQuestion>, formValue: unknown): AskChoiceFormValue {
  const values = formValue && typeof formValue === 'object' && !Array.isArray(formValue) ? formValue as Record<string, unknown> : {};
  const chosen = questions.map(() => new Set<string>());
  const fields: Record<string, unknown> = {};
  let sawChoiceField = false;
  for (const [name, raw] of Object.entries(values)) {
    const checker = /^opt_(0|[1-9]\d*)_(0|[1-9]\d*)$/.exec(name);
    const pick = /^pick_(0|[1-9]\d*)$/.exec(name);
    if (checker) {
      const option = questions[Number(checker[1])]?.options[Number(checker[2])];
      if (!option) return { kind: 'stale' };
      const on = ticked(raw);
      if (on === undefined) return { kind: 'unreadable', fieldTypes: formValueTypes(values) };
      if (on) chosen[Number(checker[1])]!.add(option.key);
      sawChoiceField = true;
    } else if (pick) {
      const question = questions[Number(pick[1])];
      if (!question?.options.length) return { kind: 'stale' };
      const keys = picked(raw);
      if (!keys) return { kind: 'unreadable', fieldTypes: formValueTypes(values) };
      if (keys.some(key => !question.options.some(o => o.key === key))) return { kind: 'stale' };
      for (const key of keys) chosen[Number(pick[1])]!.add(key);
      sawChoiceField = true;
    } else if (/^(?:opt|pick)_/.test(name)) {
      return { kind: 'stale' };
    } else {
      fields[name] = raw;
    }
  }
  // Option order, not field order: answers are deterministic whatever order the client sends.
  const selections = questions.map((q, i) => q.options.filter(o => chosen[i]!.has(o.key)).map(o => o.key));
  return { kind: 'ok', selections, fields, sawChoiceField };
}
