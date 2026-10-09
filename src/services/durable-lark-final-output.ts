import type { DaemonSession } from '../core/types.js';
import { beginFinalOutputDelivery } from '../core/final-output-delivery-drain.js';
import type { DurableOutboxStore } from './durable-coordination.js';
import type { DurableLarkMessageClaim } from './durable-inbox-shadow.js';
import type { DurableSessionFacade } from './durable-session-facade.js';
import {
  enqueueDurableLarkSessionOutput,
  type DurableLarkSessionOutputResult,
} from './durable-lark-session-output.js';
import type { DurableOutboxMessage } from './durable-coordination.js';

/**
 * Register the existing daemon final-drain fence synchronously, then start the
 * durable Session/output transaction. Accepted output keeps the fence open
 * until the shared outbox reaches delivered or ambiguous, including settlement
 * performed by another replica. Any pre-enqueue failure releases it here.
 */
export function enqueueDurableLarkFinalOutput(input: {
  daemonSession: DaemonSession;
  facade: DurableSessionFacade;
  store: DurableOutboxStore;
  inbound: DurableLarkMessageClaim;
  message: DurableOutboxMessage;
  intervalMs?: number;
  signal?: AbortSignal;
}): Promise<DurableLarkSessionOutputResult> {
  const finishDrain = beginFinalOutputDelivery(input.daemonSession);
  return enqueueDurableLarkSessionOutput({
    facade: input.facade,
    store: input.store,
    inbound: input.inbound,
    session: input.daemonSession.session,
    message: input.message,
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    ...(input.signal ? { signal: input.signal } : {}),
  }).then(result => {
    if (result.kind !== 'accepted') {
      finishDrain();
      return result;
    }
    void result.settlement.then(finishDrain, finishDrain);
    return result;
  }, error => {
    finishDrain();
    throw error;
  });
}
