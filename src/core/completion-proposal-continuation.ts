import {
  buildCompletionProposalContinuationPrompt,
  type CompletionProposalRecord,
  type CompletionProposalStore,
} from './completion-proposal.js';

export interface CompletionProposalContinuationDeps {
  store: CompletionProposalStore;
  sessionCanResume(record: CompletionProposalRecord): boolean;
  dispatch(input: {
    record: CompletionProposalRecord;
    turnId: string;
    prompt: string;
  }): Promise<'admitted' | 'rejected'>;
  publishState?(record: CompletionProposalRecord): void | Promise<void>;
}

/**
 * Non-blocking continuation phase. The caller invokes this only after the card
 * callback has been ACKed. `dispatching` is durable before the turn edge; a
 * daemon crash from there is recovered as `dispatch_unknown`, never retried.
 */
export async function runCompletionProposalContinuation(
  proposal: CompletionProposalRecord,
  deps: CompletionProposalContinuationDeps,
): Promise<CompletionProposalRecord> {
  const begun = deps.store.beginDispatch(proposal.proposalId);
  if (!begun.changed) return begun.record;
  const current = begun.record;
  const turnId = current.dispatch!.continuationTurnId;
  let settled: CompletionProposalRecord;
  if (!deps.sessionCanResume(current)) {
    settled = deps.store.settleDispatch(
      current.proposalId,
      'dispatch_failed',
      'session_or_persistent_backend_unavailable',
    );
  } else {
    try {
      const outcome = await deps.dispatch({
        record: current,
        turnId,
        prompt: buildCompletionProposalContinuationPrompt(current),
      });
      settled = deps.store.settleDispatch(
        current.proposalId,
        outcome === 'admitted' ? 'dispatched' : 'dispatch_failed',
        outcome === 'rejected' ? 'continuation_not_admitted' : undefined,
      );
    } catch (error) {
      settled = deps.store.settleDispatch(
        current.proposalId,
        'dispatch_unknown',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  try { await deps.publishState?.(settled); } catch { /* state is durable; patch is best-effort */ }
  return settled;
}
