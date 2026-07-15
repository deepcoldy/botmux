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

/** Hard upper bound — protects snapshot/PNG memory if a pane is reported as
 *  unreasonably wide. Below this, the actual read width is the xterm's real
 *  cols (PTY_COLS=160 for spawned sessions, source pane width for adopt
 *  mode 200-270). Bumping past 320 risks a >5MB canvas per screenshot. */
const SNAPSHOT_COLS = 320;

/**
 * Read the current viewport of an xterm-headless Terminal as plain text.
 *
 * Extracted as a free function so transient renderers (capture-pane seeded)
 * can reuse the same line-filtering + trimming logic without instantiating
 * a full TerminalRenderer (which is built for long-lived buffer accumulation).
 *
 * `filter=true` drops the bare-prompt line and the input-echo line — the
 * card text should show CLI output, not the live cursor reflection.
 */
export function readViewportText(
  terminal: InstanceType<typeof Terminal>,
  opts: { filter: boolean; readCols?: number; startY?: number; rows?: number },
): string {
  const buffer = terminal.buffer.active;
  const readCols = Math.min(opts.readCols ?? SNAPSHOT_COLS, terminal.cols);
  const baseY = opts.startY ?? buffer.baseY;
  const rows = opts.rows ?? terminal.rows;
  const endY = baseY + rows;

  const lines: string[] = [];
  for (let y = baseY; y < endY; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const s = cleanBoxDrawing(line.translateToString(true, 0, readCols));
    if (opts.filter && (BARE_PROMPT_RE.test(s) || INPUT_ECHO_RE.test(s))) continue;
    lines.push(s);
  }

  if (opts.filter) {
    while (lines.length > 0 && BLANK_RE.test(lines[0])) lines.shift();
  }
  while (lines.length > 0 && BLANK_RE.test(lines[lines.length - 1])) lines.pop();

  return lines.join('\n');
}

export class TerminalRenderer {
  private terminal: InstanceType<typeof Terminal>;
  private lastHash = '';
  private pendingWrites = 0;
  private writeDrainWaiters: Array<() => void> = [];
  private disposed = false;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({ cols, rows, allowProposedApi: true });
  }

  /** Feed raw PTY data into the virtual terminal. */
  write(data: string): void {
    if (this.disposed) return;
    this.pendingWrites += 1;
    this.terminal.write(data, () => {
      if (this.disposed) return;
      this.pendingWrites = Math.max(0, this.pendingWrites - 1);
      if (this.pendingWrites !== 0) return;
      const waiters = this.writeDrainWaiters.splice(0);
      for (const resolve of waiters) resolve();
    });
  }

  /** xterm parses write() asynchronously. Safety-sensitive callers must not
   * inspect the current cells until this is false. */
  get hasPendingWrites(): boolean { return this.pendingWrites > 0; }

  /** Resolve after every write currently queued in xterm has updated the
   * buffer. Writes that arrive concurrently keep the drain closed until the
   * queue is empty, so a caller never observes a half-parsed redraw. */
  whenWritesParsed(): Promise<void> {
    if (this.pendingWrites === 0 || this.disposed) return Promise.resolve();
    return new Promise(resolve => { this.writeDrainWaiters.push(resolve); });
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

  /** Current viewport with the one SGR attribute needed by native-composer
   * proof preserved. Plain snapshots deliberately discard styling, but Codex
   * distinguishes its empty randomized placeholder from user-entered draft
   * text by rendering only the former dim. Reconstruct dim runs from xterm's
   * authoritative current cells so pty-under-{tmux,zellij} and the direct PTY
   * backend can recover safely after a partial raw-command write. */
  promptProofSnapshot(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    const startY = buffer.baseY;
    const endY = startY + this.terminal.rows;

    for (let y = startY; y < endY; y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;
      let output = '';
      let dim = false;
      for (let x = 0; x < Math.min(line.length, this.terminal.cols); x += 1) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const cellDim = cell.isDim() !== 0;
        if (cellDim !== dim) {
          output += cellDim ? '\x1b[2m' : '\x1b[22m';
          dim = cellDim;
        }
        output += cell.getChars() || ' ';
      }
      if (dim) output += '\x1b[22m';
      lines.push(output);
    }

    return lines.join('\n');
  }

  private readViewport(filter: boolean): string {
    return readViewportText(this.terminal, { filter });
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  /** Expose the underlying xterm-headless instance for screenshot rendering. */
  get xterm(): InstanceType<typeof Terminal> { return this.terminal; }

  dispose(): void {
    this.disposed = true;
    this.pendingWrites = 0;
    const waiters = this.writeDrainWaiters.splice(0);
    for (const resolve of waiters) resolve();
    this.terminal.dispose();
  }
}
