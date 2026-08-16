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
  /** Per-invocation identity: the hook generates this once and reuses it across
   *  reconnect retries, so a re-POST after a daemon restart re-attaches to the
   *  same ask instead of creating a duplicate. Unlike a questions hash it
   *  distinguishes concurrent same-question asks. Optional for legacy/explicit
   *  callers that don't need restart-resume; the broker synthesizes one. */
  requestId?: string;
  /** What kind of caller issued this ask ('hook' = AskUserQuestion PreToolUse,
   *  'explicit' = `botmux ask buttons`, etc.). Namespaces the identity so an
   *  explicit ask can never re-claim a hook ask's card. Defaults to 'hook'. */
  originKind?: string;
  /** DAEMON-COMPUTED authoritative persistence gate (codex P1-4): does the
   *  authenticated issuing session's FROZEN backend survive a daemon restart
   *  (tmux/herdr/zellij/zmx = yes; pty = no)? The broker persists + resumes ONLY
   *  when this is true — it must NOT trust the client-supplied `originKind`
   *  string, since a PTY-session hook could POST `originKind:'hook'` and orphan a
   *  record that can never be re-claimed. Undefined → treated as false (fail
   *  closed: don't persist when the backend is unknown). */
  backendSurvivesRestart?: boolean;
  /** 问题列表，调用方保证每问 `options.length ≥ 2` 且 key 唯一。 */
  questions: ReadonlyArray<AskQuestion>;
  /** Absolute deadline; computed by caller from `--timeout`. Broker won't
   *  re-compute. */
  timeoutMs: number;
  /** 发起 ask 的会话类型。仅用于点击鉴权时把 chatType 喂给 canTalk（p2pOpen 腿）；
   *  缺省时该腿 fail-closed，鉴权退回原语义。 */
  chatType?: 'group' | 'p2p';
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
  /** 发起 ask 的会话类型（见 CreateAskInput.chatType）。 */
  chatType?: 'group' | 'p2p';
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
  /** Stable Feishu IM dedupe token for the card send (≤50 chars, derived from
   *  the ask's requestId). The dispatcher passes it as the message `uuid` so a
   *  re-send after a daemon restart returns the ORIGINAL message_id instead of
   *  posting a duplicate card. Absent for non-resumable asks. */
  dispatchUuid?: string;
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
  | 'toggled'
  /** 空提交二次确认：鉴权 + nonce 校验都通过，但当前一个选项都没勾、且每个问题
   *  都允许空集（全多选），提交极可能是手滑——先不 settle，要求带 confirmEmpty 再点
   *  一次。仅当所有问题都可空时才可能返回；任一单选未选走 `stale`（空非有效答案）。 */
  | 'needs_empty_confirm';

/** 旧单选语义兼容：仅当"单问且恰好选 1 个"时返回该 key，否则 null。
 *  `botmux ask buttons` 子命令与其测试据此保持单选行为不变。 */
export function toLegacySelected(result: AskResult): string | null {
  if (result.kind !== 'answered') return null;
  if (result.answers.length === 1 && result.answers[0].length === 1) {
    return result.answers[0][0];
  }
  return null;
}

/** 用户以文字作答（`submitCustomReply`）而非点选按钮：各问 `answers` 为空数组、
 *  `comment` 携带原文。此时 `toLegacySelected` 返回 null，非 JSON 模式的 stdout
 *  与"多选/多问"的降级空值无法区分——调用方据此在 stderr 提示答案去向。 */
export function isCustomReply(result: AskResult): boolean {
  if (result.kind !== 'answered') return false;
  if (result.comment === null) return false;
  return result.answers.every((keys) => keys.length === 0);
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

/**
 * Typed dispatch failure the card dispatcher throws from `send`, so the broker
 * can decide whether re-sending could help WITHOUT importing IM/HTTP types
 * (codex P1-3). The IM side owns classification (it alone sees the AxiosError /
 * Feishu code); the broker owns the bounded retry policy.
 *
 *   - `retryable: true`  → transient (5xx / 429 / network / no-response). The
 *     broker re-sends with the SAME dispatchUuid, so a send that actually landed
 *     server-side before the socket broke returns the original message_id (one
 *     logical card) instead of duplicating.
 *   - `retryable: false` → deterministic (4xx bad request / permission /
 *     withdrawn / malformed). Retrying can't help; the broker invalidates now.
 *
 * A plain (untyped) error thrown from `send` is treated as NOT retryable — fail
 * closed, since we can't prove a re-send is safe/idempotent.
 */
export class AskDispatchError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'AskDispatchError';
    this.retryable = retryable;
  }
}

/**
 * Whether a daemon `/api/asks` HTTP status is worth the hook retrying (codex
 * P1-3, executable decision seam). PURE + exported so cli.ts's `postAsk` AND its
 * unit test call the SAME function — the retry contract is exercised by real
 * calls, not asserted against source text.
 *
 * Retryable = the daemon is up but transiently unready: 502/503/504 (e.g. the
 * startup readiness window returns 503 `startup_not_ready`). Everything else is
 * deterministic — a 4xx (bad body / capability denied / unsupported chat) fails
 * identically forever, so the hook should stop retrying and passthrough. The
 * no-daemon and network-failure legs are classified retryable separately at
 * their throw sites (there is no HTTP status there).
 */
export function isRetryableAskHttpStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/**
 * Whether the daemon's `/api/asks` handler must answer a RETRYABLE 503
 * `startup_not_ready` instead of proceeding (codex P1-2/P1-4, executable
 * decision seam). PURE + exported so daemon.ts and its unit test share the SAME
 * predicate rather than asserting against source regex.
 *
 * True iff an unknown session hits the route while restore is still in flight —
 * regardless of how the caller authenticated. The earlier `trustedHost` escape
 * was WRONG (codex P1-2): a normal unsandbox hook IS the trusted-host path
 * (`postAsk` loads the host secret and calls the HMAC `fetchDaemonIpc` when
 * there's no relay), so exempting trusted callers let exactly the reconnecting
 * hook we must protect slip through during the descriptor-published-but-sessions-
 * not-yet-restored window — it would then register a NEW ask computed as
 * `backendSurvivesRestart:false` (session unknown) and be lost on the next
 * restart. Every `POST /api/asks` caller is a session-scoped ask registration
 * (the desktop/dashboard ANSWER path is a different route), so gating all
 * unknown sessions here is safe: once `sessionsRestored` flips true the gate
 * lifts and unknown sessions fall through to normal authorization.
 */
export function shouldReturnAskStartupNotReady(args: {
  hasSession: boolean;
  sessionsRestored: boolean;
}): boolean {
  return !args.hasSession && !args.sessionsRestored;
}
