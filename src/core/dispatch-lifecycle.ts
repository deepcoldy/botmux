import { join } from 'node:path';
import { updateDispatchRegistry } from './dispatch-registry.js';

export type DispatchLifecycleStatus = 'dispatched' | 'accepted' | 'failed' | 'timed_out';
export type DispatchTransportState = 'dispatched' | 'failed';
export type DispatchAcceptanceState = 'requested' | 'not_requested' | 'accepted' | 'failed' | 'timed_out';

export interface DispatchLifecycleUpdate {
  dataDir: string;
  dispatchRoot: string;
  sourceSessionId: string;
  status: DispatchLifecycleStatus;
  transportState: DispatchTransportState;
  acceptanceState: DispatchAcceptanceState;
  errorCode?: string | null;
  acceptedBotAppIds?: readonly string[];
  missingBotAppIds?: readonly string[];
  now?: string;
}

export interface DispatchReceiptState {
  transportState: DispatchTransportState;
  acceptanceState: DispatchAcceptanceState;
  errorCode: string | null;
}

export function dispatchReceiptState(input: Pick<DispatchLifecycleUpdate,
  'transportState' | 'acceptanceState' | 'errorCode'>): DispatchReceiptState {
  return {
    transportState: input.transportState,
    acceptanceState: input.acceptanceState,
    errorCode: input.errorCode ?? null,
  };
}

export function initialDispatchLifecycle(acceptanceRequested: boolean): {
  status: 'dispatched';
  transportState: 'dispatched';
  acceptanceState: 'requested' | 'not_requested';
  errorCode: null;
} {
  return {
    status: 'dispatched',
    transportState: 'dispatched',
    acceptanceState: acceptanceRequested ? 'requested' : 'not_requested',
    errorCode: null,
  };
}

function validateLifecycle(input: DispatchLifecycleUpdate): void {
  if (input.status === 'failed' && input.transportState !== 'failed') {
    throw new Error('failed dispatch lifecycle requires failed transport');
  }
  if (input.status !== 'failed' && input.transportState !== 'dispatched') {
    throw new Error(`${input.status} dispatch lifecycle requires dispatched transport`);
  }
  if (input.status === 'accepted' && input.acceptanceState !== 'accepted') {
    throw new Error('accepted dispatch lifecycle requires accepted acceptance state');
  }
  if (input.status === 'timed_out' && input.acceptanceState !== 'timed_out') {
    throw new Error('timed_out dispatch lifecycle requires timed_out acceptance state');
  }
  if (input.status === 'failed' && input.acceptanceState !== 'failed') {
    throw new Error('failed dispatch lifecycle requires failed acceptance state');
  }
  if (input.status === 'dispatched'
    && input.acceptanceState !== 'requested'
    && input.acceptanceState !== 'not_requested') {
    throw new Error('dispatched lifecycle requires requested or not_requested acceptance state');
  }
}

/** Persist one internally-consistent handoff state for dashboard/control-plane readers. */
export async function persistDispatchLifecycle(input: DispatchLifecycleUpdate): Promise<DispatchReceiptState> {
  validateLifecycle(input);
  await updateDispatchRegistry(join(input.dataDir, 'orchestrate-dispatch.json'), registry => {
    const raw = registry[input.dispatchRoot];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const entry = raw as Record<string, unknown>;
    if (entry.orchSessionId !== input.sourceSessionId) return;
    const now = input.now ?? new Date().toISOString();
    entry.status = input.status;
    entry.transportState = input.transportState;
    entry.acceptanceState = input.acceptanceState;
    entry.errorCode = input.errorCode ?? null;
    if (input.acceptedBotAppIds) entry.acceptedBotAppIds = [...input.acceptedBotAppIds];
    if (input.missingBotAppIds) entry.missingBotAppIds = [...input.missingBotAppIds];
    if (input.status === 'accepted') entry.acceptedAt = now;
    if (input.status === 'failed' || input.status === 'timed_out') entry.failedAt = now;
    entry.updatedAt = now;
  });
  return dispatchReceiptState(input);
}
