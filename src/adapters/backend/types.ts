import type {
  RemoteRunnerBackendState,
  RemoteRunnerOutboundMessage,
  RemoteRunnerOutboundMessageResult,
  RemoteRunnerSessionToolOperation,
  RemoteRunnerSessionToolResult,
  RemoteRunnerRecoveredTurn,
  RemoteRunnerTrustedCaller,
  RemoteRunnerUsageReport,
} from './remote-runner-protocol.js';

export type BackendType = 'pty' | 'tmux' | 'herdr' | 'zellij' | 'zmx' | 'riff' | 'mojo' | 'remote-runner' | 'orca';

export type HerdrBackendPlacement = 'workspace' | 'tab' | 'split';

export interface HerdrBackendConfig {
  /**
   * Named Herdr session to host Botmux-managed agents.
   * Defaults to 'botmux'.
   * When pointing to an external user session (e.g. 'default'), Botmux launches
   * agents inside that session and never destroys or restarts the host session.
   */
  sessionName?: string;

  /**
   * Placement mode for new managed agent panes:
   * - 'workspace' (default): creates a new workspace for each topic (herdr workspace create).
   * - 'tab': creates a new tab inside the target workspace (herdr tab create).
   * - 'split': splits an existing pane inside the target tab (herdr pane split).
   */
  placement?: HerdrBackendPlacement;

  /**
   * Target workspace id or label when placement is 'tab' or 'split'. Matched by
   * exact id/label, then the label's first word, then prefix, then substring.
   * Falls back to the focused workspace.
   */
  workspace?: string;

  /**
   * Target tab id or label when placement is 'split' (e.g. "3 其他" or "3"),
   * matched like `workspace`; also the label of a tab Botmux creates.
   */
  tab?: string;

  /**
   * Split direction when placement is 'split'. Default 'right'.
   */
  splitDirection?: 'right' | 'down';

  /**
   * Chat types this placement applies to (e.g. ['group'] keeps DM sessions out
   * of the user's session). Unset = every session. Sessions of other types use
   * the default machine-wide 'botmux' host with workspace placement.
   */
  chatTypes?: Array<'group' | 'p2p'>;
}

/** `chatTypes` from bots.json or a comma-separated env value. Unknown entries
 *  are dropped; nothing valid left means "unset" (applies to every session). */
export function normalizeHerdrChatTypes(raw: unknown): Array<'group' | 'p2p'> | undefined {
  const items = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : [];
  const types = [...new Set(items
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter((item): item is 'group' | 'p2p' => item === 'group' || item === 'p2p'))];
  return types.length > 0 ? types : undefined;
}

/** Normalize a herdr block from bots.json or the BOTMUX_HERDR_* env, keeping
 *  only the fields that are set so a bot block can be layered over the env
 *  block field by field. Nothing set → undefined. */
export function normalizeHerdrBackendConfig(raw: unknown): HerdrBackendConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const config: HerdrBackendConfig = {
    sessionName: text(r.sessionName),
    placement: r.placement === 'workspace' || r.placement === 'tab' || r.placement === 'split' ? r.placement : undefined,
    workspace: text(r.workspace),
    tab: text(r.tab),
    splitDirection: r.splitDirection === 'right' || r.splitDirection === 'down' ? r.splitDirection : undefined,
    chatTypes: normalizeHerdrChatTypes(r.chatTypes),
  };
  for (const key of Object.keys(config) as Array<keyof HerdrBackendConfig>) {
    if (config[key] === undefined) delete config[key];
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

/** The herdr config a herdr-backed session spawns with: the bot's block layered
 *  over the daemon-level BOTMUX_HERDR_* config field by field (an empty bot
 *  block hides nothing). It only takes effect once it names a session or a
 *  placement; otherwise the default 'botmux' host and workspace placement
 *  apply, same as having no config. */
export function resolveHerdrBackendConfig(
  daemonConfig: HerdrBackendConfig | undefined,
  botConfig: HerdrBackendConfig | undefined,
): HerdrBackendConfig | undefined {
  const merged: HerdrBackendConfig = { ...daemonConfig, ...botConfig };
  return merged.sessionName || merged.placement ? merged : undefined;
}

/** The Herdr placement a worker applies, from its init `backendConfig`.
 *  Undefined (default host and placement) when there is no herdr block or
 *  `chatTypes` excludes this session's chat type. */
export function herdrConfigForSession(
  backendConfig: unknown,
  chatType: 'group' | 'p2p' | undefined,
): HerdrBackendConfig | undefined {
  const config = backendConfig && typeof backendConfig === 'object'
    && ('sessionName' in backendConfig || 'placement' in backendConfig)
    ? backendConfig as HerdrBackendConfig
    : undefined;
  return herdrConfigForChatType(config, chatType);
}

/** The Herdr placement for one session, or undefined when `chatTypes` excludes
 *  its chat type (the session then uses the default host). */
export function herdrConfigForChatType(
  config: HerdrBackendConfig | undefined,
  chatType: 'group' | 'p2p' | undefined,
): HerdrBackendConfig | undefined {
  if (!config?.chatTypes) return config;
  return chatType && config.chatTypes.includes(chatType) ? config : undefined;
}

export interface BackendTurnInput {
  content: string;
  turnId: string;
  replyTurnId?: string;
  dispatchAttempt?: number;
  linkRefMode?: 'observe' | 'enabled';
  trustedCaller?: RemoteRunnerTrustedCaller;
}

/** Host-owned state frozen beside a Remote Runner turn. Providers never send
 * or receive this context; it exists only on the backend → worker callbacks. */
export interface RemoteRunnerTurnHostContext {
  linkRefMode?: 'observe' | 'enabled';
}

export interface BackendTurnSubmission {
  submitted: boolean;
  failureReason?: string;
  /** Whether a rejected submission provably stayed local or may have executed. */
  submissionDisposition?: 'untouched' | 'dirty_unknown';
}

export interface BackendTurnFailure {
  turnId: string;
  code: string;
  message: string;
  status: 'failed' | 'ambiguous' | 'cancelled';
  retryable: boolean;
}

/**
 * Durable identity of the backing resource owned by one Botmux session.
 *
 * Most persistent backends own the whole mux session. Herdr can instead place
 * a managed agent inside a user's existing session; in that case `agentName`
 * identifies the pane Botmux owns and the surrounding session must be left
 * untouched on restore/close paths that run without a live worker.
 */
export type PersistentBackendTarget =
  // New tmux targets freeze the server (`-L <socketName>`, see tmux-socket.ts);
  // a tmux target without it lives on the default server (every older row).
  | { backendType: 'tmux'; sessionName: string; socketName?: string }
  | { backendType: 'zellij'; sessionName: string }
  // New ZMX targets freeze the native socket directory; older rows may omit it.
  | { backendType: 'zmx'; sessionName: string; socketDir?: string }
  | {
    backendType: 'herdr';
    sessionName: string;
    agentName?: string;
    /**
     * Full Botmux owner id attached by the lifecycle resolver. It is required
     * before an agent-less legacy `bmx-<sid8>` target may be treated as an
     * exclusive whole-session resource; persisted/shared targets may omit it.
     */
    sessionId?: string;
  };

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
   * Inherited variables the session env overlay removes (core/session-env.ts).
   * The worker already deleted them from `env`; the shell-wrapped backends
   * (tmux/zellij/zmx) additionally pass `-u KEY` to the pane's final
   * `/usr/bin/env`, which runs after the rcfile and the terminal server's
   * global env have been applied, so those sources cannot re-add them.
   */
  unsetEnv?: string[];
  /** Strict panes launch with env -i and skip user shell startup profiles. */
  strictEnv?: boolean;
  /** Worker verified the surviving generation's policy stamp. */
  strictEnvReattach?: boolean;
  /** Why a Remote Runner state is being resumed. Explicit reactivation may
   * require the provider to replace a resource that was previously cancelled. */
  remoteResumeMode?: 'reattach' | 'rebuild';
  /**
   * Per-bot shell override (BotConfig.launchShell). When set, the persistent
   * backends (tmux/zellij/zmx) launch the CLI under this shell instead of `$SHELL`
   * — the escape hatch for a login `$SHELL` whose rcfile `exec`-trampolines into
   * another shell. Bare name (`zsh`) or absolute path; see resolveUserShell.
   * Ignored by the pty backend (no shell wrapper).
   */
  launchShell?: string;
  /**
   * CLI executable resolved before any launch wrapper (session scope,
   * wrapperCli, or sandbox). Identity hint for Herdr's managed-agent kind and
   * PATH launcher only; `bin`/`args` remain the full command to execute.
   * Backends that execute `bin` directly (pty/tmux/zellij/zmx) ignore it.
   */
  cliBin?: string;
  /** Logical CLI identifier (e.g. 'claude', 'codex') for agent kind fallback. */
  cliId?: string;
  /** Provider-neutral model selection for structured remote runners. */
  model?: string;
  /** Provider-neutral model backend variant for structured remote runners. */
  modelBackendVariant?: 'standard' | 'max';
  /** Provider-neutral reasoning effort for structured remote runners. */
  reasoningEffort?: string;
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
  /** Provider-native structured turn submission. Backends that implement this
   * bypass terminal keystroke adapters and receive the daemon-authenticated
   * turn envelope directly. */
  submitTurn?(input: BackendTurnInput): Promise<BackendTurnSubmission>;
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
   * Snapshot-native backends use this for bounded viewport updates; live-only
   * observers also use it after reconnecting, when output may have been
   * produced while the observer was offline. This is a reset/rebase signal,
   * not another incremental PTY chunk.
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
   * Escape sequence re-asserting the pane's live input modes (mouse tracking,
   * app cursor keys, …) on a fresh web-terminal client. Snapshot seeds carry
   * screen cells but no DECSET state; backends that can query it (tmux) expose
   * this so mouse-mode TUIs keep receiving clicks after a page (re)load.
   */
  capturePaneInputModes?(): string;
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
  /**
   * Turn final answer — headless backends (Mojo) that synthesise their screen
   * from an event stream also know, exactly, which part of that stream is the
   * assistant's answer. They hand it over here so the worker can bridge it into
   * the thread when the agent produced an answer but never called `botmux send`
   * (a headless CLI has no terminal for the user to read instead).
   *
   * Fires at most once per turn, immediately before `onTaskDone`, so the reply
   * IPC precedes the prompt-ready/idle transition. The text is the RAW answer:
   * the worker owns the `botmux send` dedup gate and the sentinel handling, so
   * a backend must not pre-filter it. Optional — backends whose output the user
   * can already read in a terminal never implement it.
   */
  onTurnFinal?(cb: (
    text: string,
    turnId?: string,
    hostContext?: RemoteRunnerTurnHostContext,
  ) => void): void;
  /** Exact provider-reported terminal failure for a submitted turn. */
  onTurnFailure?(cb: (failure: BackendTurnFailure) => void): void;
  /** Provider-requested chat output for the active turn. A negotiated final
   * may own terminal delivery; the worker remains the trusted routing and
   * delivery authority, and providers never receive a destination override or
   * platform credential. */
  onOutboundMessage?(
    cb: (
      message: RemoteRunnerOutboundMessage,
      hostContext: RemoteRunnerTurnHostContext,
    ) => Promise<RemoteRunnerOutboundMessageResult>,
  ): void;
  /** Provider-requested access to the current BotMux session's allowlisted
   * helper surface. The worker freezes session and turn authority before
   * executing anything on the host; schedule mutations still cross daemon
   * authorization. */
  onSessionTool?(
    cb: (operation: RemoteRunnerSessionToolOperation) => Promise<RemoteRunnerSessionToolResult>,
  ): void;
  /** A provider-owned turn survived the host/worker process and is now being
   * observed without resubmitting its prompt. */
  onTurnRecovered?(cb: (turn: RemoteRunnerRecoveredTurn) => void): void;
  /** Install daemon-restored host-only state for an exact provider-owned turn.
   * Until this succeeds, the backend must not release recovered output. */
  setRecoveredTurnHostContext?(
    turnId: string,
    context: RemoteRunnerTurnHostContext,
  ): boolean;
  /** Provider handshake/startup is complete and turns may be accepted. */
  onReady?(cb: () => void): void;
  /** Durable, provider-neutral lineage/runtime state changed. */
  onBackendState?(cb: (state: RemoteRunnerBackendState) => void): void;
  /** Provider-native usage observed at a generation-fenced turn boundary. */
  onUsageSnapshot?(cb: (usage: RemoteRunnerUsageReport) => void): void;
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
   * discarding the last task lineage.
   *
   * Returns whether admission was ACTUALLY restored. A backend that is holding a
   * latched fence (an unproven local subtree, an unnamed remote session) must
   * refuse and say so: "the close was abandoned" is not evidence that the
   * survivor died. Legacy backends return void, which means "restored". */
  abortDestroySession?(): void | Promise<void> | SessionAbortDestroyResult | Promise<SessionAbortDestroyResult>;
  /** Finalize a successful prepare after the durable row is closed. */
  commitDestroySession?(): void;
  /** Graceful daemon shutdown for a remote-task backend. Fence only NEW
   * writes, drain every write accepted before the fence, and return the exact
   * final lineage without cancelling it. The daemon persists that lineage
   * before telling the worker it may exit. */
  prepareShutdownDetach?(drainTimeoutMs?: number): Promise<SessionShutdownDetachResult>;
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
  /**
   * May a FAILED prepare restore write admission?
   *
   * A single boolean `ok` cannot answer this, and treating every failure as
   * rollbackable is unsafe: once the remote session is cancelled, restoring
   * admission produces a session that looks writable but can never continue.
   *
   *  - `retryable`     no irreversible side effect happened; admission may be
   *                    restored and the same close retried.
   *  - `uncertain`     an unknown side effect MAY have happened (for example a
   *                    dispatched turn whose lineage never materialised, so a
   *                    remote session may exist that we cannot name). Admission
   *                    must stay fenced; the row stays active for a retry.
   *  - `irreversible`  the remote side is already gone. Admission must never be
   *                    restored.
   *
   * Absent means `retryable`, which is the historical behaviour.
   */
  recovery?: 'retryable' | 'uncertain' | 'irreversible';
  /**
   * May write admission be RESTORED after this failed prepare?
   *
   * This is a SEPARATE question from `recovery`, and collapsing the two is a
   * fencing bug. `recovery` answers "may the close be retried / did anything
   * irreversible happen?"; `admission` answers "is it safe to accept a new turn
   * on this session again?". They genuinely disagree in at least one real state:
   * a local child that could not be proven terminated leaves the close fully
   * retryable (the irreversible remote cancel has NOT run) while a process that
   * still holds the injected credential may be alive — so admitting a new write
   * would layer a fresh turn on top of a live orphan.
   *
   *  - `restorable`  no live-side effect can be holding the session; the backend
   *                  may re-open writes (abortDestroySession).
   *  - `fenced`      a possibly-live local child or unnamed remote session may
   *                  exist. Writes must stay refused even if the close itself is
   *                  retried, and abortDestroySession must NOT re-open them.
   *
   * Absent is derived from `recovery` (retryable → restorable, uncertain /
   * irreversible → fenced), which preserves the historical behaviour for every
   * result that predates this field.
   */
  admission?: 'restorable' | 'fenced';
  /**
   * Set when the close SUCCEEDED but a local subtree could not be proven gone.
   * Two distinct facts, deliberately kept distinguishable:
   *
   *  * `local_subtree_unprovable_on_platform` — this host cannot enumerate
   *    processes at all (a non-Linux platform, where /proc does not exist), so no
   *    retry can change the answer.
   *  * `local_subtree_boundary_unproven` — enumeration DID run and found nothing
   *    executing, but a clean scan is a diagnostic signal, not an unforgeable
   *    boundary: a descendant that setsid'd and scrubbed its own environ is
   *    invisible to it. This is the ordinary Linux weak-handle outcome.
   *
   * Neither is a failure. "The boundary is unproven" is a different fact from
   * "the instrument says something may still be running": the latter is evidence
   * of a possible credentialed survivor and must fence write admission, while
   * these two would fence ordinary sessions forever with no possible recovery.
   * The credential boundary is carried instead by the durable containment
   * handle, which is retained (not released) in both cases, so the
   * device-isolation blocker survives the close.
   */
  residual?: 'local_subtree_unprovable_on_platform' | 'local_subtree_boundary_unproven';
}

/**
 * Outcome of abortDestroySession().
 *
 * `admissionRestored: false` is NOT an error: the rollback was legitimately
 * refused because the backend is still fencing writes. The daemon must persist
 * that as "still fenced" instead of clearing its journal, or the durable state
 * would claim admission was restored while write() keeps returning false.
 */
export interface SessionAbortDestroyResult {
  admissionRestored: boolean;
  /** Why admission is still fenced, for logs/journal. */
  reason?: string;
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
  /** Notify viewers when an external pane changes geometry after attach. */
  onPaneSizeChange?(cb: (size: { cols: number; rows: number }) => void): void;
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
