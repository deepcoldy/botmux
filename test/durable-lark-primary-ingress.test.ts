import { describe, expect, it, vi } from 'vitest';
import type {
  DurableInsertResult,
  LeaseMutationResult,
  SessionLease,
} from '../src/services/durable-coordination.js';
import {
  DurableLarkIngressAckTimeoutError,
  DurableLarkIngressNotLeaderError,
  startDurableLarkPrimaryIngress,
  type DurableLarkPrimaryIngressStore,
} from '../src/services/durable-lark-primary-ingress.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function lease(epoch = 1): SessionLease {
  return {
    sessionKey: 'botmux.ingress:lark:cli_test',
    ownerId: 'ingress-boot-1',
    epoch,
    leaseUntil: 60_000,
  };
}

function fakeStore() {
  const initialLease = lease();
  const store: DurableLarkPrimaryIngressStore = {
    acquireSessionLease: vi.fn(async () => ({ kind: 'acquired', lease: initialLease })),
    renewSessionLease: vi.fn(async input => ({
      kind: 'applied',
      lease: { ...input.lease, leaseUntil: input.lease.leaseUntil + input.leaseDurationMs },
    })),
    releaseSessionLease: vi.fn(async released => ({ kind: 'applied', lease: released })),
    enqueueInbox: vi.fn(async () => ({ kind: 'inserted' })),
    claimNextInbox: vi.fn(),
    renewInboxClaim: vi.fn(),
    completeInboxClaim: vi.fn(),
    retryInboxClaim: vi.fn(),
  };
  return store;
}

function message(messageId: string, partition = 'oc_chat') {
  return {
    eventId: `im.message.receive_v1:cli_test:${messageId}`,
    partitionKey: `lark-message-routing:cli_test:${partition}`,
    data: { message: { message_id: messageId } },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe('durable Lark primary ingress', () => {
  it('acquires one application lease and refreshes the leadership proof on the configured cadence', async () => {
    vi.useFakeTimers();
    try {
      let monotonicNow = 0;
      const store = fakeStore();
      const onLeadershipAcquired = vi.fn();
      const ingress = startDurableLarkPrimaryIngress({
        store,
        larkAppId: 'cli_test',
        ownerId: 'ingress-boot-1',
        leaseDurationMs: 3_000,
        renewalIntervalMs: 250,
        leadershipProofMaxAgeMs: 250,
        electionIntervalMs: 100,
        monotonicNow: () => monotonicNow,
        onLeadershipAcquired,
      });

      await ingress.ready;
      expect(ingress.status()).toEqual({ kind: 'leader', epoch: 1 });
      expect(onLeadershipAcquired).toHaveBeenCalledOnce();
      expect(store.acquireSessionLease).toHaveBeenCalledWith({
        sessionKey: 'botmux.ingress:lark:cli_test',
        ownerId: 'ingress-boot-1',
        leaseDurationMs: 3_000,
      });

      monotonicNow = 300;
      await vi.advanceTimersByTimeAsync(249);
      expect(store.renewSessionLease).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(store.renewSessionLease).toHaveBeenCalledOnce();
      expect(ingress.status()).toEqual({ kind: 'leader', epoch: 1 });
      await ingress.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('remains standby when the application lease is occupied and rejects admission', async () => {
    const store = fakeStore();
    vi.mocked(store.acquireSessionLease).mockResolvedValue({
      kind: 'occupied',
      ownerId: 'other-boot',
      epoch: 7,
      leaseUntil: 90_000,
    });
    const ingress = startDurableLarkPrimaryIngress({
      store,
      larkAppId: 'cli_test',
      ownerId: 'ingress-boot-1',
      electionIntervalMs: 60_000,
    });

    await ingress.ready;
    expect(ingress.status()).toEqual({ kind: 'standby' });
    await expect(ingress.enqueueBeforeAck(message('om_1')))
      .rejects.toBeInstanceOf(DurableLarkIngressNotLeaderError);
    expect(store.enqueueInbox).not.toHaveBeenCalled();
    await ingress.stop();
  });

  it('serializes one partition and assigns strictly increasing timestamps', async () => {
    const store = fakeStore();
    const first = deferred<DurableInsertResult>();
    vi.mocked(store.enqueueInbox)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ kind: 'duplicate' });
    const ingress = startDurableLarkPrimaryIngress({
      store,
      larkAppId: 'cli_test',
      ownerId: 'ingress-boot-1',
      electionIntervalMs: 60_000,
      now: () => 1_000,
    });
    await ingress.ready;

    const n = ingress.enqueueBeforeAck(message('om_1'));
    const nPlusOne = ingress.enqueueBeforeAck(message('om_2'));
    await flushMicrotasks();
    expect(store.enqueueInbox).toHaveBeenCalledOnce();

    first.resolve({ kind: 'inserted' });
    await expect(n).resolves.toEqual({ kind: 'inserted' });
    await expect(nPlusOne).resolves.toEqual({ kind: 'duplicate' });
    const firstRow = vi.mocked(store.enqueueInbox).mock.calls[0]![0];
    const secondRow = vi.mocked(store.enqueueInbox).mock.calls[1]![0];
    expect(secondRow.createdAt).toBe(firstRow.createdAt + 1);
    expect(secondRow.visibleAt).toBe(secondRow.createdAt);
    await ingress.stop();
  });

  it('ACKs inserted and duplicate rows but fails closed on a conflicting duplicate', async () => {
    const store = fakeStore();
    vi.mocked(store.enqueueInbox)
      .mockResolvedValueOnce({ kind: 'inserted' })
      .mockResolvedValueOnce({ kind: 'duplicate' })
      .mockResolvedValueOnce({ kind: 'conflict' });
    const onLeadershipLost = vi.fn();
    const ingress = startDurableLarkPrimaryIngress({
      store,
      larkAppId: 'cli_test',
      ownerId: 'ingress-boot-1',
      electionIntervalMs: 60_000,
      onLeadershipLost,
    });
    await ingress.ready;

    await expect(ingress.enqueueBeforeAck(message('om_1', 'oc_a')))
      .resolves.toEqual({ kind: 'inserted' });
    await expect(ingress.enqueueBeforeAck(message('om_2', 'oc_b')))
      .resolves.toEqual({ kind: 'duplicate' });
    await expect(ingress.enqueueBeforeAck(message('om_3', 'oc_c')))
      .rejects.toThrow(/conflicting duplicate/);
    expect(ingress.status()).toEqual({ kind: 'standby' });
    expect(onLeadershipLost).toHaveBeenCalledOnce();
    await ingress.stop();
  });

  it('rejects a mismatched event identity before writing the durable inbox', async () => {
    const store = fakeStore();
    const ingress = startDurableLarkPrimaryIngress({
      store,
      larkAppId: 'cli_test',
      ownerId: 'ingress-boot-1',
      electionIntervalMs: 60_000,
    });
    await ingress.ready;

    await expect(ingress.enqueueBeforeAck({
      ...message('om_payload'),
      eventId: 'im.message.receive_v1:cli_test:om_other',
    })).rejects.toThrow(/message identity/);
    expect(store.enqueueInbox).not.toHaveBeenCalled();
    expect(ingress.status()).toEqual({ kind: 'leader', epoch: 1 });
    await ingress.stop();
  });

  it('keeps a timed-out enqueue in the partition tail so the next event cannot overtake it', async () => {
    const store = fakeStore();
    const first = deferred<DurableInsertResult>();
    vi.mocked(store.enqueueInbox)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ kind: 'inserted' });
    const ingress = startDurableLarkPrimaryIngress({
      store,
      larkAppId: 'cli_test',
      ownerId: 'ingress-boot-1',
      ackTimeoutMs: 100,
      electionIntervalMs: 60_000,
    });
    await ingress.ready;

    const n = ingress.enqueueBeforeAck(message('om_1'));
    const nPlusOne = ingress.enqueueBeforeAck(message('om_2'));
    // Attach real rejection handlers immediately. Bun's native `expect(...).rejects`
    // matcher observes the promise lazily and reports this intentional timeout as
    // unhandled before the assertion below runs.
    const nRejected = n.catch(error => error);
    const nPlusOneRejected = nPlusOne.catch(error => error);
    await flushMicrotasks();
    expect(store.enqueueInbox).toHaveBeenCalledOnce();
    await expect(nRejected).resolves.toBeInstanceOf(DurableLarkIngressAckTimeoutError);
    await expect(nPlusOneRejected).resolves.toBeInstanceOf(DurableLarkIngressAckTimeoutError);
    expect(store.enqueueInbox).toHaveBeenCalledOnce();

    first.resolve({ kind: 'inserted' });
    await flushMicrotasks();
    expect(store.enqueueInbox).toHaveBeenCalledTimes(2);
    expect(ingress.status()).toEqual({ kind: 'leader', epoch: 1 });
    await ingress.stop();
  });

  it('drops leadership when a partition enqueue fails', async () => {
    const store = fakeStore();
    vi.mocked(store.enqueueInbox).mockRejectedValue(new Error('provider unavailable'));
    const onLeadershipLost = vi.fn();
    const ingress = startDurableLarkPrimaryIngress({
      store,
      larkAppId: 'cli_test',
      ownerId: 'ingress-boot-1',
      electionIntervalMs: 60_000,
      onLeadershipLost,
    });
    await ingress.ready;

    await expect(ingress.enqueueBeforeAck(message('om_1'))).rejects.toThrow('provider unavailable');
    expect(ingress.status()).toEqual({ kind: 'standby' });
    expect(onLeadershipLost).toHaveBeenCalledOnce();
    await ingress.stop();
  });

  it.each([
    ['stale result', async (): Promise<LeaseMutationResult> => ({ kind: 'stale' })],
    ['provider error', async (): Promise<LeaseMutationResult> => { throw new Error('renew failed'); }],
  ])('drops leadership after a renewal %s', async (_label, renew) => {
    vi.useFakeTimers();
    try {
      const store = fakeStore();
      vi.mocked(store.renewSessionLease).mockImplementation(renew);
      const onLeadershipLost = vi.fn();
      const ingress = startDurableLarkPrimaryIngress({
        store,
        larkAppId: 'cli_test',
        ownerId: 'ingress-boot-1',
        leaseDurationMs: 3_000,
        renewalIntervalMs: 250,
        electionIntervalMs: 100,
        onLeadershipLost,
      });
      await ingress.ready;

      await vi.advanceTimersByTimeAsync(250);
      expect(ingress.status()).toEqual({ kind: 'standby' });
      expect(onLeadershipLost).toHaveBeenCalledOnce();
      await ingress.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the lease if the leadership activation callback fails', async () => {
    const store = fakeStore();
    const activationError = new Error('WS start failed');
    const onError = vi.fn();
    const ingress = startDurableLarkPrimaryIngress({
      store,
      larkAppId: 'cli_test',
      ownerId: 'ingress-boot-1',
      electionIntervalMs: 60_000,
      onLeadershipAcquired: async () => { throw activationError; },
      onError,
    });

    await ingress.ready;
    expect(ingress.status()).toEqual({ kind: 'standby' });
    expect(store.releaseSessionLease).toHaveBeenCalledWith(lease());
    expect(onError).toHaveBeenCalledWith(activationError);
    await ingress.stop();
  });

  it('drains admitted writes before releasing the ingress lease', async () => {
    const store = fakeStore();
    const pending = deferred<DurableInsertResult>();
    vi.mocked(store.enqueueInbox).mockReturnValue(pending.promise);
    const ingress = startDurableLarkPrimaryIngress({
      store,
      larkAppId: 'cli_test',
      ownerId: 'ingress-boot-1',
      electionIntervalMs: 60_000,
    });
    await ingress.ready;

    const enqueue = ingress.enqueueBeforeAck(message('om_1'));
    await flushMicrotasks();
    const stopping = ingress.stop(1_000);
    await flushMicrotasks();
    expect(store.releaseSessionLease).not.toHaveBeenCalled();

    pending.resolve({ kind: 'inserted' });
    await expect(enqueue).resolves.toEqual({ kind: 'inserted' });
    await expect(stopping).resolves.toEqual({
      kind: 'stopped',
      pendingPartitions: 0,
      leaseReleased: true,
    });
    expect(store.releaseSessionLease).toHaveBeenCalledOnce();
  });

  it('waits for leadership cleanup before releasing the ingress lease', async () => {
    const store = fakeStore();
    const cleaned = deferred<void>();
    const onLeadershipLost = vi.fn(() => cleaned.promise);
    const ingress = startDurableLarkPrimaryIngress({
      store,
      larkAppId: 'cli_test',
      ownerId: 'ingress-boot-1',
      electionIntervalMs: 60_000,
      onLeadershipLost,
    });
    await ingress.ready;

    const stopping = ingress.stop(1_000);
    await flushMicrotasks();
    expect(onLeadershipLost).toHaveBeenCalledOnce();
    expect(store.releaseSessionLease).not.toHaveBeenCalled();

    cleaned.resolve();
    await expect(stopping).resolves.toEqual({
      kind: 'stopped',
      pendingPartitions: 0,
      leaseReleased: true,
    });
    expect(store.releaseSessionLease).toHaveBeenCalledOnce();
  });

  it('does not release the lease when leadership cleanup exceeds the shutdown deadline', async () => {
    vi.useFakeTimers();
    try {
      const store = fakeStore();
      const cleaned = deferred<void>();
      const onLeadershipLost = vi.fn(() => cleaned.promise);
      const ingress = startDurableLarkPrimaryIngress({
        store,
        larkAppId: 'cli_test',
        ownerId: 'ingress-boot-1',
        electionIntervalMs: 60_000,
        onLeadershipLost,
      });
      await ingress.ready;

      const stopping = ingress.stop(25);
      await flushMicrotasks();
      expect(onLeadershipLost).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(25);
      await expect(stopping).resolves.toEqual({
        kind: 'timed_out',
        pendingPartitions: 0,
        leaseReleased: false,
      });
      expect(store.releaseSessionLease).not.toHaveBeenCalled();
      cleaned.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out without releasing while an admitted write is still pending', async () => {
    vi.useFakeTimers();
    try {
      const store = fakeStore();
      const pending = deferred<DurableInsertResult>();
      vi.mocked(store.enqueueInbox).mockReturnValue(pending.promise);
      const ingress = startDurableLarkPrimaryIngress({
        store,
        larkAppId: 'cli_test',
        ownerId: 'ingress-boot-1',
        ackTimeoutMs: 2_500,
        electionIntervalMs: 60_000,
      });
      await ingress.ready;

      const enqueue = ingress.enqueueBeforeAck(message('om_1'));
      void enqueue.catch(() => undefined);
      await flushMicrotasks();
      const stopping = ingress.stop(25);
      await vi.advanceTimersByTimeAsync(25);
      await expect(stopping).resolves.toEqual({
        kind: 'timed_out',
        pendingPartitions: 1,
        leaseReleased: false,
      });
      expect(store.releaseSessionLease).not.toHaveBeenCalled();

      pending.resolve({ kind: 'inserted' });
      await flushMicrotasks();
      expect(store.releaseSessionLease).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes lease release in the same shutdown deadline', async () => {
    vi.useFakeTimers();
    try {
      const store = fakeStore();
      const release = deferred<LeaseMutationResult>();
      vi.mocked(store.releaseSessionLease).mockReturnValue(release.promise);
      const ingress = startDurableLarkPrimaryIngress({
        store,
        larkAppId: 'cli_test',
        ownerId: 'ingress-boot-1',
        electionIntervalMs: 60_000,
      });
      await ingress.ready;

      const stopping = ingress.stop(25);
      await flushMicrotasks();
      expect(store.releaseSessionLease).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(25);
      await expect(stopping).resolves.toEqual({
        kind: 'timed_out',
        pendingPartitions: 0,
        leaseReleased: false,
      });
      release.resolve({ kind: 'applied', lease: lease() });
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates the shutdown budget before changing leadership state', async () => {
    const store = fakeStore();
    const ingress = startDurableLarkPrimaryIngress({
      store,
      larkAppId: 'cli_test',
      ownerId: 'ingress-boot-1',
      electionIntervalMs: 60_000,
    });
    await ingress.ready;

    expect(() => ingress.stop(-1)).toThrow(/timeoutMs/);
    expect(ingress.status()).toEqual({ kind: 'leader', epoch: 1 });
    expect(store.releaseSessionLease).not.toHaveBeenCalled();
    await ingress.stop();
  });
});
