import type { CodexAppTurnInput, TrustedCaller } from '../../types.js';

export interface PtyHandle {
  /** `false` means the backend rejected the write before it could confirm
   * delivery. Callers must not silently promote that result to success. */
  write(data: string): void | boolean;
  /** Send text literally via tmux send-keys -l (tmux mode only).
   *  Returns `false` when the backend could not confirm the write (for example,
   *  send-keys timed out while the pane stayed alive). Delivery may still have
   *  occurred, so callers must treat false as ambiguous rather than proof that
   *  zero bytes landed. `void`/`true` means the write was issued. */
  sendText?(text: string): void | boolean;
  /** Send special keys via tmux send-keys, e.g. 'Enter', 'Escape', 'C-c' (tmux mode only).
   *  Returns `false` on an unconfirmed write (see sendText). */
  sendSpecialKeys?(...keys: string[]): void | boolean;
  /**
   * Epoch-ms timestamp of the most recent Ctrl+C the backend may have injected.
   * Snapshot transports record this before an ambiguous send so adapters with
   * double-Ctrl+C exit gestures can keep their own recovery outside the window.
   */
  readonly lastInjectedCancelAt?: number;
  /** Paste text via tmux load-buffer + paste-buffer (auto-brackets if terminal supports it). */
  pasteText?(text: string): void;
  /** Absolute path to Claude Code's session JSONL; set by worker for claude-code adapter.
   *  Used by writeInput to verify a paste+Enter actually committed (new user-content
   *  line appended) and retry Enter if not — rather than trusting fixed sleep timing. */
  claudeJsonlPath?: string;
  /** PID of the spawned CLI child process; set by worker so the claude-code adapter
   *  can read `~/.claude/sessions/<pid>.json` to follow Claude's authoritative
   *  current session id (which can rotate on resume / mid-session). */
  cliPid?: number;
  /**
   * An explicitly selected remote Codex App Server thread. When set, Codex
   * history-submit verification accepts only this session id instead of
   * checking rollout ownership through the local `codex --remote` client's
   * PID—the rollout belongs to the external App Server, not the viewer.
   */
  expectedCodexSessionId?: string;
  /** Working directory the CLI was spawned in; cross-checked against the pid file's
   *  cwd field to reject pid reuse / unrelated processes. */
  cliCwd?: string;
}

export type SubmitRecheckResult = boolean | {
  submitted: boolean;
  cliSessionId?: string;
};

/** What the adapter can prove about a failed runner-protocol write.
 *
 * Runner adapters write a framed line and then a newline.  `submitted:false`
 * alone is insufficient for recovery: the line may be untouched, may have
 * been flushed as an invalid fragment, or may still be a complete valid frame
 * waiting in the runner's stdin buffer.  Only the first two dispositions are
 * safe to cancel/retry in the same generation. */
export type RunnerSubmissionDisposition =
  | 'submitted'
  | 'untouched'
  | 'flushed_invalid'
  | 'dirty_unknown';

/** Optional per-input correlation metadata. Adapters that do not need it may
 * ignore it; runner-based adapters use the immutable botmux/Lark turn id to
 * keep protocol ids separate from reply-routing ids. */
export interface WriteInputContext {
  turnId?: string;
  trustedCaller?: TrustedCaller;
  /** codex-app only: this turn is authorized to steer into an active turn. */
  codexAppSteerable?: true;
}

/** A session discovered on disk that botmux can resume (import) into a topic —
 *  surfaced by `/adopt`'s second filter. Unlike an AdoptableSession (a live
 *  tmux/zellij pane botmux *observes*), this is a stored transcript botmux
 *  re-spawns via `<cli> --resume <cliSessionId>` in `cwd`; the original CLI need
 *  not be running. */
export interface ResumableSession {
  /** CLI-native session id passed to `--resume` (jsonl basename / rollout
   *  session_meta id / antigravity conversationId). */
  cliSessionId: string;
  /** Working directory the session ran in — where botmux re-spawns the CLI. */
  cwd: string;
  /** Human title (first real user prompt, truncated). */
  title: string;
  /** Epoch ms of last activity (transcript mtime / last submit), for sort + display. */
  lastActivityAt: number;
}

export interface SkillDeliveryCapability {
  readonly nativeKind: 'claude-plugin' | 'skill-root';
  readonly supportsScopedSession: boolean;
  readonly supportsExclusive: boolean;
}

export interface McpGatewayInstallSpec {
  /** Stable CLI-global config file that receives the single `botmux` entry. */
  readonly configPath: string;
  readonly format: 'codex-toml' | 'claude-json';
}

export interface CliAdapter {
  /** Unique identifier */
  readonly id: string;

  /** Controls whether BotMux uses its routing/session XML envelope or the
   *  non-command service-user envelope. The latter preserves the original
   *  message body but adds a fixed safe prefix so OMP never interprets an
   *  external `/`, `!`, `$ `, `.`, or `c` message as local TUI control input. */
  readonly inputEnvelope?: 'standard' | 'service-user';

  /** Whether the process-wide CLI_EXTRA_ARGS escape hatch may append argv.
   *  Defaults to true. Managed service entrypoints should set false so their
   *  fixed auth/session contract cannot be altered by ambient daemon config. */
  readonly allowExtraArgs?: boolean;

  /** Declarative config target for the process-scoped Botmux MCP Gateway. */
  readonly mcpGateway?: McpGatewayInstallSpec;

  /** Resolved absolute path to the CLI binary */
  readonly resolvedBin: string;

  /** Build spawn arguments (bin comes from resolvedBin).
   *  The backend also spawns the process in `workingDir`; adapters may use the
   *  same value when a CLI needs an explicit workspace-root flag.
   *  When initialPrompt is provided and the adapter supports it, the prompt
   *  is baked into CLI args (e.g. Gemini's -i flag) instead of being written
   *  to stdin after idle detection. */
  buildArgs(opts: {
    sessionId: string;
    resume: boolean;
    workingDir?: string;
    /** CLI-native session id used for resume when it differs from botmux's session id. */
    resumeSessionId?: string;
    /** When true, resume the `resumeSessionId` transcript but write forward into a
     *  NEW CLI-native session id instead of the resumed one, leaving the source
     *  transcript untouched — the native "fork/branch a session" primitive
     *  (Claude `--fork-session`, `codex fork`). Only meaningful with resume=true
     *  and a resumeSessionId; adapters whose CLI lacks the primitive ignore it. */
    forkSession?: boolean;
    initialPrompt?: string;
    botName?: string;
    botOpenId?: string;
    /** This bot's larkAppId. Lets injectsSessionContext adapters (genius) resolve
     *  their per-bot built-in skill injection mode for the system-prompt catalog;
     *  inline-prompt CLIs get theirs from session-manager instead. */
    larkAppId?: string;
    /** No-transport session (apiOnly core-only bot OR HTTP virtual chat, i.e.
     *  `!larkTransportEnabled({chatId, apiOnly})`). injectsSessionContext adapters
     *  that build the routing block via `buildBotmuxSystemPromptText`
     *  (claude-code / genius / grok) forward this so the send/@/silence
     *  collaboration block is dropped for a program request/response turn — where
     *  it is both noise and (for usage_silence) a conflict with the per-turn
     *  <botmux_http_response_mode>. Non-injects CLIs get the same gate via
     *  session-manager's buildBotmuxShellHints. Adapters without a routing block
     *  ignore it. */
    noTransport?: boolean;
    /** UI / response language for prompts injected into the CLI (e.g. zh / en). */
    locale?: import('../../i18n/index.js').Locale;
    /** Optional model name from BotConfig.model. Adapters whose CLI accepts a
     *  `--model` flag (or equivalent) inject it here; adapters whose CLI has no
     *  such concept simply ignore the field. Empty / undefined → CLI default. */
    model?: string;
    /** Optional per-bot turn timeout in milliseconds for runner-based adapters
     *  (dsh). Forwarded as `--turn-timeout-ms` to override the runner default;
     *  adapters without a runner turn timeout ignore the field. */
    turnTimeoutMs?: number;
    /** Optional per-turn reasoning effort (codex `model_reasoning_effort`,
     *  traex `model_reasoning_effort`, grok `--reasoning-effort`). Only adapters
     *  with an explicit reasoning control honor it; others ignore. */
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    /** When true, do not add adapter-default flags that bypass CLI approvals or disable sandboxing. */
    disableCliBypass?: boolean;
    /** Codex App only: restricted local browser extension bridge. */
    codexBrowser?: import('../../core/codex-browser-config.js').CodexBrowserConfig;
    /** Codex-family only: when true (default from the global `bypassCodexHookTrust`
     *  toggle, still ANDed with `!disableCliBypass` by the worker), pass
     *  `--dangerously-bypass-hook-trust` so a headless plain-TUI launch does not
     *  wedge on Codex 0.14x's interactive "Press t to trust" gate. Undefined ⇒
     *  treated as false by adapters (the worker always sends an explicit boolean
     *  for codex/traex). Does NOT apply to `--remote`/app-server/exec paths. */
    bypassHookTrust?: boolean;
    /** Optional session-scoped skill plugin/root prepared by botmux. */
    skillPluginDir?: string;
    /** True when this session runs under per-bot read isolation (the worker
     *  wraps the whole CLI process in a Seatbelt sandbox). Adapters use it for
     *  isolation-specific spawn tweaks only (e.g. Codex forwards its env to
     *  shell subprocesses so `botmux send` finds its cred file) — the isolation
     *  itself is enforced worker-side, not via CLI args. */
    readIsolation?: boolean;
    /** Hybrid Codex input mode. When set, the codex adapter launches the TUI as
     *  a client of an external app-server (`--remote <ws>`) and resumes the
     *  botmux-owned thread, so user input is delivered via JSON-RPC (turn/start)
     *  instead of a drop-prone tmux paste. Both are set together or neither. */
    remoteWsUrl?: string;
    remoteThreadId?: string;
  }): string[];

  /** Adapter-specific chance to rewrite the first prompt before buildArgs sees
   *  it. Used for CLIs that support file positional args for long prompts: the
   *  worker can still treat the prompt as args-baked and skip stdin fallback. */
  prepareInitialPromptArg?(opts: {
    initialPrompt: string;
    sessionId: string;
    sessionDataDir?: string;
  }): {
    initialPrompt: string;
    readonlyRoots?: string[];
    cleanupPaths?: string[];
    cleanupDirs?: string[];
    /** Safe, short TUI input used only when worker policy must defer this
     * prepared argv prompt (startup commands, durable cold-start, etc.). */
    deferredInput?: {
      content: string;
      additionalArgs?: string[];
      env?: Record<string, string>;
    };
  };

  /** When true, the adapter passes the initial prompt via CLI args (e.g. -i).
   *  The worker skips queuing the prompt for stdin write unless another
   *  defer condition routes it through the post-start input queue. */
  readonly passesInitialPromptViaArgs?: boolean;

  /** Only meaningful with passesInitialPromptViaArgs. If set, prompts whose
   *  UTF-8 byte length is GREATER than this adapter-specific limit are not
   *  baked into launch args; the worker defers them to the normal post-start
   *  input queue. This guards backend launchers (notably tmux) whose command
   *  string limit can be much lower than OS ARG_MAX. */
  readonly maxInitialPromptArgBytes?: number;

  /** Only meaningful with passesInitialPromptViaArgs. When true, the CLI
   *  silently drops its initial-prompt launch flag on a RESUME spawn (e.g.
   *  OpenCode applies `--prompt` to new sessions only and ignores it with
   *  `-s <id>`), so the worker routes the initial prompt through the normal
   *  input queue instead of baking it into args — otherwise the message that
   *  triggered the resume would be lost. */
  readonly initialPromptArgsIgnoredOnResume?: boolean;

  readonly rawCommandInputMode?: 'paste-line';
  readonly rawCommandSettleMs?: number;

  /** Build a shell command string the user can paste into a terminal to
   *  resume this CLI session locally — independent of botmux. Used by the
   *  "session closed" card so users have an obvious way to keep the
   *  conversation outside the bot.
   *
   *  Returns `null` when the CLI doesn't support precise per-session resume
   *  from CLI args (e.g. gemini's "latest only" mode), or when the CLI-native
   *  session id can't be resolved (e.g. codex history file is missing).
   *  The card falls back to a static note in those cases.
   *
   *  Implementations should print the *default* binary name (`claude`,
   *  `codex`, etc.) rather than `cliPathOverride` — the override is a
   *  server-side setting and users running the command on their own
   *  laptop usually have the default binary on PATH. */
  buildResumeCommand?(opts: {
    sessionId: string;
    /** CLI-native session id from session.cliSessionId, when available. */
    cliSessionId?: string;
  }): string | null;

  /** True when this adapter's `buildArgs` can only resume a PRECISE
   *  `resumeSessionId` — a resume without one silently starts a FRESH session
   *  (no `--continue` / "latest" fallback, which would risk loading a SIBLING
   *  botmux session's conversation). The worker treats resume-without-id as a
   *  fresh-demotion (drops resume, emits the existing "历史会话无法恢复" notice
   *  once) so upper layers never describe a fresh launch as "history restored".
   *  Adapters that can always resume (botmux sessionId IS the CLI session id,
   *  e.g. claude-code/grok) or that ignore resume entirely leave this unset. */
  readonly resumeRequiresCliSessionId?: boolean;

  /** Write user input to PTY. May fire writes asynchronously (e.g. Aiden delayed Enter).
   *  Resolves when all writes are complete.
   *
   *  Return value is optional: adapters that can verify the submit (e.g. Claude
   *  Code via session JSONL) return `{ submitted: false }` when all retries
   *  failed, so the worker can surface that to the user. `void` / undefined
   *  means "no verification performed, assume OK".
   *
   *  When `submitted === false`, adapters may attach a `recheck` closure that
   *  re-scans the transcript on demand. The worker calls it after a delay so
   *  slow-path submits (cold-start, slow UserPromptSubmit hooks, busy disk)
   *  that landed *after* the in-band retry budget exhausted are recognised
   *  and the user_notify warning is suppressed. The closure must be cheap
   *  and idempotent — worker may invoke it multiple times. */
  writeInput(
    pty: PtyHandle,
    content: string,
    context?: WriteInputContext,
  ): Promise<void | {
    submitted: boolean;
    cliSessionId?: string;
    submissionDisposition?: RunnerSubmissionDisposition;
    /** Non-transient reason when the adapter knows submission is impossible
     *  without waiting for transcript confirmation (for example an unsupported
     *  terminal keybinding). Worker surfaces this immediately. */
    failureReason?: string;
    recheck?: () => SubmitRecheckResult | Promise<SubmitRecheckResult>;
  }>;

  /** Optional structured input path for adapters whose protocol can keep
   * application context out of the visible user message. The worker calls this
   * only when a typed sidecar is present; every other adapter continues through
   * writeInput with byte-for-byte legacy content. */
  writeStructuredInput?(
    pty: PtyHandle,
    content: string,
    codexAppInput: CodexAppTurnInput,
    context?: WriteInputContext,
  ): Promise<void | {
    submitted: boolean;
    cliSessionId?: string;
    submissionDisposition?: RunnerSubmissionDisposition;
    failureReason?: string;
    recheck?: () => SubmitRecheckResult | Promise<SubmitRecheckResult>;
  }>;

  /** Optional: absolute path (with ~ expansion handled by caller) to the CLI's
   *  skill directory.  When set, `ensureSkills` will write/refresh skill files
   *  into `{skillsDir}/<skillName>/SKILL.md`.  Undefined = this CLI does not
   *  support skills (or has a non-standard layout not yet integrated). */
  readonly skillsDir?: string;

  /** Optional: absolute path (with ~ expansion handled by caller) to a Claude
   *  Code *plugin* root. When set, built-in skills are written into
   *  `{pluginDir}/skills/<name>/SKILL.md` alongside a `.claude-plugin/plugin.json`
   *  manifest, and the adapter passes `--plugin-dir {pluginDir}` at spawn so the
   *  skills are scoped to botmux-spawned sessions only — they never land in the
   *  user's global `~/.claude/skills`, so a standalone `claude` won't surface
   *  (and mis-fire) them. Mutually exclusive with `skillsDir`. */
  readonly pluginDir?: string;

  /** Optional native skill delivery support for user/team custom skills.
   *  This is separate from `skillsDir`/`pluginDir`, which are still used by
   *  botmux-owned built-in bridge skills. */
  readonly skillDelivery?: SkillDeliveryCapability;

  /** hook 安装描述：spawn 时写入各 CLI 的 hook 配置，使 askUserQuestion 事件转发到
   *  `botmux hook <cliId>`。undefined = 不通过 hook 接管 askUserQuestion。 */
  readonly hookInstall?: {
    /** 待写入的配置文件路径（~ 由 installer 展开）。 */
    readonly configPath: string;
    /** 写入格式：决定 installer 如何合并进既有配置。 */
    readonly format: 'claude-settings' | 'opencode-plugin' | 'opencode2-plugin' | 'grok-hooks';
    /** 可选：SessionStart「真就绪」hook 命令。
     *  - claude-settings：写进全局 settings.json（兼进程级 --settings）
     *  - grok-hooks：写进 `~/.grok/hooks/*.json` 的 SessionStart
     *  命令缺 BOTMUX_* env 时静默 exit 0，不扰独立 CLI。 */
    readonly sessionStartCommand?: string;
    /** 可选：UserPromptSubmit per-turn 上下文 hook 命令（#794）。
     *  - claude-settings：写进全局 settings.json 的 hooks.UserPromptSubmit
     *  hook 子进程按 stdin 的 prompt 内容指纹读回 daemon 预写的 sidecar，
     *  以 additionalContext 注入为该轮 system-reminder；缺 env/未命中时
     *  空输出 exit 0（fail-open）。 */
    readonly userPromptSubmitCommand?: string;
  };

  /** true = 该 CLI 的 Hook 已接管 askUserQuestion（不再装 botmux-ask
   *  skill 兜底）。注入机制由各 adapter 自行决定（Claude 走 --settings、
   *  OpenCode 走插件、CoCo 走 ensureAskHook）。 */
  readonly asksViaHook?: boolean;

  /** 命令式 hook 安装钩子：适用于无法靠纯写文件完成、需要 spawn CLI 子命令的场景
   *  （CoCo 需要 `coco plugin install`）。声明式写文件的 CLI 用 `hookInstall`；本方法
   *  与 `hookInstall` 互斥。每个 daemon 生命周期由 ensureCliSkills 调用一次。
   *  实现内部自行 try/catch，失败只 warn 不抛。 */
  ensureAskHook?(): void;

  /** Completion marker regex (beyond generic quiescence). undefined = quiescence only. */
  readonly completionPattern?: RegExp;

  /** Busy marker regex — matches when the CLI is explicitly rendering a
   *  still-running state. Used for re-attached persistent sessions where there
   *  may be no new PTY output: if the current screen does NOT match this marker,
   *  the worker may safely let quiescence mark the session idle. */
  readonly busyPattern?: RegExp;

  /**
   * Optional runtime session busy check against the CLI's native state store
   * (e.g. OpenCode SQLite db). When true, suppresses premature idle detection
   * even if PTY output has quiesced.
   */
  readonly isSessionBusy?: (opts: { sessionId: string; cliSessionId?: string }) => boolean;

  /** Opt-in positive marker for an idle→working edge observed in PTY output.
   *  Kept separate from busyPattern because transcript/full-screen redraws may
   *  contain old busy text; existing adapters remain opt-out by default. */
  readonly idleToBusyPattern?: RegExp;

  /** Opt-in PRE-idle busy latch for static busy screens that emit no further
   *  PTY bytes after the initial render (e.g. a capacity-queue notice drawn
   *  alongside a readyPattern status bar). Unlike busyPattern — a viewport
   *  probe that only runs on backends whose screen cache is authoritative for
   *  mutation — this consumes raw PTY evidence inside IdleDetector, so it also
   *  holds on backends where screen capture must not mutate state (ZMX):
   *  while latched, screen-derived idle is suppressed until a PTY chunk with
   *  explicit composer evidence (staticBusyClearPattern) redraws AFTER the
   *  last queue marker. The latch is set from the rolling outputTail (queue
   *  markers can be split across chunks); clear is decided by the LAST
   *  static/clear evidence position within the current chunk. reset() rebases
   *  it. External structured completion (fireIdle) bypasses the latch — it is
   *  authoritative independently of the screen observer. */
  readonly staticBusyPattern?: RegExp;

  /** Opt-in CLEAR pattern for the pre-idle static-busy latch. Matches the
   *  real composer prompt (e.g. line-start ›/❯) so the latch can clear when
   *  the queue screen redraws into the composer. Must NOT match the status
   *  bar (e.g. `\d+% left`) — the queue screen itself carries a status bar,
   *  so the broad readyPattern can never clear the latch. Only tested against
   *  the CURRENT chunk (fresh composer evidence), not the rolling tail. */
  readonly staticBusyClearPattern?: RegExp;

  /** Ready marker regex — matches when the CLI's input prompt is rendered and
   *  functional.  When set, the idle detector suppresses quiescence-based idle
   *  until this pattern appears in the PTY output.  Checked every cycle (reset
   *  after each prompt), so it gates EVERY idle detection, not just startup.
   *
   *  Examples: CoCo `⏵⏵` status bar, Codex `›` prompt indicator. */
  readonly readyPattern?: RegExp;

  /** When true, the adapter injects a `SessionStart` hook that calls
   *  `botmux session-ready` once the CLI's input box is genuinely rendered —
   *  Claude-family via its effective settings.json, Grok via its global
   *  `hooks/*.json` (see `hookInstall`). The worker arms
   *  a ready-gate on this flag and holds the FIRST prompt until the signal
   *  arrives (or a fallback timeout), so a startup launcher's selector `❯` —
   *  which falsely matches `readyPattern` — can't trip an early flush that
   *  the selector eats. undefined/false → no gate (every other CLI behaves
   *  exactly as before). */
  readonly injectsReadyHook?: boolean;

  /** CLI-specific system hints injected into the initial prompt.
   *  e.g. "use Read tool for attachments", "don't use PlanMode" */
  readonly systemHints: string[];

  /** When true, the adapter injects Lark session context (instructions +
   *  session ID) via CLI flags (Claude/genius: --append-system-prompt;
   *  Grok: --rules).  The session manager skips the inline <botmux_routing>
   *  / <identity> / <session_id> envelope on user messages. */
  readonly injectsSessionContext?: boolean;

  /** When true, the CLI accepts input while busy (type-ahead). Worker writes
   *  queued messages immediately instead of waiting for idle detection.
   *  Only set for CLIs whose input handling is known to tolerate this —
   *  Claude Code buffers input internally and processes it after the current
   *  turn; CoCo (0.120.32+) parks it in its TUI queue and writes the transcript
   *  user event only at dequeue time (transcript stays interleaved); Codex
   *  (0.134.0+) parks it too but STEERS it into the active turn — a tool-running
   *  turn can merge the queued input into one final (rollout: user1 → user2 →
   *  assistant_final). CodexBridgeQueue's HOL-block-drop keeps attribution
   *  correct for both shapes. */
  readonly supportsTypeAhead?: boolean;

  /** True when this CLI supports a UserPromptSubmit hook whose additionalContext
   *  is injected as an INVISIBLE system-reminder (not rendered into the visible
   *  transcript). When true and the per-bot `envelopeInjection` setting is
   *  `auto`, the daemon moves the per-turn reminder/whiteboard blocks out of the
   *  user turn text and into a sidecar that `botmux user-prompt-hook` reads back.
   *  Only set for CLIs verified end-to-end; codex renders hook context as a
   *  visible developer message and must NOT set this. */
  readonly supportsInvisiblePromptHook?: boolean;

  /** The adapter exposes a transcript-backed end-of-turn boundary that the
   *  worker can report independently of whether fallback output is visible.
   *  Durable meeting delivery is fail-closed for adapters without this
   *  capability; `queued` and `final_output` are not completion receipts. */
  readonly reliableTurnTerminal?: boolean;

  /** The adapter PUBLISHES a structured `limited` screen_update from a machine
   *  rate-limit signal in its transcript (not from scraping screen text). When
   *  true, `isStructuredRateLimitAuthoritative` treats it as the sole rate-limit
   *  authority and suppresses the screen-scan `rate` heuristic — otherwise the
   *  model's own output or a dev editing rate-limit code puts "429" / "exceeded
   *  retry limit" on screen and the scraper false-positives (it cannot tell a
   *  printed "429" from a request that actually returned 429). The Claude family
   *  is authoritative via `claudeDataDir` regardless of this flag; Codex sets it
   *  because the worker's `maybeEmitCodexStructuredRateLimit` reads the rollout's
   *  `codex_rate_limited` terminal and emits `limited`. Do NOT set it for a
   *  codexBridgeQueue CLI that has no such emit (grok / traex / pi / hermes /
   *  mtr / cursor) — suppressing their screen scan would silently drop the real
   *  429 backoff + Dashboard「需要你」signal. */
  readonly emitsStructuredRateLimit?: boolean;

  /** True when this adapter supports running under per-bot read isolation (its
   *  data root is redirectable into BOT_HOME — CLAUDE_CONFIG_DIR / CODEX_HOME —
   *  and it runs correctly under the worker's whole-process Seatbelt wrapper,
   *  with its own built-in sandbox bypassed so nested sandboxing can't hang).
   *  The worker gates on this: a bot with `readIsolation` on but an adapter
   *  that does NOT support it is fail-closed (refuse to start) rather than run
   *  silently unisolated. */
  readonly supportsReadIsolation?: boolean;

  /** CLI 支持会话内移动工作目录（如 Claude Code ≥2.1.205 的 /cd）。
   *  ⚠️ 历史能力位，**已从角色切换路由退场**：`botmux role switch` 现统一走「杀 CLI +
   *  `--resume` 在新 cwd respawn」（适配器无关，见 dashboard-ipc-server 的 cd 路由与
   *  worker 的 restart case），不再按本字段分流 idle 注入 vs 冷启动。字段保留仅供未来
   *  可能的会话内移动复用，当前无生产读取点。 */
  readonly supportsSessionCwdMove?: boolean;

  /** When true, the worker's soft first-prompt timeout keeps queued input held
   *  until this adapter's `readyPattern` appears. Use only for CLIs whose startup
   *  screens can accept and swallow stdin before the real composer exists; the
   *  worker still enforces a longer hard timeout so the first prompt cannot hang
   *  forever if the ready marker changes or the CLI stalls. */
  readonly deferFirstPromptTimeoutUntilReady?: boolean;

  /** When true, worker may squash additional queued Lark messages into the
   *  pending tail instead of preserving one botmux turn per queued message.
   *  Keep this opt-in: most adapters rely on distinct turnId / card routing. */
  readonly mergeQueuedInput?: boolean;

  /** Whether CLI uses alternate screen buffer */
  readonly altScreen: boolean;

  /** Whether read-only Web Terminal viewers may forward SGR wheel events.
   *  This is narrower than write access: the worker accepts only validated
   *  mouse-wheel escape sequences, for TUIs whose transcript can only scroll
   *  inside the alternate-screen app viewport. */
  readonly readOnlyRemoteScroll?: boolean;

  /** Curated model candidates surfaced in `botmux setup`. When undefined the
   *  setup flow skips the model prompt for this CLI entirely (e.g. CLIs whose
   *  model is fixed or set via a config file we don't manage). The order is
   *  presented as-is; the setup prompt always appends an "Other / custom"
   *  free-text option, so this list is curation, not a hard whitelist. */
  readonly modelChoices?: readonly string[];

  /** Optional live model discovery: enumerate the models this CLI can actually
   *  use right now (e.g. `traex debug models` prints its full catalogue as
   *  JSON). The dashboard model picker invokes it on demand for the SELECTED
   *  CLI only — never in a scan over all adapters — and merges the result with
   *  `modelChoices`. Contract:
   *  - MUST be fail-soft: return null on any error, timeout, or unparseable
   *    output, never throw (the caller falls back to `modelChoices`);
   *  - MUST be self-contained: one short-lived subprocess (or pure file read)
   *    with a tight timeout (≤10s) and a capped output buffer — catalogue
   *    JSON can be hundreds of KB;
   *  - absent = the CLI cannot enumerate its models; the picker shows
   *    `modelChoices` only. */
  readonly detectModels?: () => Promise<readonly string[] | null>;

  /** Claude-family CLIs only (claude-code, seed). The data root holding
   *  `projects/<hash>/<id>.jsonl`, `sessions/<pid>.json`, `tasks/`,
   *  `keybindings.json` and `settings.json`. When set, the worker drives the
   *  JSONL submit-confirmation, bridge fallback and pid resolution against this
   *  dir (instead of hardcoding `~/.claude`). undefined → not Claude-family. */
  readonly claudeDataDir?: string;

  /** Claude-family CLIs only. Path to the `.claude.json` folder-trust / state
   *  file (pre-accepted at spawn so a fresh workingDir doesn't block on the
   *  interactive trust dialog). `~/.claude.json` for Claude Code; inside the
   *  data root for forks that set CLAUDE_CONFIG_DIR. */
  readonly claudeStateJsonPath?: string;

  /** Paths (files or dirs) holding THIS CLI's auth / login state that must stay
   *  REAL + writable inside the file sandbox. The sandbox isolates the filesystem
   *  to a deny-by-default whitelist (so the agent only sees the rule paths), but a
   *  CLI's token refresh / login must PERSIST to the real auth — otherwise the
   *  sandboxed CLI loses its login (see seed's `bytecloud-auth`). The sandbox binds
   *  each existing path rw (real host path) so auth reads/refreshes/logins hit the
   *  real files. `~` is expanded. Default to NARROW (auth only) so session history
   *  stays out of the sandbox — but widen to the CLI's whole state dir when it keeps
   *  SQLite DBs there (e.g. codex): only whitelisted paths exist in the sandbox, so
   *  a narrow carve-out leaves the DB dir absent and the CLI unable to start.
   *  undefined / empty → no carve-out. */
  readonly authPaths?: readonly string[];

  /** Absolute paths of ADDITIONAL executables this adapter spawns as a SECOND
   *  stage INSIDE the file sandbox, beyond `resolvedBin` (the bwrap target). The
   *  sandbox masks `/run` with a fresh tmpfs; any such binary living under
   *  `/run/...` (fnm/nvm/volta bin symlink farms) would then vanish and crash-loop
   *  the CLI, so the sandbox re-exposes their containing dirs read-only.
   *
   *  Most adapters omit this — their `resolvedBin` IS the binary that runs. It is
   *  for adapters whose `resolvedBin` is a launcher: codex-app's `resolvedBin` is
   *  node running the runner, while the REAL `codex` (spawned later for the
   *  app-server) is the one that must survive `--tmpfs /run`.
   *
   *  Return ONLY executable paths — never plain path args like the working dir,
   *  whose parent dir re-bind would shadow the project bind and widen exposure.
   *  Resolved lazily / read AFTER buildArgs() (so a lazily-resolved bin is cached).
   *  Missing/empty → no extra re-expose. */
  sandboxExtraExecPaths?(): readonly string[];

  /** Absolute paths (files or dirs) this adapter needs visible READ-ONLY inside
   *  the file sandbox — distinct from `authPaths`, which are bound READ-WRITE.
   *  Use this for host state the CLI only READS (e.g. traex/coco's first-run
   *  migration done-markers at the ~/.trae root): exposing them read-only lets
   *  the CLI see them without widening the writable surface to sibling
   *  hook/plugin/skill code. Wired into the fs-policy `readonlyRoots` channel
   *  (→ readOnly rule). `~`-expanded + existence-filtered by the worker, so
   *  listing a path absent on this host is a no-op. Missing/empty → nothing extra
   *  exposed. Return ONLY paths safe to reveal read-only (never credentials). */
  sandboxReadonlyPaths?(env?: NodeJS.ProcessEnv): readonly string[];

  /** Credential files a trusted service CLI must read inside the sandbox.
   *  This is deliberately separate from ordinary readonlyRoots so adapters
   *  cannot expose secrets accidentally. The worker validates exact regular
   *  files and fs-policy emits them mandatory read-only, except that a
   *  no-transport turn suppresses entries inside Feishu authority roots. Use
   *  only when the CLI's model-facing tool surface has no general file/shell
   *  escape, and return exact files rather than parent directories. */
  sandboxSecretReadonlyPaths?(env?: NodeJS.ProcessEnv): readonly string[];

  /** Extra env merged into the spawned child's environment. Used by Claude-family
   *  forks to point the CLI at its data root (e.g. Seed's `CLAUDE_CONFIG_DIR`).
   *  Keys placed here are also forwarded through the tmux backend (see
   *  BOTMUX_INJECTED_ENV_KEYS). undefined → inherit the worker env unchanged. */
  readonly spawnEnv?: Readonly<Record<string, string>>;

  /** Optional: pre-flight check for resume targets.
   *
   *  Called with `resume=true` before spawn so a missing conversation JSONL /
   *  rollout / DB entry does not produce a CLI-level "No conversation found"
   *  exit code 1 — which would otherwise be amplified into an auto-restart
   *  crash loop by the daemon's claude_exit handler.
   *
   *  Return `true` = resume target looks present (spawn normally with --resume).
   *  Return `false` = target is provably missing → worker will fall back to a
   *  FRESH session (resume=false, drop cliSessionId, log + user_notify once).
   *  Return `undefined` / omit = adapter cannot tell cheaply → rely on the
   *  worker's SECONDARY guard (2nd restart forces fresh) so unknown-shape CLIs
   *  still degrade without crash-looping.
   *
   *  Must be synchronous, cheap, and conservative. An adapter that can verify
   *  the resume target without spawning a subprocess implements this; others
   *  simply leave it undefined (the secondary guard is always active). */
  checkResumeTargetExists?(opts: {
    sessionId: string;
    /** CLI-native session id from session.cliSessionId, when available. */
    cliSessionId?: string;
    /** Working directory the CLI will spawn in. Used by Claude-family to
     *  locate <projects>/<cwdHash>/<id>.jsonl. */
    workingDir?: string;
    /** Claude-family data dir (~/.claude, ~/.claude-runtime, …) so the probe
     *  targets the SAME root the adapter will actually write into. */
    dataDir?: string;
    /** Optional CLI-specific resume store path resolved by the worker after
     *  applying per-bot env/profile settings (for example Hermes state.db). */
    stateDbPath?: string;
  }): boolean | undefined;

  /** Optional: discover sessions resumable from this CLI's on-disk transcript
   *  store (powers `/adopt`'s second filter — paseo-style import). Daemon-side,
   *  pure filesystem (no PTY / subprocess), most-recent first, capped to `limit`.
   *  undefined = this CLI has no discoverable per-session store (resume only via
   *  botmux's own id, an opaque store, or no per-session resume at all). */
  listResumableSessions?(opts: {
    limit: number;
    /** CLI-native session ids to skip (sessions botmux already runs live). Applied
     *  BEFORE truncating to `limit` — and, where the id is the on-disk filename
     *  (claude-family), before parsing — so a host with many live sessions still
     *  surfaces `limit` resumable ones instead of being starved by exclusion. */
    exclude?: ReadonlySet<string>;
  }): Promise<ResumableSession[]>;

  /** Optional CLI version command override. Defaults to `[resolvedBin, '--version']`. */
  versionCommand?(): { bin: string; args: string[] };

  /** Slash commands this CLI natively supports and botmux should pass through
   *  by default for this adapter. Unlike the global passthrough allowlist, these
   *  are scoped to the current CLI so unsupported commands do not leak to other
   *  adapters. */
  readonly defaultPassthroughCommands?: readonly string[];

  /** Build the CLI-native command that renames the current interactive session.
   *  The title has already been normalized to one control-character-free line
   *  by the daemon. Undefined means this adapter has no proven native rename
   *  command and must never receive a best-guess slash command. */
  buildSessionRenameCommand?(title: string): string;
}

export type CliId = 'claude-code' | 'seed' | 'relay' | 'aiden' | 'coco' | 'codex' | 'codex-app' | 'cursor' | 'gemini' | 'genius' | 'opencode' | 'opencode2' | 'antigravity' | 'mtr' | 'hermes' | 'mira' | 'mir' | 'traex' | 'pi' | 'copilot' | 'oh-my-pi' | 'ebsd' | 'kimi' | 'grok' | 'kiro-cli' | 'riff' | 'reasonix' | 'dsh' | 'dsh-tui' | 'mojo';
