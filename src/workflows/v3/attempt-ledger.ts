/**
 * Pure resource ledger for v3 goal attempts.
 *
 * Node state is not process state: early-release cancellation and revisit
 * supersession are intentionally journalled before the old worker has closed.
 * This fold tracks the stricter resource truth needed at run boundaries.
 */
import type { StoredEvent } from './journal.js';

export interface V3OpenWorkerAttempt {
  nodeId: string;
  instanceId?: string;
  attemptId: string;
}

const isAttemptOpened = (
  event: StoredEvent,
): event is StoredEvent & Extract<StoredEvent, { type: 'nodeDispatched' | 'nodeWorkerFenceArmed' }> =>
  event.type === 'nodeDispatched' || event.type === 'nodeWorkerFenceArmed';

function postCloseAttempt(event: StoredEvent): V3OpenWorkerAttempt | undefined {
  if (
    event.type === 'nodeSucceeded' ||
    event.type === 'nodeFailed' ||
    event.type === 'nodeBlocked' ||
    event.type === 'nodeAttemptDrained'
  ) {
    return {
      nodeId: event.nodeId,
      ...(event.instanceId ? { instanceId: event.instanceId } : {}),
      attemptId: event.attemptId,
    };
  }
  // Historical run-cancellation handling guarantees that an attempt-scoped verdict is written
  // only after the local Promise or external fence proved outer close. Keep it
  // as a close proof for one-release histories that predate AttemptDrained.
  if (event.type === 'nodeCancelled' && event.reason === 'runCancelled') {
    if (!event.attemptId) return undefined;
    return {
      nodeId: event.nodeId,
      ...(event.instanceId ? { instanceId: event.instanceId } : {}),
      attemptId: event.attemptId,
    };
  }
  return undefined;
}

/**
 * Return every dispatched worker attempt that has no durable post-close proof.
 *
 * `nodeCancelled(earlyReleaseLoser)` and `nodeInstanceSuperseded` deliberately
 * do not close an attempt: both are scheduling decisions that can precede the
 * outer ChildProcess `close` event by an arbitrary amount of time.
 */
export function openV3WorkerAttempts(events: readonly StoredEvent[]): V3OpenWorkerAttempt[] {
  const opened = new Map<string, V3OpenWorkerAttempt>();
  const closed = new Set<string>();

  for (const event of events) {
    if (isAttemptOpened(event)) {
      const prior = opened.get(event.attemptId);
      if (
        prior &&
        (prior.nodeId !== event.nodeId || prior.instanceId !== event.instanceId)
      ) {
        throw new Error(`v3 attempt ledger: identity changed for ${event.attemptId}`);
      }
      opened.set(event.attemptId, {
        nodeId: event.nodeId,
        ...(event.instanceId ? { instanceId: event.instanceId } : {}),
        attemptId: event.attemptId,
      });
      // A malformed/reused attempt id that appears after a prior close proof
      // must become open again. Never let an out-of-order verdict prove closure
      // for a later dispatch.
      closed.delete(event.attemptId);
      continue;
    }
    const close = postCloseAttempt(event);
    if (!close) continue;
    const identity = opened.get(close.attemptId);
    // A close-before-open record cannot bless a later dispatch that reuses the
    // id. Likewise, only the first post-open close is authoritative; later
    // duplicate projection events do not get to reinterpret the identity.
    if (!identity || closed.has(close.attemptId)) continue;
    if (identity.nodeId !== close.nodeId || identity.instanceId !== close.instanceId) {
      throw new Error(`v3 attempt ledger: close identity changed for ${close.attemptId}`);
    }
    closed.add(close.attemptId);
  }

  return [...opened.values()].filter((attempt) => !closed.has(attempt.attemptId));
}

export function hasOpenV3WorkerAttempts(events: readonly StoredEvent[]): boolean {
  return openV3WorkerAttempts(events).length > 0;
}
