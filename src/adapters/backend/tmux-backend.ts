import * as pty from 'node-pty';
import { execSync, execFileSync } from 'node:child_process';
import type { SessionBackend, SpawnOpts } from './types.js';

/**
 * TmuxBackend — session backend using tmux for process persistence.
 *
 * Architecture: pty-under-tmux.
 *   - A node-pty process runs `tmux new-session` or `tmux attach-session`
 *   - All output flows through the pty (onData/onExit work unchanged)
 *   - kill() only detaches (kills the pty viewer), tmux session survives
 *   - destroySession() kills the tmux session (for explicit /close)
 *
 * Naming: tmux sessions are named `bmx-<sessionId.slice(0,8)>`.
 */
export class TmuxBackend implements SessionBackend {
  private process: pty.IPty | null = null;
  private readonly sessionName: string;
  private readonly ownsSession: boolean;
  private reattaching = false;

  constructor(sessionName: string, opts?: { ownsSession?: boolean }) {
    this.sessionName = sessionName;
    this.ownsSession = opts?.ownsSession ?? true;
  }

  // ─── Static helpers ───────────────────────────────────────────────────────

  /** Check if tmux binary is available on PATH. */
  static isAvailable(): boolean {
    try {
      execSync('tmux -V', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /** Derive tmux session name from a session UUID. */
  static sessionName(sessionId: string): string {
    return `bmx-${sessionId.slice(0, 8)}`;
  }

  /** Check if a named tmux session exists. */
  static hasSession(name: string): boolean {
    try {
      execSync(`tmux has-session -t ${shellescape(name)}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /** Kill a named tmux session (no-op if it doesn't exist). */
  static killSession(name: string): void {
    try {
      execSync(`tmux kill-session -t ${shellescape(name)}`, { stdio: 'ignore' });
    } catch { /* session doesn't exist */ }
  }

  /** List all botmux tmux sessions (bmx-* prefix). */
  static listBotmuxSessions(): string[] {
    try {
      const out = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", {
        encoding: 'utf-8',
      });
      return out.split('\n').filter(s => s.startsWith('bmx-'));
    } catch {
      return [];
    }
  }

  // ─── SessionBackend implementation ────────────────────────────────────────

  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    this.reattaching = TmuxBackend.hasSession(this.sessionName);

    if (this.reattaching) {
      // Re-attach to surviving tmux session (CLI is still running)
      this.process = pty.spawn('tmux', ['attach-session', '-t', this.sessionName], {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.env,
      });
    } else {
      // Build -e flags for env vars that the tmux session command needs.
      // tmux new-session runs the command in the tmux server's environment,
      // which may differ from the spawning process (e.g. per-bot credentials).
      const envFlags: string[] = [];
      for (const key of TMUX_PASSTHROUGH_VARS) {
        const val = opts.env?.[key];
        if (val !== undefined) {
          envFlags.push('-e', `${key}=${val}`);
        }
      }

      // Create new tmux session running the CLI command
      const tmuxArgs = [
        'new-session',
        '-s', this.sessionName,
        ...envFlags,
        '-x', String(opts.cols),
        '-y', String(opts.rows),
        '--', bin, ...args,
      ];
      this.process = pty.spawn('tmux', tmuxArgs, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.env,
      });
    }

    // Configure tmux session options.
    // Runs for BOTH new sessions and reattach — reattach needs this to
    // backfill options added after the session was originally created.
    // Setting an already-applied option is idempotent.
    setTimeout(() => {
      try {
        const t = shellescape(this.sessionName);
        execSync(`tmux set-option -t ${t} status off`, { stdio: 'ignore' });
        execSync(`tmux set-option -t ${t} mouse on`, { stdio: 'ignore' });
        // set-clipboard is a server option — enable OSC 52 passthrough for web copy
        execSync(`tmux set-option -s set-clipboard on`, { stdio: 'ignore' });
        execSync(`tmux set-option -t ${t} history-limit 50000`, { stdio: 'ignore' });
        // Prevent web terminal clients (smaller viewport) from shrinking the
        // tmux window.  If a web client at 80×24 causes tmux to resize the
        // window down, reflowed content shifts buffer positions and the
        // terminal renderer's baseline tracking breaks — historical output
        // leaks into the streaming card.
        execSync(`tmux set-option -t ${t} window-size largest`, { stdio: 'ignore' });
      } catch { /* session may not be ready yet — benign */ }
    }, 500);
  }

  /** Whether the last spawn() re-attached to an existing tmux session. */
  get isReattach(): boolean {
    return this.reattaching;
  }

  /** Claude Code session JSONL path — set by worker for claude-code sessions so
   *  the claude-code adapter can verify paste+Enter submissions via file growth. */
  claudeJsonlPath?: string;

  /** Codex session rollout JSONL path — set by worker for codex sessions so the
   *  codex adapter can verify send+Enter submissions via file growth. */
  codexRolloutPath?: string;

  write(data: string): void {
    this.process?.write(data);
  }

  /**
   * Send text literally to the tmux pane via `tmux send-keys -l`.
   * Uses execFileSync (no shell) so arbitrary text is safe — no escaping needed.
   * For multiline text, use pasteText() instead (send-keys -l sends \n as Enter).
   */
  sendText(text: string): void {
    execFileSync('tmux', ['send-keys', '-t', this.sessionName, '-l', '--', text], {
      stdio: 'ignore',
      timeout: 5000,
    });
  }

  /** Send special keys (Enter, Escape, C-c, etc.) to the tmux pane. */
  sendSpecialKeys(...keys: string[]): void {
    execFileSync('tmux', ['send-keys', '-t', this.sessionName, ...keys], {
      stdio: 'ignore',
      timeout: 5000,
    });
  }

  /**
   * Enter copy-mode on the pane (`-e` makes it auto-exit when scrolled back to
   * the bottom). Lets us use tmux's own scrollback even when the running app
   * is in the alternate screen buffer (Claude Code, vim, etc.).
   */
  enterCopyMode(): void {
    execFileSync('tmux', ['copy-mode', '-e', '-t', this.sessionName], {
      stdio: 'ignore',
      timeout: 5000,
    });
  }

  /** Send a copy-mode X-command (e.g. 'halfpage-up', 'halfpage-down', 'cancel'). */
  sendCopyModeCommand(xCommand: string): void {
    execFileSync('tmux', ['send-keys', '-t', this.sessionName, '-X', xCommand], {
      stdio: 'ignore',
      timeout: 5000,
    });
  }

  /**
   * Paste text into the tmux pane via load-buffer + paste-buffer.
   * Tmux automatically wraps in bracketed paste if the pane has it enabled.
   * Safe for multiline content (unlike sendText where \n becomes Enter).
   */
  pasteText(text: string): void {
    execFileSync('tmux', ['load-buffer', '-'], {
      input: text,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 5000,
    });
    execFileSync('tmux', ['paste-buffer', '-t', this.sessionName, '-d'], {
      stdio: 'ignore',
      timeout: 5000,
    });
  }

  resize(cols: number, rows: number): void {
    this.process?.resize(cols, rows);
  }

  /** Must be called AFTER spawn(). Callbacks registered before spawn are silently lost. */
  onData(cb: (data: string) => void): void {
    this.process?.onData(cb);
  }

  /** Must be called AFTER spawn(). Callbacks registered before spawn are silently lost. */
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.process?.onExit(({ exitCode, signal }) => {
      cb(exitCode, signal !== undefined ? String(signal) : null);
    });
  }

  getChildPid(): number | null {
    try {
      const output = execSync(
        `tmux list-panes -t ${shellescape(this.sessionName)} -F '#{pane_pid}'`,
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();
      const pid = parseInt(output.split('\n')[0], 10);
      return pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /** Detach only — kills the pty viewer but leaves tmux session alive. */
  kill(): void {
    // Unzoom adopted pane before detaching (restore user's original layout)
    if (this.adoptedPaneTarget) {
      try {
        // Only unzoom if the pane is currently zoomed
        const zoomed = execSync(
          `tmux display -t ${shellescape(this.adoptedPaneTarget)} -p '#{window_zoomed_flag}'`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();
        if (zoomed === '1') {
          execSync(`tmux resize-pane -Z -t ${shellescape(this.adoptedPaneTarget)}`, { stdio: 'ignore' });
        }
      } catch { /* pane may be gone — benign */ }
      this.adoptedPaneTarget = null;
    }
    if (this.process) {
      try { this.process.kill(); } catch { /* already dead */ }
      this.process = null;
    }
  }

  /** Kill the tmux session permanently. Called on explicit /close. */
  destroySession(): void {
    this.kill();
    if (this.ownsSession) {
      TmuxBackend.killSession(this.sessionName);
    }
  }

  /**
   * Attach to an existing user tmux pane (not a bmx-* session).
   * Used by adopt mode — Botmux observes an already-running CLI.
   *
   * Zooms the target pane so only it is visible (hides other panes in the window).
   * The zoom is undone when the backend is killed (detach/disconnect).
   */
  attachToExisting(tmuxTarget: string, opts: SpawnOpts): void {
    this.reattaching = true;
    this.adoptedPaneTarget = tmuxTarget;

    // Zoom the target pane BEFORE attaching — this makes the pane fill the entire
    // window, so the PTY output (and web terminal) only shows this one pane.
    // If the pane is already the only one in the window, zoom is a no-op.
    try {
      execSync(`tmux resize-pane -Z -t ${shellescape(tmuxTarget)}`, { stdio: 'ignore' });
    } catch { /* pane may not support zoom (single pane) — benign */ }

    this.process = pty.spawn('tmux', ['attach-session', '-t', tmuxTarget], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
  }

  /** Tmux pane target when in adopt mode (e.g. "0:2.0") — used for zoom cleanup. */
  private adoptedPaneTarget: string | null = null;

  getAttachInfo() {
    return { type: 'tmux' as const, sessionName: this.sessionName };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Env vars that must be explicitly passed to the tmux session command via -e.
 * The tmux server inherits env from the first session's creator; subsequent
 * sessions share that env. Per-bot vars (LARK credentials) would be wrong
 * for non-first bots without explicit passthrough.
 */
const TMUX_PASSTHROUGH_VARS = [
  'BOTMUX',
  'LARK_APP_ID',
  'LARK_APP_SECRET',
  '__OWNER_OPEN_ID',
  'SESSION_DATA_DIR',
];

/** Minimal shell-escape for tmux session names (alphanumeric + dash). */
function shellescape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
