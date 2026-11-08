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

/**
 * Structural shape of the worker's SubmissionWriteError needed to preserve its
 * safety marker when the ambiguous-submission WAL transaction re-wraps a
 * thrown error. Kept structural (not an import of the worker class) so this
 * pure seam is testable without loading worker.ts.
 */
export interface RewrapableSubmissionFailure {
  message: string;
  runnerGenerationUnsafe?: boolean;
}

export interface RewrappedSubmissionFailure {
  message: string;
  recoveryFailureReason?: string;
  submissionStarted: boolean;
  runnerGenerationUnsafe: boolean;
}

/**
 * Preserve the framed-runner safety marker when an error escapes the
 * ambiguous submission transaction. Without this, a `runnerGenerationUnsafe`
 * error from the writer is re-wrapped into a plain error and the caller's
 * fence-generation classification silently downgrades to `notify`, re-opening
 * the "half-frame merges with the next queued line and is dropped" bug.
 */
export function rewrapSubmissionFailure(
  err: unknown,
  recoveryFailureReason: string | undefined,
  submissionStarted: boolean,
): RewrappedSubmissionFailure {
  const e = err as RewrapableSubmissionFailure | null;
  const detail = err instanceof Error ? err.message : String(err);
  return {
    message: recoveryFailureReason ? `${detail}; ${recoveryFailureReason}` : detail,
    ...(recoveryFailureReason ? { recoveryFailureReason } : {}),
    submissionStarted,
    runnerGenerationUnsafe: !!e?.runnerGenerationUnsafe,
  };
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
