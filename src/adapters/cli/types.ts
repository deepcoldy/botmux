export interface PtyHandle {
  write(data: string): void;
  /** Send text literally via tmux send-keys -l (tmux mode only). */
  sendText?(text: string): void;
  /** Send special keys via tmux send-keys, e.g. 'Enter', 'Escape', 'C-c' (tmux mode only). */
  sendSpecialKeys?(...keys: string[]): void;
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
    /** UI / response language for prompts injected into the CLI (e.g. zh / en). */
    locale?: import('../../i18n/index.js').Locale;
  }): string[];

  /** When true, the adapter passes the initial prompt via CLI args (e.g. -i).
   *  The worker skips queuing the prompt for stdin write. */
  readonly passesInitialPromptViaArgs?: boolean;

  /** Build a shell command string the user can paste into a terminal to
   *  resume this CLI session locally — independent of botmux. Used by the
   *  "session closed" card so users have an obvious way to keep the
   *  conversation outside the bot.
   *
   *  Returns `null` when the CLI doesn't support precise per-session resume
   *  from CLI args (e.g. opencode, gemini's "latest only" mode), or when
   *  the CLI-native session id can't be resolved (e.g. codex history file
   *  is missing). The card falls back to a static note in those cases.
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
    recheck?: () => boolean | Promise<boolean>;
  }>;

  /** Optional: absolute path (with ~ expansion handled by caller) to the CLI's
   *  skill directory.  When set, `ensureSkills` will write/refresh skill files
   *  into `{skillsDir}/<skillName>/SKILL.md`.  Undefined = this CLI does not
   *  support skills (or has a non-standard layout not yet integrated). */
  readonly skillsDir?: string;

  /** hook 安装描述：spawn 时写入各 CLI 的 hook 配置，使 askUserQuestion 事件转发到
   *  `botmux hook <cliId>`。undefined = 不通过 hook 接管 askUserQuestion。 */
  readonly hookInstall?: {
    /** 待写入的配置文件路径（~ 由 installer 展开）。 */
    readonly configPath: string;
    /** 写入格式：决定 installer 如何合并进既有配置。 */
    readonly format: 'claude-settings' | 'opencode-plugin';
  };

  /** Completion marker regex (beyond generic quiescence). undefined = quiescence only. */
  readonly completionPattern?: RegExp;

  /** Ready marker regex — matches when the CLI's input prompt is rendered and
   *  functional.  When set, the idle detector suppresses quiescence-based idle
   *  until this pattern appears in the PTY output.  Checked every cycle (reset
   *  after each prompt), so it gates EVERY idle detection, not just startup.
   *
   *  Examples: CoCo `⏵⏵` status bar, Codex `›` prompt indicator. */
  readonly readyPattern?: RegExp;

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
   *  turn. Others (e.g. CoCo) may drop or garble input while rendering. */
  readonly supportsTypeAhead?: boolean;

  /** Whether CLI uses alternate screen buffer */
  readonly altScreen: boolean;
}

export type CliId = 'claude-code' | 'aiden' | 'coco' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'antigravity' | 'mtr';
