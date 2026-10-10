import { describe, expect, it, vi } from 'vitest';
import type {
  BeginOutboxAttemptResult,
  DurableJson,
  DurableOutboxRecord,
  DurableOutboxStore,
  OutboxAttempt,
  OutboxMutationResult,
  OutboxReservation,
} from '../src/services/durable-coordination.js';
import { startDurableOutboxPump } from '../src/services/durable-outbox-pump.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function record(messageId: string): DurableOutboxRecord {
  return {
    messageId,
    sessionKey: 'session-a',
    payload: { type: 'test.delivery', messageId },
    visibleAt: 1,
    createdAt: 1,
    state: 'reserved',
    originEpoch: 1,
    attempts: 0,
    updatedAt: 1,
  };
}

function reservation(messageId: string): OutboxReservation {
  return {
    record: record(messageId),
    workerId: 'unassigned',
    claimEpoch: 1,
    claimUntil: 60_000,
  };
}

function outboxStore(input: {
  reservations: OutboxReservation[];
  delivered?: DurableOutboxRecord[];
  retried?: DurableOutboxRecord[];
  ambiguous?: DurableOutboxRecord[];
}): DurableOutboxStore {
  const settle = (
    attempt: OutboxAttempt,
    state: DurableOutboxRecord['state'],
    target?: DurableOutboxRecord[],
  ): OutboxMutationResult => {
    const next = { ...attempt.record, state, updatedAt: 2 };
    target?.push(next);
    return { kind: 'applied', record: next };
  };
  return {
    enqueueOutbox: vi.fn(),
    reserveNextOutbox: vi.fn(async ({ workerId }) => {
      const next = input.reservations.shift();
      return next ? { ...next, workerId } : undefined;
    }),
    beginOutboxAttempt: vi.fn(async ({ reservation: current }) => {
      const attempting = {
        ...current.record,
        state: 'attempting' as const,
        attempts: current.record.attempts + 1,
      };
      const attempt: OutboxAttempt = {
        ...current,
        record: attempting,
        attempt: attempting.attempts,
      };
      return { kind: 'applied', record: attempting, attempt } as BeginOutboxAttemptResult;
    }),
    completeOutboxAttempt: vi.fn(async ({ attempt }) => settle(attempt, 'delivered', input.delivered)),
    retryOutboxAttempt: vi.fn(async ({ attempt }) => settle(attempt, 'pending', input.retried)),
    markOutboxAmbiguous: vi.fn(async ({ attempt }) => settle(attempt, 'ambiguous', input.ambiguous)),
    readOutbox: vi.fn(),
  };
}

describe('durable outbox pump', () => {
  it('crosses the attempt boundary before delivery and records a receipt', async () => {
    const delivered: DurableOutboxRecord[] = [];
    const store = outboxStore({ reservations: [reservation('msg-delivered')], delivered });
    const deliver = vi.fn(async () => {
      expect(store.beginOutboxAttempt).toHaveBeenCalledOnce();
      return {
        kind: 'delivered' as const,
        receipt: { providerMessageId: 'provider-1' } as DurableJson,
      };
    });
    const observed: string[] = [];
    const pump = startDurableOutboxPump({
      store,
      workerId: 'outbox-boot',
      concurrency: 1,
      intervalMs: 60_000,
      deliver,
      onDelivered: row => observed.push(row.messageId),
    });
    await pump.ready;

    expect(store.completeOutboxAttempt).toHaveBeenCalledOnce();
    expect(store.retryOutboxAttempt).not.toHaveBeenCalled();
    expect(store.markOutboxAmbiguous).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(1);
    expect(observed).toEqual(['msg-delivered']);
    await pump.stop();
  });

  it('does not reclassify a delivered row when an observer fails', async () => {
    const delivered: DurableOutboxRecord[] = [];
    const store = outboxStore({ reservations: [reservation('msg-observer')], delivered });
    const errors: unknown[] = [];
    const pump = startDurableOutboxPump({
      store,
      workerId: 'outbox-boot',
      concurrency: 1,
      intervalMs: 60_000,
      deliver: async () => ({ kind: 'delivered', receipt: { ok: true } }),
      onDelivered: () => { throw new Error('observer unavailable'); },
      onError: error => errors.push(error),
    });
    await pump.ready;

    expect(delivered).toHaveLength(1);
    expect(store.markOutboxAmbiguous).not.toHaveBeenCalled();
    expect(errors.some(error => String(error).includes('observer failed'))).toBe(true);
    await pump.stop();
  });

  it('retries only when delivery returns an explicit safety proof', async () => {
    const retried: DurableOutboxRecord[] = [];
    const store = outboxStore({ reservations: [reservation('msg-retry')], retried });
    const pump = startDurableOutboxPump({
      store,
      workerId: 'outbox-boot',
      concurrency: 1,
      intervalMs: 60_000,
      now: () => 10_000,
      deliver: async () => ({
        kind: 'retry',
        visibleAt: 12_000,
        error: 'connection refused before request write',
        proof: 'no_side_effect',
      }),
    });
    await pump.ready;

    expect(store.retryOutboxAttempt).toHaveBeenCalledWith(expect.objectContaining({
      visibleAt: 12_000,
      error: 'connection refused before request write',
    }));
    expect(retried).toHaveLength(1);
    expect(store.markOutboxAmbiguous).not.toHaveBeenCalled();
    await pump.stop();
  });

  it('marks a thrown delivery outcome ambiguous instead of retrying', async () => {
    const ambiguous: DurableOutboxRecord[] = [];
    const store = outboxStore({ reservations: [reservation('msg-throw')], ambiguous });
    const pump = startDurableOutboxPump({
      store,
      workerId: 'outbox-boot',
      concurrency: 1,
      intervalMs: 60_000,
      deliver: async () => { throw new Error('socket reset after write'); },
    });
    await pump.ready;

    expect(store.markOutboxAmbiguous).toHaveBeenCalledOnce();
    expect(store.retryOutboxAttempt).not.toHaveBeenCalled();
    expect(ambiguous).toHaveLength(1);
    await pump.stop();
  });

  it('downgrades an invalid retry proof to ambiguous', async () => {
    const ambiguous: DurableOutboxRecord[] = [];
    const store = outboxStore({ reservations: [reservation('msg-proof')], ambiguous });
    const pump = startDurableOutboxPump({
      store,
      workerId: 'outbox-boot',
      concurrency: 1,
      intervalMs: 60_000,
      deliver: async () => ({
        kind: 'retry',
        visibleAt: Date.now() + 1_000,
        error: 'retry me',
        proof: 'because_i_said_so',
      } as never),
    });
    await pump.ready;

    expect(store.retryOutboxAttempt).not.toHaveBeenCalled();
    expect(store.markOutboxAmbiguous).toHaveBeenCalledOnce();
    expect(ambiguous).toHaveLength(1);
    await pump.stop();
  });

  it('times out to ambiguous and never accepts a late success receipt', async () => {
    vi.useFakeTimers();
    try {
      const ambiguous: DurableOutboxRecord[] = [];
      const store = outboxStore({ reservations: [reservation('msg-timeout')], ambiguous });
      const started = deferred<void>();
      const delivery = deferred<{ kind: 'delivered'; receipt: DurableJson }>();
      const lateObserved = deferred<void>();
      const late: string[] = [];
      const pump = startDurableOutboxPump({
        store,
        workerId: 'outbox-boot',
        concurrency: 1,
        intervalMs: 60_000,
        reservationLeaseMs: 2_000,
        attemptTimeoutMs: 500,
        deliver: async () => {
          started.resolve();
          return await delivery.promise;
        },
        onLateResult: attempt => {
          late.push(attempt.record.messageId);
          lateObserved.resolve();
        },
      });

      await started.promise;
      await vi.advanceTimersByTimeAsync(500);
      await pump.ready;
      expect(store.markOutboxAmbiguous).toHaveBeenCalledOnce();
      expect(store.completeOutboxAttempt).not.toHaveBeenCalled();

      delivery.resolve({ kind: 'delivered', receipt: { late: true } });
      await lateObserved.promise;
      expect(late).toEqual(['msg-timeout']);
      expect(store.completeOutboxAttempt).not.toHaveBeenCalled();
      await pump.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call delivery after a stale begin-attempt transition', async () => {
    const store = outboxStore({ reservations: [reservation('msg-stale')] });
    vi.mocked(store.beginOutboxAttempt).mockResolvedValue({ kind: 'stale' });
    const deliver = vi.fn();
    const errors: unknown[] = [];
    const pump = startDurableOutboxPump({
      store,
      workerId: 'outbox-boot',
      concurrency: 1,
      intervalMs: 60_000,
      deliver,
      onError: error => errors.push(error),
    });
    await pump.ready;

    expect(deliver).not.toHaveBeenCalled();
    expect(errors.some(error => String(error).includes('begin lost reservation'))).toBe(true);
    await pump.stop();
  });

  it('bounds shutdown and classifies an aborted in-flight attempt ambiguous', async () => {
    const ambiguous: DurableOutboxRecord[] = [];
    const store = outboxStore({ reservations: [reservation('msg-shutdown')], ambiguous });
    const started = deferred<void>();
    const sawAbort = deferred<void>();
    const pump = startDurableOutboxPump({
      store,
      workerId: 'outbox-boot',
      concurrency: 1,
      intervalMs: 60_000,
      deliver: async (_record, { signal }) => {
        started.resolve();
        await new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        sawAbort.resolve();
        return { kind: 'ambiguous', error: 'shutdown interrupted delivery' };
      },
    });

    await started.promise;
    await expect(pump.stop(0)).resolves.toEqual({ kind: 'timed_out', inFlight: 1 });
    await sawAbort.promise;
    await pump.ready;
    expect(store.markOutboxAmbiguous).toHaveBeenCalledOnce();
    expect(store.completeOutboxAttempt).not.toHaveBeenCalled();
    expect(store.retryOutboxAttempt).not.toHaveBeenCalled();
  });

  it('keeps polling after a transient reserve failure', async () => {
    vi.useFakeTimers();
    try {
      const delivered: DurableOutboxRecord[] = [];
      const store = outboxStore({ reservations: [reservation('msg-recovered')], delivered });
      const fallback = vi.mocked(store.reserveNextOutbox).getMockImplementation()!;
      vi.mocked(store.reserveNextOutbox)
        .mockRejectedValueOnce(new Error('provider unavailable'))
        .mockImplementation(fallback);
      const errors: unknown[] = [];
      const pump = startDurableOutboxPump({
        store,
        workerId: 'outbox-boot',
        concurrency: 1,
        intervalMs: 10,
        deliver: async () => ({ kind: 'delivered', receipt: { ok: true } }),
        onError: error => errors.push(error),
      });
      await pump.ready;
      expect(errors).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(delivered).toHaveLength(1);
      await pump.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
