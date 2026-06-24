import { execFileSync } from 'node:child_process';
import type { ObserveBackend, SpawnOpts } from './types.js';
import { tmuxKeyToBytes } from './zellij-backend.js';
import { normaliseCaptureLineEndings } from './tmux-pipe-backend.js';
import { zellijEnv } from '../../setup/ensure-zellij.js';
import { logger } from '../../utils/logger.js';
import { LivenessGate, ADOPT_LIVENESS_MAX_FAILURES } from './liveness-gate.js';

/**
 * ZellijObserveBackend — the zellij analogue of TmuxPipeBackend, for /adopt.
 *
 * zellij has no `pipe-pane` (zero-touch raw byte tap). The non-invasive
 * primitives that DON'T disturb the user's session (size/focus) are:
 *   - observe: poll `zellij action dump-screen --pane-id <p> --ansi` (a query;
 *     no client attaches, no resize, no focus change — verified)
 *   - drive:   `zellij action write/write-chars/send-keys --pane-id <p>`
 *     (targets the pane regardless of focus — verified focus-neutral)
 *
 * So this backend OBSERVES by polling dump-screen and emitting a snapshot on
 * change (cleared + redrawn so the web-terminal xterm shows the current screen
 * rather than stacking frames), and DRIVES via targeted `action` calls. It owns
 * nothing: kill()/destroySession() only stop the pollers — the user's zellij
 * session is never touched.
 *
 * Tradeoff vs tmux pipe-pane: the live screen has ~POLL_MS latency and isn't
 * byte-exact. The authoritative conversation turns come from the per-CLI
 * transcript bridge watchers (multiplexer-agnostic), which are immediate; the
 * snapshot only drives the web-terminal/screenshot observation.
 */
const POLL_MS = 700;
const LIVENESS_MS = 1000;
/** Home + clear screen — prefix each emitted snapshot so the consuming xterm
 *  redraws the current screen instead of appending successive frames. */
const CLEAR_HOME = '\x1b[H\x1b[2J';

export class ZellijObserveBackend implements ObserveBackend {
  private readonly session: string;
  private readonly paneId: string;
  private readonly cliPid: number | null;
  private cols: number;
  private rows: number;

  private dataCbs: Array<(data: string) => void> = [];
  private exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  /** Debounce transient pane-probe failures so one busy `zellij action
   *  list-panes` doesn't tear down a pane that's still alive. See recordPaneProbe.
   *  (pid-death stays decisive — a pure syscall can't false-fail under load.) */
  private readonly livenessGate = new LivenessGate(ADOPT_LIVENESS_MAX_FAILURES);
  private lastSnapshot = '';
  private exited = false;
  /** # of live web-terminal `zellij attach` clients currently connected. While
   *  >0 the pollers go quiet — see setLiveAttach. */
  private liveAttachCount = 0;

  // PtyHandle fields the worker may set (parallel to the other backends).
  claudeJsonlPath?: string;
  cliCwd?: string;

  constructor(session: string, paneId: string, opts?: { cliPid?: number }) {
    this.session = session;
    this.paneId = paneId;
    this.cliPid = opts?.cliPid ?? null;
    this.cols = 80;
    this.rows = 24;
  }

  // ─── SessionBackend ───────────────────────────────────────────────────────

  /** bin/args are ignored — we observe an existing pane, we don't launch. */
  spawn(_bin: string, _args: string[], opts: SpawnOpts): void {
    this.cols = opts.cols;
    this.rows = opts.rows;
    logger.debug(`[zellij-observe] ${this.session}/${this.paneId} observe ${this.cols}x${this.rows} cliPid=${this.cliPid}`);
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    this.livenessTimer = setInterval(() => this.checkLiveness(), LIVENESS_MS);
  }

  private poll(): void {
    const snap = this.captureViewport();
    if (snap && snap !== this.lastSnapshot) {
      this.lastSnapshot = snap;
      const frame = CLEAR_HOME + snap;
      for (const cb of this.dataCbs) cb(frame);
    }
  }

  private checkLiveness(): void {
    if (this.exited) return;
    // (b) The adopted CLI pid is a pure process.kill(pid,0) syscall — ESRCH
    // (gone) or EPERM (alive), never a transient/busy-server failure. So
    // pid-death is DECISIVE: tear down at once. Essential for user-typed CLIs,
    // where the pane drops back to a still-"alive" shell on exit and a pane-only
    // check would route subsequent Lark input INTO that shell.
    if (!this.isCliPidAlive()) { this.handlePaneExit(); return; }
    // While a live web-attach client is connected, skip the list-panes `action`
    // (it makes the zellij server repaint every attached client → flicker). The
    // attach PTY's own exit covers pane/session death and the pid check above
    // covers CLI exit — nothing flaky left to probe. The partial pane-failure
    // streak was already discarded the moment the client attached (see
    // setLiveAttach), and nothing increments the gate while attached, so there's
    // nothing to reset here.
    if (this.liveAttachCount > 0) return;
    // (a) The list-panes pane probe IS the flaky signal (busy server) — debounce.
    this.recordPaneProbe(this.isPaneAlive());
  }

  /**
   * Debounce the (flaky) pane probe — mirror of TmuxPipeBackend.recordPaneProbe.
   * Tearing down on the FIRST failed probe produced the spurious
   * "⏏ /adopt的 CLI 会话已断开" — a busy zellij server momentarily fails list-panes
   * while the pane is still alive. Only after ADOPT_LIVENESS_MAX_FAILURES
   * consecutive failures, AND a final re-probe that still fails, do we detach.
   * Any success resets the counter. (pid-death is handled decisively above.)
   */
  private recordPaneProbe(alive: boolean): void {
    if (this.exited) return;
    if (!this.livenessGate.record(alive)) {
      if (!alive) {
        logger.debug(`[zellij-observe] pane probe failed (${this.livenessGate.consecutiveFailures}/${ADOPT_LIVENESS_MAX_FAILURES}); retrying before teardown`);
      }
      return;
    }
    // Threshold reached — one final authoritative re-probe before tearing down.
    if (this.isPaneAlive()) {
      this.livenessGate.reset();
      logger.debug('[zellij-observe] pane recovered on final check; staying attached');
      return;
    }
    this.handlePaneExit();
  }

  /**
   * Mark a live web-terminal `zellij attach` client as (dis)connected.
   *
   * Every `zellij action` the pollers run (dump-screen poll @700ms, list-panes
   * liveness @1000ms) connects a transient client to the server, which makes the
   * server repaint ALL attached clients — so an attached web client redraws its
   * zellij chrome ~2×/s, i.e. the flicker 申晗 saw. While ≥1 attach client is up
   * the dump-screen poll is redundant (the attach IS the live view) so we stop
   * it, and liveness degrades to the churn-free pid syscall (see checkLiveness).
   * Reference-counted so multiple browser tabs compose; resumes on the last one.
   */
  setLiveAttach(active: boolean): void {
    this.liveAttachCount = Math.max(0, this.liveAttachCount + (active ? 1 : -1));
    if (this.exited) return;
    if (this.liveAttachCount > 0) {
      // Pane probing pauses while attached → discard any partial pane-failure
      // streak NOW, at the attach transition, not on the next liveness tick. A
      // brief attach that opens and closes BETWEEN ticks would otherwise leave a
      // stale streak that trips the moment the client detaches.
      this.livenessGate.reset();
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    } else if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    }
  }

  /** True while ≥1 live web-attach client is up — the dump-screen poller is
   *  paused (see setLiveAttach), so screen changes flow only to the attach PTY
   *  and never bump the worker's onData/onPtyData activity watermark. Consumers
   *  that gate on that watermark must capture unconditionally in this window. */
  isLiveAttachActive(): boolean {
    return this.liveAttachCount > 0;
  }

  /** Whether the adopted CLI process is still running. Unknown pid → defer to
   *  pane liveness only. EPERM (exists, not ours) counts as alive; ESRCH = gone. */
  private isCliPidAlive(): boolean {
    if (this.cliPid === null) return true;
    try { process.kill(this.cliPid, 0); return true; }
    catch (e: any) { return e?.code === 'EPERM'; }
  }

  private handlePaneExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.stopTimers();
    for (const cb of this.exitCbs) cb(0, null);
  }

  // ── Input: targeted `action` calls (focus-neutral, non-invasive) ──

  write(data: string): void {
    this.writeBytes(data);
  }

  /** Literal text via write-chars (preserves UTF-8). */
  sendText(text: string): void {
    if (!text) return;
    this.action(['write-chars', '--pane-id', this.paneId, '--', text]);
  }

  /** Special keys by tmux-style name → raw bytes → `action write`. */
  sendSpecialKeys(...keys: string[]): void {
    for (const key of keys) this.writeBytes(tmuxKeyToBytes(key));
  }

  /** Bracketed paste — wrap so TUIs detect the boundary (mirrors paste-buffer -p). */
  pasteText(text: string): void {
    this.writeBytes('\x1b[200~');
    this.sendText(text);
    this.writeBytes('\x1b[201~');
  }

  /** Write arbitrary bytes via `action write <decimal>…` (handles control/escape).
   *  Chunked so a large web-terminal paste can't blow the argv limit; zellij
   *  serialises the writes in arrival order. */
  private writeBytes(data: string): void {
    if (!data) return;
    const buf = Buffer.from(data, 'utf-8');
    const CHUNK = 512;
    for (let i = 0; i < buf.length; i += CHUNK) {
      const bytes = Array.from(buf.subarray(i, i + CHUNK), b => String(b));
      this.action(['write', '--pane-id', this.paneId, ...bytes]);
    }
  }

  /** Resize is a NO-OP in observe mode — the pane size is the user's, and
   *  resizing it would disturb their layout. The transient snapshot reads the
   *  real pane size via getPaneSize(). */
  resize(_cols: number, _rows: number): void { /* intentionally non-invasive */ }

  onData(cb: (data: string) => void): void { this.dataCbs.push(cb); }
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitCbs.push(cb); }

  getChildPid(): number | null { return this.cliPid; }

  /** Detach observer — stop polling. Never touches the user's zellij session. */
  kill(): void { this.stopTimers(); }

  /** Adopt owns nothing — destroy == detach (don't kill the user's session). */
  destroySession(): void { this.kill(); }

  private stopTimers(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.livenessTimer) { clearInterval(this.livenessTimer); this.livenessTimer = null; }
  }

  // ─── ObserveBackend snapshot surface ──────────────────────────────────────

  captureCurrentScreen(): string {
    return this.dumpScreen(true);
  }

  captureViewport(): string {
    return this.dumpScreen(false);
  }

  getPaneSize(): { cols: number; rows: number } | null {
    const pane = this.listPane();
    if (!pane) return null;
    const cols = Number(pane.pane_content_columns ?? pane.pane_columns);
    const rows = Number(pane.pane_content_rows ?? pane.pane_rows);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
    return { cols, rows };
  }

  isPaneAlive(): boolean {
    const pane = this.listPane();
    return !!pane && pane.exited !== true;
  }

  // ─── zellij plumbing ──────────────────────────────────────────────────────

  private dumpScreen(full: boolean): string {
    const args = ['dump-screen', '--pane-id', this.paneId, '--ansi'];
    if (full) args.push('--full');
    // zellij dump-screen separates rows with bare `\n` (no `\r`). Fed to an
    // xterm as-is, each line continues from the previous line's end column
    // instead of returning to column 0 → the staircase/right-drift garble.
    // Same fix tmux's capture path uses (normaliseCaptureLineEndings).
    return normaliseCaptureLineEndings(this.action(args) ?? '');
  }

  private listPane(): any | null {
    try {
      const out = execFileSync('zellij', ['--session', this.session, 'action', 'list-panes', '--json'], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, env: zellijEnv(),
      });
      const arr = JSON.parse(out);
      if (!Array.isArray(arr)) return null;
      return arr.find((p: any) => !p.is_plugin && `terminal_${p.id}` === this.paneId) ?? null;
    } catch {
      return null;
    }
  }

  /** Run a `zellij --session S action …`, returning stdout or null on failure. */
  private action(args: string[]): string | null {
    try {
      return execFileSync('zellij', ['--session', this.session, 'action', ...args], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, env: zellijEnv(),
      });
    } catch (err: any) {
      logger.debug(`[zellij-observe] action ${args[0]} failed: ${err?.message}`);
      return null;
    }
  }
}
