import type { PtyHandle, RunnerSubmissionDisposition } from './types.js';
import type { CodexAppTurnInput } from '../../types.js';
import { delay } from '../../utils/timing.js';

/**
 * Shared stdin-injection path for the "runner" CLI adapters (codex-app, mira).
 *
 * These adapters don't drive a TUI — they spawn a small Node runner that reads
 * its stdin raw, byte-by-byte, and enqueues a message only when it sees a
 * trailing newline (see codex-app-runner.ts / mira-runner.ts). botmux hands the
 * runner one control line per message:
 *
 *     ::botmux-<id>:<base64(JSON)>\n
 *
 * The naive implementation wrote the WHOLE line in a single
 * `tmux send-keys -l -- <line>`. For a large message (e.g. a Code Review
 * webhook whose full MR JSON is embedded — ~16-21KB after base64) that single
 * injection overruns the pane pty's input buffer (N_TTY's ~4KB read buffer):
 * tmux's write blocks until the reader drains, which takes longer than
 * execFileSync's 5s timeout, so Botmux can no longer prove whether the
 * keystroke landed — yet the old writeInput still reported `submitted: true`,
 * potentially wedging the session "busy" forever. (Compare claude-code, which throttles
 * its send-keys for exactly this reason; codex-app/mira were the only naive
 * single-shot writers.)
 *
 * Fix: split the line into small chunks and inject them with a short throttle
 * between writes, so no single send-keys overruns the buffer and the reader
 * keeps draining. Crucially we never inject a newline between chunks — the
 * runner accumulates the partial line in its own buffer and only acts on the
 * final Enter — so splitting mid-line is safe. The control line is pure ASCII
 * (marker + base64 alphabet), so 1 char == 1 byte and slicing by code unit is
 * a clean byte split.
 */

/** Max bytes per send-keys chunk. Well under the ~4KB N_TTY input buffer so a
 *  single chunk always drains before the next, even if the reader is briefly
 *  busy. */
export const RUNNER_INPUT_CHUNK_BYTES = 1024;

/** Throttle between chunks — gives the runner's event loop time to drain the
 *  pane pty between writes. */
export const RUNNER_INPUT_THROTTLE_MS = 20;

export function encodeRunnerInput(content: string, codexAppInput?: CodexAppTurnInput): string {
  const payload = codexAppInput
    ? { type: 'message', content, codexAppInput }
    : { type: 'message', content };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** Split an ASCII string into <=maxBytes pieces. Safe because the caller only
 *  ever passes `marker + base64`, which is single-byte throughout. */
export function chunkAscii(line: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < line.length; i += maxBytes) {
    chunks.push(line.slice(i, i + maxBytes));
  }
  return chunks;
}

/**
 * Write one control line to a runner adapter's stdin, chunked + throttled.
 *
 * Returns `{ submitted: false }` when any chunk (or the final Enter) cannot be
 * confirmed. A tmux timeout is ambiguous: bytes may still have reached the
 * pane. `submissionDisposition` therefore tells the worker whether the new
 * frame was provably untouched or the runner generation must be fenced.
 *
 * Buffer-hygiene contract (the runner only clears its stdin buffer on a newline,
 * see handleInput in codex-app-runner.ts / mira-runner.ts — a half-written
 * control line with no trailing Enter lingers and would PREPEND to the next
 * message, corrupting both into one un-parseable blob):
 *   - Pre-flush: emit one Enter before writing, terminating any partial line a
 *     prior failed write may have left behind (runner discards the fragment as
 *     bad input; an empty buffer just ignores the blank line).
 *   - On an unconfirmed chunk: attempt a flush Enter so a partial frame is less
 *     likely to merge with the next message, then report an ambiguous dirty
 *     generation; the flush cannot make delivery proof retroactive.
 *   - Submit Enter is retried — a single unconfirmed Enter could otherwise leave a
 *     COMPLETE but unsubmitted line in the buffer.
 */
export async function writeRunnerInput(
  pty: PtyHandle,
  markerPrefix: string,
  content: string,
  codexAppInput?: CodexAppTurnInput,
): Promise<{ submitted: boolean; submissionDisposition: RunnerSubmissionDisposition }> {
  const line = `${markerPrefix}${encodeRunnerInput(content, codexAppInput)}`;

  // Non-tmux fallback (raw PTY): a single write is fine — there's no send-keys
  // process to time out, and the PTY write isn't bounded the same way.
  if (!pty.sendText || !pty.sendSpecialKeys) {
    try {
      if (pty.write(line + '\r') === false) {
        // SessionBackend.write(false) is a rejection, but its contract does not
        // prove whether a lower layer accepted a prefix before reporting it.
        return { submitted: false, submissionDisposition: 'dirty_unknown' };
      }
    } catch {
      // A throwing PTY write does not prove whether the kernel accepted a
      // prefix (or the complete line) before surfacing the error.
      return { submitted: false, submissionDisposition: 'dirty_unknown' };
    }
    return { submitted: true, submissionDisposition: 'submitted' };
  }

  const sendText = pty.sendText.bind(pty);
  const sendEnterWithRetry = (attempts = 3): boolean => {
    for (let i = 0; i < attempts; i++) {
      if (pty.sendSpecialKeys!('Enter') !== false) return true;
    }
    return false;
  };

  // Pre-flush MUST land before we write a new control line. It terminates any
  // partial line a prior failed write left in the runner's buffer (runner
  // discards the fragment as bad input; an empty buffer just ignores the blank
  // line). If it can't land, the buffer may still hold an old partial — writing
  // our new line NOW would merge "old partial + new line" into one bad line the
  // runner drops, while our submit Enter would still report success (a silent
  // message loss — exactly the failure mode this whole change closes). So bail
  // with submitted:false (the worker raises a submit-failure notice + recheck so
  // the user can retry); we never touch the buffer with a half write. (Idempotent
  // on the happy path: the previous message's
  // submit Enter already emptied the buffer, so this enqueues an ignored blank.)
  try {
    if (!sendEnterWithRetry()) {
      return { submitted: false, submissionDisposition: 'untouched' };
    }
  } catch {
    // The backend threw while attempting the pre-flush.  No new frame bytes
    // were intentionally written, but the Enter itself may have landed, so the
    // runner generation is not proven clean enough for same-generation reuse.
    return { submitted: false, submissionDisposition: 'dirty_unknown' };
  }

  const chunks = chunkAscii(line, RUNNER_INPUT_CHUNK_BYTES);
  for (let i = 0; i < chunks.length; i++) {
    let chunkWritten: void | boolean;
    try {
      chunkWritten = sendText(chunks[i]);
    } catch {
      return { submitted: false, submissionDisposition: 'dirty_unknown' };
    }
    if (chunkWritten === false) {
      // The chunks already written are a partial control line with no
      // terminating newline. Flush it (with retry) so it's less likely to
      // linger; even if every retry drops, the NEXT call's pre-flush gate above
      // refuses to write onto the dirty buffer, so no corruption-as-success can
      // slip through.
      try { sendEnterWithRetry(); } catch { /* disposition remains unknown */ }
      // A tmux send-keys timeout reports false but cannot prove that the pane
      // received zero bytes. In particular, a last-chunk timeout followed by a
      // successful cleanup Enter may have submitted the complete valid frame.
      // Never cancel attribution on this ambiguous boundary.
      return { submitted: false, submissionDisposition: 'dirty_unknown' };
    }
    if (i < chunks.length - 1) await delay(RUNNER_INPUT_THROTTLE_MS);
  }

  // Submit (with retry — a single unconfirmed Enter could leave a complete but
  // unsubmitted line in the buffer).
  try {
    if (!sendEnterWithRetry()) {
      // The complete, valid line may still be buffered.  Retrying a successor
      // in this generation could submit it against the wrong FIFO head.
      return { submitted: false, submissionDisposition: 'dirty_unknown' };
    }
  } catch {
    return { submitted: false, submissionDisposition: 'dirty_unknown' };
  }
  return { submitted: true, submissionDisposition: 'submitted' };
}
