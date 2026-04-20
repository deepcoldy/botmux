/**
 * Headless terminal renderer: feeds PTY data into an xterm-headless instance
 * and exposes viewport snapshots for the Feishu streaming card (PNG render,
 * export-text action, ScreenAnalyzer).
 *
 * Snapshot semantics match PNG: both read the current viewport
 * [baseY, baseY + rows). This keeps text export and screenshot consistent
 * even for alt-screen CLIs (Claude Code) where scrollback isn't meaningful.
 */
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
import { createHash } from 'node:crypto';

/** Strip box-drawing characters and collapse runs of spaces. */
function cleanBoxDrawing(line: string): string {
  return line
    .replace(/[─━│┌┐└┘├┤┬┴┼╭╮╯╰]/g, ' ')
    .replace(/  +/g, ' ')
    .trimEnd();
}

/** Bare prompt line: ❯ (Claude) or > (Aiden) with optional trailing whitespace */
const BARE_PROMPT_RE = /^[❯>]\s*$/;
/** Input echo: ❯ or > followed by user text */
const INPUT_ECHO_RE = /^[❯>]\s+\S/;
/** Empty or whitespace-only */
const BLANK_RE = /^\s*$/;

/** Safety clamp — even if the xterm is resized wider, don't read past this. */
const SNAPSHOT_COLS = 160;

export class TerminalRenderer {
  private terminal: InstanceType<typeof Terminal>;
  private lastHash = '';

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({ cols, rows, allowProposedApi: true });
  }

  /** Feed raw PTY data into the virtual terminal. */
  write(data: string): void {
    this.terminal.write(data);
  }

  /** Reset the change-detection hash so the next snapshot registers as changed. */
  markNewTurn(): void {
    this.lastHash = '';
  }

  /** Filtered viewport snapshot — drops the bare prompt + input echo lines. */
  snapshot(): { content: string; changed: boolean } {
    const content = this.readViewport(true);
    const hash = createHash('md5').update(content).digest('hex');
    const changed = hash !== this.lastHash;
    this.lastHash = hash;
    return { content, changed };
  }

  /**
   * Raw viewport snapshot — no line filtering. Used by ScreenAnalyzer which
   * needs the full screen including ❯ cursor lines.
   */
  rawSnapshot(): string {
    return this.readViewport(false);
  }

  private readViewport(filter: boolean): string {
    const buffer = this.terminal.buffer.active;
    const readCols = Math.min(SNAPSHOT_COLS, this.terminal.cols);
    const baseY = buffer.baseY;
    const endY = baseY + this.terminal.rows;

    const lines: string[] = [];
    for (let y = baseY; y < endY; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const s = cleanBoxDrawing(line.translateToString(true, 0, readCols));
      if (filter && (BARE_PROMPT_RE.test(s) || INPUT_ECHO_RE.test(s))) continue;
      lines.push(s);
    }

    if (filter) {
      while (lines.length > 0 && BLANK_RE.test(lines[0])) lines.shift();
    }
    while (lines.length > 0 && BLANK_RE.test(lines[lines.length - 1])) lines.pop();

    return lines.join('\n');
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  /** Expose the underlying xterm-headless instance for screenshot rendering. */
  get xterm(): InstanceType<typeof Terminal> { return this.terminal; }

  dispose(): void {
    this.terminal.dispose();
  }
}
