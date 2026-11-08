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
  /** False when the writer itself proved its input never reached the backend
   *  (e.g. a framed runner refused the line before buffering any byte). */
  submissionStarted?: boolean;
  runnerGenerationUnsafe?: boolean;
}

export interface RewrappedSubmissionFailure {
  message: string;
  recoveryFailureReason?: string;
  submissionStarted: boolean;
  runnerGenerationUnsafe: boolean;
}

/**
 * Preserve the writer's own evidence when an error escapes the ambiguous
 * submission transaction:
 *
 * - `runnerGenerationUnsafe`: without it, a dirty framed-runner error is
 *   re-wrapped into a plain error and the caller's fence-generation
 *   classification silently downgrades to `notify`, re-opening the "half-frame
 *   merges with the next queued line and is dropped" bug.
 * - `submissionStarted === false`: the transaction only knows its write
 *   callback ran; a writer that proved no byte reached the backend knows more.
 *   Overwriting that proof with `true` makes a clean rejection look ambiguous
 *   on fence-capable backends only, so recovery that is correct on every other
 *   backend never runs there. Only an explicit `false` from the writer
 *   withdraws the claim; a plain error never does, and a transaction rejected
 *   before its write (outer `false`) is never raised to `true`.
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
    submissionStarted: submissionStarted && e?.submissionStarted !== false,
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
