import {
  DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION,
  DISPATCH_LAUNCH_SCHEMA_VERSION,
  dispatchLaunchIdentityDigest,
  parseDispatchLaunchOperation,
  type DispatchLaunchFailure,
  type DispatchLaunchOperationV1,
  type DispatchLaunchPrepareRequestV1,
} from './dispatch-launch-contract.js';
import type { DispatchLaunchOperationStore } from './dispatch-launch-operation-store.js';
import { requestDispatchLaunchIpc, type DispatchLaunchIpcResponse } from './dispatch-launch-ipc-client.js';
import type { OnlineDaemonInfo } from '../utils/daemon-discovery.js';

export interface DispatchLaunchSourceDependencies {
  sourceLarkAppId: string;
  store: DispatchLaunchOperationStore;
  targetDaemon: Pick<OnlineDaemonInfo, 'larkAppId' | 'ipcPort' | 'bootInstanceId' | 'dispatchLaunchIpcProtocol'>;
  now(): Date;
  request?(input: Parameters<typeof requestDispatchLaunchIpc>[0]): Promise<DispatchLaunchIpcResponse>;
}

function decodeResponse(response: DispatchLaunchIpcResponse):
  | { ok: true; operation: DispatchLaunchOperationV1 }
  | DispatchLaunchFailure {
  const raw = JSON.parse(response.bodyRaw) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid dispatch launch IPC response');
  const value = raw as Record<string, unknown>;
  if (value.ok === true) return { ok: true, operation: parseDispatchLaunchOperation(value.operation) };
  if (value.ok === false && typeof value.errorCode === 'string' && typeof value.message === 'string') {
    return value as unknown as DispatchLaunchFailure;
  }
  throw new Error('invalid dispatch launch IPC response');
}

/** Durable source-side driver. Transport errors intentionally leave a recoverable state. */
export interface DispatchLaunchSourceCoordinator {
  create(request: DispatchLaunchPrepareRequestV1): DispatchLaunchOperationV1;
  prepare(request: DispatchLaunchPrepareRequestV1): Promise<{ ok: true; operation: DispatchLaunchOperationV1 } | DispatchLaunchFailure>;
  start(dispatchId: string): Promise<{ ok: true; operation: DispatchLaunchOperationV1 } | DispatchLaunchFailure>;
  query(dispatchId: string): Promise<{ ok: true; operation: DispatchLaunchOperationV1 } | DispatchLaunchFailure>;
  recover(): Promise<void>;
}

export function createDispatchLaunchSourceCoordinator(deps: DispatchLaunchSourceDependencies): DispatchLaunchSourceCoordinator {
  const invoke = deps.request ?? requestDispatchLaunchIpc;
  const validateRequestAuthority = (request: DispatchLaunchPrepareRequestV1): void => {
    if (request.source.larkAppId !== deps.sourceLarkAppId) {
      throw new Error('dispatch launch source app id mismatch');
    }
    if (request.targetLarkAppId !== deps.targetDaemon.larkAppId) {
      throw new Error('dispatch launch target descriptor mismatch');
    }
    if (deps.targetDaemon.dispatchLaunchIpcProtocol !== 'v1' || !deps.targetDaemon.bootInstanceId) {
      throw new Error('dispatch launch target does not advertise IPC v1');
    }
  };
  const toSource = (target: DispatchLaunchOperationV1, current: DispatchLaunchOperationV1): DispatchLaunchOperationV1 => ({
    ...target, owner: 'source', createdAt: current.createdAt, updatedAt: deps.now().toISOString(),
  });
  const validatePeer = (target: DispatchLaunchOperationV1, source: DispatchLaunchOperationV1): void => {
    if (target.owner !== 'target' || target.dispatchId !== source.dispatchId
        || target.sourceLarkAppId !== source.sourceLarkAppId
        || target.sourceSessionId !== source.sourceSessionId
        || target.sourceTurnId !== source.sourceTurnId
        || target.targetLarkAppId !== source.targetLarkAppId
        || target.chatId !== source.chatId || target.kickoff.digest !== source.kickoff.digest) {
      throw new Error('target operation identity mismatch');
    }
  };
  const create = (request: DispatchLaunchPrepareRequestV1): DispatchLaunchOperationV1 => {
    validateRequestAuthority(request);
    return deps.store.create({
      schemaVersion: DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION, dispatchId: request.dispatchId, owner: 'source',
      sourceLarkAppId: request.source.larkAppId, sourceSessionId: request.source.sessionId,
      sourceTurnId: request.source.turnId, ...(request.source.callerUnionId ? { callerUnionId: request.source.callerUnionId } : {}),
      targetLarkAppId: request.targetLarkAppId, chatId: request.chatId, kickoff: request.kickoff,
      requestedOverride: request.requestedOverride, createdAt: deps.now().toISOString(),
      updatedAt: deps.now().toISOString(), expiresAt: request.expiresAt, state: 'created',
    }).operation;
  };

  const query = async (dispatchId: string) => {
    const source = deps.store.get(dispatchId);
    if (!source) return { ok: false as const, errorCode: 'OPERATION_NOT_FOUND' as const, message: 'operation does not exist' };
    if (source.targetLarkAppId !== deps.targetDaemon.larkAppId) {
      throw new Error('dispatch launch target descriptor mismatch');
    }
    const result = decodeResponse(await invoke({ daemon: deps.targetDaemon, dispatchId }));
    if (result.ok) validatePeer(result.operation, source);
    return result;
  };

  const prepare = async (request: DispatchLaunchPrepareRequestV1) => {
    let operation = create(request);
    if (operation.state === 'created') operation = deps.store.transition({
      dispatchId: operation.dispatchId, expectedState: 'created',
      next: { ...operation, state: 'preparing', updatedAt: deps.now().toISOString() },
    });
    if (operation.state !== 'preparing') return { ok: true as const, operation };
    const result = decodeResponse(await invoke({ daemon: deps.targetDaemon, dispatchId: request.dispatchId, action: 'prepare', body: request }));
    if (!result.ok) {
      deps.store.transition({
        dispatchId: operation.dispatchId, expectedState: 'preparing',
        next: { ...operation, state: 'failed', errorCode: result.errorCode, updatedAt: deps.now().toISOString() },
      });
      return result;
    }
    validatePeer(result.operation, operation);
    if (result.operation.state !== 'prepared') throw new Error(`target prepare returned ${result.operation.state}`);
    return { ok: true as const, operation: deps.store.transition({
      dispatchId: operation.dispatchId, expectedState: 'preparing', next: toSource(result.operation, operation),
    }) };
  };

  const start = async (dispatchId: string) => {
    let operation = deps.store.get(dispatchId);
    if (!operation) return { ok: false as const, errorCode: 'OPERATION_NOT_FOUND' as const, message: 'operation does not exist' };
    if (operation.state === 'awaiting_proof' || ['succeeded', 'failed', 'cancelled', 'delivery_unknown'].includes(operation.state)) {
      return { ok: true as const, operation };
    }
    if (operation.state !== 'prepared' && operation.state !== 'starting') {
      return { ok: false as const, errorCode: 'OPERATION_CONFLICT' as const, message: `operation is ${operation.state}` };
    }
    if (operation.targetLarkAppId !== deps.targetDaemon.larkAppId) {
      throw new Error('dispatch launch target descriptor mismatch');
    }
    let startable = operation as Extract<DispatchLaunchOperationV1, { state: 'prepared' | 'starting' }>;
    if (operation.state === 'prepared') operation = deps.store.transition({
      dispatchId, expectedState: 'prepared', next: { ...operation, state: 'starting', updatedAt: deps.now().toISOString() },
    });
    startable = operation as Extract<DispatchLaunchOperationV1, { state: 'prepared' | 'starting' }>;
    const result = decodeResponse(await invoke({
      daemon: deps.targetDaemon, dispatchId, action: 'start', body: {
        schemaVersion: DISPATCH_LAUNCH_SCHEMA_VERSION, protocol: 'v1', dispatchId,
        kickoffDigest: startable.kickoff.digest, policyDigest: startable.launchIdentity.policyDigest,
        launchIdentityDigest: dispatchLaunchIdentityDigest(startable.launchIdentity),
      },
    }));
    if (!result.ok) {
      deps.store.transition({
        dispatchId, expectedState: 'starting',
        next: { ...operation, state: 'failed', errorCode: result.errorCode, updatedAt: deps.now().toISOString() },
      });
      return result;
    }
    validatePeer(result.operation, operation);
    if (result.operation.state !== 'awaiting_proof' && !['failed', 'cancelled', 'delivery_unknown'].includes(result.operation.state)) {
      throw new Error(`target start returned ${result.operation.state}`);
    }
    return { ok: true as const, operation: deps.store.transition({
      dispatchId, expectedState: 'starting', next: toSource(result.operation, operation),
    }) };
  };

  const recover = async (): Promise<void> => {
    for (const operation of deps.store.listRecoverable()) {
      if (operation.state === 'created' || operation.state === 'preparing') {
        await prepare({
          schemaVersion: DISPATCH_LAUNCH_SCHEMA_VERSION, protocol: 'v1', dispatchId: operation.dispatchId,
          source: { larkAppId: operation.sourceLarkAppId, sessionId: operation.sourceSessionId, turnId: operation.sourceTurnId,
            ...(operation.callerUnionId ? { callerUnionId: operation.callerUnionId } : {}) },
          targetLarkAppId: operation.targetLarkAppId, chatId: operation.chatId, kickoff: operation.kickoff,
          requestedOverride: operation.requestedOverride, expiresAt: operation.expiresAt,
        });
      } else if (operation.state === 'prepared' || operation.state === 'starting') {
        await start(operation.dispatchId);
      }
    }
  };
  return { create, prepare, start, query, recover };
}
