import type { Session } from '../types.js';
import type {
  DurableInboxPrimaryDispatchContext,
  DurableInboxPrimaryDispatchResult,
} from './durable-inbox-primary-consumer.js';
import type { DurableOutboxStore } from './durable-coordination.js';
import type { DurableLarkMessageClaim } from './durable-inbox-shadow.js';
import type { DurableSessionFacade } from './durable-session-facade.js';
import { admitDurableLarkSession } from './durable-session-primary.js';
import {
  durableLarkOutboxMessage,
  type DurableLarkOutboxTarget,
} from './durable-lark-outbox.js';

const MAX_POST_ADMISSION_OUTPUTS = 16;

export interface DurableLarkPostAdmissionOutput {
  target: DurableLarkOutboxTarget;
  content: string;
  msgType?: string;
  providerUuid: string;
  hookContext?: Record<string, unknown>;
}

export type DurableLarkCanonicalHandlerResult =
  | { kind: 'admitted'; session: Session }
  | { kind: 'ignored'; reason: string };

export interface DurableLarkCanonicalHandlerContext extends DurableInboxPrimaryDispatchContext {
  /** Raw event data after the durable envelope identity has been validated. */
  data: unknown;
  /**
   * Queue a user-visible effect that is allowed only after this handler's
   * canonical Session snapshot has been fenced and persisted. The queue is
   * in-memory until admission succeeds; the dispatch then writes every item
   * to the durable Outbox before the Inbox claim may complete.
   */
  queuePostAdmissionOutput(output: DurableLarkPostAdmissionOutput): void;
}

export interface DurableLarkCanonicalDispatchOptions {
  facade: DurableSessionFacade;
  store: Pick<DurableOutboxStore, 'enqueueOutbox'>;
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
    let acceptingOutputs = true;
    let result: DurableLarkCanonicalHandlerResult;
    try {
      result = await options.handle(message, {
        ...context,
        data: message.data,
        queuePostAdmissionOutput(output) {
          if (!acceptingOutputs) {
            throw new Error('durable canonical post-admission output was queued after handler completion');
          }
          if (outputs.length >= MAX_POST_ADMISSION_OUTPUTS) {
            throw new Error('durable canonical post-admission output limit exceeded');
          }
          outputs.push(JSON.parse(JSON.stringify(output)) as DurableLarkPostAdmissionOutput);
        },
      });
    } finally {
      acceptingOutputs = false;
    }
    if (context.signal.aborted) throw abortError(context.signal);
    if (result.kind === 'ignored') {
      if (outputs.length > 0) {
        throw new Error('durable canonical ignored result cannot publish post-admission output');
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
    return { kind: 'committed', receipt: admitted.receipt };
  };
}
