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
const OUTPUT_MARKER_RE = /^\s*[●·⎿✓⚠★☐☑⏵✽✻❇❋✢]/;

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
  /** Whether peakContent was set from Strategy 2 (viewport fallback) rather than
   *  Strategy 1 (baseline).  When Strategy 1 first returns content, it unconditionally
   *  replaces a fallback peak — even if shorter — because the fallback may include
   *  stale content from the previous turn's viewport. */
  private peakFromFallback = false;
  /**
   * When true, the baseline has not yet been established for this turn.
   * Snapshots return empty until the first write() arrives after markNewTurn(),
   * which sets the baseline at the exact cursor position before new data flows in.
   * This prevents old terminal content from leaking into the new turn's card —
   * regardless of whether the terminal buffer state is accurate (e.g. after
   * tmux re-attach where the buffer may not match expectations).
   */
  private baselineDeferred = true;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({ cols, rows, allowProposedApi: true });
  }

  /** Feed raw PTY data into the virtual terminal. */
  write(data: string): void {
    if (this.baselineDeferred) {
      // Set baseline at the cursor position RIGHT BEFORE new data arrives.
      // This is the exact boundary between old content and new-turn content.
      const buffer = this.terminal.buffer.active;
      this.turnBaselineY = buffer.baseY + buffer.cursorY;
      this.baselineDeferred = false;
    }
    this.terminal.write(data);
  }

  /**
   * Mark the start of a new conversation turn.
   * Subsequent snapshots will return empty until new PTY data arrives,
   * at which point the baseline is set at the cursor position.
   */
  markNewTurn(): void {
    this.peakContent = '';
    this.peakFromFallback = false;
    this.lastHash = '';
    this.baselineDeferred = true;
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
    // Baseline not yet established — no new data since markNewTurn().
    // Return empty to avoid capturing old content.
    if (this.baselineDeferred) {
      const hash = createHash('md5').update('').digest('hex');
      const changed = hash !== this.lastHash;
      this.lastHash = hash;
      return { content: '', changed };
    }

    const buffer = this.terminal.buffer.active;
    const baseY = buffer.baseY;

    // Strategy 1: baseline read with Phase 1 marker gating (CLI-style output)
    let content = this.extractContent(this.turnBaselineY, false);
    const fromBaseline = !!content;

    // Strategy 2: full viewport without Phase 1 (TUI-style — content anywhere on screen)
    if (!content) {
      content = this.extractContent(baseY, true);
    }

    // Peak retention — TUI redraws can wipe response from the terminal buffer.
    // Save non-empty content; return saved peak when current screen is empty.
    //
    // Strategy-aware: Strategy 2 can read the full viewport which may include
    // content from the previous turn (before turnBaselineY).  If Strategy 1 later
    // returns shorter but *correct* content, it must replace the contaminated peak.
    if (content) {
      if (fromBaseline) {
        // Strategy 1 (authoritative): always use the latest snapshot.
        // CLI output uses cursor repositioning for temporary content (thinking
        // animations, spinners) that gets overwritten by shorter final output.
        // Length-based retention would preserve stale temporary content.
        this.peakContent = content;
        this.peakFromFallback = false;
      } else {
        // Strategy 2 (fallback): only grow peak if no baseline peak exists yet.
        if (!this.peakFromFallback && this.peakContent) {
          // Baseline peak already set — don't let fallback override it.
          content = this.peakContent;
        } else if (content.length >= this.peakContent.length) {
          this.peakContent = content;
          this.peakFromFallback = true;
        } else {
          content = this.peakContent;
        }
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

  /**
   * Raw viewport snapshot — no filtering, no phase gating, no chrome removal.
   * Used by ScreenAnalyzer which needs the full screen including ❯ cursor lines.
   */
  rawSnapshot(): string {
    const buffer = this.terminal.buffer.active;
    const baseY = buffer.baseY;
    const rows = this.terminal.rows;
    const readCols = Math.min(SNAPSHOT_COLS, this.terminal.cols);
    const endY = baseY + rows;

    const lines: string[] = [];
    for (let y = baseY; y < endY; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      lines.push(cleanBoxDrawing(line.translateToString(true, 0, readCols)));
    }

    // Trim trailing blank lines only
    while (lines.length > 0 && BLANK_RE.test(lines[lines.length - 1])) {
      lines.pop();
    }

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
