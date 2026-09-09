/**
 * daemon 侧的 flow run 管理器（设计文档 M2 §6.1、§6.4、§7）。
 *
 * 一个 bot 的 daemon 一个实例：
 *   - 起绑定话题的 runner（IPC 通道；`run` / `resume`），登记并转发控制请求；
 *   - 收 runner 的快照渲染进度卡与决策卡，收投递请求发信号卡（投递结果由 runner 写进 journal）；
 *   - runner 退出而 run 未结束 → 中断卡；daemon 启动时扫描本 app 的未结束 run 补发中断卡（§6.4）。
 *
 * 权威永远在 journal 与 runner；这里只持有「飞书投递状态」（run 目录里的 `lark-cards.json` sidecar，
 * daemon 单写者，不在 §6.2 的所有权协议内——它不是 run 的执行状态）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import {
  buildFlowDecisionCard,
  buildFlowInterruptedCard,
  buildFlowProgressCard,
  buildFlowRunPauseCard,
  buildFlowSignalCard,
  flowDecisionKey,
} from '../im/lark/flow-card.js';
import { decisionKey, loadJournal } from './journal.js';
import { holderAlive, readLeaseUnlocked } from './ownership.js';
import { flowRunsDir, flowSlotsFile } from './paths.js';
import { readRunJson, resolveFlowEntry, type RunnerOptions } from './runner.js';
import { assertScriptLint, ScriptLintError } from './script-lint.js';
import {
  type ControlRequest,
  type ControlResponse,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonToRunnerMessage,
  type OpenWait,
  type PendingDecision,
  type RunBinding,
  type RunLimits,
  type RunSnapshot,
  type RunnerToDaemonMessage,
} from './types.js';

export interface FlowCardTransport {
  /** 回复到话题（interactive 卡片），返回 messageId。 */
  reply(rootId: string, cardJson: string): Promise<string>;
  patch(messageId: string, cardJson: string): Promise<void>;
}

export interface FlowRunManagerDeps {
  larkAppId: string;
  dataDir: string;
  distDir: string;
  transport: FlowCardTransport;
  log: { info: (m: string) => void; warn: (m: string) => void };
  /** 常驻 run 上限（§9）。 */
  maxResidentRuns?: number;
  /** 注入：起 runner 进程（测试用）。 */
  spawnRunner?: (command: string, args: string[], runDir: string) => ChildProcess;
  /** 控制请求的应答预算（卡片回调 3 秒内要 ACK）。 */
  controlTimeoutMs?: number;
}

export const DEFAULT_MAX_RESIDENT_RUNS = 8;
const CARDS_SIDECAR = 'lark-cards.json';
const TERMINAL: ReadonlySet<string> = new Set(['completed', 'partial', 'failed', 'canceled']);

interface CardsSidecar {
  scriptName: string;
  progress: { messageId: string; sha: string } | null;
  decisions: Record<string, { messageId: string; frozen: boolean }>;
  pause: { gen: number; messageId: string; frozen: boolean } | null;
  waits: Record<string, { messageId: string }>;
  interrupted: { gen: number; messageId: string; frozen: boolean } | null;
}

interface ManagedRun {
  runId: string;
  runDir: string;
  binding: RunBinding;
  child: ChildProcess | null;
  gen: number;
  pid: number | null;
  snapshot: RunSnapshot | null;
  cards: CardsSidecar;
  seq: number;
  pending: Map<number, { resolve: (res: ControlResponse) => void; timer: ReturnType<typeof setTimeout> }>;
  /** 最近一次快照里的待决策（冻结卡回显用）。 */
  lastPending: Map<string, PendingDecision>;
  lastRunPause: RunSnapshot['runPause'];
  /** 序列化卡片操作，避免同一张卡并发 patch 乱序。 */
  cardQueue: Promise<void>;
  /** `waitForFinish` 的等待者；runner 退出时按 journal 结算。 */
  finishWaiters: Array<(outcome: FlowFinishOutcome) => void>;
}

/** run 的终局（`waitForFinish`）：结束行，或 runner 不在了而 run 未结束。 */
export type FlowFinishOutcome =
  | { kind: 'finished'; status: string; health: string; returned: unknown; error: { code: string; message: string } | null }
  | { kind: 'interrupted'; reason: string; inflight: string[] };

export interface FlowLaunchRequest {
  /** 相对话题工作目录的脚本路径（或绝对路径，但必须落在工作目录内）。 */
  script: string;
  input: unknown;
  binding: RunBinding;
  limits?: Partial<RunLimits>;
}

export type FlowLaunchResult = { ok: true; runId: string; runDir: string } | { ok: false; error: string };

export function newFlowRunId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export class FlowRunManager {
  private readonly runs = new Map<string, ManagedRun>();
  private closed = false;

  constructor(private readonly deps: FlowRunManagerDeps) {}

  private log(m: string): void {
    this.deps.log.info(`[flow] ${m}`);
  }

  private warn(m: string): void {
    this.deps.log.warn(`[flow] ${m}`);
  }

  // ---------------------------------------------------------------------------
  // 启动 / 恢复
  // ---------------------------------------------------------------------------

  /** `/flow run`：脚本必须在话题工作目录内；lint 早报错；常驻上限；起绑定的 runner。 */
  async launch(req: FlowLaunchRequest): Promise<FlowLaunchResult> {
    if (this.closed) return { ok: false, error: 'daemon 正在关闭' };
    const workingDir = safeRealpath(req.binding.workingDir);
    const scriptPath = safeRealpath(resolve(workingDir, req.script));
    const rel = relative(workingDir, scriptPath);
    if (rel.startsWith('..') || rel === '' || resolve(workingDir, rel) !== scriptPath) return { ok: false, error: `脚本必须在话题工作目录内（${workingDir}）` };
    if (!existsSync(scriptPath) || !statSync(scriptPath).isFile()) return { ok: false, error: `脚本不存在：${rel}` };
    let source: string;
    try {
      source = readFileSync(scriptPath, 'utf8');
      assertScriptLint(source);
    } catch (err) {
      if (err instanceof ScriptLintError) return { ok: false, error: `脚本静态检查不过：${err.message}` };
      return { ok: false, error: `读取脚本失败：${err instanceof Error ? err.message : String(err)}` };
    }
    const resident = this.countResident();
    const max = this.deps.maxResidentRuns ?? DEFAULT_MAX_RESIDENT_RUNS;
    if (resident.count >= max) return { ok: false, error: `常驻 run 已达上限 ${max}（${resident.runIds.join(', ')}）；先结束或取消一个` };
    const runId = newFlowRunId();
    const runDir = join(flowRunsDir(this.deps.dataDir), runId);
    mkdirSync(runDir, { recursive: true });
    const options: SerializableRunnerOptions = {
      runId,
      runDir,
      mode: 'run',
      script: { path: scriptPath, source },
      input: req.input ?? null,
      cwd: workingDir,
      limits: req.limits ?? {},
      cliPaths: {},
      slotsFile: flowSlotsFile(this.deps.dataDir),
      binding: req.binding,
      ownerOpenId: req.binding.ownerOpenId ?? undefined,
      decidedBy: req.binding.triggeredBy,
      distDir: this.deps.distDir,
    };
    const managed = this.register(runId, runDir, req.binding, basename(scriptPath));
    const started = this.spawnRunnerProcess(managed, options);
    if (!started.ok) return started;
    await this.ensureProgressCard(managed, placeholderSnapshot(runId, 'running'));
    return { ok: true, runId, runDir };
  }

  /** 中断卡 / `/flow resume`：以记录的绑定起新一代 runner；`cancel` = 起来后回收并取消。 */
  async resume(runId: string, by: string, mode: 'resume' | 'cancel' = 'resume'): Promise<string | null> {
    if (this.closed) return 'daemon 正在关闭';
    const runDir = join(flowRunsDir(this.deps.dataDir), runId);
    const runJson = readRunJson(runDir);
    if (!runJson) return `run ${runId} 不存在`;
    const binding = runJson.binding;
    if (!binding || binding.larkAppId !== this.deps.larkAppId) return `run ${runId} 不属于本机器人`;
    const lease = readLeaseUnlocked(runDir);
    if (lease && holderAlive(lease.holderPid, lease.holderIdentity)) return `run ${runId} 的 runner 仍在运行（pid ${lease.holderPid}）`;
    if (mode === 'resume') {
      const resident = this.countResident();
      const max = this.deps.maxResidentRuns ?? DEFAULT_MAX_RESIDENT_RUNS;
      if (resident.count >= max) return `常驻 run 已达上限 ${max}；先结束或取消一个`;
    }
    const options: SerializableRunnerOptions = {
      runId,
      runDir,
      mode: 'resume',
      limits: {},
      cliPaths: {},
      slotsFile: flowSlotsFile(this.deps.dataDir),
      binding,
      ownerOpenId: binding.ownerOpenId ?? undefined,
      decidedBy: by,
      distDir: this.deps.distDir,
      ...(mode === 'cancel' ? { cancelOnStart: `by ${by}` } : {}),
    };
    const managed = this.register(runId, runDir, binding, basename(runJson.script));
    const started = this.spawnRunnerProcess(managed, options);
    if (!started.ok) return started.error;
    if (managed.cards.interrupted && !managed.cards.interrupted.frozen) {
      const info = this.interruptedInfo(runId);
      await this.freezeInterrupted(managed, { choice: mode, by }, info);
    }
    await this.ensureProgressCard(managed, placeholderSnapshot(runId, 'running'));
    return null;
  }

  private register(runId: string, runDir: string, binding: RunBinding, scriptName: string): ManagedRun {
    const existing = this.runs.get(runId);
    if (existing) {
      existing.binding = binding;
      return existing;
    }
    const cards = readSidecar(runDir) ?? { scriptName, progress: null, decisions: {}, pause: null, waits: {}, interrupted: null };
    if (!cards.scriptName) cards.scriptName = scriptName;
    const managed: ManagedRun = {
      runId,
      runDir,
      binding,
      child: null,
      gen: 0,
      pid: null,
      snapshot: null,
      cards,
      seq: 0,
      pending: new Map(),
      lastPending: new Map(),
      lastRunPause: null,
      cardQueue: Promise.resolve(),
      finishWaiters: [],
    };
    this.runs.set(runId, managed);
    return managed;
  }

  /** 按 journal 结算一个 runner 已不在的 run；run 目录不存在返回 null。 */
  private settleOutcome(runId: string): FlowFinishOutcome | null {
    const runDir = join(flowRunsDir(this.deps.dataDir), runId);
    if (!existsSync(runDir)) return null;
    const p = loadJournal(runDir).projection;
    if (p.finished) {
      const last = p.errors.length > 0 ? p.errors[p.errors.length - 1]! : null;
      return { kind: 'finished', status: p.finished.status, health: p.finished.health, returned: p.finished.returned, error: last ? { code: last.code, message: last.error } : null };
    }
    const info = this.interruptedInfo(runId);
    return { kind: 'interrupted', reason: info?.reason ?? 'runner 异常退出', inflight: info?.inflight ?? [] };
  }

  /**
   * 等 run 到终局（webhook 的 `waitForFinalOutput`）。超时返回 null，run 继续跑；
   * runner 不由本 manager 持有（终端 resume 的）且尚未结束时也按超时处理。
   */
  waitForFinish(runId: string, timeoutMs: number): Promise<FlowFinishOutcome | null> {
    const managed = this.runs.get(runId);
    if (!managed || !managed.child) {
      const settled = this.settleOutcome(runId);
      if (settled && (settled.kind === 'finished' || !this.runnerAlive(runId))) return Promise.resolve(settled);
    }
    if (!managed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        managed.finishWaiters = managed.finishWaiters.filter((w) => w !== waiter);
        resolve(null);
      }, Math.max(0, timeoutMs));
      const waiter = (outcome: FlowFinishOutcome): void => {
        clearTimeout(timer);
        resolve(outcome);
      };
      managed.finishWaiters.push(waiter);
    });
  }

  private spawnRunnerProcess(managed: ManagedRun, options: SerializableRunnerOptions): { ok: true } | { ok: false; error: string } {
    const { command, args } = resolveFlowEntry('flow-runner', this.deps.distDir);
    let child: ChildProcess;
    try {
      if (this.deps.spawnRunner) {
        child = this.deps.spawnRunner(command, [...args, JSON.stringify(options)], managed.runDir);
      } else {
        const logFd = openSync(join(managed.runDir, 'runner.log'), 'a');
        // 不 detached：daemon 死则 IPC 断，runner 自己写 run.interrupted 并退出（§6.4）
        child = spawn(command, [...args, JSON.stringify(options)], { stdio: ['ignore', logFd, logFd, 'ipc'], env: process.env });
      }
    } catch (err) {
      return { ok: false, error: `起 runner 失败：${err instanceof Error ? err.message : String(err)}` };
    }
    managed.child = child;
    managed.pid = child.pid ?? null;
    child.on('message', (raw) => void this.onRunnerMessage(managed, raw as RunnerToDaemonMessage));
    child.on('error', (err) => this.warn(`runner ${managed.runId} error: ${err.message}`));
    child.once('exit', (code, signal) => void this.onRunnerExit(managed, child, code, signal));
    this.log(`runner ${managed.runId} spawned (pid ${child.pid}, mode ${options.mode})`);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // runner → daemon
  // ---------------------------------------------------------------------------

  private async onRunnerMessage(managed: ManagedRun, message: RunnerToDaemonMessage): Promise<void> {
    switch (message.t) {
      case 'hello':
        managed.gen = message.gen;
        managed.pid = message.pid;
        return;
      case 'snapshot':
        managed.snapshot = message.snapshot;
        managed.gen = message.snapshot.gen || managed.gen;
        this.enqueue(managed, () => this.renderSnapshot(managed, message.snapshot));
        return;
      case 'request': {
        let res: DaemonResponse;
        try {
          res = await this.handleRequest(managed, message.req);
        } catch (err) {
          res = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        const reply: DaemonToRunnerMessage = { t: 'response', id: message.id, res };
        try {
          managed.child?.send(reply);
        } catch {
          // runner 已退出
        }
        return;
      }
      case 'response': {
        const waiter = managed.pending.get(message.id);
        if (waiter) {
          managed.pending.delete(message.id);
          clearTimeout(waiter.timer);
          waiter.resolve(message.res);
        }
        return;
      }
      default:
        return;
    }
  }

  private async handleRequest(managed: ManagedRun, req: DaemonRequest): Promise<DaemonResponse> {
    switch (req.t) {
      case 'wait.deliver': {
        const card = buildFlowSignalCard({ runId: managed.runId, wait: req.wait });
        const messageId = await this.deps.transport.reply(managed.binding.rootId, card);
        managed.cards.waits[waitKey(req.wait)] = { messageId };
        writeSidecar(managed.runDir, managed.cards);
        if (req.supersedes) {
          const old: OpenWait = { ...req.wait, version: req.wait.version - 1 };
          await this.deps.transport.patch(req.supersedes, buildFlowSignalCard({ runId: managed.runId, wait: old, resolution: { how: 'superseded', newVersion: req.wait.version } })).catch((err) => this.warn(`freeze superseded signal card failed: ${err instanceof Error ? err.message : String(err)}`));
        }
        return { ok: true, messageId };
      }
      case 'wait.refresh': {
        if (!req.wait.messageId) return { ok: false, error: 'no card to refresh' };
        await this.deps.transport.patch(req.wait.messageId, buildFlowSignalCard({ runId: managed.runId, wait: req.wait, note: `run 已恢复（gen ${managed.gen}），仍在等待这个信号。` }));
        managed.cards.waits[waitKey(req.wait)] = { messageId: req.wait.messageId };
        writeSidecar(managed.runDir, managed.cards);
        return { ok: true, messageId: req.wait.messageId };
      }
      case 'wait.close': {
        const key = `${req.identity}:${req.version}`;
        const messageId = req.messageId ?? managed.cards.waits[key]?.messageId ?? null;
        delete managed.cards.waits[key];
        writeSidecar(managed.runDir, managed.cards);
        if (!messageId) return { ok: true, messageId: null };
        if (req.how === 'consumed') {
          // 消费路径的冻结由卡片回调应答完成（handleFlowCardAction 返回冻结卡）；终端提交时这里补一刀
          const wait = waitStub(req.identity, req.version);
          const value = readSignalValue(managed.runDir, req.identity, req.version);
          await this.deps.transport.patch(messageId, buildFlowSignalCard({ runId: managed.runId, wait, resolution: { how: 'consumed', by: req.by, value } })).catch(() => undefined);
        } else {
          await this.deps.transport.patch(messageId, buildFlowSignalCard({ runId: managed.runId, wait: waitStub(req.identity, req.version), resolution: { how: req.how, by: req.by } })).catch(() => undefined);
        }
        return { ok: true, messageId };
      }
      default:
        return { ok: false, error: 'unknown request' };
    }
  }

  private async onRunnerExit(managed: ManagedRun, child: ChildProcess, code: number | null, signal: string | null): Promise<void> {
    if (managed.child !== child) return;
    managed.child = null;
    for (const [id, waiter] of managed.pending) {
      managed.pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, error: 'runner exited' });
    }
    this.log(`runner ${managed.runId} exited (code ${code}, signal ${signal})`);
    if (managed.finishWaiters.length > 0) {
      const waiters = managed.finishWaiters;
      managed.finishWaiters = [];
      const outcome = this.settleOutcome(managed.runId) ?? { kind: 'interrupted' as const, reason: 'run 目录不存在', inflight: [] };
      for (const w of waiters) w(outcome);
    }
    if (this.closed) return;
    const info = this.interruptedInfo(managed.runId);
    if (!info) {
      // 已结束：确保进度卡是终态（最后一条快照可能没送到）
      this.enqueue(managed, () => this.finalizeFromJournal(managed));
      return;
    }
    this.enqueue(managed, () => this.postInterrupted(managed, info));
  }

  // ---------------------------------------------------------------------------
  // daemon → runner：控制请求
  // ---------------------------------------------------------------------------

  /** 转发控制请求；runner 不在（未登记或已退出）返回 null。 */
  control(runId: string, request: ControlRequest): Promise<ControlResponse | null> {
    const managed = this.runs.get(runId);
    if (!managed || !managed.child || !managed.child.connected) return Promise.resolve(null);
    const id = ++managed.seq;
    const child = managed.child;
    return new Promise<ControlResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        managed.pending.delete(id);
        resolve({ ok: false, error: 'runner 没有及时应答' });
      }, this.deps.controlTimeoutMs ?? 2_000);
      managed.pending.set(id, { resolve: (res) => resolve(res), timer });
      const message: DaemonToRunnerMessage = { t: 'request', id, req: request };
      try {
        child.send(message);
      } catch (err) {
        managed.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: `发送失败：${err instanceof Error ? err.message : String(err)}` });
      }
    });
  }

  runnerAlive(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.child?.connected) return true;
    const lease = readLeaseUnlocked(join(flowRunsDir(this.deps.dataDir), runId));
    return !!lease && holderAlive(lease.holderPid, lease.holderIdentity);
  }

  readBinding(runId: string): RunBinding | null {
    const managed = this.runs.get(runId);
    if (managed) return managed.binding;
    const runJson = readRunJson(join(flowRunsDir(this.deps.dataDir), runId));
    const binding = runJson?.binding ?? null;
    return binding && binding.larkAppId === this.deps.larkAppId ? binding : null;
  }

  scriptName(runId: string): string {
    const managed = this.runs.get(runId);
    if (managed) return managed.cards.scriptName;
    const runJson = readRunJson(join(flowRunsDir(this.deps.dataDir), runId));
    return runJson ? basename(runJson.script) : runId;
  }

  lastRunPause(runId: string): RunSnapshot['runPause'] {
    return this.runs.get(runId)?.lastRunPause ?? null;
  }

  /** 中断卡的 gen 是否仍是最新：run 已被恢复（gen 前进）或已结束即失效。 */
  interruptedGenIsCurrent(runId: string, gen: number): boolean {
    const runDir = join(flowRunsDir(this.deps.dataDir), runId);
    const info = this.interruptedInfo(runId);
    if (!info) return false;
    const runJson = readRunJson(runDir);
    return (runJson?.gen ?? 0) === gen;
  }

  /** run 处于中断态（未结束且 runner 不在）时返回原因与在途，否则 null。 */
  interruptedInfo(runId: string): { reason: string; inflight: string[] } | null {
    const runDir = join(flowRunsDir(this.deps.dataDir), runId);
    if (!existsSync(runDir)) return null;
    const loaded = loadJournal(runDir);
    const p = loaded.projection;
    if (p.terminal === 'finished') return null;
    const lease = readLeaseUnlocked(runDir);
    if (lease && holderAlive(lease.holderPid, lease.holderIdentity)) return null;
    const managed = this.runs.get(runId);
    if (managed?.child?.connected) return null;
    if (p.terminal === 'interrupted' && p.interrupted) return { reason: p.interrupted.reason, inflight: p.interrupted.inflight };
    const inflight = [...p.identities.values()].filter((i) => i.latest.state === 'inflight').map((i) => i.identity);
    for (const w of p.waits.values()) if (w.state === 'open') inflight.push(w.identity);
    return { reason: p.gen === 0 ? 'runner 未能启动' : 'runner 异常退出', inflight };
  }

  /** `/flow ls` 用：本 app 绑定的 run。 */
  listRuns(): Array<{ runId: string; status: string; gen: number; script: string; updatedAt: number }> {
    const dir = flowRunsDir(this.deps.dataDir);
    const out: Array<{ runId: string; status: string; gen: number; script: string; updatedAt: number }> = [];
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      const runDir = join(dir, name);
      const runJson = readRunJson(runDir);
      if (!runJson?.binding || runJson.binding.larkAppId !== this.deps.larkAppId) continue;
      const status = TERMINAL.has(runJson.status) ? runJson.status : this.interruptedInfo(name) ? 'interrupted' : runJson.status;
      out.push({ runId: name, status, gen: runJson.gen, script: basename(runJson.script), updatedAt: runJson.updatedAt });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  // ---------------------------------------------------------------------------
  // 卡片渲染
  // ---------------------------------------------------------------------------

  private enqueue(managed: ManagedRun, task: () => Promise<void>): void {
    managed.cardQueue = managed.cardQueue.then(task, task).catch((err) => this.warn(`card task for ${managed.runId} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async ensureProgressCard(managed: ManagedRun, snapshot: RunSnapshot): Promise<void> {
    if (managed.cards.progress) return;
    const card = buildFlowProgressCard({ snapshot, scriptName: managed.cards.scriptName });
    const messageId = await this.deps.transport.reply(managed.binding.rootId, card);
    managed.cards.progress = { messageId, sha: sha(card) };
    writeSidecar(managed.runDir, managed.cards);
  }

  private async renderSnapshot(managed: ManagedRun, s: RunSnapshot): Promise<void> {
    // 进度卡
    const card = buildFlowProgressCard({ snapshot: s, scriptName: managed.cards.scriptName });
    if (!managed.cards.progress) {
      const messageId = await this.deps.transport.reply(managed.binding.rootId, card);
      managed.cards.progress = { messageId, sha: sha(card) };
    } else if (managed.cards.progress.sha !== sha(card)) {
      await this.deps.transport.patch(managed.cards.progress.messageId, card);
      managed.cards.progress.sha = sha(card);
    }
    // 决策卡：新出现的待决策发卡；消失的冻结
    const seen = new Set<string>();
    for (const d of s.pending) {
      const key = flowDecisionKey(d.identity, d.attempt);
      seen.add(key);
      managed.lastPending.set(key, d);
      if (!managed.cards.decisions[key]) {
        const messageId = await this.deps.transport.reply(managed.binding.rootId, buildFlowDecisionCard({ runId: managed.runId, decision: d }));
        managed.cards.decisions[key] = { messageId, frozen: false };
      }
    }
    for (const [key, entry] of Object.entries(managed.cards.decisions)) {
      if (seen.has(key) || entry.frozen) continue;
      const d = managed.lastPending.get(key);
      const decided = d ? readDecision(managed.runDir, d) : null;
      if (d) {
        const resolution = decided ? { choice: decided.choice as 'accept-failed' | 'retry' | 'timeout', by: decided.by } : s.status === 'canceled' || s.finished?.status === 'canceled' ? { choice: 'canceled' as const } : { choice: 'stale' as const };
        await this.deps.transport.patch(entry.messageId, buildFlowDecisionCard({ runId: managed.runId, decision: d, resolution })).catch(() => undefined);
      }
      entry.frozen = true;
    }
    // run 级暂停卡
    if (s.runPause) {
      managed.lastRunPause = s.runPause;
      if (!managed.cards.pause || managed.cards.pause.gen !== s.gen || managed.cards.pause.frozen) {
        const messageId = await this.deps.transport.reply(managed.binding.rootId, buildFlowRunPauseCard({ runId: managed.runId, gen: s.gen, pause: s.runPause }));
        managed.cards.pause = { gen: s.gen, messageId, frozen: false };
      }
    } else if (managed.cards.pause && !managed.cards.pause.frozen) {
      const pause = managed.lastRunPause ?? { reason: 'container_unavailable' as const, detail: '' };
      const runDecision = readRunDecision(managed.runDir, managed.cards.pause.gen);
      const resolution = runDecision ? { choice: runDecision.choice as 'accept-journal' | 'assume-clean', by: runDecision.by } : s.status === 'canceled' ? { choice: 'cancel' as const } : { choice: 'stale' as const };
      await this.deps.transport.patch(managed.cards.pause.messageId, buildFlowRunPauseCard({ runId: managed.runId, gen: managed.cards.pause.gen, pause, resolution })).catch(() => undefined);
      managed.cards.pause.frozen = true;
    }
    writeSidecar(managed.runDir, managed.cards);
  }

  private async finalizeFromJournal(managed: ManagedRun): Promise<void> {
    const loaded = loadJournal(managed.runDir);
    const p = loaded.projection;
    if (!p.finished) return;
    const snapshot: RunSnapshot = managed.snapshot ?? placeholderSnapshot(managed.runId, p.finished.status);
    if (snapshot.finished) return; // 最后一条快照已到，renderSnapshot 处理过
    const final: RunSnapshot = {
      ...snapshot,
      gen: p.gen,
      status: p.finished.status,
      health: p.finished.health,
      counts: { ...p.counts },
      pending: [],
      runPause: null,
      waits: [],
      finished: { status: p.finished.status, health: p.finished.health, replay: p.finished.replay, returned: p.finished.returned },
      error: p.errors.length > 0 ? { code: p.errors[p.errors.length - 1]!.code, message: p.errors[p.errors.length - 1]!.error } : null,
      updatedAt: Date.now(),
    };
    await this.renderSnapshot(managed, final);
  }

  private async postInterrupted(managed: ManagedRun, info: { reason: string; inflight: string[] }): Promise<void> {
    const runJson = readRunJson(managed.runDir);
    const gen = runJson?.gen ?? managed.gen;
    if (managed.cards.interrupted && managed.cards.interrupted.gen === gen) return; // 这一代已发过
    // 进度卡冻结成「已中断」
    if (managed.cards.progress) {
      const snapshot = managed.snapshot ?? placeholderSnapshot(managed.runId, 'interrupted');
      const card = buildFlowProgressCard({ snapshot: { ...snapshot, status: 'interrupted' }, scriptName: managed.cards.scriptName, interrupted: { reason: info.reason } });
      await this.deps.transport.patch(managed.cards.progress.messageId, card).catch(() => undefined);
      managed.cards.progress.sha = sha(card);
    }
    const messageId = await this.deps.transport.reply(managed.binding.rootId, buildFlowInterruptedCard({ runId: managed.runId, gen, scriptName: managed.cards.scriptName, reason: info.reason, inflight: info.inflight }));
    managed.cards.interrupted = { gen, messageId, frozen: false };
    writeSidecar(managed.runDir, managed.cards);
    this.log(`run ${managed.runId} interrupted (${info.reason}); interrupted card posted`);
  }

  private async freezeInterrupted(managed: ManagedRun, resolution: { choice: 'resume' | 'cancel'; by: string }, info: { reason: string; inflight: string[] } | null): Promise<void> {
    const card = managed.cards.interrupted;
    if (!card || card.frozen) return;
    await this.deps.transport.patch(card.messageId, buildFlowInterruptedCard({ runId: managed.runId, gen: card.gen, scriptName: managed.cards.scriptName, reason: info?.reason ?? '', inflight: info?.inflight ?? [], resolution })).catch(() => undefined);
    card.frozen = true;
    writeSidecar(managed.runDir, managed.cards);
  }

  // ---------------------------------------------------------------------------
  // 启动扫描（§6.4）与关闭
  // ---------------------------------------------------------------------------

  /** daemon 启动：本 app 绑定的、未结束且 runner 不在的 run → 中断卡（每代只发一次）。 */
  async coldAttach(): Promise<void> {
    const dir = flowRunsDir(this.deps.dataDir);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const runDir = join(dir, name);
      try {
        const runJson = readRunJson(runDir);
        if (!runJson?.binding || runJson.binding.larkAppId !== this.deps.larkAppId) continue;
        if (TERMINAL.has(runJson.status) && loadJournal(runDir).projection.terminal === 'finished') continue;
        const info = this.interruptedInfo(name);
        if (!info) continue; // runner 活着（终端 resume 的）或已结束
        const managed = this.register(name, runDir, runJson.binding, basename(runJson.script));
        this.enqueue(managed, () => this.postInterrupted(managed, info));
      } catch (err) {
        this.warn(`cold-attach ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** daemon 关闭：断开 IPC（runner 自己写 run.interrupted 并退出），不再发卡。 */
  close(): void {
    this.closed = true;
    for (const managed of this.runs.values()) {
      try {
        managed.child?.disconnect();
      } catch {
        // already gone
      }
    }
  }

  private countResident(): { count: number; runIds: string[] } {
    const dir = flowRunsDir(this.deps.dataDir);
    if (!existsSync(dir)) return { count: 0, runIds: [] };
    const runIds: string[] = [];
    for (const name of readdirSync(dir)) {
      const lease = readLeaseUnlocked(join(dir, name));
      if (lease && holderAlive(lease.holderPid, lease.holderIdentity)) runIds.push(name);
    }
    return { count: runIds.length, runIds };
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

type SerializableRunnerOptions = Omit<RunnerOptions, 'spawnScriptHost' | 'spawnAgentWorker' | 'hooks' | 'daemonLink' | 'botExecutor'>;

function waitKey(wait: Pick<OpenWait, 'identity' | 'version'>): string {
  return `${wait.identity}:${wait.version}`;
}

function waitStub(identity: string, version: number): OpenWait {
  return { identity, version, content: '', prompt: '', schema: null, delivery: 'delivered', messageId: null, deliveryError: null, openedAt: 0, timeoutAt: 0 };
}

function readSignalValue(runDir: string, identity: string, version: number): unknown {
  try {
    const wait = loadJournal(runDir).projection.waits.get(identity);
    return wait && wait.version === version ? wait.signal?.value ?? null : null;
  } catch {
    return null;
  }
}

function readDecision(runDir: string, d: PendingDecision): { choice: string; by: string } | null {
  try {
    const p = loadJournal(runDir).projection;
    const row = p.decisions.get(decisionKey(d.identity, d.content, d.attempt));
    return row ? { choice: row.choice, by: row.by } : null;
  } catch {
    return null;
  }
}

function readRunDecision(runDir: string, gen: number): { choice: string; by: string } | null {
  try {
    const p = loadJournal(runDir).projection;
    const row = [...p.runDecisions].reverse().find((r) => r.gen === gen);
    return row ? { choice: row.choice, by: row.by } : null;
  } catch {
    return null;
  }
}

function placeholderSnapshot(runId: string, status: RunSnapshot['status']): RunSnapshot {
  return { runId, gen: 0, status, health: 'ok', counts: { started: 0, ok: 0, failed: 0, inflight: 0 }, attempts: [], pending: [], runPause: null, waits: [], notes: [], finished: null, error: null, activeMs: 0, updatedAt: Date.now() };
}

function readSidecar(runDir: string): CardsSidecar | null {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, CARDS_SIDECAR), 'utf8')) as CardsSidecar;
    if (!parsed || typeof parsed !== 'object') return null;
    return { scriptName: parsed.scriptName ?? '', progress: parsed.progress ?? null, decisions: parsed.decisions ?? {}, pause: parsed.pause ?? null, waits: parsed.waits ?? {}, interrupted: parsed.interrupted ?? null };
  } catch {
    return null;
  }
}

function writeSidecar(runDir: string, cards: CardsSidecar): void {
  try {
    atomicWriteFileSync(join(runDir, CARDS_SIDECAR), `${JSON.stringify(cards, null, 2)}\n`);
  } catch {
    // best effort：卡片状态丢了最多重发一张
  }
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
