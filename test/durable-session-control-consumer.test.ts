import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import {
  durableLarkSessionControlEvent,
  durableLarkSessionControlEventId,
  durableLarkSessionControlPartition,
} from '../src/services/durable-lark-session-control.js';
import { startDurableSessionControlConsumer } from '../src/services/durable-session-control-consumer.js';

const tempDirs: string[] = [];

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
});
