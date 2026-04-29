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
import type { SessionBackend, SpawnOpts } from './types.js';

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

export class TmuxPipeBackend implements SessionBackend {
  /** Real tmux pane address (e.g. "0:2.0"). */
  private readonly paneTarget: string;
  private readonly fifoPath: string;
  private readStream: fs.ReadStream | null = null;
  private readonly dataCbs: Array<(d: string) => void> = [];
  private readonly exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
  private cols = 200;
  private rows = 50;
  private exited = false;
  /** Set after pipe-pane subscription is active so kill() knows to cancel it. */
  private pipeAttached = false;

  constructor(paneTarget: string) {
    this.paneTarget = paneTarget;
    // Per-instance fifo so concurrent adopt sessions don't collide.
    this.fifoPath = join(tmpdir(), `botmux-pipe-${randomBytes(8).toString('hex')}.fifo`);
  }

  // ─── SessionBackend implementation ────────────────────────────────────────

  /** spawn() in this backend doesn't actually spawn a process; it sets up
   *  the pipe-pane subscription + fifo reader. The bin/args params are
   *  ignored (the CLI is already running in the user's pane). */
  spawn(_bin: string, _args: string[], opts: SpawnOpts): void {
    this.cols = opts.cols;
    this.rows = opts.rows;

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
      const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
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
        { stdio: 'ignore', timeout: 5000 },
      );
      this.pipeAttached = true;
    } catch (err: any) {
      this.fireExit(1, null);
      throw err;
    }
  }

  write(data: string): void {
    // No PTY to write to — interpret as a literal send-keys.
    this.sendText(data);
  }

  sendText(text: string): void {
    if (this.exited) return;
    execFileSync('tmux', ['send-keys', '-t', this.paneTarget, '-l', '--', text], {
      stdio: 'ignore',
      timeout: 5000,
    });
  }

  sendSpecialKeys(...keys: string[]): void {
    if (this.exited) return;
    execFileSync('tmux', ['send-keys', '-t', this.paneTarget, ...keys], {
      stdio: 'ignore',
      timeout: 5000,
    });
  }

  pasteText(text: string): void {
    if (this.exited) return;
    execFileSync('tmux', ['load-buffer', '-'], {
      input: text,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 5000,
    });
    execFileSync('tmux', ['paste-buffer', '-t', this.paneTarget, '-d'], {
      stdio: 'ignore',
      timeout: 5000,
    });
  }

  enterCopyMode(): void {
    if (this.exited) return;
    execFileSync('tmux', ['copy-mode', '-e', '-t', this.paneTarget], {
      stdio: 'ignore',
      timeout: 5000,
    });
  }

  sendCopyModeCommand(xCommand: string): void {
    if (this.exited) return;
    execFileSync('tmux', ['send-keys', '-t', this.paneTarget, '-X', xCommand], {
      stdio: 'ignore',
      timeout: 5000,
    });
  }

  resize(cols: number, rows: number): void {
    // Don't resize the user's tmux pane on every web client resize — that
    // would visibly snap the user's own client around. We just remember the
    // requested size for getAttachInfo / capture sizing.
    this.cols = cols;
    this.rows = rows;
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
    // Cancel tmux's pipe subscription. Calling pipe-pane without a command
    // turns it off for the target pane.
    if (this.pipeAttached) {
      try {
        execSync(`tmux pipe-pane -t ${shellescape(this.paneTarget)}`, { stdio: 'ignore', timeout: 3000 });
      } catch { /* pane may already be gone — benign */ }
      this.pipeAttached = false;
    }
    if (this.readStream) {
      try { this.readStream.destroy(); } catch { /* already closed */ }
      this.readStream = null;
    }
    try { fs.unlinkSync(this.fifoPath); } catch { /* already gone */ }
    this.fireExit(0, null);
  }

  destroySession(): void {
    // Adopt mode never owns the source session — kill() is enough.
    this.kill();
  }

  getChildPid(): number | null {
    try {
      const out = execSync(
        `tmux display-message -p -t ${shellescape(this.paneTarget)} '#{pane_pid}'`,
        { encoding: 'utf-8', timeout: 3000 },
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

  /** Snapshot the current screen of the adopted pane WITH ANSI escapes,
   *  including history (-S - = start of scrollback). New web-terminal
   *  connections receive this string so xterm.js renders the existing
   *  session state instead of a blank screen.
   *
   *  IMPORTANT: tmux capture-pane separates rows with bare `\n`, no `\r`.
   *  xterm.js (and any VT100-compliant emulator) treats a bare LF as
   *  "move down one row, keep column" — every captured line lands further
   *  to the right than the previous one, producing the staircase artefact
   *  observed in early pipe-mode dogfooding. Normalising every `\n` to
   *  `\r\n` makes the snapshot render correctly. The live pipe-pane stream
   *  itself doesn't need this fix — applications write proper `\r\n` (and
   *  Claude Code uses cursor-positioning instead of bare LF anyway). */
  captureCurrentScreen(): string {
    if (this.exited) return '';
    try {
      const altOn = this.isPaneInAltBuffer();
      const raw = execSync(
        `tmux capture-pane -e -p -t ${shellescape(this.paneTarget)} -S -`,
        { encoding: 'utf-8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
      );
      const normalised = normaliseCaptureLineEndings(raw);
      if (altOn) {
        // The pane's CLI (e.g. Claude Code, vim) is in the alternate screen
        // buffer. capture-pane returns the alt-buffer's content but no
        // mode-switch escape sequence — we have to bracket the snapshot
        // with `enter alt screen + home + clear` so xterm.js renders it in
        // the alt buffer instead of leaking it into the main buffer where
        // it would persist after the application exits.
        return `\x1b[?1049h\x1b[H\x1b[2J${normalised}`;
      }
      return normalised;
    } catch {
      return '';
    }
  }

  /** Cheap probe: is the adopted pane currently in the alternate screen
   *  buffer? Used by captureCurrentScreen to decide whether the snapshot
   *  needs an alt-buffer-enter prefix for correct rendering. */
  private isPaneInAltBuffer(): boolean {
    try {
      const out = execSync(
        `tmux display-message -p -t ${shellescape(this.paneTarget)} '#{alternate_on}'`,
        { encoding: 'utf-8', timeout: 2000 },
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
      });
      return true;
    } catch {
      return false;
    }
  }

  private fireExit(code: number | null, signal: string | null): void {
    for (const cb of this.exitCbs) {
      try { cb(code, signal); } catch { /* listener crash is benign */ }
    }
  }
}
