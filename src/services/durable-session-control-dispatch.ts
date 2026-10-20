import type {
  DurableControlOperationRecord,
  DurableCoordinationStore,
  DurableJson,
} from './durable-coordination.js';
import type { DurableLarkSessionControlClaim } from './durable-lark-session-control.js';
import type {
  DurableSessionControlDispatchContext,
  DurableSessionControlDispatchResult,
} from './durable-session-control-consumer.js';

export type DurableSessionControlEffectResult =
  | { kind: 'completed'; result: DurableJson }
  | { kind: 'not_applied'; error: string }
  | { kind: 'ambiguous'; error: string };

export type DurableSessionControlReconcileResult =
  | { kind: 'completed'; result: DurableJson; evidence: DurableJson }
  | { kind: 'not_applied'; error: string; evidence: DurableJson }
  | { kind: 'unknown'; error: string };

export interface DurableSessionControlTarget {
  sessionKey: string;
  operationPayload: DurableJson;
  execute(signal: AbortSignal): Promise<DurableSessionControlEffectResult>;
  reconcile(signal: AbortSignal): Promise<DurableSessionControlReconcileResult>;
  /**
   * 把 completed result 投影到 canonical Session，并持久化任何用户可见输出。
   * 它必须幂等；只有返回后 Inbox 才会 complete。
   */
  commit(result: DurableJson, signal: AbortSignal): Promise<void>;
}

export type DurableSessionControlResolution =
  | { kind: 'target'; target: DurableSessionControlTarget }
  | { kind: 'ignored'; reason: string };

export interface DurableSessionControlDispatchOptions {
  store: DurableCoordinationStore;
  /** 必须与 canonical Session facade 使用同一个 boot-unique owner id。 */
  sessionOwnerId: string;
  resolve(
    control: DurableLarkSessionControlClaim,
    context: DurableSessionControlDispatchContext,
  ): Promise<DurableSessionControlResolution>;
  sessionLeaseDurationMs?: number;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('durable session control lost inbox ownership');
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim().slice(0, 2_048) || 'control effect failed with an unknown outcome';
}

/**
 * 将 owner-routed Inbox claim 与稳定 control operation 状态机连接起来。
 *
 * resolve 完成权限、目标和所有本地 preflight；beginControlOperationAttempt 是唯一
 * 副作用边界。operation completed 但 canonical commit 未完成时，后续 owner 只重做
 * commit，不会重放 provider effect。ambiguous 必须先通过 target.reconcile 对账。
 */
export function createDurableSessionControlDispatch(
  options: DurableSessionControlDispatchOptions,
): (
  control: DurableLarkSessionControlClaim,
  context: DurableSessionControlDispatchContext,
) => Promise<DurableSessionControlDispatchResult> {
  const ownerId = options.sessionOwnerId.trim();
  if (!ownerId || ownerId.length > 256) {
    throw new Error('durable session control sessionOwnerId must be bounded non-empty text');
  }
  const leaseDurationMs = boundedInteger(
    options.sessionLeaseDurationMs ?? 60_000,
    'sessionLeaseDurationMs',
    1_000,
    300_000,
  );

  return async (control, context) => {
    if (context.signal.aborted) throw abortError(context.signal);
    const resolved = await options.resolve(control, context);
    if (context.signal.aborted) throw abortError(context.signal);
    if (resolved.kind === 'ignored') {
      const reason = resolved.reason.trim();
      if (!reason || reason.length > 512) {
        throw new Error('durable session control ignored result requires a bounded reason');
      }
      return { kind: 'ignored', reason };
    }
    const target = resolved.target;
    const acquired = await options.store.acquireSessionLease({
      sessionKey: target.sessionKey,
      ownerId,
      leaseDurationMs,
    });
    if (acquired.kind === 'occupied') {
      throw new Error(`durable session control Session is occupied by ${acquired.ownerId}`);
    }
    const inserted = await options.store.enqueueControlOperation({
      lease: acquired.lease,
      operation: {
        operationId: control.operationId,
        sessionKey: target.sessionKey,
        payload: target.operationPayload,
        createdAt: context.claim.event.createdAt,
      },
    });
    if (inserted.kind === 'conflict') {
      throw new Error(`durable session control operation conflict ${control.operationId}`);
    }
    if (inserted.kind === 'stale_lease') {
      throw new Error(`durable session control lost Session lease ${target.sessionKey}`);
    }

    let record = await options.store.readControlOperation(control.operationId);
    if (!record) throw new Error(`durable session control operation disappeared ${control.operationId}`);

    const reconcile = async (
      ambiguous: DurableControlOperationRecord,
    ): Promise<DurableControlOperationRecord> => {
      const reconciled = await target.reconcile(context.signal);
      if (context.signal.aborted) throw abortError(context.signal);
      if (reconciled.kind === 'unknown') throw new Error(reconciled.error);
      const mutation = await options.store.reconcileControlOperation({
        lease: acquired.lease,
        operationId: control.operationId,
        expectedAttempt: ambiguous.attempts,
        outcome: reconciled.kind === 'completed'
          ? {
              kind: 'completed',
              result: reconciled.result,
              evidence: reconciled.evidence,
            }
          : {
              kind: 'not_applied',
              error: reconciled.error,
              evidence: reconciled.evidence,
            },
      });
      if (mutation.kind !== 'applied') {
        throw new Error(`durable session control reconciliation lost ${control.operationId}`);
      }
      if (mutation.record.state === 'pending') {
        throw new Error('durable session control backend proved not-applied; retrying safely');
      }
      return mutation.record;
    };

    if (record.state === 'ambiguous') record = await reconcile(record);
    if (record.state === 'pending') {
      const begun = await options.store.beginControlOperationAttempt({
        lease: acquired.lease,
        operationId: control.operationId,
      });
      if (begun.kind === 'not_pending') {
        record = begun.record.state === 'ambiguous'
          ? await reconcile(begun.record)
          : begun.record;
      } else if (begun.kind !== 'applied') {
        throw new Error(`durable session control could not begin ${control.operationId}: ${begun.kind}`);
      } else {
        let effect: DurableSessionControlEffectResult;
        try {
          effect = await target.execute(context.signal);
        } catch (error) {
          await options.store.markControlOperationAmbiguous({
            attempt: begun.attempt,
            error: errorText(error),
          });
          throw error;
        }
        if (effect.kind === 'not_applied') {
          const retried = await options.store.retryControlOperationAttempt({
            attempt: begun.attempt,
            error: effect.error,
          });
          if (retried.kind !== 'applied') {
            throw new Error(`durable session control safe retry lost ${control.operationId}`);
          }
          throw new Error(effect.error);
        }
        if (effect.kind === 'ambiguous') {
          const ambiguous = await options.store.markControlOperationAmbiguous({
            attempt: begun.attempt,
            error: effect.error,
          });
          if (ambiguous.kind !== 'applied') {
            throw new Error(`durable session control ambiguity lost ${control.operationId}`);
          }
          throw new Error(effect.error);
        }
        const completed = await options.store.completeControlOperationAttempt({
          attempt: begun.attempt,
          result: effect.result,
        });
        if (completed.kind !== 'applied') {
          throw new Error(`durable session control completion lost ${control.operationId}`);
        }
        record = completed.record;
      }
    }
    if (record.state === 'attempting') {
      throw new Error(`durable session control attempt is still owned ${control.operationId}`);
    }
    if (record.state !== 'completed' || record.result === undefined) {
      throw new Error(`durable session control is not completed ${control.operationId}`);
    }
    if (context.signal.aborted) throw abortError(context.signal);
    await target.commit(record.result, context.signal);
    if (context.signal.aborted) throw abortError(context.signal);
    return { kind: 'settled' };
  };
}
