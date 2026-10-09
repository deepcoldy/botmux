/** Successful listener completion may reclaim its session after an idle boundary. */
import type { DaemonSession } from './types.js';
import { hasProtectedSessionMutationOwnership } from './session-mutation-guard.js';

/** Check exact completion and queued work under the caller's bot mutation gate. */
export function canAutoCloseMessageListenerSession(ds: DaemonSession, turnId: string): boolean {
  return ds.session.messageListenerAutoClose === true
    && ds.session.status === 'active'
    && ds.messageListenerCompletedTurnId === turnId
    && ds.currentTurnId === turnId
    && (!ds.currentReplyTarget || ds.currentReplyTarget.turnId === turnId)
    && ds.lastScreenStatus === 'idle'
    && !ds.activeInteractiveTurn
    && !ds.agentAttention
    && !ds.pendingRawInput
    && !ds.pendingFollowUpInput
    && !ds.pendingFollowUps?.length
    && !ds.session.crossPrincipalInterruptions?.length
    && !hasProtectedSessionMutationOwnership(ds)
    && (!ds.session.readonlyTaskContinuation
      || ds.session.readonlyTaskContinuation.status === 'completed')
    && (!ds.session.ordinaryTurnRecovery
      || ds.session.ordinaryTurnRecovery.status === 'completed');
}
