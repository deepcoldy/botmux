/**
 * Durable workflow event contracts shared by the scheduler and host runtimes.
 *
 * Keep this module data-only. Journal persistence, Botmux sessions, workers,
 * and provider adapters consume these shapes but must never leak into them.
 */

export type GoalAsk =
  | {
      question: string;
      options: string[];
      freeText?: false;
    }
  | {
      question: string;
      freeText: true;
      options?: never;
    };

export type GoalAnswer =
  | {
      selected: string;
      by: string;
    }
  | {
      text: string;
      by: string;
    };

export type V3ErrorClass =
  | 'workerError'
  | 'manifestInvalid'
  | 'artifactContractInvalid'
  | 'resultInvalid'
  | 'timeout'
  | 'gateRejected'
  | 'cancelled';

export type V3RunFailureReason = 'allSinksSkipped';
export type V3BlockedRecovery = 'retry' | 'reviseWorkflow';

export interface V3RuntimeAttestation {
  cliId: string;
  source: 'worker-active-runtime';
  model: string | null;
  reasoningEffort: string | null;
  codexHome?: string;
}

export interface V3UncertainHostEffect {
  nodeId: string;
  instanceId: string;
  attemptId: string;
  executor: string;
  errorCode: string;
}

export interface V3LoopRef {
  loopId: string;
  iteration: number;
  bodyNodeId: string;
}

/** Where an external goal-node handoff is delivered (design §5.1). */
export type V3ExternalPlacement = 'topic' | 'main';

/** Per-message idempotency keys, frozen in `nodeHandoffPrepared` so a
 *  re-dispatch after a crash reuses the exact same keys. */
export interface V3HandoffIdempotency {
  /** Node card (topic placement only). */
  nodeCard?: string;
  handoff: string;
}

/**
 * Why a runtime flow revision needs the initiator's confirmation before it
 * takes effect (design §13.5 / M1). `callerNotInitiator` covers every edit
 * made in a turn neither opened by the run's initiator nor woken by this
 * run's own events; the rest are the §13.5 categories.
 */
export type V3RevisionConfirmReason =
  | 'callerNotInitiator'
  | 'newBot'
  | 'hostNode'
  | 'gateRelaxed'
  | 'budgetExpanded';

/**
 * State changes a revision makes to already-dispatched work, folded
 * atomically with its `dagRevised` event (one journal line, so a crash can
 * never apply the new definition without its invalidations or vice versa).
 */
export interface V3RevisionEffects {
  /** Current instances invalidated by a definition change, reassignment or
   *  rerun — materialized exactly like `nodeInstanceSuperseded`: the node
   *  re-dispatches a fresh instance (and re-passes its gate). `waitId` names a
   *  pending gate wait voided by the change. */
  supersede?: Array<{ nodeId: string; instanceId: string; waitId?: string }>;
  /** Removed nodes that had already been dispatched or gated: neutral
   *  cancellation of that exact instance/attempt (only ever via this effect,
   *  never a separate `nodeCancelled`). `waitId` = a pending gate it voids. */
  cancel?: Array<{ nodeId: string; instanceId?: string; attemptId?: string; waitId?: string }>;
  /** Blocked instances whose gate approval no longer covers their changed
   *  definition: the approval is dropped and their next retry runs as a
   *  fresh instance that must pass the gate again, however it is triggered. */
  regate?: Array<{ nodeId: string; instanceId: string }>;
  /** Done nodes re-run with Revisit semantics; each consumes revisit budget. */
  rerun?: string[];
  /** Revisit budget the initiator's own edit lifted for its re-runs (M2 乙):
   *  each entry is one more revisit, counted exactly like a
   *  `revisitBudgetGranted` (`pair` = that node onto itself, `run` =
   *  run-wide) and attributed to this revision's `by`. In this event, never
   *  a separate line, so a crash cannot leave a lift without its revision. */
  budgetGrants?: Array<{ nodeId: string; tier: 'pair' | 'run' }>;
  /** RECORD ONLY: blocked nodes re-run by this revision. State advances
   *  through the `nodeRetryRequested` written in the same lock; replay never
   *  applies this list, reconciliation re-appends a lost retry from it. */
  retry?: Array<{ nodeId: string; instanceId?: string }>;
  /** RECORD ONLY: reassignments, applied by the `nodeReassigned` written in
   *  the same lock (reconciled the same way as `retry`). */
  assign?: Array<{ nodeId: string; from?: string; to: string }>;
}

/** Set when the main bot made the change on its own (`by: 'main_bot'`):
 *  a turn woken by this run's events, or another turn no message of the
 *  initiator opened (design §13.6). `reason` is the `--reason` the CLI
 *  requires in a wake turn; elsewhere it may fall back to the edit's note or
 *  be empty. */
export interface V3AutoProvenance {
  reason: string;
}

/** Why a checkpoint's dependants may go on (design §13.6):
 *  `wakeTurnEnded` — the main bot's turn for its wake-up ended (it may have
 *  changed the flow in it); `wakeNotDelivered` — the wake-up could not be
 *  delivered after its retries; `wakeSessionEnded` — the session that took
 *  the wake-up was closed, or its CLI stopped, before that turn was seen to
 *  end; `holdTimeout` — the safety cap on how long a checkpoint may hold its
 *  dependants ran out. */
export type V3CheckpointReleaseReason = 'wakeTurnEnded' | 'wakeNotDelivered' | 'wakeSessionEnded' | 'holdTimeout';

export type V3Event =
  | {
      type: 'runStarted';
      runId: string;
      /** Stamped by a runtime executing goal nodes through bot sessions. */
      nodeExecutor?: 'bot';
    }
  | {
      type: 'nodeDispatched';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      loop?: V3LoopRef;
      /** Present when the attempt is executed by an external bot session
       *  (`run.json` `nodeExecutor: "bot"`). Such attempts own no local worker
       *  process, so they never enter the worker attempt ledger. */
      nodeExecutor?: 'bot';
      /** Flow revision the attempt was dispatched under. Absent = 1 (the
       *  approved DAG), so runs that never revised keep their exact bytes. */
      revision?: number;
    }
  | {
      /** A flow revision took effect (design §13.3). `dag-revisions/<NNN>.json`
       *  holds the full new DAG; every digest here is of the exact file bytes
       *  and replay fails closed on a mismatch. */
      type: 'dagRevised';
      revision: number;
      baseRevision: number;
      sha256: string;
      patchSha256: string;
      /** `dag-revisions/<NNN>.bots.json`: snapshots of bots the revision
       *  newly brought into the run (always initiator-confirmed). */
      botsSha256?: string;
      summary: string;
      /** Free-text note supplied with the edit (display only). */
      note?: string;
      /** Operator: the turn's open_id, or `main_bot` for a change the main
       *  bot made on its own in a turn this run's events woke. */
      by: string;
      /** Only with `by: 'main_bot'`: why it acted (design §13.6). */
      auto?: V3AutoProvenance;
      /** Present when the revision was a confirmed proposal. */
      approval?: { by: string; proposedBy: string };
      effects?: V3RevisionEffects;
    }
  | {
      /** A revision that needs the initiator's confirmation (design §13.5).
       *  Its files are already written; it takes effect only through a later
       *  `dagRevised` carrying `approval`. A pending wait lives in
       *  `waits/revisions/<NNN>.json`. */
      type: 'dagRevisionProposed';
      revision: number;
      baseRevision: number;
      sha256: string;
      patchSha256: string;
      botsSha256?: string;
      summary: string;
      note?: string;
      by: string;
      auto?: V3AutoProvenance;
      reasons: V3RevisionConfirmReason[];
      /** Existing nodes the proposal touches; they are not dispatched while
       *  it is pending (the rest of the run keeps going). */
      touched: string[];
      /** The pending proposal this one carries onto a direct revision that
       *  took effect first (same patch, same proposer, re-based): landing
       *  supersedes it, and its card and wait move here. */
      carriedFrom?: number;
    }
  | { type: 'dagRevisionApproved'; revision: number; by: string }
  | {
      type: 'dagRevisionRejected';
      revision: number;
      by: string;
      /** `stale` = the flow moved on (another revision took effect, or the
       *  proposal no longer applies to the current node states);
       *  `superseded` = a newer proposal replaced it; `runEnded` = the run
       *  left running/blocked before anyone decided. */
      reason: 'rejected' | 'stale' | 'superseded' | 'runEnded';
      detail?: string;
    }
  | {
      /** Durable intent written before any handoff message is sent. */
      type: 'nodeHandoffPrepared';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      targetLarkAppId: string;
      placement: V3ExternalPlacement;
      /** Flow revision the attempt was dispatched under (1 = approved DAG). */
      revision: number;
      idempotency: V3HandoffIdempotency;
      /** Engine clock (ms) at preparation; bounds same-key re-dispatch. */
      preparedAt: number;
    }
  | {
      type: 'nodeHandoffSent';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      handoffMessageId: string;
      nodeCardMessageId?: string;
      threadId?: string;
      sentAt: number;
      /** Absolute engine-clock deadline for the target bot to accept. */
      acceptDeadlineAt: number;
    }
  | {
      type: 'nodeHandoffAccepted';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      sessionId: string;
      acceptedAt: number;
      /** Absolute engine-clock deadline = acceptedAt + node timeoutSec. */
      deadlineAt: number;
      /** Main-topic placement only (design §5.5): the handoff entered the
       *  target session's queue — that session may be busy with another turn
       *  — and its own turn has not been seen to start. `deadlineAt` is then
       *  a backstop (queued past it, the node times out); the node's real
       *  deadline is set by `nodeHandoffStarted`. Absent everywhere else, so
       *  node-topic attempts keep their bytes. */
      startPending?: true;
    }
  | {
      /** Main-topic placement only: the handoff's own turn reached the CLI
       *  (its input was committed) after a `startPending` acceptance; the
       *  node timeout now counts from here. At most once per attempt. */
      type: 'nodeHandoffStarted';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      startedAt: number;
      /** Absolute engine-clock deadline = startedAt + node timeoutSec. */
      deadlineAt: number;
    }
  | {
      /** The bot's turn ended without a valid submission (display only). */
      type: 'nodeStalled';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      at: number;
    }
  | {
      type: 'nodeReassigned';
      nodeId: string;
      instanceId?: string;
      /** The open external attempt this reassignment closed, if any. */
      attemptId?: string;
      from: string;
      to: string;
      by: string;
      /** Main-bot provenance of an automatic change (design §13.6). */
      auto?: V3AutoProvenance;
    }
  | {
      type: 'hostInputPrepared';
      nodeId: string;
      instanceId: string;
      attemptId: string;
      executor: string;
      provider: string;
      inputRef: { path: string; sha256: string; bytes: number };
      inputHash: string;
      idempotencyKey: string;
      idempotencyTtlMs: number;
      approvalDigest: string;
    }
  | {
      type: 'hostEffectIntent';
      nodeId: string;
      instanceId: string;
      attemptId: string;
      executor: string;
      provider: string;
      inputRef: { path: string; sha256: string; bytes: number };
      inputHash: string;
      idempotencyKey: string;
      idempotencyTtlMs: number;
      approvalDigest: string;
    }
  | {
      type: 'hostEffectUncertain';
      nodeId: string;
      instanceId: string;
      attemptId: string;
      executor: string;
      reason:
        | 'ttlExpired'
        | 'inputUnrecoverable'
        | 'outputUnrecoverable'
        | 'definitionMismatch'
        | 'unknownProvider'
        | 'inputHashMismatch'
        | 'providerUncertain';
      errorCode: string;
    }
  | {
      type: 'hostEffectRetryDeferred';
      nodeId: string;
      instanceId: string;
      attemptId: string;
      retryCount: number;
      nextRetryAt: number;
      errorCode: string;
    }
  | {
      type: 'nodeWorkerFenceArmed';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
    }
  | {
      type: 'nodeSessionReady';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      sessionInfo: { sessionId: string; webPort?: number; viewToken?: string };
      ptyLogPath?: string;
    }
  | {
      type: 'nodeSucceeded';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      manifestPath: string;
      runtime?: V3RuntimeAttestation;
    }
  | {
      type: 'nodeFailed';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      errorClass: V3ErrorClass;
      errorCode?: string;
      message?: string;
      runtime?: V3RuntimeAttestation;
    }
  | {
      type: 'nodeBlocked';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      errorClass: V3ErrorClass;
      errorCode?: string;
      message?: string;
      runtime?: V3RuntimeAttestation;
      recovery?: V3BlockedRecovery;
      ask?: GoalAsk;
      revisitTo?: string;
    }
  | {
      type: 'nodeRetryRequested';
      nodeId: string;
      instanceId?: string;
      previousAttemptId: string;
      nextAttemptId: string;
      reason: 'blockedRetry';
      previousErrorClass?: V3ErrorClass;
      previousErrorCode?: string;
      resetGate?: boolean;
      answer?: { path: string; preview: string; by: string };
      /** Operator, when recorded: `main_bot` for a retry the main bot
       *  decided on its own (with `auto`), the caller's open_id for a human
       *  turn that gave a reason (with `note`). A retry recorded without a
       *  reason keeps the original shape (no `by`). */
      by?: string;
      auto?: V3AutoProvenance;
      /** The reason a human turn gave (`--reason`), display only. */
      note?: string;
    }
  | {
      /** A checkpoint node's success may now be followed by its dependants
       *  (design §13.6; until then they are not dispatched). Names the exact
       *  success: its attempt and journal position. Older readers skip it. */
      type: 'checkpointReleased';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      eventSeq: number;
      reason: V3CheckpointReleaseReason;
    }
  | {
      /** The node was handed to a human (design §13.6): a record only. The
       *  `nodeBlocked(HANDED_TO_HUMAN)` written right after it in the same
       *  lock closes the attempt; if a crash separates the two, the runtime
       *  writes that block on the next drive (never waiting for a deadline). */
      type: 'nodeHandedToHuman';
      nodeId: string;
      instanceId?: string;
      /** The attempt it was handed over on (open, or the latest closed one). */
      attemptId: string;
      reason: string;
      /** `main_bot`, or the initiator's open_id in their own turn. */
      by: string;
      /** The turn that decided it (audit). */
      turnId?: string;
    }
  | {
      type: 'gateDispatched';
      nodeId: string;
      instanceId?: string;
      waitId: string;
      hostApproval?: { attemptId: string; approvalDigest: string; inputHash: string };
    }
  | {
      type: 'gateResolved';
      nodeId: string;
      instanceId?: string;
      waitId: string;
      resolution: 'approved' | 'rejected';
      by: string;
      selected?: string;
      hostApproval?: { attemptId: string; approvalDigest: string; inputHash: string };
    }
  | {
      type: 'edgeResolved';
      from: string;
      to: string;
      fromInstanceId?: string;
      toInstanceId?: string;
      sourceAttemptId: string;
      active: boolean;
      detail?: string;
    }
  | {
      type: 'nodeSkipped';
      nodeId: string;
      reason: 'triggerRuleUnsatisfied';
      detail?: string;
    }
  | ({
      type: 'nodeCancelled';
      nodeId: string;
      instanceId?: string;
      attemptId?: string;
      detail?: string;
    } & (
      | { reason: 'earlyReleaseLoser'; byNodeId: string }
      | { reason: 'runCancelled'; cancelRequestId: string }
    ))
  | {
      type: 'nodeAttemptDrained';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      reason: 'terminalPeer' | 'obsoleteAttempt' | 'orphanRecovery' | 'runCancellation';
    }
  | {
      type: 'nodeRevisitRequested';
      nodeId: string;
      instanceId: string;
      attemptId: string;
      toNodeId: string;
      reason?: string;
      reasonPath?: string;
      sourceManifestPath?: string;
      targetPreviousManifestPath?: string;
    }
  | {
      type: 'nodeInstanceSuperseded';
      nodeId: string;
      instanceId: string;
      byNodeId: string;
      reason: 'refresh';
    }
  | {
      type: 'revisitBudgetGranted';
      sourceNodeId?: string;
      toNodeId?: string;
      by: string;
      reason?: string;
    }
  | { type: 'loopStarted'; loopId: string }
  | { type: 'loopIterationStarted'; loopId: string; iteration: number }
  | {
      type: 'loopIterationDecision';
      loopId: string;
      iteration: number;
      decision: 'exit' | 'continue' | 'exhausted';
      detail?: string;
    }
  | {
      type: 'loopIterationGranted';
      loopId: string;
      fromIteration: number;
      by?: string;
    }
  | {
      type: 'runCancelRequested';
      cancelRequestId: string;
      by: string;
      reason?: string;
    }
  | {
      type: 'runCancelled';
      cancelRequestId: string;
      by: string;
      uncertainHostEffects?: V3UncertainHostEffect[];
    }
  | { type: 'runSucceeded' }
  | {
      type: 'runFailed';
      failedNodeId?: string;
      reason?: V3RunFailureReason;
      detail?: string;
    }
  | { type: 'runBlocked'; blockedNodeId: string };

export type StoredEvent = V3Event & { ts: number };

export interface JournalMutation {
  readonly events: readonly StoredEvent[];
  append(event: V3Event, options?: { durable?: boolean }): StoredEvent;
}
