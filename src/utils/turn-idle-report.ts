/**
 * Turn-idle report fence.
 *
 * A structured "this turn finished" report can arrive from inside the CLI
 * process (dsh-tui's cordis wrapper plugin fires `botmux __turn-idle-v2` on every
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
 * `dispatchAttempt` names the dispatch GENERATION of that turn id (a retry /
 * replay / worker restart re-uses the turn id under a new attempt), so the two
 * must agree exactly:
 *
 *   - active attempt known, report has none  → reject (`missing-attempt`).
 *     The reporter is supposed to freeze the (turn, attempt) pair off the
 *     worker's own publication at the event; an omitted attempt cannot be
 *     bound to the generation the worker is actually waiting on, and accepting
 *     it would let a retry of the same turn id settle through the older
 *     generation's report.
 *   - active attempt unknown, report has one → reject (`attempt-mismatch`).
 *     The two sides disagree about which generation is in flight; only the
 *     side with the publication can be right, and re-sending under the next
 *     idle edge costs nothing.
 *
 * Legacy reporters that cannot carry an attempt are therefore NOT accepted
 * wholesale: the transport (dsh-tui wrapper plugin → `botmux __turn-idle-v2`) is
 * versioned — both in the payload (`v`) and in the subcommand name, so a CLI
 * that predates v2 cannot service the command at all (see cli.ts cmdTurnIdle and
 * adapters/hook-command.ts) — and a report without a frozen identity never
 * reaches this fence.
 */
/**
 * Wire version of the in-CLI → daemon report envelope.
 *
 * v1 (shipped in the first cut of this channel) sent only `{seq, pid}`: the
 * reporter read the turn identity LATER, inside the detached `botmux turn-idle`
 * child, off the worker's mutable active-turn marker. That read can already name
 * the NEXT dispatch (dsh-tui steers busy-period input), so a report about turn A
 * could claim turn B and satisfy the exact-match fence while B was still
 * running.
 *
 * v2 requires the plugin to freeze `(turnId, dispatchAttempt[, capability])`
 * synchronously inside the `agent/status` callback and carry them in the
 * payload; `cmdTurnIdle` transports them verbatim and never re-resolves the
 * live marker. A v1 (or malformed) payload is dropped — fail-quiet, never early.
 * The generated plugin interpolates this constant, so both sides cannot drift.
 */
export const TURN_IDLE_PROTOCOL_VERSION = 2;

export type TurnIdleReportRejection =
  /** No turn id in the report → nothing can be attributed. */
  | 'missing-turn'
  /** This worker has no active turn → there is nothing to settle. */
  | 'no-active-turn'
  /** The report names a different turn than the one in flight. */
  | 'turn-mismatch'
  /** The report omits the dispatch attempt while this turn has one. */
  | 'missing-attempt'
  /** The two sides name different dispatch attempts (replay / retry / restart). */
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
  if (state.activeDispatchAttempt !== undefined) {
    if (state.reportedDispatchAttempt === undefined) {
      return { accept: false, reason: 'missing-attempt' };
    }
    if (state.reportedDispatchAttempt !== state.activeDispatchAttempt) {
      return { accept: false, reason: 'attempt-mismatch' };
    }
  } else if (state.reportedDispatchAttempt !== undefined) {
    return { accept: false, reason: 'attempt-mismatch' };
  }
  if (state.promptReady) return { accept: false, reason: 'already-ready' };
  return { accept: true };
}
