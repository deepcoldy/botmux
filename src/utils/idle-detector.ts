import type { CliAdapter } from '../adapters/cli/types.js';

/** Spinner frames — animate while CLI is working.
 *  Includes Claude Code symbols, Ink dots braille chars (Gemini),
 *  and OpenCode progress bar chars (■⬝). */
const SPINNER_RE = /[·✢✳✶✻✽⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏■⬝]/;

/** Default quiescence timeout (ms) — idle if PTY silent + no recent spinner */
const QUIESCENCE_MS = 2_000;
/** Spinner guard — don't declare idle if spinner seen within this window */
const SPINNER_GUARD_MS = 3_000;

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
      .replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]|\x1b\[[\?]?[0-9;]*[hlmsuJ]/g, '');
  }
}
