export interface PtyHandle {
  write(data: string): void;
  /** Send text literally via tmux send-keys -l (tmux mode only). */
  sendText?(text: string): void;
  /** Send special keys via tmux send-keys, e.g. 'Enter', 'Escape', 'C-c' (tmux mode only). */
  sendSpecialKeys?(...keys: string[]): void;
  /** Paste text via tmux load-buffer + paste-buffer (auto-brackets if terminal supports it). */
  pasteText?(text: string): void;
}

export interface CliAdapter {
  /** Unique identifier */
  readonly id: string;

  /** Resolved absolute path to the CLI binary */
  readonly resolvedBin: string;

  /** Build spawn arguments (bin comes from resolvedBin).
   *  Note: workingDir is NOT passed here — it's the backend's cwd, not a CLI arg.
   *  When initialPrompt is provided and the adapter supports it, the prompt
   *  is baked into CLI args (e.g. Gemini's -i flag) instead of being written
   *  to stdin after idle detection. */
  buildArgs(opts: {
    sessionId: string;
    resume: boolean;
    initialPrompt?: string;
    botName?: string;
    botOpenId?: string;
  }): string[];

  /** When true, the adapter passes the initial prompt via CLI args (e.g. -i).
   *  The worker skips queuing the prompt for stdin write. */
  readonly passesInitialPromptViaArgs?: boolean;

  /** Write user input to PTY. May fire writes asynchronously (e.g. Aiden delayed Enter).
   *  Resolves when all writes are complete. */
  writeInput(pty: PtyHandle, content: string): Promise<void>;

  /** Optional: absolute path (with ~ expansion handled by caller) to the CLI's
   *  skill directory.  When set, `ensureSkills` will write/refresh skill files
   *  into `{skillsDir}/<skillName>/SKILL.md`.  Undefined = this CLI does not
   *  support skills (or has a non-standard layout not yet integrated). */
  readonly skillsDir?: string;

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

export type CliId = 'claude-code' | 'aiden' | 'coco' | 'codex' | 'gemini' | 'opencode';
