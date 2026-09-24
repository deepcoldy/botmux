import type { DaemonSession } from './types.js';
import { activeSessionKey } from './types.js';

export interface PrincipalLaneTurnBinding {
  readonly larkAppId: string;
  readonly sourceSessionId: string;
  readonly laneId: string;
  readonly sessionId: string;
  readonly principalKey: string;
  readonly runtimeKey: string;
  readonly turnId: string;
  readonly inboundMessageId: string;
  readonly workerGeneration: number;
}

const bindings = new WeakMap<DaemonSession, Map<string, PrincipalLaneTurnBinding>>();

export function freezePrincipalLaneTurnBinding(
  ds: DaemonSession,
  turnId: string,
  workerGeneration: number,
  inboundMessageId = turnId,
): PrincipalLaneTurnBinding | undefined {
  const lane = ds.session.principalLane;
  if (!lane) return undefined;
  if (!Number.isSafeInteger(workerGeneration) || workerGeneration < 1
      || ds.workerGeneration !== workerGeneration
      || ds.session.workerGeneration !== workerGeneration) {
    throw new Error('principal-lane worker generation is not current');
  }
  const binding = Object.freeze({
    larkAppId: ds.larkAppId,
    sourceSessionId: lane.sourceSessionId,
    laneId: lane.laneId,
    sessionId: ds.session.sessionId,
    principalKey: lane.principalKey,
    runtimeKey: activeSessionKey(ds),
    turnId,
    inboundMessageId,
    workerGeneration,
  });
  const byTurn = bindings.get(ds) ?? new Map<string, PrincipalLaneTurnBinding>();
  const existing = byTurn.get(turnId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(binding)) {
    throw new Error('principal-lane turn identity changed');
  }
  byTurn.set(turnId, existing ?? binding);
  bindings.set(ds, byTurn);
  return existing ?? binding;
}

export function readPrincipalLaneTurnBinding(
  ds: DaemonSession,
  turnId: string,
): PrincipalLaneTurnBinding | undefined {
  const binding = bindings.get(ds)?.get(turnId);
  const lane = ds.session.principalLane;
  if (!binding || !lane) return undefined;
  return binding.larkAppId === ds.larkAppId
    && binding.sourceSessionId === lane.sourceSessionId
    && binding.laneId === lane.laneId
    && binding.sessionId === ds.session.sessionId
    && binding.principalKey === lane.principalKey
    && binding.runtimeKey === activeSessionKey(ds)
    && binding.workerGeneration === ds.workerGeneration
    && binding.workerGeneration === ds.session.workerGeneration
    ? binding
    : undefined;
}
