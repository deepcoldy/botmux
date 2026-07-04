/**
 * Pick the history seed sent to a newly-connected web-terminal client.
 *
 * Background: a fresh web client needs the prior screen state replayed so it
 * doesn't start blank. There are two possible sources:
 *
 *   1. The raw cumulative PTY byte stream (`scrollback`) — every byte the CLI
 *      ever emitted, concatenated. For a TUI like Claude Code (Ink), that
 *      stream is dominated by *height-relative* redraw sequences: the spinner
 *      and bottom input box are repainted with `\x1b[<n>A` (cursor up) followed
 *      by `\r\n` to walk back down to the bottom — no absolute positioning, no
 *      scroll region. Those relative moves are only correct at the exact
 *      terminal size the bytes were authored for. Replayed into a fresh xterm
 *      of a different size (and the pane is resized by viewers mid-session),
 *      the cursor math drifts and every redraw tick scrolls a stale
 *      spinner/footer/input-box frame into scrollback — so scrolling up shows
 *      dozens of stacked footers and fragmented lines.
 *
 *   2. tmux `capture-pane` (`captureCurrentScreen`) — tmux already interpreted
 *      all those sequences against the real pane and holds a clean grid plus
 *      its own history-limit scrollback. Capturing it yields faithful history
 *      regardless of how the redraws were encoded. This is the same source the
 *      streaming-card screenshots use, which is why screenshots never garbled.
 *
 * So whenever a tmux capture is available (pipe mode) we prefer it. A
 * non-tmux PtyBackend has no pane to capture, so it falls back to the raw
 * scrollback replay (its CLIs are generally not redraw-heavy TUIs, and there
 * is no better source).
 */
export function chooseWebTerminalSeed(opts: {
  /** True when an authoritative tmux capture is available (pipe mode). */
  canCapture: boolean;
  /** Returns the tmux capture-pane snapshot (ANSI, \r\n-normalised). */
  capture: () => string;
  /** Raw cumulative byte-stream fallback. */
  scrollback: string;
  /** Optional log sink for capture failures. */
  onError?: (msg: string) => void;
}): string {
  if (opts.canCapture) {
    try {
      const cap = opts.capture();
      // An empty capture (pane briefly gone / tmux hiccup) is not useful as a
      // seed — fall back to whatever raw scrollback we have rather than send
      // a blank screen.
      if (cap.length > 0) return cap;
    } catch (err: any) {
      opts.onError?.(`web seed capture failed, falling back to scrollback: ${err?.message ?? err}`);
    }
  }
  return opts.scrollback;
}
