/**
 * PTY turn runner：把 botmux 的 CLI adapter + SessionBackend + IdleDetector +
 * TerminalRenderer 组装成 flow agent worker 需要的「一次 prompt → 一次结算」语义。
 *
 * 与有显式回合终止事件的协议不同，这里只有「屏幕安静了」。所以每次结算都必须
 * 携带证据（来源 / 置信度 / 屏幕尾部），上游据此渲染诊断，禁止发出没有证据的
 * 裸结果。
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionBackend } from '../adapters/backend/types.js';
import type { CliAdapter, CliId, PtyHandle } from '../adapters/cli/types.js';
import { cliIdForComm, findLaunchedCliPid, readComm } from '../core/session-discovery.js';
import { IdleDetector, type IdleEvidenceSource } from '../utils/idle-detector.js';
import { TerminalRenderer } from '../utils/terminal-renderer.js';
import { interruptKeys, screenLooksBusy, screenNeedsSetup, trustDialogPattern } from './cli-quirks.js';
import {
  appendOutputContract,
  createOutputContract,
  readOutputContract,
  type OutputContract,
} from './output-contract.js';

/** 打断回合的原因；进证据与 journal，不参与控制流。 */
export type PtyCancelReason =
  | 'operator'
  | 'pause'
  | 'lease_lost'
  | 'steer'
  | 'event_sink'
  | 'deadline'
  | 'inactivity';

export interface PtyTurnRunnerOptions {
  sessionId: string;
  /** 会话状态目录：pty.log 与每轮的契约文件都落在这里。 */
  stateDir: string;
  cwd: string;
  env: Record<string, string>;
  resume?: boolean;
  resumeSessionId?: string;
  model?: string;
  /** true = 不加 adapter 默认的绕过审批/沙箱 flag（对应 permissionMode ≠ approve-all）。 */
  disableCliBypass?: boolean;
  cols?: number;
  rows?: number;
  readyTimeoutMs?: number;
  /** 就绪确认窗口：首个 idle 后屏幕必须静止这么久且无 busy 标记才算就绪。 */
  readyConfirmMs?: number;
  /** 回合内屏幕静止但显示 busy 标记时的复核间隔。 */
  busyProbeMs?: number;
  /** 打断当前回合的按键序列。默认按 cli-quirks 的逐 CLI 表（ESC，grok 为 Ctrl-C）。 */
  interruptKeys?: string;
  /**
   * idle 已触发但契约文件还没出现时的宽限。CLI 通常先刷屏再写文件，或在
   * 「思考」间隙里安静超过 quiescence 窗口——这段时间里文件落盘或 CLI 再次
   * 出声都会让本轮继续，只有宽限耗尽才退回屏幕 fallback。
   */
  contractGraceMs?: number;
  /** 契约文件轮询间隔（仅宽限期内）。 */
  contractPollMs?: number;
  /**
   * 把 backend 的子进程 pid 解析成真正的 CLI 进程 pid。npm shim 之类的 launcher
   * （`codex` → `codex.js` → 原生二进制）会让 backend 只看到 wrapper，而 adapter 的
   * 提交验证按 pid 查 rollout 归属，给错 pid 会永远 fail closed。默认按进程树
   * 找 adapter.id 对应的后代；测试可注入。
   */
  resolveCliPid?: (launcherPid: number) => number | null;
  /**
   * 契约文件名（不含目录）。flow 的 §8 要求文件名唯一到每次提交并由 runner 记录
   * 在 `send.intent` 行里；不传则沿用 `turn-<turnId>.response.md`。
   */
  contractFileName?: (turnId: string) => string;
  /**
   * prompt 已写进 PTY（adapter 提交完成）时回调。flow 用它发 `send.confirmed`——只是诊断，
   * 不参与 `effects` 推导（§5.5），所以尽力即可。`unconfirmed` 表示 adapter 没能验证提交。
   */
  onSubmitted?: (turnId: string, unconfirmed: boolean) => void;
}

export interface PtySettlement {
  source: 'contract_file' | 'screen';
  confidence: 'high' | 'low';
  idleSource: IdleEvidenceSource;
  /** 低置信度时说明原因，供卡片/inspect 直接展示。 */
  reason?: string;
}

export type PtyTurnFailure =
  | { code: 'provider_exit'; exitCode: number | null; signal: string | null; screenTail: string }
  | { code: 'submit_unconfirmed'; detail: string; screenTail: string }
  | { code: 'turn_busy'; detail: string }
  | { code: 'cli_needs_setup'; detail: string; screenTail: string };

export type PtyTurnOutcome =
  | { status: 'completed'; finalResponse: string; settlement: PtySettlement; screenTail: string }
  | { status: 'cancelled'; reason: PtyCancelReason; screenTail: string }
  | { status: 'failed'; failure: PtyTurnFailure };

export type PtyOpenFailureCode = 'spawn_failed' | 'provider_exit' | 'ready_timeout' | 'cli_needs_setup';

export class PtyOpenError extends Error {
  constructor(
    readonly code: PtyOpenFailureCode,
    message: string,
    readonly evidence: { exitCode?: number | null; signal?: string | null; screenTail: string },
  ) {
    super(message);
    this.name = 'PtyOpenError';
  }
}

export interface PtyTurnInput {
  turnId: string;
  prompt: string;
}

type Settle =
  | { kind: 'idle'; source: IdleEvidenceSource }
  | { kind: 'exit' }
  | { kind: 'cancel'; reason: PtyCancelReason };

type GraceSettle = Settle | { kind: 'contract' } | { kind: 'grace_expired' };

const DEFAULT_COLS = 160;
const DEFAULT_ROWS = 48;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_READY_CONFIRM_MS = 1_500;
const DEFAULT_BUSY_PROBE_MS = 1_000;
const DEFAULT_CONTRACT_GRACE_MS = 15_000;
const DEFAULT_CONTRACT_POLL_MS = 500;
const SCREEN_TAIL_LINES = 40;
const SUBMIT_RECHECK_DELAY_MS = 3_000;
/** 信任对话框渲染后到按 Enter 的间隔（主 worker 同值，见 openai/codex#39487）。 */
const TRUST_ACCEPT_DELAY_MS = 400;
/** node-pty helper 找不到可执行文件时打到 PTY 上的错误（Linux/macOS 措辞一致）。 */
const EXEC_FAILURE_RE = /execvp\(\d*\) failed|posix_spawnp failed/i;

export class PtyTurnRunner {
  private readonly idle: IdleDetector;
  private readonly renderer: TerminalRenderer;
  private readonly ptyLogPath: string;
  private readonly cols: number;
  private readonly rows: number;
  private exited: { exitCode: number | null; signal: string | null } | null = null;
  /** 每收到一块 PTY 数据加一；确认窗口/探测靠它判断屏幕是否还在变。 */
  private dataSeq = 0;
  private waiter: ((settle: Settle) => void) | null = null;
  private activeTurnId: string | null = null;
  private pendingCancel: PtyCancelReason | null = null;
  private cliSessionId: string | undefined;
  private resolvedCliPid: number | null = null;
  /** 启动期信任对话框只接受一次；同一文案再次出现不重入。 */
  private trustAccepted = false;
  private closed = false;

  constructor(
    private readonly adapter: CliAdapter,
    private readonly backend: SessionBackend,
    private readonly opts: PtyTurnRunnerOptions,
  ) {
    this.cols = opts.cols ?? DEFAULT_COLS;
    this.rows = opts.rows ?? DEFAULT_ROWS;
    this.renderer = new TerminalRenderer(this.cols, this.rows);
    this.idle = new IdleDetector(adapter);
    this.ptyLogPath = join(opts.stateDir, 'pty.log');
    this.idle.onIdle((source) => this.settle({ kind: 'idle', source }));
  }

  /** 会话记录落点：原始 PTY 字节流，web 终端可直接回放。 */
  get projectionRef(): string {
    return this.ptyLogPath;
  }

  get hasExited(): boolean {
    return this.exited !== null;
  }

  /** adapter 在提交时观察到的 CLI 原生会话 id（可能中途轮换），供下次 resume 使用。 */
  get observedCliSessionId(): string | undefined {
    return this.cliSessionId;
  }

  async open(): Promise<{ projectionRef: string; cliPid: number | null }> {
    mkdirSync(this.opts.stateDir, { recursive: true });
    const args = this.adapter.buildArgs({
      sessionId: this.opts.sessionId,
      resume: this.opts.resume === true,
      workingDir: this.opts.cwd,
      resumeSessionId: this.opts.resumeSessionId,
      model: this.opts.model,
      disableCliBypass: this.opts.disableCliBypass,
    });
    try {
      this.backend.spawn(this.adapter.resolvedBin, args, {
        cwd: this.opts.cwd,
        cols: this.cols,
        rows: this.rows,
        env: this.opts.env,
      });
    } catch (err) {
      throw new PtyOpenError('spawn_failed', `spawn ${this.adapter.resolvedBin} failed: ${describe(err)}`, {
        screenTail: '',
      });
    }
    this.backend.onData((data) => this.onData(data));
    this.backend.onExit((exitCode, signal) => {
      this.exited = { exitCode, signal };
      this.settle({ kind: 'exit' });
    });

    const deadlineAt = Date.now() + (this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    const settled = await this.waitSettle(Math.max(0, deadlineAt - Date.now()));
    // readyPattern 可能被启动期的状态栏/选择符误命中（codex 的 `Context 100%
    // left` 在 MCP servers 起完前就出现；Claude 的信任对话框带 `❯`），此时
    // 粘贴的 prompt 会被吞掉。要求屏幕静止一个确认窗口且没有 busy 标记。
    const outcome = settled.kind === 'idle' ? await this.confirmQuiet(deadlineAt) : settled.kind;
    if (typeof outcome === 'object') {
      throw new PtyOpenError('cli_needs_setup', setupMessage(this.adapter, outcome.setup), {
        screenTail: await this.screenTail(),
      });
    }
    if (outcome === 'exit') {
      const screenTail = await this.screenTail();
      // node-pty 通过 helper 进程 exec；二进制不存在时 spawn 本身不抛，而是子进程
      // 立刻退出并把 execvp 错误打到 PTY 上。按词汇表归到 spawn_failed（不可重试）。
      if (EXEC_FAILURE_RE.test(screenTail)) {
        throw new PtyOpenError('spawn_failed', `spawn ${this.adapter.resolvedBin} failed: ${screenTail.trim()}`, {
          exitCode: this.exited?.exitCode ?? null,
          signal: this.exited?.signal ?? null,
          screenTail,
        });
      }
      throw new PtyOpenError('provider_exit', `${this.adapter.id} exited before its prompt was ready`, {
        exitCode: this.exited?.exitCode ?? null,
        signal: this.exited?.signal ?? null,
        screenTail,
      });
    }
    if (outcome === 'timeout') {
      throw new PtyOpenError('ready_timeout', `${this.adapter.id} did not become ready in time`, {
        screenTail: await this.screenTail(),
      });
    }
    return {
      projectionRef: this.ptyLogPath,
      cliPid: this.cliPid(),
    };
  }

  /**
   * 真正的 CLI 进程 pid（穿透 launcher/wrapper）。解析成功后缓存；解析不到时退回
   * launcher pid——adapter 拿着它至多是验证不过（advisory），不会误判归属。
   */
  private cliPid(): number | null {
    if (this.resolvedCliPid !== null) return this.resolvedCliPid;
    const launcherPid = this.backend.getChildPid?.() ?? null;
    if (launcherPid === null) return null;
    const resolve = this.opts.resolveCliPid ?? defaultResolveCliPid(this.adapter.id);
    const resolved = resolve(launcherPid);
    if (resolved !== null) this.resolvedCliPid = resolved;
    return resolved ?? launcherPid;
  }

  /** 本轮契约文件路径；供 runner 在授权发送前把文件名写进 `send.intent`。 */
  contractPathFor(turnId: string): string {
    return this.contractFor(turnId).path;
  }

  private contractFor(turnId: string): OutputContract {
    return createOutputContract(this.opts.stateDir, turnId, this.opts.contractFileName?.(turnId));
  }

  async runTurn(input: PtyTurnInput): Promise<PtyTurnOutcome> {
    if (this.activeTurnId !== null) {
      return {
        status: 'failed',
        failure: { code: 'turn_busy', detail: `turn ${this.activeTurnId} is still active` },
      };
    }
    if (this.exited) return this.providerExitFailure();

    this.activeTurnId = input.turnId;
    this.pendingCancel = null;
    try {
      const contract = this.contractFor(input.turnId);
      // 先复位再武装 waiter：writeInput 内部可能 await 数秒，期间 CLI 已经可能
      // 出声并再次安静，waiter 若晚于它注册就会漏掉第一次 idle。
      this.idle.reset();
      this.renderer.markNewTurn();
      const firstSettle = this.nextSettle();

      const submission = await this.submit(appendOutputContract(input.prompt, contract));
      if ('failure' in submission) {
        this.dropWaiter();
        return { status: 'failed', failure: submission.failure };
      }
      try {
        this.opts.onSubmitted?.(input.turnId, submission.unconfirmed === true);
      } catch {
        // 诊断回调不影响回合
      }
      if (this.pendingCancel) {
        this.dropWaiter();
        return { status: 'cancelled', reason: this.pendingCancel, screenTail: await this.screenTail() };
      }

      let settled: GraceSettle = await firstSettle;
      let idleSource: IdleEvidenceSource = 'screen';
      for (;;) {
        if (settled.kind === 'cancel') {
          return { status: 'cancelled', reason: settled.reason, screenTail: await this.screenTail() };
        }
        if (settled.kind === 'exit') return this.providerExitFailure();
        if (settled.kind === 'contract') {
          return this.completeFromContract(contract, idleSource);
        }
        if (settled.kind === 'grace_expired') {
          // 证据优先级：契约文件 > adapter 提交验证 > 屏幕。adapter 没确认到提交
          // 且最终也没有契约文件时，屏幕上多半只是一个空 composer——把它当回复
          // 交出去比失败更糟。
          if (submission.unconfirmed) {
            return {
              status: 'failed',
              failure: {
                code: 'submit_unconfirmed',
                detail: 'adapter could not confirm the prompt was submitted and no output contract file was produced',
                screenTail: await this.screenTail(),
              },
            };
          }
          return this.completeFromScreen();
        }
        idleSource = settled.source;
        const fromFile = readOutputContract(contract);
        if (fromFile !== null) return this.completeFromContract(contract, idleSource, fromFile);
        // 屏幕安静但仍显示 busy 标记（codex `Working… esc to interrupt`）：这是
        // 思考间隙而不是回合结束，按主 worker 的 deferPromptReadyWhileBusy 语义
        // 继续等，直到标记消失或 CLI 再次出声。
        if (screenLooksBusy(this.adapter, await this.screenTail())) {
          settled = await this.waitBusyClear();
          continue;
        }
        settled = await this.waitContractOrSettle(contract);
      }
    } finally {
      this.activeTurnId = null;
      this.pendingCancel = null;
    }
  }

  /**
   * 打断当前回合。只对 turnId 匹配的活跃回合生效；steer 语义就是 cancel 后在同一
   * 会话上发起下一轮，所以这里不销毁会话。
   */
  cancel(turnId: string, reason: PtyCancelReason): boolean {
    if (this.activeTurnId !== turnId) return false;
    this.backend.write(this.opts.interruptKeys ?? interruptKeys(this.adapter));
    this.pendingCancel = reason;
    this.settle({ kind: 'cancel', reason });
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dropWaiter();
    this.idle.dispose();
    try {
      this.backend.kill();
    } catch {
      // already dead
    }
    this.renderer.dispose();
  }

  /** 屏幕尾部（原始视口，含提示符行），作为失败/低置信结算的证据。 */
  async screenTail(): Promise<string> {
    if (this.closed) return '';
    await this.renderer.writeAndFlush('');
    const lines = this.renderer.rawSnapshot().split('\n');
    return lines.slice(-SCREEN_TAIL_LINES).join('\n');
  }

  private onData(data: string): void {
    if (this.closed) return;
    this.dataSeq += 1;
    try {
      appendFileSync(this.ptyLogPath, data);
    } catch {
      // 日志落盘失败不能影响会话本身
    }
    this.renderer.write(data);
    this.idle.feed(data);
  }

  /**
   * 提交 prompt。adapter 的自我验证（Claude 看 JSONL、Codex 看 history.jsonl +
   * rollout 归属）只是辅助证据：明确的 failureReason 立即失败；仅仅「没确认到」
   * 则标记 unconfirmed 继续等结算，由契约文件给最终裁决。
   */
  private async submit(content: string): Promise<{ failure: PtyTurnFailure } | { unconfirmed: boolean }> {
    const handle: PtyHandle = {
      write: (data) => this.backend.write(data),
      cliPid: this.cliPid() ?? undefined,
      cliCwd: this.opts.cwd,
    };
    const result = await this.adapter.writeInput(handle, content);
    if (result?.cliSessionId) this.cliSessionId = result.cliSessionId;
    if (!result || result.submitted !== false) return { unconfirmed: false };
    if (result.failureReason) {
      return {
        failure: {
          code: 'submit_unconfirmed',
          detail: result.failureReason,
          screenTail: await this.screenTail(),
        },
      };
    }
    if (result.recheck) {
      await sleep(SUBMIT_RECHECK_DELAY_MS);
      const recheck = await result.recheck();
      const submitted = typeof recheck === 'boolean' ? recheck : recheck.submitted;
      if (submitted) {
        if (typeof recheck !== 'boolean' && recheck.cliSessionId) this.cliSessionId = recheck.cliSessionId;
        return { unconfirmed: false };
      }
    }
    return { unconfirmed: true };
  }

  private async completeFromContract(
    contract: OutputContract,
    idleSource: IdleEvidenceSource,
    text?: string,
  ): Promise<PtyTurnOutcome> {
    const finalResponse = text ?? readOutputContract(contract);
    if (finalResponse === null) return this.completeFromScreen();
    return {
      status: 'completed',
      finalResponse,
      settlement: { source: 'contract_file', confidence: 'high', idleSource },
      screenTail: await this.screenTail(),
    };
  }

  private async completeFromScreen(): Promise<PtyTurnOutcome> {
    await this.renderer.writeAndFlush('');
    const screenTail = await this.screenTail();
    // 回合中途掉到登录/信任向导（token 过期、trust 状态被清）：把向导文本当回复
    // 交出去只会让上游反复「修复输出」，直接以 cli_needs_setup 失败。
    const setup = screenNeedsSetup(this.adapter, screenTail);
    if (setup !== undefined) {
      return { status: 'failed', failure: { code: 'cli_needs_setup', detail: setupMessage(this.adapter, setup), screenTail } };
    }
    return {
      status: 'completed',
      finalResponse: this.renderer.snapshot().content,
      settlement: {
        source: 'screen',
        confidence: 'low',
        idleSource: 'screen',
        reason: 'output contract file was not written; response scraped from the terminal viewport',
      },
      screenTail,
    };
  }

  private async providerExitFailure(): Promise<PtyTurnOutcome> {
    return {
      status: 'failed',
      failure: {
        code: 'provider_exit',
        exitCode: this.exited?.exitCode ?? null,
        signal: this.exited?.signal ?? null,
        screenTail: await this.screenTail(),
      },
    };
  }

  /**
   * 就绪确认：一个确认窗口内没有新 PTY 数据、屏幕尾部没有 busy 标记、且（若
   * adapter 定义了 readyPattern）静止后的屏幕上确实有输入提示符，才算真就绪。
   * 屏幕仍在变、显示 busy、或只是启动期的过渡重绘（有 header 没 composer）都
   * 继续等，直到 deadline。
   */
  private async confirmQuiet(deadlineAt: number): Promise<'ready' | 'exit' | 'timeout' | { setup: string }> {
    const confirmMs = this.opts.readyConfirmMs ?? DEFAULT_READY_CONFIRM_MS;
    for (;;) {
      if (this.exited) return 'exit';
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return 'timeout';
      const seq = this.dataSeq;
      await sleep(Math.min(confirmMs, remaining));
      if (this.exited) return 'exit';
      if (this.dataSeq !== seq) continue;
      const tail = await this.screenTail();
      // 「信任目录」对话框：自动接受默认项后继续等 composer（与主 worker 同策略）。
      if (!this.trustAccepted && trustDialogPattern(this.adapter)?.test(tail)) {
        this.trustAccepted = true;
        // codex 0.149 的按键处理器在对话框刚渲染时尚未就绪，立刻发出的 Enter 会被
        // 静默丢弃（openai/codex#39487）；延迟一小段再发。
        await sleep(Math.min(TRUST_ACCEPT_DELAY_MS, Math.max(0, deadlineAt - Date.now())));
        if (this.exited) return 'exit';
        this.backend.write('\r');
        continue;
      }
      // 登录/信任向导常带 `❯`，会被 readyPattern 误判为就绪；先于就绪判断识别。
      const setup = screenNeedsSetup(this.adapter, tail);
      if (setup !== undefined) return { setup };
      if (this.screenShowsPrompt(tail)) return 'ready';
    }
  }

  /** 静止屏幕是否处于「可收 prompt」状态：无 busy 标记，且提示符在屏（若 adapter 有定义）。 */
  private screenShowsPrompt(tail: string): boolean {
    if (screenLooksBusy(this.adapter, tail)) return false;
    const ready = this.adapter.readyPattern;
    return ready === undefined || ready.test(tail);
  }

  /**
   * 回合内 busy 复核：屏幕安静但仍显示 busy 标记时定期探测。标记消失且期间无
   * 新输出 → 合成一次 idle；有新输出 → 交给 IdleDetector 重新判定；exit/cancel
   * 原样返回。
   */
  private async waitBusyClear(): Promise<Settle> {
    const probeMs = this.opts.busyProbeMs ?? DEFAULT_BUSY_PROBE_MS;
    for (;;) {
      if (this.pendingCancel) return { kind: 'cancel', reason: this.pendingCancel };
      const seq = this.dataSeq;
      const next = this.nextSettle();
      const result = await Promise.race([next, sleep(probeMs).then(() => 'probe' as const)]);
      if (result !== 'probe') return result;
      this.dropWaiter();
      if (this.dataSeq !== seq) continue;
      if (!screenLooksBusy(this.adapter, await this.screenTail())) return { kind: 'idle', source: 'screen' };
    }
  }

  private settle(settle: Settle): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = null;
    waiter(settle);
  }

  private dropWaiter(): void {
    this.waiter = null;
  }

  private nextSettle(): Promise<Settle> {
    if (this.exited) return Promise.resolve({ kind: 'exit' });
    return new Promise<Settle>((resolve) => {
      this.waiter = resolve;
    });
  }

  private async waitSettle(timeoutMs: number): Promise<Settle | { kind: 'timeout' }> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    });
    try {
      return await Promise.race([this.nextSettle(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      this.dropWaiter();
    }
  }

  private async waitContractOrSettle(contract: OutputContract): Promise<GraceSettle> {
    const graceMs = this.opts.contractGraceMs ?? DEFAULT_CONTRACT_GRACE_MS;
    const pollMs = this.opts.contractPollMs ?? DEFAULT_CONTRACT_POLL_MS;
    let poll: ReturnType<typeof setInterval> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const next = this.nextSettle();
    const watch = new Promise<GraceSettle>((resolve) => {
      poll = setInterval(() => {
        if (existsSync(contract.path) && readOutputContract(contract) !== null) {
          resolve({ kind: 'contract' });
        }
      }, pollMs);
      deadline = setTimeout(() => resolve({ kind: 'grace_expired' }), graceMs);
    });
    try {
      return await Promise.race([next, watch]);
    } finally {
      if (poll) clearInterval(poll);
      if (deadline) clearTimeout(deadline);
      this.dropWaiter();
    }
  }
}

function setupMessage(adapter: Pick<CliAdapter, 'id' | 'resolvedBin'>, matchedLine: string): string {
  return `${adapter.id} is showing a login/onboarding screen instead of its prompt ("${matchedLine}"); `
    + `run \`${adapter.resolvedBin}\` once in a terminal under the same HOME, finish login/trust, then retry`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** launcher 自身就是 CLI 则直接用；否则在进程树里找 adapter.id 对应的最浅后代。 */
function defaultResolveCliPid(adapterId: string): (launcherPid: number) => number | null {
  // adapter.id 在类型上是宽 string；discovery 只认注册表里的 CliId，未知 id 直接放弃解析。
  const cliId = adapterId as CliId;
  return (launcherPid) => {
    const comm = readComm(launcherPid);
    if (comm && cliIdForComm(comm, cliId) === cliId) return launcherPid;
    return findLaunchedCliPid(launcherPid, cliId);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
