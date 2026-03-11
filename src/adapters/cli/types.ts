export interface PtyHandle {
  write(data: string): void;
}

export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CliAdapter {
  /** Unique identifier */
  readonly id: string;

  /** Resolved absolute path to the CLI binary */
  readonly resolvedBin: string;

  /** Build spawn arguments (bin comes from resolvedBin).
   *  Note: workingDir is NOT passed here — it's the backend's cwd, not a CLI arg. */
  buildArgs(opts: {
    sessionId: string;
    resume: boolean;
  }): string[];

  /** Write user input to PTY. May fire writes asynchronously (e.g. Aiden delayed Enter).
   *  Resolves when all writes are complete. */
  writeInput(pty: PtyHandle, content: string): Promise<void>;

  /** Install MCP server config. Idempotent — skips if up to date. */
  ensureMcpConfig(entry: McpServerEntry): void;

  /** Completion marker regex (beyond generic quiescence). undefined = quiescence only. */
  readonly completionPattern?: RegExp;

  /** Whether CLI uses alternate screen buffer */
  readonly altScreen: boolean;
}

export type CliId = 'claude-code' | 'aiden' | 'coco' | 'codex';
