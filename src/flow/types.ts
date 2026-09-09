/**
 * flow：JS-as-runtime 编排的共享类型与常量。
 *
 * 设计文档：docs/design/2026-09-06-js-as-runtime-orchestration.md（第七稿）。
 * 这里只放跨进程共享的契约——journal 行、Outcome、run.json、lease、RPC 消息——
 * 不放任何实现。三个进程角色（runner / script host / agent worker）都从此导入。
 */

// ---------------------------------------------------------------------------
// 失败三维度与 Outcome（§4.3、§4.4）
// ---------------------------------------------------------------------------

export type FailureCategory =
  | 'setup_required'
  | 'spawn_failed'
  | 'container_unavailable'
  | 'slot_timeout'
  | 'schema_mismatch'
  | 'timeout'
  | 'crashed'
  | 'interrupted'
  | 'canceled'
  | 'wait_timeout'
  | 'delivery_failed';

export type RetryPolicy = 'auto' | 'manual';
export type EffectsCertainty = 'none' | 'uncertain';

export interface Evidence {
  /** 结算来源：契约文件 / 屏幕 / daemon 的 final_output（bot 执行器）/ 信号（人的提交）/ 无（未到结算）。 */
  source?: 'contract_file' | 'screen' | 'daemon' | 'signal' | 'none';
  confidence?: 'high' | 'low';
  screenTail?: string;
  exitCode?: number | null;
  signal?: string | null;
  /** 宿主私有的 attempt 目录（pty.log、screen.txt、response.md）。 */
  attemptDir?: string;
  [key: string]: unknown;
}

export interface OkOutcome<T = unknown> {
  ok: true;
  value: T;
  identity: string;
  attempt: number;
  evidence: Evidence;
}

export interface FailedOutcome {
  ok: false;
  identity: string;
  attempt: number;
  evidence: Evidence;
  error: string;
  category: FailureCategory;
  retry: RetryPolicy;
  effects: EffectsCertainty;
}

export type Outcome<T = unknown> = OkOutcome<T> | FailedOutcome;

// ---------------------------------------------------------------------------
// run 状态（§4.6、§7.1）
// ---------------------------------------------------------------------------

export type RunStatus =
  | 'running'
  | 'paused'
  | 'interrupted'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'canceled';

export type RunHealth = 'ok' | 'degraded' | 'all_failed';

/**
 * `contained` / `cooperative`：runner 自己起 CLI 进程（`pty` 执行器）时的隔离层级。
 * `delegated`：agent 由 bot 的 daemon 以 headless 虚拟会话执行（`bot` 执行器），进程归 daemon 管，
 * runner 不建容器、不做逃逸检测；取消 / 清理通过关闭那个会话完成。
 */
export type Containment = 'contained' | 'cooperative' | 'delegated';
export type ContainmentBoundary = 'none' | 'cgroupns+userns';

/**
 * agent 执行器：`bot` = 每个 agent 一次调用对应 bot 的 daemon（`bots.json` 里的 CLI、模型、env、
 * 沙箱、插件全部沿用，会话不露脸：HTTP 虚拟会话，不进任何群）；`pty` = runner 自己在容器里起裸 CLI
 * （无 daemon 的终端调试 / 测试）。
 */
export type FlowExecutor = 'bot' | 'pty';

export type ContainerKind = 'cgroup2-kill' | 'cgroup2-freeze' | 'cgroup1-freezer' | 'none';

// ---------------------------------------------------------------------------
// 话题绑定（M2 §11）：run 与触发它的飞书话题的关系。写进 run.started 与 run.json，
// resume 沿用；daemon 重启后按 larkAppId 认领自己的 run。
// ---------------------------------------------------------------------------

export interface RunBinding {
  /** 托管这个 run 的飞书应用；只有该应用的 daemon 会为它发卡、接回调、续跑。 */
  larkAppId: string;
  chatId: string;
  /** 话题根消息 id：所有卡片都回复到这个话题。 */
  rootId: string;
  /** 触发它的 DaemonSession（诊断用；子 agent 不是 DaemonSession）。 */
  sessionId: string | null;
  /**
   * daemon 认证的 session owner（`BOTMUX_OWNER_OPEN_ID` 视角下的 open_id，app-scoped）。
   * 经 `applySessionOwnerEnv` 注入给 agent 子进程；null 即 ownerless。
   */
  ownerOpenId: string | null;
  /**
   * 触发人的 open_id（同一应用视角）；系统触发时是 `webhook:<connectorId>` 这类标识，
   * 只进 journal 的 `by` 字段，不参与任何权限判断（卡片按钮的权限只看 chatId 的 canOperate）。
   */
  triggeredBy: string;
  /** 触发话题的工作目录（脚本路径相对它解析）。 */
  workingDir: string;
  /** 非真人触发时的来源（webhook 接入点）；`/flow inspect` 与 `botmux flow inspect` 展示用。 */
  trigger?: {
    kind: 'webhook';
    connectorId: string | null;
    triggerId: string;
    source: string;
  };
}

// ---------------------------------------------------------------------------
// journal 行（§5.4）。每一行都带 gen。
// ---------------------------------------------------------------------------

interface RowBase {
  gen: number;
  ts: number;
}

export interface RunStartedRow extends RowBase {
  t: 'run.started';
  runId: string;
  script: string;
  scriptHash: string;
  input: unknown;
  binding: RunBinding | null;
  cwd: string;
  execConfigDigest: string;
  bootId: string | null;
  containment: Containment;
  boundary: ContainmentBoundary;
  probe: unknown;
  holder: { pid: number; identity: string };
}

export interface RunTakeoverRow extends RowBase {
  t: 'run.takeover';
  from: { pid: number | null; identity: string | null };
  reason: 'holder_dead' | 'heartbeat_stale' | 'lease_missing' | 'lock_holder_stale' | 'fresh';
  containment: Containment;
  boundary: ContainmentBoundary;
  probe: unknown;
  bootId: string | null;
  holder: { pid: number; identity: string };
}

export interface ContainerCreatedRow extends RowBase {
  t: 'container.created';
  container: string;
  kind: ContainerKind;
  path: string;
}

export type AttemptPhase = 'queued' | 'spawning' | 'ready' | 'settling';

export interface AttemptStateRow extends RowBase {
  t: 'attempt.state';
  identity: string;
  attempt: number;
  container: string;
  state: AttemptPhase;
  pid?: number;
  pidIdentity?: string;
  cliPid?: number | null;
  /** `bot` 执行器：执行这个 attempt 的 bot 与它开的虚拟会话（resume 时据此关掉上一代留下的会话）。 */
  bot?: string;
  sessionId?: string;
}

export interface StartedRow extends RowBase {
  t: 'started';
  identity: string;
  attempt: number;
  content: string;
  kind: 'agent' | 'signal';
  cli?: string;
  /** `bot` 执行器：解析出来的执行 bot（larkAppId）与展示名。 */
  bot?: string;
  botName?: string;
}

export interface SendIntentRow extends RowBase {
  t: 'send.intent';
  identity: string;
  attempt: number;
  container: string;
  turn: number;
  outboxFile: string;
}

export interface SendConfirmedRow extends RowBase {
  t: 'send.confirmed';
  identity: string;
  attempt: number;
}

export interface ResultRow extends RowBase {
  t: 'result';
  identity: string;
  attempt: number;
  value: unknown;
  evidence: Evidence;
}

export interface FailedRow extends RowBase {
  t: 'failed';
  identity: string;
  attempt: number;
  category: FailureCategory;
  retry: RetryPolicy;
  effects: EffectsCertainty;
  error: string;
  evidence: Evidence;
}

export type DecisionChoice = 'accept-failed' | 'retry' | 'timeout' | 'accept-journal' | 'assume-clean';

export interface DecisionRow extends RowBase {
  t: 'decision';
  scope: { identity: string; content: string; attempt: number } | { run: true };
  choice: DecisionChoice;
  by: string;
}

export interface DivergenceRow extends RowBase {
  t: 'divergence';
  identity: string;
  expected: string;
  actual: string;
}

export interface EscapeRow extends RowBase {
  t: 'escape';
  container: string;
  pids: number[];
}

export interface ActivityRow extends RowBase {
  t: 'activity';
  activeMs: number;
  cpuMs: number;
}

export interface NoteRow extends RowBase {
  t: 'note';
  text: string;
}

export interface RunErrorRow extends RowBase {
  t: 'run.error';
  code: string;
  error: string;
  stack?: string;
}

export interface RunInterruptedRow extends RowBase {
  t: 'run.interrupted';
  reason: string;
  inflight: string[];
}

export interface RunFinishedRow extends RowBase {
  t: 'run.finished';
  status: RunStatus;
  health: RunHealth;
  counts: { started: number; ok: number; failed: number };
  returned: unknown;
  replay: 'full' | 'mixed' | 'none';
}

/** M2 才启用的行也先定义，投影要认得它们。 */
export interface WaitRow extends RowBase {
  t: 'wait';
  identity: string;
  content: string;
  version: number;
  schema: unknown;
  prompt: string;
}

export interface SignalRow extends RowBase {
  t: 'signal';
  identity: string;
  content: string;
  version: number;
  by: string;
  value: unknown;
}

export interface WaitSupersededRow extends RowBase {
  t: 'wait.superseded';
  identity: string;
  version: number;
}

/**
 * 卡片投递状态（§7.3）：与逻辑等待状态分离，只影响卡片与 inspect 的显示；投递失败不关闭
 * 逻辑等待，终端提交与重发照常。
 */
export interface WaitDeliveryRow extends RowBase {
  t: 'wait.delivery';
  identity: string;
  version: number;
  state: 'delivered' | 'failed' | 'resent';
  card?: { messageId: string };
  error?: string;
}

export type JournalRow =
  | RunStartedRow
  | RunTakeoverRow
  | ContainerCreatedRow
  | AttemptStateRow
  | StartedRow
  | SendIntentRow
  | SendConfirmedRow
  | ResultRow
  | FailedRow
  | DecisionRow
  | DivergenceRow
  | EscapeRow
  | ActivityRow
  | NoteRow
  | RunErrorRow
  | RunInterruptedRow
  | RunFinishedRow
  | WaitRow
  | SignalRow
  | WaitSupersededRow
  | WaitDeliveryRow;

export type JournalRowType = JournalRow['t'];

/** 追加时必须 fsync 的行（§6.2）。 */
export const FSYNC_ROW_TYPES: ReadonlySet<JournalRowType> = new Set<JournalRowType>([
  'send.intent',
  'signal',
  'decision',
  'run.takeover',
  'run.started',
  'container.created',
]);

/** 单行上限；大 value 落 attempt 目录并在行内引用路径。 */
export const JOURNAL_ROW_MAX_BYTES = 4096;

// ---------------------------------------------------------------------------
// run.json（缓存；真相源是 journal）与 lease（§6.2、§13）
// ---------------------------------------------------------------------------

export interface RunJson {
  runId: string;
  gen: number;
  status: RunStatus;
  health: RunHealth;
  holder: { pid: number; identity: string } | null;
  containment: Containment | null;
  activeMs: number;
  cpuMs: number;
  script: string;
  scriptHash: string;
  cwd: string;
  input: unknown;
  binding: RunBinding | null;
  createdAt: number;
  updatedAt: number;
  limits: RunLimits;
  /**
   * 执行配置（content hash 的一部分，见 §4 `execConfigDigest`）。resume 默认原样恢复，
   * 否则 cwd / cliPaths / model 任一变化都会让全部 identity 的 content 变化、缓存全部失效。
   */
  execConfig: { cwd: string; cliPaths: Record<string, string>; model: string | null; executor?: FlowExecutor };
  execConfigDigest: string;
}

export interface Lease {
  holderPid: number;
  holderIdentity: string;
  gen: number;
  heartbeatAt: number;
  acquiredAt: number;
}

export const RUN_LEASE_FILE = 'run.lease';
export const RUN_JSON_FILE = 'run.json';
export const JOURNAL_FILE = 'journal.jsonl';
export const SCRIPT_SNAPSHOT_FILE = 'script.snapshot.mjs';
export const PROCESSES_FILE = 'processes.json';
export const CONTROL_SOCKET_FILE = 'control.sock';

// ---------------------------------------------------------------------------
// 上限（§4.2、§9）
// ---------------------------------------------------------------------------

export interface RunLimits {
  maxConcurrency: number;
  maxSessions: number;
  maxAgents: number;
  maxDurationMs: number;
  maxScriptCpuMs: number;
  maxNotes: number;
  /** 无锚点状态连续无新 ctx 调用的上限。 */
  scriptSliceMs: number;
  decisionTimeoutMs: number;
  agentTimeoutMs: number;
  requireContainment: boolean;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxConcurrency: 4,
  maxSessions: 4,
  maxAgents: 50,
  maxDurationMs: 4 * 60 * 60 * 1000,
  maxScriptCpuMs: 5 * 60 * 1000,
  maxNotes: 1000,
  scriptSliceMs: 60_000,
  decisionTimeoutMs: 7 * 24 * 60 * 60 * 1000,
  agentTimeoutMs: 30 * 60 * 1000,
  requireContainment: false,
};

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_STALE_MS = 60_000;
export const LOCK_HOLDER_STALE_MS = 60_000;
export const ACTIVITY_ROW_INTERVAL_MS = 60_000;
export const CONTAINED_HANDSHAKE_TIMEOUT_MS = 10_000;

export const AGENT_RESPONSE_MAX_BYTES = 256 * 1024;
export const SIGNAL_PAYLOAD_MAX_BYTES = 16 * 1024;
export const SCHEMA_MAX_BYTES = 32 * 1024;
export const SCHEMA_MAX_DEPTH = 32;

/** CLI 内 `botmux` 命令识别自己处于 flow agent 中的辅助标记（§6.3，不参与清理判定）。 */
export const FLOW_ATTEMPT_ENV_KEY = 'BOTMUX_FLOW_ATTEMPT';
export const FLOW_WORKER_ENV_KEYS = [FLOW_ATTEMPT_ENV_KEY, 'BOTMUX_FLOW_RUN_ID', 'BOTMUX_FLOW_RUN_DIR'] as const;

// ---------------------------------------------------------------------------
// script host ↔ runner 的 RPC（§6.1、§10）
// ---------------------------------------------------------------------------

export interface AgentSpec {
  /**
   * 执行 bot（`bots.json` 里的 larkAppId / botName / displayName）。`bot` 执行器下的解析顺序：
   * 显式 `bot` → 按 `cli` 找在线 bot（本 run 所属 bot 的 CLI 相同时优先它）→ 都没给就是本 run 所属 bot。
   */
  bot?: string;
  cli?: string;
  prompt: string;
  schema?: unknown;
  session?: string;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface SignalSpec {
  prompt: string;
  schema: unknown;
  timeoutMs?: number;
}

export type ScriptToRunnerMessage =
  | { t: 'hello'; pid: number }
  | { t: 'call'; id: number; op: 'agent'; identity: string; scopePath: string; content: string; spec: AgentSpec }
  | { t: 'call'; id: number; op: 'signal'; identity: string; scopePath: string; content: string; spec: SignalSpec }
  | { t: 'call'; id: number; op: 'log'; scopePath: string; text: string }
  | { t: 'call'; id: number; op: 'position'; scopePath: string; kind: 'parallel' | 'pipeline'; identity: string; size: number }
  | { t: 'done'; value: unknown }
  | { t: 'error'; code: string; message: string; stack?: string };

export type RunnerToScriptMessage =
  | { t: 'start'; source: string; input: unknown; cwd: string; execConfigDigest: string; filename: string }
  | { t: 'reply'; id: number; result: unknown }
  | { t: 'reject'; id: number; code: string; message: string }
  | { t: 'abort'; reason: string };

// ---------------------------------------------------------------------------
// agent worker ↔ runner 的协议（§5.5、§6.3）
// ---------------------------------------------------------------------------

export interface AgentWorkerOpenInput {
  runId: string;
  identity: string;
  attempt: number;
  gen: number;
  /** CLI 会话 id（adapter 用来命名原生会话；每个 attempt 唯一）。 */
  sessionId: string;
  cli: string;
  cliPath?: string;
  model?: string;
  cwd: string;
  env: Record<string, string>;
  /** daemon 认证的 session owner；终端触发的 run 没有（ownerless：两个 owner 变量都会被删除）。 */
  ownerOpenId?: string;
  /** 宿主私有 attempt 目录（pty.log、screen.txt、response.md、evidence.json）。 */
  attemptDir: string;
  /** 契约文件所在目录（M1 非沙箱：attempt 目录本身）。 */
  outboxDir: string;
  timeoutMs: number;
}

export type RunnerToAgentMessage =
  | { t: 'contained'; container: string }
  | { t: 'open'; input: AgentWorkerOpenInput }
  | { t: 'authorize'; gen: number; attempt: number; outboxFile: string; prompt: string }
  | { t: 'cancel'; reason: string }
  | { t: 'close' };

export interface AgentSettledResult {
  status: 'completed';
  finalResponse: string;
  evidence: Evidence;
}

export interface AgentSettledFailure {
  status: 'failed';
  code: 'provider_exit' | 'submit_unconfirmed' | 'turn_busy' | 'cli_needs_setup' | 'cancelled' | 'contract_missing';
  detail: string;
  evidence: Evidence;
}

export type AgentToRunnerMessage =
  | { t: 'hello'; pid: number }
  | { t: 'ready'; pid: number; cliPid: number | null }
  | { t: 'open_failed'; code: 'spawn_failed' | 'provider_exit' | 'ready_timeout' | 'cli_needs_setup' | 'adapter_error'; message: string; evidence: Evidence }
  | { t: 'submitted'; gen: number; attempt: number }
  | { t: 'settled'; gen: number; attempt: number; outcome: AgentSettledResult | AgentSettledFailure }
  | { t: 'closed' };

// ---------------------------------------------------------------------------
// 控制通道：run 目录内的 unix socket（终端入口）与 daemon IPC（卡片入口）承载同一组请求，
// runner 是唯一裁决者（§7.2）。
// ---------------------------------------------------------------------------

export type ControlRequest =
  | { t: 'decide'; identity: string; content: string; attempt: number; choice: 'accept-failed' | 'retry'; by: string }
  | { t: 'decide-run'; choice: 'accept-journal' | 'assume-clean'; by: string }
  | { t: 'cancel'; by: string }
  /**
   * 信号提交（§7.2）：runner 核对 identity 当前逻辑 open 的 wait 的 version（与 content，若给了）
   * → 按持久化 schema 校验 → 先追加 `signal` 行并 fsync，再应答，再释放脚本。
   * 之后的提交以「已消费」拒绝；旧 version 一律拒绝。
   */
  | { t: 'signal'; identity: string; version: number; content?: string; by: string; value: unknown }
  /** 重发信号卡（§7.4）：同一逻辑 wait，`version + 1`，旧卡作废。 */
  | { t: 'resend'; identity: string; by: string }
  | { t: 'status' };

export type ControlResponse =
  | { ok: true; status: RunStatus; pending: PendingDecision[]; waits: OpenWait[] }
  | { ok: false; error: string; code?: ControlErrorCode };

export type ControlErrorCode =
  | 'no_wait'
  | 'stale_version'
  | 'consumed'
  | 'content_mismatch'
  | 'schema_mismatch'
  | 'payload_too_large'
  | 'no_decision'
  | 'not_paused'
  | 'unbound'
  | 'unknown_request';

export interface PendingDecision {
  identity: string;
  content: string;
  attempt: number;
  outcome: FailedOutcome;
  reason: 'failed_manual' | 'uncertain' | 'journal_integrity' | 'container_unavailable' | 'escape';
}

/** runner 当前逻辑 open 的一个 wait（§7.3），status 应答与快照里都带。 */
export interface OpenWait {
  identity: string;
  version: number;
  content: string;
  prompt: string;
  schema: unknown;
  /** 最近一次投递结果；`pending` = 尚未投递（无绑定或正在投递）。 */
  delivery: 'pending' | 'delivered' | 'failed' | 'resent';
  messageId: string | null;
  deliveryError: string | null;
  openedAt: number;
  timeoutAt: number;
}

// ---------------------------------------------------------------------------
// daemon ↔ runner 的 IPC（M2 §6.1、§7）。runner 由 daemon 以 IPC 通道起（绑定话题的 run）；
// 断开即 `run.interrupted`（§6.4）。daemon 负责渲染卡片；runner 只推快照、收控制请求、
// 并为需要写进 journal 的投递结果（信号卡）发起请求。
// ---------------------------------------------------------------------------

/** runner 推给 daemon 的运行快照：daemon 据此渲染进度卡与决策卡（不需要写 journal 的卡）。 */
export interface RunSnapshot {
  runId: string;
  gen: number;
  status: RunStatus;
  health: RunHealth;
  counts: { started: number; ok: number; failed: number; inflight: number };
  attempts: Array<{
    identity: string;
    attempt: number;
    state: 'inflight' | 'result' | 'failed';
    phase: AttemptPhase | null;
    cli?: string;
    /** `bot` 执行器：执行 bot 的展示名。 */
    botName?: string;
    category?: FailureCategory;
    error?: string;
  }>;
  pending: PendingDecision[];
  runPause: { reason: PendingDecision['reason']; detail: string } | null;
  waits: OpenWait[];
  /** 最近几条 note。 */
  notes: string[];
  finished: { status: RunStatus; health: RunHealth; replay: 'full' | 'mixed' | 'none'; returned: unknown } | null;
  error: { code: string; message: string } | null;
  activeMs: number;
  updatedAt: number;
}

export type RunnerToDaemonMessage =
  | { t: 'hello'; runId: string; gen: number; pid: number }
  | { t: 'snapshot'; snapshot: RunSnapshot }
  /** runner 请 daemon 投递 / 更新一张信号卡。 */
  | { t: 'request'; id: number; req: DaemonRequest }
  /** 对 daemon 转来的控制请求的应答。 */
  | { t: 'response'; id: number; res: ControlResponse };

export type DaemonRequest =
  | { t: 'wait.deliver'; wait: OpenWait; /** 重发时作废的旧卡 */ supersedes: string | null }
  /** 逻辑等待仍 open、runner 换代后：把旧卡改成「run 已恢复，仍在等待」；失败则 runner 重发。 */
  | { t: 'wait.refresh'; wait: OpenWait }
  /** 等待关闭（消费 / 作废 / 超时 / 取消）：冻结卡片。 */
  | { t: 'wait.close'; identity: string; version: number; messageId: string | null; how: 'consumed' | 'superseded' | 'timeout' | 'canceled'; by: string | null };

export type DaemonResponse = { ok: true; messageId: string | null } | { ok: false; error: string };

export type DaemonToRunnerMessage =
  | { t: 'request'; id: number; req: ControlRequest }
  | { t: 'response'; id: number; res: DaemonResponse };

// ---------------------------------------------------------------------------
// `bot` 执行器：runner ↔ 执行 bot 的 daemon 的 loopback IPC 契约（`POST /api/flow/agent-turn`）。
// 与话题绑定的 daemon 通道无关：任何 runner（daemon 起的、终端起的）都直接找**执行 bot** 的 daemon，
// 本 bot 与别的 bot 走同一条路。结果用现成的 `GET /api/sessions/:id/trigger-result` 轮询，
// 取消 / 清理用现成的 `POST /api/sessions/:id/close`。
// ---------------------------------------------------------------------------

export const FLOW_AGENT_TURN_ROUTE = '/api/flow/agent-turn';

export interface FlowAgentTurnRequest {
  runId: string;
  identity: string;
  attempt: number;
  gen: number;
  /** 同一 attempt 内的第几轮（schema 修复是第 2 轮，回到同一个会话）。 */
  turn: number;
  /** 首轮 null（daemon 开一个 headless 虚拟会话）；修复轮传首轮返回的 sessionId。 */
  sessionId: string | null;
  prompt: string;
  workingDir: string;
  model?: string;
  /** 单轮上限（daemon 侧不 cap；runner 自己按它轮询超时）。 */
  timeoutMs: number;
}

export type FlowAgentTurnResponse =
  | { ok: true; sessionId: string; triggerId: string; bot: string; botName: string; cliId: string }
  | { ok: false; code: 'bad_request' | 'session_not_found' | 'dispatch_failed' | 'flow_not_enabled'; error: string };

export class FlowHardError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'FlowHardError';
  }
}
