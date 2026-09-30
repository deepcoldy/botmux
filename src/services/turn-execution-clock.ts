/**
 * Worker-local clock for a turn's REAL native execution window.
 *
 * The window opens at the literal CLI write (the moment this turn's input is
 * actually handed to the backend), not when the daemon queued it — a turn that
 * waited 40s behind a busy CLI must not report 40s of "execution". It closes at
 * the turn's native terminal.
 *
 * Everything here is deliberately fail-quiet: an unknown start yields NO
 * duration rather than a guessed one, because a fabricated number is worse than
 * an absent one for the analytics this feeds.
 */

/** Bound the map so a turn that never reaches a terminal cannot leak forever
 *  (cancelled mid-flight, CLI killed, worker replaced). Insertion-ordered
 *  eviction drops the oldest unsettled start, which is exactly the one whose
 *  duration is least trustworthy by then. */
const MAX_TRACKED_TURNS = 512;

export interface TurnExecutionTiming {
  /** Epoch ms of the native terminal. Always present. */
  completedAtMs: number;
  /** Native execution time in ms. Absent when the start instant is unknown. */
  durationMs?: number;
}

function key(turnId: string, dispatchAttempt?: number): string {
  return `${turnId}:${dispatchAttempt ?? 'generic'}`;
}

export class TurnExecutionClock {
  private readonly startedAtMs = new Map<string, number>();

  constructor(private readonly maxTracked = MAX_TRACKED_TURNS) {
    if (!Number.isInteger(maxTracked) || maxTracked < 1) {
      throw new Error('maxTracked must be a positive integer');
    }
  }

  /**
   * Open the window for one `(turn, dispatch attempt)` at its literal write.
   * Re-arming the same key overwrites: a resubmit/replay genuinely restarts the
   * CLI-side work, so the later write is the honest start.
   */
  start(turnId: string | undefined, dispatchAttempt?: number, atMs: number = Date.now()): void {
    if (!turnId || !Number.isFinite(atMs)) return;
    const id = key(turnId, dispatchAttempt);
    // Delete first so a re-armed key moves to the end of the insertion order and
    // is not evicted ahead of genuinely older starts.
    this.startedAtMs.delete(id);
    this.startedAtMs.set(id, atMs);
    while (this.startedAtMs.size > this.maxTracked) {
      const oldest = this.startedAtMs.keys().next().value;
      if (oldest === undefined) break;
      this.startedAtMs.delete(oldest);
    }
  }

  /**
   * Close the window and return the timing to publish. The entry is consumed, so
   * a duplicate terminal for the same key reports the completion instant without
   * a second duration — the first (real) terminal already owns it.
   *
   * `completedAtMs` may be supplied by a backend that timestamps its own
   * completion (codex-app's runner does); it is trusted only when it is a finite
   * instant that is not in the future, so a skewed/forged runner clock cannot
   * mint a completion later than this worker's own observation.
   */
  settle(
    turnId: string | undefined,
    dispatchAttempt?: number,
    completedAtMs?: number,
    nowMs: number = Date.now(),
  ): TurnExecutionTiming | undefined {
    const timing = this.read(turnId, dispatchAttempt, completedAtMs, nowMs);
    if (turnId) this.startedAtMs.delete(key(turnId, dispatchAttempt));
    return timing;
  }

  /**
   * Same computation as `settle` but WITHOUT consuming the entry. Used by the
   * codex-app two-phase settlement, which must stamp the daemon-synthesized
   * terminal before the worker's own terminal fires; both then report identical
   * numbers, and the store's INSERT OR IGNORE makes whichever lands first the
   * one that counts.
   */
  peek(
    turnId: string | undefined,
    dispatchAttempt?: number,
    completedAtMs?: number,
    nowMs: number = Date.now(),
  ): TurnExecutionTiming | undefined {
    return this.read(turnId, dispatchAttempt, completedAtMs, nowMs);
  }

  private read(
    turnId: string | undefined,
    dispatchAttempt: number | undefined,
    completedAtMs: number | undefined,
    nowMs: number,
  ): TurnExecutionTiming | undefined {
    if (!turnId) return undefined;
    const startedAt = this.startedAtMs.get(key(turnId, dispatchAttempt));
    const completed = typeof completedAtMs === 'number' && Number.isFinite(completedAtMs)
      ? Math.min(completedAtMs, nowMs)
      : nowMs;
    if (startedAt === undefined) return { completedAtMs: completed };
    const durationMs = completed - startedAt;
    // A negative span means the clocks disagree (backend-supplied completion
    // predating our own write observation). Report the completion instant and
    // withhold the duration rather than publish a nonsense number.
    if (!Number.isFinite(durationMs) || durationMs < 0) return { completedAtMs: completed };
    return { completedAtMs: completed, durationMs: Math.round(durationMs) };
  }

  /** Drop a tracked start without producing timing (turn abandoned pre-terminal). */
  forget(turnId: string | undefined, dispatchAttempt?: number): void {
    if (!turnId) return;
    this.startedAtMs.delete(key(turnId, dispatchAttempt));
  }

  /** Drop every tracked start (CLI replaced / session reset). */
  clear(): void {
    this.startedAtMs.clear();
  }

  size(): number {
    return this.startedAtMs.size;
  }
}
