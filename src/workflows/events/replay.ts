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
  LoopFinishedEvent,
  LoopIterationFinishedEvent,
  LoopIterationStartedEvent,
  LoopStartedEvent,
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
import { workActivityId } from '../orchestrator.js';

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
  /**
   * Latest reconcileResult matched to this attempt by idempotencyKey.
   * Resume consults this BEFORE re-running the decision tree: if a
   * previous resume crashed between writing reconcileResult and the
   * terminal event, replay surfaces the prior decision so the next
   * resume can finish what the first started (codex Step 7 round 1
   * finding 1).  reconcileResult.payload doesn't carry attemptId — we
   * match by idempotencyKey, which uniquely identifies the attempt.
   */
  latestReconcileResult?: {
    decision: 'replayed' | 'completedByIdempotentSubmit' | 'manual' | 'freshRetry';
    capability: 'readOnlyLookup' | 'idempotentSubmit' | 'none';
    evidence: Record<string, unknown>;
    eventId: string;
  };
  /**
   * Cancel-in-flight marker (Step 9).  Populated when a `cancelRequested`
   * targets this activity (directly via `kind=activity`, or — Step 10
   * scheduler concern — fan-out from node/run cancel).  Resume reads
   * this to detect dangling cancels (cancelRequested written, terminal
   * missing) and complete them with `activityCanceled`.
   *
   * Cleared / superseded once `activityCanceled` writes a terminal —
   * but we keep `cancelOriginEventId` recoverable from the request
   * event itself, so resume doesn't need an in-flight pointer post-
   * terminal.
   */
  cancelRequest?: {
    cancelOriginEventId: string;
    requestedBy: string;
    reason: string;
    delivered: boolean;
  };
  /**
   * Wait state for human-gate / time / condition activities (Step 8).
   * Populated by `waitCreated` and updated by `waitResolved` /
   * `waitDeadlineExceeded`.  Resume reads this to recover dangling
   * wait resolutions (resolved/exceeded but no terminal written).
   */
  wait?: {
    waitKind: 'human-gate' | 'time' | 'condition';
    deadlineAt?: number;
    /** Inline prompt — only set for small prompts (≤1 KiB producer policy)
     *  AND for historical pre-v0.1.3 events.  When the prompt was spilled
     *  to a blob, `prompt` is undefined and consumers must use `promptRef`
     *  (full text on demand) or `promptPreview` (cheap, card-safe). */
    prompt?: string;
    /** Blob spill ref (v0.1.3+).  Replay never reads the blob; cards
     *  must render `promptPreview` only and dashboard reads on demand. */
    promptRef?: OutputRef;
    /** Short preview carried inline on waitCreated when promptRef is set;
     *  ≤500 chars by schema, byte-budgeted by the producer. */
    promptPreview?: string;
    /** Default `fail` at the consumer.  Recorded only when waitCreated
     *  carries the field; absent means caller never specified. */
    onTimeout?: 'fail' | 'success';
    /** Open when neither resolution nor deadline event has landed. */
    resolution?:
      | {
          kind: 'resolved';
          resolution: 'approved' | 'rejected' | 'external';
          by: string;
          comment?: string;
          eventId: string;
        }
      | {
          kind: 'deadlineExceeded';
          deadlineAt: number;
          exceededAtMs: number;
          eventId: string;
        };
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
  /**
   * Immutable bot identity snapshot captured at runCreated time
   * (UI doc §3.4).  Read by the runtime when spawning workers so that
   * subsequent bot-registry rename / re-wire doesn't drift execution
   * away from what was authored.  Absent on legacy runs created before
   * v0.1.3 introduced the field.
   */
  botSnapshots?: Record<
    string,
    {
      larkAppId?: string;
      cliId?: string;
      displayName?: string;
      workingDir?: string;
      cliPathOverride?: string;
    }
  >;
};

export type LoopIterationState = {
  iteration: number;
  status: 'running' | 'approved' | 'rejected' | 'failed' | 'cancelled';
  bodyActivityIds: string[];
  decisionActivityId?: string;
  waitResolvedEventId?: string;
  decisionBy?: string;
  decisionComment?: string;
  timedOut?: boolean;
};

export type LoopState = {
  loopId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  iteration: number;
  maxIterations: number;
  iterations: LoopIterationState[];
  output?: OutputRef;
  errorCode?: string;
  errorClass?: ErrorClass;
};

export type Snapshot = {
  run: RunState;
  nodes: Map<string, NodeState>;
  activities: Map<string, ActivityState>;
  loops: Map<string, LoopState>;
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
  /**
   * activityIds whose wait was resolved (either by waitResolved or by
   * waitDeadlineExceeded) but whose attempt never reached a terminal
   * event.  Step 8 resume recovery materializes the terminal from the
   * recorded resolution.  Disjoint from `danglingWaits`.
   */
  danglingWaitResolutions: string[];
  /**
   * activityIds with a `cancelRequested` targeting them (directly or
   * via fan-out — Step 10 scheduler concern), but no terminal yet.
   *
   * NOT disjoint from `danglingEffectAttempted` (Step 9 round 1
   * finding 1):  cancel + effectAttempted is the central case that
   * `recoverCancelWithReconcile` handles — reconcile fires FIRST to
   * capture provider evidence, then writes the cancel-flavored
   * terminal (`activityCanceled` for completedByIdempotentSubmit /
   * freshRetry; `activityFailed{manual}` when reconcile is
   * inconclusive).  The orchestrator routes the intersection through
   * the cancel-with-reconcile path; remaining cancels (no effect)
   * go through plain `recoverCancel`.
   *
   * Disjoint from `danglingWaitResolutions` is still upheld — cancel
   * + wait combinations are skipped by wait recovery; cancel wins.
   */
  danglingCancels: string[];
  /**
   * Run-level cancel intent (Step 9 codex round 1 finding 3).  Set when
   * a `cancelRequested{kind:run}` lands and not yet `runCanceled`.  Replay
   * surfaces it so schedulers / dashboards can see "this run is being
   * cancelled" without re-scanning the event list.  Cleared when
   * `runCanceled` lands (run.status === 'cancelled').
   */
  cancelledRunIntent?: {
    cancelOriginEventId: string;
    requestedBy: string;
    reason: string;
  };
  /**
   * Per-node cancel intents.  Same shape and role as `cancelledRunIntent`
   * but scoped to a node — set when `cancelRequested{kind:node}` lands
   * and the node hasn't yet reached `nodeCanceled`.  First request wins
   * on overlap (consistent with the activity-level fan-out semantics).
   */
  cancelledNodeIntents: Map<
    string,
    {
      cancelOriginEventId: string;
      requestedBy: string;
      reason: string;
    }
  >;
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
  const loops = new Map<string, LoopState>();
  const outputs = new Map<string, OutputRef>();
  // Wait tracking: activityId -> resolved (true if waitResolved/Deadline seen)
  const waitsOpen = new Set<string>();
  // Step 9 finding 3: cancel intents — first request wins.
  let runCancelIntent:
    | { cancelOriginEventId: string; requestedBy: string; reason: string }
    | undefined;
  const nodeCancelIntents = new Map<
    string,
    { cancelOriginEventId: string; requestedBy: string; reason: string }
  >();

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

  function getLoop(loopId: string): LoopState {
    let loop = loops.get(loopId);
    if (!loop) {
      loop = {
        loopId,
        status: 'running',
        iteration: 0,
        maxIterations: 0,
        iterations: [],
      };
      loops.set(loopId, loop);
    }
    return loop;
  }

  function getLoopIteration(loop: LoopState, iteration: number): LoopIterationState {
    let it = loop.iterations.find((candidate) => candidate.iteration === iteration);
    if (!it) {
      it = { iteration, status: 'running', bodyActivityIds: [] };
      loop.iterations.push(it);
      loop.iterations.sort((a, b) => a.iteration - b.iteration);
    }
    return it;
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
          if (p.botSnapshots) run.botSnapshots = p.botSnapshots;
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

      // ─── Loop lifecycle ─────────────────────────────────────────────
      case 'loopStarted': {
        const p = (e as LoopStartedEvent).payload as LoopStartedEvent['payload'];
        if (!('ref' in p)) {
          const loop = getLoop(p.loopId);
          loop.status = 'running';
          loop.maxIterations = p.maxIterations;
        }
        break;
      }
      case 'loopIterationStarted': {
        const p = (e as LoopIterationStartedEvent).payload as LoopIterationStartedEvent['payload'];
        if (!('ref' in p)) {
          const loop = getLoop(p.loopId);
          loop.status = 'running';
          loop.iteration = p.iteration;
          const it = getLoopIteration(loop, p.iteration);
          it.status = 'running';
        }
        break;
      }
      case 'loopIterationFinished': {
        const p = (e as LoopIterationFinishedEvent).payload as LoopIterationFinishedEvent['payload'];
        if (!('ref' in p)) {
          const loop = getLoop(p.loopId);
          loop.iteration = Math.max(loop.iteration, p.iteration);
          const it = getLoopIteration(loop, p.iteration);
          it.status = p.resolution;
          it.decisionActivityId = p.decisionActivityId;
          it.waitResolvedEventId = p.waitResolvedEventId;
          it.decisionBy = p.by;
          it.decisionComment = p.comment;
          it.timedOut = p.timedOut;
        }
        break;
      }
      case 'loopFinished': {
        const p = (e as LoopFinishedEvent).payload as LoopFinishedEvent['payload'];
        if (!('ref' in p)) {
          const loop = getLoop(p.loopId);
          loop.iteration = p.finalIteration;
          loop.status =
            p.resolution === 'approved'
              ? 'succeeded'
              : p.resolution === 'cancelled'
                ? 'cancelled'
                : 'failed'; // body-failed / timeout / max-iterations-exceeded
          loop.output = p.outputRef;
          loop.errorCode = p.errorCode;
          loop.errorClass = p.errorClass;
          if (p.outputRef) {
            outputs.set(workActivityId(runId, p.loopId), p.outputRef);
          }
          // Close any still-running iteration so the dashboard / ops
          // surface doesn't display the loop as "failed but iteration
          // X is somehow still running" (codex Step 3 review Medium —
          // /tmp/wf-loop-v02.md §10.8 design compromise resolved).
          if (loop.status !== 'succeeded') {
            const inflight = loop.iterations.find((it) => it.status === 'running');
            if (inflight) {
              inflight.status =
                p.resolution === 'cancelled' ? 'cancelled' : 'failed';
            }
          }
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
          for (const loop of loops.values()) {
            const it = loop.iterations.find((candidate) => candidate.iteration === loop.iteration);
            if (!it) continue;
            if (!p.activityId.includes(`::loop::${loop.loopId}.${it.iteration}::`)) continue;
            if (!it.bodyActivityIds.includes(p.activityId)) {
              it.bodyActivityIds.push(p.activityId);
            }
          }
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
            waitsOpen.delete(p.activityId);
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
            waitsOpen.delete(p.activityId);
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
            waitsOpen.delete(p.activityId);
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
            waitsOpen.delete(p.activityId);
          }
        }
        break;
      }

      // ─── Wait ───────────────────────────────────────────────────────
      case 'waitCreated': {
        const p = (e as WaitCreatedEvent).payload as WaitCreatedEvent['payload'];
        if (!('ref' in p)) {
          waitsOpen.add(p.activityId);
          const act = getActivity(p.activityId);
          const at = currentAttempt(act);
          if (at) {
            at.wait = {
              waitKind: p.waitKind,
              deadlineAt: p.deadlineAt,
              prompt: p.prompt,
              promptRef: p.promptRef,
              promptPreview: p.promptPreview,
              onTimeout: p.onTimeout,
            };
          }
        }
        break;
      }
      case 'waitResolved': {
        const p = (e as WaitResolvedEvent).payload as WaitResolvedEvent['payload'];
        if (!('ref' in p)) {
          waitsOpen.delete(p.activityId);
          const act = getActivity(p.activityId);
          const at = currentAttempt(act);
          if (at && at.wait) {
            at.wait.resolution = {
              kind: 'resolved',
              resolution: p.resolution,
              by: p.by,
              comment: p.comment,
              eventId: e.eventId,
            };
          }
        }
        break;
      }
      case 'waitDeadlineExceeded': {
        const p = (e as WaitDeadlineExceededEvent).payload as WaitDeadlineExceededEvent['payload'];
        if (!('ref' in p)) {
          waitsOpen.delete(p.activityId);
          const act = getActivity(p.activityId);
          const at = currentAttempt(act);
          if (at && at.wait) {
            at.wait.resolution = {
              kind: 'deadlineExceeded',
              deadlineAt: p.deadlineAt,
              exceededAtMs: p.exceededAtMs,
              eventId: e.eventId,
            };
          }
        }
        break;
      }

      // ─── Control ────────────────────────────────────────────────────
      case 'cancelRequested': {
        // Step 9 + Step 10: project the request onto the targeted
        // entity.  Spec §2.5 cancel chain expects scheduler to "broadcast
        // to all non-terminal nodes, send cancel to each running activity"
        // — replay treats this as a deterministic semantic projection
        // (no need to materialize per-activity events): a node-level
        // cancel marks every in-flight activity linked to that node;
        // a run-level cancel marks every in-flight activity.
        //
        // Activities created AFTER the cancelRequested are intentionally
        // NOT auto-marked here — the scheduler should refuse to spawn
        // new attempts under a cancelled run/node.  If it does anyway,
        // those activities go through the regular WorkerCrashed/reconcile
        // recovery paths.
        const p = (e as CancelRequestedEvent).payload as CancelRequestedEvent['payload'];
        if (!('ref' in p)) {
          const markActivity = (act: ActivityState) => {
            const at = currentAttempt(act);
            if (!at) return;
            const isTerminal =
              at.status === 'succeeded' ||
              at.status === 'failed' ||
              at.status === 'timedOut' ||
              at.status === 'cancelled';
            if (isTerminal) return; // cancel doesn't override terminals
            // First cancel wins — later overlapping cancels don't rewrite
            // the cancelOriginEventId so the audit chain stays pointing
            // at the originating event.
            if (at.cancelRequest) return;
            at.cancelRequest = {
              cancelOriginEventId: e.eventId,
              requestedBy: p.by,
              reason: p.reason,
              delivered: false,
            };
          };
          switch (p.target.kind) {
            case 'activity': {
              markActivity(getActivity(p.target.activityId));
              break;
            }
            case 'node': {
              const nodeId = p.target.nodeId;
              // Record node intent (first cancel wins) regardless of
              // whether any activities are currently mapped to the node
              // — the intent stands even if fan-out finds nothing yet.
              if (!nodeCancelIntents.has(nodeId)) {
                nodeCancelIntents.set(nodeId, {
                  cancelOriginEventId: e.eventId,
                  requestedBy: p.by,
                  reason: p.reason,
                });
              }
              for (const act of activities.values()) {
                if (act.ownerNodeId === nodeId) markActivity(act);
              }
              break;
            }
            case 'run': {
              // Record run intent (first cancel wins).
              if (!runCancelIntent) {
                runCancelIntent = {
                  cancelOriginEventId: e.eventId,
                  requestedBy: p.by,
                  reason: p.reason,
                };
              }
              for (const act of activities.values()) markActivity(act);
              break;
            }
          }
        }
        break;
      }
      case 'cancelDelivered': {
        const p = (e as CancelDeliveredEvent).payload as CancelDeliveredEvent['payload'];
        if (!('ref' in p)) {
          const act = getActivity(p.activityId);
          const at = currentAttempt(act);
          if (at?.cancelRequest) {
            at.cancelRequest.delivered = true;
          }
        }
        break;
      }

      // ─── System / Recovery ──────────────────────────────────────────
      case 'workerLost':
      case 'resumeStarted': {
        // No state projection: these are audit-only.
        //   - `workerLost` (Step 10) is informational — the runtime emits
        //     it when a worker disappears with in-flight activityIds, and
        //     the lost activities surface through the normal dangling
        //     paths (no terminals, so they show up in danglingActivities
        //     and feed reconcile / WorkerCrashed recovery).  Replay
        //     doesn't need to mutate state to make that work.
        //   - `resumeStarted` (Step 7) is written BY resume itself as the
        //     first event of a recovery cycle; downstream consumers may
        //     read it for audit/forensics, but replay just preserves it
        //     in the event order.
        void (e as WorkerLostEvent | ResumeStartedEvent);
        break;
      }
      case 'reconcileResult': {
        // Project the latest reconcileResult onto the matching attempt
        // (by idempotencyKey).  Resume uses this to recover from a
        // crash that landed between reconcileResult and the terminal
        // event — without this projection the next resume would re-run
        // the decision tree and risk a different (possibly wrong)
        // outcome (codex Step 7 round 1 finding 1).
        const p = (e as ReconcileResultEvent).payload as ReconcileResultEvent['payload'];
        if (!('ref' in p)) {
          // Linear scan: workflows have small attempt counts, no need
          // to index by idempotencyKey.
          for (const act of activities.values()) {
            const at = act.attempts.find(
              (x) => x.effectAttempted?.idempotencyKey === p.idempotencyKey,
            );
            if (at) {
              at.latestReconcileResult = {
                decision: p.decision,
                capability: p.capability,
                evidence: p.evidence,
                eventId: e.eventId,
              };
              break;
            }
          }
        }
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
  const danglingWaitResolutions: string[] = [];
  const danglingCancels: string[] = [];
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
      // A wait that has a recorded resolution (resolved or
      // deadlineExceeded) but no terminal event is recoverable: write
      // the matching activity-terminal during resume.
      if (latest.wait?.resolution) {
        danglingWaitResolutions.push(a.activityId);
      }
      // Cancel requested but no terminal yet — resume completes by
      // writing activityCanceled.  Cancel takes precedence over other
      // recovery paths (see resume routing).
      if (latest.cancelRequest) {
        danglingCancels.push(a.activityId);
      }
    }
  }

  const danglingWaits = Array.from(waitsOpen);

  // Drop intents that already reached their terminal.  Spec §2.5:
  // run/nodeCanceled writes the cancel terminal; once present the intent
  // is no longer in-flight.  The intent stays set when the terminal
  // hasn't been written (caller / scheduler still needs to complete it).
  const cancelledRunIntent = run.status === 'cancelled' ? undefined : runCancelIntent;
  const cancelledNodeIntents = new Map<
    string,
    { cancelOriginEventId: string; requestedBy: string; reason: string }
  >();
  for (const [nodeId, intent] of nodeCancelIntents) {
    const node = nodes.get(nodeId);
    if (node?.status === 'cancelled') continue;
    cancelledNodeIntents.set(nodeId, intent);
  }

  return {
    run,
    nodes,
    activities,
    loops,
    outputs,
    lastSeq,
    danglingActivities,
    danglingEffectAttempted,
    danglingWaitResolutions,
    danglingCancels,
    danglingWaits,
    cancelledRunIntent,
    cancelledNodeIntents,
  };
}
