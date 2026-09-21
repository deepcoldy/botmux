import { createHash } from 'node:crypto';

import {
  DISPATCH_LAUNCH_ADMISSION_SCHEMA_VERSION,
  DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION,
  dispatchLaunchIdentityDigest,
  evaluateDispatchLaunchPolicy,
  resolveDispatchLaunchOverride,
  type DispatchLaunchFailure,
  type DispatchLaunchIdentityV1,
  type DispatchLaunchOperationV1,
  type DispatchLaunchPrepareRequestV1,
  type DispatchLaunchStartRequestV1,
} from './dispatch-launch-contract.js';
import type { DispatchLaunchAdmissionStore } from './dispatch-launch-admission-store.js';
import type { DispatchLaunchOperationStore } from './dispatch-launch-operation-store.js';

export const DISPATCH_LAUNCH_PROVIDER_IDEMPOTENCY_MS = 60 * 60_000;

export interface DispatchLaunchTargetConfig {
  larkAppId: string;
  cliId: string;
  model?: string;
  reasoningEffort?: import('../services/codex-reasoning-effort.js').CodexReasoningEffort;
  policy?: import('./dispatch-launch-contract.js').DispatchLaunchPolicyV1;
}

export interface DispatchLaunchTargetDependencies {
  target: DispatchLaunchTargetConfig;
  operationStore: DispatchLaunchOperationStore;
  admissionStore: DispatchLaunchAdmissionStore;
  now(): Date;
  resolveIdentity(): DispatchLaunchIdentityV1;
  resolveWorkingDir(chatId: string): Promise<string | undefined> | string | undefined;
  resolveChatType(chatId: string): Promise<'group' | 'p2p' | undefined>;
  capacityAvailable(): boolean;
  resolveSourceOpenId(chatId: string, sourceLarkAppId: string): Promise<string>;
  authorizeTalk(chatId: string, sourceOpenId: string, callerUnionId?: string): {
    allowed: boolean;
    reason: string;
    quotaKey?: string;
    grantChatId?: string;
  };
  consumeQuotaOnce(input: {
    receiptId: string;
    quotaKey: string;
    grantChatId?: string;
    sourceOpenId: string;
  }): Promise<{ allow: boolean }>;
  ensureRoot(input: {
    operation: DispatchLaunchOperationV1;
    providerUuid: string;
  }): Promise<string>;
  ensureSession(input: {
    operation: DispatchLaunchOperationV1;
    rootMessageId: string;
    sourceOpenId: string;
  }): Promise<{ sessionId: string }>;
  ensureWorker(input: {
    operation: DispatchLaunchOperationV1;
    rootMessageId: string;
    sessionId: string;
    sourceOpenId: string;
  }): Promise<{ kickoffTurnId: string; workerGeneration: number }>;
  cancelSession?(dispatchId: string, sessionId?: string): Promise<void>;
}

export type DispatchLaunchTargetResult =
  | { ok: true; operation: DispatchLaunchOperationV1 }
  | DispatchLaunchFailure;

type StartingOperation = Extract<DispatchLaunchOperationV1, { state: 'starting' }>;

function stableId(prefix: string, dispatchId: string): string {
  return `${prefix}_${createHash('sha256').update(dispatchId).digest('hex').slice(0, 32)}`;
}

function fail(errorCode: DispatchLaunchFailure['errorCode'], message: string): DispatchLaunchFailure {
  return { ok: false, errorCode, message };
}

function terminal(operation: DispatchLaunchOperationV1): boolean {
  return ['succeeded', 'failed', 'cancelled', 'delivery_unknown'].includes(operation.state);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Target-authoritative prepare/start state machine. External effects are injected for tests. */
export function createDispatchLaunchTargetCoordinator(deps: DispatchLaunchTargetDependencies) {
  const failOperation = (
    operation: DispatchLaunchOperationV1,
    errorCode: DispatchLaunchFailure['errorCode'],
  ): DispatchLaunchOperationV1 => {
    if (terminal(operation)) return operation;
    return deps.operationStore.transition({
      dispatchId: operation.dispatchId,
      expectedState: operation.state,
      next: { ...operation, state: errorCode === 'DELIVERY_UNKNOWN' ? 'delivery_unknown' : 'failed', errorCode, updatedAt: deps.now().toISOString() } as DispatchLaunchOperationV1,
    });
  };

  const prepare = async (request: DispatchLaunchPrepareRequestV1): Promise<DispatchLaunchTargetResult> => {
    if (request.targetLarkAppId !== deps.target.larkAppId) return fail('BAD_REQUEST', 'target app id mismatch');
    if (Date.parse(request.expiresAt) <= deps.now().getTime()) return fail('OPERATION_EXPIRED', 'operation has expired');

    const existing = deps.operationStore.get(request.dispatchId);
    const initial: DispatchLaunchOperationV1 = {
      schemaVersion: DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION,
      dispatchId: request.dispatchId,
      owner: 'target',
      sourceLarkAppId: request.source.larkAppId,
      sourceSessionId: request.source.sessionId,
      sourceTurnId: request.source.turnId,
      ...(request.source.callerUnionId ? { callerUnionId: request.source.callerUnionId } : {}),
      targetLarkAppId: request.targetLarkAppId,
      chatId: request.chatId,
      kickoff: request.kickoff,
      requestedOverride: request.requestedOverride,
      createdAt: existing?.createdAt ?? deps.now().toISOString(),
      updatedAt: deps.now().toISOString(),
      expiresAt: request.expiresAt,
      state: 'preparing',
    };
    const created = deps.operationStore.create(initial).operation;
    if (created.state === 'prepared' || created.state === 'starting' || created.state === 'awaiting_proof' || terminal(created)) {
      return { ok: true, operation: created };
    }

    const resolved = resolveDispatchLaunchOverride({
      cliId: deps.target.cliId, requested: request.requestedOverride,
      targetModel: deps.target.model, targetReasoningEffort: deps.target.reasoningEffort,
    });
    if (!resolved.ok) { failOperation(created, resolved.errorCode); return resolved; }
    const policy = evaluateDispatchLaunchPolicy({
      policy: deps.target.policy, sourceLarkAppId: request.source.larkAppId, effective: resolved.effective,
    });
    if (!policy.ok) { failOperation(created, policy.errorCode); return policy; }
    let identity: DispatchLaunchIdentityV1;
    try { identity = deps.resolveIdentity(); }
    catch (error) { failOperation(created, 'UNSUPPORTED_HARNESS'); return fail('UNSUPPORTED_HARNESS', error instanceof Error ? error.message : String(error)); }
    if (identity.policyDigest !== policy.policyDigest) {
      failOperation(created, 'POLICY_CHANGED');
      return fail('POLICY_CHANGED', 'resolved launch identity does not match target policy');
    }

    const existingAdmission = deps.admissionStore.get(request.dispatchId);
    if (created.state === 'preparing' && existingAdmission) {
      if (existingAdmission.state === 'authorized') {
        const receipt = existingAdmission;
        const receiptMatches = receipt.sourceLarkAppId === request.source.larkAppId
          && receipt.sourceSessionId === request.source.sessionId
          && receipt.sourceTurnId === request.source.turnId
          && receipt.callerUnionId === request.source.callerUnionId
          && typeof receipt.sourceOpenId === 'string'
          && (receipt.chatType === 'group' || receipt.chatType === 'p2p')
          && typeof receipt.talkReason === 'string'
          && typeof receipt.workingDir === 'string' && receipt.workingDir.length > 0
          && receipt.chatId === request.chatId
          && receipt.targetLarkAppId === request.targetLarkAppId
          && receipt.policyDigest === policy.policyDigest
          && sameJson(receipt.effectiveOverride, resolved.effective)
          && sameJson(receipt.launchIdentity, identity);
        if (!receiptMatches) {
          failOperation(created, 'OPERATION_CONFLICT');
          return fail('OPERATION_CONFLICT', 'admission receipt does not match the prepared launch authority');
        }
        const prepared = deps.operationStore.transition({
          dispatchId: request.dispatchId, expectedState: 'preparing',
          next: { ...created, state: 'prepared', effectiveOverride: resolved.effective, launchIdentity: identity, updatedAt: deps.now().toISOString() },
        });
        return { ok: true, operation: prepared };
      }
      failOperation(created, 'OPERATION_CONFLICT');
      return fail('OPERATION_CONFLICT', `admission receipt is already ${existingAdmission.state}`);
    }

    if (!deps.capacityAvailable()) {
      failOperation(created, 'CAPACITY_UNAVAILABLE');
      return fail('CAPACITY_UNAVAILABLE', 'target has no launch capacity');
    }
    const workingDir = await deps.resolveWorkingDir(request.chatId);
    if (!workingDir) { failOperation(created, 'WORKDIR_REQUIRED'); return fail('WORKDIR_REQUIRED', 'target has no concrete working directory'); }
    const chatType = await deps.resolveChatType(request.chatId);
    if (!chatType) { failOperation(created, 'TARGET_CHAT_UNSUPPORTED'); return fail('TARGET_CHAT_UNSUPPORTED', 'target chat type cannot be confirmed'); }

    let sourceOpenId: string;
    try { sourceOpenId = await deps.resolveSourceOpenId(request.chatId, request.source.larkAppId); }
    catch { failOperation(created, 'TARGET_NOT_IN_CHAT'); return fail('TARGET_NOT_IN_CHAT', 'source identity cannot be bound in target chat'); }
    const talk = deps.authorizeTalk(request.chatId, sourceOpenId);
    if (!talk.allowed) { failOperation(created, 'UNAUTHORIZED_SOURCE'); return fail('UNAUTHORIZED_SOURCE', 'source bot is not allowed to talk to target'); }

    deps.admissionStore.authorize({
      schemaVersion: DISPATCH_LAUNCH_ADMISSION_SCHEMA_VERSION, dispatchId: request.dispatchId, state: 'authorized',
      sourceLarkAppId: request.source.larkAppId, sourceSessionId: request.source.sessionId,
      sourceTurnId: request.source.turnId, ...(request.source.callerUnionId ? { callerUnionId: request.source.callerUnionId } : {}),
      sourceOpenId, chatType, talkReason: talk.reason, ...(talk.quotaKey ? { quotaKey: talk.quotaKey } : {}),
      ...(talk.grantChatId ? { grantChatId: talk.grantChatId } : {}), chatId: request.chatId,
      targetLarkAppId: request.targetLarkAppId, policyDigest: policy.policyDigest,
      effectiveOverride: resolved.effective, launchIdentity: identity,
      talkAuthorizationReceiptId: stableId('talk', request.dispatchId),
      quotaReceiptId: stableId('quota', request.dispatchId), workingDir,
      capacityReservationId: stableId('capacity', request.dispatchId),
      createdAt: existingAdmission?.createdAt ?? deps.now().toISOString(),
    });
    const prepared = deps.operationStore.transition({
      dispatchId: request.dispatchId, expectedState: ['created', 'preparing'],
      next: { ...created, state: 'prepared', effectiveOverride: resolved.effective, launchIdentity: identity, updatedAt: deps.now().toISOString() },
    });
    return { ok: true, operation: prepared };
  };

  const start = async (request: DispatchLaunchStartRequestV1): Promise<DispatchLaunchTargetResult> => {
    let operation = deps.operationStore.get(request.dispatchId);
    if (!operation) return fail('OPERATION_NOT_FOUND', 'operation does not exist');
    if (terminal(operation) || operation.state === 'awaiting_proof') return { ok: true, operation };
    if (operation.state !== 'prepared' && operation.state !== 'starting') return fail('OPERATION_CONFLICT', `operation is ${operation.state}`);
    if (Date.parse(operation.expiresAt) <= deps.now().getTime()) {
      operation = failOperation(operation, 'OPERATION_EXPIRED');
      return { ok: true, operation };
    }
    if (request.kickoffDigest !== operation.kickoff.digest
        || request.policyDigest !== operation.launchIdentity.policyDigest
        || request.launchIdentityDigest !== dispatchLaunchIdentityDigest(operation.launchIdentity)) {
      return fail('OPERATION_CONFLICT', 'start request does not match prepared operation');
    }
    let currentIdentity: DispatchLaunchIdentityV1;
    try { currentIdentity = deps.resolveIdentity(); } catch { return fail('LAUNCH_IDENTITY_CHANGED', 'target launch identity is unavailable'); }
    if (dispatchLaunchIdentityDigest(currentIdentity) !== request.launchIdentityDigest) {
      operation = failOperation(operation, currentIdentity.policyDigest === request.policyDigest ? 'LAUNCH_IDENTITY_CHANGED' : 'POLICY_CHANGED');
      return { ok: true, operation };
    }
    if (operation.state === 'prepared') {
      operation = deps.operationStore.transition({
        dispatchId: operation.dispatchId, expectedState: 'prepared',
        next: { ...operation, state: 'starting', updatedAt: deps.now().toISOString() },
      });
    }
    let starting = operation as StartingOperation;
    const admission = deps.admissionStore.get(starting.dispatchId);
    if (!admission || admission.state === 'released' || !admission.sourceOpenId) {
      operation = failOperation(starting, 'UNAUTHORIZED_SOURCE');
      return { ok: true, operation };
    }
    if (admission.state === 'authorized') {
      if (admission.quotaKey) {
        const quota = await deps.consumeQuotaOnce({
          receiptId: admission.quotaReceiptId, quotaKey: admission.quotaKey,
          grantChatId: admission.grantChatId, sourceOpenId: admission.sourceOpenId,
        });
        if (!quota.allow) {
          deps.admissionStore.release(starting.dispatchId, deps.now().toISOString());
          operation = failOperation(starting, 'UNAUTHORIZED_SOURCE');
          return { ok: true, operation };
        }
      }
      deps.admissionStore.commit(starting.dispatchId, deps.now().toISOString());
    }

    if (!starting.rootMessageId) {
      if (deps.now().getTime() - Date.parse(starting.updatedAt) >= DISPATCH_LAUNCH_PROVIDER_IDEMPOTENCY_MS) {
        operation = failOperation(starting, 'DELIVERY_UNKNOWN');
        return { ok: true, operation };
      }
      const rootMessageId = await deps.ensureRoot({ operation: starting, providerUuid: stableId('dl', starting.dispatchId) });
      starting = deps.operationStore.transition({
        dispatchId: starting.dispatchId, expectedState: 'starting',
        next: { ...starting, rootMessageId, updatedAt: deps.now().toISOString() },
      }) as StartingOperation;
    }
    const rootMessageId = starting.rootMessageId!;
    if (!starting.targetSessionId) {
      const session = await deps.ensureSession({ operation: starting, rootMessageId, sourceOpenId: admission.sourceOpenId });
      starting = deps.operationStore.transition({
        dispatchId: starting.dispatchId, expectedState: 'starting',
        next: { ...starting, targetSessionId: session.sessionId, updatedAt: deps.now().toISOString() },
      }) as StartingOperation;
    }
    if (!starting.kickoffTurnId || !starting.workerGeneration) {
      const worker = await deps.ensureWorker({
        operation: starting, rootMessageId, sessionId: starting.targetSessionId!, sourceOpenId: admission.sourceOpenId,
      });
      starting = deps.operationStore.transition({
        dispatchId: starting.dispatchId, expectedState: 'starting',
        next: { ...starting, kickoffTurnId: worker.kickoffTurnId, workerGeneration: worker.workerGeneration, updatedAt: deps.now().toISOString() },
      }) as StartingOperation;
    }
    operation = deps.operationStore.transition({
      dispatchId: starting.dispatchId, expectedState: 'starting',
      next: { ...starting, state: 'awaiting_proof', updatedAt: deps.now().toISOString() } as DispatchLaunchOperationV1,
    });
    return { ok: true, operation };
  };

  const cancel = async (dispatchId: string): Promise<DispatchLaunchTargetResult> => {
    const operation = deps.operationStore.get(dispatchId);
    if (!operation) return fail('OPERATION_NOT_FOUND', 'operation does not exist');
    if (terminal(operation)) return { ok: true, operation };
    if (operation.state === 'awaiting_proof') {
      if (deps.cancelSession) await deps.cancelSession(dispatchId, operation.targetSessionId);
      const cancelled = deps.operationStore.transition({
        dispatchId, expectedState: 'awaiting_proof',
        next: { ...operation, state: 'cancelled', errorCode: 'CANCELLED', updatedAt: deps.now().toISOString() },
      });
      return { ok: true, operation: cancelled };
    }
    const admission = deps.admissionStore.get(dispatchId);
    if (admission?.state === 'authorized') deps.admissionStore.release(dispatchId, deps.now().toISOString());
    if (operation.state === 'starting' && deps.cancelSession) {
      await deps.cancelSession(dispatchId, operation.targetSessionId);
    }
    const cancelled = deps.operationStore.transition({
      dispatchId, expectedState: operation.state,
      next: { ...operation, state: 'cancelled', errorCode: 'CANCELLED', updatedAt: deps.now().toISOString() } as DispatchLaunchOperationV1,
    });
    return { ok: true, operation: cancelled };
  };

  return { prepare, start, cancel, query: (dispatchId: string) => deps.operationStore.get(dispatchId) };
}

export type DispatchLaunchTargetCoordinator = ReturnType<typeof createDispatchLaunchTargetCoordinator>;
