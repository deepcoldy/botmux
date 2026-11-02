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
    }
  | {
      type: 'nodeFailed';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      errorClass: V3ErrorClass;
      errorCode?: string;
      message?: string;
    }
  | {
      type: 'nodeBlocked';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      errorClass: V3ErrorClass;
      errorCode?: string;
      message?: string;
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
