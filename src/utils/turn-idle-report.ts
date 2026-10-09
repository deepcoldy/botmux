/**
 * Turn-idle report fence.
 *
 * A structured "this turn finished" report can arrive from inside the CLI
 * process (dsh-tui's cordis wrapper plugin fires `botmux turn-idle` on every
 * `agent/status === 'idle'` transition). The worker turns an accepted report
 * into `idleDetector.fireIdle()` → `markPromptReady()`, which publishes a ready
 * edge and may flush queued input. Accepting a report for a turn that is NOT the
 * one this worker is actually waiting on would therefore write into a busy CLI
 * and settle the wrong turn — the expensive direction.
 *
 * So the decision is deliberately one-sided: a report is accepted only when it
 * names exactly the turn this worker believes is in flight, and the worker is
 * still waiting for that turn (not already prompt-ready). Everything else is
 * dropped, which is always safe here: the reporter reads the turn id from the
 * worker-published active-turn marker, so a mismatch means this worker has
 * already moved on, and the newer turn will produce its own idle edge when it
 * really finishes (dsh-tui also delivers queued input through the type-ahead
 * path, so nothing is stranded waiting for a ready edge).
 *
 * Derived from the same shape as the other worker-side authority checks:
 * `turnId` carries the identity (fresh random id per turn), and
 * `dispatchAttempt` only disambiguates a replay of the SAME turn id, so it is
 * compared only when both sides can see it — a report that simply could not
 * read an attempt is not treated as a mismatch.
 */
export type TurnIdleReportRejection =
  /** No turn id in the report → nothing can be attributed. */
  | 'missing-turn'
  /** This worker has no active turn → there is nothing to settle. */
  | 'no-active-turn'
  /** The report names a different turn than the one in flight. */
  | 'turn-mismatch'
  /** Same turn id, different dispatch attempt (a replay of that turn). */
  | 'attempt-mismatch'
  /** The worker is not waiting for a turn any more. */
  | 'already-ready';

export type TurnIdleReportDecision =
  | { readonly accept: true }
  | { readonly accept: false; readonly reason: TurnIdleReportRejection };

export function decideTurnIdleReport(state: {
  readonly reportedTurnId?: string;
  readonly reportedDispatchAttempt?: number;
  readonly activeTurnId?: string;
  readonly activeDispatchAttempt?: number;
  readonly promptReady: boolean;
}): TurnIdleReportDecision {
  if (!state.reportedTurnId) return { accept: false, reason: 'missing-turn' };
  if (!state.activeTurnId) return { accept: false, reason: 'no-active-turn' };
  if (state.reportedTurnId !== state.activeTurnId) return { accept: false, reason: 'turn-mismatch' };
  if (state.reportedDispatchAttempt !== undefined
    && state.activeDispatchAttempt !== undefined
    && state.reportedDispatchAttempt !== state.activeDispatchAttempt) {
    return { accept: false, reason: 'attempt-mismatch' };
  }
  if (state.promptReady) return { accept: false, reason: 'already-ready' };
  return { accept: true };
}
