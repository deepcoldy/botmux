/**
 * Classification of a failed raw passthrough dispatch (`raw_input` IPC,
 * startup command lines, v3 goal-mode's first dispatch).
 *
 * Extracted as a pure seam so worker callers can be tested for WHAT they do
 * with each failure, not just for the error type that was thrown:
 *
 * - `fence-generation`: a framed stdin runner may already hold a partial frame.
 *   Any successor line typed into that runner can merge with the half-frame
 *   and be dropped while the backend still reports the write as accepted. The
 *   caller MUST tear down the runner generation (worker exit) and must not
 *   continue to the next queued/startup line.
 * - `workflow-node-fail`: a v3 workflow worker has no human in the session to
 *   retry its single goal dispatch; fail the node now instead of idling until
 *   its wall deadline.
 * - `notify`: an ordinary interactive session; surface the failure and keep
 *   the existing (non-framed) recovery semantics.
 */
export type RawDispatchFailureAction = 'fence-generation' | 'workflow-node-fail' | 'notify';

export interface RawDispatchFailureLike {
  runnerGenerationUnsafe?: boolean;
}

export function classifyRawDispatchFailure(
  err: unknown,
  isWorkflowWorker: boolean,
): RawDispatchFailureAction {
  if (
    typeof err === 'object'
    && err !== null
    && (err as RawDispatchFailureLike).runnerGenerationUnsafe === true
  ) {
    return 'fence-generation';
  }
  if (isWorkflowWorker) return 'workflow-node-fail';
  return 'notify';
}
