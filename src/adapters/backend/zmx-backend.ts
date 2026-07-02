import * as pty from 'node-pty';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import xtermHeadless from '@xterm/headless';
import type { SessionBackend, SpawnOpts, SessionProbe } from './types.js';
import { zmxEnv, probeZmxFunctional } from '../../setup/ensure-zmx.js';
import {
  buildBotmuxEnvAssignments,
  buildDebugKeepShellScript,
  resolveUserShell,
  SHELL_WRAPPER_SCRIPT,
} from './tmux-backend.js';
import { logger } from '../../utils/logger.js';

const { Terminal } = xtermHeadless;

const EARLY_BUFFER_MAX = 1024 * 1024;
const RECOVERY_WRITE_BUFFER_MAX = 256 * 1024;
const RECOVERY_DELAY_MAX_MS = 2000;
const RECOVERY_WRITE_FLUSH_DELAY_MS = 150;
const FRESH_ATTACH_READY_TIMEOUT_MS = 5000;
const FRESH_ATTACH_READY_BUFFER_MAX = 1024 * 1024;
const FRESH_BOOTSTRAP_WATCHDOG_SECONDS = 8;
const STALE_BOOTSTRAP_POLL_MS = 100;
const STALE_BOOTSTRAP_WAIT_MAX_MS = (FRESH_BOOTSTRAP_WATCHDOG_SECONDS + 3) * 1000;
const REATTACH_BOOTSTRAP_SNIFF_MS = 300;
const ZMX_READY_MARKER_RE = /\x1b\]5150;botmux-zmx-ready=([0-9a-f]{32})\x1b\\/;
const ZMX_READY_MARKER_MAX = 96;
const LAUNCH_PAYLOAD_CLEANUP_MS = 5 * 60_000;
const TERMINAL_FG = '#a9b1d6';
const TERMINAL_BG = '#1a1b26';
const TERMINAL_CURSOR = '#c0caf5';
const TERMINAL_ANSI = [
  '#15161e', '#f7768e', '#9ece6a', '#e0af68',
  '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
  '#414868', '#f7768e', '#9ece6a', '#e0af68',
  '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5',
] as const;

type AttachMode = 'fresh' | 'reattach';
type BackendState = 'idle' | 'connecting' | 'attached' | 'recovering' | 'stopped' | 'exited';

interface ZmxSessionProbeResult {
  ok: true;
  sessions: string[];
  unhealthySessions: string[];
  raw: string;
}

interface ZmxLaunchPayload {
  bootstrapPath: string;
  readyMarker: string;
  completionMarker: string;
  releaseToken: string;
  cleanup: () => void;
}

/**
 * Persistent backend driven by one real `zmx attach` client inside node-pty.
 *
 * The attach client is the ordered, bidirectional transport: it preserves raw
 * terminal bytes, gives the backing PTY its real dimensions, and replays ZMX's
 * terminal snapshot on reconnect. Killing the client only detaches; explicit
 * session teardown uses `zmx kill --force`.
 */
export class ZmxBackend implements SessionBackend {
  private process: pty.IPty | null = null;
  private readonly dataCbs: Array<(data: string) => void> = [];
  private readonly exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  private reattaching: boolean;
  private intentionalExit = false;
  private exited = false;
  private state: BackendState = 'idle';
  private epoch = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stableAttachTimer: NodeJS.Timeout | null = null;
  private freshAttachReadyTimer: NodeJS.Timeout | null = null;
  private recoveryWriteFlushTimer: NodeJS.Timeout | null = null;
  private recoveryWriteProbeAttempt = 0;
  private queryTerminal: InstanceType<typeof Terminal> | null = null;
  /** Quarantine may be observing a same-name session owned by another checkout. */
  private preserveSessionOnDestroy = false;
  private pendingExit: { code: number | null; signal: string | null } | null = null;
  private earlyBuffer = '';
  private recoveryWriteBuffer = '';
  private lastOpts: SpawnOpts | null = null;
  private cols = 200;
  private rows = 50;

  claudeJsonlPath?: string;
  cliPid?: number;
  cliCwd?: string;

  constructor(
    private readonly sessionName: string,
    private readonly opts: { ownsSession?: boolean; isReattach?: boolean } = {},
  ) {
    this.reattaching = opts.isReattach ?? false;
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
  static probeSessions(): ZmxSessionProbeResult | { ok: false } {
    try {
      const shortOut = execFileSync('zmx', ['list', '--short'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        env: zmxEnv(),
      });
      const out = execFileSync('zmx', ['list'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        env: zmxEnv(),
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

  static hasSession(name: string): boolean {
    return ZmxBackend.probeSession(name) === 'exists';
  }

  static probeSession(name: string): SessionProbe {
    const probe = ZmxBackend.probeSessions();
    if (!probe.ok) return 'unknown';
    if (probe.sessions.includes(name)) return 'exists';
    if (probe.unhealthySessions.includes(name)) return 'unknown';
    return 'missing';
  }

  /**
   * ZMX has one daemon per session, not one shared server. This value therefore
   * describes botmux-owned sessions only and must not be used to infer whether
   * another missing ZMX session is a zombie.
   */
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
        timeout: 5000,
        env: zmxEnv(),
      });
    } catch { /* already gone */ }
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
    this.lastOpts = {
      ...opts,
      env: { ...opts.env },
      injectEnv: opts.injectEnv ? { ...opts.injectEnv } : undefined,
    };
    this.cols = opts.cols;
    this.rows = opts.rows;

    const probe = ZmxBackend.probeSession(this.sessionName);
    if (probe === 'unknown') {
      throw new Error(`无法确认 ZMX 会话 ${this.sessionName} 的状态`);
    }

    // An explicit reattach decision is sticky. If the session disappears in
    // the probe-to-attach race, the sentinel command exits instead of silently
    // creating a duplicate CLI with a fresh shell.
    this.reattaching = this.reattaching || probe === 'exists';
    const mode: AttachMode = this.reattaching ? 'reattach' : 'fresh';
    logger.debug(
      `[zmx:${this.sessionName}] spawn ${mode} ` +
      `bin=${bin} args=${JSON.stringify(args)} cwd=${opts.cwd} ${opts.cols}x${opts.rows}`,
    );
    this.openAttach(mode, bin, args, opts);
  }

  write(data: string): void {
    if (!data || this.exited || this.intentionalExit) return;
    // Once input has been queued during a reconnect, keep all subsequent input
    // behind it until the target is authoritatively live. Letting new bytes go
    // direct while the older buffer awaits its probe would reverse FIFO order.
    if (
      this.process &&
      this.state === 'attached' &&
      !this.recoveryWriteBuffer &&
      !this.recoveryWriteFlushTimer
    ) {
      this.process.write(data);
      return;
    }
    const next = this.recoveryWriteBuffer + data;
    if (next.length > RECOVERY_WRITE_BUFFER_MAX) {
      logger.warn(`[zmx:${this.sessionName}] recovery input buffer full; dropping oldest bytes`);
    }
    this.recoveryWriteBuffer = next.slice(-RECOVERY_WRITE_BUFFER_MAX);
    if (this.process && this.state === 'attached') {
      this.scheduleRecoveryWriteFlush(this.epoch, this.process);
    }
  }

  sendText(text: string): void {
    this.write(text);
  }

  sendSpecialKeys(...keys: string[]): void {
    for (const key of keys) this.write(tmuxKeyToBytes(key));
  }

  pasteText(text: string): void {
    this.write(`\x1b[200~${text}\x1b[201~`);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    try { this.process?.resize(cols, rows); } catch { /* client may be reconnecting */ }
    try { this.queryTerminal?.resize(cols, rows); } catch { /* responder may be rotating */ }
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
    if (this.earlyBuffer) {
      const buffered = this.earlyBuffer;
      this.earlyBuffer = '';
      try { cb(buffered); } catch { /* listener failure must not kill transport */ }
    }
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCbs.push(cb);
    if (this.pendingExit) {
      const exit = this.pendingExit;
      this.pendingExit = null;
      cb(exit.code, exit.signal);
    }
  }

  getChildPid(): number | null {
    if (this.cliPid) return this.cliPid;
    const pid = findSessionPid(this.sessionName);
    if (pid) this.cliPid = pid;
    return pid;
  }

  /** Detach the viewer while leaving the per-session ZMX daemon and CLI alive. */
  kill(): void {
    if (this.state === 'stopped' || this.state === 'exited') return;
    this.intentionalExit = true;
    this.state = 'stopped';
    this.epoch++;
    this.clearReconnectTimer();
    this.clearStableAttachTimer();
    this.clearFreshAttachReadyTimer();
    this.clearRecoveryWriteFlushTimer();
    this.clearTerminalResponder();
    this.recoveryWriteBuffer = '';
    this.recoveryWriteProbeAttempt = 0;
    const process = this.process;
    this.process = null;
    try { process?.kill(); } catch { /* already gone */ }
  }

  destroySession(): void {
    this.kill();
    if ((this.opts.ownsSession ?? true) && !this.preserveSessionOnDestroy) {
      ZmxBackend.killSession(this.sessionName);
    }
  }

  private openAttach(mode: AttachMode, bin: string, args: string[], opts: SpawnOpts): void {
    this.clearReconnectTimer();
    this.clearStableAttachTimer();
    this.clearFreshAttachReadyTimer();
    this.clearRecoveryWriteFlushTimer();
    const epoch = ++this.epoch;
    let launchPayload: ZmxLaunchPayload | null = null;
    const zmxArgs = mode === 'fresh'
      ? (() => {
          launchPayload = createZmxLaunchPayload(bin, args, opts);
          return buildFreshAttachArgs(this.sessionName, launchPayload.bootstrapPath);
        })()
      : buildReattachArgs(this.sessionName);

    let process: pty.IPty;
    try {
      process = pty.spawn('zmx', zmxArgs, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: opts.cwd,
        // Per-session and per-bot values are delivered through the 0600 launch
        // payload. Keep them out of the long-lived ZMX daemon environment.
        env: zmxControlEnv(opts),
      });
    } catch (err) {
      launchPayload?.cleanup();
      throw err;
    }
    if (launchPayload) {
      const payload = launchPayload as ZmxLaunchPayload;
      const cleanupTimer = setTimeout(payload.cleanup, LAUNCH_PAYLOAD_CLEANUP_MS);
      cleanupTimer.unref?.();
    }
    this.process = process;
    this.state = 'connecting';
    this.recoveryWriteProbeAttempt = 0;
    this.resetTerminalResponder(process, epoch);

    let freshReadyMarker = launchPayload?.readyMarker ?? null;
    let freshCompletionMarker = launchPayload?.completionMarker ?? null;
    let freshReleaseSent = false;
    let freshReadyBuffer = '';
    let reattachSniffing = mode === 'reattach';
    let reattachSniffBuffer = '';
    let reattachMarkerTail = '';

    const acceptAttachedData = (attachedData: string) => {
      if (epoch !== this.epoch || this.process !== process || this.intentionalExit || this.exited) return;
      this.state = 'attached';
      if (!this.stableAttachTimer) {
        this.stableAttachTimer = setTimeout(() => {
          this.stableAttachTimer = null;
          if (epoch === this.epoch && this.state === 'attached') this.reconnectAttempt = 0;
        }, 5000);
        this.stableAttachTimer.unref?.();
      }
      // Keep one authoritative headless terminal beside the attach transport.
      // It tracks cursor state and answers terminal queries even with no browser
      // connected. ZMX web terminals register no-reply parser handlers so they
      // render these zero-width queries without becoming a second responder.
      if (attachedData) {
        this.queryTerminal?.write(attachedData);
        this.emitData(attachedData);
      }
      this.scheduleRecoveryWriteFlush(epoch, process);
    };

    const quarantineBootstrapAttach = (reason: string) => {
      if (
        epoch !== this.epoch ||
        this.process !== process ||
        this.intentionalExit ||
        this.exited
      ) return;
      freshReadyMarker = null;
      freshCompletionMarker = null;
      freshReadyBuffer = '';
      reattachSniffing = false;
      reattachSniffBuffer = '';
      reattachMarkerTail = '';
      this.clearFreshAttachReadyTimer();
      this.clearStableAttachTimer();
      this.clearRecoveryWriteFlushTimer();
      this.clearTerminalResponder();
      // Before the private release token has been sent it is safe to remove the
      // payload. cleanup() deliberately leaves the watchdog guard directory in
      // place, so the bootstrap still times out and terminates its ZMX session.
      if (!freshReleaseSent) launchPayload?.cleanup();
      logger.error(`[zmx:${this.sessionName}] quarantining unverified bootstrap attach: ${reason}`);
      this.preserveSessionOnDestroy = true;

      // Detach this viewer without killing the named session: the ready marker
      // may have come from a same-name session owned by another checkout. The
      // private bootstrap watchdog is solely responsible for deleting its own
      // payload and terminating its own session. Emit one exit only after that
      // session is authoritatively missing, so the daemon can restart the worker
      // and recompute fresh-vs-reattach from scratch. If it never disappears,
      // remain quarantined instead of auto-restarting into a foreign session.
      const quarantineEpoch = ++this.epoch;
      if (this.process === process) this.process = null;
      this.state = 'recovering';
      try { process.kill(); } catch { /* already detached */ }

      const deadline = Date.now() + STALE_BOOTSTRAP_WAIT_MAX_MS;
      let overdueWarningEmitted = false;
      const poll = () => {
        this.reconnectTimer = null;
        if (
          quarantineEpoch !== this.epoch ||
          this.intentionalExit ||
          this.exited
        ) return;
        const probe = ZmxBackend.probeSession(this.sessionName);
        if (probe === 'missing') {
          this.fireExit(75, null);
          return;
        }
        if (Date.now() >= deadline && !overdueWarningEmitted) {
          overdueWarningEmitted = true;
          logger.error(
            `[zmx:${this.sessionName}] quarantined bootstrap did not disappear ` +
            `(${probe}); continuing to refuse attach/input until ownership is safe`,
          );
          launchPayload?.cleanup();
        }
        this.reconnectTimer = setTimeout(
          poll,
          overdueWarningEmitted ? RECOVERY_DELAY_MAX_MS : STALE_BOOTSTRAP_POLL_MS,
        );
        this.reconnectTimer.unref?.();
      };
      this.reconnectTimer = setTimeout(poll, STALE_BOOTSTRAP_POLL_MS);
      this.reconnectTimer.unref?.();
    };

    const failFreshAttach = (reason: string) => {
      quarantineBootstrapAttach(`fresh ownership check failed: ${reason}`);
    };

    const armFreshAttachReadyTimer = (reason: string) => {
      this.clearFreshAttachReadyTimer();
      this.freshAttachReadyTimer = setTimeout(() => {
        failFreshAttach(reason);
      }, FRESH_ATTACH_READY_TIMEOUT_MS);
      this.freshAttachReadyTimer.unref?.();
    };
    if (freshReadyMarker) {
      armFreshAttachReadyTimer('bootstrap ready marker timed out');
    } else if (reattachSniffing) {
      // A worker can die after creating the private bootstrap but before sending
      // its nonce-bound release token. The surviving ZMX child then repeats a
      // ready OSC until its watchdog fires. Briefly quarantine every reattach so
      // that marker can be recognized across chunk boundaries before any output
      // is exposed or any queued user input is flushed.
      this.freshAttachReadyTimer = setTimeout(() => {
        this.freshAttachReadyTimer = null;
        if (
          epoch !== this.epoch ||
          this.process !== process ||
          this.intentionalExit ||
          this.exited ||
          !reattachSniffing
        ) return;
        reattachSniffing = false;
        const buffered = reattachSniffBuffer;
        reattachSniffBuffer = '';
        acceptAttachedData(buffered);
      }, REATTACH_BOOTSTRAP_SNIFF_MS);
      this.freshAttachReadyTimer.unref?.();
    }

    process.onData((data) => {
      if (epoch !== this.epoch || this.intentionalExit || this.exited) return;

      // Keep scanning after the initial quarantine too. The bootstrap emits at
      // 50 ms intervals, but an overloaded host can delay delivery beyond the
      // sniff window. Its independent release token means ordinary input still
      // cannot launch the CLI; a late marker is quarantined before this chunk is
      // forwarded and the watchdog is allowed to reap the stale session.
      const markerScan = reattachMarkerTail + data;
      if (mode === 'reattach' && ZMX_READY_MARKER_RE.test(markerScan)) {
        quarantineBootstrapAttach('stale private bootstrap marker detected during reattach');
        return;
      }
      reattachMarkerTail = markerScan.slice(-ZMX_READY_MARKER_MAX);
      if (reattachSniffing) {
        reattachSniffBuffer += data;
        if (reattachSniffBuffer.length > FRESH_ATTACH_READY_BUFFER_MAX) {
          quarantineBootstrapAttach('reattach bootstrap sniff buffer exceeded limit');
        }
        return;
      }

      let attachedData = data;
      if (freshReadyMarker && freshCompletionMarker) {
        freshReadyBuffer += data;
        if (freshReadyBuffer.length > FRESH_ATTACH_READY_BUFFER_MAX) {
          failFreshAttach('bootstrap ready buffer exceeded limit');
          return;
        }

        if (!freshReleaseSent) {
          if (!freshReadyBuffer.includes(freshReadyMarker)) return;
          freshReleaseSent = true;
          // Only our private bootstrap can emit the nonce. Releasing its read
          // barrier here proves this PTY created the session instead of attaching
          // to a same-name session that appeared after the liveness probe.
          try {
            process.write(`${launchPayload!.releaseToken}\r`);
          } catch {
            failFreshAttach('could not release bootstrap barrier');
            return;
          }
          // The bootstrap repeats its ready marker because output produced
          // before the first ZMX client connects is not replayed. Wait for its
          // post-release completion marker so no late repeat can leak through.
          armFreshAttachReadyTimer('bootstrap completion marker timed out');
        }

        const completionIndex = freshReadyBuffer.indexOf(freshCompletionMarker);
        if (completionIndex < 0) return;
        attachedData =
          freshReadyBuffer.slice(0, completionIndex) +
          freshReadyBuffer.slice(completionIndex + freshCompletionMarker.length);
        attachedData = attachedData.split(freshReadyMarker).join('');
        freshReadyMarker = null;
        freshCompletionMarker = null;
        freshReadyBuffer = '';
        this.clearFreshAttachReadyTimer();
      }
      acceptAttachedData(attachedData);
    });
    process.onExit(({ exitCode, signal }) => {
      if (epoch !== this.epoch || this.intentionalExit || this.exited) return;
      const freshAttachWasUnverified = freshCompletionMarker !== null;
      freshReadyMarker = null;
      freshCompletionMarker = null;
      freshReadyBuffer = '';
      this.clearFreshAttachReadyTimer();
      this.clearStableAttachTimer();
      this.clearRecoveryWriteFlushTimer();
      this.clearTerminalResponder();
      if (this.process === process) this.process = null;
      if (freshAttachWasUnverified) {
        launchPayload?.cleanup();
        // An unverified fresh attach may have hit a foreign same-name session.
        // Never reconnect to it; surface a deterministic launch failure.
        this.fireExit(exitCode === 0 ? 75 : exitCode, null);
        return;
      }
      this.state = 'recovering';
      this.scheduleRecovery(
        exitCode,
        signal !== undefined && signal !== null && signal !== 0 ? String(signal) : null,
      );
    });

  }

  private scheduleRecovery(code: number | null, signal: string | null): void {
    if (this.intentionalExit || this.exited || !this.lastOpts) return;
    const delay = Math.min(50 * (2 ** this.reconnectAttempt), RECOVERY_DELAY_MAX_MS);
    this.reconnectAttempt++;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalExit || this.exited || !this.lastOpts) return;

      const probe = ZmxBackend.probeSession(this.sessionName);
      if (probe === 'missing') {
        this.fireExit(code, signal);
        return;
      }
      if (probe === 'unknown') {
        this.scheduleRecovery(code, signal);
        return;
      }

      logger.warn(`[zmx:${this.sessionName}] attach client exited while session is alive; reconnecting`);
      try {
        this.openAttach('reattach', '/bin/sh', [], this.lastOpts);
      } catch (err) {
        logger.warn(
          `[zmx:${this.sessionName}] attach reconnect failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        this.scheduleRecovery(code, signal);
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private scheduleRecoveryWriteFlush(epoch: number, process: pty.IPty): void {
    if (
      !this.recoveryWriteBuffer ||
      this.recoveryWriteFlushTimer ||
      epoch !== this.epoch ||
      this.process !== process ||
      this.state !== 'attached'
    ) return;

    // A reattach TOCTOU sentinel can emit a clear frame before its short-lived
    // session exits. Wait for a still-live target before releasing input. An
    // inconclusive control-plane probe re-arms with bounded backoff: a quiet
    // attach must not strand the buffer forever merely because its first probe
    // timed out.
    const delay = Math.min(
      RECOVERY_WRITE_FLUSH_DELAY_MS * (2 ** this.recoveryWriteProbeAttempt),
      RECOVERY_DELAY_MAX_MS,
    );
    this.recoveryWriteFlushTimer = setTimeout(() => {
      this.recoveryWriteFlushTimer = null;
      if (
        epoch !== this.epoch ||
        this.process !== process ||
        this.state !== 'attached' ||
        !this.recoveryWriteBuffer
      ) return;

      const probe = ZmxBackend.probeSession(this.sessionName);
      if (probe === 'unknown') {
        this.recoveryWriteProbeAttempt++;
        this.scheduleRecoveryWriteFlush(epoch, process);
        return;
      }
      if (probe === 'missing') return;

      this.recoveryWriteProbeAttempt = 0;
      const buffered = this.recoveryWriteBuffer;
      this.recoveryWriteBuffer = '';
      try {
        process.write(buffered);
      } catch {
        this.recoveryWriteBuffer = buffered + this.recoveryWriteBuffer;
        this.scheduleRecoveryWriteFlush(epoch, process);
      }
    }, delay);
    this.recoveryWriteFlushTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearStableAttachTimer(): void {
    if (!this.stableAttachTimer) return;
    clearTimeout(this.stableAttachTimer);
    this.stableAttachTimer = null;
  }

  private clearFreshAttachReadyTimer(): void {
    if (!this.freshAttachReadyTimer) return;
    clearTimeout(this.freshAttachReadyTimer);
    this.freshAttachReadyTimer = null;
  }

  private clearRecoveryWriteFlushTimer(): void {
    if (!this.recoveryWriteFlushTimer) return;
    clearTimeout(this.recoveryWriteFlushTimer);
    this.recoveryWriteFlushTimer = null;
  }

  private resetTerminalResponder(process: pty.IPty, epoch: number): void {
    this.clearTerminalResponder();
    const terminal = new Terminal({
      cols: this.cols,
      rows: this.rows,
      allowProposedApi: true,
    });
    const respond = (response: string) => {
      if (
        epoch !== this.epoch ||
        this.process !== process ||
        this.intentionalExit ||
        this.exited
      ) return;
      try { process.write(response); } catch { /* transport recovery handles it */ }
    };
    terminal.onData(respond);
    // Browser xterm has a ThemeService and answers OSC color queries; headless
    // xterm intentionally does not. Supply stable colors here so no-browser
    // sessions still work and ZMX browser tabs can safely suppress duplicates.
    for (const ident of [4, 10, 11, 12] as const) {
      terminal.parser.registerOscHandler(ident, (data) => {
        const replies = terminalOscColorQueryReplies(ident, data);
        if (replies.length === 0) return false;
        for (const reply of replies) respond(reply);
        return true;
      });
    }
    this.queryTerminal = terminal;
  }

  private clearTerminalResponder(): void {
    const terminal = this.queryTerminal;
    this.queryTerminal = null;
    try { terminal?.dispose(); } catch { /* already disposed */ }
  }

  private emitData(data: string): void {
    if (this.dataCbs.length === 0) {
      const next = this.earlyBuffer + data;
      if (next.length > EARLY_BUFFER_MAX && this.earlyBuffer.length <= EARLY_BUFFER_MAX) {
        logger.warn(`[zmx:${this.sessionName}] early output exceeded 1 MiB; keeping newest bytes`);
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
    this.exited = true;
    this.state = 'exited';
    this.clearReconnectTimer();
    this.clearStableAttachTimer();
    this.clearFreshAttachReadyTimer();
    this.clearRecoveryWriteFlushTimer();
    this.clearTerminalResponder();
    this.process = null;
    this.recoveryWriteBuffer = '';
    this.recoveryWriteProbeAttempt = 0;
    if (this.exitCbs.length === 0) {
      this.pendingExit = { code, signal };
      return;
    }
    for (const cb of this.exitCbs) {
      try { cb(code, signal); } catch { /* listener failure must not block teardown */ }
    }
  }
}

/**
 * The command is ignored when the named session exists. If it disappeared
 * after the liveness probe, the sentinel exits immediately instead of creating
 * an unrelated interactive shell.
 */
export function buildReattachArgs(sessionName: string): string[] {
  return ['attach', sessionName, '/bin/sh', '-c', 'exit 75'];
}

export function buildFreshAttachArgs(
  sessionName: string,
  bootstrapPath: string,
): string[] {
  // The ZMX daemon retains its original command for the whole session and
  // exposes it through `zmx list`. Keep cwd, env values and CLI argv (including
  // an initial user prompt) out of that retained command. The 0600 bootstrap
  // unlinks itself before starting the real shell.
  return ['attach', sessionName, '/bin/sh', bootstrapPath];
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render the two private files used for a fresh launch. The bootstrap contains
 * no user prompt or environment values; the payload is sourced only after the
 * user's rcfiles load, then immediately unlinked. Keeping `set --` in the file
 * also prevents arbitrary argv bytes from becoming shell syntax.
 */
export function buildZmxLaunchFiles(
  bin: string,
  args: string[],
  opts: SpawnOpts,
  payloadPath: string,
  readyMarker: string,
  completionMarker: string,
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
    'payload_dir=${payload%/*}',
    'rmdir -- "$payload_dir" 2>/dev/null || true',
    'unset payload payload_dir ZMX_SESSION ZMX_SESSION_PREFIX',
    wrapped,
  ].join('\n');
  const shellCommand = [
    shellSingleQuote(shellSpec.shell),
    ...shellSpec.flags.map(shellSingleQuote),
    '-c', shellSingleQuote(userScript),
    '_', shellSingleQuote(payloadPath),
  ].join(' ');
  const bootstrap = [
    '#!/bin/sh',
    'self=$0',
    'rm -f -- "$self"',
    'unset self ZMX_SESSION ZMX_SESSION_PREFIX',
    `payload_path=${shellSingleQuote(payloadPath)}`,
    'payload_dir=${payload_path%/*}',
    'watchdog_guard="$payload_dir/bootstrap-watchdog"',
    'mkdir -- "$watchdog_guard" || exit 126',
    'bootstrap_pid=$$',
    // The nonce distinguishes a newly executed private bootstrap from the
    // probe-to-attach race where ZMX ignores this command and attaches to an
    // existing same-name session. The daemon can start before its first client,
    // so repeat it until botmux releases the read barrier. Both markers are
    // stripped before terminal processing.
    '(',
    '  while :; do',
    `    printf '%s' ${shellSingleQuote(readyMarker)}`,
    '    sleep 0.05',
    '  done',
    ') &',
    'ready_marker_pid=$!',
    '(',
    `  sleep ${FRESH_BOOTSTRAP_WATCHDOG_SECONDS}`,
    '  if rmdir -- "$watchdog_guard" 2>/dev/null; then',
    '    kill "$ready_marker_pid" 2>/dev/null || true',
    '    wait "$ready_marker_pid" 2>/dev/null || true',
    '    rm -f -- "$payload_path"',
    '    rmdir -- "$payload_dir" 2>/dev/null || true',
    '    kill -TERM "$bootstrap_pid" 2>/dev/null || true',
    '  fi',
    ') &',
    'watchdog_pid=$!',
    'stop_ready_marker() {',
    '  kill "$ready_marker_pid" 2>/dev/null || true',
    '  wait "$ready_marker_pid" 2>/dev/null || true',
    '}',
    'stop_watchdog() {',
    '  kill "$watchdog_pid" 2>/dev/null || true',
    '  wait "$watchdog_pid" 2>/dev/null || true',
    '}',
    'cleanup_uncommitted_launch() {',
    '  stop_ready_marker',
    '  stop_watchdog',
    '  if [ "${launch_committed:-0}" != 1 ]; then',
    '    rmdir -- "$watchdog_guard" 2>/dev/null || true',
    '    rm -f -- "$payload_path"',
    '    rmdir -- "$payload_dir" 2>/dev/null || true',
    '  fi',
    '}',
    'launch_committed=0',
    "trap 'cleanup_uncommitted_launch' 0",
    "trap 'exit 75' 1 2 15",
    // The release capability is independent from the visible ready nonce and
    // exists only in this already-unlinked 0600 bootstrap plus worker memory.
    // A stale reattach's ordinary user input can therefore only abort the
    // bootstrap; it can never authorize launching a second CLI.
    'stty -echo 2>/dev/null || exit 126',
    `IFS= read -r release_line && [ "$release_line" = ${shellSingleQuote(releaseToken)} ] || exit 75`,
    'unset release_line',
    'rmdir -- "$watchdog_guard" 2>/dev/null || exit 75',
    'stop_watchdog',
    'stop_ready_marker',
    'stty echo 2>/dev/null || exit 126',
    'launch_committed=1',
    'trap - 0 1 2 15',
    'unset ready_marker_pid watchdog_pid watchdog_guard bootstrap_pid launch_committed',
    `printf '%s' ${shellSingleQuote(completionMarker)}`,
    `exec ${shellCommand}`,
    '',
  ].join('\n');
  return { bootstrap, payload };
}

function createZmxLaunchPayload(bin: string, args: string[], opts: SpawnOpts): ZmxLaunchPayload {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-zmx-launch-'));
  chmodSync(dir, 0o700);
  const bootstrapPath = join(dir, 'bootstrap.sh');
  const payloadPath = join(dir, 'payload.sh');
  const cleanup = () => {
    // Never recursively remove the directory: a running bootstrap's watchdog
    // uses its child guard directory as an atomic release-vs-timeout lock. It is
    // safe to remove the private files early, but deleting that guard would
    // strand the bootstrap (and its ZMX daemon) at the read barrier forever.
    try { rmSync(payloadPath, { force: true }); } catch { /* already consumed */ }
    try { rmSync(bootstrapPath, { force: true }); } catch { /* already unlinked */ }
    try { rmdirSync(dir); } catch { /* watchdog guard or active bootstrap remains */ }
  };
  try {
    const markerNonce = randomBytes(16).toString('hex');
    const releaseToken = randomBytes(16).toString('hex');
    // Use an otherwise inert private OSC sequence: ZMX forwards the raw bytes
    // to this client, while its terminal snapshot does not render the nonce or
    // retain it as visible scrollback for a later reattach.
    const readyMarker = `\x1b]5150;botmux-zmx-ready=${markerNonce}\x1b\\`;
    const completionMarker = `\x1b]5150;botmux-zmx-started=${markerNonce}\x1b\\`;
    const files = buildZmxLaunchFiles(
      bin,
      args,
      opts,
      payloadPath,
      readyMarker,
      completionMarker,
      releaseToken,
    );
    writeFileSync(payloadPath, files.payload, { mode: 0o600, flag: 'wx' });
    writeFileSync(bootstrapPath, files.bootstrap, { mode: 0o600, flag: 'wx' });
    return { bootstrapPath, readyMarker, completionMarker, releaseToken, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Strip every payload-delivered key from the persistent ZMX control process. */
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

function colorToOscRgb(hex: string): string {
  const value = hex.startsWith('#') ? hex.slice(1) : hex;
  const parts = [0, 2, 4].map(offset => {
    const byte = Number.parseInt(value.slice(offset, offset + 2), 16);
    return (byte * 257).toString(16).padStart(4, '0');
  });
  return `rgb:${parts.join('/')}`;
}

function indexedTerminalColor(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < TERMINAL_ANSI.length) return TERMINAL_ANSI[index]!;
  if (index < 232) {
    const n = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = levels[Math.floor(n / 36)]!;
    const green = levels[Math.floor((n % 36) / 6)]!;
    const blue = levels[n % 6]!;
    return `#${[red, green, blue].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  }
  const gray = 8 + (index - 232) * 10;
  const byte = gray.toString(16).padStart(2, '0');
  return `#${byte}${byte}${byte}`;
}

/** Replies for the OSC color-query families handled by browser xterm's theme service. */
export function terminalOscColorQueryReplies(
  ident: 4 | 10 | 11 | 12,
  data: string,
): string[] {
  if (ident === 4) {
    const parts = data.split(';');
    if (parts.length < 2 || parts.length % 2 !== 0) return [];
    const replies: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      if (!/^\d+$/.test(parts[i]!)) return [];
      if (parts[i + 1] !== '?') continue;
      const index = Number(parts[i]);
      const color = indexedTerminalColor(index);
      if (!color) return [];
      replies.push(`\x1b]4;${index};${colorToOscRgb(color)}\x1b\\`);
    }
    return replies;
  }

  const colors = [TERMINAL_FG, TERMINAL_BG, TERMINAL_CURSOR];
  const replies: string[] = [];
  for (const [offset, token] of data.split(';').entries()) {
    const target = ident + offset;
    if (token !== '?' || target > 12) continue;
    replies.push(`\x1b]${target};${colorToOscRgb(colors[target - 10]!)}\x1b\\`);
  }
  return replies;
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
      // The full list renders cmd= verbatim, including literal newlines. Once
      // a real row has started, even a continuation beginning with `name=` is
      // opaque unless it also has ZMX's tab-delimited pid=/err= status field.
      // A warning or changed row format before the first record is malformed.
      if (!sawRecord) malformedLines.push(line);
      continue;
    }
    sawRecord = true;
    const row = parseZmxListRow(line);
    if (!row) {
      malformedLines.push(line);
    } else if (row.state === 'unhealthy') {
      unhealthySessions.push(row.name);
    } else {
      sessions.push(row.name);
    }
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
    // ZMX 0.6 permits ordinary spaces in session names. `--short` is one name
    // per line, so preserve them verbatim (apart from a CRLF terminator) and
    // reject only bytes that make that line boundary/status protocol ambiguous.
    const name = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!name) continue;
    if (/[	\x00-\x1f\x7f]/.test(name) || seen.has(name)) {
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
} | null {
  // The first field is the name and the SECOND tab-delimited field is the
  // authoritative status (`pid=...` or `err=...`). Later fields include the
  // cwd and full command; treating an `err=`/`pid=` substring there as status
  // would misclassify a healthy session whose path or argv contains that text.
  const fields = line.replace(/^\s*/, '').split('\t');
  const nameField = fields[0];
  const name = nameField?.startsWith('name=') ? nameField.slice('name='.length) : '';
  const status = fields[1];
  if (!name || /[\x00-\x1f\x7f]/.test(name) || !status) return null;
  const pid = status.match(/^pid=(\d+)$/)?.[1];
  if (pid) return { name, state: 'healthy', pid: Number(pid) };
  if (/^err=/.test(status)) return { name, state: 'unhealthy' };
  return null;
}

export function findSessionPid(sessionName: string): number | null {
  const probe = ZmxBackend.probeSessions();
  if (!probe.ok || !probe.sessions.includes(sessionName)) return null;
  const matches: number[] = [];
  for (const line of probe.raw.split('\n')) {
    const row = parseZmxListRow(line);
    if (row?.name === sessionName && row.state === 'healthy' && row.pid) matches.push(row.pid);
  }
  // A multiline command can forge a record-shaped continuation. Refuse an
  // ambiguous PID rather than signaling or stamping the wrong process.
  return matches.length === 1 ? matches[0]! : null;
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
