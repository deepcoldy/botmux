import type { Session } from '../types.js';
import type {
  DurableInboxPrimaryDispatchContext,
  DurableInboxPrimaryDispatchResult,
} from './durable-inbox-primary-consumer.js';
import type { DurableLarkMessageClaim } from './durable-inbox-shadow.js';
import type { DurableSessionFacade } from './durable-session-facade.js';
import { admitDurableLarkSession } from './durable-session-primary.js';

export type DurableLarkCanonicalHandlerResult =
  | { kind: 'admitted'; session: Session }
  | { kind: 'ignored'; reason: string };

export interface DurableLarkCanonicalHandlerContext extends DurableInboxPrimaryDispatchContext {
  /** Raw event data after the durable envelope identity has been validated. */
  data: unknown;
}

export interface DurableLarkCanonicalDispatchOptions {
  facade: DurableSessionFacade;
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
    const result = await options.handle(message, { ...context, data: message.data });
    if (context.signal.aborted) throw abortError(context.signal);
    if (result.kind === 'ignored') {
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
    return { kind: 'committed', receipt: admitted.receipt };
  };
}
