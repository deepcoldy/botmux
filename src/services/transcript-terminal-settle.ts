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
 * The settle polls until the transcript shows the turn's terminal marker, or
 * the bound elapses, then proceeds exactly as before. A newer request or a
 * cancel (the agent went back to work) drops the one in flight.
 */
export interface TranscriptTerminalSettleOptions {
  /** True while the head turn's terminal marker has not been read yet. May ingest. */
  awaitingTerminal: () => boolean;
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
