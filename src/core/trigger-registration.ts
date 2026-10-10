import * as idempotencyStore from '../services/idempotency-store.js';
import * as asyncTriggerStore from '../services/async-trigger-store.js';

/** Read durable evidence only. In particular, do not call the trigger-result
 * builder: that path can reconcile faults and mirror parked steer results. */
export function readTurnRegistration(
  ownerLarkAppId: string,
  sessionId: string,
  turnIdempotencyKey: string | null,
): { status: number; body: Record<string, unknown> } {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId)
    || typeof turnIdempotencyKey !== 'string' || !turnIdempotencyKey.trim()
    || turnIdempotencyKey.length > 200) {
    return { status: 400, body: { ok: false, errorCode: 'bad_request' } };
  }
  if (!ownerLarkAppId) {
    return { status: 503, body: { ok: false, errorCode: 'observation_unavailable' } };
  }
  try {
    const record = idempotencyStore.lookup(
      ownerLarkAppId, sessionId + '\0' + turnIdempotencyKey.trim(), 'turn',
    );
    // Missing includes forgotten and foreign records. It cannot prove that the
    // input never executed, even when there is no longer a session row.
    if (!record) return { status: 200, body: { ok: true, schemaVersion: 1, larkAppId: ownerLarkAppId, state: 'unknown', sessionId } };
    if (record.kind !== 'turn' || record.sessionId !== sessionId) throw new Error('identity mismatch');
    const persisted = asyncTriggerStore.lookupStrict(sessionId, record.triggerId);
    const result = persisted?.ownerLarkAppId === ownerLarkAppId ? persisted.result : undefined;
    return {
      status: 200,
      body: {
        ok: true, schemaVersion: 1, larkAppId: ownerLarkAppId, state: 'registered', sessionId,
        registration: {
          triggerId: record.triggerId, requestHash: record.requestHash, state: record.state,
          ownerBootId: record.ownerBootId, revision: record.revision,
          createdAt: record.createdAt, updatedAt: record.updatedAt,
        },
        inputCommitted: record.inputCommit
          ? { state: 'observed', ...record.inputCommit }
          : { state: 'unknown' },
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
    // Do not expose host paths or reinterpret corrupt/unreadable data as absent.
    return { status: 503, body: { ok: false, errorCode: 'observation_unavailable' } };
  }
}
