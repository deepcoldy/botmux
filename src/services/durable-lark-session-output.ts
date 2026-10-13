import type { Session } from '../types.js';
import type {
  DurableOutboxMessage,
  DurableOutboxStore,
} from './durable-coordination.js';
import type { DurableLarkAdmissionReceipt } from './durable-lark-admission.js';
import type { DurableLarkMessageClaim } from './durable-inbox-shadow.js';
import type { DurableSessionFacade } from './durable-session-facade.js';
import {
  enqueueDurableOutboxWithSettlement,
  type DurableOutboxTerminalSettlement,
} from './durable-outbox-settlement.js';
import {
  admitDurableLarkSession,
  durablePrimarySessionProjection,
} from './durable-session-primary.js';

export type DurableLarkSessionOutputResult =
  | {
      kind: 'accepted';
      admissionReceipt: DurableLarkAdmissionReceipt;
      inserted: boolean;
      settlement: Promise<DurableOutboxTerminalSettlement>;
    }
  | { kind: 'session_unavailable'; reason: string }
  | { kind: 'outbox_conflict' }
  | { kind: 'stale_lease' };

/**
 * Commit the latest full Session snapshot under a fresh fencing proof, then
 * enqueue one frozen output under that exact lease. The returned settlement is
 * authoritative across replica takeover and can be joined to final-drain.
 */
export async function enqueueDurableLarkSessionOutput(input: {
  facade: DurableSessionFacade;
  store: DurableOutboxStore;
  inbound: DurableLarkMessageClaim;
  session: Session;
  message: DurableOutboxMessage;
  intervalMs?: number;
  signal?: AbortSignal;
}): Promise<DurableLarkSessionOutputResult> {
  const projection = durablePrimarySessionProjection(input.session, input.inbound);
  if (input.message.sessionKey !== projection.sessionKey) {
    throw new Error('durable Lark output does not belong to the admitted Session');
  }
  const admitted = await admitDurableLarkSession({
    facade: input.facade,
    message: input.inbound,
    session: input.session,
  });
  if (admitted.kind !== 'committed') {
    return { kind: 'session_unavailable', reason: admitted.kind };
  }
  const output = await enqueueDurableOutboxWithSettlement({
    store: input.store,
    enqueue: { lease: admitted.lease, message: input.message },
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (output.kind === 'conflict') return { kind: 'outbox_conflict' };
  if (output.kind === 'stale_lease') return output;
  return {
    kind: 'accepted',
    admissionReceipt: admitted.receipt,
    inserted: output.inserted,
    settlement: output.settlement,
  };
}
