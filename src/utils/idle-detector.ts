import type { CliAdapter } from '../adapters/cli/types.js';

/** Spinner frames — animate while CLI is working.
 *  Includes Claude Code symbols, Ink dots braille chars (Gemini),
 *  and OpenCode progress bar chars (■⬝). */
const SPINNER_RE = /[·✢✳✶✻✽⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏■⬝]/;

/** Default quiescence timeout (ms) — idle if PTY silent + no recent spinner */
const QUIESCENCE_MS = 2_000;
/** Spinner guard — don't declare idle if spinner seen within this window */
const SPINNER_GUARD_MS = 3_000;
/** Short grace window after readyPattern fires (ms) — covers a transient
 *  redraw of the input box, but is NOT reset by arbitrary TUI status-bar
 *  churn the way QUIESCENCE_MS is. Matches completionPattern's 500ms. */
const READY_GRACE_MS = 500;

export class IdleDetector {
  private outputTail = '';
  private lastSpinnerAt = 0;
  private quiescenceTimer: ReturnType<typeof setTimeout> | null = null;
  private isIdle = false;
  private idleCallback: (() => void) | null = null;
  private completionPattern: RegExp | undefined;
  private readyPattern: RegExp | undefined;
  private readySeen = false;

  constructor(cli: CliAdapter) {
    this.completionPattern = cli.completionPattern;
    this.readyPattern = cli.readyPattern;
  }

  onIdle(cb: () => void): void {
    this.idleCallback = cb;
  }

  feed(data: string): void {
    // A botmux-owned submit calls reset() before writing input, but adopted
    // panes can also receive local terminal input while we are already idle.
    // Treat any later PTY data as a fresh cycle so that local work can become
    // idle and flush transcript-driven fallback output.
    if (this.isIdle) {
      this.isIdle = false;
      this.outputTail = '';
      this.readySeen = false;
      this.lastSpinnerAt = Date.now();
    }

    const stripped = this.stripAnsi(data);
    this.outputTail = (this.outputTail + stripped).slice(-500);

    // Track when the CLI's input prompt appears.
    // Check the current chunk too — a single chunk can contain the prompt
    // AND a full status-bar redraw (hundreds of chars), pushing the prompt
    // out of the 500-char outputTail before the check runs.
    if (this.readyPattern && !this.readySeen) {
      if (this.readyPattern.test(stripped) || this.readyPattern.test(this.outputTail)) {
        this.readySeen = true;
      }
    }

    // Track spinner — but not if it's part of completion marker,
    // and not after ready pattern is seen (status bar chars like · are not real spinners)
    if (SPINNER_RE.test(stripped) && !(this.completionPattern?.test(stripped) || this.completionPattern?.test(this.outputTail)) && !this.readySeen) {
      this.lastSpinnerAt = Date.now();
    }

    // Strategy 1: CLI-specific completion marker
    // Check the current chunk too: a single full-screen redraw can contain
    // the completion line and enough trailing status text to push it out of
    // the 500-char tail before this check runs.
    if (this.completionPattern?.test(stripped) || this.completionPattern?.test(this.outputTail)) {
      this.clearTimer();
      this.quiescenceTimer = setTimeout(() => {
        this.quiescenceTimer = null;
        if (!this.isIdle) this.markIdle();
      }, 500);
      return;
    }

    // Strategy 2: quiescence (PTY silence + no recent spinner)
    // When readyPattern is set, suppress quiescence until the input prompt appears.
    if (this.readyPattern && !this.readySeen) return;

    // Once the input prompt is visible, the CLI is visually "ready" — don't
    // make the user wait QUIESCENCE_MS (2s) on top of the spawn time. A short
    // grace window (READY_GRACE_MS, 500ms) covers a transient redraw of the
    // input box. The grace timer is NOT reset by arbitrary TUI status-bar
    // churn (every ~1ms in Hermes/Codex TUIs): once the prompt is up, idle
    // is the only sensible state from a user-input perspective. Spinner chars
    // in the post-ready output are already excluded by the `!readySeen` guard
    // at the top of feed() (status-bar ·· is not a real spinner) — we do not
    // re-check them here.
    if (this.readyPattern && this.readySeen && !this.completionPattern) {
      // Only arm the grace timer once. If it's already armed, leave it
      // running — TUI status-bar redraws every ~1ms in Hermes/Codex would
      // otherwise clear+reset the timer indefinitely, recreating the
      // original 13s detection delay.
      if (this.quiescenceTimer) return;
      this.quiescenceTimer = setTimeout(() => {
        this.quiescenceTimer = null;
        if (!this.isIdle) this.markIdle();
      }, READY_GRACE_MS);
      return;
    }

    this.clearTimer();
    this.quiescenceTimer = setTimeout(() => this.quiescenceCheck(), QUIESCENCE_MS);
  }

  reset(): void {
    this.isIdle = false;
    this.outputTail = '';
    this.readySeen = false;
    this.lastSpinnerAt = Date.now();
    this.clearTimer();
  }

  /** External idle source — lets transcript-driven detectors (Claude jsonl
   *  Stop, Codex rollout assistant_final, CoCo events.jsonl finish_reason
   *  stop) push idle without waiting for screen-pattern + quiescence to
   *  agree. Idempotent within a turn (gated by isIdle); reset() re-arms it
   *  for the next turn — same lifecycle as the internal markIdle path. */
  fireIdle(): void {
    if (this.isIdle) return;
    this.markIdle();
  }

  dispose(): void {
    this.clearTimer();
    this.idleCallback = null;
  }

  private quiescenceCheck(): void {
    this.quiescenceTimer = null;
    if (this.isIdle) return;
    const sinceSpinner = Date.now() - this.lastSpinnerAt;
    if (sinceSpinner < SPINNER_GUARD_MS) {
      this.quiescenceTimer = setTimeout(
        () => this.quiescenceCheck(),
        SPINNER_GUARD_MS - sinceSpinner + 200,
      );
      return;
    }
    this.markIdle();
  }

  private markIdle(): void {
    this.isIdle = true;
    this.outputTail = '';
    this.clearTimer();
    this.idleCallback?.();
  }

  private clearTimer(): void {
    if (this.quiescenceTimer) {
      clearTimeout(this.quiescenceTimer);
      this.quiescenceTimer = null;
    }
  }

  private stripAnsi(str: string): string {
    return str
      .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Number(n) || 1))
      .replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b\[\??[0-9;]*[hlmsuJ]/g, '');
  }
}
