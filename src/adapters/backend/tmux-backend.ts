import { execSync, execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import type { SessionProbe } from './types.js';
import { probeTmuxFunctional, scrubTmuxServerGlobalEnv, tmuxEnv, getTmuxVersionCached, tmuxVersionAtLeast } from '../../setup/ensure-tmux.js';
import { BOTMUX_INJECTED_ENV_KEYS, CA_BUNDLE_ENV_KEYS, PROXY_ENV_KEYS, REDACTED_CHILD_ENV_KEYS, SESSION_TEMP_ENV_KEYS, WORKFLOW_WORKER_ENV_KEYS } from '../../utils/child-env.js';
import { sanitizePerBotEnv } from '../../core/per-bot-env.js';
import { logger } from '../../utils/logger.js';
import { isExecutable } from '../../utils/executable.js';
import { PROCESS_TABLE_MAX_BUFFER } from '../../utils/exec-limits.js';

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
 * True when the connection failure is specifically "the socket file does not
 * exist" (ENOENT on connect). This is still a server-level error (see
 * {@link isTmuxServerLevelErrorText}) — on its own it cannot tell "no server at
 * all" from "a live server whose socket was cleaned from /tmp" — but it is the
 * ONLY shape a cold machine produces: a reboot wipes /tmp (macOS /private/tmp,
 * Linux tmpfs / boot-time tmpfiles), so before anything has started a server
 * every probe reads exactly this. A server that merely exited leaves its socket
 * file behind and reads "no server running" instead.
 */
export function isTmuxSocketMissingErrorText(stderrText: string): boolean {
  return /error connecting to .*\(No such file or directory\)/i.test(stderrText);
}

/**
 * Evidence that NO tmux process (server or client) of the current user is
 * visible. Used ONLY by {@link TmuxBackend.serverAbsentOnColdMachine} to break the
 * read-isolation cold-start tie; it is a heuristic (a renamed tmux binary or a
 * server in another PID namespace is invisible to it), so it must never feed
 * the general probeSession that kill-verify / close / wake paths consume.
 *
 * Deliberately coarse and fail-closed:
 *   - matches ANY tmux process of this uid (any socket, client or server), so a
 *     live server whose socket was deleted is never missed, whatever its argv
 *     or proctitle looks like on this platform;
 *   - returns false (⇒ caller stays 'unknown') whenever `ps` fails, times out,
 *     prints nothing parseable, or the uid is unavailable.
 * A concurrent sibling probe's short-lived client can make this false — that
 * only keeps today's 'unknown', the safe direction.
 */
export function noTmuxProcessForCurrentUser(): boolean {
  // Both real and effective uid: a setuid launcher must not let a server owned
  // by the other one slip past the comparison.
  const uids = new Set<number>();
  if (typeof process.getuid === 'function') uids.add(process.getuid());
  if (typeof process.geteuid === 'function') uids.add(process.geteuid());
  if (uids.size === 0) return false;
  let out: string;
  try {
    out = execFileSync('ps', ['-A', '-o', 'uid=,comm='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      maxBuffer: PROCESS_TABLE_MAX_BUFFER,
    });
  } catch {
    return false;
  }
  if (typeof out !== 'string') return false;
  let rows = 0;
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    rows++;
    if (!uids.has(Number(m[1]))) continue;
    // Prefix, not equality: on Linux tmux renames its threads via
    // prctl(PR_SET_NAME) ("tmux: server", "tmux: client"); macOS keeps "tmux"
    // (or the full path). Over-matching only keeps 'unknown'.
    if (basename(m[2]!).startsWith('tmux')) return false;
  }
  // `ps -A` always lists at least this process itself; zero parseable rows
  // means the output format is not what we expect — no evidence either way.
  return rows > 0;
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
 * TmuxBackend — static tmux session helpers (naming, probes, kill, diagnostics).
 *
 * This class used to be a pty-under-tmux `SessionBackend` instance (node-pty
 * running `tmux new-session` / `attach-session`). That implementation was
 * superseded by {@link TmuxPipeBackend} (tmux-pipe-backend.ts), which is the only
 * tmux backend `selectSessionBackend` constructs; the unreachable instance
 * surface (constructor, spawn / write / sendText / pasteText / attachToExisting
 * / getAttachInfo …) was removed. What remains is the static helper surface
 * shared by the daemon, worker, persistent-backend bookkeeping and
 * TmuxPipeBackend itself.
 *
 * Naming: tmux sessions are named `bmx-<sessionId.slice(0,8)>`.
 */
export class TmuxBackend {
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

  static assertInstanceIdentity(name: string, expected: string): void {
    const probe = TmuxBackend.probeSession(name);
    if (probe === 'missing') return;
    let actual = '';
    try {
      actual = execFileSync('tmux', ['show-environment', '-t', name, 'BOTMUX_CODEX_INSTANCE_BINDING'],
        { encoding: 'utf8', timeout: 5000, env: tmuxEnv() }).trim();
    } catch { /* unknown/missing identity is not permission to attach */ }
    if (actual !== `BOTMUX_CODEX_INSTANCE_BINDING=${expected}`) {
      throw new Error('Codex instance identity mismatch: existing tmux session preserved; attachment refused');
    }
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
    return TmuxBackend.classifyHasSession(name, false);
  }

  /**
   * Launch-selection variant of {@link probeSession} (reattach vs create), used
   * by the worker's backend gate. Identical except for ONE shape: "error
   * connecting to <socket> (No such file or directory)" reads 'missing'. For a
   * launch that is the only honest answer — there is no reachable pane at that
   * socket to reattach (`pipe-pane` would hit the same connect error), and the
   * next `new-session` starts a server there. It is exactly what a clean host
   * / fresh TMUX_TMPDIR reports before any server exists, and treating it as
   * 'unknown' would bias every first launch toward a doomed reattach.
   * Destructive/verification callers (kill-verify, restore, read-isolation)
   * keep {@link probeSession}'s stricter 'unknown' — this is not a liveness
   * verdict, only "nothing here can be attached to".
   */
  static probeSessionForLaunch(name: string): SessionProbe {
    return TmuxBackend.classifyHasSession(name, true);
  }

  private static classifyHasSession(name: string, socketMissingIsMissing: boolean): SessionProbe {
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
        if (socketMissingIsMissing && isTmuxSocketMissingErrorText(stderrText)) return 'missing';
        if (isTmuxServerLevelErrorText(stderrText)) return 'unknown';
        return 'missing';
      }
      return 'unknown';
    }
  }

  /**
   * {@link probeSessionForLaunch} with a short backoff retry on 'unknown' ONLY.
   *
   * `has-session` is ~20ms on a healthy host but still needs a fork+exec; under
   * heavy load the deadline can expire before tmux is ever scheduled. One
   * timeout must not become the verdict for a launch decision, so the worker's
   * backend gate retries it. 'exists' / 'missing' are tmux's authoritative
   * answers and return immediately (no added latency on a cold start). The
   * per-attempt deadline stays the base probe's, so the worst case is
   * bounded at `attempts × 3s` plus the backoff.
   */
  static probeSessionWithRetry(
    name: string,
    opts: {
      attempts?: number;
      baseDelayMs?: number;
      /** Test seams. */
      probe?: (name: string) => SessionProbe;
      sleep?: (ms: number) => void;
    } = {},
  ): SessionProbe {
    const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
    const baseDelayMs = Math.max(0, Math.floor(opts.baseDelayMs ?? 150));
    const probe = opts.probe ?? ((n: string) => TmuxBackend.probeSessionForLaunch(n));
    const sleep = opts.sleep ?? ((ms: number) => {
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      } catch { /* SharedArrayBuffer unavailable: retry immediately */ }
    });
    let result = probe(name);
    for (let completed = 1; result === 'unknown' && completed < attempts; completed += 1) {
      const backoff = baseDelayMs * (2 ** (completed - 1));
      const jitter = baseDelayMs > 0 ? Math.floor(Math.random() * baseDelayMs) : 0;
      sleep(backoff + jitter);
      result = probe(name);
    }
    return result;
  }

  /**
   * Cold-machine check for the read-isolation pre-spawn gate ONLY (see
   * resolveReadIsolationPaneProbe). True when the default server's socket file
   * does not exist ("error connecting to <socket> (No such file or directory)")
   * AND no tmux process of this user is visible — the state a reboot leaves
   * (/tmp wiped) before anything has started a server.
   *
   * A server that merely exited leaves its socket behind and reads "no server
   * running" ⇒ probeSession already answers 'missing'. Anything else — a live
   * reply, timeout, spawn failure, ECONNREFUSED, lost server, any visible tmux
   * process, a failing `ps` — is false (stay inconclusive).
   */
  static serverAbsentOnColdMachine(): boolean {
    try {
      execFileSync('tmux', ['list-sessions'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: tmuxEnv(),
        timeout: 3000,
      });
      return false;
    } catch (e: any) {
      if (isExecTimeoutError(e)) return false;
      if (!e || typeof e.status !== 'number' || e.signal) return false;
      const stderrText = (e.stderr?.toString?.() ?? '').trim();
      if (!isTmuxSocketMissingErrorText(stderrText)) return false;
    }
    // ps AFTER tmux: a server started in between has a visible process.
    return noTmuxProcessForCurrentUser();
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

  // ─── Type-level instance fields ───────────────────────────────────────────
  //
  // TmuxBackend is never instantiated. These three optional fields exist only
  // so worker.ts's `(backend as TmuxBackend | PtyBackend | ZellijBackend | …)`
  // assignments keep type-checking (a property write on a union requires the
  // property on every member). Drop them together with those casts.

  /** Claude Code session JSONL path — set by worker for claude-code sessions so
   *  the claude-code adapter can verify paste+Enter submissions via file growth. */
  claudeJsonlPath?: string;
  /** PID of the spawned Claude Code child — used by the claude-code adapter to
   *  follow Claude's authoritative session id via ~/.claude/sessions/<pid>.json. */
  cliPid?: number;
  /** Working directory the CLI was spawned in — cross-checked against the pid
   *  file's cwd field so a recycled PID can't mislead the resolver. */
  cliCwd?: string;
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
  // env(1) runs AFTER the login shell's rcfiles, so stripping these only from
  // the worker/client env is insufficient: rcfiles can reintroduce them.
  if (env?.BOTMUX_CODEX_INSTANCE_BINDING) {
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) out.push('-u', key);
  }
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
    // CA bundle: same treatment as proxy vars (see CA_BUNDLE_ENV_KEYS). Emitted
    // per pane so a value the worker resolved for a sandboxed Codex reaches the
    // CLI and overrides a stale server-global one, while a user's own value on
    // their tmux server survives untouched for every other CLI.
    for (const key of CA_BUNDLE_ENV_KEYS) {
      const val = env[key];
      if (val === undefined) continue;
      out.push(`${key}=${val}`);
    }
    // Session scratch must be pane-local. In particular, never rely on the
    // shared tmux server's ambient TMPDIR: one bot can otherwise write into
    // another session's scratch tree (or back into a tmpfs-backed /tmp).
    for (const key of SESSION_TEMP_ENV_KEYS) {
      const val = env[key];
      if (val === undefined) continue;
      out.push(`${key}=${val}`);
    }
    // Workflow (v3 goal-mode) identity: BOTMUX_WORKFLOW / BOTMUX_GOAL_* etc.
    // These are NOT in BOTMUX_INJECTED_ENV_KEYS (they belong to the ephemeral
    // pool, not general sessions), so like proxy/CA they must be forwarded
    // explicitly here — otherwise a v3 worker on the tmux backend loses its
    // whole workflow env and the CLI can't see the goal (the PTY backend passed
    // the full env, so it never hit this). Emitted only when defined, so
    // non-workflow panes are unaffected.
    for (const key of WORKFLOW_WORKER_ENV_KEYS) {
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
      if (env?.BOTMUX_CODEX_INSTANCE_BINDING && ['CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'BOTMUX_CODEX_INSTANCE_BINDING'].includes(key)) continue;
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
    // window-size largest exists since tmux 3.1; skip on known-older builds.
    // Unknown version: keep trying (best-effort inside the try/catch).
    const version = getTmuxVersionCached();
    if (version === null || tmuxVersionAtLeast(version, 3, 1)) {
      execSync(`tmux set-option -t ${t} window-size largest`, { stdio: 'ignore', env });
    }
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
