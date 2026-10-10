import type {
  DurableOutboxRecord,
  DurableOutboxStore,
  EnqueueOutboxInput,
} from './durable-coordination.js';

export type DurableOutboxTerminalSettlement =
  | { kind: 'delivered'; record: DurableOutboxRecord }
  | { kind: 'ambiguous'; record: DurableOutboxRecord };

export type DurableOutboxEnqueueSettlementResult =
  | {
      kind: 'accepted';
      inserted: boolean;
      settlement: Promise<DurableOutboxTerminalSettlement>;
    }
  | { kind: 'conflict' }
  | { kind: 'stale_lease' };

export interface DurableOutboxSettlementOptions {
  store: DurableOutboxStore;
  messageId: string;
  intervalMs?: number;
  signal?: AbortSignal;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function messageIdFrom(value: string): string {
  const messageId = value.trim();
  if (!messageId || messageId.length > 1_024 || /[\r\n\0]/.test(messageId)) {
    throw new Error('durable outbox settlement messageId must contain bounded non-empty text');
  }
  return messageId;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('durable outbox settlement aborted');
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      if (!signal) return;
      clearTimeout(timer);
      cleanup();
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Follow one durable outbox row to a terminal state using the store as the
 * authority. Polling, rather than a process-local observer, also sees a row
 * delivered by another replica after takeover.
 */
export async function waitForDurableOutboxSettlement(
  options: DurableOutboxSettlementOptions,
): Promise<DurableOutboxTerminalSettlement> {
  const messageId = messageIdFrom(options.messageId);
  const intervalMs = boundedInteger(options.intervalMs ?? 250, 'intervalMs', 10, 60_000);
  for (;;) {
    if (options.signal?.aborted) throw abortError(options.signal);
    const record = await options.store.readOutbox(messageId);
    if (!record) throw new Error(`durable outbox settlement row disappeared: ${messageId}`);
    if (record.state === 'delivered') return { kind: 'delivered', record };
    if (record.state === 'ambiguous') return { kind: 'ambiguous', record };
    await wait(intervalMs, options.signal);
  }
}

/** Enqueue a fenced output and return the authoritative terminal settlement. */
export async function enqueueDurableOutboxWithSettlement(input: {
  store: DurableOutboxStore;
  enqueue: EnqueueOutboxInput;
  intervalMs?: number;
  signal?: AbortSignal;
}): Promise<DurableOutboxEnqueueSettlementResult> {
  const result = await input.store.enqueueOutbox(input.enqueue);
  if (result.kind === 'conflict' || result.kind === 'stale_lease') return result;
  return {
    kind: 'accepted',
    inserted: result.kind === 'inserted',
    settlement: waitForDurableOutboxSettlement({
      store: input.store,
      messageId: input.enqueue.message.messageId,
      ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  };
}
