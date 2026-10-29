/** Pure question validation shared by the CLI and daemon. No runtime imports. */
import type { AskInputField, AskOption, AskQuestion } from './ask-types.js';

export type AskQuestionParseError =
  | 'bad_options' | 'bad_option_shape' | 'bad_option_key' | 'bad_option_label'
  | 'duplicate_option_key' | 'bad_questions' | 'bad_question_shape'
  | 'bad_multiSelect' | 'bad_defaultSelectedKeys' | 'bad_inputMode' | 'bad_input';

/** 校验单个 option 对象，返回解析后的 AskOption 或错误码。 */
export function parseOption(o: unknown): AskOption | AskQuestionParseError {
  if (!o || typeof o !== 'object') return 'bad_option_shape';
  const oo = o as Record<string, unknown>;
  if (typeof oo.key !== 'string' || !oo.key.trim()) return 'bad_option_key';
  if (typeof oo.label !== 'string') return 'bad_option_label';
  return { key: oo.key, label: oo.label };
}

/** 校验 questions[] 数组，返回解析后的 AskQuestion[] 或错误码。 */
export function parseAskQuestions(arr: unknown, options?: { allowSingleOption?: boolean }): AskQuestion[] | AskQuestionParseError {
  if (!Array.isArray(arr) || arr.length === 0) return 'bad_questions';
  const result: AskQuestion[] = [];
  for (const q of arr) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return 'bad_question_shape';
    const qq = q as Record<string, unknown>;
    if (typeof qq.prompt !== 'string' || !qq.prompt.trim()) return 'bad_question_shape';
    if (typeof qq.multiSelect !== 'boolean') return 'bad_multiSelect';
    if (qq.inputMode !== undefined && qq.inputMode !== 'text') return 'bad_inputMode';
    const input = qq.input === undefined ? undefined : parseInputField(qq.input);
    if (typeof input === 'string') return input;
    if (input && (qq.inputMode !== undefined || qq.multiSelect || qq.defaultSelectedKeys !== undefined)) return 'bad_input';
    const textOnly = qq.inputMode === 'text' || !!input;
    if (textOnly && (qq.multiSelect || qq.defaultSelectedKeys !== undefined)) return 'bad_inputMode';
    if (!Array.isArray(qq.options) || (textOnly ? qq.options.length !== 0 : qq.options.length < (options?.allowSingleOption ? 1 : 2))) return 'bad_options';
    const opts: AskOption[] = [];
    const seen = new Set<string>();
    for (const o of qq.options) {
      const parsed = parseOption(o);
      if (typeof parsed === 'string') return parsed;
      if (seen.has(parsed.key)) return 'duplicate_option_key';
      seen.add(parsed.key);
      opts.push(parsed);
    }
    const defaults = qq.defaultSelectedKeys;
    if (defaults !== undefined && (
      !Array.isArray(defaults) || defaults.some(key => typeof key !== 'string' || !seen.has(key))
      || new Set(defaults).size !== defaults.length || (!qq.multiSelect && defaults.length > 1)
    )) return 'bad_defaultSelectedKeys';
    result.push({ prompt: qq.prompt, multiSelect: qq.multiSelect, options: opts,
      ...(qq.inputMode === 'text' ? { inputMode: 'text' as const } : {}),
      ...(input ? { input } : {}),
      ...(defaults !== undefined ? { defaultSelectedKeys: [...defaults as string[]] } : {}),
    });
  }
  // Mixing legacy chat-only inputs with form fields has no unambiguous submit path.
  if (result.some(q => q.input) && (result.length > 20 || result.some(q => q.inputMode === 'text'))) return 'bad_input';
  return result;
}

function parseInputField(raw: unknown): AskInputField | 'bad_input' {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'bad_input';
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some(k => !['type', 'required', 'placeholder', 'maxLength', 'min', 'max'].includes(k))
    || (r.type !== 'text' && r.type !== 'number')
    || (r.required !== undefined && typeof r.required !== 'boolean')
    || (r.placeholder !== undefined && (typeof r.placeholder !== 'string' || r.placeholder.length > 100))
    || (r.maxLength !== undefined && (!Number.isInteger(r.maxLength) || Number(r.maxLength) < 1 || Number(r.maxLength) > 1000))
    || ['min', 'max'].some(k => r[k] !== undefined && (r.type !== 'number' || typeof r[k] !== 'number' || !Number.isFinite(r[k])))
    || (typeof r.min === 'number' && typeof r.max === 'number' && r.min > r.max)) return 'bad_input';
  return { type: r.type as 'text' | 'number', required: r.required !== false,
    ...(r.placeholder !== undefined ? { placeholder: r.placeholder as string } : {}),
    maxLength: r.maxLength as number | undefined ?? 1000,
    ...(r.min !== undefined ? { min: r.min as number } : {}),
    ...(r.max !== undefined ? { max: r.max as number } : {}),
  };
}

