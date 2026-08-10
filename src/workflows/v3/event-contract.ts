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
  | 'resultInvalid'
  | 'timeout'
  | 'gateRejected'
  | 'cancelled';

export type V3RunFailureReason = 'allSinksSkipped';

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

export type V3Event =
  | { type: 'runStarted'; runId: string }
  | {
      type: 'nodeDispatched';
      nodeId: string;
      instanceId?: string;
      attemptId: string;
      loop?: V3LoopRef;
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
      sessionInfo: { sessionId: string; webPort?: number };
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
