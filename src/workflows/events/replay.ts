import type {
  ActivityCanceledEvent,
  ActivityFailedEvent,
  ActivityRunningEvent,
  ActivitySucceededEvent,
  ActivityTimedOutEvent,
  ActivityWaitingEvent,
  AttemptCreatedEvent,
  BackoffElapsedEvent,
  BackoffScheduledEvent,
  CancelDeliveredEvent,
  CancelRequestedEvent,
  ConditionEvaluatedEvent,
  EffectAttemptedEvent,
  LeaseSignedEvent,
  NodeCanceledEvent,
  NodeFailedEvent,
  NodeRetryingEvent,
  NodeSkippedEvent,
  NodeSucceededEvent,
  NodeWaitingEvent,
  ReconcileResultEvent,
  ResumeStartedEvent,
  RunCanceledEvent,
  RunCreatedEvent,
  RunFailedEvent,
  RunStartedEvent,
  RunSucceededEvent,
  WaitCreatedEvent,
  WaitDeadlineExceededEvent,
  WaitResolvedEvent,
  WorkerLostEvent,
} from './types.js';
import type { WorkflowEvent } from './schema.js';
import type { ErrorClass, ErrorPayload, OutputRef } from './payloads.js';

// ─── State shapes ───────────────────────────────────────────────────────────

export type RunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type NodeStatus =
  | 'idle'
  | 'triggered'
  | 'running'
  | 'waiting'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export type ActivityStatus =
  | 'pending'
  | 'acquired'
  | 'running'
  | 'waiting'
  | 'effectAttempting'
  | 'succeeded'
  | 'failed'
  | 'timedOut'
  | 'cancelled';

export type AttemptState = {
  attemptId: string;
  attemptNumber: number;
  inputRef: OutputRef;
  status: ActivityStatus;
  leaseId?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  effectAttempted?: {
    idempotencyKey: string;
    inputHash: string;
    idempotencyTtlMs: number;
    provider: string;
    attemptedAtEventId: string;
    /** Wall-clock timestamp the effectAttempted envelope landed (ms epoch).
     *  Resume uses this to evaluate the TTL boundary against `now()` —
     *  cheaper and more deterministic than re-deriving the time from
     *  `eventId` parsing. */
    attemptedAtMs: number;
  };
  // terminal
  output?: OutputRef;
  externalRefs?: Record<string, unknown>;
  error?: ErrorPayload;
  runningMs?: number; // for timedOut
  cancelOriginEventId?: string;
};

export type ActivityState = {
  activityId: string;
  attempts: AttemptState[];
  // Latest-attempt projection (mirrors latest attempt's status).
  status: ActivityStatus;
  currentAttemptId?: string;
  /**
   * Node that owns this Activity (recorded from `attemptCreated.nodeId`).
   * Lets us project node.status when activity-level events arrive
   * (e.g. activityRunning → node.status = 'running').
   */
  ownerNodeId?: string;
};

export type NodeState = {
  nodeId: string;
  status: NodeStatus;
  // Node owns at most one Activity; attempts live inside the activity.
  activityId?: string;
  retryCount: number;
  nextAttemptAt?: number;
  errorClass?: ErrorClass;
  conditionEventId?: string;
  cancelOriginEventId?: string;
};

export type RunState = {
  runId: string;
  status: RunStatus;
  workflowId?: string;
  revisionId?: string;
  initiator?: string;
  input?: OutputRef;
  output?: OutputRef;
  failedNodeId?: string;
  rootCauseEventId?: string;
  cancelOriginEventId?: string;
};

export type Snapshot = {
  run: RunState;
  nodes: Map<string, NodeState>;
  activities: Map<string, ActivityState>;
  /** Convenience: terminal outputs by activityId (succeeded events only). */
  outputs: Map<string, OutputRef>;
  /** Last seq seen.  0 if the log is empty. */
  lastSeq: number;
  /**
   * activityIds with attemptCreated but whose latest attempt has no terminal
   * event (succeeded/failed/timedOut/cancelled).  Consumed by resume in
   * Step 7 to drive reconcile decisions.
   */
  danglingActivities: string[];
  /**
   * activityIds whose latest attempt wrote effectAttempted but never reached
   * a terminal event for that attempt.  Subset of danglingActivities.
   */
  danglingEffectAttempted: string[];
  /**
   * activityIds with waitCreated but no waitResolved / waitDeadlineExceeded.
   */
  danglingWaits: string[];
};

// ─── Replay ─────────────────────────────────────────────────────────────────

/**
 * Fold an event log into a state snapshot.  Read-only — never executes
 * activity logic, never calls providers, never writes to the log.  Events
 * doc §5.2.
 *
 * Throws on:
 *   - empty event list (caller must supply at least the runCreated event
 *     to derive runId)
 *   - first event is not runCreated (state machine forbids — events doc §2.1)
 *   - event.runId mismatch (cross-contamination)
 *
 * Does NOT validate state-machine transitions semantically — the log is
 * authoritative.  If transitions look wrong (e.g. activitySucceeded without
 * attemptCreated), the resulting snapshot will simply have weird state;
 * verification is the producer's job.
 */
export function replay(events: WorkflowEvent[]): Snapshot {
  if (events.length === 0) {
    throw new Error('replay: cannot replay empty event log');
  }
  const first = events[0];
  if (first.type !== 'runCreated') {
    throw new Error(`replay: first event must be runCreated, got ${first.type}`);
  }
  const runId = first.runId;

  const run: RunState = { runId, status: 'pending' };
  const nodes = new Map<string, NodeState>();
  const activities = new Map<string, ActivityState>();
  const outputs = new Map<string, OutputRef>();
  // Wait tracking: activityId -> resolved (true if waitResolved/Deadline seen)
  const waitsOpen = new Set<string>();

  let lastSeq = 0;

  function getNode(id: string): NodeState {
    let n = nodes.get(id);
    if (!n) {
      n = { nodeId: id, status: 'idle', retryCount: 0 };
      nodes.set(id, n);
    }
    return n;
  }

  function getActivity(id: string): ActivityState {
    let a = activities.get(id);
    if (!a) {
      a = { activityId: id, attempts: [], status: 'pending' };
      activities.set(id, a);
    }
    return a;
  }

  function currentAttempt(a: ActivityState): AttemptState | undefined {
    return a.attempts.find((at) => at.attemptId === a.currentAttemptId);
  }

  for (const e of events) {
    if (e.runId !== runId) {
      throw new Error(
        `replay: runId mismatch at ${e.eventId} — log is ${runId}, event has ${e.runId}`,
      );
    }
    const seqMatch = e.eventId.match(/-(\d+)$/);
    if (seqMatch) {
      const s = parseInt(seqMatch[1], 10);
      if (s > lastSeq) lastSeq = s;
    }

    switch (e.type) {
      // ─── Run lifecycle ──────────────────────────────────────────────
      case 'runCreated': {
        const p = (e as RunCreatedEvent).payload as RunCreatedEvent['payload'];
        if (!('ref' in p)) {
          run.workflowId = p.workflowId;
          run.revisionId = p.revisionId;
          run.initiator = p.initiator;
          run.input = p.inputRef;
        }
        break;
      }
      case 'runStarted': {
        run.status = 'running';
        break;
      }
      case 'runSucceeded': {
        const p = (e as RunSucceededEvent).payload as RunSucceededEvent['payload'];
        run.status = 'succeeded';
        if (!('ref' in p)) run.output = p.outputRef;
        break;
      }
      case 'runFailed': {
        const p = (e as RunFailedEvent).payload as RunFailedEvent['payload'];
        run.status = 'failed';
        if (!('ref' in p)) {
          run.failedNodeId = p.failedNodeId;
          run.rootCauseEventId = p.rootCauseEventId;
        }
        break;
      }
      case 'runCanceled': {
        const p = (e as RunCanceledEvent).payload as RunCanceledEvent['payload'];
        run.status = 'cancelled';
        if (!('ref' in p)) run.cancelOriginEventId = p.cancelOriginEventId;
        break;
      }

      // ─── Node lifecycle ─────────────────────────────────────────────
      case 'nodeWaiting': {
        const p = (e as NodeWaitingEvent).payload as NodeWaitingEvent['payload'];
        if (!('ref' in p)) getNode(p.nodeId).status = 'waiting';
        break;
      }
      case 'nodeRetrying': {
        const p = (e as NodeRetryingEvent).payload as NodeRetryingEvent['payload'];
        if (!('ref' in p)) {
          const n = getNode(p.nodeId);
          n.status = 'retrying';
          n.retryCount += 1;
        }
        break;
      }
      case 'nodeSucceeded': {
        const p = (e as NodeSucceededEvent).payload as NodeSucceededEvent['payload'];
        if (!('ref' in p)) {
          const n = getNode(p.nodeId);
          n.status = 'succeeded';
          n.activityId = p.lastActivityId;
        }
        break;
      }
      case 'nodeFailed': {
        const p = (e as NodeFailedEvent).payload as NodeFailedEvent['payload'];
        if (!('ref' in p)) {
          const n = getNode(p.nodeId);
          n.status = 'failed';
          n.activityId = p.lastActivityId;
          n.errorClass = p.errorClass;
        }
        break;
      }
      case 'nodeSkipped': {
        const p = (e as NodeSkippedEvent).payload as NodeSkippedEvent['payload'];
        if (!('ref' in p)) {
          const n = getNode(p.nodeId);
          n.status = 'skipped';
          n.conditionEventId = p.conditionEventId;
        }
        break;
      }
      case 'nodeCanceled': {
        const p = (e as NodeCanceledEvent).payload as NodeCanceledEvent['payload'];
        if (!('ref' in p)) {
          const n = getNode(p.nodeId);
          n.status = 'cancelled';
          n.cancelOriginEventId = p.cancelOriginEventId;
        }
        break;
      }

      // ─── Scheduling ─────────────────────────────────────────────────
      case 'conditionEvaluated': {
        const p = (e as ConditionEvaluatedEvent).payload as ConditionEvaluatedEvent['payload'];
        if (!('ref' in p)) {
          const n = getNode(p.nodeId);
          n.conditionEventId = e.eventId;
          // resultTrue=true: node is on its way to triggered (attemptCreated/leaseSigned will follow).
          // resultTrue=false: nodeSkipped will follow shortly.  Either way we don't
          // mutate node.status here — wait for the explicit follow-up event.
        }
        break;
      }
      case 'attemptCreated': {
        const p = (e as AttemptCreatedEvent).payload as AttemptCreatedEvent['payload'];
        if (!('ref' in p)) {
          const a = getActivity(p.activityId);
          a.attempts.push({
            attemptId: p.attemptId,
            attemptNumber: p.attemptNumber,
            inputRef: p.inputRef,
            status: 'pending',
          });
          a.currentAttemptId = p.attemptId;
          a.status = 'pending';
          // Codex round 4 fix: capture activity→node ownership so we can
          // project node.status on later activity-level events.
          a.ownerNodeId = p.nodeId;
          // First attempt creates the "this node is now triggered" signal:
          // before attemptCreated the node has no activity to point at.
          // For retries (attemptNumber > 1) we DON'T overwrite — by then
          // the node has typically already been routed through
          // `nodeRetrying` and we should let `nodeRetrying`'s explicit
          // event own the status.
          const n = getNode(p.nodeId);
          n.activityId = p.activityId;
          if (p.attemptNumber === 1 && n.status === 'idle') {
            n.status = 'triggered';
          }
        }
        break;
      }
      case 'leaseSigned': {
        const p = (e as LeaseSignedEvent).payload as LeaseSignedEvent['payload'];
        if (!('ref' in p)) {
          const a = getActivity(p.activityId);
          const at = a.attempts.find((x) => x.attemptId === p.attemptId);
          if (at) {
            at.leaseId = p.leaseId;
            at.timeoutMs = p.timeoutMs;
            at.maxOutputBytes = p.maxOutputBytes;
          }
          // After both attemptCreated + leaseSigned for the first attempt, node
          // transitions idle→triggered (per state machine 4.2).  We mark the
          // node here unambiguously: leaseSigned implies the attempt exists.
          // Find the owning node: walk all nodes whose activityId === p.activityId
          // — but Node knows its activityId only after nodeSucceeded/nodeFailed.
          // For replay we don't have explicit node↔activity mapping events; the
          // producer's intent is that conditionEvaluated{true} + leaseSigned for
          // the FIRST attempt = node triggered.  v0 leaves this as advisory: we
          // don't synthesize node.status from leaseSigned, only from explicit
          // node* events.  This keeps replay deterministic given the event log.
        }
        break;
      }
      case 'backoffScheduled': {
        const p = (e as BackoffScheduledEvent).payload as BackoffScheduledEvent['payload'];
        if (!('ref' in p)) {
          const n = getNode(p.nodeId);
          n.nextAttemptAt = p.nextAttemptAt;
        }
        break;
      }
      case 'backoffElapsed': {
        const p = (e as BackoffElapsedEvent).payload as BackoffElapsedEvent['payload'];
        if (!('ref' in p)) {
          const n = getNode(p.nodeId);
          n.nextAttemptAt = undefined;
        }
        break;
      }

      // ─── Side effect ────────────────────────────────────────────────
      case 'effectAttempted': {
        const p = (e as EffectAttemptedEvent).payload as EffectAttemptedEvent['payload'];
        if (!('ref' in p)) {
          const a = getActivity(p.activityId);
          const at = a.attempts.find((x) => x.attemptId === p.attemptId);
          if (at) {
            at.effectAttempted = {
              idempotencyKey: p.idempotencyKey,
              inputHash: p.inputHash,
              idempotencyTtlMs: p.idempotencyTtlMs,
              provider: p.provider,
              attemptedAtEventId: e.eventId,
              attemptedAtMs: e.timestamp,
            };
            at.status = 'effectAttempting';
            a.status = 'effectAttempting';
          }
        }
        break;
      }
      case 'activitySucceeded': {
        const p = (e as ActivitySucceededEvent).payload as ActivitySucceededEvent['payload'];
        if (!('ref' in p)) {
          const a = getActivity(p.activityId);
          const at = a.attempts.find((x) => x.attemptId === p.attemptId);
          if (at) {
            at.status = 'succeeded';
            at.output = p.outputRef;
            at.externalRefs = p.externalRefs;
            a.status = 'succeeded';
            outputs.set(p.activityId, p.outputRef);
          }
        }
        break;
      }
      case 'activityFailed': {
        const p = (e as ActivityFailedEvent).payload as ActivityFailedEvent['payload'];
        if (!('ref' in p)) {
          const a = getActivity(p.activityId);
          const at = a.attempts.find((x) => x.attemptId === p.attemptId);
          if (at) {
            at.status = 'failed';
            at.error = p.error;
            a.status = 'failed';
          }
        }
        break;
      }
      case 'activityTimedOut': {
        const p = (e as ActivityTimedOutEvent).payload as ActivityTimedOutEvent['payload'];
        if (!('ref' in p)) {
          const a = getActivity(p.activityId);
          const at = a.attempts.find((x) => x.attemptId === p.attemptId);
          if (at) {
            at.status = 'timedOut';
            at.runningMs = p.runningMs;
            a.status = 'timedOut';
          }
        }
        break;
      }
      case 'activityRunning': {
        const p = (e as ActivityRunningEvent).payload as ActivityRunningEvent['payload'];
        if (!('ref' in p)) {
          const a = getActivity(p.activityId);
          const at = a.attempts.find((x) => x.attemptId === p.attemptId);
          if (at) {
            at.status = 'running';
            a.status = 'running';
          }
          // Project node.status from triggered/retrying → running when
          // the activity's worker actually starts work.  Skip if the
          // node has already reached waiting/terminal — those are owned
          // by explicit node-level events.
          if (a.ownerNodeId) {
            const n = getNode(a.ownerNodeId);
            if (n.status === 'triggered' || n.status === 'retrying') {
              n.status = 'running';
            }
          }
        }
        break;
      }
      case 'activityWaiting': {
        const p = (e as ActivityWaitingEvent).payload as ActivityWaitingEvent['payload'];
        if (!('ref' in p)) {
          const a = getActivity(p.activityId);
          const at = currentAttempt(a);
          if (at) {
            at.status = 'waiting';
            a.status = 'waiting';
          }
        }
        break;
      }
      case 'activityCanceled': {
        const p = (e as ActivityCanceledEvent).payload as ActivityCanceledEvent['payload'];
        if (!('ref' in p)) {
          const a = getActivity(p.activityId);
          const at = a.attempts.find((x) => x.attemptId === p.attemptId);
          if (at) {
            at.status = 'cancelled';
            at.cancelOriginEventId = p.cancelOriginEventId;
            a.status = 'cancelled';
          }
        }
        break;
      }

      // ─── Wait ───────────────────────────────────────────────────────
      case 'waitCreated': {
        const p = (e as WaitCreatedEvent).payload as WaitCreatedEvent['payload'];
        if (!('ref' in p)) waitsOpen.add(p.activityId);
        break;
      }
      case 'waitResolved': {
        const p = (e as WaitResolvedEvent).payload as WaitResolvedEvent['payload'];
        if (!('ref' in p)) waitsOpen.delete(p.activityId);
        break;
      }
      case 'waitDeadlineExceeded': {
        const p = (e as WaitDeadlineExceededEvent).payload as WaitDeadlineExceededEvent['payload'];
        if (!('ref' in p)) waitsOpen.delete(p.activityId);
        break;
      }

      // ─── Control ────────────────────────────────────────────────────
      case 'cancelRequested':
      case 'cancelDelivered': {
        // No direct state mutation — terminal node/activity/run cancel
        // events (activityCanceled / nodeCanceled / runCanceled) carry
        // the projection.  These two are causal links recorded for audit
        // and to drive scheduler-side broadcast logic.
        void (e as CancelRequestedEvent | CancelDeliveredEvent);
        break;
      }

      // ─── System / Recovery ──────────────────────────────────────────
      case 'workerLost':
      case 'resumeStarted':
      case 'reconcileResult': {
        // No deterministic state projection during replay.  Resume logic
        // (Step 7) reads these events directly to drive recovery; replay
        // just preserves them in the event order for downstream use.
        void (e as WorkerLostEvent | ResumeStartedEvent | ReconcileResultEvent);
        break;
      }

      default: {
        // Exhaustiveness — every event type above must have a case.
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
  }

  // ─── Compute dangling sets ────────────────────────────────────────────
  const danglingActivities: string[] = [];
  const danglingEffectAttempted: string[] = [];
  for (const a of activities.values()) {
    const latest = a.attempts.length > 0 ? a.attempts[a.attempts.length - 1] : undefined;
    if (!latest) continue;
    const isTerminal =
      latest.status === 'succeeded' ||
      latest.status === 'failed' ||
      latest.status === 'timedOut' ||
      latest.status === 'cancelled';
    if (!isTerminal) {
      danglingActivities.push(a.activityId);
      if (latest.effectAttempted) {
        danglingEffectAttempted.push(a.activityId);
      }
    }
  }

  const danglingWaits = Array.from(waitsOpen);

  return {
    run,
    nodes,
    activities,
    outputs,
    lastSeq,
    danglingActivities,
    danglingEffectAttempted,
    danglingWaits,
  };
}
