import {
  execFile,
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionBackend, SpawnOpts, SessionProbe } from './types.js';
import { zmxEnv, probeZmxFunctional } from '../../setup/ensure-zmx.js';
import {
  buildBotmuxEnvAssignments,
  buildDebugKeepShellScript,
  resolveUserShell,
  SHELL_WRAPPER_SCRIPT,
} from './tmux-backend.js';
import { logger } from '../../utils/logger.js';

const EARLY_BUFFER_MAX = 1024 * 1024;
const HISTORY_TAIL_DEBOUNCE_MS = 50;
const HISTORY_HOT_POLL_MS = 250;
// Keep the worst-case safety poll below IdleDetector's 2s quiescence window:
// otherwise a pure-Unicode burst (which broken upstream tail may not signal)
// could be observed only after the worker had already declared the turn idle.
const HISTORY_COLD_POLL_MS = 1250;
const HISTORY_COLD_JITTER_MAX_MS = 250;
const HISTORY_STABLE_POLLS_BEFORE_COLD = 3;
const ZMX_HISTORY_TIMEOUT_MS = 3000;
const ZMX_HISTORY_SETTLE_TIMEOUT_MS = 4000;
const TAIL_RECOVERY_DELAY_MAX_MS = 2000;
const FRESH_READY_TIMEOUT_MS = 5000;
const FRESH_RELEASE_TIMEOUT_MS = 12_000;
const FRESH_CLI_PID_TIMEOUT_MS = 3000;
// ZMX removes history as soon as the PTY root exits. Keep the private launch
// shell alive briefly after the real CLI finishes so the history-only output
// path can publish the final bytes before the daemon unlinks the session.
const ZMX_EXIT_HISTORY_GRACE_SECONDS = 3;
const TAIL_CONNECT_TIMEOUT_MS = 3000;
const MANAGED_KILL_TIMEOUT_MS = 5000;
const ZMX_COMMAND_TIMEOUT_MS = 5000;
const ZMX_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
// ZMX's daemon reads one 4096-byte IPC frame at a time and may observe HUP from
// the short-lived `send` client in the same poll iteration. Keep header+payload
// comfortably below that boundary so it can parse the complete message before
// closing the client (PR #202 currently has no ACK/drain handshake).
const ZMX_SEND_CHUNK_BYTES = 1024;
// PR #202 still has a 256 KiB daemon-side input queue and no send ACK. Reject
// one-shot payloads well below that ceiling before writing any prefix; adapters
// that intentionally stream larger input already split and throttle their calls.
const ZMX_SEND_MAX_BYTES = 64 * 1024;
const ZMX_TRANSPORT_LABEL = 'botmux.transport';
const ZMX_TRANSPORT = 'tail-send-v1';
const ZMX_SESSION_LABEL = 'botmux.session';
const ZMX_LAUNCH_PID_LABEL = 'botmux.launch_pid';

type BackendState = 'idle' | 'observing' | 'recovering' | 'stopped' | 'exited';

type BackingIdentityProbe =
  | { state: 'compatible'; clients: number | null }
  | { state: 'missing' }
  | { state: 'unknown'; reason: string }
  | { state: 'replaced'; reason: string };

interface ZmxSessionProbeResult {
  ok: true;
  sessions: string[];
  unhealthySessions: string[];
  raw: string;
}

interface ZmxSessionDetails {
  name: string;
  pid: number;
  clients: number | null;
  command: string | null;
}

export type ZmxManagedSessionProbe =
  | { state: 'missing' }
  | { state: 'unknown'; reason: string }
  | { state: 'compatible'; pid: number; clients: number | null }
  | {
      state: 'incompatible';
      pid: number;
      clients: number | null;
      reason: 'transport-label' | 'session-label';
    };

interface ZmxLaunchPayload {
  dir: string;
  bootstrapPath: string;
  readyPath: string;
  readyNonce: string;
  releasePath: string;
  releaseTempPath: string;
  cliPidPath: string;
  releaseToken: string;
  cleanup: () => void;
}

const syncSleepCell = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(syncSleepCell, 0, 0, ms);
}

/** Cross-platform direct-parent probe used only during the private fresh
 * handshake and warm reattach. ZMX itself is Unix-only, so Linux `/proc` plus
 * BSD-compatible `ps` covers its supported hosts without shell interpolation. */
function readProcessParentPid(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = raw.lastIndexOf(')');
      if (closeParen < 0) return null;
      const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
      const parent = Number(fields[1]);
      return Number.isSafeInteger(parent) && parent > 0 ? parent : null;
    } catch { return null; }
  }
  for (const ps of ['/usr/bin/ps', '/bin/ps']) {
    try {
      const raw = execFileSync(ps, ['-o', 'ppid=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      }).trim();
      const parent = Number(raw);
      if (Number.isSafeInteger(parent) && parent > 0) return parent;
    } catch { /* try the other standard BSD/GNU location */ }
  }
  return null;
}

/** Convert plain line feeds into terminal-safe CRLF without doubling CRLF. */
export function normaliseZmxHistory(text: string): string {
  // ZMX history emits LF while tail can expose CRLF, and high-throughput tail
  // chunking can occasionally repeat the CR at a boundary. All represent the
  // same terminal line break in this plain-text transport.
  return text.replace(/\r*\n/g, '\r\n');
}

/**
 * Persistent ZMX backend built from three non-leader primitives:
 *
 *   - `zmx tail` is a low-latency change/liveness signal (never a byte source);
 *   - `zmx send` injects input without taking client leadership or resizing;
 *   - `zmx history` is the sole authoritative plain-text screen source.
 *
 * A one-shot `zmx attach ... /bin/sh <private-bootstrap>` is used only as the
 * race-safe create primitive. Its stdin is /dev/null, so the client exits
 * immediately and never remains as a synthetic leader. The private bootstrap
 * does not launch the CLI until botmux has proved ownership, stamped the
 * transport protocol labels and observed the tail client connected.
 */
export class ZmxBackend implements SessionBackend {
  private tailProcess: ChildProcess | null = null;
  private readonly dataCbs: Array<(data: string) => void> = [];
  private readonly screenResyncCbs: Array<(snapshot: string) => void> = [];
  private readonly exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  private reattaching: boolean;
  private intentionalExit = false;
  private exited = false;
  private state: BackendState = 'idle';
  private tailEpoch = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stableTailTimer: NodeJS.Timeout | null = null;
  private historyTimer: NodeJS.Timeout | null = null;
  private historyTimerDueAt = 0;
  private historyProcess: ChildProcess | null = null;
  private historyGeneration = 0;
  private historyCaptureSerial = 0;
  private historyInFlight = false;
  private historyAgain = false;
  private historyAgainActivity = false;
  private historyAgainForceResync = false;
  private tailActivitySinceCapture = false;
  private forceResyncOnNextSnapshot = false;
  private stableHistoryPolls = 0;
  private snapshotCache = '';
  private hasSnapshot = false;
  private pendingScreenResyncReplay = false;
  private readonly historyColdJitterMs: number;
  private readonly historySettleWaiters: Array<{
    targetSerial: number;
    resolve: (success: boolean) => void;
    timer: NodeJS.Timeout;
  }> = [];
  /** A same-name session failed ownership checks and must never be killed. */
  private preserveSessionOnDestroy = false;
  private pendingExit: { code: number | null; signal: string | null } | null = null;
  private earlyBuffer = '';
  private lastOpts: SpawnOpts | null = null;
  /** Frozen ZMX PTY-root PID for the session generation we may control. */
  private backingPid: number | null = null;
  /** Stable direct child of the PTY root; wrapper resolution may refine cliPid. */
  private launchPid: number | null = null;

  claudeJsonlPath?: string;
  cliPid?: number;
  cliCwd?: string;

  constructor(
    private readonly sessionName: string,
    private readonly opts: {
      ownsSession?: boolean;
      isReattach?: boolean;
      sessionId?: string;
    } = {},
  ) {
    this.reattaching = opts.isReattach ?? false;
    let hash = 0;
    for (const char of sessionName) hash = ((hash * 33) + char.charCodeAt(0)) >>> 0;
    this.historyColdJitterMs = hash % (HISTORY_COLD_JITTER_MAX_MS + 1);
  }

  static isAvailable(): boolean {
    return probeZmxFunctional().ok;
  }

  static sessionName(sessionId: string): string {
    return `bmx-${sessionId.slice(0, 8)}`;
  }

  /**
   * Pair the authoritative healthy-name surface (`list --short`) with the full
   * list's `err=` rows. The full command field is not a line protocol (literal
   * newlines in argv spill onto continuation lines), so it must never be the
   * sole source of truth for a healthy session name.
   */
  static probeSessions(env: NodeJS.ProcessEnv = zmxEnv()): ZmxSessionProbeResult | { ok: false } {
    try {
      const shortOut = execFileSync('zmx', ['list', '--short'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        env,
      });
      const out = execFileSync('zmx', ['list'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        env,
      });
      const short = parseZmxShortList(shortOut);
      const parsed = parseZmxList(out);
      if (short.malformedLines.length > 0 || parsed.malformedLines.length > 0) return { ok: false };
      if (short.sessions.length > 0 && parsed.sessions.length + parsed.unhealthySessions.length === 0) {
        return { ok: false };
      }

      const healthy = new Set(short.sessions);
      // A healthy-looking full row absent from --short is ambiguous (the row
      // can have been forged by a multiline cmd field). Preserve it as unknown,
      // never as authoritative existence or absence. Conversely --short wins
      // over a forged err= continuation for a genuinely healthy name.
      const unhealthy = new Set([
        ...parsed.unhealthySessions.filter(name => !healthy.has(name)),
        ...parsed.sessions.filter(name => !healthy.has(name)),
      ]);
      return {
        ok: true,
        sessions: short.sessions,
        unhealthySessions: [...unhealthy],
        raw: out,
      };
    } catch {
      return { ok: false };
    }
  }

  static hasSession(name: string, env: NodeJS.ProcessEnv = zmxEnv()): boolean {
    return ZmxBackend.probeSession(name, env) === 'exists';
  }

  static probeSession(name: string, env: NodeJS.ProcessEnv = zmxEnv()): SessionProbe {
    const probe = ZmxBackend.probeSessions(env);
    if (!probe.ok) return 'unknown';
    if (probe.sessions.includes(name)) return 'exists';
    if (probe.unhealthySessions.includes(name)) return 'unknown';
    return 'missing';
  }

  /**
   * Verify that a name still resolves to the botmux-owned transport for the
   * complete session UUID. The PTY-root PID is sampled on both sides of the label
   * reads so a same-name replacement cannot be mistaken for the process whose
   * labels we just inspected.
   */
  static probeManagedSession(
    name: string,
    expectedSessionId: string | undefined,
    env: NodeJS.ProcessEnv = zmxEnv(),
  ): ZmxManagedSessionProbe {
    const beforeSnapshot = ZmxBackend.probeSessions(env);
    if (!beforeSnapshot.ok) {
      return { state: 'unknown', reason: `无法读取 ZMX 会话 ${name} 的进程信息` };
    }
    if (!beforeSnapshot.sessions.includes(name)) {
      return beforeSnapshot.unhealthySessions.includes(name)
        ? { state: 'unknown', reason: `ZMX 会话 ${name} 当前无响应` }
        : { state: 'missing' };
    }
    const before = sessionDetailsFromSnapshot(beforeSnapshot, name);
    if (!before) return { state: 'unknown', reason: `ZMX 会话 ${name} 的进程信息不唯一` };

    let transport: string;
    let sessionId = '';
    try {
      transport = execFileSync('zmx', ['get', name, ZMX_TRANSPORT_LABEL], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3000,
        env,
      }).trim();
      if (expectedSessionId) {
        sessionId = execFileSync('zmx', ['get', name, ZMX_SESSION_LABEL], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 3000,
          env,
        }).trim();
      }
    } catch (err) {
      return {
        state: 'unknown',
        reason: `无法读取 ZMX 会话 ${name} 的所有权标签：${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const afterSnapshot = ZmxBackend.probeSessions(env);
    const after = afterSnapshot.ok ? sessionDetailsFromSnapshot(afterSnapshot, name) : null;
    if (!after || after.pid !== before.pid) {
      return { state: 'unknown', reason: `ZMX 会话 ${name} 在所有权校验期间发生变化` };
    }
    if (transport !== ZMX_TRANSPORT) {
      return {
        state: 'incompatible',
        pid: after.pid,
        clients: after.clients,
        reason: 'transport-label',
      };
    }
    if (expectedSessionId && sessionId !== expectedSessionId) {
      return {
        state: 'incompatible',
        pid: after.pid,
        clients: after.clients,
        reason: 'session-label',
      };
    }
    return { state: 'compatible', pid: after.pid, clients: after.clients };
  }

  /** ZMX has one daemon per session rather than one shared server. */
  static serverState(): 'running' | 'down' | 'unknown' {
    const probe = ZmxBackend.probeSessions();
    if (!probe.ok) return 'unknown';
    if (probe.unhealthySessions.some(s => s.startsWith('bmx-'))) return 'unknown';
    return probe.sessions.some(s => s.startsWith('bmx-')) ? 'running' : 'down';
  }

  static killSession(name: string): void {
    try {
      execFileSync('zmx', ['kill', name, '--force'], {
        stdio: 'ignore',
        timeout: ZMX_COMMAND_TIMEOUT_MS,
        env: zmxEnv(),
      });
    } catch { /* already gone or daemon unavailable */ }
  }

  /** Kill only a session whose full botmux identity is still authoritative. */
  static killManagedSession(
    name: string,
    expectedSessionId: string,
    expectedPid?: number,
    env: NodeJS.ProcessEnv = zmxEnv(),
  ): void {
    const probe = ZmxBackend.probeManagedSession(name, expectedSessionId, env);
    if (probe.state === 'missing') return;
    if (probe.state !== 'compatible') {
      throw new Error(
        probe.state === 'unknown'
          ? probe.reason
          : `ZMX 会话 ${name} 的所有权标签不匹配，已拒绝删除`,
      );
    }
    if (expectedPid !== undefined && probe.pid !== expectedPid) {
      throw new Error(`ZMX 会话 ${name} 的 PTY root PID 已变化，已拒绝删除`);
    }
    execFileSync('zmx', ['kill', name, '--force'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: ZMX_COMMAND_TIMEOUT_MS,
      env,
    });
    // Successful ZMX kills print `killed session <name>` (and forced stale
    // cleanup also prints a status line). The exit status plus the generation-
    // aware convergence probe below are authoritative, not empty stdout.

    const deadline = Date.now() + MANAGED_KILL_TIMEOUT_MS;
    let lastUnknownReason: string | null = null;
    while (Date.now() < deadline) {
      const after = ZmxBackend.probeManagedSession(name, expectedSessionId, env);
      if (after.state === 'missing') return;
      // A just-removed socket may briefly remain visible while its control
      // endpoint already rejects get/list. Treat that as convergence, not as a
      // replacement; an incompatible label or changed PID still fails at once.
      if (after.state === 'unknown') {
        lastUnknownReason = after.reason;
        sleepSync(25);
        continue;
      }
      if (after.state === 'incompatible' || after.pid !== probe.pid) {
        throw new Error(`ZMX 会话 ${name} 在删除确认期间被同名会话替换`);
      }
      sleepSync(25);
    }
    throw new Error(
      `ZMX 会话 ${name} 删除确认超时` +
      (lastUnknownReason ? `：${lastUnknownReason}` : ''),
    );
  }

  static listBotmuxSessions(): string[] {
    const probe = ZmxBackend.probeSessions();
    return probe.ok ? probe.sessions.filter(s => s.startsWith('bmx-')) : [];
  }

  static listDetails(): string {
    const probe = ZmxBackend.probeSessions();
    return probe.ok ? probe.raw : '';
  }

  get isReattach(): boolean {
    return this.reattaching;
  }

  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    const frozenOpts: SpawnOpts = {
      ...opts,
      env: { ...opts.env },
      injectEnv: opts.injectEnv ? { ...opts.injectEnv } : undefined,
    };
    const controlEnv = zmxControlEnv(frozenOpts);
    const probe = ZmxBackend.probeManagedSession(
      this.sessionName,
      this.opts.sessionId,
      controlEnv,
    );
    if (probe.state === 'unknown') throw new Error(probe.reason);
    if (probe.state === 'incompatible') {
      this.preserveSessionOnDestroy = true;
      throw new Error(
        probe.reason === 'transport-label'
          ? `ZMX 会话 ${this.sessionName} 缺少 botmux 传输标签（tail 信号 + history 屏幕 + send 输入）；已保留，请手动关闭旧会话后重试`
          : `ZMX 会话 ${this.sessionName} 属于另一个完整 botmux session；已保留该会话`,
      );
    }

    if (probe.state === 'compatible') {
      // Reattach/fresh is frozen by worker before plugin, startup-command and
      // isolation decisions. A late same-name winner must not silently turn a
      // fresh launch into an attach to a process created under another policy.
      if (!this.reattaching) {
        this.preserveSessionOnDestroy = true;
        throw new Error(`ZMX 会话 ${this.sessionName} 在启动前已出现；已保留并拒绝改变 fresh 决策`);
      }
      this.backingPid = probe.pid;
      this.lastOpts = frozenOpts;
      this.launchPid = this.readManagedLaunchPid(frozenOpts, probe.pid);
      this.cliPid = this.launchPid;
    } else if (this.reattaching) {
      // The daemon selected reattach from an earlier probe. Never turn that
      // stale decision into a new CLI after the backing session disappears.
      throw new Error(`ZMX 会话 ${this.sessionName} 在重连前已消失`);
    } else {
      this.lastOpts = frozenOpts;
    }

    logger.debug(
      `[zmx:${this.sessionName}] spawn ${this.reattaching ? 'reattach' : 'fresh'} ` +
      `bin=${bin} args=${JSON.stringify(args)} cwd=${opts.cwd}`,
    );

    if (this.reattaching) {
      const baselineClients = probe.state === 'compatible' ? (probe.clients ?? 0) : 0;
      this.startTail();
      if (!this.waitForTailClient(baselineClients)) {
        this.stopTailAfterLaunchFailure();
        this.preserveSessionOnDestroy = true;
        throw new Error(`ZMX tail 未能连接会话 ${this.sessionName}`);
      }
      this.requestHistoryCapture(0, true, true);
      return;
    }

    this.createFreshSession(bin, args, opts);
  }

  write(data: string): void {
    if (!this.sendText(data)) throw new Error(`ZMX 会话 ${this.sessionName} 输入发送失败`);
  }

  sendText(text: string): boolean {
    return this.sendBytes(Buffer.from(text, 'utf8'));
  }

  sendSpecialKeys(...keys: string[]): boolean {
    return this.sendText(keys.map(tmuxKeyToBytes).join(''));
  }

  pasteText(text: string): void {
    if (!this.sendBytes(Buffer.from(`\x1b[200~${text}\x1b[201~`, 'utf8'), true)) {
      throw new Error(`ZMX 会话 ${this.sessionName} 粘贴发送失败`);
    }
  }

  /** send intentionally never becomes a leader, so botmux cannot resize ZMX. */
  resize(_cols: number, _rows: number): void {}

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
    if (this.earlyBuffer) {
      const buffered = this.earlyBuffer;
      this.earlyBuffer = '';
      try { cb(buffered); } catch { /* listener failure must not kill transport */ }
    }
  }

  onScreenResync(cb: (snapshot: string) => void): void {
    this.screenResyncCbs.push(cb);
    if (this.pendingScreenResyncReplay) {
      this.pendingScreenResyncReplay = false;
      try { cb(this.snapshotCache); } catch { /* listener failure must not kill transport */ }
    }
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCbs.push(cb);
    if (this.pendingExit) {
      const exit = this.pendingExit;
      try { cb(exit.code, exit.signal); } catch { /* listener failure must not block teardown */ }
    }
  }

  getChildPid(): number | null {
    if (this.cliPid) return this.cliPid;
    const pid = this.backingPid ?? findSessionPid(this.sessionName);
    if (pid) this.cliPid = pid;
    return pid;
  }

  /** Best-effort plain-text terminal snapshot supplied by ZMX history. */
  captureCurrentScreen(): string {
    return this.hasSnapshot ? this.snapshotCache : '';
  }

  settleCurrentScreen(): Promise<boolean> {
    if (this.exited || this.intentionalExit || !this.lastOpts) return Promise.resolve(false);
    // If a capture is already in flight, wait for the dirty-latch follow-up,
    // not the older sample that may have started before the final output.
    const targetSerial = this.historyCaptureSerial + 1;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const index = this.historySettleWaiters.findIndex(waiter => waiter.resolve === resolve);
        if (index >= 0) this.historySettleWaiters.splice(index, 1);
        resolve(false);
      }, ZMX_HISTORY_SETTLE_TIMEOUT_MS);
      timer.unref?.();
      this.historySettleWaiters.push({ targetSerial, resolve, timer });
      this.requestHistoryCapture(0);
    });
  }

  captureViewport(): string {
    return this.captureCurrentScreen();
  }

  getPaneSize(): null {
    return null;
  }

  isPaneAlive(): boolean {
    return this.verifyBackingGeneration('liveness').state === 'compatible';
  }

  /** Detach the read-only observer while leaving the ZMX daemon and CLI alive. */
  kill(): void {
    if (this.state === 'stopped' || this.state === 'exited') return;
    this.intentionalExit = true;
    this.state = 'stopped';
    this.tailEpoch += 1;
    this.clearReconnectTimer();
    this.clearStableTailTimer();
    this.stopHistoryPolling();
    const tail = this.tailProcess;
    this.tailProcess = null;
    try { tail?.kill('SIGTERM'); } catch { /* already gone */ }
  }

  destroySession(): void {
    this.kill();
    if (!(this.opts.ownsSession ?? true) || this.preserveSessionOnDestroy) return;
    if (!this.opts.sessionId || !this.lastOpts || this.backingPid == null) return;
    try {
      ZmxBackend.killManagedSession(
        this.sessionName,
        this.opts.sessionId,
        this.backingPid,
        zmxControlEnv(this.lastOpts),
      );
    } catch (err) {
      this.preserveSessionOnDestroy = true;
      logger.warn(
        `[zmx:${this.sessionName}] refused unsafe destroy: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private createFreshSession(bin: string, args: string[], opts: SpawnOpts): void {
    const launch = createZmxLaunchPayload(bin, args, opts);
    let released = false;
    try {
      const result = spawnSync('zmx', buildFreshAttachArgs(this.sessionName, launch.bootstrapPath), {
        cwd: opts.cwd,
        // /dev/null makes this a one-shot create client: it never remains as a
        // fake terminal leader and never controls the backing PTY dimensions.
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: ZMX_COMMAND_TIMEOUT_MS,
        env: zmxControlEnv(opts),
      });

      const ready = this.waitForFreshReady(launch);
      if (!ready) {
        const details = sessionDetails(this.sessionName, zmxControlEnv(opts));
        if (!details?.command?.includes(launch.bootstrapPath)) {
          this.preserveSessionOnDestroy = true;
        }
        const stderr = result.stderr?.toString('utf8').trim();
        throw new Error(
          `ZMX 会话 ${this.sessionName} 启动握手超时` + (stderr ? `：${stderr}` : ''),
        );
      }

      const created = sessionDetails(this.sessionName, zmxControlEnv(opts));
      if (!created || !created.command?.includes(launch.bootstrapPath)) {
        this.preserveSessionOnDestroy = true;
        throw new Error(`ZMX 会话 ${this.sessionName} 的 fresh 所有权握手失效；已保留同名会话`);
      }
      this.backingPid = created.pid;
      const launchPid = this.waitForFreshLaunchPid(launch);
      if (launchPid == null) {
        throw new Error(`ZMX 会话 ${this.sessionName} 未能确认稳定的 CLI launch 子进程`);
      }
      this.launchPid = launchPid;
      this.cliPid = launchPid;

      this.stampProtocolLabels(opts, launchPid);
      const managed = ZmxBackend.probeManagedSession(
        this.sessionName,
        this.opts.sessionId,
        zmxControlEnv(opts),
      );
      if (managed.state !== 'compatible' || managed.pid !== this.backingPid) {
        this.preserveSessionOnDestroy = true;
        throw new Error(`ZMX 会话 ${this.sessionName} 在 release 前未通过完整身份校验`);
      }
      const baselineClients = managed.clients ?? 0;
      this.startTail();
      if (!this.waitForTailClient(baselineClients)) {
        throw new Error(`ZMX tail 未能连接会话 ${this.sessionName}`);
      }

      // The bootstrap performs one read after observing the release file. A
      // direct write has an open-before-content race, so publish a complete
      // token atomically within the same private directory.
      writeFileSync(launch.releaseTempPath, `${launch.releaseToken}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(launch.releaseTempPath, launch.releasePath);
      released = true;
      // The bootstrap can now launch the CLI. Polling is required even when
      // tail emits no bytes: upstream currently drops pure UTF-8 output while
      // stripping ANSI, whereas history preserves it.
      this.requestHistoryCapture(0, true, true);
    } catch (err) {
      this.stopTailAfterLaunchFailure();
      launch.cleanup();
      // Before release, never kill by name: the bounded private bootstrap exits
      // on its own and a same-name race winner must be preserved. After release
      // the CLI may already be running, so tear down only through the frozen
      // full-session identity and PTY-root PID.
      if (released && this.opts.sessionId && this.backingPid != null) {
        try {
          ZmxBackend.killManagedSession(
            this.sessionName,
            this.opts.sessionId,
            this.backingPid,
            zmxControlEnv(opts),
          );
        } catch (killErr) {
          this.preserveSessionOnDestroy = true;
          logger.warn(
            `[zmx:${this.sessionName}] failed to tear down released launch after handshake error: ` +
            `${killErr instanceof Error ? killErr.message : String(killErr)}`,
          );
        }
      }
      this.lastOpts = null;
      this.backingPid = null;
      this.launchPid = null;
      this.cliPid = undefined;
      throw err;
    }
  }

  private waitForFreshReady(launch: ZmxLaunchPayload): boolean {
    const deadline = Date.now() + FRESH_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const value = readFileSync(launch.readyPath, 'utf8').trim();
        if (value === launch.readyNonce) return true;
      } catch { /* bootstrap has not reached the gate yet */ }
      sleepSync(25);
    }
    return false;
  }

  private waitForFreshLaunchPid(launch: ZmxLaunchPayload): number | null {
    const deadline = Date.now() + FRESH_CLI_PID_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const pid = Number(readFileSync(launch.cliPidPath, 'utf8').trim());
        if (
          Number.isSafeInteger(pid)
          && pid > 0
          && this.backingPid != null
          && readProcessParentPid(pid) === this.backingPid
        ) {
          return pid;
        }
      } catch { /* bootstrap has not published a complete pid yet */ }
      sleepSync(25);
    }
    return null;
  }

  private readManagedLaunchPid(opts: SpawnOpts, expectedBackingPid: number): number {
    let raw: string;
    try {
      raw = execFileSync('zmx', ['get', this.sessionName, ZMX_LAUNCH_PID_LABEL], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3000,
        env: zmxControlEnv(opts),
      }).trim();
    } catch (err) {
      throw new Error(
        `ZMX 会话 ${this.sessionName} 缺少 launch PID 标签：` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const pid = Number(raw);
    if (
      !Number.isSafeInteger(pid)
      || pid <= 0
      || readProcessParentPid(pid) !== expectedBackingPid
    ) {
      throw new Error(`ZMX 会话 ${this.sessionName} 的 launch PID 标签无效或已脱离 PTY root`);
    }
    const after = ZmxBackend.probeManagedSession(
      this.sessionName,
      this.opts.sessionId,
      zmxControlEnv(opts),
    );
    if (after.state !== 'compatible' || after.pid !== expectedBackingPid) {
      throw new Error(`ZMX 会话 ${this.sessionName} 在 launch PID 校验期间发生变化`);
    }
    return pid;
  }

  private waitForTailClient(baselineClients: number): boolean {
    const deadline = Date.now() + TAIL_CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const details = sessionDetails(
        this.sessionName,
        this.lastOpts ? zmxControlEnv(this.lastOpts) : zmxEnv(),
      );
      if (details && this.backingPid != null && details.pid !== this.backingPid) {
        this.preserveSessionOnDestroy = true;
        return false;
      }
      if (details?.clients != null && details.clients > baselineClients) return true;
      if (!details && ZmxBackend.probeSession(
        this.sessionName,
        this.lastOpts ? zmxControlEnv(this.lastOpts) : zmxEnv(),
      ) === 'missing') return false;
      sleepSync(25);
    }
    return false;
  }

  private stampProtocolLabels(opts: SpawnOpts, launchPid: number): void {
    const labels = [`${ZMX_TRANSPORT_LABEL}=${ZMX_TRANSPORT}`];
    if (this.opts.sessionId) labels.push(`${ZMX_SESSION_LABEL}=${this.opts.sessionId}`);
    labels.push(`${ZMX_LAUNCH_PID_LABEL}=${launchPid}`);
    const stdout = execFileSync('zmx', ['set', this.sessionName, ...labels], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: ZMX_COMMAND_TIMEOUT_MS,
      env: zmxControlEnv(opts),
    });
    if (stdout.trim()) {
      throw new Error(`ZMX 协议标签写入返回异常：${stdout.trim()}`);
    }
  }


  private verifyBackingIdentity(context: string): BackingIdentityProbe {
    if (!this.lastOpts || !this.opts.sessionId || this.backingPid == null) {
      return { state: 'unknown', reason: `ZMX ${context} 缺少已冻结的会话身份` };
    }
    const wasAlive = this.isBackingProcessAlive();
    let transport: string;
    let sessionId: string;
    try {
      const env = zmxControlEnv(this.lastOpts);
      transport = execFileSync('zmx', ['get', this.sessionName, ZMX_TRANSPORT_LABEL], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3000,
        env,
      }).trim();
      sessionId = execFileSync('zmx', ['get', this.sessionName, ZMX_SESSION_LABEL], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3000,
        env,
      }).trim();
    } catch (err) {
      if (!wasAlive || !this.isBackingProcessAlive()) {
        this.fireExit(0, null);
        return { state: 'missing' };
      }
      return {
        state: 'unknown',
        reason: `无法读取 ZMX 会话 ${this.sessionName} 的所有权标签：` +
          `${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (transport !== ZMX_TRANSPORT || sessionId !== this.opts.sessionId) {
      return this.rejectBackingReplacement(context, '完整 session / transport 标签已变化');
    }
    if (!wasAlive || !this.isBackingProcessAlive()) {
      this.fireExit(0, null);
      return { state: 'missing' };
    }
    return { state: 'compatible', clients: null };
  }

  /** Full list sampling is reserved for lifecycle edges that need client count.
   * Hot send/history paths use target-scoped labels + the frozen PTY-root PID,
   * so one unrelated unhealthy ZMX socket cannot freeze every session. */
  private verifyBackingIdentityWithClients(context: string): BackingIdentityProbe {
    if (!this.lastOpts || !this.opts.sessionId || this.backingPid == null) {
      return { state: 'unknown', reason: `ZMX ${context} 缺少已冻结的会话身份` };
    }
    const probe = ZmxBackend.probeManagedSession(
      this.sessionName,
      this.opts.sessionId,
      zmxControlEnv(this.lastOpts),
    );
    if (probe.state === 'missing') {
      this.fireExit(0, null);
      return probe;
    }
    if (probe.state === 'unknown') return probe;
    if (probe.state === 'incompatible' || probe.pid !== this.backingPid) {
      const reason = probe.state === 'incompatible'
        ? '完整 session / transport 标签已变化'
        : `PTY root PID 已从 ${this.backingPid} 变化为 ${probe.pid}`;
      return this.rejectBackingReplacement(context, reason);
    }
    return { state: 'compatible', clients: probe.clients };
  }

  /** Fast generation check for high-frequency read-only snapshots. */
  private verifyBackingGeneration(context: string): BackingIdentityProbe {
    return this.verifyBackingIdentity(context);
  }

  private isBackingProcessAlive(): boolean {
    if (this.backingPid == null) return false;
    try {
      process.kill(this.backingPid, 0);
      return true;
    } catch (err) {
      return !!err && typeof err === 'object' && 'code' in err && err.code === 'EPERM';
    }
  }

  private rejectBackingReplacement(context: string, reason: string): BackingIdentityProbe {
    this.preserveSessionOnDestroy = true;
    logger.error(`[zmx:${this.sessionName}] ${context} refused: ${reason}`);
    this.fireExit(75, null);
    return { state: 'replaced', reason };
  }

  private labelsMatchBacking(raw: string): boolean {
    const labels = new Map<string, string>();
    for (const pair of raw.trim().split(/\s+/)) {
      if (!pair) continue;
      const equals = pair.indexOf('=');
      if (equals <= 0) continue;
      labels.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    return labels.get(ZMX_TRANSPORT_LABEL) === ZMX_TRANSPORT
      && labels.get(ZMX_SESSION_LABEL) === this.opts.sessionId;
  }

  private readLabelsAsync(generation: number): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.lastOpts || generation !== this.historyGeneration) {
        reject(new Error('history capture generation changed'));
        return;
      }
      const child = execFile('zmx', ['get', this.sessionName], {
        encoding: 'utf8',
        timeout: ZMX_HISTORY_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        env: zmxControlEnv(this.lastOpts),
      }, (err, stdout, stderr) => {
        if (this.historyProcess === child) this.historyProcess = null;
        if (generation !== this.historyGeneration) {
          reject(new Error('history capture generation changed'));
          return;
        }
        const errorText = stderr?.toString().trim() ?? '';
        if (err || errorText) {
          reject(err ?? new Error(errorText));
          return;
        }
        resolve(stdout.toString());
      });
      this.historyProcess = child;
    });
  }

  private captureHistoryFileAsync(generation: number): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.lastOpts || generation !== this.historyGeneration) {
        reject(new Error('history capture generation changed'));
        return;
      }
      let historyDir: string | undefined;
      let historyPath: string | undefined;
      let historyFd: number | undefined;
      let child: ChildProcess | null = null;
      let timeout: NodeJS.Timeout | null = null;
      let settled = false;
      let stderrTail = '';

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        timeout = null;
        if (this.historyProcess === child) this.historyProcess = null;
        if (historyFd !== undefined) {
          try { closeSync(historyFd); } catch { /* best effort */ }
        }
        if (historyPath) {
          try { rmSync(historyPath, { force: true }); } catch { /* best effort */ }
        }
        if (historyDir) {
          try { rmdirSync(historyDir); } catch { /* best effort */ }
        }
      };
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        try {
          if (err) throw err;
          if (generation !== this.historyGeneration || historyFd === undefined) {
            throw new Error('history capture generation changed');
          }
          const size = fstatSync(historyFd).size;
          const length = Math.min(size, ZMX_HISTORY_MAX_BYTES);
          const data = Buffer.allocUnsafe(length);
          let bytesRead = 0;
          while (bytesRead < length) {
            const count = readSync(
              historyFd,
              data,
              bytesRead,
              length - bytesRead,
              size - length + bytesRead,
            );
            if (count === 0) break;
            bytesRead += count;
          }
          let bounded = data.subarray(0, bytesRead);
          if (size > length) {
            const firstLf = bounded.indexOf(0x0a);
            if (firstLf >= 0) bounded = bounded.subarray(firstLf + 1);
          }
          resolve(normaliseZmxHistory(bounded.toString('utf8')));
        } catch (error) {
          reject(error);
        } finally {
          cleanup();
        }
      };

      try {
        historyDir = mkdtempSync(join(tmpdir(), 'botmux-zmx-history-'));
        chmodSync(historyDir, 0o700);
        historyPath = join(historyDir, 'history.txt');
        historyFd = openSync(historyPath, 'wx+', 0o600);
        // Keep transcript bytes reachable only through the open fd. A private
        // regular file also avoids PR #202's single-write pipe truncation.
        rmSync(historyPath);
        child = spawn('zmx', ['history', this.sessionName], {
          stdio: ['ignore', historyFd, 'pipe'],
          env: zmxControlEnv(this.lastOpts),
        });
        this.historyProcess = child;
        child.stderr?.on('data', (chunk: Buffer | string) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-4096);
        });
        child.once('error', error => finish(error));
        child.once('close', (code, signal) => {
          const stderr = stderrTail.trim();
          if (code !== 0 || signal || stderr) {
            finish(new Error(stderr || `zmx history exited status=${code} signal=${signal}`));
            return;
          }
          finish();
        });
        timeout = setTimeout(() => {
          try { child?.kill('SIGKILL'); } catch { /* already gone */ }
          finish(new Error(`zmx history timed out after ${ZMX_HISTORY_TIMEOUT_MS}ms`));
        }, ZMX_HISTORY_TIMEOUT_MS);
        timeout.unref?.();
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async readHistorySnapshotAsync(generation: number): Promise<string | null> {
    if (this.exited || this.intentionalExit || !this.lastOpts) return null;
    try {
      if (!this.isBackingProcessAlive()) {
        this.fireExit(0, null);
        return null;
      }
      const before = await this.readLabelsAsync(generation);
      if (!this.labelsMatchBacking(before)) {
        this.rejectBackingReplacement('history', '完整 session / transport 标签已变化');
        return null;
      }
      const snapshot = await this.captureHistoryFileAsync(generation);
      const after = await this.readLabelsAsync(generation);
      if (!this.labelsMatchBacking(after) || !this.isBackingProcessAlive()) {
        if (!this.isBackingProcessAlive()) this.fireExit(0, null);
        else this.rejectBackingReplacement('history completion', '完整 session / transport 标签已变化');
        return null;
      }
      return snapshot;
    } catch (err) {
      if (generation !== this.historyGeneration || this.intentionalExit || this.exited) return null;
      logger.warn(
        `[zmx:${this.sessionName}] history capture failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      if (!this.isBackingProcessAlive()) this.fireExit(0, null);
      return null;
    }
  }

  private requestHistoryCapture(
    delayMs: number,
    activity = false,
    forceResync = false,
  ): void {
    if (this.exited || this.intentionalExit || !this.lastOpts) return;
    if (activity) {
      this.tailActivitySinceCapture = true;
      this.stableHistoryPolls = 0;
    }
    if (forceResync) this.forceResyncOnNextSnapshot = true;
    if (this.historyInFlight) {
      this.historyAgain = true;
      this.historyAgainActivity ||= activity;
      this.historyAgainForceResync ||= forceResync;
      return;
    }
    const dueAt = Date.now() + Math.max(0, delayMs);
    if (this.historyTimer && this.historyTimerDueAt <= dueAt) return;
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimerDueAt = dueAt;
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      this.historyTimerDueAt = 0;
      void this.runHistoryCapture();
    }, Math.max(0, delayMs));
    this.historyTimer.unref?.();
  }

  private async runHistoryCapture(): Promise<void> {
    if (this.historyInFlight || this.exited || this.intentionalExit || !this.lastOpts) return;
    this.historyInFlight = true;
    const captureSerial = ++this.historyCaptureSerial;
    const generation = this.historyGeneration;
    const activity = this.tailActivitySinceCapture;
    const forceResync = this.forceResyncOnNextSnapshot;
    this.tailActivitySinceCapture = false;
    this.forceResyncOnNextSnapshot = false;
    let snapshot: string | null = null;
    let captureUsable = false;
    try {
      snapshot = await this.readHistorySnapshotAsync(generation);
      if (snapshot !== null && generation === this.historyGeneration) {
        captureUsable = this.publishHistorySnapshot(snapshot, activity, forceResync);
      } else {
        this.stableHistoryPolls = 0;
      }
      if (!captureUsable) {
        // A failed/ambiguous capture must not consume the wakeup that caused
        // it. Preserve both obligations for the next usable history sample.
        this.tailActivitySinceCapture ||= activity;
        this.forceResyncOnNextSnapshot ||= forceResync;
      }
    } finally {
      if (generation !== this.historyGeneration) return;
      const again = this.historyAgain;
      const againActivity = this.historyAgainActivity;
      const againForceResync = this.historyAgainForceResync;
      this.historyAgain = false;
      this.historyAgainActivity = false;
      this.historyAgainForceResync = false;
      // A capture dirtied while in flight predates output that arrived after
      // it started. Settle waiters must remain pending for the latched follow-
      // up rather than finalizing from this stale-but-otherwise-usable sample.
      if (!again) this.resolveHistorySettleWaiters(captureSerial, captureUsable);
      this.historyInFlight = false;
      if (this.exited || this.intentionalExit || !this.lastOpts) return;
      if (again) {
        // Preserve the dirty-latch obligation, but give the single-threaded
        // daemon a short breathing window before serializing history again.
        // Continuous tail chunks otherwise turn a long transcript into a
        // back-to-back history loop that can starve concurrent `send` probes.
        this.requestHistoryCapture(
          HISTORY_TAIL_DEBOUNCE_MS,
          againActivity,
          againForceResync,
        );
        return;
      }
      const nextDelay = this.stableHistoryPolls >= HISTORY_STABLE_POLLS_BEFORE_COLD
        ? HISTORY_COLD_POLL_MS + this.historyColdJitterMs
        : HISTORY_HOT_POLL_MS;
      this.requestHistoryCapture(nextDelay);
    }
  }

  private publishHistorySnapshot(snapshot: string, activity: boolean, forceResync: boolean): boolean {
    // Current ZMX history failures can exit 0 with empty stdout. Never let an
    // ambiguous empty capture erase a previously non-empty authoritative view.
    if (snapshot.length === 0 && this.hasSnapshot && this.snapshotCache.length > 0) {
      this.stableHistoryPolls = 0;
      return false;
    }
    if (!this.hasSnapshot) {
      this.hasSnapshot = true;
      this.snapshotCache = snapshot;
      this.stableHistoryPolls = snapshot.length === 0 ? 1 : 0;
      if (forceResync) this.emitScreenResync(snapshot);
      else if (snapshot) this.emitData(snapshot);
      return true;
    }

    const previous = this.snapshotCache;
    if (snapshot === previous) {
      this.stableHistoryPolls += 1;
      // Tail can signal a cursor-only redraw that leaves plain history equal.
      // Rebase derived state so idle detection observes the activity without
      // trusting any (possibly UTF-8-corrupted) tail payload bytes.
      if (activity) this.emitScreenResync(snapshot);
      return true;
    }

    this.snapshotCache = snapshot;
    this.stableHistoryPolls = 0;
    if (!forceResync && snapshot.startsWith(previous)) {
      const delta = snapshot.slice(previous.length);
      if (delta) this.emitData(delta);
      return true;
    }
    this.emitScreenResync(snapshot);
    return true;
  }

  private stopHistoryPolling(): void {
    this.historyGeneration += 1;
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    this.historyTimerDueAt = 0;
    const child = this.historyProcess;
    this.historyProcess = null;
    try { child?.kill('SIGKILL'); } catch { /* already gone */ }
    this.historyInFlight = false;
    this.historyAgain = false;
    this.historyAgainActivity = false;
    this.historyAgainForceResync = false;
    this.tailActivitySinceCapture = false;
    this.forceResyncOnNextSnapshot = false;
    for (const waiter of this.historySettleWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
  }

  private resolveHistorySettleWaiters(captureSerial: number, success: boolean): void {
    for (let i = this.historySettleWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.historySettleWaiters[i]!;
      if (waiter.targetSerial > captureSerial) continue;
      this.historySettleWaiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(success);
    }
  }

  private emitScreenResync(snapshot: string): void {
    if (this.screenResyncCbs.length === 0) {
      this.pendingScreenResyncReplay = true;
      return;
    }
    for (const cb of this.screenResyncCbs) {
      try { cb(snapshot); } catch { /* listener failure must not kill recovery */ }
    }
  }

  private sendBytes(bytes: Buffer, bracketedPaste = false): boolean {
    if (bytes.length === 0) return true;
    if (this.exited || this.intentionalExit || !this.lastOpts) return false;
    if (bytes.length > ZMX_SEND_MAX_BYTES) {
      throw new Error(
        `ZMX 单次输入 ${bytes.length} 字节超过 ${ZMX_SEND_MAX_BYTES} 字节安全上限；` +
        '当前 send 协议没有 ACK/backpressure，已在写入任何前缀前拒绝',
      );
    }
    const identity = this.verifyBackingIdentity('send');
    if (identity.state !== 'compatible') {
      if (identity.state === 'unknown') {
        logger.warn(`[zmx:${this.sessionName}] send blocked: ${identity.reason}`);
      }
      return false;
    }

    for (let offset = 0; offset < bytes.length; offset += ZMX_SEND_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + ZMX_SEND_CHUNK_BYTES, bytes.length));
      // ZMX strips exactly one trailing LF from piped stdin. Appending our own
      // framing LF therefore preserves the caller's original bytes exactly,
      // including an original trailing LF, while keeping secrets out of argv.
      const input = Buffer.concat([chunk, Buffer.from('\n')]);
      try {
        const stdout = execFileSync('zmx', ['send', this.sessionName], {
          input,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: ZMX_COMMAND_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          env: zmxControlEnv(this.lastOpts),
        });
        // Several ZMX control-plane failures are reported on stdout with exit
        // status 0. Empty stdout is part of the transport contract.
        if (stdout.trim()) {
          logger.warn(`[zmx:${this.sessionName}] send rejected: ${stdout.trim()}`);
          this.verifyBackingIdentity('send rejection');
          if (bracketedPaste || offset > 0) this.abortPartialSend(bracketedPaste);
          return false;
        }
      } catch (err) {
        const probe = this.verifyBackingIdentity('send failure');
        logger.warn(
          `[zmx:${this.sessionName}] send failed (${probe.state}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        // Never retry an ambiguous send: ZMX has no PTY-level ACK, so retrying
        // can duplicate a prompt that the daemon already queued.
        if (bracketedPaste || offset > 0) this.abortPartialSend(bracketedPaste);
        return false;
      }
    }
    this.requestHistoryCapture(HISTORY_TAIL_DEBOUNCE_MS, true);
    return true;
  }

  private abortPartialSend(bracketedPaste: boolean): void {
    if (!this.lastOpts) return;
    // A failed multi-frame paste may have delivered the opening marker but not
    // its close. Best-effort close it first, then cancel the partial composer
    // so a later retry cannot append to/trivially submit truncated input.
    const recovery = bracketedPaste ? '\x1b[201~\x03' : '\x03';
    try {
      const stdout = execFileSync('zmx', ['send', this.sessionName], {
        input: Buffer.concat([Buffer.from(recovery), Buffer.from('\n')]),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: ZMX_COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: zmxControlEnv(this.lastOpts),
      });
      if (stdout.trim()) throw new Error(stdout.trim());
      logger.warn(`[zmx:${this.sessionName}] cancelled a partially delivered input sequence`);
    } catch (err) {
      logger.error(
        `[zmx:${this.sessionName}] unable to cancel partially delivered input; ` +
        `manual session recovery may be required: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.requestHistoryCapture(0, true, true);
  }

  private startTail(): void {
    this.clearReconnectTimer();
    const epoch = ++this.tailEpoch;
    const child = spawn('zmx', ['tail', this.sessionName], {
      cwd: this.lastOpts?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: this.lastOpts ? zmxControlEnv(this.lastOpts) : zmxEnv(),
    });
    this.tailProcess = child;
    this.state = 'observing';
    this.clearStableTailTimer();
    this.stableTailTimer = setTimeout(() => {
      this.stableTailTimer = null;
      if (epoch === this.tailEpoch && this.tailProcess === child && this.state === 'observing') {
        this.reconnectAttempt = 0;
      }
    }, 5000);
    this.stableTailTimer.unref?.();
    let settled = false;
    let stderrTail = '';

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (epoch !== this.tailEpoch || this.tailProcess !== child || this.intentionalExit || this.exited) return;
      // Drain the stream, but never expose its bytes. Upstream's ANSI stripper
      // currently deletes UTF-8 and can even consume following ASCII; only the
      // existence of a chunk is trustworthy enough to wake history capture.
      if ((typeof chunk === 'string' ? chunk.length : chunk.byteLength) > 0) {
        this.requestHistoryCapture(HISTORY_TAIL_DEBOUNCE_MS, true);
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096);
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null, err?: Error) => {
      if (settled) return;
      settled = true;
      if (epoch !== this.tailEpoch || this.tailProcess !== child || this.intentionalExit || this.exited) return;
      this.tailProcess = null;
      this.state = 'recovering';
      this.clearStableTailTimer();
      if (err || stderrTail.trim()) {
        logger.warn(
          `[zmx:${this.sessionName}] tail ended: ` +
          `${err?.message ?? stderrTail.trim()}`,
        );
      }
      this.scheduleTailRecovery(code, signal);
    };
    child.once('error', err => finish(null, null, err));
    child.once('close', (code, signal) => finish(code, signal));
  }

  private scheduleTailRecovery(code: number | null, signal: string | null): void {
    if (this.intentionalExit || this.exited || !this.lastOpts) return;
    const delay = Math.min(50 * (2 ** this.reconnectAttempt), TAIL_RECOVERY_DELAY_MAX_MS);
    this.reconnectAttempt += 1;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalExit || this.exited || !this.lastOpts) return;
      const probe = this.verifyBackingIdentityWithClients('tail recovery');
      if (probe.state === 'missing' || probe.state === 'replaced') return;
      if (probe.state === 'unknown') {
        this.scheduleTailRecovery(code, signal);
        return;
      }
      try {
        logger.warn(`[zmx:${this.sessionName}] tail observer exited while session lives; reconnecting`);
        const baselineClients = probe.clients ?? 0;
        this.startTail();
        if (!this.waitForTailClient(baselineClients)) {
          throw new Error('replacement tail did not become a connected client');
        }
        this.requestHistoryCapture(0, true, true);
      } catch (err) {
        if (this.intentionalExit || this.exited) return;
        this.stopTailForRecovery();
        logger.warn(
          `[zmx:${this.sessionName}] tail restart failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        this.scheduleTailRecovery(code, signal);
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private stopTailAfterLaunchFailure(): void {
    this.tailEpoch += 1;
    this.clearStableTailTimer();
    this.stopHistoryPolling();
    const tail = this.tailProcess;
    this.tailProcess = null;
    this.state = 'idle';
    try { tail?.kill('SIGTERM'); } catch { /* already gone */ }
  }

  private stopTailForRecovery(): void {
    this.tailEpoch += 1;
    this.clearStableTailTimer();
    const tail = this.tailProcess;
    this.tailProcess = null;
    this.state = 'recovering';
    try { tail?.kill('SIGTERM'); } catch { /* already gone */ }
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearStableTailTimer(): void {
    if (!this.stableTailTimer) return;
    clearTimeout(this.stableTailTimer);
    this.stableTailTimer = null;
  }

  private emitData(data: string): void {
    if (this.dataCbs.length === 0) {
      const next = this.earlyBuffer + data;
      if (next.length > EARLY_BUFFER_MAX && this.earlyBuffer.length <= EARLY_BUFFER_MAX) {
        logger.warn(`[zmx:${this.sessionName}] early output exceeded 1 MiB; keeping newest text`);
      }
      this.earlyBuffer = next.slice(-EARLY_BUFFER_MAX);
      return;
    }
    for (const cb of this.dataCbs) {
      try { cb(data); } catch { /* listener failure must not kill transport */ }
    }
  }

  private fireExit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    // Once the backing daemon is gone, history is no longer queryable. Never
    // fall back to tail payload bytes here: upstream may already have deleted
    // or corrupted their UTF-8 content.
    this.exited = true;
    this.state = 'exited';
    this.tailEpoch += 1;
    this.clearReconnectTimer();
    this.clearStableTailTimer();
    this.stopHistoryPolling();
    const tail = this.tailProcess;
    this.tailProcess = null;
    try { tail?.kill('SIGTERM'); } catch { /* already gone */ }
    this.pendingExit = { code, signal };
    if (this.exitCbs.length === 0) return;
    for (const cb of this.exitCbs) {
      try { cb(code, signal); } catch { /* listener failure must not block teardown */ }
    }
  }
}

export function buildFreshAttachArgs(sessionName: string, bootstrapPath: string): string[] {
  // An existing session ignores this command, which makes attach safer than
  // `zmx run` (run is an upsert that can inject into a foreign race winner).
  return ['attach', sessionName, '/bin/sh', bootstrapPath];
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Render the private bootstrap and payload used by a fresh session. */
export function buildZmxLaunchFiles(
  bin: string,
  args: string[],
  opts: SpawnOpts,
  payloadPath: string,
  readyPath: string,
  readyNonce: string,
  releasePath: string,
  releaseToken: string,
): { bootstrap: string; payload: string } {
  const shellSpec = resolveUserShell(process.env, opts.launchShell);
  const envAssignments = buildBotmuxEnvAssignments(opts.env, opts.injectEnv)
    .filter(assignment => !/^ZMX_(?:SESSION|SESSION_PREFIX)=/.test(assignment));
  const debugKeepShell = process.env.BOTMUX_DEBUG_KEEP_SHELL === '1';
  const wrapped = debugKeepShell
    ? buildDebugKeepShellScript(shellSpec.shell)
    : SHELL_WRAPPER_SCRIPT;
  const payloadArgv = [opts.cwd, ...envAssignments, bin, ...args];
  const payload = `set -- ${payloadArgv.map(shellSingleQuote).join(' ')}\n`;
  const userScript = [
    'payload=$1',
    'if [ ! -r "$payload" ]; then printf "[botmux] ZMX launch payload unavailable\\n" >&2; exit 126; fi',
    '. "$payload" || exit 126',
    'rm -f -- "$payload"',
    'unset payload ZMX_SESSION ZMX_SESSION_PREFIX',
    wrapped,
  ].join('\n');
  const shellCommand = [
    shellSingleQuote(shellSpec.shell),
    ...shellSpec.flags.map(shellSingleQuote),
    '-c', shellSingleQuote(userScript),
    '_', shellSingleQuote(payloadPath),
  ].join(' ');
  const launchDir = payloadPath.slice(0, payloadPath.lastIndexOf('/'));
  const cliPidPath = join(launchDir, 'cli-pid');
  const gateScript = [
    'payload_path=$1',
    'ready_path=$2',
    'release_path=$3',
    'cli_pid_path=$4',
    'ready_nonce=$5',
    'release_token=$6',
    'printf \'%s\\n\' "$$" > "$cli_pid_path" || exit 126',
    'printf \'%s\\n\' "$ready_nonce" > "$ready_path" || exit 126',
    'attempt=0',
    `while [ ! -r "$release_path" ] && [ "$attempt" -lt ${Math.ceil(FRESH_RELEASE_TIMEOUT_MS / 100)} ]; do`,
    '  sleep 0.1',
    '  attempt=$((attempt + 1))',
    'done',
    '[ -r "$release_path" ] || exit 75',
    'release_value=',
    'IFS= read -r release_value < "$release_path" || [ -n "$release_value" ]',
    '[ "$release_value" = "$release_token" ] || exit 75',
    'rm -f -- "$ready_path" "$release_path"',
    'unset ready_path release_path release_value attempt cli_pid_path ready_nonce release_token',
    'trap - 1 2 15',
    'exec </dev/tty || exit 126',
    `exec ${shellCommand}`,
  ].join('\n');
  const gateCommand = [
    '/bin/sh',
    '-c', shellSingleQuote(gateScript),
    '_',
    '"$payload_path"',
    '"$ready_path"',
    '"$release_path"',
    '"$cli_pid_path"',
    '"$ready_nonce"',
    '"$release_token"',
  ].join(' ');
  const bootstrap = [
    '#!/bin/sh',
    'umask 077',
    'self=$0',
    'rm -f -- "$self"',
    'unset self ZMX_SESSION ZMX_SESSION_PREFIX',
    `payload_path=${shellSingleQuote(payloadPath)}`,
    `ready_path=${shellSingleQuote(readyPath)}`,
    `release_path=${shellSingleQuote(releasePath)}`,
    `cli_pid_path=${shellSingleQuote(cliPidPath)}`,
    `ready_nonce=${shellSingleQuote(readyNonce)}`,
    `release_token=${shellSingleQuote(releaseToken)}`,
    `launch_dir=${shellSingleQuote(launchDir)}`,
    'cleanup_launch() {',
    '  rm -f -- "$ready_path" "$release_path" "$cli_pid_path" "$payload_path"',
    '  rmdir -- "$launch_dir" 2>/dev/null || true',
    '}',
    // Do not exec away the PTY-root bootstrap. ZMX destroys history together
    // with that root process, so retaining it for a short bounded grace after
    // the real CLI exits gives the authoritative history poller time to read
    // final output (including pure Unicode that tail cannot signal reliably).
    // A foreground gate child keeps the normal SIGINT disposition (POSIX async
    // jobs may inherit SIGINT ignored), while retaining one stable PID through
    // gate -> user shell -> env -> CLI exec. The parent validates and labels
    // that PID before atomically publishing release.
    'is_direct_child() {',
    '  for ps_bin in /usr/bin/ps /bin/ps; do',
    '    [ -x "$ps_bin" ] || continue',
    '    child_parent=$("$ps_bin" -o ppid= -p "$child_pid" 2>/dev/null) || continue',
    '    [ "$child_parent" -eq "$$" ] 2>/dev/null && return 0',
    '  done',
    '  return 1',
    '}',
    'forward_stop() {',
    '  trap - 1 15',
    '  child_pid=',
    '  IFS= read -r child_pid < "$cli_pid_path" 2>/dev/null || true',
    '  if [ -n "$child_pid" ] && is_direct_child; then',
    '    kill -HUP "$child_pid" 2>/dev/null || true',
    '    kill -HUP -- "-$child_pid" 2>/dev/null || true',
    '    sleep 0.15',
    '    if is_direct_child; then',
    '      kill -KILL "$child_pid" 2>/dev/null || true',
    '      kill -KILL -- "-$child_pid" 2>/dev/null || true',
    '    fi',
    '  fi',
    '  cleanup_launch',
    '  exit 75',
    '}',
    "trap 'forward_stop' 1 15",
    "trap ':' 2",
    gateCommand,
    'cli_status=$?',
    // Do not retain a dead PID during the grace period: an external HUP must
    // never target an unrelated process that reused the numeric pid.
    'rm -f -- "$cli_pid_path"',
    `while ! sleep ${ZMX_EXIT_HISTORY_GRACE_SECONDS}; do :; done`,
    'cleanup_launch',
    'trap - 1 2 15',
    'exit "$cli_status"',
    '',
  ].join('\n');
  return { bootstrap, payload };
}

function createZmxLaunchPayload(bin: string, args: string[], opts: SpawnOpts): ZmxLaunchPayload {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-zmx-launch-'));
  chmodSync(dir, 0o700);
  const bootstrapPath = join(dir, 'bootstrap.sh');
  const payloadPath = join(dir, 'payload.sh');
  const readyPath = join(dir, 'ready');
  const releasePath = join(dir, 'release');
  const releaseTempPath = join(dir, 'release.tmp');
  const cliPidPath = join(dir, 'cli-pid');
  const readyNonce = randomBytes(16).toString('hex');
  const releaseToken = randomBytes(16).toString('hex');
  const cleanup = () => {
    for (const path of [readyPath, releasePath, releaseTempPath, cliPidPath, payloadPath, bootstrapPath]) {
      try { rmSync(path, { force: true }); } catch { /* already consumed */ }
    }
    try { rmdirSync(dir); } catch { /* live bootstrap still owns the directory */ }
  };
  try {
    const files = buildZmxLaunchFiles(
      bin,
      args,
      opts,
      payloadPath,
      readyPath,
      readyNonce,
      releasePath,
      releaseToken,
    );
    writeFileSync(payloadPath, files.payload, { mode: 0o600, flag: 'wx' });
    writeFileSync(bootstrapPath, files.bootstrap, { mode: 0o600, flag: 'wx' });
    return {
      dir,
      bootstrapPath,
      readyPath,
      readyNonce,
      releasePath,
      releaseTempPath,
      cliPidPath,
      releaseToken,
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Strip every payload-delivered key from ZMX control subprocesses. */
export function zmxControlEnv(opts: SpawnOpts): NodeJS.ProcessEnv {
  const env = zmxEnv(opts.env);
  for (const assignment of buildBotmuxEnvAssignments(opts.env, opts.injectEnv)) {
    const equals = assignment.indexOf('=');
    if (equals > 0) delete env[assignment.slice(0, equals)];
  }
  if (opts.injectEnv) {
    for (const key of Object.keys(opts.injectEnv)) delete env[key];
  }
  return env;
}

export function parseZmxList(output: string): {
  sessions: string[];
  unhealthySessions: string[];
  malformedLines: string[];
} {
  const sessions: string[] = [];
  const unhealthySessions: string[] = [];
  const malformedLines: string[] = [];
  let sawRecord = false;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const looksLikeRecord = /^\s*name=[^\t]*\t(?:pid=\d+(?:\t|$)|err=)/.test(line);
    if (!looksLikeRecord) {
      // Full-list cmd= is verbatim and may contain literal newlines. Once a
      // record starts, continuation text is opaque even when it says name=.
      if (!sawRecord) malformedLines.push(line);
      continue;
    }
    sawRecord = true;
    const row = parseZmxListRow(line);
    if (!row) malformedLines.push(line);
    else if (row.state === 'unhealthy') unhealthySessions.push(row.name);
    else sessions.push(row.name);
  }
  return { sessions, unhealthySessions, malformedLines };
}

export function parseZmxShortList(output: string): {
  sessions: string[];
  malformedLines: string[];
} {
  const sessions: string[] = [];
  const malformedLines: string[] = [];
  const seen = new Set<string>();
  for (const raw of output.split('\n')) {
    const name = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!name) continue;
    if (/[\t\x00-\x1f\x7f]/.test(name) || seen.has(name)) {
      malformedLines.push(raw);
      continue;
    }
    seen.add(name);
    sessions.push(name);
  }
  return { sessions, malformedLines };
}

function parseZmxListRow(line: string): {
  name: string;
  state: 'healthy' | 'unhealthy';
  pid?: number;
  clients?: number;
  command?: string;
} | null {
  const fields = line.replace(/^\s*/, '').split('\t');
  const nameField = fields[0];
  const name = nameField?.startsWith('name=') ? nameField.slice('name='.length) : '';
  const status = fields[1];
  if (!name || /[\x00-\x1f\x7f]/.test(name) || !status) return null;
  const pid = status.match(/^pid=(\d+)$/)?.[1];
  if (pid) {
    const clients = fields.map(field => field.match(/^clients=(\d+)$/)?.[1]).find(Boolean);
    const command = fields.find(field => field.startsWith('cmd='))?.slice('cmd='.length);
    return {
      name,
      state: 'healthy',
      pid: Number(pid),
      clients: clients === undefined ? undefined : Number(clients),
      command,
    };
  }
  if (/^err=/.test(status)) return { name, state: 'unhealthy' };
  return null;
}

function sessionDetails(
  sessionName: string,
  env: NodeJS.ProcessEnv = zmxEnv(),
): ZmxSessionDetails | null {
  const probe = ZmxBackend.probeSessions(env);
  return probe.ok ? sessionDetailsFromSnapshot(probe, sessionName) : null;
}

function sessionDetailsFromSnapshot(
  probe: ZmxSessionProbeResult,
  sessionName: string,
): ZmxSessionDetails | null {
  if (!probe.sessions.includes(sessionName)) return null;
  const rows = probe.raw
    .split('\n')
    .map(parseZmxListRow)
    .filter((row): row is NonNullable<typeof row> =>
      row?.name === sessionName && row.state === 'healthy' && !!row.pid,
    );
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return {
    name: row.name,
    pid: row.pid!,
    clients: row.clients ?? null,
    command: row.command ?? null,
  };
}

export function findSessionPid(sessionName: string): number | null {
  return sessionDetails(sessionName)?.pid ?? null;
}

export function tmuxKeyToBytes(key: string): string {
  const named: Record<string, string> = {
    Enter: '\r',
    Tab: '\t',
    Escape: '\x1b',
    Esc: '\x1b',
    Space: ' ',
    BSpace: '\x7f',
    Backspace: '\x7f',
    Up: '\x1b[A',
    Down: '\x1b[B',
    Right: '\x1b[C',
    Left: '\x1b[D',
    Home: '\x1b[H',
    End: '\x1b[F',
    PageUp: '\x1b[5~',
    PPage: '\x1b[5~',
    PageDown: '\x1b[6~',
    NPage: '\x1b[6~',
    'M-Enter': '\x1b\r',
  };
  if (key in named) return named[key]!;

  const ctrl = key.match(/^C-([A-Za-z])$/);
  if (ctrl) return String.fromCharCode(ctrl[1]!.toLowerCase().charCodeAt(0) - 96);
  const meta = key.match(/^M-(.)$/);
  if (meta) return `\x1b${meta[1]}`;
  return key;
}
