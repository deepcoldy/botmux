import type { DaemonSession } from './types.js';

/** A pruned all-cancelled tail is an empty queue, not a failed promotion. The
 * write-ahead flag keeps a failed cancellation prune from looking drained. */
export function hasCleanlyDrainedQueuedActivationTail(ds: DaemonSession): boolean {
  return (ds.session.queuedActivationTail?.length ?? 0) === 0
    && !ds.session.queuedActivationPending
    && ds.activationCancellationPending !== true;
}
