/** Successful listener completion may reclaim its session after an idle boundary. */
import type { DaemonSession } from './types.js';
import { waitForTurnFinalOutputDeliveryDrain } from './final-output-delivery-drain.js';
import { waitAllWithin } from './producer-quiescence.js';
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
    && !ds.session.xpiSharedCwdQueuedTurns?.length
    && !ds.finalOutputDeliveriesByTurn?.get(turnId)?.size
    && !hasProtectedSessionMutationOwnership(ds)
    && (!ds.session.readonlyTaskContinuation
      || ds.session.readonlyTaskContinuation.status === 'completed')
    && (!ds.session.ordinaryTurnRecovery
      || ds.session.ordinaryTurnRecovery.status === 'completed');
}

/** Let terminal/idle callbacks settle before attempting listener cleanup. */
export const MESSAGE_LISTENER_CLOSE_DELAY_MS = 1_500;
/** Allow the existing 0/5/15 second delivery retry sequence; timeout retains the session. */
export const MESSAGE_LISTENER_DELIVERY_DRAIN_TIMEOUT_MS = 30_000;

/** Bind listener cleanup to the daemon's existing mutation and close paths. */
export function createMessageListenerAutoCloseScheduler(deps: {
  mutate: (ds: DaemonSession, action: () => Promise<void>) => Promise<void>;
  isCurrent: (ds: DaemonSession) => boolean;
  closeCompletedSession: (ds: DaemonSession) => Promise<void>;
  onError: (error: unknown) => void;
}): (ds: DaemonSession) => void {
  const scheduled = new WeakMap<DaemonSession, {
    turnId: string;
    worker: DaemonSession['worker'];
    timer: ReturnType<typeof setTimeout>;
  }>();
  return ds => {
    const turnId = ds.messageListenerCompletedTurnId;
    if (!turnId || !ds.session.messageListenerAutoClose) return;
    const worker = ds.worker;
    const previous = scheduled.get(ds);
    if (previous?.turnId === turnId && previous.worker === worker) return;
    if (previous) clearTimeout(previous.timer);
    const claim = { turnId, worker, timer: setTimeout(() => {
      void (async () => {
        // Never hold the Bot mutation gate across external delivery/retry waits.
        const drained = await waitAllWithin(
          [waitForTurnFinalOutputDeliveryDrain(ds, turnId)],
          Date.now() + MESSAGE_LISTENER_DELIVERY_DRAIN_TIMEOUT_MS,
        );
        if (scheduled.get(ds) !== claim) return;
        if (!drained) throw new Error(`Final reply delivery timed out for ${turnId}; listener session retained`);
        await deps.mutate(ds, async () => {
          if (scheduled.get(ds) !== claim || ds.worker !== worker || !deps.isCurrent(ds)
            || !canAutoCloseMessageListenerSession(ds, turnId)) return;
          await deps.closeCompletedSession(ds);
        });
      })().catch(deps.onError).finally(() => {
        // A superseded timer/drain must never remove the next turn's schedule.
        if (scheduled.get(ds) === claim) scheduled.delete(ds);
      });
    }, MESSAGE_LISTENER_CLOSE_DELAY_MS) };
    scheduled.set(ds, claim);
    claim.timer.unref();
  };
}
