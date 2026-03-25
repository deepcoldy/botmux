/**
 * Headless terminal renderer: feeds PTY data into an xterm-headless instance
 * and periodically snapshots the rendered screen for Feishu card updates.
 *
 * Filters out TUI chrome and preamble (logo, version, prompt echo, system
 * instructions) so only the CLI's actual work output appears in the card.
 *
 * Supports two rendering styles:
 *   - CLI-style (Claude Code, Aiden): output appends to scrollback. Baseline
 *     tracking isolates current-turn content. Phase 1 (OUTPUT_MARKER_RE) gates
 *     content detection.
 *   - TUI-style (CoCo, Codex): cursor-positioned full-screen UI. Content can
 *     be overwritten when the TUI redraws (e.g. response → idle prompt).
 *     Viewport fallback + peak retention ensure response content is captured.
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

/** Bare prompt line: ❯ (Claude) or > (Aiden) with optional trailing whitespace */
const BARE_PROMPT_RE = /^[❯>]\s*$/;

/** Input echo: ❯ or > followed by user text */
const INPUT_ECHO_RE = /^[❯>]\s+\S/;

/** Status bar: Claude ("bypass permissions", "⏵⏵", "/model"), Aiden ("agent full mode"),
 *  CoCo ("accept all tools", "shell mode") */
const STATUS_BAR_RE = /bypass permissions|⏵⏵|shift\+tab|\/model|auto-update|agent full mode|IDE: \w+|accept all tools/;

/** CLI logo — block drawing characters used in ASCII art splash screens.
 *  Includes Claude Code (▐▛█▜▝▘) and CoCo (▄▀◆) character sets. */
const LOGO_RE = /[▐▛█▜▝▘▄▀◆]{2,}/;

/** CLI version / banner info lines */
const VERSION_RE = /Claude Code v\d|^\s*(Opus|Sonnet|Haiku)\s+\d|>_ Aiden \(v[\d.]+\)|Trae CLI \d|Formerly Coco/;

/** CoCo TUI chrome: input placeholder, mode/keyboard hints, welcome screen */
const COCO_CHROME_RE = /Ask anything|shell mode.*command mode|Ctrl\+J new line|Codebase Copilot|Did you know|Welcome back,|Use \/status|Announcements|code\.byted\.org/;

/** Empty or whitespace-only */
const BLANK_RE = /^\s*$/;

function shouldSkipLine(line: string): boolean {
  return (
    BARE_PROMPT_RE.test(line) ||
    INPUT_ECHO_RE.test(line) ||
    STATUS_BAR_RE.test(line) ||
    LOGO_RE.test(line) ||
    VERSION_RE.test(line) ||
    COCO_CHROME_RE.test(line)
  );
}

/** CLI output markers — lines starting with these indicate real work output.
 *  Includes CoCo spinner chars (❇❋✢) alongside Claude Code's markers. */
const OUTPUT_MARKER_RE = /^[●·⎿✓⚠★☐☑⏵✽✻❇❋✢]|^\s+⎿/;

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
  /** Best content seen this turn — prevents TUI redraws from wiping output. */
  private peakContent = '';

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
    const cursorAbsY = baseY + buffer.cursorY;

    // Find the last non-empty line in the current viewport
    let lastContentY = baseY;
    for (let y = rows - 1; y >= 0; y--) {
      const line = buffer.getLine(baseY + y);
      if (line && line.translateToString(true).trimEnd()) {
        lastContentY = baseY + y + 1;
        break;
      }
    }

    // Cap at cursor position — TUI renderers (Ink) place the status bar below
    // the cursor. Without this cap, the status bar inflates lastContentY past
    // the actual content boundary, causing Strategy 1 to start reading too late
    // and miss content that Ink renders above the cursor on the next turn.
    this.turnBaselineY = Math.min(lastContentY, cursorAbsY + 1);
    this.peakContent = '';
    this.lastHash = '';
  }

  /**
   * Snapshot the current screen content.
   *
   * Strategy:
   *   1. Try from turn baseline with Phase 1 marker gating (Claude Code style).
   *   2. If empty, fall back to full viewport without Phase 1 (CoCo/TUI style).
   *      TUI apps redraw the entire screen, so content may appear anywhere.
   *   3. Peak retention: save the best content seen this turn. When the TUI
   *      redraws to idle (empty screen), return the saved peak instead.
   */
  snapshot(): { content: string; changed: boolean } {
    const buffer = this.terminal.buffer.active;
    const baseY = buffer.baseY;

    // Strategy 1: baseline read with Phase 1 marker gating (CLI-style output)
    let content = this.extractContent(this.turnBaselineY, false);

    // Strategy 2: full viewport without Phase 1 (TUI-style — content anywhere on screen)
    if (!content) {
      content = this.extractContent(baseY, true);
    }

    // Peak retention — TUI redraws can wipe response from the terminal buffer.
    // Save non-empty content; return saved peak when current screen is empty.
    // Only update peak when new content is at least as long — prevents Strategy 1's
    // partial captures (starting from turnBaselineY) from overwriting a more complete
    // peak that Strategy 2 captured from the full viewport earlier in the turn.
    if (content) {
      if (content.length >= this.peakContent.length) {
        this.peakContent = content;
      } else {
        content = this.peakContent;
      }
    } else {
      content = this.peakContent;
    }

    // Hash-based change detection
    const hash = createHash('md5').update(content).digest('hex');
    const changed = hash !== this.lastHash;
    this.lastHash = hash;

    return { content, changed };
  }

  /**
   * Read and filter terminal content starting from `startY`.
   * @param skipPhase1 When true, include all non-chrome lines (no marker gating).
   *                   Used for TUI viewport fallback where output markers differ.
   */
  private extractContent(startY: number, skipPhase1: boolean): string {
    const buffer = this.terminal.buffer.active;
    const baseY = buffer.baseY;
    const rows = this.terminal.rows;
    const readCols = Math.min(SNAPSHOT_COLS, this.terminal.cols);
    const endY = baseY + rows;

    const rawLines: string[] = [];
    for (let y = startY; y < endY; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      rawLines.push(cleanBoxDrawing(line.translateToString(true, 0, readCols)));
    }

    let foundOutput = skipPhase1;
    const filtered: string[] = [];

    for (const line of rawLines) {
      if (!foundOutput) {
        // Phase 1: skip lines until we see an output marker
        if (OUTPUT_MARKER_RE.test(line)) {
          foundOutput = true;
          filtered.push(line);
        }
        continue;
      }

      // Phase 2: filter TUI chrome but keep content
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

    return filtered.join('\n');
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
