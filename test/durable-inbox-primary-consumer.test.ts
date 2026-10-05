import { describe, expect, it, vi } from 'vitest';
import type {
  DurableInboxStore,
  DurableJson,
  InboxClaim,
  InboxClaimMutationResult,
} from '../src/services/durable-coordination.js';
import {
  startDurableInboxPrimaryConsumer,
  type DurableInboxPrimaryDispatchResult,
} from '../src/services/durable-inbox-primary-consumer.js';
import type { DurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';
import { durableLarkAdmissionReceipt } from '../src/services/durable-lark-admission.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function claim(messageId: string, payload?: unknown): InboxClaim {
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
    workerId: 'unassigned',
    claimEpoch: 1,
    claimUntil: 60_000,
    attempts: 1,
  };
}

function committed(message: DurableLarkMessageClaim): Extract<
  DurableInboxPrimaryDispatchResult,
  { kind: 'committed' }
> {
  const sessionKey = `${message.messageId}::${message.larkAppId}`;
  return {
    kind: 'committed',
    receipt: durableLarkAdmissionReceipt({
      message,
      lease: {
        sessionKey,
        ownerId: 'session-owner-boot',
        epoch: 3,
        leaseUntil: 60_000,
      },
      record: {
        sessionKey,
        revision: 5,
        value: { status: 'active' },
        updatedAt: 10_000,
      },
    }),
  };
}

function inboxStore(input: {
  claims: InboxClaim[];
  completed?: InboxClaim[];
  retried?: Array<{ claim: InboxClaim; visibleAt: number }>;
}): DurableInboxStore {
  return {
    enqueueInbox: vi.fn(),
    claimNextInbox: vi.fn(async ({ workerId }) => {
      const next = input.claims.shift();
      return next ? { ...next, workerId } : undefined;
    }),
    renewInboxClaim: vi.fn(async ({ claim: current, leaseDurationMs }) => ({
      kind: 'applied',
      claim: { ...current, claimUntil: current.claimUntil + leaseDurationMs },
    })),
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

describe('durable inbox primary consumer', () => {
  it('completes only after committed or explicitly ignored dispatch receipts', async () => {
    const completed: InboxClaim[] = [];
    const store = inboxStore({
      claims: [claim('om_commit'), claim('om_ignore')],
      completed,
    });
    const dispatch = vi.fn(async message => message.messageId === 'om_commit'
      ? committed(message)
      : { kind: 'ignored' as const, reason: 'not addressed to this bot' });
    const commits: string[] = [];
    const receipts: number[] = [];
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      dispatch,
      onCommitted: ({ message, result }) => {
        commits.push(message.messageId);
        if (result.kind === 'committed') receipts.push(result.receipt.sessionRevision);
      },
    });
    await consumer.ready;

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      messageId: 'om_commit',
      data: { message: { message_id: 'om_commit' } },
    });
    expect(completed.map(item => item.event.eventId)).toEqual([
      'im.message.receive_v1:cli_test:om_commit',
      'im.message.receive_v1:cli_test:om_ignore',
    ]);
    expect(commits).toEqual(['om_commit', 'om_ignore']);
    expect(receipts).toEqual([5]);
    expect(store.completeInboxClaim).toHaveBeenCalledTimes(2);
    expect(store.retryInboxClaim).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it('retries an invalid envelope without exposing it to dispatch', async () => {
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const store = inboxStore({
      claims: [claim('om_invalid', { version: 2 })],
      retried,
    });
    const dispatch = vi.fn();
    const errors: unknown[] = [];
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      retryDelayMs: 2_000,
      now: () => 10_000,
      dispatch,
      onError: error => errors.push(error),
    });
    await consumer.ready;

    expect(dispatch).not.toHaveBeenCalled();
    expect(store.completeInboxClaim).not.toHaveBeenCalled();
    expect(retried).toHaveLength(1);
    expect(retried[0].visibleAt).toBe(12_000);
    expect(errors).toHaveLength(1);
    await consumer.stop();
  });

  it('retries a dispatch failure while the claim is still owned', async () => {
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const store = inboxStore({ claims: [claim('om_retry')], retried });
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      retryDelayMs: 500,
      now: () => 5_000,
      dispatch: async () => { throw new Error('durable admission unavailable'); },
      onError: () => { throw new Error('observer failure'); },
    });
    await consumer.ready;

    expect(store.completeInboxClaim).not.toHaveBeenCalled();
    expect(retried).toHaveLength(1);
    expect(retried[0].visibleAt).toBe(5_500);
    await consumer.stop();
  });

  it('keeps polling after a transient claim failure', async () => {
    vi.useFakeTimers();
    try {
      const completed: InboxClaim[] = [];
      const store = inboxStore({ claims: [claim('om_recovered')], completed });
      const fallback = vi.mocked(store.claimNextInbox).getMockImplementation()!;
      vi.mocked(store.claimNextInbox)
        .mockRejectedValueOnce(new Error('provider unavailable'))
        .mockImplementation(fallback);
      const errors: unknown[] = [];
      const consumer = startDurableInboxPrimaryConsumer({
        store,
        workerId: 'primary-boot',
        concurrency: 1,
        intervalMs: 10,
        dispatch: async message => committed(message),
        onError: error => errors.push(error),
      });
      await consumer.ready;
      expect(errors).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(completed).toHaveLength(1);
      await consumer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an unproven dispatch receipt instead of completing the row', async () => {
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const store = inboxStore({ claims: [claim('om_unproven')], retried });
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      now: () => 8_000,
      dispatch: async () => ({ kind: 'queued' } as never),
    });
    await consumer.ready;

    expect(store.completeInboxClaim).not.toHaveBeenCalled();
    expect(retried).toHaveLength(1);
    await consumer.stop();
  });

  it('refuses a bare committed marker without a fenced Session receipt', async () => {
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const store = inboxStore({ claims: [claim('om_bare_commit')], retried });
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      dispatch: async () => ({ kind: 'committed' } as never),
    });
    await consumer.ready;

    expect(store.completeInboxClaim).not.toHaveBeenCalled();
    expect(retried).toHaveLength(1);
    await consumer.stop();
  });

  it('refuses a committed receipt copied from another inbox event', async () => {
    const retried: Array<{ claim: InboxClaim; visibleAt: number }> = [];
    const store = inboxStore({ claims: [claim('om_expected')], retried });
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      dispatch: async message => {
        const result = committed(message);
        return {
          ...result,
          receipt: {
            ...result.receipt,
            eventId: 'im.message.receive_v1:cli_test:om_other',
          },
        };
      },
    });
    await consumer.ready;

    expect(store.completeInboxClaim).not.toHaveBeenCalled();
    expect(retried).toHaveLength(1);
    await consumer.stop();
  });

  it('does not retry a completed row when the observer callback fails', async () => {
    const store = inboxStore({ claims: [claim('om_observer')] });
    const errors: unknown[] = [];
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      dispatch: async message => committed(message),
      onCommitted: () => { throw new Error('observer unavailable'); },
      onError: error => errors.push(error),
    });
    await consumer.ready;

    expect(store.completeInboxClaim).toHaveBeenCalledOnce();
    expect(store.retryInboxClaim).not.toHaveBeenCalled();
    expect(errors.some(error => String(error).includes('commit observer failed'))).toBe(true);
    await consumer.stop();
  });

  it('renews a long dispatch and completes with the latest claim proof', async () => {
    vi.useFakeTimers();
    try {
      const completed: InboxClaim[] = [];
      const store = inboxStore({ claims: [claim('om_long')], completed });
      const started = deferred<void>();
      const admission = deferred<void>();
      const consumer = startDurableInboxPrimaryConsumer({
        store,
        workerId: 'primary-boot',
        concurrency: 1,
        intervalMs: 60_000,
        leaseDurationMs: 3_000,
        renewalIntervalMs: 1_000,
        dispatch: message => {
          started.resolve();
          return admission.promise.then(() => committed(message));
        },
      });

      await started.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(store.renewInboxClaim).toHaveBeenCalledOnce();
      admission.resolve();
      await consumer.ready;

      expect(completed).toHaveLength(1);
      expect(completed[0].claimUntil).toBe(63_000);
      await consumer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts dispatch and leaves the row recoverable after stale renewal', async () => {
    vi.useFakeTimers();
    try {
      const store = inboxStore({ claims: [claim('om_stale')] });
      vi.mocked(store.renewInboxClaim).mockResolvedValue({ kind: 'stale' });
      const started = deferred<void>();
      const aborted = deferred<void>();
      const dispatch = vi.fn(async (message, { signal }) => {
        started.resolve();
        await new Promise<void>(resolve => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        aborted.resolve();
        return committed(message);
      });
      const errors: unknown[] = [];
      const consumer = startDurableInboxPrimaryConsumer({
        store,
        workerId: 'primary-boot',
        concurrency: 1,
        intervalMs: 60_000,
        leaseDurationMs: 3_000,
        renewalIntervalMs: 1_000,
        dispatch,
        onError: error => errors.push(error),
      });

      await started.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      await aborted.promise;
      await consumer.ready;

      expect(errors.some(error => String(error).includes('renewal lost claim'))).toBe(true);
      expect(store.completeInboxClaim).not.toHaveBeenCalled();
      expect(store.retryInboxClaim).not.toHaveBeenCalled();
      await consumer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds shutdown and aborts an in-flight dispatch without completing', async () => {
    const store = inboxStore({ claims: [claim('om_shutdown')] });
    const started = deferred<void>();
    const sawAbort = deferred<void>();
    const consumer = startDurableInboxPrimaryConsumer({
      store,
      workerId: 'primary-boot',
      concurrency: 1,
      intervalMs: 60_000,
      dispatch: async (message, { signal }) => {
        started.resolve();
        await new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        sawAbort.resolve();
        return committed(message);
      },
    });

    await started.promise;
    await expect(consumer.stop(0)).resolves.toEqual({ kind: 'timed_out', inFlight: 1 });
    await sawAbort.promise;
    await consumer.ready;
    expect(store.completeInboxClaim).not.toHaveBeenCalled();
  });
});
