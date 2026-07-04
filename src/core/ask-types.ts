/**
 * Public types for `botmux ask` (v0.1.8).
 *
 * See `/tmp/botmux-ask.md` for the full design. This module is import-safe for
 * both the daemon side (broker, card builder, click handler) and the CLI side
 * (`botmux ask buttons` subcommand) — no runtime cross-imports.
 */

/** A single selectable option on an ask card. `key` is the stable identifier
 *  returned via stdout; `label` is the human-facing button text. When the user
 *  writes `--options "yes,no"`, `key === label`. With `--options "yes=继续"`,
 *  `key="yes"` and `label="继续"`. */
export interface AskOption {
  key: string;
  label: string;
}

/** 多问多选模型中一个问题的描述。`key` 是问题的稳定标识符（可选，默认用序号），
 *  `label` 是人类可读的标题（暂保留向后兼容），`prompt` 是问题正文，
 *  `options` 是该问题的选项列表，`multiSelect` 表示是否允许多选。 */
export interface AskQuestion {
  /** 问题正文文本，展示给用户。 */
  prompt: string;
  /** 该问题的选项列表，调用方保证 `options.length ≥ 2` 且 `key` 唯一。 */
  options: ReadonlyArray<AskOption>;
  /** true = 多选（可选多个 key）；false = 单选（恰好 1 个 key）。 */
  multiSelect: boolean;
}

/** Terminal result of an ask, returned to the CLI caller. Discriminated by
 *  `kind` so the CLI can map straight to stdout shape + exit code.
 *
 *  v0.1.8 变更：`answered` 变体的 `selected: string` 升级为
 *  `answers: ReadonlyArray<ReadonlyArray<string>>`，其中 `answers[i]`
 *  对应第 i 个问题（`questions[i]`）选中的 key 数组。
 *  向后兼容：单问单选场景用 `toLegacySelected` 取回旧的 `string`。
 *
 *  自定义回复（comment）：用户在话题里直接回一句文字当答案时，broker 用
 *  `submitCustomReply` settle，此时 `answers` 各问为空数组、`comment` 携带
 *  用户原文。CLI hook adapter 的 `formatAnswer` 据此把没有选中项的问题回落到
 *  这段自定义文字（替代语义，见 §自定义回复）。按钮路径的 comment 仍为 null。 */
export type AskResult =
  | {
      kind: 'answered';
      /** answers[i] = questions[i] 选中的 key 数组。 */
      answers: ReadonlyArray<ReadonlyArray<string>>;
      by: string;
      /** 自定义回复原文（用户在话题里直接打字作答）；按钮选择时为 null。 */
      comment: string | null;
      timedOut: false;
    }
  | {
      kind: 'timedOut';
      selected: null;
      by: null;
      comment: null;
      timedOut: true;
    }
  | {
      kind: 'invalidated';
      reason: string;
      selected: null;
      by: null;
      comment: null;
      timedOut: false;
    };

/** JSON envelope emitted by `botmux ask buttons --json`.
 *
 *  v0.1.8 新增 `answers: string[][] | null`（多问多选完整答案），
 *  保留 `selected: string | null` 做向后兼容（等价于 `toLegacySelected`）。
 *  `comment` 携带用户的自定义回复原文（话题直接打字作答），无则 null。 */
export interface AskJsonOutput {
  /** 向后兼容：单问单选时等于 `answers[0][0]`，否则为 null。 */
  selected: string | null;
  /** v0.1.8 新增：按问题分组的完整答案，answered 时非 null。 */
  answers: string[][] | null;
  by: string | null;
  /** 自定义回复原文；按钮选择 / 超时 / 失效时为 null。 */
  comment: string | null;
  timedOut: boolean;
}

/** Input accepted by broker.registerAsk. Caller (CLI subcommand → daemon IPC
 *  handler) is responsible for env validation and parameter parsing. Click
 *  authorization is the bot's canTalk gate, injected via `setCanTalkChecker`.
 *
 *  v0.1.8 变更：`options`/`prompt` 字段替换为 `questions: ReadonlyArray<AskQuestion>`。 */
export interface CreateAskInput {
  larkAppId: string;
  chatId: string;
  /** thread-scope ask → root message_id; chat-scope ask → null. */
  rootMessageId: string | null;
  /** Session that issued the ask — used for audit + future replay scoping. */
  sessionId: string;
  /** 问题列表，调用方保证每问 `options.length ≥ 2` 且 key 唯一。 */
  questions: ReadonlyArray<AskQuestion>;
  /** Absolute deadline; computed by caller from `--timeout`. Broker won't
   *  re-compute. */
  timeoutMs: number;
}

/** Daemon-internal state for a pending ask. Not exported on the IPC boundary —
 *  the CLI side only sees `AskResult`.
 *
 *  v0.1.8 变更：`options`/`prompt` 替换为 `questions`。 */
export interface PendingAsk {
  askId: string;
  /** Anti-replay nonce embedded in each button's action value. Click events
   *  whose nonce doesn't match → treated as stale (e.g. card from a previous
   *  daemon process before restart). */
  nonce: string;
  larkAppId: string;
  chatId: string;
  rootMessageId: string | null;
  sessionId: string;
  /** 问题列表，替代旧的 `options` + `prompt`。 */
  questions: ReadonlyArray<AskQuestion>;
  /** 当前已勾选答案快照。仅 daemon/card 内部使用；CLI IPC 边界不暴露。 */
  selections?: ReadonlyArray<ReadonlyArray<string>>;
  createdAt: number;
  deadlineAt: number;
  /** Set after the card dispatch succeeds. Until then, the ask is "registered
   *  but not visible" — clicks can't physically arrive yet. */
  cardMessageId?: string;
  /** Once true, subsequent click attempts return `already_settled`. */
  settled: boolean;
}

/** Outcome of a click-resolution attempt. Card click handler maps these to
 *  user-visible toasts. */
export type AskClickOutcome =
  /** First valid click — caller's Promise resolves with `kind:'answered'`. */
  | 'accepted'
  /** Clicker can't canTalk to the bot in this chat — caller shows "你没有权限". */
  | 'unauthorized'
  /** No such askId, nonce mismatch, or unknown option — caller shows
   *  "此 ask 已失效（daemon 重启）". Covers the §8 stale-card case. */
  | 'stale'
  /** Ask already settled (race winner exists or timed out). */
  | 'already_settled'
  /** 多选累积：用户勾选/取消某项，尚未 submit——不触发 settle。 */
  | 'toggled';

/** 旧单选语义兼容：仅当"单问且恰好选 1 个"时返回该 key，否则 null。
 *  `botmux ask buttons` 子命令与其测试据此保持单选行为不变。 */
export function toLegacySelected(result: AskResult): string | null {
  if (result.kind !== 'answered') return null;
  if (result.answers.length === 1 && result.answers[0].length === 1) {
    return result.answers[0][0];
  }
  return null;
}

/** Card dispatcher contract. The im/lark side registers a dispatcher via
 *  `setCardDispatcher`; the broker is otherwise IM-agnostic. */
export interface AskCardDispatcher {
  send(ask: PendingAsk): Promise<{ messageId: string }>;
  /** Called when an ask settles (answered / timedOut / invalidated). Card
   *  builder uses this to PATCH the card into a terminal state. Best-effort —
   *  the broker does not block on it. */
  onSettle?(
    ask: PendingAsk,
    result: AskResult,
  ): void | Promise<void>;
}
