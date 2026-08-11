export type BackendType = 'pty' | 'tmux' | 'herdr' | 'zellij' | 'zmx' | 'riff' | 'mojo';

/**
 * Durable identity of the backing resource owned by one Botmux session.
 *
 * Most persistent backends own the whole mux session. Herdr can instead place
 * a managed agent inside a user's existing session; in that case `agentName`
 * identifies the pane Botmux owns and the surrounding session must be left
 * untouched on restore/close paths that run without a live worker.
 */
export type PersistentBackendTarget =
  | { backendType: 'tmux' | 'zellij' | 'zmx'; sessionName: string }
  | { backendType: 'herdr'; sessionName: string; agentName?: string };

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
   * separate from `env` on purpose: the persistent backends (tmux/zellij/zmx) must
   * NOT put these into the shared backing-server global env — they inject them
   * via the per-pane `/usr/bin/env KEY=VAL` prefix so one bot's provider creds
   * can't leak into another bot's panes. The pty backend (no shared server)
   * merges them into the child env. Already sanitized (see sanitizePerBotEnv).
   */
  injectEnv?: Record<string, string>;
  /**
   * Per-bot shell override (BotConfig.launchShell). When set, the persistent
   * backends (tmux/zellij/zmx) launch the CLI under this shell instead of `$SHELL`
   * — the escape hatch for a login `$SHELL` whose rcfile `exec`-trampolines into
   * another shell. Bare name (`zsh`) or absolute path; see resolveUserShell.
   * Ignored by the pty backend (no shell wrapper).
   */
  launchShell?: string;
}

export type AmbiguousSubmissionRecoveryFailure =
  | 'recovery-pending'
  | 'recovery-unconfirmed';

/** Raised before a logical write when an older ambiguous composer transaction
 * already owns the backend. Callers must not rotate turn attribution or touch
 * the terminal after this error. */
export class AmbiguousSubmissionBlockedError extends Error {
  constructor(readonly failure: AmbiguousSubmissionRecoveryFailure) {
    super(`ambiguous submission blocked: ${failure}`);
    this.name = 'AmbiguousSubmissionBlockedError';
  }
}

export interface SessionBackend {
  spawn(bin: string, args: string[], opts: SpawnOpts): void;
  /** Returns false only when the backend can prove the write was not accepted.
   * Legacy implementations may return void on success. */
  write(data: string): void | boolean;
  /**
   * Begin one logical adapter submission and return its recovery fence.
   * Backends with a persistent ambiguity journal may arm it here so all
   * adapter-level text chunks plus the final submit key share one transaction.
   */
  captureAmbiguousSubmissionFence?(): number;
  /**
   * Commit a logical adapter submission after its write call returns. A
   * recovery failure keeps the backend fail-closed and must be surfaced by the
   * worker instead of treating the adapter result as safely delivered.
   */
  confirmAmbiguousSubmission?(
    fence: number,
  ): AmbiguousSubmissionRecoveryFailure | undefined;
  /**
   * Best-effort cleanup for a logical write that failed after `fence`. The
   * backend owns deduplication against frame-level recovery and must poison
   * control-key outcomes that cannot safely be retried.
   */
  cancelAmbiguousSubmission?(
    fence: number,
  ): AmbiguousSubmissionRecoveryFailure | undefined;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  /**
   * Replace the worker's derived screen state with an authoritative snapshot.
   *
   * Live-only observers use this after reconnecting: output may have been
   * produced while the observer was offline, so replaying only subsequent
   * chunks would leave idle detection and cards permanently stale. This is a
   * reset/rebase signal, not another incremental PTY chunk.
   */
  onScreenResync?(cb: (snapshot: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(): void;
  /** Permanently destroy the backing session (e.g. kill tmux session).
   *  Called only on explicit /close. Default: same as kill(). */
  getAttachInfo?(): { type: 'tmux'; sessionName: string } | null;
  /** PID of the CLI process running inside the backend. */
  getChildPid?(): number | null;
  captureCurrentScreen?(): string;
  /**
   * Complete one authoritative screen refresh that starts after this call.
   * Snapshot-only backends use this as a completion fence before the worker
   * declares a turn idle, so a final burst cannot be lost to polling phase.
   */
  settleCurrentScreen?(): Promise<boolean>;
  captureViewport?(): string;
  /**
   * Plain current viewport plus the real terminal cursor. Adopt-mode input
   * guards use this to detect an unsubmitted local composer draft before a
   * remote message is written into the same TUI.
   */
  captureInputState?(): {
    viewport: string;
    cursor: { x: number; y: number };
  } | null;
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
   * (Riff/Mojo) invoke this when the current task finishes or fails. The worker
   * uses it to re-arm prompt-ready and flush queued follow-up messages: remote
   * backends have no PTY output, so the idle detector never fires for them and
   * nothing else would ever mark the session ready again after a write.
   * Optional — local backends never implement it.
   */
  onTaskDone?(cb: () => void): void;
  /** Remote-session lineage updates — the worker forwards these to the daemon
   *  so the follow-up lineage survives daemon restarts. `null` clears the
   *  persisted lineage (follow-up failed → next message starts fresh). */
  onTaskId?(cb: (taskId: string | null) => void): void;
  /** Async-capable teardown: remote backends return a confirmed cancellation result so
   * daemon-driven explicit close can fence late create/follow-up races before
   * publishing the durable closed row. Local backends remain synchronous. */
  destroySession?(): void | Promise<void | SessionDestroyResult>;
  /** Roll back a successful remote prepare when the daemon could not commit
   * the durable closed row. The backend must restore write admission without
   * discarding the last task lineage. */
  abortDestroySession?(): void | Promise<void>;
  /** Finalize a successful prepare after the durable row is closed. */
  commitDestroySession?(): void;
  /** Graceful daemon shutdown for a remote-task backend. Fence only NEW
   * writes, drain every write accepted before the fence, and return the exact
   * final lineage without cancelling it. The daemon persists that lineage
   * before telling the worker it may exit. */
  prepareShutdownDetach?(): Promise<SessionShutdownDetachResult>;
  /** Restore admission/streaming when the daemon cannot complete a prepared
   * shutdown detach (for example, lineage persistence failed). */
  abortShutdownDetach?(): SessionShutdownDetachResult | Promise<SessionShutdownDetachResult>;
  /** Finalize a shutdown detach after exact lineage persistence has been
   * acknowledged by the daemon. Shutdown refusal never cancels remote work. */
  commitShutdownDetach?(): void;
}

export interface SessionDestroyResult {
  ok: boolean;
  /** Exact remote task that failed cancellation and must remain retryable. */
  taskId?: string;
  error?: string;
}

export interface SessionShutdownDetachResult {
  ok: boolean;
  /** Exact final lineage after all pre-fence writes have drained. `null` is
   * authoritative and clears any stale durable parent. */
  taskId: string | null;
  error?: string;
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
