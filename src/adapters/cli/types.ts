export interface PtyHandle {
  write(data: string): void;
  /** Send text literally via tmux send-keys -l (tmux mode only).
   *  Returns `false` when the write was dropped (e.g. send-keys failed while the
   *  pane is still alive) so callers can surface a non-submission; `void`/`true`
   *  means the write was issued. Backends that can't tell return void. */
  sendText?(text: string): void | boolean;
  /** Send special keys via tmux send-keys, e.g. 'Enter', 'Escape', 'C-c' (tmux mode only).
   *  Returns `false` on a dropped write (see sendText). */
  sendSpecialKeys?(...keys: string[]): void | boolean;
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
  /** Working directory the CLI was spawned in; cross-checked against the pid file's
   *  cwd field to reject pid reuse / unrelated processes. */
  cliCwd?: string;
}

export type SubmitRecheckResult = boolean | {
  submitted: boolean;
  cliSessionId?: string;
};

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

export interface CliAdapter {
  /** Unique identifier */
  readonly id: string;

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
    initialPrompt?: string;
    botName?: string;
    botOpenId?: string;
    /** This bot's larkAppId. Lets injectsSessionContext adapters (genius) resolve
     *  their per-bot built-in skill injection mode for the system-prompt catalog;
     *  inline-prompt CLIs get theirs from session-manager instead. */
    larkAppId?: string;
    /** UI / response language for prompts injected into the CLI (e.g. zh / en). */
    locale?: import('../../i18n/index.js').Locale;
    /** Optional model name from BotConfig.model. Adapters whose CLI accepts a
     *  `--model` flag (or equivalent) inject it here; adapters whose CLI has no
     *  such concept simply ignore the field. Empty / undefined → CLI default. */
    model?: string;
    /** When true, do not add adapter-default flags that bypass CLI approvals or disable sandboxing. */
    disableCliBypass?: boolean;
    /** Optional session-scoped skill plugin/root prepared by botmux. */
    skillPluginDir?: string;
    /** True when this session runs under per-bot read isolation (the worker
     *  wraps the whole CLI process in a Seatbelt sandbox). Adapters use it for
     *  isolation-specific spawn tweaks only (e.g. Codex forwards its env to
     *  shell subprocesses so `botmux send` finds its cred file) — the isolation
     *  itself is enforced worker-side, not via CLI args. */
    readIsolation?: boolean;
  }): string[];

  /** When true, the adapter passes the initial prompt via CLI args (e.g. -i).
   *  The worker skips queuing the prompt for stdin write. */
  readonly passesInitialPromptViaArgs?: boolean;

  /** Only meaningful with passesInitialPromptViaArgs. When true, the CLI
   *  silently drops its initial-prompt launch flag on a RESUME spawn (e.g.
   *  OpenCode applies `--prompt` to new sessions only and ignores it with
   *  `-s <id>`), so the worker routes the initial prompt through the normal
   *  input queue instead of baking it into args — otherwise the message that
   *  triggered the resume would be lost. */
  readonly initialPromptArgsIgnoredOnResume?: boolean;

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
  ): Promise<void | {
    submitted: boolean;
    cliSessionId?: string;
    /** Non-transient reason when the adapter knows submission is impossible
     *  without waiting for transcript confirmation (for example an unsupported
     *  terminal keybinding). Worker surfaces this immediately. */
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
    readonly format: 'claude-settings' | 'opencode-plugin' | 'grok-hooks';
    /** 可选：SessionStart「真就绪」hook 命令。
     *  - claude-settings：写进全局 settings.json（兼进程级 --settings）
     *  - grok-hooks：写进 `~/.grok/hooks/*.json` 的 SessionStart
     *  命令缺 BOTMUX_* env 时静默 exit 0，不扰独立 CLI。 */
    readonly sessionStartCommand?: string;
  };

  /** true = 该 CLI 通过 hook 接管 askUserQuestion（不再装 botmux-ask skill 兜底）。
   *  注入机制由各 adapter 自行决定（Claude 走 --settings、OpenCode 走插件、
   *  CoCo 走 ensureAskHook 装插件）。 */
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

  /** Ready marker regex — matches when the CLI's input prompt is rendered and
   *  functional.  When set, the idle detector suppresses quiescence-based idle
   *  until this pattern appears in the PTY output.  Checked every cycle (reset
   *  after each prompt), so it gates EVERY idle detection, not just startup.
   *
   *  Examples: CoCo `⏵⏵` status bar, Codex `›` prompt indicator. */
  readonly readyPattern?: RegExp;

  /** When true, the adapter injects a `SessionStart` hook that calls
   *  `botmux session-ready` once the CLI's input box is genuinely rendered —
   *  Claude-family via process-level `--settings`, Grok via its global
   *  `hooks/*.json` (see `hookInstall.format: 'grok-hooks'`). The worker arms
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
   *  session ID) via CLI flags (e.g. --append-system-prompt).  The session
   *  manager skips appending "Session ID: ..." to every user message. */
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

  /** True when this adapter supports running under per-bot read isolation (its
   *  data root is redirectable into BOT_HOME — CLAUDE_CONFIG_DIR / CODEX_HOME —
   *  and it runs correctly under the worker's whole-process Seatbelt wrapper,
   *  with its own built-in sandbox bypassed so nested sandboxing can't hang).
   *  The worker gates on this: a bot with `readIsolation` on but an adapter
   *  that does NOT support it is fail-closed (refuse to start) rather than run
   *  silently unisolated. */
  readonly supportsReadIsolation?: boolean;

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

  /** Curated model candidates surfaced in `botmux setup`. When undefined the
   *  setup flow skips the model prompt for this CLI entirely (e.g. CLIs whose
   *  model is fixed or set via a config file we don't manage). The order is
   *  presented as-is; the setup prompt always appends an "Other / custom"
   *  free-text option, so this list is curation, not a hard whitelist. */
  readonly modelChoices?: readonly string[];

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
   *  REAL + writable inside the file sandbox. The sandbox isolates writes (so the
   *  agent's project edits are reviewable), but a CLI's token refresh / login
   *  must PERSIST to the real auth — otherwise the sandboxed CLI loses its login
   *  (see seed's `bytecloud-auth`). The sandbox binds each existing path rw over
   *  the isolated overlay so auth reads/refreshes/logins hit the real files.
   *  `~` is expanded. Default to NARROW (auth only) so session history stays
   *  isolated — but widen to the CLI's whole state dir when it keeps SQLite DBs
   *  there (e.g. codex): the overlayfs home lacks the POSIX fcntl locks SQLite
   *  needs, so a narrow carve-out leaves the CLI unable to start.
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
   *  whose parent dir re-bind would shadow the project overlay and widen exposure.
   *  Resolved lazily / read AFTER buildArgs() (so a lazily-resolved bin is cached).
   *  Missing/empty → no extra re-expose. */
  sandboxExtraExecPaths?(): readonly string[];

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
}

export type CliId = 'claude-code' | 'seed' | 'relay' | 'aiden' | 'coco' | 'codex' | 'codex-app' | 'cursor' | 'gemini' | 'genius' | 'opencode' | 'antigravity' | 'mtr' | 'hermes' | 'mira' | 'mir' | 'traex' | 'pi' | 'copilot' | 'oh-my-pi' | 'kimi' | 'grok';
