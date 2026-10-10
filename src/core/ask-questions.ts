/** Pure question validation shared by the CLI and daemon. No runtime imports. */
import type { AskOption, AskQuestion } from './ask-types.js';

export type AskQuestionParseError =
  | 'bad_options' | 'bad_option_shape' | 'bad_option_key' | 'bad_option_label'
  | 'duplicate_option_key' | 'bad_questions' | 'bad_question_shape'
  | 'bad_multiSelect' | 'bad_defaultSelectedKeys';

/** 校验单个 option 对象，返回解析后的 AskOption 或错误码。 */
export function parseOption(o: unknown): AskOption | AskQuestionParseError {
  if (!o || typeof o !== 'object') return 'bad_option_shape';
  const oo = o as Record<string, unknown>;
  if (typeof oo.key !== 'string' || !oo.key.trim()) return 'bad_option_key';
  if (typeof oo.label !== 'string') return 'bad_option_label';
  return { key: oo.key, label: oo.label };
}

/** 校验 questions[] 数组，返回解析后的 AskQuestion[] 或错误码。 */
export function parseAskQuestions(arr: unknown): AskQuestion[] | AskQuestionParseError {
  if (!Array.isArray(arr) || arr.length === 0) return 'bad_questions';
  const result: AskQuestion[] = [];
  for (const q of arr) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) return 'bad_question_shape';
    const qq = q as Record<string, unknown>;
    if (typeof qq.prompt !== 'string' || !qq.prompt.trim()) return 'bad_question_shape';
    if (typeof qq.multiSelect !== 'boolean') return 'bad_multiSelect';
    if (!Array.isArray(qq.options) || qq.options.length < 2) return 'bad_options';
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
      ...(defaults !== undefined ? { defaultSelectedKeys: [...defaults as string[]] } : {}),
    });
  }
  return result;
}

