/**
 * System / recovery boundary host API (events doc v0.1.2 §2.6, Step 10
 * of 10).
 *
 * Step 10 deliverables (paired with Step 7 resume + Step 9 cancel):
 *   - `reportWorkerLost` — write `workerLost { workerId, lostActivityIds }`.
 *     Resume already handles the consequence (Step 7):
 *       * for each lost activity with dangling effectAttempted → run
 *         the reconcile decision tree;
 *       * for each lost activity without effectAttempted → write
 *         activityFailed { WorkerCrashed, retryable };
 *       * dangling waits stay alone (worker death is not a wait
 *         resolution).
 *     So this module only adds the host-side writer; the recovery
 *     loop is already in place.
 *
 * Note on the cancel fan-out (also Step 10): the fan-out lives in
 * replay (not here) — it's a deterministic projection of node/run
 * cancel onto in-flight activities, not a new event-writing path.
 */

import type { EventLog } from './events/append.js';
import type { WorkerLostEvent } from './events/types.js';

export type ReportWorkerLostInput = {
  /** Identifier of the worker that timed out / disconnected. */
  workerId: string;
  /**
   * Activities the runtime registry believes the worker held leases
   * for at the moment of detection.  Resume walks these alongside the
   * generic dangling-set fallback — supplying them here lets the
   * runtime tag the event with audit-grade evidence even if the
   * dangling set picks up additional activities later.
   */
  lostActivityIds: string[];
};

/**
 * Record a worker timeout / heartbeat loss.  Spec §2.6 v0.1.1: this is
 * the system-fault path; explicitly NOT cancel.  Resume's recovery
 * loop (Step 7) reads dangling state, not this event — workerLost is
 * primarily an audit trail.  Writing it before resume runs is the
 * recommended ordering so the audit reflects why recovery fired.
 *
 * Returns the appended event (with eventId etc).
 *
 * Throws if `lostActivityIds` is empty (spec mandates min 1; an empty
 * list means "worker lost but had no work" which is a no-op the
 * runtime should detect before writing this event).
 */
export async function reportWorkerLost(
  log: EventLog,
  input: ReportWorkerLostInput,
): Promise<WorkerLostEvent> {
  if (input.lostActivityIds.length === 0) {
    throw new Error(
      `reportWorkerLost(${input.workerId}): lostActivityIds is empty — the runtime should skip writing workerLost when the worker held no leases.`,
    );
  }
  return (await log.append({
    runId: log.runId,
    type: 'workerLost',
    actor: 'system',
    payload: {
      workerId: input.workerId,
      lostActivityIds: input.lostActivityIds,
    },
  })) as WorkerLostEvent;
}
