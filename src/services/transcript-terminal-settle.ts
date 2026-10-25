/**
 * Bounded wait between "the backend says the agent finished" and "finalize the
 * turn from the transcript".
 *
 * Herdr's `done` / `idle` is driven by the CLI's own stop hook, which can fire
 * before the CLI has appended the turn's last assistant line (and its terminal
 * marker) to the transcript. Draining the bridge at that instant pops the turn
 * with no answer, and the answer that lands a moment later has no turn left to
 * belong to: it is synthesised as a local turn and suppressed, so a
 * transcript-delivered reply (HTTP wait/async, reply-delivery mode) is lost.
 *
 * A PTY idle edge has the same race: Claude redraws its prompt (and its hooks
 * report done over OSC 7501) while the records that close the turn are still
 * queued for the file. When an API error cut the stream, settling the turn on
 * that edge closes it as `completed`, and the error read a moment later has no
 * turn left to fail.
 *
 * The settle polls until the transcript shows the turn's terminal marker, or
 * the bound elapses, then proceeds exactly as before. A newer request or a
 * cancel (the agent went back to work) drops the one in flight.
 */
export interface TranscriptTerminalSettleOptions {
  /** True while the head turn's terminal marker has not been read yet. May ingest. */
  awaitingTerminal: () => boolean;
  /** Called when the bound ran out with the marker still unread, right before
   *  `proceed`. */
  onTimeout?: () => void;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
}

export interface TranscriptTerminalSettle {
  /** Start (or restart) the settle for a fresh backend "finished" signal;
   *  `proceed` finalizes (drain the bridges, mark the prompt ready). */
  request(proceed: () => void): void;
  /** Drop a pending settle without finalizing. */
  cancel(): void;
}

/** Claude flushes transcript records asynchronously: in the production case
 *  the closing records, created 90-140 ms before the idle edge, were still
 *  unread at it. 2 s leaves headroom for a loaded host while capping how long
 *  a turn whose closing records never come (an older CLI, an interrupt) holds
 *  prompt-ready. */
export const TRANSCRIPT_TERMINAL_SETTLE_TIMEOUT_MS = 2_000;
export const TRANSCRIPT_TERMINAL_SETTLE_POLL_MS = 100;

export function createTranscriptTerminalSettle(opts: TranscriptTerminalSettleOptions): TranscriptTerminalSettle {
  const timeoutMs = opts.timeoutMs ?? TRANSCRIPT_TERMINAL_SETTLE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? TRANSCRIPT_TERMINAL_SETTLE_POLL_MS;
  const now = opts.now ?? Date.now;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  return {
    request(proceed) {
      clear();
      const mine = ++generation;
      const startedAt = now();
      const tick = (): void => {
        timer = undefined;
        if (mine !== generation) return;
        let waiting = false;
        try { waiting = opts.awaitingTerminal(); } catch { /* unreadable transcript: finalize as before */ }
        if (waiting && now() - startedAt < timeoutMs) {
          timer = setTimeout(tick, pollMs);
          timer.unref?.();
          return;
        }
        if (waiting) {
          try { opts.onTimeout?.(); } catch { /* observer only: never block finalizing */ }
        }
        proceed();
      };
      tick();
    },
    cancel() {
      generation++;
      clear();
    },
  };
}
