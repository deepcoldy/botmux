import type { Session } from '../types.js';
import type {
  DurableInboxPrimaryDispatchContext,
  DurableInboxPrimaryDispatchResult,
} from './durable-inbox-primary-consumer.js';
import type {
  DurableInboxEvent,
  DurableInboxStore,
  DurableOutboxStore,
} from './durable-coordination.js';
import type { DurableLarkMessageClaim } from './durable-inbox-shadow.js';
import type { DurableSessionFacade } from './durable-session-facade.js';
import { admitDurableLarkSession, checkpointDurableLarkSession } from './durable-session-primary.js';
import {
  durableLarkOutboxMessage,
  type DurableLarkOutboxTarget,
} from './durable-lark-outbox.js';

const MAX_POST_ADMISSION_OUTPUTS = 16;
const MAX_POST_ADMISSION_CONTROLS = 4;

export interface DurableLarkPostAdmissionOutput {
  target: DurableLarkOutboxTarget;
  content: string;
  msgType?: string;
  providerUuid: string;
  hookContext?: Record<string, unknown>;
}

export type DurableLarkCanonicalHandlerResult =
  | { kind: 'admitted'; session: Session }
  | { kind: 'ignored'; reason: string }
  | { kind: 'retry'; reason: string };

export interface DurableLarkCanonicalHandlerContext extends DurableInboxPrimaryDispatchContext {
  /** Raw event data after the durable envelope identity has been validated. */
  data: unknown;
  /**
   * Fence and persist pre-admission state for an existing active Session.
   * Await this before starting task input. This preserves earlier admissions
   * and creates no receipt for the current message; it may survive a retry.
   * The callback is valid only while this handler still owns its Inbox claim.
   * Supply isCurrent to keep the caller's worker/native identity fenced while
   * the snapshot waits in the durable Session lane.
   */
  checkpointPreAdmissionSession(session: Session, isCurrent?: () => boolean): Promise<void>;
  /**
   * Queue a user-visible effect that is allowed only after this handler's
   * canonical Session snapshot has been fenced and persisted. The queue is
   * in-memory until admission succeeds; the dispatch then writes every item
   * to the durable Outbox before the Inbox claim may complete.
   */
  queuePostAdmissionOutput(output: DurableLarkPostAdmissionOutput): void;
  /** 仅在本轮 canonical admission 提交后排入生命周期请求。 */
  queuePostAdmissionControl(event: DurableInboxEvent): void;
}

export interface DurableLarkCanonicalDispatchOptions {
  facade: DurableSessionFacade;
  store: Pick<DurableOutboxStore, 'enqueueOutbox'> & Pick<DurableInboxStore, 'enqueueInbox'>;
  handle(
    message: DurableLarkMessageClaim,
    context: DurableLarkCanonicalHandlerContext,
  ): Promise<DurableLarkCanonicalHandlerResult>;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('durable canonical dispatch lost inbox ownership');
}

/**
 * Bridge the primary inbox consumer to a canonical handler. The handler must
 * explicitly return either an ignored reason or the exact persisted Session
 * snapshot after its local admission boundary. Only the latter is written via
 * the exact durable Session lane and converted into a committed receipt.
 */
export function createDurableLarkCanonicalDispatch(
  options: DurableLarkCanonicalDispatchOptions,
): (
  message: DurableLarkMessageClaim,
  context: DurableInboxPrimaryDispatchContext,
) => Promise<DurableInboxPrimaryDispatchResult> {
  return async (message, context) => {
    if (context.signal.aborted) throw abortError(context.signal);
    const outputs: DurableLarkPostAdmissionOutput[] = [];
    const controls: DurableInboxEvent[] = [];
    const checkpoints: Promise<void>[] = [];
    const pendingCheckpoints = new Set<Promise<void>>();
    let acceptingOutputs = true;
    const assertCheckpointCurrent = (): void => {
      if (context.signal.aborted) throw abortError(context.signal);
      if (!acceptingOutputs) {
        throw new Error('durable canonical pre-admission checkpoint was requested after handler completion');
      }
    };
    let result: DurableLarkCanonicalHandlerResult;
    try {
      result = await options.handle(message, {
        ...context,
        data: message.data,
        checkpointPreAdmissionSession(session, isCurrent) {
          const assertCurrent = (): void => {
            assertCheckpointCurrent();
            if (isCurrent && !isCurrent()) {
              throw new Error('durable canonical pre-admission checkpoint runtime identity changed');
            }
          };
          const checkpoint = (async () => {
            assertCurrent();
            const saved = await checkpointDurableLarkSession({
              facade: options.facade,
              message,
              session,
              assertCurrent,
            });
            assertCurrent();
            if (saved.kind !== 'checkpointed') {
              throw new Error(`durable canonical pre-admission checkpoint failed: ${saved.kind}`);
            }
          })();
          checkpoints.push(checkpoint);
          pendingCheckpoints.add(checkpoint);
          // Dispatch observes failures even if the handler catches or forgets
          // this promise. Attach immediately to avoid an unhandled rejection.
          void checkpoint.then(
            () => { pendingCheckpoints.delete(checkpoint); },
            () => { pendingCheckpoints.delete(checkpoint); },
          );
          return checkpoint;
        },
        queuePostAdmissionOutput(output) {
          if (!acceptingOutputs) {
            throw new Error('durable canonical post-admission output was queued after handler completion');
          }
          if (outputs.length >= MAX_POST_ADMISSION_OUTPUTS) {
            throw new Error('durable canonical post-admission output limit exceeded');
          }
          outputs.push(JSON.parse(JSON.stringify(output)) as DurableLarkPostAdmissionOutput);
        },
        queuePostAdmissionControl(event) {
          if (!acceptingOutputs) {
            throw new Error('durable canonical post-admission control was queued after handler completion');
          }
          if (controls.length >= MAX_POST_ADMISSION_CONTROLS) {
            throw new Error('durable canonical post-admission control limit exceeded');
          }
          controls.push(JSON.parse(JSON.stringify(event)) as DurableInboxEvent);
        },
      });
    } catch (error) {
      acceptingOutputs = false;
      // An unawaited checkpoint may have entered storage already. Drain it
      // before the Inbox retries, while preserving the handler's original error.
      await Promise.allSettled(checkpoints);
      throw error;
    } finally {
      acceptingOutputs = false;
    }
    const hadPendingCheckpoint = pendingCheckpoints.size > 0;
    if (result.kind === 'retry' && !hadPendingCheckpoint) {
      // An awaited checkpoint outage is a recoverable wait-state. Keep the
      // explicit retry so Inbox maxAttempts cannot retire the pending task.
      await Promise.allSettled(checkpoints);
    } else {
      try {
        await Promise.all(checkpoints);
      } catch (error) {
        await Promise.allSettled(checkpoints);
        throw error;
      }
    }
    if (context.signal.aborted) throw abortError(context.signal);
    if (result.kind === 'retry') {
      if (outputs.length > 0 || controls.length > 0) {
        throw new Error('durable canonical retry result cannot publish post-admission effects');
      }
      const reason = result.reason.trim();
      if (!reason || reason.length > 512) {
        throw new Error('durable canonical retry result requires a bounded reason');
      }
      return { kind: 'retry', reason };
    }
    if (result.kind === 'ignored') {
      if (outputs.length > 0 || controls.length > 0) {
        throw new Error('durable canonical ignored result cannot publish post-admission effects');
      }
      const reason = result.reason.trim();
      if (!reason || reason.length > 512) {
        throw new Error('durable canonical ignored result requires a bounded reason');
      }
      return { kind: 'ignored', reason };
    }
    if (result.kind !== 'admitted' || !result.session) {
      throw new Error('durable canonical handler returned an invalid result');
    }
    const admitted = await admitDurableLarkSession({
      facade: options.facade,
      message,
      session: result.session,
    });
    if (admitted.kind !== 'committed') {
      throw new Error(`durable canonical Session admission failed: ${admitted.kind}`);
    }
    for (const output of outputs) {
      if (context.signal.aborted) throw abortError(context.signal);
      const mutation = await options.store.enqueueOutbox({
        lease: admitted.lease,
        message: durableLarkOutboxMessage({
          messageId: `out_${output.providerUuid}`,
          sessionKey: admitted.lease.sessionKey,
          larkAppId: message.larkAppId,
          target: output.target,
          content: output.content,
          providerUuid: output.providerUuid,
          ...(output.msgType === undefined ? {} : { msgType: output.msgType }),
          ...(output.hookContext === undefined ? {} : { hookContext: output.hookContext }),
          visibleAt: context.claim.event.createdAt,
          createdAt: context.claim.event.createdAt,
        }),
      });
      if (mutation.kind === 'conflict' || mutation.kind === 'stale_lease') {
        throw new Error(`durable canonical post-admission output failed: ${mutation.kind}`);
      }
    }
    for (const control of controls) {
      if (context.signal.aborted) throw abortError(context.signal);
      const mutation = await options.store.enqueueInbox(control);
      if (mutation.kind === 'conflict') {
        throw new Error(`durable canonical post-admission control failed: ${mutation.kind}`);
      }
    }
    if (result.session.status !== 'active') {
      await options.facade.releaseLease(admitted.lease.sessionKey);
    }
    return { kind: 'committed', receipt: admitted.receipt };
  };
}
