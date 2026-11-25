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
  /** True while the transcript shows the CLI is still inside the turn's tool
   *  cycle (its last record is a `tool_use` stop or a tool_result it has not
   *  answered yet). A "finished" signal seen then is premature: keep waiting
   *  past `timeoutMs`, up to `maxHoldMs`, instead of finalizing. May read. */
  midToolCycle?: () => boolean;
  maxHoldMs?: number;
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
/** Upper bound for holding a premature "finished" while the transcript is mid
 *  tool cycle: one model call between two tools can take minutes (thinking). */
export const TRANSCRIPT_TERMINAL_SETTLE_MAX_HOLD_MS = 10 * 60_000;

export function createTranscriptTerminalSettle(opts: TranscriptTerminalSettleOptions): TranscriptTerminalSettle {
  const timeoutMs = opts.timeoutMs ?? TRANSCRIPT_TERMINAL_SETTLE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? TRANSCRIPT_TERMINAL_SETTLE_POLL_MS;
  const now = opts.now ?? Date.now;
  const maxHoldMs = opts.maxHoldMs ?? TRANSCRIPT_TERMINAL_SETTLE_MAX_HOLD_MS;
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
      // The normal bound counts from here; after a hold ends it restarts, so
      // the turn's closing records get the same grace as after a real finish.
      let graceFrom = startedAt;
      let held = false;
      const tick = (): void => {
        timer = undefined;
        if (mine !== generation) return;
        let waiting = false;
        try { waiting = opts.awaitingTerminal(); } catch { /* unreadable transcript: finalize as before */ }
        const at = now();
        let holding = false;
        if (waiting && at - graceFrom >= timeoutMs && at - startedAt < maxHoldMs && opts.midToolCycle) {
          try { holding = opts.midToolCycle(); } catch { /* unreadable: finalize as before */ }
        }
        if (waiting && held && !holding && at - startedAt < maxHoldMs) {
          // The tool cycle just ended (the final answer is being written):
          // give its terminal marker the normal bound instead of timing out now.
          held = false;
          graceFrom = at;
        }
        if (holding) held = true;
        if (waiting && (at - graceFrom < timeoutMs || holding)) {
          timer = setTimeout(tick, holding ? Math.max(pollMs, 500) : pollMs);
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

/** True when the tail of a Claude Code transcript (JSONL text, possibly
 *  starting mid-line) shows the turn is still inside its tool cycle: the last
 *  main-chain assistant record stopped for `tool_use`, or a tool_result was
 *  written after it (the next model call is in flight). A real prompt, an
 *  interrupt notice or a compact summary (string / text content) says "not mid
 *  cycle", as does anything unparsable. */
export function claudeTranscriptTailMidToolCycle(tail: string): boolean {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.isMeta || rec?.isSidechain) continue;
    if (rec?.type === 'assistant') return rec?.message?.stop_reason === 'tool_use';
    if (rec?.type === 'user') {
      const c = rec?.message?.content;
      return Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result');
    }
  }
  return false;
}
