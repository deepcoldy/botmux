import type { AskQuestion, CliPermissionOutcome } from '../ask-types.js';

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
   * `comment` 为用户自定义回复原文（话题里直接打字作答）；按钮选择时为 null/缺省。
   * 没有任何选中项的问题，若 comment 非空则回落到 comment（替代语义）。
   * 返回写回 CLI 的 directive JSON 字符串。
   */
  formatAnswer(
    answersByQuestion: ReadonlyArray<ReadonlyArray<string>>,
    parsed: ParsedAsk,
    comment?: string | null,
    customAnswers?: ReadonlyArray<string | null>,
  ): string;

  /** hook 接管失败时的"放行/无操作" directive（让 CLI 回退原生终端提问）。 */
  passthrough(payload: unknown): string;

  /**
   * 可选：CLI 即将弹出终端权限确认框（Claude `PermissionRequest`，含 bypass 模式下
   * 仍会触发的「Dangerous rm」这类内置安全检查）时，把它转成一问两选（允许/拒绝）。
   * 非权限确认事件返回 null。未实现 = 该 CLI 不桥接权限确认。
   */
  parsePermissionRequest?(payload: unknown, env?: Record<string, string | undefined>): ParsedAsk | null;

  /** 可选：把权限裁决写回 CLI 期望的 directive；deny 时 message 会回给模型。 */
  formatPermissionDecision?(allow: boolean, message?: string): string;

  /**
   * 可选：从 CLI 自己落盘的确定记录里观察这次权限确认是否已被 CLI 自行了结（内置超时
   * 自动拒绝、终端里选了允许/拒绝）。无法唯一定位这次确认时返回 null，hook 照旧只等卡片。
   */
  createPermissionOutcomeWatcher?(payload: unknown): PermissionOutcomeWatcher | null;
}

export interface PermissionOutcomeWatcher {
  /** 读取新增记录；CLI 已了结这次确认时返回结局，否则 null。 */
  scan(): CliPermissionOutcome | null;
}

/** 权限确认问题里两个选项的稳定 key（hook 客户端据此判定裁决）。 */
export const PERMISSION_ALLOW_KEY = 'allow';
export const PERMISSION_DENY_KEY = 'deny';

/** hook 发起的「允许 / 拒绝」权限确认卡（区别于 AskUserQuestion 提问卡和显式 botmux ask）。
 *  提问卡的选项没有独立 key 时用 label 充当，可能恰好是 allow / deny；权限卡总是关掉自定义输入。 */
export function isHookPermissionAsk(ask: { originKind?: string; questions: ReadonlyArray<AskQuestion> }): boolean {
  return ask.originKind === 'hook' && ask.questions.length === 1 && ask.questions[0]!.allowCustom === false
    && ask.questions[0]!.options.map(o => o.key).join('\n') === `${PERMISSION_ALLOW_KEY}\n${PERMISSION_DENY_KEY}`;
}
