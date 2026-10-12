import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableInboxStore, InboxClaim } from '../src/services/durable-coordination.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import {
  durableLarkSessionControlEvent,
  durableLarkSessionControlEventId,
  durableLarkSessionControlPartition,
  durableLarkSessionControlPartitionPrefix,
} from '../src/services/durable-lark-session-control.js';
import { startDurableSessionControlConsumer } from '../src/services/durable-session-control-consumer.js';

const tempDirs: string[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeStore(now: () => number): SqliteDurableCoordinationStore {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-control-consumer-'));
  tempDirs.push(dir);
  return new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now });
}

function rawControl(sessionId: string, stableEventId: string, action: 'close' | 'resume' = 'close') {
  return {
    event_id: stableEventId,
    action: {
      value: { action, session_id: sessionId, root_id: `om_root_${sessionId}` },
    },
    operator: { open_id: 'ou_operator' },
    context: { open_message_id: `om_card_${sessionId}` },
  };
}

function controlEvent(sessionId: string, stableEventId: string, now: number) {
  return durableLarkSessionControlEvent({
    larkAppId: 'cli_test',
    eventId: durableLarkSessionControlEventId('cli_test', stableEventId),
    partitionKey: durableLarkSessionControlPartition('cli_test', sessionId),
    data: rawControl(sessionId, stableEventId),
    now,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable session control consumer', () => {
  it('claims only local owner partitions and leaves other Session controls queued', async () => {
    let now = 10;
    const store = makeStore(() => now);
    await store.enqueueInbox(controlEvent('session-a', 'evt-a', 1));
    await store.enqueueInbox(controlEvent('session-b', 'evt-b', 2));
    const dispatched: string[] = [];
    const ownerB = startDurableSessionControlConsumer({
      store,
      workerId: 'control-b',
      ownedPartitionKeys: () => [
        durableLarkSessionControlPartition('cli_test', 'session-b'),
        durableLarkSessionControlPartition('cli_test', 'session-b'),
      ],
      dispatch: async control => {
        dispatched.push(control.sessionId);
        return { kind: 'settled' };
      },
      concurrency: 1,
      intervalMs: 60_000,
    });
    await ownerB.ready;
    expect(dispatched).toEqual(['session-b']);
    await ownerB.stop();

    now = 11;
    const ownerA = startDurableSessionControlConsumer({
      store,
      workerId: 'control-a',
      ownedPartitionKeys: () => [durableLarkSessionControlPartition('cli_test', 'session-a')],
      dispatch: async control => {
        dispatched.push(control.sessionId);
        return { kind: 'ignored', reason: 'already closed' };
      },
      concurrency: 1,
      intervalMs: 60_000,
    });
    await ownerA.ready;
    expect(dispatched).toEqual(['session-b', 'session-a']);
    await ownerA.stop();
    await store.close();
  });

  it('does not claim anything when this Pod owns no eligible partitions', async () => {
    const store = makeStore(() => 10);
    await store.enqueueInbox(controlEvent('session-a', 'evt-a', 1));
    const dispatch = vi.fn();
    const consumer = startDurableSessionControlConsumer({
      store,
      workerId: 'control-none',
      ownedPartitionKeys: () => [],
      dispatch,
      intervalMs: 60_000,
    });
    await consumer.ready;
    expect(dispatch).not.toHaveBeenCalled();
    await consumer.stop();

    const claim = await store.claimNextInbox({
      workerId: 'proof',
      lane: 'session-control',
      partitionKeys: [durableLarkSessionControlPartition('cli_test', 'session-a')],
      leaseDurationMs: 100,
    });
    expect(claim?.event.eventId).toBe('card.action.trigger:cli_test:evt-a');
    await store.close();
  });

  it('round-robins more than 256 owned partitions through bounded claims', async () => {
    const store = makeStore(() => 10);
    const partitionKeys = Array.from({ length: 300 }, (_, index) =>
      durableLarkSessionControlPartition('cli_test', `session-${index}`));
    await store.enqueueInbox(controlEvent('session-0', 'evt-first', 1));
    await store.enqueueInbox(controlEvent('session-299', 'evt-last', 2));
    const dispatched: string[] = [];
    const errors: unknown[] = [];
    const consumer = startDurableSessionControlConsumer({
      store,
      workerId: 'control-many',
      ownedPartitionKeys: () => partitionKeys,
      dispatch: async control => {
        dispatched.push(control.sessionId);
        return { kind: 'settled' };
      },
      concurrency: 2,
      batchSize: 1,
      intervalMs: 60_000,
      onError: error => errors.push(error),
    });
    await consumer.ready;

    expect(new Set(dispatched)).toEqual(new Set(['session-0', 'session-299']));
    expect(errors).toEqual([]);
    await consumer.stop();
    await store.close();
  });

  it('discovers a canonical control by application prefix after the local owner disappeared', async () => {
    const store = makeStore(() => 10);
    await store.enqueueInbox(controlEvent('session-a', 'evt-a', 1));
    const dispatched: string[] = [];
    const consumer = startDurableSessionControlConsumer({
      store,
      workerId: 'control-failover',
      ownedPartitionKeys: () => [],
      partitionKeyPrefix: durableLarkSessionControlPartitionPrefix('cli_test'),
      dispatch: async control => {
        dispatched.push(control.sessionId);
        return { kind: 'settled' };
      },
      concurrency: 1,
      intervalMs: 60_000,
    });
    await consumer.ready;
    expect(dispatched).toEqual(['session-a']);
    await consumer.stop();
    await store.close();
  });

  it('prefers an exact local owner before application-prefix fallback', async () => {
    const store = makeStore(() => 10);
    await store.enqueueInbox(controlEvent('session-remote', 'evt-remote', 1));
    await store.enqueueInbox(controlEvent('session-local', 'evt-local', 2));
    const dispatched: string[] = [];
    const consumer = startDurableSessionControlConsumer({
      store,
      workerId: 'control-preferred',
      ownedPartitionKeys: () => [
        durableLarkSessionControlPartition('cli_test', 'session-local'),
      ],
      partitionKeyPrefix: durableLarkSessionControlPartitionPrefix('cli_test'),
      dispatch: async control => {
        dispatched.push(control.sessionId);
        return { kind: 'settled' };
      },
      concurrency: 1,
      batchSize: 1,
      intervalMs: 60_000,
    });
    await consumer.ready;
    expect(dispatched).toEqual(['session-local']);
    await consumer.stop();

    const remaining = await store.claimNextInbox({
      workerId: 'proof',
      lane: 'session-control',
      partitionKeyPrefix: durableLarkSessionControlPartitionPrefix('cli_test'),
      leaseDurationMs: 100,
    });
    expect(remaining?.event.eventId).toBe('card.action.trigger:cli_test:evt-remote');
    await store.close();
  });

  it('retries dispatch failures without completing the control row', async () => {
    let now = 10;
    const store = makeStore(() => now);
    await store.enqueueInbox(controlEvent('session-a', 'evt-a', 1));
    const errors: unknown[] = [];
    const consumer = startDurableSessionControlConsumer({
      store,
      workerId: 'control-a',
      ownedPartitionKeys: () => [durableLarkSessionControlPartition('cli_test', 'session-a')],
      dispatch: async () => { throw new Error('canonical control unavailable'); },
      retryDelayMs: 500,
      intervalMs: 60_000,
      concurrency: 1,
      onError: error => errors.push(error),
      now: () => now,
    });
    await consumer.ready;
    expect(errors).toHaveLength(1);
    await consumer.stop();

    now = 509;
    expect(await store.claimNextInbox({
      workerId: 'too-early',
      lane: 'session-control',
      partitionKeys: [durableLarkSessionControlPartition('cli_test', 'session-a')],
      leaseDurationMs: 100,
    })).toBeUndefined();
    now = 510;
    expect(await store.claimNextInbox({
      workerId: 'retry-owner',
      lane: 'session-control',
      partitionKeys: [durableLarkSessionControlPartition('cli_test', 'session-a')],
      leaseDurationMs: 100,
    })).toMatchObject({ attempts: 2 });
    await store.close();
  });

  it('aborts dispatch without completing or retrying after claim ownership is lost', async () => {
    vi.useFakeTimers();
    try {
      const event = controlEvent('session-a', 'evt-a', 1);
      const claim: InboxClaim = {
        event,
        workerId: 'control-a:0',
        claimEpoch: 1,
        claimUntil: 1_000,
        attempts: 1,
      };
      let offered = false;
      const completeInboxClaim = vi.fn(async () => ({ kind: 'applied' as const }));
      const retryInboxClaim = vi.fn(async () => ({ kind: 'applied' as const }));
      const store = {
        claimNextInbox: vi.fn(async () => {
          if (offered) return undefined;
          offered = true;
          return claim;
        }),
        renewInboxClaim: vi.fn(async () => ({ kind: 'stale' as const })),
        completeInboxClaim,
        retryInboxClaim,
      } as unknown as DurableInboxStore;
      const started = deferred<void>();
      let aborted = false;
      const errors: unknown[] = [];
      const consumer = startDurableSessionControlConsumer({
        store,
        workerId: 'control-a',
        ownedPartitionKeys: () => [event.partitionKey],
        dispatch: async (_control, { signal }) => {
          started.resolve();
          await new Promise<void>(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          aborted = signal.aborted;
          return { kind: 'settled' };
        },
        concurrency: 1,
        batchSize: 1,
        intervalMs: 60_000,
        leaseDurationMs: 1_000,
        renewalIntervalMs: 100,
        onError: error => errors.push(error),
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(100);
      await consumer.ready;

      expect(aborted).toBe(true);
      expect(completeInboxClaim).not.toHaveBeenCalled();
      expect(retryInboxClaim).not.toHaveBeenCalled();
      expect(errors.some(error => String(error).includes('renewal lost'))).toBe(true);
      await consumer.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
