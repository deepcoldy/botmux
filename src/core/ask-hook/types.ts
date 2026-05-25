import type { AskQuestion } from '../ask-types.js';

/** adapter 解析一个 hook payload 后得到的问题列表和原始上下文。 */
export interface ParsedAsk {
  questions: AskQuestion[];
  /** adapter 私有的原始上下文，formatAnswer 用来重建 directive。 */
  raw: unknown;
}

/**
 * 每家 CLI 的 hook adapter 接口。
 *
 * - parseQuestions：非 askUserQuestion 事件返回 null（hook 客户端据此输出"放行"directive）。
 * - formatAnswer：把用户答案映射回该 CLI 所期望的 directive JSON 字符串。
 * - passthrough：hook 接管失败时的"放行/无操作" directive，让 CLI 回退原生终端提问。
 */
export interface HookAskAdapter {
  /** 非 askUserQuestion 事件返回 null（hook 客户端据此输出"放行"directive）。 */
  parseQuestions(payload: unknown): ParsedAsk | null;

  /**
   * answersByQuestion[i] = questions[i] 选中的 key 数组。
   * 返回写回 CLI 的 directive JSON 字符串。
   */
  formatAnswer(answersByQuestion: ReadonlyArray<ReadonlyArray<string>>, parsed: ParsedAsk): string;

  /** hook 接管失败时的"放行/无操作" directive（让 CLI 回退原生终端提问）。 */
  passthrough(payload: unknown): string;
}
