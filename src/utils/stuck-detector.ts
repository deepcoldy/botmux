/**
 * Lightweight, AI-free "stuck" detector — fires a callback when a written input
 * has not produced a completed turn within a timeout window.
 *
 * Scope (intentionally narrow): this PR targets the specific Codex PreToolUse
 * hook-review blocking state, where the CLI renders a review screen and waits
 * for t/Enter/Esc (level 1) or t/Esc (level 2). Generic [Y/n]/permission/
 * Press-to-continue prompts are NOT handled here — they require semantic parsing
 * that cannot be safely inferred from a regex, and belong in a follow-up PR.
 *
 * The detector does NOT itself decide the CLI is stuck. It only tracks elapsed
 * time since the last write and asks the owner (worker) to confirm via the
 * `isActuallyStuck` callback — the worker knows whether inflight inputs exist,
 * whether a TUI prompt card is already posted, and whether the PTY has been
 * quiet. This avoids false positives from legitimately long turns.
 */

/**
 * Codex renders two distinct hook-review screens. We match each independently
 * because their titles and control hints differ, and the safe button set differs
 * (level 1 has Enter to drill in; level 2 has no Enter).
 *
 * Level 1 — hooks browser (the screen that actually blocks on startup):
 *   Title:  "Hooks"
 *   State:  "1 hook needs review before it can run."
 *   Table:  "Event  Installed  Active  Review  Description" header + a row
 *           whose Review column > 0 (e.g. "PreToolUse  1  0  1  ...")
 *   Footer: "Press t to trust all; enter to review hooks; esc to close"
 *
 * Level 2 — per-hook review (after pressing Enter on level 1):
 *   Title:  "PreToolUse hooks"
 *   State:  "1 hook needs review before it can run."
 *   Body:   "[!] Hook 1 · new" + "Trust  New hook - review required"
 *   Footer: "Press t to trust; esc to go back"
 *
 * Matching rules (addresses retained-history and pasted-text false positives):
 *  - Only inspect the bottom VIEWPORT_LINES of the snapshot — the TUI shows the
 *    active screen at the bottom; stale overview text scrolled off the top must
 *    not count.
 *  - The footer (control hint) MUST be present in the viewport and anchors the
 *    active region. We scan upward from the footer to find the nearest title.
 *  - Level 2 is checked first: if the nearest title above the footer is
 *    "PreToolUse hooks" AND the L2 body semantics are present, it is level 2
 *    even if a stale "Hooks" overview lingers further up.
 *  - Each level requires its semantic content rows, not just title + footer.
 */
const VIEWPORT_LINES = 40;

/** Strip ANSI escape sequences and carriage returns so a line's visible text
 *  can be matched against plain-text patterns. */
function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

export function matchHookReviewScreen(snapshot: string): 'hook review level 1' | 'hook review level 2' | undefined {
  if (!snapshot) return undefined;
  const rawLines = snapshot.split('\n');
  // Strip ANSI/CR from every line — the PTY carries color codes and the
  // renderer can emit \r\n; matching against raw bytes would miss the footer.
  const lines = rawLines.map(stripAnsi);
  // Only inspect the bottom of the screen — the active viewport. Stale overview
  // text that scrolled off the top must not trigger a match.
  const viewport = lines.slice(-VIEWPORT_LINES);
  // Trim trailing blank lines: the footer (control hint) must be the LAST
  // non-empty line of the viewport. If there is content below the footer,
  // the footer belongs to a scrolled-off screen, not the active one.
  let end = viewport.length;
  while (end > 0 && viewport[end - 1].trim() === '') end--;
  if (end === 0) return undefined;
  const trimmed = viewport.slice(0, end);

  // The footer MUST be the last non-empty line of the viewport, matched as a
  // whole line (^...$) — not a substring. A line like "The old footer said: ..."
  // must NOT match.
  const lastLine = trimmed[trimmed.length - 1].trim();
  let level: 1 | 2 | undefined;
  if (/^Press t to trust all; enter to review hooks; esc to close$/i.test(lastLine)) {
    level = 1;
  } else if (/^Press t to trust; esc to go back$/i.test(lastLine)) {
    level = 2;
  }
  if (!level) return undefined;
  const footerIdx = trimmed.length - 1;

  // Scan upward from the footer to find the nearest title line. The title must
  // be within the active region (not separated by too many blank lines / other
  // content), otherwise the footer may belong to a different screen.
  let titleIdx = -1;
  for (let i = footerIdx - 1; i >= 0 && footerIdx - i < 30; i--) {
    const line = trimmed[i].trim();
    if (line === 'Hooks' || /^PreToolUse hooks$/i.test(line)) {
      titleIdx = i;
      break;
    }
  }
  if (titleIdx < 0) return undefined;

  // Bind footer level to title: a level-1 footer (trust all / review / close)
  // can only belong to the "Hooks" overview; a level-2 footer (trust / back)
  // can only belong to the "PreToolUse hooks" detail. This prevents a stale
  // overview title above a detail footer (or vice versa) from misclassifying.
  const titleLine = trimmed[titleIdx].trim();
  if (level === 1 && titleLine !== 'Hooks') return undefined;
  if (level === 2 && !/^PreToolUse hooks$/i.test(titleLine)) return undefined;

  const region = trimmed.slice(titleIdx, footerIdx + 1).join('\n');

  // Require the pending-review state line in the active region.
  if (!/hook needs review|needs review before it can run/i.test(region)) return undefined;

  // Level 2 (detail): require the "Trust" action line in the region.
  if (level === 2) {
    if (/Trust\s+New hook/i.test(region)) return 'hook review level 2';
    return undefined;
  }

  // Level 1 (overview): require the table header + a row with Review > 0 to
  // confirm this is the active hooks browser, not a pasted snippet.
  const hasTableHeader = /Event\s+Installed\s+Active\s+Review/i.test(region);
  const hasReviewRow = /PreToolUse\s+\d+\s+\d+\s+[1-9]/i.test(region);
  if (hasTableHeader && hasReviewRow) return 'hook review level 1';
  return undefined;
}

/** Codex startup review is a separate three-choice screen from the detailed
 * Hooks browser. It owns Enter/arrow keys, so normal BotMux input must not be
 * pasted into it. Keep its signature strict and footer-anchored to avoid
 * treating quoted discussion text as an active menu. */
function isStartupHookReviewScreen(snapshot: string): boolean {
  if (!snapshot) return false;
  const viewport = snapshot
    .split('\n')
    .map(stripAnsi)
    .slice(-VIEWPORT_LINES);
  let end = viewport.length;
  while (end > 0 && viewport[end - 1].trim() === '') end--;
  if (end === 0) return false;
  const trimmed = viewport.slice(0, end);
  const lastLine = trimmed[trimmed.length - 1].trim();
  if (!/^Press enter to confirm or esc to go back$/i.test(lastLine)) return false;
  const region = trimmed.slice(Math.max(0, trimmed.length - 18)).join('\n');
  return /^Hooks need review$/im.test(region)
    && /^\d+\s+hooks?\s+are new or changed\.$/im.test(region)
    && /^\s*1\.\s+Review hooks$/im.test(region)
    && /^\s*>?\s*2\.\s+Trust all and continue$/im.test(region)
    && /^\s*3\.\s+Continue without trusting \(hooks won't run\)$/im.test(region);
}

/** A Hook-review menu owns Enter/arrow keys instead of the normal Codex
 * composer. Queue BotMux-originated input until the operator resolves it:
 * otherwise a message submit can accidentally select "Trust all" or be lost
 * before it reaches the model. Kept pure so the worker wiring is testable. */
export function shouldHoldInputForHookReview(snapshot: string): boolean {
  return matchHookReviewScreen(snapshot) !== undefined
    || isStartupHookReviewScreen(snapshot);
}

export interface StuckDetectorCallbacks {
  /** Called when the timeout elapses. Return true to fire the warning; false
   *  to silently re-arm (e.g. the CLI just finished a long turn). */
  isActuallyStuck: () => boolean;
  /** Called once per armed window when isActuallyStuck returns true.
   *  `matchedLabel` is set when the snapshot matches a known hook-review
   *  pattern; undefined means the turn is stalled but the cause is unknown. */
  onStuck: (elapsedMs: number, matchedLabel?: string) => void;
  /** Optional: return the current terminal snapshot for pattern matching. */
  getSnapshot?: () => string;
}

export class StuckDetector {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private armedAt = 0;
  private firedThisWindow = false;
  private disposed = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly callbacks: StuckDetectorCallbacks,
  ) {}

  /** Arm the detector — call right after writing input to the PTY. */
  arm(): void {
    if (this.disposed) return;
    this.disarm();
    this.armedAt = Date.now();
    this.firedThisWindow = false;
    this.timer = setTimeout(() => this.tick(), this.timeoutMs);
  }

  /** Disarm — call when the turn completes (prompt ready) or the CLI exits. */
  disarm(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.armedAt = 0;
    this.firedThisWindow = false;
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
  }

  private tick(): void {
    this.timer = null;
    if (this.disposed) return;
    if (this.firedThisWindow) return;
    if (!this.callbacks.isActuallyStuck()) {
      // CLI may have just finished — re-arm for the next window in case it
      // immediately blocks again on a follow-up prompt.
      this.arm();
      return;
    }
    // Only fire when the snapshot matches a known hook-review pattern.
    // A 15s PTY silence alone does NOT prove the turn is stuck — long model
    // thinking or tool calls can be quiet. Without a pattern match we silently
    // re-arm and keep waiting, never posting a false "CLI stuck" warning.
    const matched = this.matchSnapshot();
    if (!matched) {
      this.arm();
      return;
    }
    this.firedThisWindow = true;
    const elapsed = Date.now() - this.armedAt;
    this.callbacks.onStuck(elapsed, matched);
  }

  private matchSnapshot(): string | undefined {
    const snap = this.callbacks.getSnapshot?.();
    return snap ? matchHookReviewScreen(snap) : undefined;
  }
}
