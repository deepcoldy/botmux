import * as pty from 'node-pty';
import { execSync, execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SessionBackend, SpawnOpts, SessionProbe } from './types.js';
import { probeTmuxFunctional, tmuxEnv } from '../../setup/ensure-tmux.js';
import { REDACTED_CHILD_ENV_KEYS } from '../../utils/child-env.js';
import { sanitizePerBotEnv } from '../../core/per-bot-env.js';
import { logger } from '../../utils/logger.js';
import { isExecutable } from '../../utils/executable.js';

/**
 * `unset KEY KEY ...` clause spliced into the shell wrapper before exec. The
 * new tmux pane inherits the tmux *server's* global environment, which the
 * (redacted) client env can't override — so if the server was ever started
 * with bare LARK_APP_* in scope (pre-upgrade botmux, or the user's own tmux),
 * those values reach the CLI despite redactChildEnv(). Unsetting them in the
 * wrapper shell removes them for this pane only, without touching the server
 * global env. Key names are fixed identifiers — no shell-escaping needed.
 */
const REDACTED_ENV_UNSET_CLAUSE = `unset ${REDACTED_CHILD_ENV_KEYS.join(' ')}`;

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
  /** Tmux pane target when in adopt mode (e.g. "0:2.0") — set by attachToExisting.
   *  When non-null, ALL pane-scoped tmux commands (send-keys / paste-buffer /
   *  copy-mode / list-panes) must address this pane explicitly; using
   *  `this.sessionName` would either resolve nothing (the name is synthetic
   *  in adopt mode) or fall through to whichever pane tmux happens to have
   *  active, which is exactly the bug we're avoiding. */
  private adoptedPaneTarget: string | null = null;

  constructor(sessionName: string, opts?: { ownsSession?: boolean }) {
    this.sessionName = sessionName;
    this.ownsSession = opts?.ownsSession ?? true;
  }

  /** Target string to use for pane-scoped tmux commands. In adopt mode this
   *  is the real pane address ("0:2.0"); otherwise the bmx-* session name. */
  private get cmdTarget(): string {
    return this.adoptedPaneTarget ?? this.sessionName;
  }

  // ─── Static helpers ───────────────────────────────────────────────────────

  /**
   * Check if tmux is usable — runs a functional probe (start + kill a
   * disposable server), not just `tmux -V`. Same probe as config.ts so
   * backend selection and runtime guard agree.
   */
  static isAvailable(): boolean {
    return probeTmuxFunctional().ok;
  }

  /** Derive tmux session name from a session UUID. */
  static sessionName(sessionId: string): string {
    return `bmx-${sessionId.slice(0, 8)}`;
  }

  /**
   * Name of the parked crash-diagnostic shell session. DISTINCT from
   * {@link sessionName} on purpose: the diagnostic shell must never collide with
   * the live CLI's backing-session name, or restore/cold-resume/`botmux resume`
   * would reattach the bare shell as if it were the CLI. Stays `bmx-`-prefixed
   * so adopt-discovery still skips it.
   */
  static diagnosticSessionName(sessionId: string): string {
    return `bmx-diag-${sessionId.slice(0, 8)}`;
  }

  /** Check if a named tmux session exists. */
  static hasSession(name: string): boolean {
    return TmuxBackend.probeSession(name) === 'exists';
  }

  /**
   * Tri-state existence probe. `tmux has-session` exits 0 when the session
   * exists and exits 1 (clean status, no signal) when the server answered but
   * the session is absent — INCLUDING "no server running". Both collapse to
   * 'missing' here. The caller MUST disambiguate before treating 'missing' as a
   * destructive signal: a single gone pane (server still up) is a true zombie,
   * but "no server running" means the *whole* server died (e.g. machine reboot)
   * and every pane vanished at once — those sessions are still resumable from
   * the CLI transcript on disk. Use `serverState()` to tell the two apart (the
   * restore path does exactly this). Anything else — a timeout (signal/killed)
   * or a spawn failure (binary not on PATH → ENOENT, not executable → EACCES;
   * neither carries a numeric exit status) — means we never got an answer →
   * 'unknown', so a flaky/unavailable tmux can't be mistaken for a gone session.
   *
   * Uses execFileSync (NOT a shell string): running tmux directly keeps a
   * missing/unrunnable binary as ENOENT/EACCES. A shell would instead surface
   * those as its own clean exits 127/126, which this classifier would wrongly
   * read as 'missing' and then drive a destructive restore-time close.
   */
  static probeSession(name: string): SessionProbe {
    try {
      execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore', env: tmuxEnv(), timeout: 3000 });
      return 'exists';
    } catch (e: any) {
      if (e && typeof e.status === 'number' && !e.signal) return 'missing';
      return 'unknown';
    }
  }

  /**
   * Tri-state liveness of the tmux SERVER itself (not a specific session).
   *
   *   - 'running' — `tmux list-sessions` exited 0, so the server is up with ≥1
   *                 session. (A tmux server with zero sessions doesn't exist —
   *                 it self-terminates when its last session closes — so exit 0
   *                 is an authoritative "server alive".)
   *   - 'down'    — clean non-zero exit (no signal): "no server running on …".
   *                 Every pane the server held is gone *at once*.
   *   - 'unknown' — timeout / signal / spawn failure (ENOENT/EACCES): no answer.
   *
   * Why this matters: `probeSession` returns 'missing' BOTH when the server is
   * up but one session is gone AND when the whole server is down (machine
   * reboot). Those are very different — a reboot wipes every bmx-* pane
   * simultaneously, but the CLI transcripts on disk are still resumable. The
   * restore path uses this to avoid mass-closing every session on the first
   * boot after a reboot (which would otherwise read each pane as an
   * authoritative 'missing' zombie and tear it down).
   */
  static serverState(): 'running' | 'down' | 'unknown' {
    try {
      execFileSync('tmux', ['list-sessions'], { stdio: 'ignore', env: tmuxEnv(), timeout: 3000 });
      return 'running';
    } catch (e: any) {
      if (e && typeof e.status === 'number' && !e.signal) return 'down';
      return 'unknown';
    }
  }

  /** Kill a named tmux session (no-op if it doesn't exist). */
  static killSession(name: string): void {
    try {
      execSync(`tmux kill-session -t ${shellescape(name)}`, { stdio: 'ignore', env: tmuxEnv() });
    } catch { /* session doesn't exist */ }
  }

  /** List all botmux tmux sessions (bmx-* prefix). */
  static listBotmuxSessions(): string[] {
    try {
      const out = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", {
        encoding: 'utf-8',
        env: tmuxEnv(),
      });
      return out.split('\n').filter(s => s.startsWith('bmx-'));
    } catch {
      return [];
    }
  }

  /**
   * Create a parked diagnostic session after a CLI has exited. The worker uses
   * this only after it has already captured the failed pane's output, so the
   * browser can still attach to `bmx-*` and see the startup error while daemon
   * auto-restart is paused.
   */
  static parkDiagnosticSession(name: string, opts: { cwd: string; cols: number; rows: number; contentPath: string }): boolean {
    try {
      TmuxBackend.killSession(name);
      const shellSpec = resolveUserShell();
      execFileSync('tmux', [
        'new-session',
        '-d',
        '-s', name,
        '-x', String(opts.cols),
        '-y', String(opts.rows),
        '--',
        shellSpec.shell, ...shellSpec.flags, '-c', DIAGNOSTIC_SHELL_SCRIPT, '_',
        opts.cwd,
        opts.contentPath,
        shellSpec.shell,
      ], {
        stdio: 'ignore',
        cwd: opts.cwd,
        env: tmuxEnv(),
        timeout: 5000,
      });
      configureTmuxSessionOptions(name);
      return true;
    } catch (err) {
      logger.warn(`[tmux:${name}] failed to park diagnostic session: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  // ─── SessionBackend implementation ────────────────────────────────────────

  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    this.reattaching = TmuxBackend.hasSession(this.sessionName);
    logger.debug(
      `[tmux:${this.sessionName}] spawn ${this.reattaching ? 'reattach' : 'new'} ` +
      `bin=${bin} args=${JSON.stringify(args)} cwd=${opts.cwd} ${opts.cols}x${opts.rows}`,
    );
    // Strip TMUX/TMUX_PANE from caller env before handing to pty.spawn — if
    // the daemon was started inside a tmux session, leaving TMUX set would
    // make this `tmux attach-session`/`new-session` target that parent
    // session's socket. After the user's terminal tmux dies, every call
    // here would print `error connecting to <stale-socket>` to the PTY and
    // flood the daemon log via the leaked-stderr path.
    const childEnv = tmuxEnv(opts.env);

    if (this.reattaching) {
      // Re-attach to surviving tmux session (CLI is still running)
      this.process = pty.spawn('tmux', ['attach-session', '-t', this.sessionName], {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: childEnv,
      });
    } else {
      // Run the CLI inside a fresh user shell so PATH / NVM_BIN / PNPM_HOME /
      // mise / fnm / asdf shims set up in the user's rcfiles are loaded the
      // way `coco` (or any other CLI) would see them if the user opened a
      // terminal and ran it themselves.
      //
      // Shape:
      //   tmux new-session -- <shell> <shellFlags> -c <SCRIPT> _ <cwd> KEY=VAL... bin args...
      //
      //   - <shell> + <shellFlags> come from resolveUserShell() and are
      //     bash/zsh/sh-specific (bash needs `-i` for .bashrc; zsh needs
      //     `-l -i` for .zprofile + .zshrc). fish/csh/nu are remapped to a
      //     POSIX fallback because our SCRIPT is POSIX-syntax.
      //   - SCRIPT = `cd -- "$1" && shift && unset <creds> && exec /usr/bin/env "$@"`:
      //       * `cd -- "$1"` returns to the session's intended cwd even if
      //         the rcfile changed directory mid-load (.zshrc/.bashrc with
      //         a `cd ~/work` left in by mistake stays in opts.cwd).
      //       * `unset LARK_APP_ID LARK_APP_SECRET CLAUDECODE`: the new pane
      //         inherits the tmux *server's* global env, which the redacted
      //         client env can't override — so unset the bare creds for this
      //         pane only (REDACTED_ENV_UNSET_CLAUSE; see redactChildEnv).
      //       * `exec /usr/bin/env "$@"`: env(1) parses the leading KEY=VAL
      //         pairs in argv as overrides for the child process. This lands
      //         AFTER rcfile load, so botmux's per-session values (e.g.
      //         BOTMUX_LARK_APP_ID, SESSION_DATA_DIR) win over same-named
      //         exports left in the user's .zshrc. Bare LARK_APP_* are NOT in
      //         the inject list — they're unset above, never re-added.
      //   - `_` is the $0 placeholder; the remaining argv items are seen as
      //     "$@" by the shell, so spaces / quotes / `$` / newlines in cwd,
      //     env values, or args never need shell-escaping.
      //   - tmux's own `-e KEY=VAL` is deliberately NOT used: it sets the
      //     session env (visible to the shell), which means the user's rcfile
      //     could `unset` or `export` over it before the CLI sees it. env(1)
      //     injection happens after rcfile load and is authoritative.
      const shellSpec = resolveUserShell(process.env, opts.launchShell);
      const envAssignments = buildBotmuxEnvAssignments(opts.env, opts.injectEnv);
      // Debug knob — when on, the wrapper does NOT `exec` the CLI; it runs the
      // CLI as a child and then drops into an interactive `$shell -i` so the
      // user can poke at PATH / NVM / pnpm in the web terminal after exiting
      // the CLI with Ctrl-C. Worker will still think the CLI is alive (it
      // can't see the child-vs-exec distinction), so don't send messages
      // through the bot while in this mode — type into the web terminal directly.
      const debugKeepShell = process.env.BOTMUX_DEBUG_KEEP_SHELL === '1';
      const script = debugKeepShell
        ? buildDebugKeepShellScript(shellSpec.shell)
        : SHELL_WRAPPER_SCRIPT;
      if (debugKeepShell) {
        logger.info(
          `[tmux:${this.sessionName}] BOTMUX_DEBUG_KEEP_SHELL=1 — CLI exit will drop ` +
          `to interactive ${shellSpec.shell} in the web terminal`,
        );
      }

      const tmuxArgs = [
        'new-session',
        '-s', this.sessionName,
        '-x', String(opts.cols),
        '-y', String(opts.rows),
        '--',
        shellSpec.shell, ...shellSpec.flags, '-c', script, '_',
        opts.cwd,
        ...envAssignments,
        bin, ...args,
      ];
      this.process = pty.spawn('tmux', tmuxArgs, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: childEnv,
      });
    }

    // Configure tmux session options.
    // Runs for BOTH new sessions and reattach — reattach needs this to
    // backfill options added after the session was originally created.
    // Setting an already-applied option is idempotent.
    setTimeout(() => {
      configureTmuxSessionOptions(this.sessionName);
    }, 500);
  }

  /** Whether the last spawn() re-attached to an existing tmux session. */
  get isReattach(): boolean {
    return this.reattaching;
  }

  /** Claude Code session JSONL path — set by worker for claude-code sessions so
   *  the claude-code adapter can verify paste+Enter submissions via file growth. */
  claudeJsonlPath?: string;
  /** PID of the spawned Claude Code child — used by the claude-code adapter to
   *  follow Claude's authoritative session id via ~/.claude/sessions/<pid>.json. */
  cliPid?: number;
  /** Working directory the CLI was spawned in — cross-checked against the pid
   *  file's cwd field so a recycled PID can't mislead the resolver. */
  cliCwd?: string;

  write(data: string): void {
    this.process?.write(data);
  }

  /**
   * Send text literally to the tmux pane via `tmux send-keys -l`.
   * Uses execFileSync (no shell) so arbitrary text is safe — no escaping needed.
   * For multiline text, use pasteText() instead (send-keys -l sends \n as Enter).
   */
  sendText(text: string): void {
    this.exitCopyModeIfNeeded();
    execFileSync('tmux', ['send-keys', '-t', this.cmdTarget, '-l', '--', text], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  /** Send special keys (Enter, Escape, C-c, etc.) to the tmux pane. */
  sendSpecialKeys(...keys: string[]): void {
    this.exitCopyModeIfNeeded();
    execFileSync('tmux', ['send-keys', '-t', this.cmdTarget, ...keys], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  /**
   * Enter copy-mode on the pane (`-e` makes it auto-exit when scrolled back to
   * the bottom). Lets us use tmux's own scrollback even when the running app
   * is in the alternate screen buffer (Claude Code, vim, etc.).
   */
  enterCopyMode(): void {
    execFileSync('tmux', ['copy-mode', '-e', '-t', this.cmdTarget], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  /** Send a copy-mode X-command (e.g. 'halfpage-up', 'halfpage-down', 'cancel'). */
  sendCopyModeCommand(xCommand: string): void {
    execFileSync('tmux', ['send-keys', '-t', this.cmdTarget, '-X', xCommand], {
      stdio: 'ignore',
      timeout: 5000,
      env: tmuxEnv(),
    });
  }

  /**
   * Paste text into the tmux pane via load-buffer + paste-buffer.
   * The -p flag asks tmux to insert bracketed-paste markers
   * (\e[200~ … \e[201~) when the application has requested bracketed paste,
   * so TUI apps (CoCo/Ink, etc.) can detect paste boundaries reliably.
   * Safe for multiline content (unlike sendText where \n becomes Enter).
   */
  pasteText(text: string): void {
    this.exitCopyModeIfNeeded();
    const bufferName = `botmux-${randomBytes(8).toString('hex')}`;
    let loaded = false;
    try {
      execFileSync('tmux', ['load-buffer', '-b', bufferName, '-'], {
        input: text,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeout: 5000,
        env: tmuxEnv(),
      });
      loaded = true;
      execFileSync('tmux', ['paste-buffer', '-b', bufferName, '-t', this.cmdTarget, '-d', '-p'], {
        stdio: 'ignore',
        timeout: 5000,
        env: tmuxEnv(),
      });
      loaded = false;
    } finally {
      if (loaded) {
        try {
          execFileSync('tmux', ['delete-buffer', '-b', bufferName], {
            stdio: 'ignore',
            timeout: 1000,
            env: tmuxEnv(),
          });
        } catch { /* best-effort cleanup after a failed paste */ }
      }
    }
  }

  private exitCopyModeIfNeeded(): void {
    try {
      const inMode = execFileSync('tmux', ['display-message', '-p', '-t', this.cmdTarget, '#{pane_in_mode}'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
        env: tmuxEnv(),
      }).trim();

      if (inMode === '1') {
        execFileSync('tmux', ['send-keys', '-t', this.cmdTarget, '-X', 'cancel'], {
          stdio: 'ignore',
          timeout: 1000,
          env: tmuxEnv(),
        });
      }
    } catch {
      // Pane may be gone or tmux may be restarting; keep the original write path best-effort.
    }
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
      // display-message resolves the *exact* target pane (single line out),
      // unlike list-panes which returns every pane in the target's window
      // when cmdTarget is a pane address — taking the first line of that
      // would silently bind to whichever pane tmux happens to list first.
      const output = execSync(
        `tmux display-message -p -t ${shellescape(this.cmdTarget)} '#{pane_pid}'`,
        // Explicit stdio: execSync's default leaks the child's stderr to the
        // parent's stderr fd. When tmux server is unavailable (transient
        // restart, killed by user, /tmp wiped), this command writes "error
        // connecting to /tmp/tmux-UID/default" to stderr, which the daemon's
        // worker.stderr handler then logs as a worker error every poll cycle.
        // tmuxEnv() also strips $TMUX so we don't target a dead parent server.
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000, env: tmuxEnv() },
      ).trim();
      const pid = parseInt(output, 10);
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
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: tmuxEnv() },
        ).trim();
        if (zoomed === '1') {
          execSync(`tmux resize-pane -Z -t ${shellescape(this.adoptedPaneTarget)}`, { stdio: 'ignore', env: tmuxEnv() });
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
    //
    // We intentionally attach to the source session directly rather than
    // creating a grouped viewer session: in tmux -CC + iTerm2 control mode
    // the extra session disrupts the integration's window/pane bookkeeping
    // and tearing it down on disconnect breaks the user's original layout
    // (iTerm splits one source window's panes into separate native windows).
    // The downside is the web terminal will follow whichever window the
    // user's primary -CC client is currently focused on; that stickiness
    // can be revisited later via `tmux pipe-pane` (out-of-band capture)
    // without polluting the -CC client.
    try {
      execSync(`tmux resize-pane -Z -t ${shellescape(tmuxTarget)}`, { stdio: 'ignore', env: tmuxEnv() });
    } catch { /* benign */ }

    this.process = pty.spawn('tmux', ['attach-session', '-t', tmuxTarget], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: tmuxEnv(opts.env),
    });
  }

  getAttachInfo() {
    return { type: 'tmux' as const, sessionName: this.sessionName };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The minimal set of env vars that botmux must inject into the CLI process
 * itself — values that user rcfiles cannot derive on their own (the namespaced
 * Lark app id for `botmux ask`, the daemon-assigned data directory, the BOTMUX
 * marker, the Claude root-mode escape hatch, the session owner's open_id).
 *
 * NOTE: the bot's bare `LARK_APP_ID` / `LARK_APP_SECRET` are deliberately NOT
 * here — the child must not see them (a CLI's own Lark OAuth would be hijacked
 * by the botmux IM app; see worker.ts redactChildEnv). The child resolves Lark
 * via the namespaced `BOTMUX_LARK_APP_ID` below or via bots.json on disk.
 *
 * Anything outside this list (PATH, HOME, NVM_BIN, PNPM_HOME, LANG, …) is
 * deliberately NOT forwarded from the daemon — the wrapping `$SHELL -l -i`
 * pass loads the user's rcfiles, and whatever they set is what the CLI sees.
 * This matches the user's mental model: "the tmux session should be like a
 * fresh terminal where the user runs the CLI manually."
 *
 * These values are injected via `/usr/bin/env KEY=VAL ... cli args` (not tmux
 * `-e`) so they land *after* rcfile load and override any leftover same-named
 * exports in the user's rcfile.
 */
const BOTMUX_INJECTED_ENV_KEYS = [
  '__OWNER_OPEN_ID',
  'BOTMUX',
  'SESSION_DATA_DIR',
  'IS_SANDBOX',
  // §5 of botmux ask v0.1.7: `botmux ask buttons` / `botmux hook <cli>` read
  // these to locate the daemon, route the card back to this thread, and
  // resolve approvers from session.owner. Without them, the hook client falls
  // back to passthrough and the agent never reaches the Lark card.
  'BOTMUX_SESSION_ID',
  'BOTMUX_CHAT_ID',
  'BOTMUX_LARK_APP_ID',
  'BOTMUX_ROOT_MESSAGE_ID',
  'BOTMUX_TURN_ID',
  // Experimental Lark chat bot discovery. The daemon injects a canonical
  // true/false value so `botmux bots list` inside long-lived panes matches the
  // daemon's `<available_bots>` behavior instead of reading stale rcfile/tmux env.
  'BOTMUX_LARK_LIST_BOTS_API_ENABLED',
  'BOTMUX_LARK_LIST_BOTS_API_TIMEOUT_MS',
  // Claude Code 2.1.x resume-summary 菜单的抑制阈值（issue #62）。worker 为
  // claude-code 注入一个极大值绕过菜单；只有进了这条白名单才会被透传进 tmux pane。
  'CLAUDE_CODE_RESUME_TOKEN_THRESHOLD',
  // Seed CLI（Claude Code fork）的数据根目录。worker 为 seed 注入它指向 seed 自己的
  // `.claude-runtime`，bridge 才能盯对文件；不进白名单 tmux pane 就拿不到。
  'CLAUDE_CONFIG_DIR',
  // cjadk wrapperCli（`cjadk <agent>`）启动时 worker 注入 `0`，让 cjadk 跑非交互模式
  // （跳过启动选择器、清掉吃首条/碎裂多行的输入怪癖），对齐 cjadk 官方 `cjadk feishu`
  // wrapper。只有 cjadk 启动会被设上此值，其它 bot 不带 → 不进白名单 tmux pane 拿不到，
  // cjadk 就回到交互模式（本次 bug 的根因）。
  'CJADK_INTERACTIVE',
] as const;

/**
 * Build the `KEY=VAL` argv slice passed to `/usr/bin/env`. Only forwards the
 * keys in `BOTMUX_INJECTED_ENV_KEYS` and only when the value is defined —
 * `IS_SANDBOX` for instance is only set when the daemon is running as root.
 * Pure function for unit-testing without spawning tmux.
 */
export function buildBotmuxEnvAssignments(
  env: NodeJS.ProcessEnv | undefined,
  injectEnv?: Record<string, string>,
): string[] {
  const out: string[] = [];
  if (env) {
    for (const key of BOTMUX_INJECTED_ENV_KEYS) {
      const val = env[key];
      if (val === undefined) continue;
      out.push(`${key}=${val}`);
    }
  }
  // Per-bot env (bots.json `env`): appended AFTER the botmux-managed keys so a
  // bot's provider creds win over any same-named leftover, and emitted ONLY
  // here (the per-pane `/usr/bin/env` prefix) — never via the tmux client env —
  // so they don't pollute the shared server global and leak across bots. These
  // are argv items consumed as `"$@"` by the shell wrapper, so values with
  // spaces / quotes / `$` need no escaping. Re-sanitized defensively (the value
  // crossed an IPC boundary from the daemon).
  if (injectEnv) {
    for (const [key, val] of Object.entries(sanitizePerBotEnv(injectEnv))) {
      out.push(`${key}=${val}`);
    }
  }
  return out;
}

/**
 * Default wrapper script for `<shell> -c`. Sees argv as:
 *   $0 = '_' (placeholder), $1 = cwd, $2..N = KEY=VAL... bin args...
 *
 * The `cd` step makes the CLI's cwd survive a wayward `cd` in the user's
 * rcfile. The `unset` step removes bare creds the pane inherited from the tmux
 * server's global env (REDACTED_ENV_UNSET_CLAUSE). The `exec /usr/bin/env` step
 * injects botmux's per-bot/per-session overrides AFTER rcfile load so they
 * can't be shadowed by leftover exports.
 *
 * POSIX-syntax (works in bash/zsh/sh); fish/csh/nu users get remapped to
 * bash/zsh/sh by resolveUserShell() so they hit the same SCRIPT path.
 */
export const SHELL_WRAPPER_SCRIPT = `cd -- "$1" && shift && ${REDACTED_ENV_UNSET_CLAUSE} && exec /usr/bin/env "$@"`;

export const DIAGNOSTIC_SHELL_SCRIPT = [
  'cd -- "$1" 2>/dev/null || cd "$HOME" 2>/dev/null || cd /',
  REDACTED_ENV_UNSET_CLAUSE,
  'clear',
  `printf '\\033[1;31m[botmux] Agent CLI exited. Auto-restart is paused and the last terminal output is preserved below.\\033[0m\\n\\n'`,
  'cat -- "$2" 2>/dev/null || true',
  `printf '\\n\\033[1;33m[botmux] Fix the startup error, then send a new message to retry. Type exit to close this diagnostic shell.\\033[0m\\n'`,
  'exec "$3" -i',
].join('; ');

/**
 * Debug variant of the wrapper script — same prelude, but the CLI runs as
 * a *child* (no `exec`) and the wrapper hands off to an interactive shell
 * once the CLI exits. Useful for diagnosing missing PATH / NVM / pnpm /
 * mise shims in the user's rcfile: hit Ctrl-C in the web terminal, land
 * in `<shell> -i`, run `echo $PATH` / `which node` / etc.
 *
 * Enabled with `BOTMUX_DEBUG_KEEP_SHELL=1` at daemon-start time.
 *
 * `shellPath` is single-quoted into the script with `'` escaped, so it's
 * safe for paths containing spaces or quotes. Caller has already verified
 * it via accessSync().
 */
export function buildDebugKeepShellScript(shellPath: string): string {
  const safeShell = shellPath.replace(/'/g, `'\\''`);
  return [
    'cd -- "$1" && shift',
    // Same redaction as SHELL_WRAPPER_SCRIPT — so neither the CLI nor the
    // interactive debug shell that follows sees server/rcfile-inherited creds.
    REDACTED_ENV_UNSET_CLAUSE,
    '/usr/bin/env "$@"',
    `printf '\\n[botmux debug] CLI exited (status %d) — interactive shell active. Type exit to close the session.\\n' "$?" >&2`,
    `exec '${safeShell}' -i`,
  ].join('; ');
}

export type ShellKind = 'bash' | 'zsh' | 'sh';

export interface ShellSpec {
  /** Absolute path to the shell binary. */
  shell: string;
  /** Rcfile-loading flags (`-i`, `-l -i`, or empty) — caller appends
   *  `-c <SCRIPT> _ <cwd> KEY=VAL... bin args...` after these. */
  flags: string[];
}

/** Map a shell kind to the right rcfile-loading flags. The choice of flags
 *  is the part that actually differs between bash and zsh:
 *   - bash login shell does NOT auto-source .bashrc; many users only have
 *     nvm/fnm/pnpm hooks in .bashrc; using `-l` here would miss them.
 *     Plain `-i` loads .bashrc, which is what we want.
 *   - zsh interactive shell loads .zshrc; login loads .zprofile + .zlogin.
 *     Combine `-l -i` so installs in either location surface.
 *   - sh has no rcfile we can rely on portably; skip rcfile flags. */
function specForKind(shell: string, kind: ShellKind): ShellSpec {
  const flags: string[] = [];
  if (kind === 'bash') flags.push('-i');
  else if (kind === 'zsh') flags.push('-l', '-i');
  // 'sh' adds nothing — POSIX sh has no portable interactive rcfile.
  return { shell, flags };
}

function configureTmuxSessionOptions(sessionName: string): void {
  try {
    const t = shellescape(sessionName);
    const env = tmuxEnv();
    // status bar ON — see TmuxPipeBackend.applySessionOptions for the rationale:
    // shows the window list to a user who manually `tmux attach`es, and is a
    // client-level overlay that never enters the pane stream the card / web
    // terminal capture, so it has zero effect on them.
    execSync(`tmux set-option -t ${t} status on`, { stdio: 'ignore', env });
    execSync(`tmux set-option -t ${t} mouse on`, { stdio: 'ignore', env });
    // set-clipboard is a server option — enable OSC 52 passthrough for web copy
    execSync(`tmux set-option -s set-clipboard on`, { stdio: 'ignore', env });
    execSync(`tmux set-option -t ${t} history-limit 50000`, { stdio: 'ignore', env });
    // Prevent web terminal clients (smaller viewport) from shrinking the
    // tmux window. If a web client at 80x24 causes tmux to resize the window
    // down, reflowed content shifts buffer positions and historical output
    // leaks into the streaming card.
    execSync(`tmux set-option -t ${t} window-size largest`, { stdio: 'ignore', env });
  } catch { /* session may not be ready yet — benign */ }
}

/** Classify a shell binary path by basename. Returns null for shells whose
 *  syntax we don't support (fish, nu, csh, tcsh, ...). */
function classifyShell(path: string): ShellKind | null {
  const base = basename(path);
  if (base === 'bash') return 'bash';
  if (base === 'zsh') return 'zsh';
  if (base === 'sh' || base === 'dash' || base === 'ash') return 'sh';
  return null;
}

/**
 * Resolve a per-bot `launchShell` override (BotConfig.launchShell) to an
 * absolute, executable, classifiable shell path. Accepts either an absolute
 * path (`/usr/bin/zsh`) or a bare name (`zsh`) — the latter is searched in the
 * conventional shell locations. Returns null when the override can't be honored
 * (not found / not executable / unsupported syntax like fish), so the caller
 * falls back to the normal `$SHELL` resolution with a warning.
 *
 * The override is the escape hatch for users whose login `$SHELL` (e.g. bash)
 * has an rcfile that `exec`-trampolines into another shell: pinning
 * `launchShell: zsh` makes botmux launch the CLI under zsh directly, sidestepping
 * the bash `.bashrc` `exec zsh` entirely. (Caveat surfaced in docs: PATH/nvm/pnpm
 * must then live in the pinned shell's rcfiles, not the bypassed one.)
 */
export function resolveShellOverride(override: string): ShellSpec | null {
  const raw = override.trim();
  if (!raw) return null;
  const candidates = raw.includes('/')
    ? [raw]
    : [`/bin/${raw}`, `/usr/bin/${raw}`, `/usr/local/bin/${raw}`, `/opt/homebrew/bin/${raw}`];
  for (const candidate of candidates) {
    if (!isExecutable(candidate)) continue;
    const kind = classifyShell(candidate);
    if (!kind) {
      logger.warn(
        `[tmux-backend] launchShell=${override} resolved to ${candidate} which is not bash/zsh/sh; ` +
        `ignoring override (our POSIX wrapper would break under it).`,
      );
      return null;
    }
    return specForKind(candidate, kind);
  }
  logger.warn(`[tmux-backend] launchShell=${override} not found/executable; ignoring override.`);
  return null;
}

/**
 * Pick a shell to wrap the CLI launch in, returning the binary path plus the
 * exact argv flags needed for its rcfiles to load. A per-bot `launchShell`
 * override wins when it resolves; otherwise tries `$SHELL` first, then
 * `/bin/zsh` → `/bin/bash` → `/bin/sh`.
 *
 * If `$SHELL` is fish/nu/csh/etc., emits a warning and falls back to a POSIX
 * shell — our wrapper SCRIPT is POSIX-syntax and would break under fish. The
 * user can still configure their CLI's PATH/etc. inside the fallback shell's
 * rcfile if needed; the alternative (run their fish rcfile under a POSIX
 * harness) does not work.
 *
 * Always returns a usable ShellSpec — the last-resort `/bin/sh` fallback is
 * close enough to universal that surfacing an error here would do more harm
 * than good. If `/bin/sh` is also missing, tmux's own spawn will fail with
 * a clear message.
 */
export function resolveUserShell(env: NodeJS.ProcessEnv = process.env, override?: string): ShellSpec {
  if (override) {
    const spec = resolveShellOverride(override);
    if (spec) return spec;
    // override unusable (not found / unsupported) → fall through to $SHELL.
  }
  const userShell = env.SHELL;
  if (userShell && isExecutable(userShell)) {
    const kind = classifyShell(userShell);
    if (kind) return specForKind(userShell, kind);
    logger.warn(
      `[tmux-backend] $SHELL=${userShell} is not bash/zsh/sh; ` +
      `falling back to a POSIX shell for the wrapper. ` +
      `Configure CLI PATH/env in the fallback shell's rcfile if needed.`,
    );
  }
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh'] as const) {
    if (!isExecutable(candidate)) continue;
    const kind = classifyShell(candidate);
    if (!kind) continue;
    return specForKind(candidate, kind);
  }
  // /bin/sh missing too — return it anyway and let tmux surface the error.
  return specForKind('/bin/sh', 'sh');
}

/** Minimal shell-escape for tmux session names (alphanumeric + dash). */
function shellescape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
