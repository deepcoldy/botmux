/**
 * flow runner：一个 run 一个进程，持 lease，是所有共享状态的唯一写者（设计文档 §6）。
 *
 * 职责：接管协议 → 容器回收与逃逸检测 → 完整性校验 → 在途 attempt 诚实结算 → 起 script host
 * → 把 ctx RPC 翻译成 attempt 生命周期（started / container / send.intent / authorize / settle）
 * → 三状态秒表、失速看门狗、CPU 预算 → 决策与控制通道 → run.finished。
 *
 * 所有写入经 `withRunOwnership`；被围栏即退出。进程管理（script host / agent worker）经
 * `ChildLink` 抽象注入，故障注入测试在进程内驱动同一份逻辑。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { scrubFlowChildEnv } from '../utils/child-env.js';
import { readLinuxBootIdentity, readProcessStartIdentity } from '../utils/process-identity.js';
import { resolveEntrySpawn } from '../core/self-spawn.js';
import {
  addPidToContainer,
  containerName,
  containerPath,
  createContainerDir,
  probeContainerBackend,
  reclaimContainer,
  reclaimForeignContainers,
  removeRunTreeIfEmpty,
  runFalsificationProbe,
  runTreePath,
  scanEscapes,
  type ContainerBackend,
  type ContainmentVerdict,
  type ReclaimResult,
} from './container.js';
import { attemptSessionId, canonicalJson, identityDirName, outboxFileName, scriptHash } from './identity.js';
import { controlSocketPath } from './paths.js';
import {
  appendRowsLocked,
  checkIntegrity,
  decisionKey,
  journalMaxGen,
  loadJournal,
  project,
  readJournal,
  type DroppedRow,
  type Projection,
} from './journal.js';
import {
  FencedError,
  OwnershipLockTimeoutError,
  RunBusyError,
  acquireRun,
  heartbeat,
  releaseRun,
  selfIdentity,
  terminateProcess,
  withRunOwnership,
  type RunSelf,
} from './ownership.js';
import { decideReplay, interruptedOutcome, outcomeFromFailed, outcomeFromResult, type ReplayDisposition } from './replay.js';
import { extractLastJsonBlock, validateValue } from './schema.js';
import { acquireSlot, adoptRunSlots, releaseSlot, type SlotEntry } from './slots.js';
import {
  ACTIVITY_ROW_INTERVAL_MS,
  AGENT_RESPONSE_MAX_BYTES,
  DEFAULT_RUN_LIMITS,
  FLOW_ATTEMPT_ENV_KEY,
  HEARTBEAT_INTERVAL_MS,
  JOURNAL_ROW_MAX_BYTES,
  RUN_JSON_FILE,
  SCRIPT_SNAPSHOT_FILE,
  SIGNAL_PAYLOAD_MAX_BYTES,
  type AgentSettledFailure,
  type AgentSettledResult,
  type AgentSpec,
  type AgentToRunnerMessage,
  type AgentWorkerOpenInput,
  type ControlRequest,
  type ControlResponse,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonToRunnerMessage,
  type DecisionChoice,
  type Evidence,
  type FailedOutcome,
  type FailedRow,
  type JournalRow,
  type OkOutcome,
  type OpenWait,
  type Outcome,
  type PendingDecision,
  type ResultRow,
  type RunBinding,
  type RunHealth,
  type RunJson,
  type RunLimits,
  type RunSnapshot,
  type RunStatus,
  type RunnerToAgentMessage,
  type RunnerToDaemonMessage,
  type RunnerToScriptMessage,
  type ScriptToRunnerMessage,
  type SignalSpec,
} from './types.js';

// ---------------------------------------------------------------------------
// 子进程抽象
// ---------------------------------------------------------------------------

export interface ChildLink<In, Out> {
  readonly pid: number;
  send(message: In): void;
  onMessage(handler: (message: Out) => void): void;
  onExit(handler: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
  readonly exited: boolean;
}

export type ScriptLink = ChildLink<RunnerToScriptMessage, ScriptToRunnerMessage>;
export type AgentLink = ChildLink<RunnerToAgentMessage, AgentToRunnerMessage>;

/**
 * runner → daemon 的上行通道（M2 §6.1）：绑定话题的 run 由 daemon 以 IPC 起，runner 经它推快照、
 * 请求投递信号卡、应答控制请求；断开即 `run.interrupted`（§6.4）。默认实现是 `process.send`。
 */
export interface DaemonLink {
  send(message: RunnerToDaemonMessage): void;
  onMessage(handler: (message: DaemonToRunnerMessage) => void): void;
  onDisconnect(handler: () => void): void;
}

export function processDaemonLink(): DaemonLink | null {
  if (typeof process.send !== 'function' || !process.connected) return null;
  return {
    send: (message) => {
      try {
        process.send!(message);
      } catch {
        // 通道已关：disconnect 事件随后处理
      }
    },
    onMessage: (handler) => process.on('message', (raw) => handler(raw as DaemonToRunnerMessage)),
    onDisconnect: (handler) => process.once('disconnect', handler),
  };
}

export function linkChildProcess<In, Out>(child: ChildProcess): ChildLink<In, Out> {
  let exited = false;
  const errors: Error[] = [];
  child.once('exit', () => {
    exited = true;
  });
  // spawn 失败（ENOENT 等）与 IPC 错误都从这里出：不让它们变成未处理的 'error' 事件炸掉 runner。
  // spawn 失败时 Node 也会随后触发 exit（code null）。
  child.on('error', (err) => {
    errors.push(err);
  });
  return {
    get pid() {
      return child.pid ?? -1;
    },
    get exited() {
      return exited;
    },
    send: (message) => {
      if (exited || !child.connected) return;
      try {
        // 带回调：通道已关时错误走回调而不是 'error' 事件（对方要么退出了要么正在退出）
        child.send(message as object, (err) => {
          if (err) errors.push(err);
        });
      } catch {
        // 同上
      }
    },
    onMessage: (handler) => child.on('message', (raw) => handler(raw as Out)),
    onExit: (handler) => child.once('exit', (code, signal) => handler(code, signal)),
    kill: (signal) => {
      try {
        child.kill(signal ?? 'SIGTERM');
      } catch {
        // gone
      }
    },
  };
}

export interface RunnerHooks {
  /** 故障注入点：返回 promise 可以让 runner 在该点等待（测试里在此 kill -9）。 */
  at?: (point: RunnerHookPoint, detail: Record<string, unknown>) => void | Promise<void>;
  /** 观察日志。 */
  log?: (line: string) => void;
}

export type RunnerHookPoint =
  | 'acquired'
  | 'reclaimed'
  | 'script_started'
  | 'in_container_created_section'
  | 'after_container_created'
  | 'in_contained_section'
  | 'before_contained_notify'
  | 'before_send_intent'
  | 'after_send_intent'
  | 'before_authorize'
  | 'after_authorize'
  | 'after_settled'
  | 'paused'
  | 'finished';

export interface RunnerOptions {
  runId: string;
  runDir: string;
  mode: 'run' | 'resume';
  /** 全新 run 需要；resume 从快照读。 */
  script?: { path: string; source: string };
  input?: unknown;
  cwd?: string;
  limits?: Partial<RunLimits>;
  cliPaths?: Record<string, string>;
  model?: string;
  ownerOpenId?: string;
  /**
   * 话题绑定（M2）：全新 run 写进 run.started；resume 缺省沿用 run.json 的记录。
   * 有绑定才允许 `signal()`；卡片经 `daemonLink` 投递。
   */
  binding?: RunBinding | null;
  /** 注入：daemon 通道（默认 `processDaemonLink()`，即 daemon 以 IPC 起我时的 process.send；null 关闭）。 */
  daemonLink?: DaemonLink | null;
  slotsFile: string;
  hostSlots?: number;
  distDir: string;
  requireContainment?: boolean;
  unsafeNoContainer?: boolean;
  acceptJournal?: boolean;
  assumeClean?: boolean;
  retryUncertain?: boolean;
  /** resume 后不跑脚本，回收完上一代容器就取消（中断卡上的「取消」：中断态的 run 没有 runner 可收取消）。 */
  cancelOnStart?: string;
  decidedBy?: string;
  /** 注入：起 script host / agent worker（默认 resolveEntrySpawn + IPC）。 */
  spawnScriptHost?: (env: NodeJS.ProcessEnv, cpuLimitSec: { soft: number; hard: number }) => ScriptLink;
  spawnAgentWorker?: (env: NodeJS.ProcessEnv) => AgentLink;
  hooks?: RunnerHooks;
  heartbeatIntervalMs?: number;
  /** 接管判定参数（默认 60s；测试缩短）。 */
  heartbeatStaleMs?: number;
  lockHolderStaleMs?: number;
  /** 控制通道 socket 路径（默认 `<run>/control.sock`）；null 关闭。 */
  controlSocket?: string | null;
  /** 全部 agent 共享的 env 基线（默认 process.env）。 */
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * 显式指定容器后端（跳过能力探测）。`null` = 不用容器（等价 --unsafe-no-container，
   * 进程内测试用：假 worker 就是本进程，不能把自己放进 cgroup）。
   */
  containerBackend?: ContainerBackend | null;
}

export interface RunSummary {
  runId: string;
  gen: number;
  status: RunStatus;
  health: RunHealth;
  returned: unknown;
  counts: { started: number; ok: number; failed: number };
  replay: 'full' | 'mixed' | 'none';
  containment: ContainmentVerdict | null;
  exitCode: number;
}

export class RunnerFencedExit extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerFencedExit';
  }
}

interface InflightAttempt {
  identity: string;
  attempt: number;
  container: string;
  containerPath: string | null;
  link: AgentLink | null;
  cancel: (reason: string) => void;
  slot: SlotEntry | null;
}

interface PendingWait {
  decision: PendingDecision;
  resolve: (choice: DecisionChoice | 'canceled') => void;
}

/** 一个逻辑 open 的信号等待（§7.3）：runner 内存里的裁决对象；持久化真相在 journal 的 wait/signal 行。 */
interface OpenSignalWait {
  identity: string;
  content: string;
  version: number;
  prompt: string;
  schema: unknown;
  openedAt: number;
  timeoutAt: number;
  delivery: OpenWait['delivery'];
  messageId: string | null;
  deliveryError: string | null;
  /** 释放脚本：提交已持久化（signal 行）或等待结束（超时 / 取消）。 */
  resolve: (outcome: Outcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** 同一 identity 的提交串行处理（§7.2）。 */
  arbitrating: Promise<void>;
}

const CLK_TCK = 100;
const SCREEN_TAIL_ROW_LIMIT = 800;
const SNAPSHOT_MIN_INTERVAL_MS = 300;
const SNAPSHOT_NOTES_TAIL = 5;
const DEFAULT_SIGNAL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

function nowMs(): number {
  return Date.now();
}

export class FlowRunner {
  /** 生效限额：全新 run 来自 opts；resume 以 run.json 记录为底、显式 opts 覆盖（见 resolveExecConfig）。 */
  private limits: RunLimits;
  private readonly hooks: RunnerHooks;
  private self: RunSelf | null = null;
  private backend: ContainerBackend | null = null;
  private verdict: ContainmentVerdict | null = null;
  private projection: Projection;
  private script: ScriptLink | null = null;
  private scriptPid: number | null = null;
  private scriptReturned = false;
  private scriptDone: { kind: 'done'; value: unknown } | { kind: 'error'; code: string; message: string; stack?: string } | null = null;
  private readonly inflight = new Map<string, InflightAttempt>();
  private readonly pendingWaits = new Map<string, PendingWait>();
  private readonly openWaits = new Map<string, OpenSignalWait>();
  private runPause: { reason: PendingDecision['reason']; detail: string; resolve: (choice: DecisionChoice) => void } | null = null;
  /** 话题绑定：全新 run 来自 opts；resume 缺省沿用 run.json。 */
  private binding: RunBinding | null = null;
  private daemon: DaemonLink | null = null;
  private daemonRequestSeq = 0;
  private readonly daemonPending = new Map<number, (res: DaemonResponse) => void>();
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSnapshotAt = 0;
  private recentNotes: string[] = [];
  private daemonGone = false;
  private attemptCounter = 0;
  private notes = 0;
  private spawns = 0;
  private cacheHits = 0;
  private activeMs = 0;
  private cpuBaseMs = 0;
  private cpuSampleMs = 0;
  private lastTick = 0;
  private lastActivityRowAt = 0;
  private lastClockState: 'walking' | 'stopped' | 'unanchored' | null = null;
  private lastCtxCallAt = 0;
  private startedAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private control: Server | null = null;
  private fenced = false;
  private finishing = false;
  private canceled: string | null = null;
  private hardError: { code: string; message: string; stack?: string } | null = null;
  private finishResolve: ((summary: RunSummary) => void) | null = null;
  /** 生效的执行配置：全新 run 来自 opts；resume 默认从 run.json 恢复，显式 opts 覆盖。 */
  private execConfigDigest = '';
  private cwd = '';
  private cliPaths: Record<string, string> = {};
  private model: string | undefined;
  private scriptSource = '';
  private scriptHashValue = '';
  private runJson: RunJson | null = null;

  constructor(private readonly opts: RunnerOptions) {
    this.limits = { ...DEFAULT_RUN_LIMITS, ...(opts.limits ?? {}), ...(opts.requireContainment ? { requireContainment: true } : {}) };
    this.hooks = opts.hooks ?? {};
    this.projection = project([]);
  }

  /**
   * 决定本代次的执行配置与限额。resume 时以 run.json 为准（否则 content 全部变化、
   * 缓存全失效——真 CLI 冒烟踩过：resume 没带 --cwd，三步全部重跑）；显式传入的
   * opts 覆盖并在配置摘要变化时记一条日志，让操作者知道缓存不会命中。
   */
  private resolveExecConfig(prior: RunJson | null): void {
    const explicitCliPaths = this.opts.cliPaths && Object.keys(this.opts.cliPaths).length > 0 ? this.opts.cliPaths : undefined;
    if (this.opts.mode === 'resume' && prior) {
      const recorded = prior.execConfig ?? { cwd: prior.cwd, cliPaths: {}, model: null };
      this.cwd = this.opts.cwd ? safeRealpath(this.opts.cwd) : recorded.cwd;
      this.cliPaths = explicitCliPaths ?? recorded.cliPaths;
      this.model = this.opts.model ?? recorded.model ?? undefined;
      this.limits = { ...DEFAULT_RUN_LIMITS, ...prior.limits, ...(this.opts.limits ?? {}), ...(this.opts.requireContainment ? { requireContainment: true } : {}) };
    } else {
      this.cwd = safeRealpath(this.opts.cwd ?? process.cwd());
      this.cliPaths = explicitCliPaths ?? {};
      this.model = this.opts.model;
    }
    this.execConfigDigest = createHash('sha256').update(canonicalJson({ cliPaths: this.cliPaths, model: this.model ?? null })).digest('hex');
    if (this.opts.mode === 'resume' && prior && (this.cwd !== prior.cwd || (prior.execConfigDigest !== undefined && this.execConfigDigest !== prior.execConfigDigest))) {
      this.log(`exec config differs from the recorded run (cwd ${prior.cwd} → ${this.cwd}, digest ${(prior.execConfigDigest ?? '?').slice(0, 12)} → ${this.execConfigDigest.slice(0, 12)}); cached results will not replay`);
    }
  }

  /**
   * 子进程 env 基线：剥掉触发 shell 可能带着的话题会话身份、IM 凭证与陈旧标记
   * （`scrubFlowChildEnv`），否则从话题 CLI 里 `botmux flow run` 起的子 agent 会把自己
   * 当成那个话题会话，hook 与 `botmux send` 全部误路由到父话题。
   */
  private childBaseEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(this.opts.baseEnv ?? process.env) };
    scrubFlowChildEnv(env);
    return env;
  }

  private log(line: string): void {
    this.hooks.log?.(`[flow-runner ${this.opts.runId}${this.self ? ` gen ${this.self.gen}` : ''}] ${line}`);
  }

  private async hook(point: RunnerHookPoint, detail: Record<string, unknown> = {}): Promise<void> {
    await this.hooks.at?.(point, detail);
  }

  // ---------------------------------------------------------------------------
  // 主流程
  // ---------------------------------------------------------------------------

  async run(): Promise<RunSummary> {
    const { runDir, runId } = this.opts;
    mkdirSync(runDir, { recursive: true });
    const snapshotPath = join(runDir, SCRIPT_SNAPSHOT_FILE);

    // 1. 能力探测
    if (this.opts.containerBackend !== undefined) {
      this.backend = this.opts.containerBackend;
    } else {
      const probed = probeContainerBackend();
      if (probed.kind === 'none') {
        if (!this.opts.unsafeNoContainer) {
          throw new Error(`container_unavailable: ${probed.reason} (pass --unsafe-no-container to run without process containment)`);
        }
        this.backend = null;
      } else {
        this.backend = probed;
      }
    }
    if (this.limits.requireContainment) {
      // M1 一律 cooperative：要求 contained 就是拒绝运行
      throw new Error('container_unavailable: --require-containment is set but M1 only provides the cooperative tier (contained needs the M3 sandbox boundary)');
    }

    // 2. 脚本：全新 run 写快照；resume 读快照
    if (this.opts.mode === 'run') {
      if (!this.opts.script) throw new Error('script is required for a fresh run');
      if (existsSync(join(runDir, 'journal.jsonl'))) throw new Error(`run ${runId} already exists; use resume`);
      this.scriptSource = this.opts.script.source;
      atomicWriteFileSync(snapshotPath, this.scriptSource);
    } else {
      if (!existsSync(snapshotPath)) throw new Error(`run ${runId} has no script snapshot; nothing to resume`);
      this.scriptSource = readFileSync(snapshotPath, 'utf8');
    }
    this.scriptHashValue = scriptHash(this.scriptSource);
    const existingRunJson = readRunJson(runDir);
    this.resolveExecConfig(existingRunJson);
    // 话题绑定：全新 run 用 opts；resume 缺省沿用记录（显式给了才覆盖）
    this.binding = this.opts.mode === 'resume' ? (this.opts.binding ?? existingRunJson?.binding ?? null) : (this.opts.binding ?? null);
    this.attachDaemon();

    // 3. 证伪探测（临界区外；容器名 c-0-probe，gen 0 永远不是真实代次，树扫描会把它当外来容器回收）
    if (this.backend) {
      mkdirSync(runTreePath(this.backend, runId), { recursive: true });
      this.verdict = await runFalsificationProbe(this.backend, runId, 0);
    }

    // 4. 接管
    const identity = selfIdentity();
    const bootId = readLinuxBootIdentity() ?? null;
    let acquired;
    try {
      acquired = await acquireRun(runDir, {
        pid: process.pid,
        identity,
        persistedMaxGen: () => Math.max(journalMaxGen(readJournal(runDir).rows), existingRunJson?.gen ?? 0),
        lastHolder: existingRunJson?.holder ?? null,
        killProcess: (pid, id) => terminateProcess(pid, id),
        heartbeatStaleMs: this.opts.heartbeatStaleMs,
        lockHolderStaleMs: this.opts.lockHolderStaleMs,
        onCommit: ({ gen, from, reason }) => {
          const ts = nowMs();
          const holder = { pid: process.pid, identity };
          const verdict = this.verdict;
          const containment = verdict?.containment ?? 'cooperative';
          const boundary = verdict?.boundary ?? 'none';
          const probe = verdict?.probe ?? null;
          const rows: JournalRow[] =
            reason === 'fresh'
              ? [{
                  t: 'run.started', gen, ts, runId, script: this.opts.script?.path ?? snapshotPath, scriptHash: this.scriptHashValue,
                  input: this.opts.input ?? null, binding: this.binding, cwd: this.cwd, execConfigDigest: this.execConfigDigest, bootId,
                  containment, boundary, probe, holder,
                }]
              : [{ t: 'run.takeover', gen, ts, from, reason, containment, boundary, probe, bootId, holder }];
          appendRowsLocked(runDir, rows);
          const prior = existingRunJson;
          this.runJson = {
            runId,
            gen,
            status: 'running',
            health: prior?.health ?? 'ok',
            holder,
            containment,
            activeMs: prior?.activeMs ?? 0,
            cpuMs: prior?.cpuMs ?? 0,
            script: prior?.script ?? this.opts.script?.path ?? snapshotPath,
            scriptHash: this.scriptHashValue,
            cwd: prior?.cwd ?? this.cwd,
            input: prior?.input ?? this.opts.input ?? null,
            binding: this.binding,
            createdAt: prior?.createdAt ?? ts,
            updatedAt: ts,
            limits: this.limits,
            execConfig: { cwd: this.cwd, cliPaths: this.cliPaths, model: this.model ?? null },
            execConfigDigest: this.execConfigDigest,
          };
          writeRunJsonLocked(runDir, this.runJson);
        },
      });
    } catch (err) {
      if (err instanceof RunBusyError) throw new Error(`run_busy: ${err.message}`);
      throw err;
    }
    this.self = { pid: process.pid, identity, gen: acquired.gen };
    this.startedAt = nowMs();
    this.lastTick = this.startedAt;
    this.lastCtxCallAt = this.startedAt;
    this.log(`acquired gen ${acquired.gen} (${acquired.reason})${this.binding ? `, bound to ${this.binding.larkAppId}/${this.binding.chatId}/${this.binding.rootId}` : ''}`);
    await this.hook('acquired', { gen: acquired.gen, reason: acquired.reason });

    const summary = new Promise<RunSummary>((resolve) => {
      this.finishResolve = resolve;
    });
    this.daemon?.send({ t: 'hello', runId, gen: acquired.gen, pid: process.pid });
    this.scheduleSnapshot();
    if (this.daemonGone) {
      // daemon 在我拿到 lease 之前就断了：按中断处理，不跑脚本
      void this.interrupt('daemon_disconnect');
      return summary;
    }

    // 心跳从拿到 lease 起就跑：回收 / 完整性校验阶段的暂停可能很长，lease 不能在那期间变陈旧
    this.heartbeatTimer = setInterval(() => void this.tick(), this.opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);

    try {
      await this.afterAcquire();
    } catch (err) {
      await this.finishWithError(err);
    }
    return summary;
  }

  private async afterAcquire(): Promise<void> {
    const { runDir, runId } = this.opts;
    const self = this.self!;

    // 5. 回收：改记槽位 → 记录中的容器 + run 级树扫描 → 逃逸检测
    if (this.backend) {
      const adopted = await withRunOwnership(runDir, self, () => adoptRunSlots(this.opts.slotsFile, runId, self));
      const results = await reclaimForeignContainers(this.backend, runId, self.gen);
      const loaded = loadJournal(runDir);
      for (const [name, row] of loaded.projection.containers) {
        if (name.startsWith(`c-${self.gen}-`)) continue;
        if (results.some((r) => r.container === name)) continue;
        results.push({ container: name, result: await reclaimContainer(this.backend, row.path) });
      }
      // 成功回收也要留痕（runner.log）：接管后「上一代到底有没有孤儿、杀了谁」是排障第一问。
      const reclaimedOk = results.filter((r): r is { container: string; result: Extract<ReclaimResult, { ok: true }> } => r.result.ok);
      if (reclaimedOk.length > 0) {
        this.log(`reclaimed ${reclaimedOk.length} previous-generation container(s): ${reclaimedOk.map((r) => `${r.container} killed ${r.result.killed} pid(s) in ${r.result.cycles} cycle(s)`).join('; ')}`);
      }
      const failed = results.filter((r) => !r.result.ok);
      if (failed.length > 0) {
        const detail = failed.map((f) => `${f.container}: ${(f.result as Extract<ReclaimResult, { ok: false }>).detail}`).join('; ');
        this.log(`reclaim incomplete: ${detail}`);
        const choice = await this.pauseRun('container_unavailable', `previous-generation containers could not be reclaimed: ${detail}`);
        if (choice !== 'assume-clean') return this.cancelRun('reclaim incomplete');
      }
      for (const entry of adopted) await releaseSlot(this.opts.slotsFile, { ...entry, holderPid: self.pid, holderIdentity: self.identity, gen: self.gen, state: 'held' });
      const escapes = scanEscapes(this.backend, runId, FLOW_ATTEMPT_ENV_KEY);
      if (escapes.length > 0) {
        await this.append([{ t: 'escape', gen: self.gen, ts: nowMs(), container: 'unknown', pids: escapes.map((e) => e.pid) }]);
        const choice = await this.pauseRun('escape', `processes carrying this run's marker are outside its containers: ${escapes.map((e) => `${e.pid} (${e.cgroup})`).join(', ')}`);
        if (choice !== 'assume-clean') return this.cancelRun('escaped processes');
      }
    } else if (this.opts.mode === 'resume') {
      const loaded = loadJournal(runDir);
      if (loaded.projection.counts.inflight > 0 && !this.opts.assumeClean) {
        const choice = await this.pauseRun('container_unavailable', 'no container backend: in-flight attempts from a previous generation cannot be reclaimed; pass --assume-clean to continue');
        if (choice !== 'assume-clean') return this.cancelRun('no container backend');
      }
    }
    await this.hook('reclaimed');

    // 6. 完整性校验
    const loaded = loadJournal(runDir);
    if (loaded.integrity.dropped.length > 0) {
      const detail = describeDropped(loaded.integrity.dropped);
      this.log(`journal integrity: ${loaded.integrity.dropped.length} row(s) dropped: ${detail}`);
      const alreadyAccepted = loaded.projection.runDecisions.some((d) => d.choice === 'accept-journal' && d.gen === self.gen);
      if (!alreadyAccepted) {
        const choice = this.opts.acceptJournal ? 'accept-journal' : await this.pauseRun('journal_integrity', `journal has ${loaded.integrity.dropped.length} row(s) outside the ownership protocol: ${detail}`);
        if (choice !== 'accept-journal') return this.cancelRun('journal integrity rejected');
        await this.append([{ t: 'decision', gen: self.gen, ts: nowMs(), scope: { run: true }, choice: 'accept-journal', by: this.opts.decidedBy ?? 'operator' }]);
      }
    }
    this.projection = loadJournal(runDir).projection;

    // 7. 在途 attempt 的诚实结算（上一代次留下的）
    const settleRows: JournalRow[] = [];
    for (const ident of this.projection.identities.values()) {
      if (ident.latest.state !== 'inflight') continue;
      const outcome = interruptedOutcome(ident.latest, `runner gen ${ident.latest.gen} did not settle it`);
      settleRows.push({
        t: 'failed', gen: self.gen, ts: nowMs(), identity: outcome.identity, attempt: outcome.attempt,
        category: outcome.category, retry: outcome.retry, effects: outcome.effects, error: outcome.error, evidence: outcome.evidence,
      });
    }
    if (this.opts.retryUncertain) {
      for (const ident of this.projection.identities.values()) {
        const latest = ident.latest;
        const uncertain = latest.state === 'inflight' ? latest.intent !== null : latest.failed?.effects === 'uncertain';
        if (!uncertain) continue;
        settleRows.push({ t: 'decision', gen: self.gen, ts: nowMs(), scope: { identity: latest.identity, content: latest.content, attempt: latest.attempt }, choice: 'retry', by: this.opts.decidedBy ?? 'operator' });
      }
    }
    if (settleRows.length > 0) await this.append(settleRows);
    this.projection = loadJournal(runDir).projection;

    // 8. 从 activity 行恢复秒表与 CPU
    if (this.projection.activity) {
      this.activeMs = this.projection.activity.activeMs;
      this.cpuBaseMs = this.projection.activity.cpuMs;
    }

    // 9. 控制通道（暂停时可能已经打开）
    this.openControl();

    if (this.opts.cancelOnStart) {
      // 中断态的 run 收到「取消」：上一代已回收干净，直接以 canceled 收尾，不起脚本
      await this.cancelRun(this.opts.cancelOnStart);
      return;
    }

    // 10. script host
    await this.startScript();
  }

  // ---------------------------------------------------------------------------
  // journal / run.json
  // ---------------------------------------------------------------------------

  private async append(rows: JournalRow[]): Promise<void> {
    if (this.fenced) throw new RunnerFencedExit('runner is fenced');
    try {
      await withRunOwnership(this.opts.runDir, this.self!, () => appendRowsLocked(this.opts.runDir, rows));
    } catch (err) {
      this.onFenced(err);
      throw err;
    }
  }

  /** 临界区内：追加 + 额外操作（mkdir、入容器）；核对失败即围栏。 */
  private async appendAnd(rows: JournalRow[], extra: () => void): Promise<void> {
    if (this.fenced) throw new RunnerFencedExit('runner is fenced');
    try {
      await withRunOwnership(this.opts.runDir, this.self!, () => {
        appendRowsLocked(this.opts.runDir, rows);
        extra();
      });
    } catch (err) {
      this.onFenced(err);
      throw err;
    }
  }

  private onFenced(err: unknown): void {
    if (err instanceof FencedError || err instanceof OwnershipLockTimeoutError) {
      if (!this.fenced) {
        this.fenced = true;
        this.log(`fenced: ${err.message}`);
        void this.exitFenced();
      }
    }
  }

  private updateRunJsonLocked(patch: Partial<RunJson>): void {
    if (!this.runJson) return;
    this.runJson = { ...this.runJson, ...patch, updatedAt: nowMs() };
    writeRunJsonLocked(this.opts.runDir, this.runJson);
  }

  // ---------------------------------------------------------------------------
  // script host
  // ---------------------------------------------------------------------------

  private async startScript(): Promise<void> {
    const self = this.self!;
    const env: NodeJS.ProcessEnv = { ...this.childBaseEnv(), BOTMUX_FLOW_RUN_ID: this.opts.runId, BOTMUX_FLOW_RUN_DIR: this.opts.runDir };
    const soft = Math.max(1, Math.ceil((this.limits.maxScriptCpuMs * 2) / 1000));
    const hard = Math.max(soft + 1, Math.ceil((this.limits.maxScriptCpuMs * 3) / 1000));
    const link = (this.opts.spawnScriptHost ?? ((e, cpu) => this.defaultSpawnScriptHost(e, cpu)))(env, { soft, hard });
    this.script = link;
    this.scriptPid = link.pid;
    link.onMessage((message) => void this.onScriptMessage(message));
    link.onExit((code, signal) => {
      if (this.scriptReturned || this.finishing || this.fenced) return;
      void this.finishWithError(new Error(`script host exited unexpectedly (code ${code}, signal ${signal})`), 'script_host_exited');
    });
    await new Promise<void>((resolve) => {
      const onHello = (m: ScriptToRunnerMessage) => {
        if (m.t === 'hello') resolve();
      };
      link.onMessage(onHello);
      if (link.exited) resolve();
    });
    link.send({ t: 'start', source: this.scriptSource, input: this.runJson?.input ?? this.opts.input ?? null, cwd: this.cwd, execConfigDigest: this.execConfigDigest, filename: this.runJson?.script ?? 'flow-script.mjs' });
    this.lastCtxCallAt = nowMs();
    this.log(`script host pid ${link.pid} started (gen ${self.gen})`);
    await this.hook('script_started', { pid: link.pid });
  }

  private defaultSpawnScriptHost(env: NodeJS.ProcessEnv, cpu: { soft: number; hard: number }): ScriptLink {
    const { command, args } = resolveFlowEntry('flow-script', this.opts.distDir);
    // RLIMIT_CPU：软限制两倍预算（SIGXCPU 可被捕获），硬限制三倍且有限（SIGKILL 才是强制终止，§9）
    // 顺序必须先软后硬：初始软限制是 unlimited，先把硬限制压下来会让 soft > hard，setrlimit 报 EINVAL
    const child = spawn('sh', ['-c', 'ulimit -S -t "$1" && ulimit -H -t "$2"; shift 2; exec "$@"', 'flow-script', String(cpu.soft), String(cpu.hard), command, ...args], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env,
      cwd: this.cwd,
    });
    return linkChildProcess(child);
  }

  private async onScriptMessage(message: ScriptToRunnerMessage): Promise<void> {
    if (this.fenced || this.finishing) return;
    switch (message.t) {
      case 'hello':
        return;
      case 'done':
        this.scriptReturned = true;
        this.scriptDone = { kind: 'done', value: message.value };
        await this.maybeFinish();
        return;
      case 'error':
        this.scriptReturned = true;
        this.scriptDone = { kind: 'error', code: message.code, message: message.message, ...(message.stack ? { stack: message.stack } : {}) };
        await this.maybeFinish();
        return;
      case 'call':
        this.lastCtxCallAt = nowMs();
        try {
          const result = await this.handleCall(message);
          this.script?.send({ t: 'reply', id: message.id, result });
        } catch (err) {
          if (err instanceof RunnerFencedExit) return;
          const code = err instanceof CallRejected ? err.code : 'runner_error';
          this.script?.send({ t: 'reject', id: message.id, code, message: err instanceof Error ? err.message : String(err) });
        }
        return;
      default:
        return;
    }
  }

  private async handleCall(message: Extract<ScriptToRunnerMessage, { t: 'call' }>): Promise<unknown> {
    switch (message.op) {
      case 'position':
        return undefined;
      case 'log': {
        if (this.notes >= this.limits.maxNotes) throw new CallRejected('note_limit', `log() exceeded maxNotes (${this.limits.maxNotes})`);
        this.notes++;
        const text = message.text.length > 3000 ? `${message.text.slice(0, 3000)}…` : message.text;
        await this.append([{ t: 'note', gen: this.self!.gen, ts: nowMs(), text }]);
        this.recentNotes.push(text);
        if (this.recentNotes.length > SNAPSHOT_NOTES_TAIL) this.recentNotes.splice(0, this.recentNotes.length - SNAPSHOT_NOTES_TAIL);
        this.scheduleSnapshot();
        return undefined;
      }
      case 'signal':
        return this.handleSignal(message.identity, message.content, message.spec);
      case 'agent':
        return this.handleAgent(message.identity, message.content, message.spec);
      default:
        throw new CallRejected('unknown_op', `unknown ctx op`);
    }
  }

  // ---------------------------------------------------------------------------
  // agent：重放决策 → attempt 生命周期
  // ---------------------------------------------------------------------------

  private async handleAgent(identity: string, content: string, spec: AgentSpec): Promise<Outcome> {
    if (spec.session !== undefined) throw new CallRejected('session_unavailable', 'named sessions are not available in M1');
    if (this.inflight.has(identity)) throw new CallRejected('identity_in_flight', `identity ${identity} already has an attempt in flight`);
    for (;;) {
      const disposition = decideReplay(this.projection, identity, content);
      switch (disposition.action) {
        case 'cached':
          this.cacheHits++;
          return this.materialize(disposition.outcome);
        case 'accept_failed':
          this.cacheHits++;
          return disposition.outcome;
        case 'pending': {
          const decided = await this.pauseForDecision(identity, content, disposition.attempt, disposition.outcome, disposition.reason);
          if (decided.choice === 'canceled') {
            // run 被取消：不替人写任何 decision——失败仍待决策，resume 后再问
            return { ...disposition.outcome, category: 'canceled', retry: 'manual', error: `run canceled while ${identity} attempt ${disposition.attempt} awaited a decision (${disposition.outcome.error})` };
          }
          await this.append([{ t: 'decision', gen: this.self!.gen, ts: nowMs(), scope: { identity, content, attempt: disposition.attempt }, choice: decided.choice, by: decided.by }]);
          this.projection = loadJournal(this.opts.runDir).projection;
          if (decided.choice === 'timeout') {
            // 决策等待到期（§9）：decision {timeout} 已持久化，run 取消
            await this.cancelRun(`decision timeout for ${identity} attempt ${disposition.attempt}`);
            return { ...disposition.outcome, category: 'canceled', retry: 'manual', error: `decision for ${identity} attempt ${disposition.attempt} timed out after ${this.limits.decisionTimeoutMs}ms` };
          }
          continue;
        }
        case 'run':
          return this.runAttempt(identity, content, spec, disposition);
        default:
          throw new Error('unreachable');
      }
    }
  }

  private materialize(outcome: OkOutcome): OkOutcome {
    const value = outcome.value as { $file?: string } | null;
    if (value && typeof value === 'object' && typeof value.$file === 'string') {
      try {
        return { ...outcome, value: JSON.parse(readFileSync(value.$file, 'utf8')) as unknown };
      } catch (err) {
        throw new CallRejected('result_unreadable', `cached result for ${outcome.identity} could not be read from ${value.$file}: ${(err as Error).message}`);
      }
    }
    return outcome;
  }

  private async runAttempt(identity: string, content: string, spec: AgentSpec, disposition: Extract<ReplayDisposition, { action: 'run' }>): Promise<Outcome> {
    const self = this.self!;
    const attempt = disposition.attempt;
    if (this.projection.identities.size >= this.limits.maxAgents && !this.projection.identities.has(identity)) {
      throw new CallRejected('agent_limit', `maxAgents (${this.limits.maxAgents}) reached`);
    }
    const n = this.attemptCounter++;
    const container = containerName(self.gen, n);
    const attemptDir = join(this.opts.runDir, 'agents', identityDirName(identity), 'attempts', `${self.gen}-${attempt}`);
    mkdirSync(attemptDir, { recursive: true });
    const rows: JournalRow[] = [];
    if (disposition.divergence) rows.push({ t: 'divergence', gen: self.gen, ts: nowMs(), identity, expected: disposition.divergence.expected, actual: disposition.divergence.actual });
    rows.push({ t: 'started', gen: self.gen, ts: nowMs(), identity, attempt, content, kind: 'agent', cli: spec.cli });
    rows.push({ t: 'attempt.state', gen: self.gen, ts: nowMs(), identity, attempt, container, state: 'queued' });
    await this.append(rows);
    this.projection = loadJournal(this.opts.runDir).projection;

    const entry: InflightAttempt = { identity, attempt, container, containerPath: null, link: null, cancel: () => {}, slot: null };
    this.inflight.set(identity, entry);
    this.noteClockTransition();
    try {
      const outcome = await this.executeAttempt(entry, content, spec, attemptDir);
      await this.hook('after_settled', { identity, attempt, ok: outcome.ok });
      return outcome;
    } finally {
      this.inflight.delete(identity);
      this.noteClockTransition();
      this.projection = loadJournal(this.opts.runDir).projection;
    }
  }

  private async executeAttempt(entry: InflightAttempt, content: string, spec: AgentSpec, attemptDir: string): Promise<Outcome> {
    const self = this.self!;
    const { identity, attempt, container } = entry;
    const failRow = async (category: FailedOutcome['category'], retry: FailedOutcome['retry'], effects: FailedOutcome['effects'], error: string, evidence: Evidence): Promise<FailedOutcome> => {
      const row: FailedRow = { t: 'failed', gen: self.gen, ts: nowMs(), identity, attempt, category, retry, effects, error, evidence: trimEvidence(evidence, attemptDir) };
      await this.append([row]);
      return { ok: false, identity, attempt, evidence: row.evidence, error, category, retry, effects };
    };

    // 槽位与并发
    const slotWait = await this.waitForSlot(entry);
    if (!slotWait.ok) return failRow('slot_timeout', 'auto', 'none', slotWait.detail, { source: 'none', attemptDir });
    if (this.canceled) return failRow('canceled', 'manual', 'none', `run canceled (${this.canceled}) before the attempt started`, { source: 'none', attemptDir });

    // 容器：记录与 mkdir 同一临界区
    const cpath = this.backend ? containerPath(this.backend, this.opts.runId, container) : null;
    entry.containerPath = cpath;
    await this.appendAnd(
      [{ t: 'container.created', gen: self.gen, ts: nowMs(), container, kind: this.backend?.kind ?? 'none', path: cpath ?? '' }],
      () => {
        if (cpath) createContainerDir(cpath);
        // 故障注入点在临界区内：同步调用（注入器本身是同步的 SIGSTOP/SIGKILL）
        void this.hooks.at?.('in_container_created_section', { identity, attempt, container });
      },
    );
    await this.hook('after_container_created', { identity, attempt, container });

    // worker：spawn → hello → 入容器 + attempt.state spawning（同一临界区）→ contained
    const env: NodeJS.ProcessEnv = { ...this.childBaseEnv(), BOTMUX_FLOW_RUN_ID: this.opts.runId, BOTMUX_FLOW_RUN_DIR: this.opts.runDir };
    const link = (this.opts.spawnAgentWorker ?? ((e) => this.defaultSpawnAgentWorker(e)))(env);
    entry.link = link;
    this.spawns++;
    const inbox = new Inbox<AgentToRunnerMessage>();
    link.onMessage((m) => inbox.push(m));
    link.onExit((code, signal) => inbox.push({ t: 'closed', __exit: { code, signal } } as AgentToRunnerMessage));
    const killWorker = () => {
      link.kill('SIGTERM');
      setTimeout(() => link.kill('SIGKILL'), 2_000).unref();
    };
    const cleanup = async (): Promise<void> => {
      link.send({ t: 'close' });
      await inbox.waitFor((m) => m.t === 'closed', 5_000).catch(() => undefined);
      if (!link.exited) killWorker();
      if (this.backend && cpath) {
        const reclaimed = await reclaimContainer(this.backend, cpath);
        if (!reclaimed.ok) this.log(`container ${container} not reclaimed after settle: ${reclaimed.detail}`);
      }
      if (entry.slot) {
        await releaseSlot(this.opts.slotsFile, entry.slot);
        entry.slot = null;
      }
    };

    try {
      const hello = await inbox.waitFor((m) => m.t === 'hello' || m.t === 'closed', 15_000).catch(() => null);
      if (!hello || hello.t !== 'hello') {
        killWorker();
        return failRow('spawn_failed', 'auto', 'none', 'agent worker did not start', { source: 'none', attemptDir });
      }
      const pid = hello.pid;
      const pidIdentity = readProcessStartIdentity(pid) ?? '';
      try {
        await this.appendAnd(
          [{ t: 'attempt.state', gen: self.gen, ts: nowMs(), identity, attempt, container, state: 'spawning', pid, pidIdentity }],
          () => {
            if (cpath) addPidToContainer(cpath, pid);
            void this.hooks.at?.('in_contained_section', { identity, attempt, container, pid });
          },
        );
      } catch (err) {
        // 核对失败：那个 worker 还没起 CLI、不在任何容器里，是我们自己的直接子进程
        killWorker();
        throw err;
      }
      await this.hook('before_contained_notify', { identity, attempt, container, pid });
      link.send({ t: 'contained', container });

      const openInput: AgentWorkerOpenInput = {
        runId: this.opts.runId,
        identity,
        attempt,
        gen: self.gen,
        sessionId: attemptSessionId(this.opts.runId, identity, self.gen, attempt),
        cli: spec.cli,
        cliPath: this.cliPaths[spec.cli],
        model: spec.model ?? this.model,
        cwd: spec.cwd ? safeRealpath(spec.cwd) : this.cwd,
        env: stringEnv(env),
        ownerOpenId: this.opts.ownerOpenId ?? this.binding?.ownerOpenId ?? undefined,
        attemptDir,
        outboxDir: attemptDir,
        timeoutMs: spec.timeoutMs ?? this.limits.agentTimeoutMs,
      };
      link.send({ t: 'open', input: openInput });
      const opened = await inbox.waitFor((m) => m.t === 'ready' || m.t === 'open_failed' || m.t === 'closed', 120_000).catch(() => null);
      if (!opened || opened.t === 'closed') return failRow('spawn_failed', 'auto', 'none', 'agent worker exited while opening the CLI', { source: 'none', attemptDir });
      if (opened.t === 'open_failed') {
        const category = opened.code === 'cli_needs_setup' ? 'setup_required' : 'spawn_failed';
        return failRow(category, category === 'setup_required' ? 'manual' : 'auto', 'none', opened.message, { ...opened.evidence, attemptDir });
      }
      if (opened.t !== 'ready') return failRow('spawn_failed', 'auto', 'none', `unexpected worker message ${opened.t} while opening`, { source: 'none', attemptDir });
      await this.append([{ t: 'attempt.state', gen: self.gen, ts: nowMs(), identity, attempt, container, state: 'ready', cliPid: opened.cliPid }]);

      // 一次提交（schema 不符时同一会话内仅一次 repair）
      let turn = 0;
      let prompt = spec.prompt;
      let repaired = false;
      for (;;) {
        turn++;
        const outboxFile = outboxFileName(self.gen, turn, identity);
        const outboxPath = join(attemptDir, outboxFile);
        if (existsSync(outboxPath)) {
          await this.append([{ t: 'note', gen: self.gen, ts: nowMs(), text: `stale contract file ${outboxFile} existed before send.intent for ${identity}; removed` }]);
          unlinkSync(outboxPath);
        }
        await this.hook('before_send_intent', { identity, attempt, turn, outboxFile });
        await this.append([{ t: 'send.intent', gen: self.gen, ts: nowMs(), identity, attempt, container, turn, outboxFile }]);
        await this.hook('after_send_intent', { identity, attempt, turn, outboxFile });
        if (this.canceled) return failRow('canceled', 'manual', 'uncertain', `run canceled (${this.canceled}) after send intent`, { source: 'none', attemptDir });
        await this.hook('before_authorize', { identity, attempt, turn });
        link.send({ t: 'authorize', gen: self.gen, attempt, outboxFile, prompt });
        await this.hook('after_authorize', { identity, attempt, turn });

        let cancelReason: string | null = null;
        entry.cancel = (reason) => {
          cancelReason = reason;
          link.send({ t: 'cancel', reason });
        };
        const timeoutMs = spec.timeoutMs ?? this.limits.agentTimeoutMs;
        const deadline = setTimeout(() => entry.cancel('timeout'), timeoutMs);
        let settled: AgentToRunnerMessage | null;
        try {
          for (;;) {
            settled = await inbox.waitFor((m) => m.t === 'submitted' || m.t === 'settled' || m.t === 'closed', timeoutMs + 30_000).catch(() => null);
            if (settled?.t === 'submitted') {
              await this.append([{ t: 'send.confirmed', gen: self.gen, ts: nowMs(), identity, attempt }]).catch(() => undefined);
              continue;
            }
            break;
          }
        } finally {
          clearTimeout(deadline);
          entry.cancel = () => {};
        }
        if (!settled || settled.t !== 'settled') {
          return failRow('crashed', 'auto', 'uncertain', 'agent worker exited before settling the turn', { source: 'none', attemptDir });
        }
        if (settled.gen !== self.gen || settled.attempt !== attempt) {
          return failRow('crashed', 'auto', 'uncertain', `worker settled a different registration (gen ${settled.gen} attempt ${settled.attempt})`, { source: 'none', attemptDir });
        }
        const outcome = settled.outcome;
        if (outcome.status === 'failed') {
          if (cancelReason === 'timeout') return failRow('timeout', 'auto', 'uncertain', `agent did not settle within ${timeoutMs}ms`, outcome.evidence);
          if (cancelReason) return failRow('canceled', 'manual', 'uncertain', `canceled (${cancelReason}): ${outcome.detail}`, outcome.evidence);
          return failRow(...failureTriple(outcome), outcome.detail, outcome.evidence);
        }
        // completed：schema 校验（最后一个平衡 JSON 块）
        const settledOk = outcome as AgentSettledResult;
        if (Buffer.byteLength(settledOk.finalResponse, 'utf8') > AGENT_RESPONSE_MAX_BYTES) {
          return failRow('schema_mismatch', 'manual', 'uncertain', `agent response exceeds ${AGENT_RESPONSE_MAX_BYTES} bytes`, settledOk.evidence);
        }
        let value: unknown = settledOk.finalResponse;
        if (spec.schema !== undefined) {
          const parsed = extractLastJsonBlock(settledOk.finalResponse);
          const issues = parsed === null ? [{ path: '$', message: 'no JSON block found in the response' }] : validateValue(spec.schema, parsed);
          if (issues.length > 0) {
            if (!repaired) {
              repaired = true;
              prompt = `Your previous reply did not satisfy the required JSON schema:\n${issues.map((i) => `- ${i.path}: ${i.message}`).join('\n')}\nReply again with ONLY the corrected JSON object (no prose).`;
              continue;
            }
            return failRow('schema_mismatch', 'manual', 'uncertain', `response does not match schema after one repair: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`, settledOk.evidence);
          }
          value = parsed;
        }
        const row = await this.resultRow(identity, attempt, value, settledOk.evidence, attemptDir);
        await this.append([row]);
        return { ok: true, value, identity, attempt, evidence: row.evidence };
      }
    } finally {
      await cleanup();
    }
  }

  private async resultRow(identity: string, attempt: number, value: unknown, evidence: Evidence, attemptDir: string): Promise<ResultRow> {
    const self = this.self!;
    const trimmed = trimEvidence(evidence, attemptDir);
    let row: ResultRow = { t: 'result', gen: self.gen, ts: nowMs(), identity, attempt, value, evidence: trimmed };
    if (Buffer.byteLength(JSON.stringify(row), 'utf8') + 64 > JOURNAL_ROW_MAX_BYTES) {
      const file = join(attemptDir, 'value.json');
      writeFileSync(file, JSON.stringify(value));
      row = { ...row, value: { $file: file } };
    }
    return row;
  }

  private defaultSpawnAgentWorker(env: NodeJS.ProcessEnv): AgentLink {
    const { command, args } = resolveFlowEntry('flow-agent', this.opts.distDir);
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env, cwd: this.cwd });
    return linkChildProcess(child);
  }

  private async waitForSlot(entry: InflightAttempt): Promise<{ ok: true } | { ok: false; detail: string }> {
    const self = this.self!;
    const until = nowMs() + Math.min(this.limits.agentTimeoutMs, 10 * 60_000);
    const slot: SlotEntry = {
      runId: this.opts.runId,
      gen: self.gen,
      container: entry.container,
      cgroupPath: this.backend ? containerPath(this.backend, this.opts.runId, entry.container) : '',
      holderPid: self.pid,
      holderIdentity: self.identity,
      state: 'held',
    };
    for (;;) {
      const running = [...this.inflight.values()].filter((e) => e.slot !== null).length;
      if (running < this.limits.maxConcurrency) {
        const got = await acquireSlot(this.opts.slotsFile, slot, this.opts.hostSlots);
        if (got.ok) {
          entry.slot = slot;
          return { ok: true };
        }
        if (nowMs() > until) return { ok: false, detail: `host slots exhausted (${got.occupied}/${got.capacity}) for ${Math.round((until - nowMs()) / 1000)}s` };
      } else if (nowMs() > until) {
        return { ok: false, detail: `maxConcurrency (${this.limits.maxConcurrency}) never freed a slot` };
      }
      if (this.canceled || this.fenced) return { ok: false, detail: 'run is no longer accepting attempts' };
      await sleep(500);
    }
  }

  // ---------------------------------------------------------------------------
  // 决策 / 暂停
  // ---------------------------------------------------------------------------

  private async pauseForDecision(identity: string, content: string, attempt: number, outcome: FailedOutcome, reason: PendingDecision['reason']): Promise<{ choice: DecisionChoice | 'canceled'; by: string }> {
    const key = decisionKey(identity, content, attempt);
    this.log(`paused: ${identity} attempt ${attempt} needs a decision (${reason}: ${outcome.error})`);
    let by = this.opts.decidedBy ?? 'operator';
    const choice = await new Promise<DecisionChoice | 'canceled'>((resolve) => {
      this.pendingWaits.set(key, {
        decision: { identity, content, attempt, outcome, reason },
        resolve: (c) => resolve(c),
      });
      this.noteClockTransition();
      this.scheduleSnapshot();
      void this.hook('paused', { identity, attempt, reason });
      this.armDecisionTimeout(key);
    });
    const decidedBy = this.lastDecisionBy.get(key);
    if (decidedBy) {
      by = decidedBy;
      this.lastDecisionBy.delete(key);
    }
    this.pendingWaits.delete(key);
    this.noteClockTransition();
    this.scheduleSnapshot();
    return { choice, by };
  }

  private readonly lastDecisionBy = new Map<string, string>();

  private armDecisionTimeout(key: string): void {
    const timer = setTimeout(() => {
      const wait = this.pendingWaits.get(key);
      if (wait) wait.resolve('timeout');
    }, this.limits.decisionTimeoutMs);
    timer.unref();
  }

  private async pauseRun(reason: PendingDecision['reason'], detail: string): Promise<DecisionChoice> {
    this.log(`paused (run): ${reason}: ${detail}`);
    if (reason === 'container_unavailable' && this.opts.assumeClean) return 'assume-clean';
    if (reason === 'escape' && this.opts.assumeClean) return 'assume-clean';
    if (reason === 'journal_integrity' && this.opts.acceptJournal) return 'accept-journal';
    if (!this.control) this.openControl();
    const choice = await new Promise<DecisionChoice>((resolve) => {
      this.runPause = { reason, detail, resolve };
      this.scheduleSnapshot();
      void this.hook('paused', { reason, detail });
    });
    this.runPause = null;
    this.scheduleSnapshot();
    return choice;
  }

  // ---------------------------------------------------------------------------
  // signal()：逻辑等待与卡片投递分离（§7.3），runner 唯一裁决（§7.2）
  // ---------------------------------------------------------------------------

  private async handleSignal(identity: string, content: string, spec: SignalSpec): Promise<Outcome> {
    if (!this.binding) throw new CallRejected('signal_unbound', 'signal() needs a Feishu topic binding; this run was started without one');
    if (this.openWaits.has(identity)) throw new CallRejected('identity_in_flight', `identity ${identity} already has a wait open`);
    const self = this.self!;
    const existing = this.projection.waits.get(identity);
    // 重放：signal 且 content 相同 → 直接返回
    if (existing && existing.state === 'consumed' && existing.content === content && existing.signal) {
      this.cacheHits++;
      return this.signalOutcome(identity, existing.version, existing.signal.value, existing.signal.by, existing.delivery?.card?.messageId ?? null);
    }
    if (this.canceled) {
      return { ok: false, identity, attempt: existing?.version ?? 0, evidence: { source: 'none' }, error: `run canceled (${this.canceled}) before the wait opened`, category: 'canceled', retry: 'manual', effects: 'none' };
    }
    let version: number;
    let reuse = false;
    const rows: JournalRow[] = [];
    if (existing && existing.state === 'open' && existing.content === content) {
      // wait 逻辑上仍 open 且 content 相同 → 复用等待（不写新 wait 行）
      version = existing.version;
      reuse = true;
    } else {
      version = (existing?.version ?? 0) + 1;
      if (existing && existing.state === 'open') rows.push({ t: 'wait.superseded', gen: self.gen, ts: nowMs(), identity, version: existing.version });
      rows.push({ t: 'wait', gen: self.gen, ts: nowMs(), identity, content, version, schema: spec.schema, prompt: spec.prompt });
    }
    if (rows.length > 0) await this.append(rows);
    const timeoutMs = spec.timeoutMs ?? DEFAULT_SIGNAL_TIMEOUT_MS;
    const openedAt = nowMs();
    const wait: OpenSignalWait = {
      identity,
      content,
      version,
      prompt: spec.prompt,
      schema: spec.schema,
      openedAt,
      timeoutAt: openedAt + timeoutMs,
      delivery: reuse ? (existing!.delivery?.state ?? 'pending') : 'pending',
      messageId: reuse ? (existing!.delivery?.card?.messageId ?? null) : null,
      deliveryError: reuse ? (existing!.delivery?.error ?? null) : null,
      resolve: () => {},
      timer: null,
      arbitrating: Promise.resolve(),
    };
    this.openWaits.set(identity, wait);
    this.noteClockTransition();
    this.projection = loadJournal(this.opts.runDir).projection;
    const outcomePromise = new Promise<Outcome>((resolve) => {
      wait.resolve = resolve;
    });
    wait.timer = setTimeout(() => void this.expireWait(identity, version), timeoutMs);
    wait.timer.unref();
    this.log(`wait ${identity} v${version} opened${reuse ? ' (reused from a previous generation)' : ''}`);

    // 投递（临界区外，失败不关闭逻辑等待）
    if (reuse && wait.messageId) {
      const refreshed = await this.daemonRequest({ t: 'wait.refresh', wait: this.openWaitView(wait) });
      if (!refreshed.ok) await this.deliverWait(wait, wait.messageId);
    } else {
      await this.deliverWait(wait, null);
    }
    this.scheduleSnapshot();
    try {
      return await outcomePromise;
    } finally {
      if (wait.timer) clearTimeout(wait.timer);
      if (this.openWaits.get(identity) === wait) this.openWaits.delete(identity);
      this.noteClockTransition();
      this.projection = loadJournal(this.opts.runDir).projection;
      this.scheduleSnapshot();
    }
  }

  private signalOutcome(identity: string, version: number, value: unknown, by: string, messageId: string | null): OkOutcome {
    return { ok: true, value, identity, attempt: version, evidence: { source: 'signal', confidence: 'high', by, version, ...(messageId ? { messageId } : {}) } };
  }

  private openWaitView(wait: OpenSignalWait): OpenWait {
    return {
      identity: wait.identity,
      version: wait.version,
      content: wait.content,
      prompt: wait.prompt,
      schema: wait.schema,
      delivery: wait.delivery,
      messageId: wait.messageId,
      deliveryError: wait.deliveryError,
      openedAt: wait.openedAt,
      timeoutAt: wait.timeoutAt,
    };
  }

  /** 投递信号卡并记 wait.delivery（§7.3、§7.4）。`supersedes` 非空即重发（resent）。 */
  private async deliverWait(wait: OpenSignalWait, supersedes: string | null): Promise<void> {
    const self = this.self!;
    const res = await this.daemonRequest({ t: 'wait.deliver', wait: this.openWaitView(wait), supersedes });
    if (this.openWaits.get(wait.identity) !== wait) return; // 期间已结束
    if (res.ok) {
      wait.delivery = supersedes !== null ? 'resent' : 'delivered';
      wait.messageId = res.messageId;
      wait.deliveryError = null;
      await this.append([{ t: 'wait.delivery', gen: self.gen, ts: nowMs(), identity: wait.identity, version: wait.version, state: wait.delivery, ...(res.messageId ? { card: { messageId: res.messageId } } : {}) }]).catch(() => undefined);
    } else {
      wait.delivery = 'failed';
      wait.deliveryError = res.error;
      this.log(`wait ${wait.identity} v${wait.version} delivery failed: ${res.error}`);
      await this.append([{ t: 'wait.delivery', gen: self.gen, ts: nowMs(), identity: wait.identity, version: wait.version, state: 'failed', error: res.error.slice(0, 500) }]).catch(() => undefined);
    }
  }

  private async expireWait(identity: string, version: number): Promise<void> {
    const wait = this.openWaits.get(identity);
    if (!wait || wait.version !== version) return;
    await this.closeWait(wait, 'timeout', null);
    wait.resolve({ ok: false, identity, attempt: version, evidence: { source: 'none', version }, error: `no signal within ${wait.timeoutAt - wait.openedAt}ms`, category: 'wait_timeout', retry: 'manual', effects: 'none' });
  }

  /** 关闭一个逻辑等待（超时 / 取消）：作废 wait 行、冻结卡片。消费路径在 arbitrateSignal 里。 */
  private async closeWait(wait: OpenSignalWait, how: 'timeout' | 'canceled', by: string | null): Promise<void> {
    this.openWaits.delete(wait.identity);
    if (wait.timer) clearTimeout(wait.timer);
    await this.append([{ t: 'wait.superseded', gen: this.self!.gen, ts: nowMs(), identity: wait.identity, version: wait.version }]).catch(() => undefined);
    void this.daemonRequest({ t: 'wait.close', identity: wait.identity, version: wait.version, messageId: wait.messageId, how, by });
  }

  /**
   * 裁决一次信号提交（§7.2）：同一 identity 串行；核对 version（与 content）与当前逻辑 open 的 wait
   * 一致 → 按持久化 schema 校验 → 先追加 `signal` 行并 fsync，再应答，再释放脚本。
   */
  private arbitrateSignal(request: Extract<ControlRequest, { t: 'signal' }>): Promise<ControlResponse> {
    const wait = this.openWaits.get(request.identity);
    if (!wait) {
      const recorded = this.projection.waits.get(request.identity);
      if (recorded?.state === 'consumed') return Promise.resolve({ ok: false, code: 'consumed', error: `signal for ${request.identity} v${recorded.version} was already submitted` });
      return Promise.resolve({ ok: false, code: 'no_wait', error: `no open wait for ${request.identity}` });
    }
    const run = async (): Promise<ControlResponse> => {
      if (this.openWaits.get(request.identity) !== wait) return { ok: false, code: 'consumed', error: `wait ${request.identity} v${wait.version} is no longer open` };
      if (request.version !== wait.version) return { ok: false, code: 'stale_version', error: `wait ${request.identity} is at v${wait.version}, submission targeted v${request.version}` };
      if (request.content !== undefined && request.content !== wait.content) return { ok: false, code: 'content_mismatch', error: `submission content does not match the open wait for ${request.identity}` };
      const bytes = Buffer.byteLength(JSON.stringify(request.value ?? null), 'utf8');
      if (bytes > SIGNAL_PAYLOAD_MAX_BYTES) return { ok: false, code: 'payload_too_large', error: `signal payload is ${bytes} bytes, limit ${SIGNAL_PAYLOAD_MAX_BYTES}` };
      const issues = validateValue(wait.schema, request.value);
      if (issues.length > 0) return { ok: false, code: 'schema_mismatch', error: `signal payload does not match the schema: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}` };
      const row: JournalRow = { t: 'signal', gen: this.self!.gen, ts: nowMs(), identity: wait.identity, content: wait.content, version: wait.version, by: request.by, value: request.value };
      try {
        await this.append([row]);
      } catch (err) {
        if (err instanceof RunnerFencedExit) return { ok: false, error: 'runner is fenced; a newer generation owns this run' };
        return { ok: false, error: `could not persist the signal: ${err instanceof Error ? err.message : String(err)}` };
      }
      this.openWaits.delete(wait.identity);
      if (wait.timer) clearTimeout(wait.timer);
      this.projection = loadJournal(this.opts.runDir).projection;
      this.log(`signal ${wait.identity} v${wait.version} by ${request.by}`);
      void this.daemonRequest({ t: 'wait.close', identity: wait.identity, version: wait.version, messageId: wait.messageId, how: 'consumed', by: request.by });
      // 先持久化并应答（本函数返回），再释放脚本
      setImmediate(() => wait.resolve(this.signalOutcome(wait.identity, wait.version, request.value, request.by, wait.messageId)));
      return { ok: true, status: this.currentStatus(), pending: this.pendingList(), waits: this.openWaitList().filter((w) => w.identity !== wait.identity) };
    };
    const result = wait.arbitrating.then(run, run);
    wait.arbitrating = result.then(() => undefined, () => undefined);
    return result;
  }

  private async resendWait(request: Extract<ControlRequest, { t: 'resend' }>): Promise<ControlResponse> {
    const wait = this.openWaits.get(request.identity);
    if (!wait) return { ok: false, code: 'no_wait', error: `no open wait for ${request.identity}` };
    const self = this.self!;
    const oldVersion = wait.version;
    const oldMessageId = wait.messageId;
    wait.version = oldVersion + 1;
    wait.delivery = 'pending';
    wait.messageId = null;
    wait.deliveryError = null;
    await this.append([
      { t: 'wait.superseded', gen: self.gen, ts: nowMs(), identity: wait.identity, version: oldVersion },
      { t: 'wait', gen: self.gen, ts: nowMs(), identity: wait.identity, content: wait.content, version: wait.version, schema: wait.schema, prompt: wait.prompt },
    ]);
    this.projection = loadJournal(this.opts.runDir).projection;
    this.log(`wait ${wait.identity} resent as v${wait.version} by ${request.by}`);
    await this.deliverWait(wait, oldMessageId ?? '');
    this.scheduleSnapshot();
    return { ok: true, status: this.currentStatus(), pending: this.pendingList(), waits: this.openWaitList() };
  }

  private pendingList(): PendingDecision[] {
    return [...this.pendingWaits.values()].map((w) => w.decision);
  }

  private openWaitList(): OpenWait[] {
    return [...this.openWaits.values()].map((w) => this.openWaitView(w));
  }

  // ---------------------------------------------------------------------------
  // 控制通道：unix socket（终端）与 daemon IPC（卡片）承载同一组请求
  // ---------------------------------------------------------------------------

  private openControl(): void {
    const path = this.opts.controlSocket === undefined ? controlSocketPath(this.opts.runDir) : this.opts.controlSocket;
    if (!path || this.control) return;
    try {
      rmSync(path, { force: true });
    } catch {
      // ignore
    }
    const server = createServer((socket) => this.serveControl(socket));
    server.on('error', (err) => this.log(`control socket error: ${err.message}`));
    server.listen(path);
    // 不 unref：暂停等决策时它是 runner 唯一的存活理由；结束路径都会 closeControl
    this.control = server;
  }

  private serveControl(socket: Socket): void {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        let request: ControlRequest | null = null;
        try {
          request = JSON.parse(line) as ControlRequest;
        } catch {
          socket.write(`${JSON.stringify({ ok: false, error: 'invalid json' } satisfies ControlResponse)}\n`);
          continue;
        }
        void this.handleControl(request).then(
          (response) => socket.write(`${JSON.stringify(response)}\n`),
          (err) => socket.write(`${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ControlResponse)}\n`),
        );
      }
    });
    socket.on('error', () => undefined);
  }

  private currentStatus(): RunStatus {
    if (this.canceled) return 'canceled';
    if (this.pendingWaits.size > 0 || this.runPause || this.openWaits.size > 0) return 'paused';
    return 'running';
  }

  private async handleControl(request: ControlRequest): Promise<ControlResponse> {
    switch (request.t) {
      case 'status':
        return { ok: true, status: this.currentStatus(), pending: this.pendingList(), waits: this.openWaitList() };
      case 'decide': {
        const key = decisionKey(request.identity, request.content, request.attempt);
        const wait = this.pendingWaits.get(key);
        if (!wait) return { ok: false, code: 'no_decision', error: `no pending decision for ${request.identity} attempt ${request.attempt} with that content` };
        this.log(`decision by ${request.by}: ${request.identity} attempt ${request.attempt} → ${request.choice}`);
        this.lastDecisionBy.set(key, request.by);
        wait.resolve(request.choice);
        return { ok: true, status: this.currentStatus(), pending: this.pendingList().filter((p) => p.identity !== request.identity), waits: this.openWaitList() };
      }
      case 'decide-run': {
        if (!this.runPause) return { ok: false, code: 'not_paused', error: 'run is not paused on a run-level decision' };
        this.runPause.resolve(request.choice);
        return { ok: true, status: 'running', pending: this.pendingList(), waits: this.openWaitList() };
      }
      case 'cancel':
        void this.cancelRun(`by ${request.by}`);
        return { ok: true, status: 'canceled', pending: [], waits: [] };
      case 'signal':
        return this.arbitrateSignal(request);
      case 'resend':
        return this.resendWait(request);
      default:
        return { ok: false, code: 'unknown_request', error: 'unknown request' };
    }
  }

  // ---------------------------------------------------------------------------
  // daemon 通道：快照上行、投递请求、控制请求下行（M2 §6.1）
  // ---------------------------------------------------------------------------

  private attachDaemon(): void {
    const link = this.opts.daemonLink === undefined ? processDaemonLink() : this.opts.daemonLink;
    if (!link) return;
    this.daemon = link;
    link.onMessage((message) => void this.onDaemonMessage(message));
    link.onDisconnect(() => {
      this.log('daemon disconnected');
      this.daemonGone = true;
      for (const [id, resolve] of this.daemonPending) {
        this.daemonPending.delete(id);
        resolve({ ok: false, error: 'daemon disconnected' });
      }
      this.daemon = null;
      // §6.4：IPC 断开 → run.interrupted、回收、释放 lease、退出
      if (this.self) void this.interrupt('daemon_disconnect');
    });
  }

  private async onDaemonMessage(message: DaemonToRunnerMessage): Promise<void> {
    switch (message.t) {
      case 'request': {
        let res: ControlResponse;
        try {
          res = this.fenced ? { ok: false, error: 'runner is fenced' } : await this.handleControl(message.req);
        } catch (err) {
          res = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        this.daemon?.send({ t: 'response', id: message.id, res });
        return;
      }
      case 'response': {
        const resolve = this.daemonPending.get(message.id);
        if (resolve) {
          this.daemonPending.delete(message.id);
          resolve(message.res);
        }
        return;
      }
      default:
        return;
    }
  }

  /** 请 daemon 做一件事（投递 / 更新卡片）。没有通道即失败，调用方按投递失败处理。 */
  private daemonRequest(req: DaemonRequest, timeoutMs = 15_000): Promise<DaemonResponse> {
    if (!this.daemon) return Promise.resolve({ ok: false, error: this.binding ? 'no daemon link (run was started or resumed outside the daemon)' : 'run has no topic binding' });
    const id = ++this.daemonRequestSeq;
    return new Promise<DaemonResponse>((resolve) => {
      const timer = setTimeout(() => {
        if (this.daemonPending.delete(id)) resolve({ ok: false, error: `daemon did not answer ${req.t} within ${timeoutMs}ms` });
      }, timeoutMs);
      timer.unref();
      this.daemonPending.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      this.daemon!.send({ t: 'request', id, req });
    });
  }

  /** 推运行快照给 daemon（节流；daemon 据此渲染进度卡与决策卡）。 */
  private scheduleSnapshot(): void {
    if (!this.daemon || this.snapshotTimer) return;
    const wait = Math.max(0, SNAPSHOT_MIN_INTERVAL_MS - (nowMs() - this.lastSnapshotAt));
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.sendSnapshot();
    }, wait);
    this.snapshotTimer.unref();
  }

  private sendSnapshot(finished: RunSnapshot['finished'] = null, error: RunSnapshot['error'] = null): void {
    if (!this.daemon || !this.self) return;
    this.lastSnapshotAt = nowMs();
    this.daemon.send({ t: 'snapshot', snapshot: this.snapshot(finished, error) });
  }

  snapshot(finished: RunSnapshot['finished'] = null, error: RunSnapshot['error'] = null): RunSnapshot {
    const p = this.projection;
    const attempts: RunSnapshot['attempts'] = [];
    for (const ident of p.identities.values()) {
      const a = ident.latest;
      attempts.push({
        identity: a.identity,
        attempt: a.attempt,
        state: a.state,
        phase: a.phase,
        ...(a.cli ? { cli: a.cli } : {}),
        ...(a.failed ? { category: a.failed.category, error: a.failed.error } : {}),
      });
    }
    return {
      runId: this.opts.runId,
      gen: this.self?.gen ?? 0,
      status: finished ? finished.status : this.currentStatus(),
      health: p.health,
      counts: { ...p.counts },
      attempts,
      pending: this.pendingList(),
      runPause: this.runPause ? { reason: this.runPause.reason, detail: this.runPause.detail } : null,
      waits: this.openWaitList(),
      notes: [...this.recentNotes],
      finished,
      error,
      activeMs: this.activeMs,
      updatedAt: nowMs(),
    };
  }

  // ---------------------------------------------------------------------------
  // 秒表、看门狗、CPU、心跳
  // ---------------------------------------------------------------------------

  private clockState(): 'walking' | 'stopped' | 'unanchored' | 'returned' {
    if (this.inflight.size > 0) return 'walking';
    if (this.pendingWaits.size > 0 || this.runPause || this.openWaits.size > 0) return 'stopped';
    if (this.scriptReturned) return 'returned';
    return 'unanchored';
  }

  private noteClockTransition(): void {
    const now = nowMs();
    this.accumulate(now);
    const state = this.clockState();
    if (state !== 'returned' && state !== this.lastClockState) {
      this.lastClockState = state;
      this.lastActivityRowAt = now;
      void this.append([{ t: 'activity', gen: this.self!.gen, ts: now, activeMs: this.activeMs, cpuMs: this.cpuBaseMs + this.cpuSampleMs }]).catch(() => undefined);
    }
    this.scheduleSnapshot();
  }

  private accumulate(now: number): void {
    const state = this.clockState();
    if (state === 'walking' || state === 'unanchored') this.activeMs += Math.max(0, now - this.lastTick);
    this.lastTick = now;
  }

  private async tick(): Promise<void> {
    if (this.fenced || this.finishing || !this.self) return;
    const now = nowMs();
    this.accumulate(now);
    // CPU 采样：不依赖 script host 配合
    if (this.scriptPid) {
      const sample = readCpuMs(this.scriptPid);
      if (sample !== null) this.cpuSampleMs = sample;
    }
    const cpuMs = this.cpuBaseMs + this.cpuSampleMs;
    if (cpuMs > this.limits.maxScriptCpuMs) return void this.finishWithError(new Error(`script CPU ${Math.round(cpuMs)}ms exceeded maxScriptCpuMs ${this.limits.maxScriptCpuMs}`), 'script_cpu_exceeded');
    if (this.activeMs > this.limits.maxDurationMs) return void this.finishWithError(new Error(`active time ${Math.round(this.activeMs)}ms exceeded maxDurationMs ${this.limits.maxDurationMs}`), 'run_timeout');
    const state = this.clockState();
    if (this.script && state === 'unanchored' && now - this.lastCtxCallAt > this.limits.scriptSliceMs) {
      return void this.finishWithError(new Error(`script made no ctx call for ${Math.round((now - this.lastCtxCallAt) / 1000)}s with nothing in flight and nothing to wait for`), 'script_stalled');
    }
    try {
      await heartbeat(this.opts.runDir, this.self, () => {
        this.updateRunJsonLocked({ status: this.currentStatus(), health: this.projection.health, activeMs: this.activeMs, cpuMs });
        if (now - this.lastActivityRowAt >= ACTIVITY_ROW_INTERVAL_MS) {
          this.lastActivityRowAt = now;
          appendRowsLocked(this.opts.runDir, [{ t: 'activity', gen: this.self!.gen, ts: now, activeMs: this.activeMs, cpuMs }]);
        }
      });
    } catch (err) {
      this.onFenced(err);
      return;
    }
    if (this.backend) {
      const results = await reclaimForeignContainers(this.backend, this.opts.runId, this.self.gen, { drainTimeoutMs: 2_000, maxCycles: 1 });
      for (const r of results) if (!r.result.ok) this.log(`tree scan: ${r.container} still populated (${r.result.detail})`);
    }
  }

  // ---------------------------------------------------------------------------
  // 结束
  // ---------------------------------------------------------------------------

  private async maybeFinish(): Promise<void> {
    if (this.inflight.size > 0 && this.scriptDone?.kind === 'done') {
      // 脚本已返回但仍有在途副作用：script host 已把它判成 unawaited_effect，这里不会走到；保险起见等待
      return;
    }
    await this.finish();
  }

  async cancelRun(reason: string): Promise<void> {
    if (this.canceled) return;
    this.canceled = reason;
    this.log(`cancel: ${reason}`);
    // 待决策的失败不替人决定：resolve 'canceled' 不写 decision 行，resume 后仍待决策
    for (const wait of this.pendingWaits.values()) wait.resolve('canceled');
    this.runPause?.resolve('timeout');
    // 上一代留下的、本代还没重放到的逻辑 open 的 wait（典型：中断卡上点「取消」→ cancelOnStart）：
    // 一并作废并冻结卡片，否则飞书里那张信号卡会一直可提交
    const currentWaits = new Set(this.openWaits.keys());
    const inherited = [...this.projection.waits.values()].filter((w) => w.state === 'open' && !currentWaits.has(w.identity));
    for (const wait of [...this.openWaits.values()]) {
      await this.closeWait(wait, 'canceled', null);
      wait.resolve({ ok: false, identity: wait.identity, attempt: wait.version, evidence: { source: 'none', version: wait.version }, error: `run canceled (${reason}) while waiting for a signal`, category: 'canceled', retry: 'manual', effects: 'none' });
    }
    for (const w of inherited) {
      if (this.self) await this.append([{ t: 'wait.superseded', gen: this.self.gen, ts: nowMs(), identity: w.identity, version: w.version }]).catch(() => undefined);
      void this.daemonRequest({ t: 'wait.close', identity: w.identity, version: w.version, messageId: w.delivery?.card?.messageId ?? null, how: 'canceled', by: null });
    }
    for (const entry of this.inflight.values()) entry.cancel(`run canceled: ${reason}`);
    this.script?.send({ t: 'abort', reason });
    if (!this.script) await this.finish();
  }

  private async finishWithError(err: unknown, code = 'runner_error'): Promise<void> {
    if (this.finishing || this.fenced) return;
    const message = err instanceof Error ? err.message : String(err);
    this.hardError = { code, message, ...(err instanceof Error && err.stack ? { stack: err.stack } : {}) };
    this.log(`hard error ${code}: ${message}`);
    for (const entry of this.inflight.values()) entry.cancel(`hard error: ${code}`);
    this.script?.send({ t: 'abort', reason: `${code}: ${message}` });
    await this.finish();
  }

  private async finish(): Promise<void> {
    if (this.finishing || this.fenced || !this.self) return;
    this.finishing = true;
    const self = this.self;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    // 等在途 attempt 结算（它们已被 cancel）
    const waitUntil = nowMs() + 20_000;
    while (this.inflight.size > 0 && nowMs() < waitUntil) await sleep(100);
    for (const entry of this.inflight.values()) {
      entry.link?.kill('SIGKILL');
      if (this.backend && entry.containerPath) await reclaimContainer(this.backend, entry.containerPath, { drainTimeoutMs: 3_000 });
      if (entry.slot) await releaseSlot(this.opts.slotsFile, entry.slot).catch(() => undefined);
    }
    this.script?.kill('SIGTERM');

    this.projection = loadJournal(this.opts.runDir).projection;
    const counts = { started: this.projection.counts.started, ok: this.projection.counts.ok, failed: this.projection.counts.failed };
    const health = this.projection.health;
    let status: RunStatus;
    let returned: unknown = null;
    const rows: JournalRow[] = [];
    if (this.hardError) {
      rows.push({ t: 'run.error', gen: self.gen, ts: nowMs(), code: this.hardError.code, error: this.hardError.message, ...(this.hardError.stack ? { stack: this.hardError.stack } : {}) });
      status = 'failed';
    } else if (this.canceled) {
      status = 'canceled';
    } else if (this.scriptDone?.kind === 'error') {
      rows.push({ t: 'run.error', gen: self.gen, ts: nowMs(), code: this.scriptDone.code, error: this.scriptDone.message, ...(this.scriptDone.stack ? { stack: this.scriptDone.stack } : {}) });
      status = 'failed';
    } else {
      returned = this.scriptDone?.value ?? null;
      status = health === 'all_failed' ? 'failed' : health === 'degraded' ? 'partial' : 'completed';
    }
    const replay: 'full' | 'mixed' | 'none' = this.spawns === 0 ? (this.cacheHits > 0 ? 'full' : 'none') : this.cacheHits > 0 ? 'mixed' : 'none';
    this.accumulate(nowMs());
    rows.push({ t: 'activity', gen: self.gen, ts: nowMs(), activeMs: this.activeMs, cpuMs: this.cpuBaseMs + this.cpuSampleMs });
    rows.push({ t: 'run.finished', gen: self.gen, ts: nowMs(), status, health, counts, returned, replay });
    let exitCode = status === 'completed' ? 0 : status === 'partial' ? 2 : 1;
    try {
      await withRunOwnership(this.opts.runDir, self, () => {
        appendRowsLocked(this.opts.runDir, rows);
        this.updateRunJsonLocked({ status, health, holder: null, activeMs: this.activeMs, cpuMs: this.cpuBaseMs + this.cpuSampleMs });
      });
      await releaseRun(this.opts.runDir, self);
    } catch (err) {
      this.onFenced(err);
      exitCode = 75;
    }
    this.closeControl();
    if (this.backend) removeRunTreeIfEmpty(this.backend, this.opts.runId);
    this.projection = loadJournal(this.opts.runDir).projection;
    this.sendSnapshot({ status, health, replay, returned }, this.hardError ? { code: this.hardError.code, message: this.hardError.message } : this.scriptDone?.kind === 'error' ? { code: this.scriptDone.code, message: this.scriptDone.message } : null);
    await this.hook('finished', { status });
    this.finishResolve?.({ runId: this.opts.runId, gen: self.gen, status, health, returned, counts, replay, containment: this.verdict, exitCode });
  }

  /** 被围栏：不写 journal，只回收自己代次的资源后退出。 */
  private async exitFenced(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const wait of this.pendingWaits.values()) wait.resolve('canceled');
    for (const wait of this.openWaits.values()) {
      if (wait.timer) clearTimeout(wait.timer);
      wait.resolve({ ok: false, identity: wait.identity, attempt: wait.version, evidence: { source: 'none' }, error: 'runner was fenced while waiting for a signal', category: 'interrupted', retry: 'manual', effects: 'none' });
    }
    this.openWaits.clear();
    for (const entry of this.inflight.values()) {
      entry.link?.kill('SIGKILL');
      if (this.backend && entry.containerPath) await reclaimContainer(this.backend, entry.containerPath, { drainTimeoutMs: 3_000 }).catch(() => undefined);
    }
    this.script?.kill('SIGKILL');
    this.closeControl();
    this.finishResolve?.({
      runId: this.opts.runId,
      gen: this.self?.gen ?? 0,
      status: 'interrupted',
      health: this.projection.health,
      returned: null,
      counts: { started: this.projection.counts.started, ok: this.projection.counts.ok, failed: this.projection.counts.failed },
      replay: 'none',
      containment: this.verdict,
      exitCode: 75,
    });
  }

  /** 外部中断（SIGTERM/SIGINT）：写 run.interrupted，回收，释放 lease。 */
  async interrupt(reason: string): Promise<void> {
    if (this.finishing || this.fenced || !this.self) return;
    this.finishing = true;
    const self = this.self;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    // 逻辑 open 的 wait 保持 open（resume 复用，§7.4）；只停计时器
    for (const wait of this.openWaits.values()) if (wait.timer) clearTimeout(wait.timer);
    const inflightIds = [...this.inflight.keys(), ...this.openWaits.keys()];
    for (const entry of this.inflight.values()) {
      entry.link?.kill('SIGKILL');
      if (this.backend && entry.containerPath) await reclaimContainer(this.backend, entry.containerPath, { drainTimeoutMs: 3_000 }).catch(() => undefined);
      if (entry.slot) await releaseSlot(this.opts.slotsFile, entry.slot).catch(() => undefined);
    }
    this.script?.kill('SIGKILL');
    try {
      await withRunOwnership(this.opts.runDir, self, () => {
        appendRowsLocked(this.opts.runDir, [
          { t: 'activity', gen: self.gen, ts: nowMs(), activeMs: this.activeMs, cpuMs: this.cpuBaseMs + this.cpuSampleMs },
          { t: 'run.interrupted', gen: self.gen, ts: nowMs(), reason, inflight: inflightIds },
        ]);
        this.updateRunJsonLocked({ status: 'interrupted', holder: null, activeMs: this.activeMs });
      });
      await releaseRun(this.opts.runDir, self);
    } catch (err) {
      this.onFenced(err);
    }
    this.closeControl();
    this.finishResolve?.({
      runId: this.opts.runId,
      gen: self.gen,
      status: 'interrupted',
      health: this.projection.health,
      returned: null,
      counts: { started: this.projection.counts.started, ok: this.projection.counts.ok, failed: this.projection.counts.failed },
      replay: 'none',
      containment: this.verdict,
      exitCode: 130,
    });
  }

  private closeControl(): void {
    if (!this.control) return;
    try {
      this.control.close();
    } catch {
      // ignore
    }
    this.control = null;
    const path = this.opts.controlSocket === undefined ? controlSocketPath(this.opts.runDir) : this.opts.controlSocket;
    if (path) rmSync(path, { force: true });
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 三个 flow 入口的 spawn 形态。默认 `resolveEntrySpawn`（Node: dist/*.js；编译态: 自身 + 隐藏子命令）。
 * 测试专用：`BOTMUX_FLOW_TS_SRC_DIR` 指向 src/ 时直接跑 TypeScript 源（Node 加 tsx loader，Bun 原生），
 * 让进程级故障注入测试不依赖 dist/ 与源码同步。
 */
export function resolveFlowEntry(entry: 'flow-runner' | 'flow-script' | 'flow-agent', distDir: string): { command: string; args: string[] } {
  const tsSrc = process.env.BOTMUX_FLOW_TS_SRC_DIR;
  if (tsSrc) {
    const script = join(tsSrc, `${entry}.ts`);
    // @ts-ignore — Bun global is absent under Node/tsc
    const isBun = typeof Bun !== 'undefined';
    if (isBun) return { command: process.execPath, args: [script] };
    // 子进程的 cwd 是 run 的 cwd（通常不在仓库里），裸 `--import tsx` 会从那里找不到包；
    // 从源码目录旁边的 node_modules 解析出 loader 的绝对路径再传
    const loader = createRequire(join(tsSrc, 'flow-runner.ts')).resolve('tsx/package.json').replace(/package\.json$/, 'dist/loader.mjs');
    return { command: process.execPath, args: ['--import', pathToFileURL(loader).href, script] };
  }
  return resolveEntrySpawn(entry, distDir);
}

class CallRejected extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CallRejected';
  }
}

class Inbox<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{ pred: (m: T) => boolean; resolve: (m: T) => void }> = [];

  push(item: T): void {
    const idx = this.waiters.findIndex((w) => w.pred(item));
    if (idx !== -1) {
      const [w] = this.waiters.splice(idx, 1);
      w!.resolve(item);
      return;
    }
    this.items.push(item);
  }

  waitFor(pred: (m: T) => boolean, timeoutMs: number): Promise<T> {
    const idx = this.items.findIndex(pred);
    if (idx !== -1) return Promise.resolve(this.items.splice(idx, 1)[0]!);
    return new Promise<T>((resolve, reject) => {
      const waiter = { pred, resolve: (m: T) => { clearTimeout(timer); resolve(m); } };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new Error('inbox wait timed out'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

export function readRunJson(runDir: string): RunJson | null {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, RUN_JSON_FILE), 'utf8')) as RunJson;
    return parsed && typeof parsed === 'object' && typeof parsed.runId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function writeRunJsonLocked(runDir: string, data: RunJson): void {
  atomicWriteFileSync(join(runDir, RUN_JSON_FILE), `${JSON.stringify(data, null, 2)}\n`);
}

function describeDropped(dropped: DroppedRow[]): string {
  return dropped
    .slice(0, 5)
    .map((d) => `line ${d.index + 1} ${d.row.t} gen ${d.row.gen} (${d.reason}, current gen ${d.currentGen})`)
    .join('; ') + (dropped.length > 5 ? `; …${dropped.length - 5} more` : '');
}

/** 证据裁剪：screenTail 超长的写到 attempt 目录，行内只留尾巴。 */
function trimEvidence(evidence: Evidence, attemptDir: string): Evidence {
  const out: Evidence = { ...evidence, attemptDir };
  if (typeof out.screenTail === 'string' && out.screenTail.length > SCREEN_TAIL_ROW_LIMIT) {
    try {
      writeFileSync(join(attemptDir, 'screen.txt'), out.screenTail);
    } catch {
      // best effort
    }
    out.screenTail = `…${out.screenTail.slice(-SCREEN_TAIL_ROW_LIMIT)}`;
  }
  return out;
}

function failureTriple(outcome: AgentSettledFailure): [FailedOutcome['category'], FailedOutcome['retry'], FailedOutcome['effects']] {
  switch (outcome.code) {
    case 'provider_exit':
      return ['crashed', 'auto', 'uncertain'];
    case 'submit_unconfirmed':
      return ['delivery_failed', 'auto', 'uncertain'];
    case 'turn_busy':
      return ['crashed', 'auto', 'uncertain'];
    case 'cli_needs_setup':
      return ['setup_required', 'manual', 'uncertain'];
    case 'cancelled':
      return ['canceled', 'manual', 'uncertain'];
    case 'contract_missing':
      return ['crashed', 'auto', 'uncertain'];
    default:
      return ['crashed', 'auto', 'uncertain'];
  }
}

/** `/proc/<pid>/stat` 的 utime+stime（clock ticks）换算成毫秒。 */
export function readCpuMs(pid: number): number | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return ((utime + stime) * 1000) / CLK_TCK;
  } catch {
    return null;
  }
}

// 供 check-replay 与 inspect 复用
export { outcomeFromFailed, outcomeFromResult };
