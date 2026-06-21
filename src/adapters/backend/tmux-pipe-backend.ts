/**
 * TmuxPipeBackend — observe a user-owned tmux pane WITHOUT attaching to its
 * session. Used by /adopt mode to avoid the renderer conflict that arises
 * when a normal `tmux attach-session` client coexists with a tmux -CC
 * (iTerm2 control mode) client on the same server (interleaved ANSI vs
 * control-protocol writes corrupt cursor / status-bar / alt-screen state).
 *
 * Architecture (no PTY, no attach):
 *   - mkfifo a unique fifo under /tmp
 *   - `tmux pipe-pane -O -t <pane> 'cat > <fifo>'` — tmux replicates every
 *     byte the pane writes into the fifo (append-only, '-O' overwrites any
 *     existing pipe).
 *   - fs.createReadStream(<fifo>) — we read tmux's verbatim ANSI stream.
 *   - All writes (sendText / sendSpecialKeys / pasteText / copy-mode keys)
 *     go through `tmux send-keys / paste-buffer -t <pane>` — so the pane's
 *     real address ("0:2.0") is the addressing target, not a synthetic
 *     session name.
 *   - `tmux capture-pane -e -p -t <pane> -S -` returns the current screen
 *     with ANSI; the worker uses it to seed new web-terminal connections
 *     so they don't start from a blank screen.
 *
 * The user's source session is never attached, never zoomed, never
 * grouped — fully zero-touch from tmux's perspective beyond the pipe-pane
 * subscription, which is automatically detached when we kill the backend.
 */
import * as fs from 'node:fs';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { SessionBackend, SpawnOpts } from './types.js';
import { tmuxEnv } from '../../setup/ensure-tmux.js';
import { buildBotmuxEnvAssignments, resolveUserShell, SHELL_WRAPPER_SCRIPT, TmuxBackend } from './tmux-backend.js';

function shellescape(s: string): string {
  // Single-quote-escape, replacing internal ' with '\''
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Convert `\n` to `\r\n` while leaving existing `\r\n` alone. Exported for
 *  unit tests; used to normalise tmux capture-pane output before sending it
 *  to xterm.js (which treats bare LF as "down one row, keep column"). */
export function normaliseCaptureLineEndings(s: string): string {
  return s.replace(/\r?\n/g, '\r\n');
}

/**
 * Compose the web-terminal seed body from a normalised capture-pane snapshot
 * and the pane's cursor position.
 *
 * The receiving xterm replays this body and then resumes the LIVE pipe-pane
 * byte stream. Claude Code (and other Ink TUIs) repaint their bottom block with
 * height-RELATIVE moves (`\x1b[<n>A` + `\r\n`), so the FIRST live redraw assumes
 * the cursor sits exactly where the pane's cursor is. Raw capture-pane output
 * carries no cursor position and ends with a trailing newline — that newline
 * scrolls the receiving grid one row PAST the content (desyncing the viewport
 * from the app's coordinates) and parks the cursor on the bottom row instead of
 * the app's real row. The first relative redraw then lands a row low, and
 * because the CLI tracks position relatively, every subsequent frame stays
 * shifted (the status-line update bleeds into the line below — the bug 申晗
 * reported).
 *
 * Fix: strip the SINGLE trailing line terminator so no extra scroll happens,
 * then restore the cursor with CUP (`\x1b[row;colH`). Strip exactly one `\r\n`,
 * NOT a greedy `(\r\n)+` — capture-pane emits every pane row including trailing
 * BLANK rows below the cursor (Claude's bottom row is usually blank). Greedily
 * stripping would delete those blank rows and shift the whole grid up one row,
 * parking the cursor above the real input line (an upward drift — the same bug,
 * mirrored). CUP is viewport-relative and tmux's `cursor_x`/`cursor_y` are
 * 0-based viewport coordinates, so +1 each lands correctly even when the capture
 * includes full scrollback. Verified against a real 208x62 Claude pane.
 * Exported for tests.
 */
export function composeSeedBody(
  normalisedCapture: string,
  cursor: { x: number; y: number } | null,
): string {
  const body = normalisedCapture.replace(/\r\n$/, '');
  if (!cursor) return body;
  return body + `\x1b[${cursor.y + 1};${cursor.x + 1}H`;
}

export class TmuxPipeBackend implements SessionBackend {
  /** Real tmux pane address (e.g. "0:2.0") or botmux session name (bmx-*). */
  private readonly paneTarget: string;
  private readonly fifoPath: string;
  private readStream: fs.ReadStream | null = null;
  /** Streaming UTF-8 decoder. The fifo read emits raw Buffer chunks at libuv's
   *  64KB highWaterMark boundary, which can fall in the middle of a multi-byte
   *  character (CJK = 3 bytes, box-drawing = 3 bytes, emoji = 4 bytes). Decoding
   *  each chunk independently with `chunk.toString('utf8')` would split that
   *  character into U+FFFD replacement chars on both halves — one wide glyph
   *  becomes 2-3 garbage chars and every following column shifts right, which
   *  is the intermittent "错位" seen in the web terminal during heavy CLI
   *  re-renders (a full redraw is a big burst, far more likely to cross a 64KB
   *  boundary). StringDecoder holds the incomplete trailing bytes and prepends
   *  them to the next chunk, so a character split across reads is reassembled. */
  private readonly decoder = new StringDecoder('utf8');
  private readonly dataCbs: Array<(d: string) => void> = [];
  /** Bounded tail of the decoded output tmux most recently replicated from the
   *  pane (kept to the last RECENT_OUTPUT_MAX UTF-16 code units, not an exact
   *  byte count — fine for a diagnostic). Crash diagnostic: when a send fails
   *  because the pane vanished, capture-pane can no longer read the (now-gone)
   *  screen — but this text was already received over the pipe and is the
   *  CLI's actual final stdout/stderr (e.g. a gateway/API error) right before
   *  it exited. */
  private recentOutput = '';
  private static readonly RECENT_OUTPUT_MAX = 4096;
  private readonly exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  private lifecycleTimer: NodeJS.Timeout | null = null;
  private cols = 200;
  private rows = 50;
  private exited = false;
  /** Set after pipe-pane subscription is active so kill() knows to cancel it. */
  private pipeAttached = false;
  private readonly createSession: boolean;
  private readonly ownsSession: boolean;
  private readonly _isReattach: boolean;
  /** Adopt-mode CLI pid. Pane liveness alone is insufficient because the CLI
   *  can exit back to the user's shell while the tmux pane stays alive. */
  private readonly watchCliPid: number | undefined;

  /** Claude Code session JSONL path — set by worker for claude-code sessions so
   *  the claude-code adapter can verify paste+Enter submissions via file growth. */
  claudeJsonlPath?: string;
  /** PID of the spawned Claude Code child — used by the claude-code adapter to
   *  follow Claude's authoritative session id via ~/.claude/sessions/<pid>.json. */
  cliPid?: number;
  /** Working directory the CLI was spawned in — cross-checked against the pid
   *  file's cwd field so a recycled PID can't mislead the resolver. */
  cliCwd?: string;

  /** Whether this backend re-attached to an existing bmx-* tmux session
   *  (rather than creating a new detached one). Mirrors TmuxBackend.isReattach
   *  so the worker can branch on reattach behaviour without a private-cast. */
  get isReattach(): boolean {
    return this._isReattach;
  }

  constructor(paneTarget: string, opts?: { createSession?: boolean; ownsSession?: boolean; isReattach?: boolean; cliPid?: number }) {
    this.paneTarget = paneTarget;
    this.createSession = opts?.createSession ?? false;
    this.ownsSession = opts?.ownsSession ?? false;
    this._isReattach = opts?.isReattach ?? false;
    this.watchCliPid = opts?.cliPid;
    // Per-instance fifo so concurrent adopt sessions don't collide.
    this.fifoPath = join(tmpdir(), `botmux-pipe-${randomBytes(8).toString('hex')}.fifo`);
  }

  // ─── SessionBackend implementation ────────────────────────────────────────

  /** spawn() sets up the pipe-pane subscription + fifo reader. In managed
   *  mode it first creates a detached bmx-* tmux session that runs the CLI. */
  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    this.cols = opts.cols;
    this.rows = opts.rows;

    if (this.createSession) {
      this.createDetachedSession(bin, args, opts);
    } else if (this.ownsSession && this._isReattach) {
      // Backfill tmux options on an existing bmx-* session — daemon may have
      // been upgraded since the session was originally created, and options
      // like set-clipboard / window-size largest are idempotent to re-apply.
      this.applySessionOptions();
    }

    // Step 1: create the fifo. mkfifo is POSIX; linux/darwin both have it.
    spawnSync('mkfifo', [this.fifoPath], { stdio: 'ignore' });

    // Step 2: open the read end with O_RDWR (no O_NONBLOCK).
    //
    // Why O_RDWR? Avoids the fifo open chicken-and-egg: opening O_RDONLY
    // alone blocks until a writer arrives, opening O_WRONLY alone blocks
    // until a reader arrives. Holding both ends ourselves makes either
    // peer's open() return immediately.
    //
    // Why NOT O_NONBLOCK? libuv's ReadStream issues blocking read() calls
    // from its threadpool — that's how it stays responsive without
    // burning CPU. With O_NONBLOCK the very first read() on an empty
    // fifo returns EAGAIN, which libuv surfaces as an error, and the
    // stream dies before tmux ever gets a chance to write a byte. (This
    // exact bug ate the bridge final_output pipeline on first ship: an
    // strace showed worker only read its IPC fd, never the fifo.)
    const fd = fs.openSync(this.fifoPath, fs.constants.O_RDWR);
    this.readStream = fs.createReadStream('', { fd, autoClose: false, highWaterMark: 64 * 1024 });

    this.readStream.on('data', (chunk) => {
      // StringDecoder reassembles multi-byte chars split across chunk
      // boundaries (see `decoder` field doc). A string chunk would only
      // appear if the stream were created with an encoding — it isn't, but
      // keep the guard so the decoder path stays the single source of truth.
      const data = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
      if (data) {
        this.recentOutput = (this.recentOutput + data).slice(-TmuxPipeBackend.RECENT_OUTPUT_MAX);
      }
      for (const cb of this.dataCbs) {
        try { cb(data); } catch { /* listener crash shouldn't kill the stream */ }
      }
    });
    this.readStream.on('error', (err: any) => {
      // Errors are best-effort logged via the worker's stderr (we can't
      // pull a logger in a backend without circular imports). Don't fire
      // exit — the user's CLI is still alive, we just lost realtime view.
      process.stderr.write(`[tmux-pipe-backend] read error: ${err?.message ?? err}\n`);
    });

    // Step 3: ask tmux to replicate the pane's bytes into our fifo.
    // -O causes tmux to overwrite any prior pipe-pane subscription.
    // The shell command must redirect to the fifo; tmux runs it via /bin/sh.
    try {
      execSync(
        `tmux pipe-pane -O -t ${shellescape(this.paneTarget)} 'cat > ${shellescape(this.fifoPath)}'`,
        { stdio: 'ignore', timeout: 5000, env: tmuxEnv() },
      );
      this.pipeAttached = true;
      this.startLifecycleWatcher();
    } catch (err: any) {
      this.fireExit(1, null);
      throw err;
    }
  }

  write(data: string): void {
    // No PTY to write to — interpret as a literal send-keys.
    this.sendText(data);
  }

  sendText(text: string): boolean {
    if (this.exited) return false;
    this.exitCopyModeIfNeeded();
    return this.guardedSend('send-keys (text)', () => {
      execFileSync('tmux', ['send-keys', '-t', this.paneTarget, '-l', '--', text], {
        stdio: 'ignore',
        timeout: 5000,
        env: tmuxEnv(),
      });
    });
  }

  sendSpecialKeys(...keys: string[]): boolean {
    if (this.exited) return false;
    this.exitCopyModeIfNeeded();
    return this.guardedSend(`send-keys ${keys.join(' ')}`, () => {
      execFileSync('tmux', ['send-keys', '-t', this.paneTarget, ...keys], {
        stdio: 'ignore',
        timeout: 5000,
        env: tmuxEnv(),
      });
    });
  }

  /**
   * Paste text into the pane via load-buffer + paste-buffer.
   * The -p flag asks tmux to wrap the buffer in bracketed-paste markers
   * (\e[200~ … \e[201~) when the application has requested bracketed paste.
   * This is REQUIRED for CoCo/Ink: without the markers the TUI treats the
   * paste as a rapid input burst and swallows the trailing Enter as a soft
   * newline, stranding the message in the input box (it then gets submitted
   * by the *next* paste — the "replies to the previous message" off-by-one).
   * NB: TmuxPipeBackend is the only backend used at runtime (see
   * selectSessionBackend), so this is the path that actually matters.
   */
  pasteText(text: string): void {
    if (this.exited) return;
    this.exitCopyModeIfNeeded();
    this.guardedSend('paste-buffer', () => {
      execFileSync('tmux', ['load-buffer', '-'], {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 5000,
        env: tmuxEnv(),
      });
      execFileSync('tmux', ['paste-buffer', '-t', this.paneTarget, '-d', '-p'], {
        stdio: 'ignore',
        timeout: 5000,
        env: tmuxEnv(),
      });
    });
  }

  /**
   * Run a tmux write (send-keys / load-buffer / paste-buffer) that must never
   * crash the worker on failure.
   *
   * Background: when the CLI process exits mid-write its tmux session/pane is
   * destroyed, so the very next `tmux send-keys` returns exit 1. The 1s
   * lifecycle watcher hasn't fired yet, so `this.exited` is still false and the
   * guard above doesn't help. Previously execFileSync's synchronous throw
   * propagated through writeInput → flushPending (a fire-and-forget async with
   * no .catch) → unhandledRejection, which killed the entire worker process
   * (and with it every Lark session it served).
   *
   * Classify the failure instead of letting it escape:
   *   - pane GONE  → the CLI exited; convert to a normal onExit so the worker
   *                  tears the session down and tells the user "CLI exited",
   *                  exactly like the lifecycle watcher would have.
   *   - pane ALIVE → a transient tmux hiccup; log and drop the keystroke. The
   *                  claude-code adapter's JSONL retry/verify loop will catch a
   *                  non-submission and surface a submit-failure notice.
   *
   * Either way this method never throws — every send-keys caller (web-terminal
   * keys, TUI input, the typing loop) stays crash-safe without its own guard.
   *
   * Returns true when the write succeeded, false when it was dropped (pane gone
   * or a pane-alive hiccup). Callers that verify submission (runner adapters)
   * read this to report a non-submission; the many fire-and-forget callers
   * (web-terminal keys, copy-mode) just ignore it.
   */
  private guardedSend(op: string, run: () => void): boolean {
    try {
      run();
      return true;
    } catch (err: any) {
      // A kill()/handlePaneExit() may have flipped exited between the guard
      // and here; if so the teardown already happened.
      if (this.exited) return false;
      const alive = this.isPaneAlive();
      process.stderr.write(
        `[tmux-pipe-backend] ${op} failed (pane ${alive ? 'ALIVE' : 'GONE'}): ${err?.message ?? err}\n`,
      );
      if (!alive) {
        // Diagnostic: the pane is gone, so capture-pane can't read the final
        // screen. Instead dump the tail tmux already replicated over the pipe
        // — the CLI's real last stdout/stderr before it exited, which often
        // explains WHY it exited (e.g. a gateway/API error line).
        const tail = this.recentOutput.trim();
        if (tail) {
          process.stderr.write(`[tmux-pipe-backend] CLI last output before exit (tail):\n${tail}\n`);
        }
        this.handlePaneExit();
      }
      return false;
    }
  }

  private exitCopyModeIfNeeded(): void {
    if (this.exited) return;

    try {
      const inMode = execFileSync('tmux', ['display-message', '-p', '-t', this.paneTarget, '#{pane_in_mode}'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
        env: tmuxEnv(),
      }).trim();

      if (inMode === '1') {
        execFileSync('tmux', ['send-keys', '-t', this.paneTarget, '-X', 'cancel'], {
          stdio: 'ignore',
          timeout: 1000,
          env: tmuxEnv(),
        });
      }
    } catch {
      // Pane may be gone or tmux may be restarting; keep the original write path best-effort.
    }
  }

  enterCopyMode(): void {
    if (this.exited) return;
    execFileSync('tmux', ['copy-mode', '-e', '-t', this.paneTarget], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  sendCopyModeCommand(xCommand: string): void {
    if (this.exited) return;
    execFileSync('tmux', ['send-keys', '-t', this.paneTarget, '-X', xCommand], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.ownsSession) {
      execFileSync('tmux', ['resize-window', '-t', this.paneTarget, '-x', String(cols), '-y', String(rows)], {
        stdio: 'ignore',
        timeout: 5000,
        env: tmuxEnv(),
      });
    }
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCbs.push(cb);
  }

  kill(): void {
    if (this.exited) return;
    this.exited = true;
    this.stopLifecycleWatcher();
    // Cancel tmux's pipe subscription. Calling pipe-pane without a command
    // turns it off for the target pane.
    if (this.pipeAttached) {
      try {
        execSync(`tmux pipe-pane -t ${shellescape(this.paneTarget)}`, { stdio: 'ignore', timeout: 3000, env: tmuxEnv() });
      } catch { /* pane may already be gone — benign */ }
      this.pipeAttached = false;
    }
    if (this.readStream) {
      try { this.readStream.destroy(); } catch { /* already closed */ }
      this.readStream = null;
    }
    try { fs.unlinkSync(this.fifoPath); } catch { /* already gone */ }
  }

  destroySession(): void {
    this.kill();
    if (this.ownsSession) {
      TmuxBackend.killSession(this.paneTarget);
    }
  }

  getChildPid(): number | null {
    try {
      const out = execSync(
        `tmux display-message -p -t ${shellescape(this.paneTarget)} '#{pane_pid}'`,
        // Explicit stdio: execSync's default leaks the child's stderr to the
        // parent — when tmux server is unavailable this would spam
        // "error connecting to /tmp/tmux-UID/default" into daemon-error.log
        // every poll. Capture stderr in the result instead.
        // tmuxEnv() also strips $TMUX so we don't target a dead parent server.
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000, env: tmuxEnv() },
      ).trim();
      const pid = parseInt(out, 10);
      return pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  getAttachInfo() {
    return null;
  }

  // ─── Pipe-specific helpers ────────────────────────────────────────────────

  private startLifecycleWatcher(): void {
    this.stopLifecycleWatcher();
    this.lifecycleTimer = setInterval(() => {
      if (this.exited) return;
      if (!this.isCliPidAlive()) {
        process.stderr.write(`[tmux-pipe-backend] adopted CLI pid ${this.watchCliPid} exited; detaching observer\n`);
        this.handlePaneExit();
        return;
      }
      try {
        const paneId = execSync(
          `tmux display-message -p -t ${shellescape(this.paneTarget)} '#{pane_id}'`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, env: tmuxEnv() },
        ).trim();
        if (!paneId) this.handlePaneExit();
      } catch {
        this.handlePaneExit();
      }
    }, 1000);
  }

  private stopLifecycleWatcher(): void {
    if (this.lifecycleTimer) {
      clearInterval(this.lifecycleTimer);
      this.lifecycleTimer = null;
    }
  }

  private handlePaneExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.stopLifecycleWatcher();
    if (this.pipeAttached) {
      try {
        execSync(`tmux pipe-pane -t ${shellescape(this.paneTarget)}`, { stdio: 'ignore', timeout: 3000, env: tmuxEnv() });
      } catch { /* pane may already be gone — benign */ }
      this.pipeAttached = false;
    }
    if (this.readStream) {
      try { this.readStream.destroy(); } catch { /* already closed */ }
      this.readStream = null;
    }
    try { fs.unlinkSync(this.fifoPath); } catch { /* already gone */ }
    this.fireExit(1, null);
  }

  private createDetachedSession(bin: string, args: string[], opts: SpawnOpts): void {
    const shellSpec = resolveUserShell();
    const envAssignments = buildBotmuxEnvAssignments(opts.env, opts.injectEnv);
    execFileSync('tmux', [
      'new-session',
      '-d',
      '-s', this.paneTarget,
      '-x', String(opts.cols),
      '-y', String(opts.rows),
      '--',
      shellSpec.shell, ...shellSpec.flags, '-c', SHELL_WRAPPER_SCRIPT, '_',
      opts.cwd,
      ...envAssignments,
      bin, ...args,
    ], {
      cwd: opts.cwd,
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(opts.env),
    });
    this.applySessionOptions();
  }

  private applySessionOptions(): void {
    const t = shellescape(this.paneTarget);
    const env = tmuxEnv();
    try {
      execSync(`tmux set-option -t ${t} status off`, { stdio: 'ignore', env });
      execSync(`tmux set-option -t ${t} mouse on`, { stdio: 'ignore', env });
      execSync(`tmux set-option -s set-clipboard on`, { stdio: 'ignore', env });
      execSync(`tmux set-option -t ${t} history-limit 50000`, { stdio: 'ignore', env });
      execSync(`tmux set-option -t ${t} window-size largest`, { stdio: 'ignore', env });
    } catch { /* session may not be ready yet — benign */ }
  }

  /** Snapshot the full pane history WITH ANSI escapes (`-S - -E -`).
   *
   *  Used by web reattach so a brand-new web client sees the whole prior
   *  conversation. For the screenshot / screen_update fast path use
   *  `captureViewport()` instead — that one only returns the visible pane
   *  and is safe to seed a transient xterm-headless with.
   *
   *  IMPORTANT: tmux capture-pane separates rows with bare `\n`, no `\r`.
   *  xterm.js (and any VT100-compliant emulator) treats a bare LF as
   *  "move down one row, keep column" — every captured line lands further
   *  to the right than the previous one. Normalising every `\n` to `\r\n`
   *  makes the snapshot render correctly. The live pipe-pane stream itself
   *  doesn't need this fix — applications write proper `\r\n`. */
  captureCurrentScreen(): string {
    return this.captureWithBounds('-S - -E -', { restoreCursor: true });
  }

  /** Snapshot ONLY the currently visible pane (no scrollback). Equivalent to
   *  `tmux capture-pane` with no `-S`/`-E` flags, which defaults to the
   *  viewport. This is the right input for a transient xterm-headless seed:
   *  the snapshot row count matches the transient terminal's row count, so
   *  no normal-buffer scroll happens and the rendered screenshot lines up
   *  with what the user is seeing in the web terminal right now. */
  captureViewport(): string {
    // No `-S`/`-E` flags = tmux default = current viewport only.
    return this.captureWithBounds('');
  }

  private captureWithBounds(bounds: string, opts?: { restoreCursor?: boolean }): string {
    if (this.exited) return '';
    try {
      const altOn = this.isPaneInAltBuffer();
      const raw = execSync(
        `tmux capture-pane -e -p -t ${shellescape(this.paneTarget)}${bounds ? ' ' + bounds : ''}`,
        // Explicit stdio — see getChildPid for why default leaks tmux stderr.
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: tmuxEnv() },
      );
      const normalised = normaliseCaptureLineEndings(raw);
      const body = opts?.restoreCursor
        ? composeSeedBody(normalised, this.getCursorPosition())
        : normalised;

      if (altOn) {
        // The pane's CLI (e.g. Claude Code, vim) is in the alternate screen
        // buffer. capture-pane returns the alt-buffer's content but no
        // mode-switch escape sequence — we have to bracket the snapshot
        // with `enter alt screen + home + clear` so xterm.js renders it in
        // the alt buffer instead of leaking it into the main buffer where
        // it would persist after the application exits.
        return `\x1b[?1049h\x1b[H\x1b[2J${body}`;
      }
      return body;
    } catch {
      return '';
    }
  }

  /** Current pane cursor position (0-based, viewport-relative — matches xterm
   *  CUP semantics). Used to restore the cursor in the web-terminal seed so the
   *  CLI's first height-relative redraw lands on the right row. */
  private getCursorPosition(): { x: number; y: number } | null {
    if (this.exited) return null;
    try {
      const out = execSync(
        `tmux display-message -p -t ${shellescape(this.paneTarget)} '#{cursor_x} #{cursor_y}'`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, env: tmuxEnv() },
      ).trim();
      const [x, y] = out.split(/\s+/).map(s => parseInt(s, 10));
      if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) return { x, y };
      return null;
    } catch {
      return null;
    }
  }

  /** Current real tmux pane dimensions. Drives transient-renderer sizing so
   *  the screenshot canvas matches whatever the web client resized the pane
   *  to. Returns null if tmux can't be queried (pane gone, server gone). */
  getPaneSize(): { cols: number; rows: number } | null {
    if (this.exited) return null;
    try {
      const out = execSync(
        `tmux display-message -p -t ${shellescape(this.paneTarget)} '#{pane_width} #{pane_height}'`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, env: tmuxEnv() },
      ).trim();
      const [cols, rows] = out.split(/\s+/).map(s => parseInt(s, 10));
      if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
        return { cols, rows };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Cheap probe: is the adopted pane currently in the alternate screen
   *  buffer? Used by captureCurrentScreen to decide whether the snapshot
   *  needs an alt-buffer-enter prefix for correct rendering. */
  private isPaneInAltBuffer(): boolean {
    try {
      const out = execSync(
        `tmux display-message -p -t ${shellescape(this.paneTarget)} '#{alternate_on}'`,
        // Explicit stdio — see getChildPid for why default leaks tmux stderr.
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, env: tmuxEnv() },
      ).trim();
      return out === '1';
    } catch {
      return false;
    }
  }

  /** True if the underlying pane is still addressable in tmux. Cheap check —
   *  used by callers to detect "user closed the pane while we were piping". */
  isPaneAlive(): boolean {
    if (this.exited) return false;
    try {
      execSync(`tmux display-message -p -t ${shellescape(this.paneTarget)} ''`, {
        stdio: 'ignore',
        timeout: 2000,
        env: tmuxEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Unknown pid → pane-only liveness. EPERM still means the process exists. */
  private isCliPidAlive(): boolean {
    if (this.watchCliPid === undefined) return true;
    try {
      process.kill(this.watchCliPid, 0);
      return true;
    } catch (err: any) {
      return err?.code === 'EPERM';
    }
  }

  private fireExit(code: number | null, signal: string | null): void {
    for (const cb of this.exitCbs) {
      try { cb(code, signal); } catch { /* listener crash is benign */ }
    }
  }
}
