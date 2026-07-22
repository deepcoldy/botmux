/**
 * Lightweight, AI-free "stuck" detector — fires a callback when a written input
 * has not produced a completed turn within a timeout window.
 *
 * Why this exists: the AI-powered ScreenAnalyzer catches rendered TUI selectors
 * (option lists, confirm dialogs) but is opt-in and requires an LLM endpoint.
 * Some blocking states — Codex PreToolUse hook review, a bare `[Y/n]` prompt,
 * a "Press any key" pause — do not always render as a clean option list, or the
 * analyzer is simply not configured. Without a fallback, botmux silently waits
 * forever while the user assumes the message was never delivered.
 *
 * The detector does NOT itself decide the CLI is stuck. It only tracks elapsed
 * time since the last write and asks the owner (worker) to confirm via the
 * `isActuallyStuck` callback — the worker knows whether inflight inputs exist,
 * whether a TUI prompt card is already posted, and whether the CLI is at its
 * idle prompt. This avoids false positives from legitimately long turns.
 */

/** Patterns that strongly suggest the CLI is blocked on user input rather than
 *  genuinely working. Matched against a recent terminal snapshot (ANSI-stripped). */
const STUCK_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /hook needs review|needs review before it can run|PreToolUse hooks/i, label: 'hook review prompt' },
  { re: /Press .+ to/i, label: 'key-press prompt' },
  { re: /\[(Y|y)\/(N|n)\]|\[Y\/n\]|\[y\/N\]/, label: 'yes/no confirmation' },
  { re: /trust all|review hooks/i, label: 'trust/review prompt' },
  { re: /Do you want to|Would you like to|Proceed\?|Continue\?/i, label: 'confirmation question' },
  { re: /permission|allow|deny/i, label: 'permission prompt' },
];

export interface StuckDetectorCallbacks {
  /** Called when the timeout elapses. Return true to fire the warning; false
   *  to silently re-arm (e.g. the CLI just finished a long turn). */
  isActuallyStuck: () => boolean;
  /** Called once per armed window when isActuallyStuck returns true. */
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
    this.firedThisWindow = true;
    const elapsed = Date.now() - this.armedAt;
    const matched = this.matchSnapshot();
    this.callbacks.onStuck(elapsed, matched);
  }

  private matchSnapshot(): string | undefined {
    const snap = this.callbacks.getSnapshot?.();
    if (!snap) return undefined;
    for (const { re, label } of STUCK_PATTERNS) {
      if (re.test(snap)) return label;
    }
    return undefined;
  }
}
