export type BackendType = 'pty' | 'tmux' | 'herdr' | 'zellij' | 'riff';

/**
 * Tri-state result of probing whether a named backing session exists.
 *
 *   - 'exists'  — the probe command succeeded and confirmed a live session.
 *   - 'missing' — the probe command succeeded and confirmed no such live session.
 *   - 'unknown' — the probe command FAILED (error / timeout / unparseable output),
 *                 so we could not determine existence either way.
 *
 * The distinction matters wherever a `false`/`missing` answer drives a
 * destructive action (e.g. closing an active session on restore): a transient
 * 'unknown' must never be treated as 'missing', or one flaky probe could
 * permanently tear down a still-alive session.
 */
export type SessionProbe = 'exists' | 'missing' | 'unknown';

export interface SpawnOpts {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  /**
   * Per-bot env (bots.json `env`) to inject into the CLI process ONLY. Kept
   * separate from `env` on purpose: the persistent backends (tmux/zellij) must
   * NOT put these into the shared backing-server global env — they inject them
   * via the per-pane `/usr/bin/env KEY=VAL` prefix so one bot's provider creds
   * can't leak into another bot's panes. The pty backend (no shared server)
   * merges them into the child env. Already sanitized (see sanitizePerBotEnv).
   */
  injectEnv?: Record<string, string>;
  /**
   * Per-bot shell override (BotConfig.launchShell). When set, the persistent
   * backends (tmux/zellij) launch the CLI under this shell instead of `$SHELL`
   * — the escape hatch for a login `$SHELL` whose rcfile `exec`-trampolines into
   * another shell. Bare name (`zsh`) or absolute path; see resolveUserShell.
   * Ignored by the pty backend (no shell wrapper).
   */
  launchShell?: string;
}

export interface SessionBackend {
  spawn(bin: string, args: string[], opts: SpawnOpts): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(): void;
  /** Permanently destroy the backing session (e.g. kill tmux session).
   *  Called only on explicit /close. Default: same as kill(). */
  getAttachInfo?(): { type: 'tmux'; sessionName: string } | null;
  /** PID of the CLI process running inside the backend. */
  getChildPid?(): number | null;
  captureCurrentScreen?(): string;
  captureViewport?(): string;
  getPaneSize?(): { cols: number; rows: number } | null;
  /**
   * Remote sandbox access URL — backends that run on a remote sandbox (e.g.
   * riff) expose a web terminal link instead of a local PTY. The worker
   * forwards this to the daemon so the dashboard "Web终端" button opens the
   * sandbox directly. Optional — local backends (pty/tmux/herdr/zellij)
   * never implement it.
   */
  onAccessUrl?(cb: (url: string) => void): void;
  /**
   * Remote-task turn boundary — backends that execute discrete remote tasks
   * (riff) invoke this when the current task finishes or fails. The worker
   * uses it to re-arm prompt-ready and flush queued follow-up messages: remote
   * backends have no PTY output, so the idle detector never fires for them and
   * nothing else would ever mark the session ready again after a write.
   * Optional — local backends never implement it.
   */
  onTaskDone?(cb: () => void): void;
  /** Remote-task id updates (riff) — the worker forwards these to the daemon
   *  so the follow-up lineage survives daemon restarts. `null` clears the
   *  persisted lineage (follow-up failed → next message starts fresh). */
  onTaskId?(cb: (taskId: string | null) => void): void;
  /** Async-capable teardown: riff awaits the remote task-cancel here. */
  destroySession?(): void | Promise<void>;
}

/**
 * Observe/adopt backends that expose authoritative screen snapshots of a pane
 * they don't own (TmuxPipeBackend via capture-pane, ZellijObserveBackend via
 * dump-screen). The worker's adopt-mode web-terminal seed + transient-snapshot
 * screenshot path consume these instead of the long-lived renderer, so the
 * snapshot dimensions always match the real pane.
 */
export interface ObserveBackend extends SessionBackend {
  /** Full-history snapshot (ANSI) — seeds the web terminal on attach. */
  captureCurrentScreen(): string;
  /** Current-viewport snapshot (ANSI) — sized to the pane, for screenshots. */
  captureViewport(): string;
  /** Live pane dimensions, or null if the pane is gone. */
  getPaneSize(): { cols: number; rows: number } | null;
  /** Cheap liveness probe. */
  isPaneAlive(): boolean;
  /**
   * True while a live web-attach client is connected and this backend has
   * paused its change-emission poller (ZellijObserveBackend does this to avoid
   * attach flicker — see setLiveAttach). During that window the pane can keep
   * changing without ever reaching onData, so a snapshot watermark fed by
   * onData/onPtyData goes stale. Backends that never pause emission omit this.
   */
  isLiveAttachActive?(): boolean;
}

/** Duck-typed guard — true for any backend exposing the ObserveBackend surface. */
export function isObserveBackend(b: unknown): b is ObserveBackend {
  return (
    !!b &&
    typeof (b as ObserveBackend).captureViewport === 'function' &&
    typeof (b as ObserveBackend).getPaneSize === 'function' &&
    typeof (b as ObserveBackend).captureCurrentScreen === 'function'
  );
}
