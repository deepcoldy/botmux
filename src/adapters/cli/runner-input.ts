import type { PtyHandle } from './types.js';
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
 * execFileSync's 5s timeout, so the send-keys is killed and the keystroke is
 * silently dropped — yet the old writeInput still reported `submitted: true`,
 * wedging the session "busy" forever. (Compare claude-code, which throttles
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

export function encodeRunnerInput(content: string): string {
  return Buffer.from(JSON.stringify({ type: 'message', content }), 'utf8').toString('base64');
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
 * Returns `{ submitted: false }` when any chunk (or the final Enter) fails to
 * write — the tmux backend's send methods return `false` on a dropped-but-pane-
 * alive keystroke, so a genuine drop is now surfaced to the worker (which warns
 * / re-queues) instead of being swallowed as a false success.
 *
 * Buffer-hygiene contract (the runner only clears its stdin buffer on a newline,
 * see handleInput in codex-app-runner.ts / mira-runner.ts — a half-written
 * control line with no trailing Enter lingers and would PREPEND to the next
 * message, corrupting both into one un-parseable blob):
 *   - Pre-flush: emit one Enter before writing, terminating any partial line a
 *     prior failed write may have left behind (runner discards the fragment as
 *     bad input; an empty buffer just ignores the blank line).
 *   - On a dropped chunk: emit a flush Enter so the partial we just wrote can't
 *     merge with the next message, then report non-submission for re-queue.
 *   - Submit Enter is retried — a single dropped Enter would otherwise leave a
 *     COMPLETE but unsubmitted line in the buffer.
 */
export async function writeRunnerInput(
  pty: PtyHandle,
  markerPrefix: string,
  content: string,
): Promise<{ submitted: boolean }> {
  const line = `${markerPrefix}${encodeRunnerInput(content)}`;

  // Non-tmux fallback (raw PTY): a single write is fine — there's no send-keys
  // process to time out, and the PTY write isn't bounded the same way.
  if (!pty.sendText || !pty.sendSpecialKeys) {
    try {
      pty.write(line + '\r');
    } catch {
      return { submitted: false };
    }
    return { submitted: true };
  }

  const sendText = pty.sendText.bind(pty);
  const sendEnter = (): boolean => pty.sendSpecialKeys!('Enter') !== false;

  // Pre-flush any leftover partial control line (see buffer-hygiene contract).
  // Cheap and idempotent on the happy path: the previous message's submit Enter
  // already emptied the buffer, so this just enqueues a blank line the runner
  // ignores.
  sendEnter();

  const chunks = chunkAscii(line, RUNNER_INPUT_CHUNK_BYTES);
  for (let i = 0; i < chunks.length; i++) {
    if (sendText(chunks[i]) === false) {
      // The chunks already written are sitting in the runner's buffer as a
      // partial control line with no terminating newline. Flush it (best-effort)
      // so the discarded fragment can't merge with the next message.
      sendEnter();
      return { submitted: false };
    }
    if (i < chunks.length - 1) await delay(RUNNER_INPUT_THROTTLE_MS);
  }

  // Submit, retrying the Enter — a single dropped Enter leaves a complete but
  // unsubmitted line in the buffer (the next call's pre-flush would belatedly
  // submit it; retrying here makes that vanishingly rare).
  for (let attempt = 0; attempt < 3; attempt++) {
    if (sendEnter()) return { submitted: true };
  }
  return { submitted: false };
}
