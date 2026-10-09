import { describe, expect, it, vi } from 'vitest';
import type {
  DurableInboxStore,
  DurableJson,
  InboxClaim,
  InboxClaimMutationResult,
} from '../src/services/durable-coordination.js';
import { startDurableInboxShadowConsumer } from '../src/services/durable-inbox-shadow-consumer.js';

function claim(messageId: string, workerId = 'shadow-worker', payload?: unknown): InboxClaim {
  return {
    event: {
      eventId: `im.message.receive_v1:cli_test:${messageId}`,
      partitionKey: 'lark-message-routing:cli_test:oc_test',
      payload: (payload ?? {
        version: 1,
        type: 'lark.im.message.receive_v1',
        larkAppId: 'cli_test',
        event: { message: { message_id: messageId } },
      }) as DurableJson,
      visibleAt: 1,
      createdAt: 1,
    },
    workerId,
    claimEpoch: 1,
    claimUntil: 60_000,
    attempts: 1,
  };
}

function inboxStore(input: {
  claims: InboxClaim[];
  completed?: InboxClaim[];
  retried?: Array<{ claim: InboxClaim; visibleAt: number }>;
}): DurableInboxStore {
  return {
    enqueueInbox: vi.fn(),
    claimNextInbox: vi.fn(async () => input.claims.shift()),
    renewInboxClaim: vi.fn(),
    completeInboxClaim: vi.fn(async current => {
      input.completed?.push(current);
      return { kind: 'applied' } as InboxClaimMutationResult;
    }),
    retryInboxClaim: vi.fn(async retry => {
      input.retried?.push(retry);
      return { kind: 'applied' } as InboxClaimMutationResult;
    }),
  };
}

describe('durable inbox shadow consumer', () => {
  it('claims, validates, and completes a bounded batch without routing side effects', async () => {
    const completed: InboxClaim[] = [];
    const store = inboxStore({
      claims: [claim('om_first'), claim('om_second')],
      completed,
    });
    const observed = vi.fn();
    const consumer = startDurableInboxShadowConsumer({
      store,
      workerId: 'shadow-worker',
      intervalMs: 60_000,
      onObserved: observed,
    });
    await consumer.ready;

    expect(completed.map(item => item.event.eventId)).toEqual([
      'im.message.receive_v1:cli_test:om_first',
      'im.message.receive_v1:cli_test:om_second',
    ]);
    expect(observed).toHaveBeenCalledTimes(2);
    expect(store.claimNextInbox).toHaveBeenLastCalledWith({
      workerId: 'shadow-worker',
      lane: 'lark-message',
      leaseDurationMs: 60_000,
    });
    await consumer.stop();
  });

  it('retries an invalid shadow envelope without completing the claim', async () => {
    const completed: InboxClaim[] = [];
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const store = inboxStore({
      claims: [claim('om_invalid', 'shadow-worker', { version: 2 })],
      completed,
      retried,
    });
    const errors: unknown[] = [];
    const consumer = startDurableInboxShadowConsumer({
      store,
      workerId: 'shadow-worker',
      intervalMs: 60_000,
      retryDelayMs: 5_000,
      now: () => 10_000,
      onError: error => errors.push(error),
    });
    await consumer.ready;

    expect(completed).toHaveLength(0);
    expect(retried).toHaveLength(1);
    expect(retried[0].visibleAt).toBe(15_000);
    expect(errors).toHaveLength(1);
    await consumer.stop();
  });

  it('reports a stale completion and stops without closing the shared store', async () => {
    const store = inboxStore({ claims: [claim('om_stale')] });
    vi.mocked(store.completeInboxClaim).mockResolvedValue({ kind: 'stale' });
    const errors: unknown[] = [];
    const consumer = startDurableInboxShadowConsumer({
      store,
      workerId: 'shadow-worker',
      intervalMs: 60_000,
      onError: error => errors.push(error),
    });
    await consumer.ready;

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('completion lost claim');
    await consumer.stop(0);
    expect(store.claimNextInbox).toHaveBeenCalled();
  });

  it('keeps the recurring poll armed after a transient bootstrap claim failure', async () => {
    vi.useFakeTimers();
    try {
      const store = inboxStore({ claims: [claim('om_recovered')] });
      vi.mocked(store.claimNextInbox)
        .mockRejectedValueOnce(new Error('provider unavailable'))
        .mockResolvedValueOnce(claim('om_recovered'))
        .mockResolvedValueOnce(undefined);
      const errors: unknown[] = [];
      const consumer = startDurableInboxShadowConsumer({
        store,
        workerId: 'shadow-worker',
        intervalMs: 10,
        onError: error => errors.push(error),
      });
      await consumer.ready;
      expect(errors).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(store.completeInboxClaim).toHaveBeenCalledOnce();
      await consumer.stop(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
