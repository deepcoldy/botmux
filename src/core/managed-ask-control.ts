import type { ExplicitAskControl, ExplicitAskReceipt, ExplicitAskRetirement } from './explicit-ask-continuation.js';
import type { PendingAsk } from './ask-types.js';

export function parseManagedAskControl(body: unknown, action: 'describe' | 'inspect' | 'retire' | 'release'): ExplicitAskRetirement {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Buffer.byteLength(JSON.stringify(body)) > 16384) throw new Error('invalid managed Ask control');
  const value = body as Record<string, unknown>;
  const origin = value.origin as Record<string, unknown> | undefined;
  const keys = ['larkAppId', 'sessionId', 'requestId', 'chatId', 'rootMessageId',
    ...(action === 'describe' ? [] : ['origin']),
    ...(action === 'inspect' || action === 'describe' ? [] : ['operationId', 'reason'])];
  if (Object.keys(value).some(key => !keys.includes(key))
    || ['larkAppId', 'sessionId', 'requestId', 'chatId'].some(key => typeof value[key] !== 'string' || !value[key])
    || !(value.rootMessageId === null || typeof value.rootMessageId === 'string' && value.rootMessageId.length > 0)
    || action !== 'describe' && (!origin || typeof origin !== 'object' || Array.isArray(origin)
    || typeof origin.turnId !== 'string' || !origin.turnId
    || !Number.isSafeInteger(origin.workerGeneration) || Number(origin.workerGeneration) < 0
    || origin.dispatchAttempt !== undefined && (!Number.isSafeInteger(origin.dispatchAttempt) || Number(origin.dispatchAttempt) < 0)
    || Object.keys(origin).some(key => !['turnId', 'workerGeneration', 'dispatchAttempt'].includes(key)))
    || action !== 'inspect' && action !== 'describe' && ['operationId', 'reason'].some(key => typeof value[key] !== 'string' || !value[key])) {
    throw new Error('invalid managed Ask control');
  }
  return value as unknown as ExplicitAskRetirement;
}

export interface ManagedAskSession {
  larkAppId: string;
  chatId: string;
  rootMessageId: string | null;
  workerGeneration?: number;
  workerAlive: boolean;
  turnId?: string;
  safeToSuspend: boolean;
  resourceOwned: boolean;
  suspensionConfirmed?: boolean;
  terminatedTurnIds?: ReadonlyArray<string>;
}

export function createManagedAskControl(deps: {
  appId: string;
  inspect: (request: ExplicitAskControl) => ExplicitAskReceipt;
  describe?: (request: Omit<ExplicitAskControl, 'origin'>) => ExplicitAskReceipt;
  retire: (request: ExplicitAskRetirement) => ExplicitAskReceipt;
  snapshot: (receipt: ExplicitAskReceipt) => PendingAsk | undefined;
  session: (sessionId: string) => ManagedAskSession | undefined;
  suspend: (sessionId: string, stillOwned: () => boolean) => Promise<boolean>;
}) {
  const releasing = new Set<string>();
  function bound(request: Omit<ExplicitAskControl, 'origin'>) {
    const session = deps.session(request.sessionId);
    if (request.larkAppId !== deps.appId || !session
      || session.larkAppId !== request.larkAppId || session.chatId !== request.chatId
      || session.rootMessageId !== request.rootMessageId) throw new Error('managed Ask binding conflict');
  }
  function validate(request: ExplicitAskControl): ExplicitAskReceipt {
    bound(request);
    return deps.inspect(request);
  }
  function result(request: ExplicitAskControl, receipt: ExplicitAskReceipt, status: string) {
    const card = deps.snapshot(receipt) ?? receipt.card;
    return { status, sessionId: request.sessionId, requestId: request.requestId, questions: receipt.input.questions,
      answererOpenId: receipt.input.answererOpenId,
      ...(receipt.result ? { result: receipt.result } : {}),
      ...(receipt.retirement ? { operationId: receipt.retirement.operationId } : {}),
      ...(receipt.origin ? { origin: receipt.origin } : {}),
      ...(card ? { askId: card.askId, cardMessageId: card.cardMessageId, cardDeliveredAt: card.cardDeliveredAt } : {}) };
  }
  function inspect(request: ExplicitAskControl) {
    const receipt = validate(request);
    return result(request, receipt, receipt.result?.kind === 'answered' ? 'answered'
      : receipt.retirement ? 'retired' : receipt.result ? 'invalidated' : 'waiting');
  }
  function describe(request: ExplicitAskControl) {
    bound(request);
    if (!deps.describe) throw new Error('managed Ask discovery unavailable');
    const receipt = deps.describe(request);
    return result(request, receipt, receipt.result?.kind === 'answered' ? 'answered'
      : receipt.retirement ? 'retired' : receipt.result ? 'invalidated' : 'waiting');
  }
  async function retire(request: ExplicitAskRetirement) {
    const receipt = validate(request);
    if (receipt.result?.kind === 'answered') return result(request, receipt, 'answered');
    const session = deps.session(request.sessionId)!;
    if (session.workerGeneration !== request.origin.workerGeneration
      || (session.workerAlive && session.turnId !== request.origin.turnId)
      || !session.resourceOwned) return result(request, receipt, 'conflict');
    const retired = deps.retire(request);
    return result(request, retired, retired.result?.kind === 'answered' ? 'answered' : 'draining');
  }
  async function release(request: ExplicitAskRetirement) {
    const receipt = validate(request);
    if (receipt.result?.kind === 'answered') return result(request, receipt, 'answered');
    if (!receipt.retirement || receipt.retirement.operationId !== request.operationId
      || receipt.retirement.reason !== request.reason || receipt.result?.kind !== 'invalidated') {
      throw new Error('managed Ask retirement conflict');
    }
    const session = deps.session(request.sessionId)!;
    if (session.workerGeneration !== request.origin.workerGeneration || !session.resourceOwned
      || (session.workerAlive && session.turnId !== request.origin.turnId
        && !(session.turnId === undefined && session.terminatedTurnIds?.includes(request.origin.turnId)))) {
      return result(request, receipt, 'conflict');
    }
    if (!session.workerAlive) return result(request, receipt, session.suspensionConfirmed ? 'suspended' : 'unknown');
    const stillOwned = () => {
      const current = deps.session(request.sessionId);
      return !!current && current.larkAppId === request.larkAppId && current.chatId === request.chatId
        && current.rootMessageId === request.rootMessageId && current.workerGeneration === request.origin.workerGeneration
        && current.workerAlive && current.resourceOwned && current.safeToSuspend
        && current.terminatedTurnIds?.includes(request.origin.turnId) === true
        && (current.turnId === undefined || current.turnId === request.origin.turnId);
    };
    if (!stillOwned() || releasing.has(request.sessionId)) return result(request, receipt, 'draining');
    releasing.add(request.sessionId);
    try {
      const confirmed = await deps.suspend(request.sessionId, stillOwned);
      return result(request, receipt, confirmed ? 'suspended' : 'unknown');
    } finally { releasing.delete(request.sessionId); }
  }
  return { describe, inspect, retire, release };
}
