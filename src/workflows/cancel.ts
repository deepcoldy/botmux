/**
 * Cancel propagation (events doc v0.1.2 §2.5, Step 9 of 10).
 *
 * Cancel is a TERMINAL REASON, not an error — Run/Node/Activity each
 * have an independent `cancelled` terminal state.  The chain (§2.5):
 *
 *   cancelRequested(target)
 *     → scheduler broadcasts to non-terminal nodes
 *     → for each running activity: send cancel signal
 *     → cancelDelivered (worker acknowledges)
 *     → worker cleans up
 *     → activityCanceled (Activity terminal)
 *     → nodeCanceled    (Node terminal, only after ALL its activities
 *                        reach a terminal state; spec §2.5 "partial
 *                        cancel": cancelRequested(activityId) does NOT
 *                        auto-cancel parent node)
 *     → runCanceled     (Run terminal, only when all nodes terminal;
 *                        spec §2.5: cancelRequested(nodeId) does NOT
 *                        auto-cancel parent run)
 *
 * Step 9 deliverables:
 *   - `requestCancel`, `deliverCancel`, `completeActivityCancel` —
 *     host functions that write the corresponding events.
 *   - replay projection of in-flight cancel state so resume can
 *     detect dangling cancels (cancelRequested written, terminal
 *     missing) and complete them.
 *   - resume integration: a third recovery branch alongside
 *     reconcile + wait recovery.
 *
 * Step 9 does NOT:
 *   - implement the scheduler broadcast (run/node → activity fan-out
 *     is Step 10+ scheduler concern; this layer assumes the caller
 *     supplies activity-level cancels);
 *   - decide retry policy (cancel preempts retry — once canceled,
 *     terminal stays canceled, not failed/retryable).
 */

import type { EventLog } from './events/append.js';
import type {
  ActivityCanceledEvent,
  CancelDeliveredEvent,
  CancelRequestedEvent,
  NodeCanceledEvent,
  RunCanceledEvent,
} from './events/types.js';

// ─── Public types ──────────────────────────────────────────────────────────

export type CancelTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'node'; nodeId: string }
  | { kind: 'activity'; activityId: string };

export type RequestCancelInput = {
  target: CancelTarget;
  /** Free-form human-readable reason; recorded for audit + dashboard. */
  reason: string;
  /** Identifier of the requester — open_id, system actor name, etc. */
  by: string;
};

export type DeliverCancelInput = {
  target: CancelTarget;
  /** Activity that the worker actually acknowledged the cancel on.
   *  For node/run-level cancels broadcast to multiple activities, the
   *  worker writes one cancelDelivered per activity it acknowledges. */
  activityId: string;
};

export type CompleteActivityCancelInput = {
  activityId: string;
  attemptId: string;
  /** eventId of the originating cancelRequested — surfaced on the
   *  terminal so post-hoc forensics can follow the cancel chain. */
  cancelOriginEventId: string;
};

export type CompleteNodeCancelInput = {
  nodeId: string;
  cancelOriginEventId: string;
};

export type CompleteRunCancelInput = {
  cancelOriginEventId: string;
};

export type RequestCancelActor = 'human' | 'supervisor' | 'system';
export type DeliverCancelActor = 'worker' | 'system';
export type CompleteCancelActor = 'scheduler' | 'worker' | 'system';

// ─── Host API ─────────────────────────────────────────────────────────────

/**
 * Originating cancel event.  Records the intent without changing any
 * entity state — the actual transitions happen via cancelDelivered →
 * activityCanceled.
 */
export async function requestCancel(
  log: EventLog,
  input: RequestCancelInput,
  actor: RequestCancelActor = 'human',
): Promise<CancelRequestedEvent> {
  return (await log.append({
    runId: log.runId,
    type: 'cancelRequested',
    actor,
    payload: {
      target: input.target,
      reason: input.reason,
      by: input.by,
    },
  })) as CancelRequestedEvent;
}

/**
 * Worker acknowledges the cancel signal for a specific activity.
 * Multiple cancelDelivered events may fan out from a single
 * cancelRequested(run|node).
 */
export async function deliverCancel(
  log: EventLog,
  input: DeliverCancelInput,
  actor: DeliverCancelActor = 'worker',
): Promise<CancelDeliveredEvent> {
  return (await log.append({
    runId: log.runId,
    type: 'cancelDelivered',
    actor,
    payload: {
      target: input.target,
      activityId: input.activityId,
    },
  })) as CancelDeliveredEvent;
}

/**
 * Activity terminal in the cancel branch.  Spec §2.5: cancel produces
 * a distinct terminal state (not activityFailed/canceled error code).
 */
export async function completeActivityCancel(
  log: EventLog,
  input: CompleteActivityCancelInput,
  actor: CompleteCancelActor = 'scheduler',
): Promise<ActivityCanceledEvent> {
  return (await log.append({
    runId: log.runId,
    type: 'activityCanceled',
    actor,
    payload: {
      activityId: input.activityId,
      attemptId: input.attemptId,
      cancelOriginEventId: input.cancelOriginEventId,
    },
  })) as ActivityCanceledEvent;
}

/**
 * Node terminal in the cancel branch.  Spec §2.5: nodeCanceled fires
 * only after ALL of the node's activities have reached terminal — the
 * caller (scheduler / supervisor) is responsible for verifying that
 * precondition before invoking.  This helper merely writes the event.
 */
export async function completeNodeCancel(
  log: EventLog,
  input: CompleteNodeCancelInput,
  actor: CompleteCancelActor = 'scheduler',
): Promise<NodeCanceledEvent> {
  return (await log.append({
    runId: log.runId,
    type: 'nodeCanceled',
    actor,
    payload: {
      nodeId: input.nodeId,
      cancelOriginEventId: input.cancelOriginEventId,
    },
  })) as NodeCanceledEvent;
}

/**
 * Run terminal in the cancel branch.  Spec §2.5: runCanceled fires
 * only after ALL of the run's nodes have reached terminal.  Same
 * precondition responsibility as `completeNodeCancel` — this helper
 * writes the event but doesn't enforce dependencies.
 */
export async function completeRunCancel(
  log: EventLog,
  input: CompleteRunCancelInput,
  actor: CompleteCancelActor = 'scheduler',
): Promise<RunCanceledEvent> {
  return (await log.append({
    runId: log.runId,
    type: 'runCanceled',
    actor,
    payload: {
      cancelOriginEventId: input.cancelOriginEventId,
    },
  })) as RunCanceledEvent;
}
