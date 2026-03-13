import * as pty from 'node-pty';
import { execSync } from 'node:child_process';
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
  private reattaching = false;

  constructor(sessionName: string) {
    this.sessionName = sessionName;
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

      // Configure tmux session for web terminal use:
      //  - status off: avoid cursor-positioning noise in xterm.js
      //  - mouse on: let tmux handle scroll wheel → copy mode for scrollback
      //  - history-limit: large scrollback buffer (tmux default is 2000)
      setTimeout(() => {
        try {
          const t = shellescape(this.sessionName);
          execSync(`tmux set-option -t ${t} status off`, { stdio: 'ignore' });
          execSync(`tmux set-option -t ${t} mouse on`, { stdio: 'ignore' });
          execSync(`tmux set-option -t ${t} history-limit 50000`, { stdio: 'ignore' });
        } catch { /* session may not be ready yet — benign */ }
      }, 500);
    }
  }

  /** Whether the last spawn() re-attached to an existing tmux session. */
  get isReattach(): boolean {
    return this.reattaching;
  }

  write(data: string): void {
    this.process?.write(data);
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

  /** Detach only — kills the pty viewer but leaves tmux session alive. */
  kill(): void {
    if (this.process) {
      try { this.process.kill(); } catch { /* already dead */ }
      this.process = null;
    }
  }

  /** Kill the tmux session permanently. Called on explicit /close. */
  destroySession(): void {
    this.kill();
    TmuxBackend.killSession(this.sessionName);
  }

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
  'LARK_APP_ID',
  'LARK_APP_SECRET',
  '__OWNER_OPEN_ID',
  'SESSION_DATA_DIR',
];

/** Minimal shell-escape for tmux session names (alphanumeric + dash). */
function shellescape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
