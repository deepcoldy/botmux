/**
 * Bounded, ANSI-stripped extraction of recent terminal scrollback for crash
 * diagnostics. Lives in its own leaf module (no worker.ts globals) so the
 * stripping/tailing logic — including the ReDoS regression guard — is unit
 * testable in isolation.
 */

/** Return at most the last `max` chars of `text`. */
export function tailChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

/**
 * Strip ANSI/VT control sequences for a plaintext crash log.
 *
 * The OSC branch deliberately (a) excludes ESC from the body class and (b)
 * makes the terminator optional. Without (a)/(b) — i.e. `\x1b\][^\x07]*(?:…)` —
 * a long run of `\x1b]` with no terminating BEL (a half-written OSC, or binary
 * garbage flushed to the TTY right before a crash) forces catastrophic
 * backtracking: O(n²) over the 200 KB tail, measured at ~18 s of synchronous
 * main-loop freeze inside the worker's exit handler. Excluding ESC bounds each
 * match to the next ESC and drops it to a few ms while still stripping real
 * OSC-8 hyperlinks (`ESC]8;;url BEL`) and OSC-0 titles (`ESC]0;title BEL`/`ST`).
 */
export function stripAnsiForLog(text: string): string {
  return text
    // OSC sequences (non-backtracking body + optional terminator).
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    // CSI/SGR and most cursor/control sequences.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // Remaining one-byte ESC commands.
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
