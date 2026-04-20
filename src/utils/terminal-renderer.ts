/**
 * Headless terminal renderer: feeds PTY data into an xterm-headless instance
 * and periodically snapshots the rendered screen for Feishu card updates.
 *
 * Minimal pipeline:
 *   - baseline tracking (turnBaselineY + baselineDeferred) isolates the current
 *     turn so previous-turn content never leaks into the streaming card
 *   - read from baseline to end, clamp per-line width at SNAPSHOT_COLS
 *   - strip box-drawing chars, drop the bare prompt line and input echo,
 *     trim blank head/tail
 *
 * The card's text is a best-effort preview — PNG screenshot is the
 * authoritative view. Keep this path cheap.
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
  /** Absolute line index where the current turn starts. */
  private turnBaselineY = 0;
  /** Baseline not yet established — snapshots return empty until the first
   *  write() arrives after markNewTurn(), which sets the baseline at the
   *  cursor position right before new data flows in. Prevents previous-turn
   *  content from leaking into the new turn's card. */
  private baselineDeferred = true;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({ cols, rows, allowProposedApi: true });
  }

  /** Feed raw PTY data into the virtual terminal. */
  write(data: string): void {
    if (this.baselineDeferred) {
      const buffer = this.terminal.buffer.active;
      this.turnBaselineY = buffer.baseY + buffer.cursorY;
      this.baselineDeferred = false;
    }
    this.terminal.write(data);
  }

  /** Mark the start of a new conversation turn. */
  markNewTurn(): void {
    this.lastHash = '';
    this.baselineDeferred = true;
  }

  /** Snapshot the current screen from baseline to end, with basic filtering. */
  snapshot(): { content: string; changed: boolean } {
    const content = this.baselineDeferred ? '' : this.extractContent(this.turnBaselineY);
    const hash = createHash('md5').update(content).digest('hex');
    const changed = hash !== this.lastHash;
    this.lastHash = hash;
    return { content, changed };
  }

  private extractContent(startY: number): string {
    const buffer = this.terminal.buffer.active;
    const readCols = Math.min(SNAPSHOT_COLS, this.terminal.cols);
    const endY = buffer.baseY + this.terminal.rows;

    const lines: string[] = [];
    for (let y = startY; y < endY; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const s = cleanBoxDrawing(line.translateToString(true, 0, readCols));
      if (BARE_PROMPT_RE.test(s) || INPUT_ECHO_RE.test(s)) continue;
      lines.push(s);
    }

    while (lines.length > 0 && BLANK_RE.test(lines[0])) lines.shift();
    while (lines.length > 0 && BLANK_RE.test(lines[lines.length - 1])) lines.pop();

    return lines.join('\n');
  }

  /**
   * Raw viewport snapshot — no filtering, no baseline gating.
   * Used by ScreenAnalyzer which needs the full screen including ❯ cursor lines.
   */
  rawSnapshot(): string {
    const buffer = this.terminal.buffer.active;
    const readCols = Math.min(SNAPSHOT_COLS, this.terminal.cols);
    const baseY = buffer.baseY;
    const endY = baseY + this.terminal.rows;

    const lines: string[] = [];
    for (let y = baseY; y < endY; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      lines.push(cleanBoxDrawing(line.translateToString(true, 0, readCols)));
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
