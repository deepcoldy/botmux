import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  DurableJson,
  DurableSessionRecord,
  SessionLease,
  SessionLeaseAcquisition,
  WriteSessionResult,
} from '../src/services/durable-coordination.js';
import {
  createDurableSessionFacade,
  type DurableSessionFacadeStore,
} from '../src/services/durable-session-facade.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeStore() {
  const records = new Map<string, DurableSessionRecord>();
  let epoch = 0;
  const store: DurableSessionFacadeStore = {
    acquireSessionLease: vi.fn(async input => ({
      kind: 'acquired',
      lease: {
        sessionKey: input.sessionKey,
        ownerId: input.ownerId,
        epoch: ++epoch,
        leaseUntil: 60_000,
      },
    })),
    renewSessionLease: vi.fn(),
    releaseSessionLease: vi.fn(async lease => ({ kind: 'applied', lease })),
    readSession: vi.fn(async sessionKey => records.get(sessionKey)),
    writeSession: vi.fn(async input => {
      const current = records.get(input.lease.sessionKey);
      if ((current?.revision ?? null) !== input.expectedRevision) {
        return { kind: 'conflict', current } as WriteSessionResult;
      }
      const record: DurableSessionRecord = {
        sessionKey: input.lease.sessionKey,
        revision: (current?.revision ?? 0) + 1,
        value: input.value,
        updatedAt: 1,
      };
      records.set(input.lease.sessionKey, record);
      return { kind: 'written', record } as WriteSessionResult;
    }),
  };
  return { store, records };
}

describe('durable session facade', () => {
  it('renews retained live-runtime leases and stops renewing after a closed snapshot', async () => {
    vi.useFakeTimers();
    try {
      const { store } = fakeStore();
      vi.mocked(store.renewSessionLease).mockImplementation(async input => ({
        kind: 'applied',
        lease: { ...input.lease, leaseUntil: input.lease.leaseUntil + input.leaseDurationMs },
      }));
      const facade = createDurableSessionFacade({
        store,
        ownerId: 'live-runtime-owner',
        leaseDurationMs: 1_200,
        keepLeaseAlive: value => (value as { status?: string }).status === 'active',
      });

      await expect(facade.writeExact('session-live', { status: 'active' }))
        .resolves.toMatchObject({ kind: 'written' });
      await vi.advanceTimersByTimeAsync(400);
      expect(store.renewSessionLease).toHaveBeenCalledOnce();

      await expect(facade.writeExact('session-live', { status: 'closed' }))
        .resolves.toMatchObject({ kind: 'written' });
      await vi.advanceTimersByTimeAsync(1_200);
      expect(store.renewSessionLease).toHaveBeenCalledOnce();
      await facade.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a stale retained lease exactly once and stops renewing it', async () => {
    vi.useFakeTimers();
    try {
      const { store } = fakeStore();
      vi.mocked(store.renewSessionLease).mockResolvedValue({ kind: 'stale' });
      const onLeaseLost = vi.fn();
      const facade = createDurableSessionFacade({
        store,
        ownerId: 'stale-runtime-owner',
        leaseDurationMs: 1_200,
        keepLeaseAlive: value => (value as { status?: string }).status === 'active',
        onLeaseLost,
      });

      await facade.writeExact('session-stale', { status: 'active' });
      await vi.advanceTimersByTimeAsync(400);
      expect(onLeaseLost).toHaveBeenCalledOnce();
      expect(onLeaseLost).toHaveBeenCalledWith('session-stale', expect.any(Error));
      await vi.advanceTimersByTimeAsync(1_200);
      expect(store.renewSessionLease).toHaveBeenCalledOnce();
      await facade.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a stale renewal result after a foreground write refreshes the lease', async () => {
    vi.useFakeTimers();
    try {
      const { store } = fakeStore();
      const delayedRenewal = deferred<Awaited<ReturnType<typeof store.renewSessionLease>>>();
      vi.mocked(store.renewSessionLease).mockReturnValueOnce(delayedRenewal.promise);
      const onLeaseLost = vi.fn();
      const facade = createDurableSessionFacade({
        store,
        ownerId: 'renew-race-owner',
        leaseDurationMs: 1_200,
        keepLeaseAlive: value => (value as { status?: string }).status === 'active',
        onLeaseLost,
      });

      await facade.writeExact('session-renew-race', { status: 'active', revision: 1 });
      await vi.advanceTimersByTimeAsync(400);
      expect(store.renewSessionLease).toHaveBeenCalledOnce();
      await facade.writeExact('session-renew-race', { status: 'active', revision: 2 });
      delayedRenewal.resolve({ kind: 'stale' });
      await Promise.resolve();

      expect(onLeaseLost).not.toHaveBeenCalled();
      await facade.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a live lease renewing after a Session write throws', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const dir = mkdtempSync(join(tmpdir(), 'botmux-durable-session-renew-error-'));
    const databasePath = join(dir, 'coordination.db');
    const ownerStore = new SqliteDurableCoordinationStore(databasePath, { now: () => Date.now() });
    const peerStore = new SqliteDurableCoordinationStore(databasePath, { now: () => Date.now() });
    const renew = vi.spyOn(ownerStore, 'renewSessionLease');
    const write = vi.spyOn(ownerStore, 'writeSession');
    const facade = createDurableSessionFacade({
      store: ownerStore,
      ownerId: 'renew-after-error-owner',
      leaseDurationMs: 1_200,
      keepLeaseAlive: value => (value as { status?: string }).status === 'active',
    });
    try {
      await expect(facade.writeExact('session-renew-after-error', { status: 'active', revision: 1 }))
        .resolves.toMatchObject({ kind: 'written' });
      await vi.advanceTimersByTimeAsync(400);
      expect(renew).toHaveBeenCalledOnce();

      write.mockRejectedValueOnce(new Error('transient Session write failure'));
      await expect(facade.writeExact(
        'session-renew-after-error',
        { status: 'active', revision: 2 },
      )).rejects.toThrow('transient Session write failure');

      await vi.advanceTimersByTimeAsync(1_600);
      expect(renew.mock.calls.length).toBeGreaterThan(1);
      await expect(peerStore.acquireSessionLease({
        sessionKey: 'session-renew-after-error',
        ownerId: 'renew-after-error-peer',
        leaseDurationMs: 1_200,
      })).resolves.toMatchObject({ kind: 'occupied', ownerId: 'renew-after-error-owner' });
    } finally {
      await facade.stop();
      await ownerStore.close();
      await peerStore.close();
      rmSync(dir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it('keeps a live lease renewing after a conflicting Session write', async () => {
    vi.useFakeTimers();
    try {
      const { store } = fakeStore();
      vi.mocked(store.writeSession).mockResolvedValue({
        kind: 'conflict',
        current: {
          sessionKey: 'session-live-conflict',
          revision: 2,
          value: { status: 'active' },
          updatedAt: 2,
        },
      });
      vi.mocked(store.renewSessionLease).mockImplementation(async input => ({
        kind: 'applied',
        lease: { ...input.lease, leaseUntil: input.lease.leaseUntil + input.leaseDurationMs },
      }));
      const facade = createDurableSessionFacade({
        store,
        ownerId: 'live-conflict-owner',
        leaseDurationMs: 1_200,
        keepLeaseAlive: value => (value as { status?: string }).status === 'active',
      });

      await expect(facade.writeExact('session-live-conflict', { status: 'active' }))
        .resolves.toMatchObject({ kind: 'conflict' });
      await vi.advanceTimersByTimeAsync(400);
      expect(store.renewSessionLease).toHaveBeenCalledOnce();
      await facade.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports lease loss when a live Session write returns stale lease', async () => {
    const { store } = fakeStore();
    vi.mocked(store.writeSession).mockResolvedValue({ kind: 'stale_lease' });
    const onLeaseLost = vi.fn();
    const facade = createDurableSessionFacade({
      store,
      ownerId: 'live-stale-write-owner',
      keepLeaseAlive: value => (value as { status?: string }).status === 'active',
      onLeaseLost,
    });

    await expect(facade.writeExact('session-live-stale-write', { status: 'active' }))
      .resolves.toEqual({ kind: 'stale_lease', coalescedCount: 1 });
    expect(onLeaseLost).toHaveBeenCalledOnce();
    expect(onLeaseLost).toHaveBeenCalledWith(
      'session-live-stale-write',
      expect.objectContaining({
        message: expect.stringContaining('lease was stale when committing the Session write'),
      }),
    );
    await facade.stop();
  });

  it('releases a write-scoped lease when a Session read throws', async () => {
    const { store } = fakeStore();
    vi.mocked(store.readSession).mockRejectedValueOnce(new Error('transient Session read failure'));
    const facade = createDurableSessionFacade({ store, ownerId: 'release-after-error-owner' });

    await expect(facade.writeExact('session-release-after-error', { status: 'active' }))
      .rejects.toThrow('transient Session read failure');
    expect(store.releaseSessionLease).toHaveBeenCalledOnce();
    expect(store.releaseSessionLease).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'session-release-after-error',
      ownerId: 'release-after-error-owner',
    }));
    await facade.stop();
  });

  it('orders an explicit lease release after earlier writes on the same lane', async () => {
    const { store } = fakeStore();
    const blockedWrite = deferred<WriteSessionResult>();
    vi.mocked(store.writeSession).mockReturnValueOnce(blockedWrite.promise);
    const facade = createDurableSessionFacade({ store, ownerId: 'release-owner' });

    const write = facade.writeExact('session-release', { status: 'active' });
    await vi.waitFor(() => expect(store.writeSession).toHaveBeenCalledOnce());
    const release = facade.releaseLease('session-release');
    expect(store.releaseSessionLease).not.toHaveBeenCalled();
    blockedWrite.resolve({
      kind: 'written',
      record: {
        sessionKey: 'session-release',
        revision: 1,
        value: { status: 'active' },
        updatedAt: 1,
      },
    });

    await expect(write).resolves.toMatchObject({ kind: 'written' });
    await expect(release).resolves.toBe(true);
    expect(store.releaseSessionLease).toHaveBeenCalledOnce();
    await facade.stop();
  });

  it('uses canonical equality across a real SQLite round trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-durable-session-facade-'));
    const store = new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now: () => 1 });
    const facade = createDurableSessionFacade({
      store,
      ownerId: 'facade-real-store',
      leaseDurationMs: 10_000,
    });
    try {
      await expect(facade.write('session-real', { z: 1, a: 2 })).resolves.toMatchObject({
        kind: 'written', record: { revision: 1 },
      });
      await expect(facade.write('session-real', { z: 1, a: 2 })).resolves.toMatchObject({
        kind: 'unchanged', record: { revision: 1 },
      });
      await expect(facade.write('session-real', { z: 2, a: 2 })).resolves.toMatchObject({
        kind: 'written', record: { revision: 2 },
      });
      await expect(store.readSession('session-real')).resolves.toMatchObject({
        revision: 2, value: { a: 2, z: 2 },
      });
      await expect(facade.stop()).resolves.toEqual({
        kind: 'stopped', pendingSessionKeys: [], unreleasedSessionKeys: [],
      });
    } finally {
      facade.terminate();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('acquires, reads, CAS-writes, skips unchanged values, and releases on stop', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({
      store,
      ownerId: 'facade-boot-1',
      leaseDurationMs: 10_000,
    });

    await expect(facade.write('session-a', { status: 'active' })).resolves.toMatchObject({
      kind: 'written',
      lease: { sessionKey: 'session-a', ownerId: 'facade-boot-1', epoch: 1 },
      record: { revision: 1 },
      coalescedCount: 1,
    });
    await expect(facade.write('session-a', { status: 'active' })).resolves.toMatchObject({
      kind: 'unchanged',
      record: { revision: 1 },
    });
    expect(store.acquireSessionLease).toHaveBeenLastCalledWith({
      sessionKey: 'session-a',
      ownerId: 'facade-boot-1',
      leaseDurationMs: 10_000,
    });
    expect(store.writeSession).toHaveBeenCalledOnce();

    await expect(facade.stop()).resolves.toEqual({
      kind: 'stopped',
      pendingSessionKeys: [],
      unreleasedSessionKeys: [],
    });
    expect(store.releaseSessionLease).toHaveBeenCalledOnce();
    await expect(facade.write('session-a', { status: 'closed' })).resolves.toEqual({
      kind: 'stopped',
      coalescedCount: 1,
    });
  });

  it('serializes one key and coalesces queued updates to the latest value', async () => {
    const { store, records } = fakeStore();
    const firstAcquire = deferred<SessionLeaseAcquisition>();
    const defaultAcquire = store.acquireSessionLease.getMockImplementation();
    vi.mocked(store.acquireSessionLease)
      .mockImplementationOnce(() => firstAcquire.promise)
      .mockImplementation(defaultAcquire!);
    const facade = createDurableSessionFacade({ store, ownerId: 'facade-boot-2' });

    const first = facade.write('session-a', { order: 1 });
    const second = facade.write('session-a', { order: 2 });
    const third = facade.write('session-a', { order: 3 });
    firstAcquire.resolve({
      kind: 'acquired',
      lease: {
        sessionKey: 'session-a',
        ownerId: 'facade-boot-2',
        epoch: 1,
        leaseUntil: 60_000,
      },
    });

    await expect(first).resolves.toMatchObject({ kind: 'written', coalescedCount: 1 });
    await expect(second).resolves.toMatchObject({ kind: 'written', coalescedCount: 2 });
    await expect(third).resolves.toMatchObject({ kind: 'written', coalescedCount: 2 });
    expect(store.writeSession).toHaveBeenCalledTimes(2);
    expect(records.get('session-a')).toMatchObject({ revision: 2, value: { order: 3 } });
    await facade.stop();
  });

  it('preserves every exact admission write in FIFO order and returns its lease proof', async () => {
    const { store, records } = fakeStore();
    const firstAcquire = deferred<SessionLeaseAcquisition>();
    const defaultAcquire = store.acquireSessionLease.getMockImplementation();
    vi.mocked(store.acquireSessionLease)
      .mockImplementationOnce(() => firstAcquire.promise)
      .mockImplementation(defaultAcquire!);
    const facade = createDurableSessionFacade({ store, ownerId: 'facade-exact-boot' });

    const first = facade.writeExact('session-a', { event: 1 });
    const second = facade.writeExact('session-a', { event: 2 });
    const third = facade.writeExact('session-a', { event: 3 });
    firstAcquire.resolve({
      kind: 'acquired',
      lease: {
        sessionKey: 'session-a',
        ownerId: 'facade-exact-boot',
        epoch: 1,
        leaseUntil: 60_000,
      },
    });

    await expect(first).resolves.toMatchObject({
      kind: 'written',
      lease: { epoch: 1 },
      record: { revision: 1, value: { event: 1 } },
      coalescedCount: 1,
    });
    await expect(second).resolves.toMatchObject({
      kind: 'written',
      record: { revision: 2, value: { event: 2 } },
      coalescedCount: 1,
    });
    await expect(third).resolves.toMatchObject({
      kind: 'written',
      record: { revision: 3, value: { event: 3 } },
      coalescedCount: 1,
    });
    expect(store.writeSession).toHaveBeenCalledTimes(3);
    expect(records.get('session-a')).toMatchObject({ revision: 3, value: { event: 3 } });
    await facade.stop();
  });

  it('builds exact FIFO values from the leased current record without a read-merge-write gap', async () => {
    const { store, records } = fakeStore();
    const firstAcquire = deferred<SessionLeaseAcquisition>();
    const defaultAcquire = store.acquireSessionLease.getMockImplementation();
    vi.mocked(store.acquireSessionLease)
      .mockImplementationOnce(() => firstAcquire.promise)
      .mockImplementation(defaultAcquire!);
    const facade = createDurableSessionFacade({ store, ownerId: 'facade-current-boot' });

    const first = facade.writeExactFromCurrent('session-a', current => ({
      events: [...((current?.value as { events?: number[] } | undefined)?.events ?? []), 1],
    }));
    const second = facade.writeExactFromCurrent('session-a', current => ({
      events: [...((current?.value as { events?: number[] } | undefined)?.events ?? []), 2],
    }));
    firstAcquire.resolve({
      kind: 'acquired',
      lease: {
        sessionKey: 'session-a',
        ownerId: 'facade-current-boot',
        epoch: 1,
        leaseUntil: 60_000,
      },
    });

    await expect(first).resolves.toMatchObject({
      kind: 'written',
      record: { revision: 1, value: { events: [1] } },
    });
    await expect(second).resolves.toMatchObject({
      kind: 'written',
      record: { revision: 2, value: { events: [1, 2] } },
    });
    expect(records.get('session-a')).toMatchObject({
      revision: 2,
      value: { events: [1, 2] },
    });
    await facade.stop();
  });

  it('surfaces occupied, conflict, and stale lease results without retrying blindly', async () => {
    const occupied = fakeStore();
    vi.mocked(occupied.store.acquireSessionLease).mockResolvedValue({
      kind: 'occupied',
      ownerId: 'other-boot',
      epoch: 7,
      leaseUntil: 90_000,
    });
    const occupiedFacade = createDurableSessionFacade({
      store: occupied.store,
      ownerId: 'this-boot',
    });
    await expect(occupiedFacade.write('session-a', null)).resolves.toMatchObject({
      kind: 'occupied',
      ownerId: 'other-boot',
      epoch: 7,
    });

    const conflict = fakeStore();
    vi.mocked(conflict.store.writeSession).mockResolvedValue({
      kind: 'conflict',
      current: {
        sessionKey: 'session-b',
        revision: 4,
        value: { current: true },
        updatedAt: 4,
      },
    });
    const conflictFacade = createDurableSessionFacade({
      store: conflict.store,
      ownerId: 'this-boot',
    });
    await expect(conflictFacade.write('session-b', { next: true })).resolves.toMatchObject({
      kind: 'conflict',
      current: { revision: 4 },
    });

    const stale = fakeStore();
    vi.mocked(stale.store.writeSession).mockResolvedValue({ kind: 'stale_lease' });
    const staleFacade = createDurableSessionFacade({
      store: stale.store,
      ownerId: 'this-boot',
    });
    await expect(staleFacade.write('session-c', { next: true })).resolves.toEqual({
      kind: 'stale_lease',
      coalescedCount: 1,
    });

    await occupiedFacade.stop();
    await conflictFacade.stop();
    await staleFacade.stop();
  });

  it('keeps different session keys independent', async () => {
    const { store } = fakeStore();
    const blocked = deferred<SessionLeaseAcquisition>();
    vi.mocked(store.acquireSessionLease).mockImplementation(async input => {
      if (input.sessionKey === 'blocked') return await blocked.promise;
      return {
        kind: 'acquired',
        lease: {
          sessionKey: input.sessionKey,
          ownerId: input.ownerId,
          epoch: 1,
          leaseUntil: 60_000,
        },
      };
    });
    const facade = createDurableSessionFacade({ store, ownerId: 'facade-boot-3' });

    const first = facade.write('blocked', { key: 1 });
    await expect(facade.write('free', { key: 2 })).resolves.toMatchObject({ kind: 'written' });
    blocked.resolve({
      kind: 'acquired',
      lease: {
        sessionKey: 'blocked',
        ownerId: 'facade-boot-3',
        epoch: 1,
        leaseUntil: 60_000,
      },
    });
    await expect(first).resolves.toMatchObject({ kind: 'written' });
    await facade.stop();
  });

  it('returns a bounded timeout when an in-flight provider call cannot settle', async () => {
    vi.useFakeTimers();
    try {
      const { store } = fakeStore();
      const blocked = deferred<SessionLeaseAcquisition>();
      vi.mocked(store.acquireSessionLease).mockReturnValue(blocked.promise);
      const facade = createDurableSessionFacade({ store, ownerId: 'facade-boot-4' });
      const write = facade.write('session-a', { value: true });
      const stopping = facade.stop(25);
      await vi.advanceTimersByTimeAsync(25);
      await expect(stopping).resolves.toEqual({
        kind: 'timed_out',
        pendingSessionKeys: ['session-a'],
        unreleasedSessionKeys: [],
      });
      facade.terminate();
      blocked.resolve({
        kind: 'acquired',
        lease: {
          sessionKey: 'session-a',
          ownerId: 'facade-boot-4',
          epoch: 1,
          leaseUntil: 60_000,
        },
      });
      await expect(write).resolves.toEqual({ kind: 'stopped', coalescedCount: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops queued writes and releases an in-flight lease after drain timeout', async () => {
    const { store } = fakeStore();
    const blockedWrite = deferred<WriteSessionResult>();
    const defaultWrite = store.writeSession.getMockImplementation();
    vi.mocked(store.writeSession)
      .mockImplementationOnce(() => blockedWrite.promise)
      .mockImplementation(defaultWrite!);
    const facade = createDurableSessionFacade({ store, ownerId: 'facade-stop-race' });

    const first = facade.write('session-stop', { order: 1 });
    await vi.waitFor(() => expect(store.writeSession).toHaveBeenCalledOnce());
    const second = facade.write('session-stop', { order: 2 });
    const stopping = facade.stop(25);

    await expect(stopping).resolves.toEqual({
      kind: 'timed_out',
      pendingSessionKeys: ['session-stop'],
      unreleasedSessionKeys: [],
    });
    blockedWrite.resolve({
      kind: 'written',
      record: {
        sessionKey: 'session-stop', revision: 1, value: { order: 1 }, updatedAt: 1,
      },
    });

    await expect(first).resolves.toEqual({ kind: 'stopped', coalescedCount: 1 });
    await expect(second).resolves.toEqual({ kind: 'stopped', coalescedCount: 1 });
    expect(store.acquireSessionLease).toHaveBeenCalledOnce();
    expect(store.releaseSessionLease).toHaveBeenCalledTimes(2);
    expect(store.releaseSessionLease).toHaveBeenCalledWith({
      sessionKey: 'session-stop',
      ownerId: 'facade-stop-race',
      epoch: 1,
      leaseUntil: 60_000,
    });
  });

  it('validates the stop budget before closing admission', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'facade-stop-validation' });

    expect(() => facade.stop(-1)).toThrow(/timeoutMs/);
    await expect(facade.writeExact('session-a', { still: 'accepted' }))
      .resolves.toMatchObject({ kind: 'written', record: { revision: 1 } });
    await facade.stop();
  });
});
