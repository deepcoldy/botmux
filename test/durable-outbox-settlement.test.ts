import { describe, expect, it, vi } from 'vitest';
import type {
  DurableOutboxRecord,
  DurableOutboxStore,
  SessionLease,
} from '../src/services/durable-coordination.js';
import {
  enqueueDurableOutboxWithSettlement,
  waitForDurableOutboxSettlement,
} from '../src/services/durable-outbox-settlement.js';

function row(state: DurableOutboxRecord['state']): DurableOutboxRecord {
  return {
    messageId: 'outbox-1',
    sessionKey: 'om_root::cli_test',
    payload: { text: 'hello' },
    visibleAt: 1,
    createdAt: 1,
    state,
    originEpoch: 3,
    attempts: state === 'pending' ? 0 : 1,
    updatedAt: 2,
  };
}

function lease(): SessionLease {
  return {
    sessionKey: 'om_root::cli_test',
    ownerId: 'session-owner',
    epoch: 3,
    leaseUntil: 60_000,
  };
}

function store(): DurableOutboxStore {
  return {
    enqueueOutbox: vi.fn(async () => ({ kind: 'inserted' })),
    reserveNextOutbox: vi.fn(),
    beginOutboxAttempt: vi.fn(),
    completeOutboxAttempt: vi.fn(),
    retryOutboxAttempt: vi.fn(),
    markOutboxAmbiguous: vi.fn(),
    readOutbox: vi.fn(async () => row('delivered')),
  };
}

describe('durable outbox settlement', () => {
  it('enqueues once and follows another replica\'s delivery to terminal state', async () => {
    vi.useFakeTimers();
    try {
      const durableStore = store();
      vi.mocked(durableStore.readOutbox)
        .mockResolvedValueOnce(row('pending'))
        .mockResolvedValueOnce(row('attempting'))
        .mockResolvedValueOnce(row('delivered'));
      const accepted = await enqueueDurableOutboxWithSettlement({
        store: durableStore,
        enqueue: { lease: lease(), message: row('pending') },
        intervalMs: 10,
      });
      expect(accepted).toMatchObject({ kind: 'accepted', inserted: true });
      if (accepted.kind !== 'accepted') throw new Error('expected accepted output');

      await vi.advanceTimersByTimeAsync(20);
      await expect(accepted.settlement).resolves.toMatchObject({
        kind: 'delivered',
        record: { messageId: 'outbox-1', state: 'delivered' },
      });
      expect(durableStore.readOutbox).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a duplicate row and surfaces an existing ambiguous terminal', async () => {
    const durableStore = store();
    vi.mocked(durableStore.enqueueOutbox).mockResolvedValue({ kind: 'duplicate' });
    vi.mocked(durableStore.readOutbox).mockResolvedValue(row('ambiguous'));
    const accepted = await enqueueDurableOutboxWithSettlement({
      store: durableStore,
      enqueue: { lease: lease(), message: row('pending') },
    });
    expect(accepted).toMatchObject({ kind: 'accepted', inserted: false });
    if (accepted.kind !== 'accepted') throw new Error('expected accepted output');
    await expect(accepted.settlement).resolves.toMatchObject({ kind: 'ambiguous' });
  });

  it('removes each abort listener after a normal polling interval completes', async () => {
    vi.useFakeTimers();
    try {
      const durableStore = store();
      vi.mocked(durableStore.readOutbox)
        .mockResolvedValueOnce(row('pending'))
        .mockResolvedValueOnce(row('delivered'));
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const settlement = waitForDurableOutboxSettlement({
        store: durableStore,
        messageId: 'outbox-1',
        intervalMs: 10,
        signal: controller.signal,
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
      await expect(settlement).resolves.toMatchObject({ kind: 'delivered' });
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['conflict', 'stale_lease'] as const)('does not start settlement after %s', async kind => {
    const durableStore = store();
    vi.mocked(durableStore.enqueueOutbox).mockResolvedValue({ kind } as never);
    await expect(enqueueDurableOutboxWithSettlement({
      store: durableStore,
      enqueue: { lease: lease(), message: row('pending') },
    })).resolves.toEqual({ kind });
    expect(durableStore.readOutbox).not.toHaveBeenCalled();
  });

  it('aborts a pending cross-replica settlement without mutating the outbox row', async () => {
    vi.useFakeTimers();
    try {
      const durableStore = store();
      vi.mocked(durableStore.readOutbox).mockResolvedValue(row('pending'));
      const controller = new AbortController();
      const settlement = waitForDurableOutboxSettlement({
        store: durableStore,
        messageId: 'outbox-1',
        intervalMs: 10,
        signal: controller.signal,
      });
      await Promise.resolve();
      controller.abort(new Error('shutdown deadline'));
      await expect(settlement).rejects.toThrow('shutdown deadline');
      expect(durableStore.markOutboxAmbiguous).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
