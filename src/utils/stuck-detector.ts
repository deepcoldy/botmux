/**
 * Lightweight, AI-free "stuck" detector — fires a callback when a written input
 * has not produced a completed turn within a timeout window.
 *
 * Scope (intentionally narrow): only the blocking pages listed in
 * classifyStuckPage — the Codex-family hook-review flow (startup menu, hooks
 * browser, per-event detail, for any hook event) and the TRAE CLI legacy-data
 * migration picker — each matched against text captured from a real build.
 * Generic [Y/n]/permission/Press-to-continue prompts are NOT handled here —
 * they require semantic parsing that cannot be safely inferred from a regex.
 * Which keys a card may send for each page lives in core/stuck-page-catalog.ts.
 *
 * The detector does NOT itself decide the CLI is stuck. It only tracks elapsed
 * time since the last write and asks the owner (worker) to confirm via the
 * `isActuallyStuck` callback — the worker knows whether inflight inputs exist,
 * whether a TUI prompt card is already posted, and whether the PTY has been
 * quiet. This avoids false positives from legitimately long turns.
 */

/**
 * Codex-family CLIs (Codex, and TRAE CLI / CoCo which share codex_core's TUI)
 * render the same hook-review flow. Captured on real builds — Codex 0.147
 * (official rust-v0.147.0 snapshots in test/fixtures), Codex 0.162.0 / 0.164.0
 * and traecli 0.213.1 (test/fixtures/stuck-pages/):
 *
 * Startup menu (shown before the composer when any hook is new or changed):
 *   "Hooks need review" / "N hook(s) is/are new or changed." /
 *   "1. Review hooks" "2. Trust all and continue"
 *   "3. Continue without trusting (hooks won't run)"
 *   footer 0.147: "Press enter to confirm or esc to go back"
 *          0.162+: "enter confirm · esc skip"   traex: "enter confirm  |  esc go back"
 *
 * Level 1 — hooks browser:
 *   Title "Hooks", state "N hook(s) need(s) review before it/they can run.",
 *   table header "Event  Installed  Active  Review  Description".
 *   footer 0.147: "Press t to trust all; enter to review hooks; esc to close"
 *          0.162+: "t trust all · enter review · esc close"
 *          traex:  "t trust all  |  enter review hooks  |  esc close"
 *
 * Level 2 — per-event detail. Title is "<Event> hooks" for ANY event
 *   (PreToolUse, SessionStart, ...), state line as above, and a
 *   "Trust  New hook - review required" row.
 *   footer 0.147: "Press t to trust; esc to go back"
 *          0.162+: "t trust · esc back"   traex: "t trust  |  esc go back"
 *   (After pressing t the footer becomes "space/enter toggle · esc back" —
 *   deliberately NOT matched: Enter there disables the hook.)
 *
 * Matching rules (retained history / pasted text must not count):
 *  - Only the bottom VIEWPORT_LINES are inspected.
 *  - The footer MUST be the last non-empty line, and must consist of exactly
 *    the expected control hints (order-insensitive, any of the observed
 *    separators). A sentence that merely quotes a footer does not match.
 *  - The nearest title above the footer binds the level; the region between
 *    them must carry that level's semantic rows.
 */
const VIEWPORT_LINES = 40;

/** Strip ANSI escape sequences and carriage returns so a line's visible text
 *  can be matched against plain-text patterns. */
/** Escape sequences that never put text on screen. A raw PTY chunk can carry
 *  any of them (OSC window title `ESC ] 0;codex BEL` / `… ESC \`, CSI with
 *  intermediate bytes such as the cursor-shape `ESC [ 2 SP q`, charset
 *  designators, keypad modes); left in, their parameters read as a visible
 *  "last line" and hide the page above. */
const NON_PRINTING_ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b\[[0-?]*[ -\/]*[@-~]|\x1b[()*+][0-9A-Za-z]|\x1b[78=>]/g;

function stripAnsi(line: string): string {
  return line.replace(NON_PRINTING_ESCAPES, '').replace(/\r/g, '');
}

/** Bottom of the screen with trailing blank lines removed; the last element is
 *  the last visible (non-empty) line. Empty when the screen is blank.
 *  Blank rows are trimmed BEFORE taking the bottom VIEWPORT_LINES: a TUI that
 *  draws its menu at the top of a tall pane (Codex --no-alt-screen on a
 *  50-row pane puts the startup menu on rows 1-11) leaves dozens of empty rows
 *  below it, and slicing first would cut the menu off. */
function activeViewport(snapshot: string): string[] {
  const lines = snapshot.split('\n').map(stripAnsi);
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(Math.max(0, end - VIEWPORT_LINES), end);
}

/** A footer line as a normalised set of control hints, e.g.
 *  "Press t to trust all; enter to review hooks; esc to close",
 *  "t trust all · enter review · esc close" and
 *  "t trust all  |  enter review hooks  |  esc close" all become
 *  ["esc close", "enter review hooks"|"enter review", "t trust all"]. */
function footerHints(line: string): string[] {
  return line
    .trim()
    .replace(/^press\s+/i, '')
    .split(/\s*(?:·|\||;|\bor\b)\s*/i)
    .map(hint => hint.trim().toLowerCase().replace(/\s+to\s+/g, ' ').replace(/\s+/g, ' '))
    .filter(Boolean)
    .sort();
}

function footerIs(line: string, accepted: ReadonlyArray<ReadonlyArray<string>>): boolean {
  const hints = footerHints(line).join('\n');
  return accepted.some(set => [...set].sort().join('\n') === hints);
}

const L1_FOOTERS = [
  ['t trust all', 'enter review hooks', 'esc close'], // 0.147, traex 0.213
  ['t trust all', 'enter review', 'esc close'],       // codex 0.162+
] as const;
const L2_FOOTERS = [
  ['t trust', 'esc go back'], // 0.147, traex 0.213
  ['t trust', 'esc back'],    // codex 0.162+
] as const;
const STARTUP_FOOTERS = [
  ['enter confirm', 'esc go back'], // 0.147, traex 0.213
  ['enter confirm', 'esc skip'],    // codex 0.162+
] as const;

/** "1 hook needs review before it can run." / "2 hooks need review before they can run." */
const PENDING_REVIEW_STATE = /\b\d+\s+hooks?\s+needs?\s+review before (?:it|they) can run\b/i;
const L2_TITLE = /^[A-Z][A-Za-z]*\s+hooks$/;

export type HookReviewPageType = 'hook review startup' | 'hook review level 1' | 'hook review level 2';
export type StuckPageType = HookReviewPageType | 'cli migration menu';

/** Hooks browser (level 1) or per-event detail (level 2). The startup menu is
 *  recognised separately — see classifyStuckPage. */
export function matchHookReviewScreen(snapshot: string): 'hook review level 1' | 'hook review level 2' | undefined {
  if (!snapshot) return undefined;
  const trimmed = activeViewport(snapshot);
  if (trimmed.length === 0) return undefined;
  const footerIdx = trimmed.length - 1;
  const lastLine = trimmed[footerIdx];
  let level: 1 | 2 | undefined;
  if (footerIs(lastLine, L1_FOOTERS)) level = 1;
  else if (footerIs(lastLine, L2_FOOTERS)) level = 2;
  if (!level) return undefined;

  // Nearest title above the footer, within the active region.
  let titleIdx = -1;
  for (let i = footerIdx - 1; i >= 0 && footerIdx - i < 30; i--) {
    const line = trimmed[i].trim();
    if (line === 'Hooks' || L2_TITLE.test(line)) {
      titleIdx = i;
      break;
    }
  }
  if (titleIdx < 0) return undefined;

  // Bind footer level to title: the overview footer only belongs to "Hooks",
  // the detail footer only to "<Event> hooks".
  const titleLine = trimmed[titleIdx].trim();
  if (level === 1 && titleLine !== 'Hooks') return undefined;
  if (level === 2 && !L2_TITLE.test(titleLine)) return undefined;

  const region = trimmed.slice(titleIdx, footerIdx + 1).join('\n');
  if (!PENDING_REVIEW_STATE.test(region)) return undefined;

  if (level === 2) {
    return /^\s*Trust\s+\w+ hook - review required\s*$/im.test(region) ? 'hook review level 2' : undefined;
  }
  // The pending row itself can be scrolled out of the table (traex lists 8+
  // events), so the state line + table header carry level 1.
  return /^\s*[›>»❯]?\s*Event\s+Installed\s+Active\s+Review\b/im.test(region) ? 'hook review level 1' : undefined;
}

/** Startup three-choice menu. It owns Enter/arrow keys, so normal BotMux input
 *  must not be pasted into it. Keep the signature strict and footer-anchored to
 *  avoid treating quoted discussion text as an active menu. A custom keymap
 *  that changes the hint fails open rather than guessing. */
function isStartupHookReviewScreen(snapshot: string): boolean {
  if (!snapshot) return false;
  const trimmed = activeViewport(snapshot);
  if (trimmed.length === 0) return false;
  if (!footerIs(trimmed[trimmed.length - 1], STARTUP_FOOTERS)) return false;
  const region = trimmed.slice(Math.max(0, trimmed.length - 18)).join('\n');
  // Selection cursor: › (0.147), » (codex ≥0.154), ❯ (traex), >.
  return /^\s*Hooks need review$/im.test(region)
    && /^\s*\d+\s+hooks?\s+(?:is|are) new or changed\.$/im.test(region)
    && /^\s*[›>»❯]?\s*1\.\s+Review hooks$/im.test(region)
    && /^\s*[›>»❯]?\s*2\.\s+Trust all and continue$/im.test(region)
    && /^\s*[›>»❯]?\s*3\.\s+Continue without trusting \(hooks won't run\)$/im.test(region);
}

/** TRAE CLI 0.213 legacy-data migration picker (TRAE_HOME holds a legacy
 *  traecli.yaml and no .coco-migrated marker). Pasted text is consumed as
 *  keystrokes: `n` clears the selection, `4` persists "don't ask again", and
 *  Enter runs the migration. Esc = "Skip for now". */
function isCliMigrationMenu(snapshot: string): boolean {
  if (!snapshot) return false;
  const trimmed = activeViewport(snapshot);
  if (trimmed.length === 0) return false;
  const footer = trimmed[trimmed.length - 1].trim();
  if (!/^Use ↑\/↓ to move, space to toggle, 1\/2\/3\/4 to choose, a\/n for all\/none$/.test(footer)) return false;
  const region = trimmed.slice(Math.max(0, trimmed.length - 30)).join('\n');
  return /^\s*[>›❯]?\s*Legacy TRAE CLI data detected$/m.test(region)
    && /^\s*[›>»❯]?\s*1\.\s+Proceed with selected$/m.test(region)
    && /^\s*[›>»❯]?\s*2\.\s+Skip for now$/m.test(region);
}

/** Which known blocking page (if any) the active screen shows. Pure; the
 *  worker uses it to hold queued input, to raise the stuck card, and to
 *  re-verify the page right before a card click writes a key. */
export function classifyStuckPage(snapshot: string): StuckPageType | undefined {
  if (!snapshot) return undefined;
  const hookPage = matchHookReviewScreen(snapshot);
  if (hookPage) return hookPage;
  if (isStartupHookReviewScreen(snapshot)) return 'hook review startup';
  if (isCliMigrationMenu(snapshot)) return 'cli migration menu';
  return undefined;
}

/** A Hook-review menu owns Enter/arrow keys instead of the normal Codex
 * composer. Queue BotMux-originated input until the operator resolves it:
 * otherwise a message submit can accidentally select "Trust all" or be lost
 * before it reaches the model. Kept pure so the worker wiring is testable. */
export function shouldHoldInputForHookReview(snapshot: string): boolean {
  return matchHookReviewScreen(snapshot) !== undefined
    || isStartupHookReviewScreen(snapshot);
}

/** Any known blocking page (hook review or migration picker) — queued input
 *  must not be typed into it. */
export function shouldHoldInputForStuckPage(snapshot: string): boolean {
  return classifyStuckPage(snapshot) !== undefined;
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
    return snap ? classifyStuckPage(snap) : undefined;
  }
}
