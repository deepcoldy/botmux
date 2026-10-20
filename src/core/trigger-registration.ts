import * as idempotencyStore from '../services/idempotency-store.js';
import * as asyncTriggerStore from '../services/async-trigger-store.js';
import { routedTurnTarget, routedTurnKey } from '../services/trigger-types.js';

type Route = { chatId: string; rootMessageId?: string };
const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id);

/** Read the retained native registration without reconciling or dispatching. */
function readRegistration(ownerLarkAppId: string, target: string | Route, key: string | null) {
  const route = typeof target === 'string' ? undefined : routedTurnTarget(target, { topicMessage: null });
  if ((typeof target === 'string' ? !validId(target) : !route)
    || typeof key !== 'string' || !key.trim() || key.length > 200) {
    return { status: 400, body: { ok: false, errorCode: 'bad_request' } };
  }
  if (!ownerLarkAppId) return { status: 503, body: { ok: false, errorCode: 'observation_unavailable' } };
  try {
    const kind = route ? 'routed_turn' : 'turn';
    const record = idempotencyStore.lookup(ownerLarkAppId,
      route ? routedTurnKey(route, key) : target + '\0' + key.trim(), kind);
    const identity = route ? { target: route } : { sessionId: target };
    // Forgotten, foreign, and missing records never prove non-execution.
    if (!record) return { status: 200, body: { ok: true, schemaVersion: 1, larkAppId: ownerLarkAppId, state: 'unknown', ...identity } };
    if (record.ownerLarkAppId !== ownerLarkAppId || record.kind !== kind || (!route && record.sessionId !== target)) throw Error('identity mismatch');
    const sessionId = record.sessionId;
    const persisted = asyncTriggerStore.lookupStrict(sessionId, record.triggerId);
    const result = persisted?.ownerLarkAppId === ownerLarkAppId ? persisted.result : undefined;
    // The receiver-owned async record survives worker/daemon replacement. A
    // queued successor may receive its first input ACK only after that restart,
    // when the old process-local idempotency binding is no longer present.
    // Read its original durable ACK rather than requiring a second mirror write.
    if (result?.inputCommit && record.inputCommit
      && result.inputCommit.workerGeneration !== record.inputCommit.workerGeneration) {
      throw Error('original_input_commit_conflict');
    }
    const inputCommit = record.state === 'attempting' ? result?.inputCommit ?? record.inputCommit : undefined;
    return {
      status: 200,
      body: {
        ok: true, schemaVersion: 1, larkAppId: ownerLarkAppId, state: 'registered', ...identity, sessionId,
        registration: {
          triggerId: record.triggerId, requestHash: record.requestHash, state: record.state,
          ownerBootId: record.ownerBootId, revision: record.revision,
          createdAt: record.createdAt, updatedAt: record.updatedAt,
        },
        inputCommitted: inputCommit ? { state: 'observed', ...inputCommit } : { state: 'unknown' },
        executionStarted: result?.executionStarted ? {state:'observed',...result.executionStarted} : {state:'unknown'},
        result: result ? {
          state: result.status,
          ...(result.completedAt !== undefined ? { completedAt: result.completedAt } : {}),
          ...(result.failedAt !== undefined ? { failedAt: result.failedAt } : {}),
          ...(result.interruptedAt !== undefined ? { interruptedAt: result.interruptedAt } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.terminalErrorCode ? { terminalErrorCode: result.terminalErrorCode } : {}),
          ...(result.steerParkedBy ? { steerParkedBy: result.steerParkedBy } : {}),
        } : { state: 'unknown' },
        resultRef: '/api/sessions/' + encodeURIComponent(sessionId)
          + '/trigger-result?triggerId=' + encodeURIComponent(record.triggerId),
      },
    };
  } catch {
    return { status: 503, body: { ok: false, errorCode: 'observation_unavailable' } };
  }
}
export function readTurnRegistration(owner: string, sessionId: string, key: string | null) {
  return readRegistration(owner, sessionId, key);
}
export function readRoutedTurnRegistration(owner: string, target: Route, key: string | null) {
  return readRegistration(owner, target, key);
}
