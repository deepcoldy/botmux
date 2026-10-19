/** Pure question validation shared by the CLI and daemon. No runtime imports. */
import type { AskOption, AskQuestion } from './ask-types.js';

export type AskQuestionParseError =
  | 'bad_options' | 'bad_option_shape' | 'bad_option_key' | 'bad_option_label'
  | 'bad_option_description'
  | 'duplicate_option_key' | 'bad_questions' | 'bad_question_shape'
  | 'bad_multiSelect' | 'bad_defaultSelectedKeys' | 'bad_inputMode';

/** 选项说明长度上限（卡片渲染还会再截到 400 字，这里只给 IPC 兜底）。 */
const MAX_OPTION_DESCRIPTION = 1000;

/** 校验单个 option 对象，返回解析后的 AskOption 或错误码。 */
export function parseOption(o: unknown): AskOption | AskQuestionParseError {
  if (!o || typeof o !== 'object') return 'bad_option_shape';
  const oo = o as Record<string, unknown>;
  if (typeof oo.key !== 'string' || !oo.key.trim()) return 'bad_option_key';
  if (typeof oo.label !== 'string') return 'bad_option_label';
  // 可选 description（AskUserQuestion options[].description）：空白归一化为
  // undefined，非字符串/超长 fail loud，避免选项说明被静默丢弃。
  let description: string | undefined;
  if (oo.description !== undefined && oo.description !== null) {
    if (typeof oo.description !== 'string') return 'bad_option_description';
    const trimmed = oo.description.trim();
    if (trimmed.length > MAX_OPTION_DESCRIPTION) return 'bad_option_description';
    if (trimmed) description = trimmed;
  }
  return description ? { key: oo.key, label: oo.label, description } : { key: oo.key, label: oo.label };
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
    if (qq.inputMode !== undefined && qq.inputMode !== 'text') return 'bad_inputMode';
    const textOnly = qq.inputMode === 'text';
    if (textOnly && (qq.multiSelect || qq.defaultSelectedKeys !== undefined)) return 'bad_inputMode';
    if (!Array.isArray(qq.options) || (textOnly ? qq.options.length !== 0 : qq.options.length < 2)) return 'bad_options';
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
      ...(textOnly ? { inputMode: 'text' as const } : {}),
      ...(defaults !== undefined ? { defaultSelectedKeys: [...defaults as string[]] } : {}),
    });
  }
  return result;
}
