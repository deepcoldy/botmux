/**
 * Headless terminal renderer: feeds PTY data into an xterm-headless instance
 * and periodically snapshots the rendered screen for Feishu card updates.
 *
 * Filters out Claude Code TUI chrome and preamble (logo, version, prompt echo,
 * system instructions) so only Claude's actual work output appears in the card.
 *
 * Also strips box-drawing characters (─ ━ │ etc.) that leak from the TUI's
 * split-panel borders when the headless terminal captures overlapping layers.
 *
 * Timer overlay avoidance: The PTY is intentionally wider than normal so that
 * right-aligned TUI overlays (elapsed time, timeout counters) are rendered
 * far to the right. Snapshots only read the first `contentCols` columns,
 * cleanly excluding the overlay area — no fragile regex stripping needed.
 */
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
import { createHash } from 'node:crypto';

// ─── Box-Drawing Cleanup ─────────────────────────────────────────────────────
// Claude Code TUI renders panel borders with box-drawing characters.
// The headless terminal captures them overlapping with content text.

/** Strip box-drawing horizontal/vertical/corner characters, collapse spaces. */
function cleanBoxDrawing(line: string): string {
  return line
    .replace(/[─━│┌┐└┘├┤┬┴┼╭╮╯╰]/g, ' ')
    .replace(/  +/g, ' ')
    .trimEnd();
}

// ─── Line Filters ────────────────────────────────────────────────────────────

/** Bare prompt line: ❯ (with optional trailing whitespace, no content) */
const BARE_PROMPT_RE = /^❯\s*$/;

/** Input echo: ❯ followed by user text */
const INPUT_ECHO_RE = /^❯\s+\S/;

/** Status bar: "bypass permissions", "⏵⏵", "/model", "shift+tab" */
const STATUS_BAR_RE = /bypass permissions|⏵⏵|shift\+tab|\/model|auto-update/;

/** Claude Code logo — block drawing characters used in the ASCII art splash */
const LOGO_RE = /[▐▛█▜▝▘]{2,}/;

/** Claude Code version / model info lines */
const VERSION_RE = /Claude Code v\d|^\s*(Opus|Sonnet|Haiku)\s+\d/;

/** Empty or whitespace-only */
const BLANK_RE = /^\s*$/;

function shouldSkipLine(line: string): boolean {
  return (
    BARE_PROMPT_RE.test(line) ||
    INPUT_ECHO_RE.test(line) ||
    STATUS_BAR_RE.test(line) ||
    LOGO_RE.test(line) ||
    VERSION_RE.test(line)
  );
}

/** Claude output markers — lines starting with these indicate real work output */
const OUTPUT_MARKER_RE = /^[●·⎿✓⚠★☐☑⏵✽✻]|^\s+⎿/;

/**
 * How many columns to read from each line for the Feishu card snapshot.
 * Content beyond this is ignored — this is where TUI overlays (timer, timeout)
 * live when the PTY is wider than this value.
 */
const SNAPSHOT_COLS = 160;

export class TerminalRenderer {
  private terminal: InstanceType<typeof Terminal>;
  private lastHash = '';
  /** Absolute line index where the current turn starts. */
  private turnBaselineY = 0;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({ cols, rows, allowProposedApi: true });
  }

  /** Feed raw PTY data into the virtual terminal. */
  write(data: string): void {
    this.terminal.write(data);
  }

  /**
   * Mark the start of a new conversation turn.
   * Subsequent snapshots will only include content from after this point.
   */
  markNewTurn(): void {
    const buffer = this.terminal.buffer.active;
    const baseY = buffer.baseY;
    const rows = this.terminal.rows;

    // Find the last non-empty line in the current viewport
    let lastContentY = baseY;
    for (let y = rows - 1; y >= 0; y--) {
      const line = buffer.getLine(baseY + y);
      if (line && line.translateToString(true).trimEnd()) {
        lastContentY = baseY + y + 1;
        break;
      }
    }

    this.turnBaselineY = lastContentY;
    this.lastHash = '';
  }

  /**
   * Snapshot the current screen content (from the turn baseline onward).
   * Strips box-drawing characters, filters TUI chrome and preamble.
   * Only reads the first SNAPSHOT_COLS columns so right-aligned TUI overlays
   * (timer, timeout) that sit beyond that range are excluded.
   * Returns only Claude's actual work output.
   */
  snapshot(): { content: string; changed: boolean } {
    const buffer = this.terminal.buffer.active;
    const baseY = buffer.baseY;
    const rows = this.terminal.rows;
    const readCols = Math.min(SNAPSHOT_COLS, this.terminal.cols);

    // Start from the turn baseline (including scrollback) to capture all output
    const startY = this.turnBaselineY;
    const endY = baseY + rows;
    const rawLines: string[] = [];

    for (let y = startY; y < endY; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      // Read only the content columns — TUI overlays beyond readCols are excluded
      rawLines.push(cleanBoxDrawing(line.translateToString(true, 0, readCols)));
    }

    // Phase 1: Skip lines until we see actual Claude output
    let foundOutput = false;
    const filtered: string[] = [];

    for (const line of rawLines) {
      if (!foundOutput) {
        if (OUTPUT_MARKER_RE.test(line)) {
          foundOutput = true;
          filtered.push(line);
        }
        continue;
      }

      // Phase 2: After finding output, still filter TUI chrome but keep content
      if (shouldSkipLine(line)) continue;
      filtered.push(line);
    }

    // Trim leading and trailing empty lines
    while (filtered.length > 0 && BLANK_RE.test(filtered[0])) {
      filtered.shift();
    }
    while (filtered.length > 0 && BLANK_RE.test(filtered[filtered.length - 1])) {
      filtered.pop();
    }

    const content = filtered.join('\n');

    // Hash-based change detection
    const hash = createHash('md5').update(content).digest('hex');
    const changed = hash !== this.lastHash;
    this.lastHash = hash;

    return { content, changed };
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
