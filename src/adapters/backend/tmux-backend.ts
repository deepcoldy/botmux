import * as pty from 'node-pty';
import { execSync, execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SessionBackend, SpawnOpts, SessionProbe } from './types.js';
import { probeTmuxFunctional, scrubTmuxServerGlobalEnv, tmuxEnv } from '../../setup/ensure-tmux.js';
import { BOTMUX_INJECTED_ENV_KEYS, PROXY_ENV_KEYS, REDACTED_CHILD_ENV_KEYS } from '../../utils/child-env.js';
import { sanitizePerBotEnv } from '../../core/per-bot-env.js';
import { logger } from '../../utils/logger.js';
import { isExecutable } from '../../utils/executable.js';
import { resolveBotmuxWrapperBinDir } from '../../core/botmux-wrapper.js';

/**
 * `unset KEY KEY ...` clause spliced into the shell wrapper before exec. The
 * new tmux pane inherits the tmux *server's* global environment, which the
 * client env can't override — so if the server was ever started with stale
 * botmux routing/profile values or bare LARK_APP_* creds in scope, those values
 * reach the CLI. Unsetting the complete managed allowlist in the wrapper shell
 * removes them for this pane only before current values are re-injected. Key
 * names are fixed identifiers — no shell-escaping needed.
 */
const PANE_ENV_UNSET_KEYS = [...new Set([
  ...REDACTED_CHILD_ENV_KEYS,
  ...BOTMUX_INJECTED_ENV_KEYS,
])];
const PANE_ENV_UNSET_CLAUSE = `unset ${PANE_ENV_UNSET_KEYS.join(' ')}`;
const FISH_PANE_ENV_UNSET_CLAUSE = `set -e ${PANE_ENV_UNSET_KEYS.join(' ')}`;

/** Guard so the fallback self-heal runs at most once in this worker process. */
let serverGlobalEnvScrubbed = false;

/**
 * True when a tmux client's stderr reports a CONNECTION-level failure — the
 * client never got an answer from the shared server, so the error proves
 * nothing about any particular session/pane:
 *   - "error connecting to <socket> (Connection refused)" — Linux fails
 *     unix-socket connect() with an INSTANT clean ECONNREFUSED when the
 *     server's accept backlog overflows. A busy-but-alive server (stalled a
 *     couple of seconds under load while hundreds of workers probe it every
 *     second) mass-produces exactly this error.
 *   - "error connecting to <socket> (No such file or directory)" — socket file
 *     missing (server down, or the file was cleaned from /tmp under a live
 *     server).
 *   - "lost server" / "server exited unexpectedly" — the connection died
 *     mid-command.
 *
 * Probes must classify these as 'unknown', NEVER as an authoritative
 * 'missing': on 2026-08-20 a few seconds of backlog overflow on the default
 * server made every worker's liveness probe read clean-exit "error connecting"
 * as "pane gone", and the daemon tore down / force-FRESHed dozens of live
 * sessions across all bots simultaneously.
 *
 * Deliberately NOT matched: "no server running on <socket>" — the client did
 * determine that no server owns the socket, and a not-running server provably
 * has no sessions, so that one stays an authoritative 'missing'.
 */
export function isTmuxServerLevelErrorText(stderrText: string): boolean {
  return /error connecting to|lost server|server exited unexpectedly/i.test(stderrText);
}

/**
 * True when a thrown exec*Sync error represents the caller's own `timeout`
 * deadline firing — regardless of the exit-status shape Node attached.
 *
 * Node reports a spawnSync timeout as `error.code === 'ETIMEDOUT'` while ALSO
 * reporting whatever the child managed to do around the kill. Normally the
 * child dies from the kill signal (`status: null, signal: 'SIGTERM'`), but
 * under heavy load the client can complete and exit cleanly in the same window
 * the deadline fires — the throw then carries `status: 0/1, signal: null` PLUS
 * the ETIMEDOUT error. 2026-08-23: exactly that shape escaped every
 * "clean numeric exit ⇒ the server answered deterministically" classifier
 * during a post-outage mass cold-restart (261 sessions rebuilt in ~40s after
 * the shared server died): `new-session` had actually succeeded server-side,
 * but the launch was classified as a deterministic rejection, not retried, and
 * the worker died user-visibly ("会话启动失败: spawnSync tmux ETIMEDOUT").
 *
 * A deadline is NEVER an authoritative server answer. Every tmux classifier
 * must check this BEFORE any status-shape branch.
 */
export function isExecTimeoutError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null | undefined)?.code === 'ETIMEDOUT';
}

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
   * the session is absent — including "no server running" (a not-running server
   * provably has no sessions). 'missing' is NOT a destructive signal on restore:
   * whether a single pane died (solo crash) or the whole server is gone (machine
   * reboot), the CLI transcript on disk is still resumable, so restore keeps the
   * session active and cold-resumes it on the next message (see
   * restoreActiveSessions).
   *
   * A clean non-zero exit whose stderr is a CONNECTION-level failure ("error
   * connecting to <socket>", "lost server", …) is 'unknown', not 'missing': the
   * client never reached the server, so it proved nothing about this session.
   * Linux fails unix-socket connect() with instant ECONNREFUSED when the
   * server's accept backlog overflows — a busy-but-alive shared server briefly
   * looks exactly like this, and 2026-08-20 that misread made kill-verify /
   * liveness paths treat dozens of live sessions as gone at once.
   * Anything else — a timeout (signal/killed) or a spawn failure (binary not on
   * PATH → ENOENT, not executable → EACCES; neither carries a numeric exit
   * status) — also means we never got an answer → 'unknown'.
   *
   * Uses execFileSync (NOT a shell string): running tmux directly keeps a
   * missing/unrunnable binary as ENOENT/EACCES. A shell would instead surface
   * those as its own clean exits 127/126, which this classifier would wrongly
   * read as 'missing'.
   */
  static probeSession(name: string): SessionProbe {
    try {
      execFileSync('tmux', ['has-session', '-t', name], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: tmuxEnv(),
        timeout: 3000,
      });
      return 'exists';
    } catch (e: any) {
      // Deadline first: a timed-out client can surface a clean numeric exit
      // when its completion races the kill (see isExecTimeoutError) — that is
      // still "no answer", never an authoritative 'missing'.
      if (isExecTimeoutError(e)) return 'unknown';
      if (e && typeof e.status === 'number' && !e.signal) {
        const stderrText = (e.stderr?.toString?.() ?? '').trim();
        if (isTmuxServerLevelErrorText(stderrText)) return 'unknown';
        return 'missing';
      }
      return 'unknown';
    }
  }

  /** Kill a named tmux session (no-op if it doesn't exist). */
  static killSession(name: string): void {
    try {
      // Runtime recovery calls this from many workers. Bound the command so a
      // wedged shared server cannot pin every worker forever; restart jitter
      // keeps the bounded attempts from landing simultaneously.
      execFileSync('tmux', ['kill-session', '-t', name], {
        stdio: 'ignore',
        timeout: 3000,
        env: tmuxEnv(),
      });
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
   * One-time self-heal: strip botmux-managed keys from the tmux SERVER's global
   * environment. A server booted by an upgraded botmux is already clean (tmuxEnv
   * strips the client env before `new-session`), but a server started by an
   * OLDER botmux — or one that has outlived many daemon restarts — still carries
   * a stale BOTMUX_SESSION_ID / BOTMUX_CHAT_ID / SESSION_DATA_DIR / … in its
   * global env. That leaks into every co-tenant session on the socket (the
   * user's own `tmux`), whose Claude Code then misroutes its AskUserQuestion
   * hook to the leaked thread.
   *
   * Scrubbing the global table does NOT touch already-running panes' process
   * environments — only panes created AFTER the scrub inherit the cleaned table
   * — so this is safe to run against a live server with active sessions: no
   * running bmx-* CLI is disturbed, and the user's next new pane comes up clean.
   * The daemon proactively runs the same repair at startup, even when there are
   * no active bmx-* sessions. This worker-local fallback covers standalone
   * backend use and a transient failure during daemon startup.
   */
  static scrubServerGlobalEnvOnce(): void {
    if (serverGlobalEnvScrubbed) return;
    serverGlobalEnvScrubbed = true;
    const result = scrubTmuxServerGlobalEnv();
    if (result.failed.length > 0) {
      logger.warn(`[tmux] failed to scrub server-global keys: ${result.failed.join(', ')}`);
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
      const shellKind = shellKindForPath(shellSpec.shell);
      execFileSync('tmux', [
        'new-session',
        '-d',
        '-s', name,
        '-x', String(opts.cols),
        '-y', String(opts.rows),
        '--',
        ...shellCommandArgv(shellSpec, diagnosticShellScript(shellKind), [
          opts.cwd,
          opts.contentPath,
          shellSpec.shell,
        ]),
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
    // Self-heal a server polluted by a pre-upgrade botmux before we touch it
    // (once per daemon process; no-op on a server this build booted clean).
    TmuxBackend.scrubServerGlobalEnvOnce();
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
      //   tmux new-session -- /usr/bin/env DISABLE_AUTO_UPDATE=true
      //     <shell> <shellFlags> -c <SCRIPT> [POSIX: _] <cwd> KEY=VAL... bin args...
      //
      //   - The env(1) prefix makes DISABLE_AUTO_UPDATE visible while the
      //     shell loads its rcfile, then SCRIPT unsets it before execing the
      //     CLI. This prevents oh-my-zsh's update prompt without changing the
      //     final CLI environment or running an unattended update.
      //   - <shell> + <shellFlags> come from resolveUserShell() and are
      //     shell-kind-specific (bash needs `-i`; zsh needs `-l -i`;
      //     fish needs `-i`; POSIX sh uses no flags).
      //   - SCRIPT is shell-kind-aware:
      //       * POSIX: `cd -- "$1" && shift && unset <managed> && exec /usr/bin/env "$@"`.
      //       * fish: `cd -- $argv[1]; set -e argv[1]; set -e <managed>; exec /usr/bin/env $argv`.
      //     Both return to the session's intended cwd even if the rcfile changed
      //     directory mid-load, clear inherited tmux server-global botmux keys,
      //     and inject this pane's KEY=VAL values only after rcfile startup.
      //   - POSIX shells require `_` as the $0 placeholder before cwd; fish sees
      //     argv directly and must omit that sentinel. In both contracts, spaces /
      //     quotes / `$` / newlines in cwd, env values, or args never need shell
      //     escaping because they travel as argv elements.
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
      // Host-resolve the wrapper bin dir from opts.env (BOTMUX_CORE_ONLY /
      // SESSION_DATA_DIR are scrubbed inside the pane before the script runs, so it
      // MUST be baked in host-side — codex P1). opts.env is the authoritative
      // per-session env the daemon assembled, not the scrubbed pane env.
      const wrapperBinDir = resolveBotmuxWrapperBinDir(opts.env ?? process.env);
      const shellKind = shellKindForPath(shellSpec.shell);
      const script = debugKeepShell
        ? buildDebugKeepShellScript(shellSpec.shell, wrapperBinDir, shellKind)
        : shellWrapperScript(wrapperBinDir, shellKind);
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
        ...shellCommandArgv(shellSpec, script, [
          opts.cwd,
          ...envAssignments,
          bin, ...args,
        ]),
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

  write(data: string): boolean {
    if (!this.process) return false;
    this.process.write(data);
    return true;
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
 * Env vars that must be set BEFORE the user's shell rcfile loads, so interactive
 * prompts during rcfile sourcing don't block the shell startup and prevent the
 * CLI from launching. These are injected as `env KEY=VAL shell -i -c '...'` so
 * the rcfile sees them while sourcing. oh-my-zsh's check_for_upgrade.sh reads
 * $DISABLE_AUTO_UPDATE before showing its "Would you like to update Oh My Zsh?
 * [Y/n]" prompt.
 *
 * DISABLE_AUTO_UPDATE=true makes the botmux-managed shell skip the update check
 * altogether. DISABLE_UPDATE_PROMPT is deliberately not used: oh-my-zsh maps it
 * to update_mode=auto, which would modify the user's installation without the
 * confirmation their normal prompt-mode shell requires. GIT_TERMINAL_PROMPT is
 * also deliberately untouched so git commands run by the eventual CLI preserve
 * the user's normal credential behavior.
 *
 * Why here and not in buildBotmuxEnvAssignments: those are injected via
 * `exec /usr/bin/env "$@"` which runs AFTER rcfile load — too late for an
 * oh-my-zsh update prompt that already blocked the shell. These must be in the
 * shell process's own environment when it starts, so they're visible to the
 * rcfile. Applied via `env(1)` prefix in shellLaunchArgv() so they work even
 * when the tmux server was already started by a different client.
 */
export const NON_INTERACTIVE_SHELL_ENV = [
  'DISABLE_AUTO_UPDATE=true',
  'BOTMUX_MANAGED_SHELL=1',
] as const;

/** Remove rcfile-only launch overrides before the managed CLI is exec'd. */
const NON_INTERACTIVE_SHELL_ENV_UNSET_CLAUSE =
  `unset ${NON_INTERACTIVE_SHELL_ENV.map(assignment => assignment.split('=', 1)[0]).join(' ')}`;
const FISH_NON_INTERACTIVE_SHELL_ENV_UNSET_CLAUSE =
  `set -e ${NON_INTERACTIVE_SHELL_ENV.map(assignment => assignment.split('=', 1)[0]).join(' ')}`;

/**
 * Build the argv prefix that launches the user's shell with non-interactive
 * env vars set BEFORE rcfile load. Returns:
 *   ['/usr/bin/env', 'DISABLE_AUTO_UPDATE=true', shell, ...flags]
 *
 * Backends splat this before `-c <SCRIPT> _ <cwd> KEY=VAL... bin args...`:
 *   tmux new-session ... -- /usr/bin/env DISABLE_AUTO_UPDATE=true <shell> <flags> -c <SCRIPT> _ ...
 *
 * The env(1) prefix sets the vars in the shell process's own environment so
 * the rcfile sees them during sourcing; they are NOT in the tmux server global
 * env (so they don't leak to the user's own interactive tmux sessions). The
 * wrapper removes them after rcfile load and before execing the CLI.
 */
export function shellLaunchArgv(shell: string, flags: string[]): string[] {
  return ['/usr/bin/env', ...NON_INTERACTIVE_SHELL_ENV, shell, ...flags];
}

export function shellCommandArgv(shell: ShellSpec, script: string, argv: readonly string[]): string[] {
  const kind = shellKindForPath(shell.shell);
  return [
    ...shellLaunchArgv(shell.shell, shell.flags),
    '-c',
    script,
    ...(kind === 'fish' ? argv : ['_', ...argv]),
  ];
}

/**
 * Build the `KEY=VAL` argv slice passed to `/usr/bin/env`. Only forwards the
 * centralized BOTMUX_INJECTED_ENV_KEYS allowlist and only when the value is
 * defined — `IS_SANDBOX` for instance is only set in sandboxed sessions.
 * Everything else (PATH, HOME, NVM, locale, …) comes from the user's rcfile.
 * Bare LARK_APP_* credentials are deliberately absent and remain redacted.
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
    // Proxy vars are not in BOTMUX_INJECTED_ENV_KEYS (which drives tmuxEnv
    // stripping + server-global scrub) — inject them explicitly here so the
    // CLI reaches the API even when the tmux server was started without proxy
    // in its global env, or the shell rcfile doesn't set them.
    for (const key of PROXY_ENV_KEYS) {
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
 * rcfile. The first `unset` step removes stale botmux-owned values the pane
 * inherited from the tmux server's global env; the second removes the
 * rcfile-only launch override before the CLI starts. The PATH prepend puts the
 * daemon-written wrapper dir (~/.botmux/bin, which holds THIS build's `botmux`)
 * ahead of any npm-global botmux the rcfile put earlier in PATH — otherwise the
 * agent's `botmux` could resolve to a stale build. Critical under read isolation:
 * only the wrapper build has the send-cred reader; a shadowing stale build can't
 * read bots.json (Seatbelt-denied) → `botmux send` fails "Bot not registered".
 * The `exec /usr/bin/env` step injects botmux's per-bot/per-session overrides
 * AFTER rcfile load so they can't be shadowed by leftover exports.
 *
 * POSIX-syntax by default (works in bash/zsh/sh). Pass `kind: "fish"` for the
 * fish-native argv/env variant.
 *
 * The wrapper bin dir is baked in as a HOST-RESOLVED LITERAL (codex P1): the pane
 * cannot resolve it at runtime because tmuxEnv + PANE_ENV_UNSET_CLAUSE scrub
 * BOTMUX_CORE_ONLY / SESSION_DATA_DIR BEFORE this script runs (and the argv env
 * assignments only land at the final `exec /usr/bin/env`, too late). So the daemon
 * computes it from opts.env via resolveBotmuxWrapperBinDir and single-quotes it in.
 */
export function shellWrapperScript(binDir: string, kind: ShellKind = 'sh'): string {
  if (kind === 'fish') return fishShellWrapperScript(binDir);
  const q = `'${binDir.replace(/'/g, `'\\''`)}'`;
  return `cd -- "$1" && shift && ${PANE_ENV_UNSET_CLAUSE} && ${NON_INTERACTIVE_SHELL_ENV_UNSET_CLAUSE} && export PATH=${q}:"$PATH" && exec /usr/bin/env "$@"`;
}

function fishShellWrapperScript(binDir: string): string {
  const q = fishSingleQuote(binDir);
  return [
    'cd -- $argv[1]; or exit',
    'set -e argv[1]',
    FISH_PANE_ENV_UNSET_CLAUSE,
    FISH_NON_INTERACTIVE_SHELL_ENV_UNSET_CLAUSE,
    `set -gx PATH ${q} $PATH`,
    'exec /usr/bin/env $argv',
  ].join('; ');
}

export const DIAGNOSTIC_SHELL_SCRIPT = [
  'cd -- "$1" 2>/dev/null || cd "$HOME" 2>/dev/null || cd /',
  PANE_ENV_UNSET_CLAUSE,
  'clear',
  `printf '\\033[1;31m[botmux] Agent CLI exited. Auto-restart is paused and the last terminal output is preserved below.\\033[0m\\n\\n'`,
  'cat -- "$2" 2>/dev/null || true',
  `printf '\\n\\033[1;33m[botmux] Fix the startup error, then send a new message to retry. Type exit to close this diagnostic shell.\\033[0m\\n'`,
  'exec "$3" -i',
].join('; ');

export function diagnosticShellScript(kind: ShellKind = 'sh'): string {
  if (kind !== 'fish') return DIAGNOSTIC_SHELL_SCRIPT;
  return [
    'cd -- $argv[1] 2>/dev/null; or cd $HOME 2>/dev/null; or cd /',
    FISH_PANE_ENV_UNSET_CLAUSE,
    FISH_NON_INTERACTIVE_SHELL_ENV_UNSET_CLAUSE,
    'clear',
    `printf '\\033[1;31m[botmux] Agent CLI exited. Auto-restart is paused and the last terminal output is preserved below.\\033[0m\\n\\n'`,
    'cat -- $argv[2] 2>/dev/null; or true',
    `printf '\\n\\033[1;33m[botmux] Fix the startup error, then send a new message to retry. Type exit to close this diagnostic shell.\\033[0m\\n'`,
    'exec $argv[3] -i',
  ].join('; ');
}

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
 * it via accessSync(). `binDir` is the HOST-RESOLVED wrapper bin dir (same
 * literal-baking rationale as shellWrapperScript — pane can't resolve it).
 */
export function buildDebugKeepShellScript(shellPath: string, binDir: string, kind: ShellKind = 'sh'): string {
  if (kind === 'fish') return buildFishDebugKeepShellScript(shellPath, binDir);
  const safeShell = shellPath.replace(/'/g, `'\\''`);
  const qBin = `'${binDir.replace(/'/g, `'\\''`)}'`;
  return [
    'cd -- "$1" && shift',
    // Same managed-env cleanup as shellWrapperScript — so neither the CLI nor
    // the interactive debug shell sees stale server/rcfile-owned values.
    PANE_ENV_UNSET_CLAUSE,
    // The pre-rcfile launch override must not reach the CLI or debug shell.
    NON_INTERACTIVE_SHELL_ENV_UNSET_CLAUSE,
    // Same PATH prepend as shellWrapperScript (wrapper build wins over stale npm-global).
    `export PATH=${qBin}:"$PATH"`,
    '/usr/bin/env "$@"',
    `printf '\\n[botmux debug] CLI exited (status %d) — interactive shell active. Type exit to close the session.\\n' "$?" >&2`,
    `exec '${safeShell}' -i`,
  ].join('; ');
}

function buildFishDebugKeepShellScript(shellPath: string, binDir: string): string {
  const safeShell = fishSingleQuote(shellPath);
  const qBin = fishSingleQuote(binDir);
  return [
    'cd -- $argv[1]; or exit',
    'set -e argv[1]',
    FISH_PANE_ENV_UNSET_CLAUSE,
    FISH_NON_INTERACTIVE_SHELL_ENV_UNSET_CLAUSE,
    `set -gx PATH ${qBin} $PATH`,
    '/usr/bin/env $argv',
    'set -l botmux_cli_status $status',
    `printf '\\n[botmux debug] CLI exited (status %d) — interactive shell active. Type exit to close the session.\\n' $botmux_cli_status >&2`,
    `exec ${safeShell} -i`,
  ].join('; ');
}

function fishSingleQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export type ShellKind = 'bash' | 'zsh' | 'sh' | 'fish';

export interface ShellSpec {
  /** Absolute path to the shell binary. */
  shell: string;
  /** Rcfile-loading flags (`-i`, `-l -i`, or empty) — caller appends
 *  `-c <SCRIPT> ... <cwd> KEY=VAL... bin args...` after these. */
  flags: string[];
}

/** Map a shell kind to the right rcfile-loading flags. The choice of flags
 *  is the part that actually differs between bash and zsh:
 *   - bash login shell does NOT auto-source .bashrc; many users only have
 *     nvm/fnm/pnpm hooks in .bashrc; using `-l` here would miss them.
 *     Plain `-i` loads .bashrc, which is what we want.
 *   - zsh interactive shell loads .zshrc; login loads .zprofile + .zlogin.
 *     Combine `-l -i` so installs in either location surface.
 *   - fish interactive shell loads config.fish; use `-i`.
 *   - sh has no rcfile we can rely on portably; skip rcfile flags. */
function specForKind(shell: string, kind: ShellKind): ShellSpec {
  switch (kind) {
    case 'bash':
      return { shell, flags: ['-i'] };
    case 'zsh':
      return { shell, flags: ['-l', '-i'] };
    case 'fish':
      return { shell, flags: ['-i'] };
    case 'sh':
      return { shell, flags: [] };
  }
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
 *  syntax we don't support (nu, csh, tcsh, ...). */
function classifyShell(path: string): ShellKind | null {
  const base = basename(path);
  if (base === 'bash') return 'bash';
  if (base === 'zsh') return 'zsh';
  if (base === 'fish') return 'fish';
  if (base === 'sh' || base === 'dash' || base === 'ash') return 'sh';
  return null;
}

export function shellKindForPath(path: string): ShellKind {
  return classifyShell(path) ?? 'sh';
}

/**
 * Resolve a per-bot `launchShell` override (BotConfig.launchShell) to an
 * absolute, executable, classifiable shell path. Accepts either an absolute
 * path (`/usr/bin/zsh`) or a bare name (`zsh`) — the latter is searched in the
 * conventional shell locations. Returns null when the override can't be honored
 * (not found / not executable / unsupported syntax like nu/csh/tcsh), so the caller
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
        `[tmux-backend] launchShell=${override} resolved to ${candidate} which is not bash/zsh/fish/sh; ` +
        `ignoring override (our wrapper would break under it).`,
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
 * If `$SHELL` is nu/csh/etc., emits a warning and falls back to a POSIX shell.
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
      `[tmux-backend] $SHELL=${userShell} is not bash/zsh/fish/sh; ` +
      `falling back to a POSIX shell for the wrapper.`,
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
