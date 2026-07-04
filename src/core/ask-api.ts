/**
 * Pure helpers for the daemon's `POST /api/asks` IPC route.
 *
 * Kept separate from daemon.ts so the body-validator is unit-testable without
 * spinning up an HTTP server, registering bots, or mounting a full session map.
 */

import type { AskOption, AskQuestion } from './ask-types.js';

export interface AskApiBody {
  sessionId: string;
  chatId: string;
  larkAppId: string;
  rootMessageId: string | null;
  /** v0.1.8：替换旧的 options/prompt，支持多问多选。 */
  questions: AskQuestion[];
  /** Already in milliseconds. CLI side converts from `--timeout` seconds. */
  timeoutMs: number;
}

export type AskApiBodyError =
  | 'bad_body'
  | 'bad_sessionId'
  | 'bad_chatId'
  | 'bad_larkAppId'
  | 'bad_rootMessageId'
  | 'bad_prompt'
  | 'bad_timeoutMs'
  | 'bad_options'
  | 'bad_option_shape'
  | 'bad_option_key'
  | 'bad_option_label'
  | 'duplicate_option_key'
  | 'bad_questions'
  | 'bad_question_shape'
  | 'bad_multiSelect';

/** 校验单个 option 对象，返回解析后的 AskOption 或错误码。 */
function parseOption(o: unknown): AskOption | AskApiBodyError {
  if (!o || typeof o !== 'object') return 'bad_option_shape';
  const oo = o as Record<string, unknown>;
  if (typeof oo.key !== 'string' || !oo.key.trim()) return 'bad_option_key';
  if (typeof oo.label !== 'string') return 'bad_option_label';
  return { key: oo.key, label: oo.label };
}

/** 校验 questions[] 数组，返回解析后的 AskQuestion[] 或错误码。 */
function parseQuestions(arr: unknown[]): AskQuestion[] | AskApiBodyError {
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
    result.push({ prompt: qq.prompt, multiSelect: qq.multiSelect, options: opts });
  }
  return result;
}

/** Validate the request body. Returns either the parsed body or an error code
 *  ready to be sent back as `{ ok: false, error }` with HTTP 400.
 *
 *  v0.1.8：
 *  - 优先识别 `questions[]` 新格式（多问多选）。
 *  - 兼容旧的 `options[]` + `prompt` 格式，归一化为单问单选的 questions[]。
 *  - 两者都没有则返回 `bad_options`。 */
export function parseAskBody(raw: unknown): AskApiBody | { error: AskApiBodyError } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'bad_body' };
  const r = raw as Record<string, unknown>;

  if (typeof r.sessionId !== 'string' || !r.sessionId.trim()) return { error: 'bad_sessionId' };
  if (typeof r.chatId !== 'string' || !r.chatId.trim()) return { error: 'bad_chatId' };
  if (typeof r.larkAppId !== 'string' || !r.larkAppId.trim()) return { error: 'bad_larkAppId' };
  if (r.rootMessageId !== null && typeof r.rootMessageId !== 'string') {
    return { error: 'bad_rootMessageId' };
  }
  if (
    typeof r.timeoutMs !== 'number' ||
    !Number.isFinite(r.timeoutMs) ||
    r.timeoutMs < 1000
  ) {
    return { error: 'bad_timeoutMs' };
  }

  let questions: AskQuestion[];

  if (Array.isArray(r.questions)) {
    // 新格式：questions[] 多问多选
    if (r.questions.length === 0) return { error: 'bad_questions' };
    const parsed = parseQuestions(r.questions);
    if (typeof parsed === 'string') return { error: parsed };
    questions = parsed;
  } else if (Array.isArray(r.options) && typeof r.prompt === 'string' && r.prompt.trim()) {
    // 旧格式兼容：options[] + prompt → 归一化为单问单选
    if (r.options.length < 2) return { error: 'bad_options' };
    const opts: AskOption[] = [];
    const seen = new Set<string>();
    for (const o of r.options) {
      const parsed = parseOption(o);
      if (typeof parsed === 'string') return { error: parsed };
      if (seen.has(parsed.key)) return { error: 'duplicate_option_key' };
      seen.add(parsed.key);
      opts.push(parsed);
    }
    questions = [{ prompt: r.prompt, multiSelect: false, options: opts }];
  } else {
    // 旧格式：仅有 prompt 校验（无 options 或 options 不合法）
    if (typeof r.prompt !== 'string' || !r.prompt.trim()) return { error: 'bad_prompt' };
    if (!Array.isArray(r.options) || r.options.length < 2) return { error: 'bad_options' };
    // 走到这里说明 options 是数组但长度不足，上面已处理，此处不可达
    return { error: 'bad_options' };
  }

  return {
    sessionId: r.sessionId,
    chatId: r.chatId,
    larkAppId: r.larkAppId,
    rootMessageId: r.rootMessageId as string | null,
    questions,
    timeoutMs: r.timeoutMs,
  };
}
