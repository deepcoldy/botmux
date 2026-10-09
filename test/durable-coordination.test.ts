import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DURABLE_COORDINATION_CONTRACT_VERSION,
  DURABLE_INBOX_LANE_LARK_MESSAGE,
  DURABLE_INBOX_LANE_SESSION_CONTROL,
  type SessionLease,
} from '../src/services/durable-coordination.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';

const tempDirs: string[] = [];

function makeStore(now: () => number, name = 'coordination.db'): SqliteDurableCoordinationStore {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-durable-coordination-'));
  tempDirs.push(dir);
  return new SqliteDurableCoordinationStore(join(dir, name), { now });
}

function acquired(result: Awaited<ReturnType<SqliteDurableCoordinationStore['acquireSessionLease']>>): SessionLease {
  expect(result.kind).toBe('acquired');
  if (result.kind !== 'acquired') throw new Error('expected acquired lease');
  return result.lease;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SQLite durable coordination contract', () => {
  it('pins the lane-aware coordination contract version', () => {
    expect(DURABLE_COORDINATION_CONTRACT_VERSION).toBe(2);
  });

  it('uses monotonic session epochs and fences stale state writers', async () => {
    let now = 100;
    const store = makeStore(() => now);
    const first = acquired(await store.acquireSessionLease({
      sessionKey: 'session-1', ownerId: 'worker-a', leaseDurationMs: 50,
    }));
    expect(first).toEqual({ sessionKey: 'session-1', ownerId: 'worker-a', epoch: 1, leaseUntil: 150 });

    now = 120;
    expect(await store.acquireSessionLease({
      sessionKey: 'session-1', ownerId: 'worker-b', leaseDurationMs: 50,
    })).toMatchObject({ kind: 'occupied', ownerId: 'worker-a', epoch: 1 });

    const created = await store.writeSession({
      lease: first, expectedRevision: null, value: { status: 'active' },
    });
    expect(created).toMatchObject({ kind: 'written', record: { revision: 1 } });
    expect(await store.writeSession({
      lease: first, expectedRevision: null, value: { status: 'duplicate-create' },
    })).toMatchObject({ kind: 'conflict', current: { revision: 1 } });

    now = 150;
    const takeover = acquired(await store.acquireSessionLease({
      sessionKey: 'session-1', ownerId: 'worker-b', leaseDurationMs: 50,
    }));
    expect(takeover.epoch).toBe(2);
    now = 151;
    expect(await store.writeSession({
      lease: first, expectedRevision: 1, value: { status: 'late' },
    })).toEqual({ kind: 'stale_lease' });

    expect(await store.writeSession({
      lease: takeover, expectedRevision: 1, value: { status: 'owned-by-b' },
    })).toMatchObject({ kind: 'written', record: { revision: 2, value: { status: 'owned-by-b' } } });
    now = 160;
    expect(await store.releaseSessionLease(takeover)).toMatchObject({
      kind: 'applied', lease: { leaseUntil: 160 },
    });
    const reacquired = acquired(await store.acquireSessionLease({
      sessionKey: 'session-1', ownerId: 'worker-b', leaseDurationMs: 50,
    }));
    expect(reacquired.epoch).toBe(3);
    await store.close();
  });

  it('rejects stale lease renewal and both Session CAS mismatch legs', async () => {
    let now = 1;
    const store = makeStore(() => now);
    const first = acquired(await store.acquireSessionLease({
      sessionKey: 'session-existing', ownerId: 'worker-a', leaseDurationMs: 10,
    }));
    await store.writeSession({ lease: first, expectedRevision: null, value: { revision: 1 } });
    expect(await store.writeSession({
      lease: first, expectedRevision: 2, value: { revision: 2 },
    })).toMatchObject({ kind: 'conflict', current: { revision: 1 } });

    const missing = acquired(await store.acquireSessionLease({
      sessionKey: 'session-missing', ownerId: 'worker-a', leaseDurationMs: 10,
    }));
    expect(await store.writeSession({
      lease: missing, expectedRevision: 1, value: { impossible: true },
    })).toEqual({ kind: 'conflict' });

    now = 11;
    expect(await store.renewSessionLease({ lease: first, leaseDurationMs: 10 }))
      .toEqual({ kind: 'stale' });
    const takeover = acquired(await store.acquireSessionLease({
      sessionKey: 'session-existing', ownerId: 'worker-b', leaseDurationMs: 10,
    }));
    expect(takeover.epoch).toBe(2);
    expect(await store.renewSessionLease({ lease: first, leaseDurationMs: 10 }))
      .toEqual({ kind: 'stale' });
    now = 12;
    expect(await store.renewSessionLease({ lease: takeover, leaseDurationMs: 10 }))
      .toMatchObject({ kind: 'applied', lease: { ownerId: 'worker-b', epoch: 2, leaseUntil: 22 } });
    await store.close();
  });

  it('deduplicates inbox events and serializes each partition without blocking others', async () => {
    let now = 10;
    const store = makeStore(() => now);
    expect(await store.enqueueInbox({
      eventId: 'event-1', partitionKey: 'chat-a', payload: { b: 2, a: 1 }, visibleAt: 0, createdAt: 1,
    })).toEqual({ kind: 'inserted' });
    expect(await store.enqueueInbox({
      eventId: 'event-1', partitionKey: 'chat-a', payload: { a: 1, b: 2 }, visibleAt: 9, createdAt: 9,
    })).toEqual({ kind: 'duplicate' });
    expect(await store.enqueueInbox({
      eventId: 'event-1', partitionKey: 'chat-a', payload: { a: 9 }, visibleAt: 0, createdAt: 1,
    })).toEqual({ kind: 'conflict' });
    await store.enqueueInbox({
      eventId: 'event-2', partitionKey: 'chat-a', payload: { n: 2 }, visibleAt: 0, createdAt: 2,
    });
    await store.enqueueInbox({
      eventId: 'event-3', partitionKey: 'chat-b', payload: { n: 3 }, visibleAt: 0, createdAt: 3,
    });

    const first = await store.claimNextInbox({ workerId: 'worker-a', leaseDurationMs: 10 });
    expect(first).toMatchObject({ event: { eventId: 'event-1' }, attempts: 1, claimEpoch: 1 });
    const parallel = await store.claimNextInbox({ workerId: 'worker-b', leaseDurationMs: 10 });
    expect(parallel).toMatchObject({ event: { eventId: 'event-3' } });
    expect(await store.claimNextInbox({ workerId: 'worker-c', leaseDurationMs: 10 })).toBeUndefined();

    now = 11;
    expect(await store.completeInboxClaim(parallel!)).toEqual({ kind: 'applied' });
    now = 20;
    const reclaimed = await store.claimNextInbox({ workerId: 'worker-b', leaseDurationMs: 10 });
    expect(reclaimed).toMatchObject({
      event: { eventId: 'event-1' }, workerId: 'worker-b', attempts: 2, claimEpoch: 2,
    });
    now = 21;
    expect(await store.completeInboxClaim(first!)).toEqual({ kind: 'stale' });
    expect(await store.completeInboxClaim(reclaimed!)).toEqual({ kind: 'applied' });
    expect(await store.claimNextInbox({ workerId: 'worker-c', leaseDurationMs: 10 }))
      .toMatchObject({ event: { eventId: 'event-2' } });
    await store.close();
  });

  it('isolates inbox lanes and lets an owner claim only its local partitions', async () => {
    const store = makeStore(() => 10);
    await store.enqueueInbox({
      eventId: 'message-a', lane: DURABLE_INBOX_LANE_LARK_MESSAGE,
      partitionKey: 'session-a', payload: { type: 'message' }, visibleAt: 0, createdAt: 1,
    });
    await store.enqueueInbox({
      eventId: 'control-a', lane: DURABLE_INBOX_LANE_SESSION_CONTROL,
      partitionKey: 'session-a', payload: { action: 'close' }, visibleAt: 0, createdAt: 2,
    });
    await store.enqueueInbox({
      eventId: 'control-b', lane: DURABLE_INBOX_LANE_SESSION_CONTROL,
      partitionKey: 'session-b', payload: { action: 'resume' }, visibleAt: 0, createdAt: 3,
    });

    expect(await store.claimNextInbox({
      workerId: 'control-none', lane: DURABLE_INBOX_LANE_SESSION_CONTROL,
      partitionKeys: [], leaseDurationMs: 20,
    })).toBeUndefined();
    const message = await store.claimNextInbox({
      workerId: 'message-worker', lane: DURABLE_INBOX_LANE_LARK_MESSAGE,
      leaseDurationMs: 20,
    });
    expect(message).toMatchObject({
      event: { eventId: 'message-a', lane: DURABLE_INBOX_LANE_LARK_MESSAGE },
    });
    const controlB = await store.claimNextInbox({
      workerId: 'owner-b', lane: DURABLE_INBOX_LANE_SESSION_CONTROL,
      partitionKeys: ['session-b'], leaseDurationMs: 20,
    });
    expect(controlB).toMatchObject({
      event: { eventId: 'control-b', lane: DURABLE_INBOX_LANE_SESSION_CONTROL },
    });
    const controlA = await store.claimNextInbox({
      workerId: 'owner-a', lane: DURABLE_INBOX_LANE_SESSION_CONTROL,
      partitionKeys: ['session-a', 'session-a'], leaseDurationMs: 20,
    });
    expect(controlA).toMatchObject({ event: { eventId: 'control-a' } });
    await store.close();
  });

  it('orders one partition by store insertion sequence instead of client timestamps or ids', async () => {
    let now = 10;
    const store = makeStore(() => now);
    await store.enqueueInbox({
      eventId: 'event-z-first', partitionKey: 'chat-a', payload: { order: 1 },
      visibleAt: 0, createdAt: 9_000,
    });
    await store.enqueueInbox({
      eventId: 'event-a-second', partitionKey: 'chat-a', payload: { order: 2 },
      visibleAt: 0, createdAt: 1,
    });

    const first = await store.claimNextInbox({ workerId: 'worker-a', leaseDurationMs: 20 });
    expect(first?.event.eventId).toBe('event-z-first');
    expect(await store.claimNextInbox({ workerId: 'worker-b', leaseDurationMs: 20 })).toBeUndefined();
    now = 11;
    expect(await store.completeInboxClaim(first!)).toEqual({ kind: 'applied' });
    const second = await store.claimNextInbox({ workerId: 'worker-b', leaseDurationMs: 20 });
    expect(second?.event.eventId).toBe('event-a-second');
    await store.close();
  });

  it('backfills deterministic inbox and outbox sequence rows when order tables are missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-durable-sequence-migration-'));
    tempDirs.push(dir);
    const path = join(dir, 'coordination.db');
    const first = new SqliteDurableCoordinationStore(path, { now: () => 10 });
    await first.enqueueInbox({
      eventId: 'legacy-b', partitionKey: 'chat-a', payload: { order: 2 }, visibleAt: 0, createdAt: 2,
    });
    await first.enqueueInbox({
      eventId: 'legacy-a', partitionKey: 'chat-a', payload: { order: 1 }, visibleAt: 0, createdAt: 1,
    });
    const lease = acquired(await first.acquireSessionLease({
      sessionKey: 'legacy-session', ownerId: 'legacy-worker', leaseDurationMs: 100,
    }));
    await first.enqueueOutbox({
      lease,
      message: {
        messageId: 'legacy-outbox-b', sessionKey: 'legacy-session', payload: { order: 2 },
        visibleAt: 0, createdAt: 2,
      },
    });
    await first.enqueueOutbox({
      lease,
      message: {
        messageId: 'legacy-outbox-a', sessionKey: 'legacy-session', payload: { order: 1 },
        visibleAt: 0, createdAt: 1,
      },
    });
    await first.close();

    const raw = openDatabaseSyncOrThrow(path);
    raw.exec('DROP TABLE durable_inbox_order; DROP TABLE durable_outbox_order;');
    raw.close();

    const reopened = new SqliteDurableCoordinationStore(path, { now: () => 10 });
    const claim = await reopened.claimNextInbox({ workerId: 'worker-a', leaseDurationMs: 20 });
    expect(claim?.event.eventId).toBe('legacy-a');
    const reservation = await reopened.reserveNextOutbox({ workerId: 'sender-a', leaseDurationMs: 20 });
    expect(reservation?.record.messageId).toBe('legacy-outbox-a');
    await reopened.close();
  });

  it('upgrades version 1 inbox rows into the default Lark message lane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-durable-lane-migration-'));
    tempDirs.push(dir);
    const path = join(dir, 'coordination.db');
    const first = new SqliteDurableCoordinationStore(path, { now: () => 10 });
    await first.enqueueInbox({
      eventId: 'legacy-message', partitionKey: 'chat-a', payload: {}, visibleAt: 0, createdAt: 1,
    });
    await first.close();

    const raw = openDatabaseSyncOrThrow(path);
    raw.exec('DROP INDEX durable_inbox_lane_claim_idx;');
    raw.exec('DROP INDEX durable_inbox_lane_partition_claim_idx;');
    raw.exec('ALTER TABLE durable_inbox DROP COLUMN lane;');
    raw.prepare(
      'UPDATE durable_coordination_meta SET schema_version = 1 WHERE singleton = 1',
    ).run();
    raw.close();

    const reopened = new SqliteDurableCoordinationStore(path, { now: () => 10 });
    const claim = await reopened.claimNextInbox({
      workerId: 'message-worker',
      lane: DURABLE_INBOX_LANE_LARK_MESSAGE,
      leaseDurationMs: 20,
    });
    expect(claim).toMatchObject({
      event: { eventId: 'legacy-message', lane: DURABLE_INBOX_LANE_LARK_MESSAGE },
    });
    await reopened.close();
  });

  it('retries claimed inbox work only after the requested visibility time', async () => {
    let now = 1;
    const store = makeStore(() => now);
    await store.enqueueInbox({
      eventId: 'event-retry', partitionKey: 'chat-a', payload: {}, visibleAt: 0, createdAt: 1,
    });
    await store.enqueueInbox({
      eventId: 'event-later', partitionKey: 'chat-a', payload: {}, visibleAt: 0, createdAt: 2,
    });
    const claim = await store.claimNextInbox({ workerId: 'worker-a', leaseDurationMs: 20 });
    now = 2;
    expect(await store.retryInboxClaim({ claim: claim!, visibleAt: 30 })).toEqual({ kind: 'applied' });
    now = 29;
    expect(await store.claimNextInbox({ workerId: 'worker-b', leaseDurationMs: 20 })).toBeUndefined();
    now = 30;
    const retried = await store.claimNextInbox({ workerId: 'worker-b', leaseDurationMs: 20 });
    expect(retried).toMatchObject({ event: { eventId: 'event-retry' }, attempts: 2 });
    expect(await store.claimNextInbox({ workerId: 'worker-c', leaseDurationMs: 20 })).toBeUndefined();
    now = 31;
    expect(await store.completeInboxClaim(retried!)).toEqual({ kind: 'applied' });
    expect(await store.claimNextInbox({ workerId: 'worker-c', leaseDurationMs: 20 }))
      .toMatchObject({ event: { eventId: 'event-later' } });
    await store.close();
  });

  it('rejects inbox renewal after expiry or takeover', async () => {
    let now = 1;
    const store = makeStore(() => now);
    await store.enqueueInbox({
      eventId: 'event-renew', partitionKey: 'chat-a', payload: {}, visibleAt: 0, createdAt: 1,
    });
    const first = await store.claimNextInbox({ workerId: 'worker-a', leaseDurationMs: 10 });
    if (!first) throw new Error('expected first inbox claim');
    now = 11;
    expect(await store.renewInboxClaim({ claim: first, leaseDurationMs: 10 }))
      .toEqual({ kind: 'stale' });
    const takeover = await store.claimNextInbox({ workerId: 'worker-b', leaseDurationMs: 10 });
    if (!takeover) throw new Error('expected inbox takeover');
    expect(takeover.claimEpoch).toBe(2);
    expect(await store.renewInboxClaim({ claim: first, leaseDurationMs: 10 }))
      .toEqual({ kind: 'stale' });
    now = 12;
    expect(await store.renewInboxClaim({ claim: takeover, leaseDurationMs: 10 }))
      .toMatchObject({ kind: 'applied', claim: { workerId: 'worker-b', claimEpoch: 2, claimUntil: 22 } });
    await store.close();
  });

  it('fences stale inbox tokens after the same worker reclaims an expired event', async () => {
    let now = 1;
    const store = makeStore(() => now);
    await store.enqueueInbox({
      eventId: 'event-same-worker-reclaim', partitionKey: 'chat-a', payload: {}, visibleAt: 0, createdAt: 1,
    });
    const first = await store.claimNextInbox({ workerId: 'worker-a', leaseDurationMs: 10 });
    if (!first) throw new Error('expected first inbox claim');

    now = 11;
    const reclaimed = await store.claimNextInbox({ workerId: 'worker-a', leaseDurationMs: 10 });
    if (!reclaimed) throw new Error('expected same-worker inbox reclaim');
    expect(reclaimed).toMatchObject({ workerId: 'worker-a', claimEpoch: 2, attempts: 2, claimUntil: 21 });

    now = 12;
    expect(await store.renewInboxClaim({ claim: first, leaseDurationMs: 10 }))
      .toEqual({ kind: 'stale' });
    expect(await store.completeInboxClaim(first)).toEqual({ kind: 'stale' });
    expect(await store.retryInboxClaim({ claim: first, visibleAt: 30 }))
      .toEqual({ kind: 'stale' });

    const renewed = await store.renewInboxClaim({ claim: reclaimed, leaseDurationMs: 10 });
    expect(renewed).toMatchObject({
      kind: 'applied', claim: { workerId: 'worker-a', claimEpoch: 2, claimUntil: 22 },
    });
    if (renewed.kind !== 'applied') throw new Error('expected reclaimed inbox renewal');
    expect(await store.completeInboxClaim(renewed.claim)).toEqual({ kind: 'applied' });
    await store.close();
  });

  it('fences outbox creation and keeps a stable message id across safe retries', async () => {
    let now = 100;
    const store = makeStore(() => now);
    const lease = acquired(await store.acquireSessionLease({
      sessionKey: 'session-1', ownerId: 'worker-a', leaseDurationMs: 50,
    }));
    const message = {
      messageId: 'message-1', sessionKey: 'session-1', payload: { text: 'hello' }, visibleAt: 100, createdAt: 100,
    } as const;
    now = 101;
    expect(await store.enqueueOutbox({ lease, message })).toEqual({ kind: 'inserted' });
    now = 102;
    expect(await store.enqueueOutbox({ lease, message })).toEqual({ kind: 'duplicate' });
    expect(await store.enqueueOutbox({
      lease, message: { ...message, payload: { text: 'changed' } },
    })).toEqual({ kind: 'conflict' });
    expect(await store.enqueueOutbox({
      lease,
      message: { ...message, messageId: 'message-2', payload: { text: 'second' }, createdAt: 101 },
    })).toEqual({ kind: 'inserted' });

    const reservation = await store.reserveNextOutbox({ workerId: 'sender-a', leaseDurationMs: 20 });
    now = 103;
    const firstAttempt = await store.beginOutboxAttempt({ reservation: reservation! });
    expect(firstAttempt).toMatchObject({ kind: 'applied', attempt: { attempt: 1 } });
    if (firstAttempt.kind !== 'applied') throw new Error('expected first attempt');
    now = 104;
    expect(await store.retryOutboxAttempt({
      attempt: firstAttempt.attempt, visibleAt: 130, error: 'connection refused before dispatch',
    })).toMatchObject({ kind: 'applied', record: { state: 'pending', attempts: 1 } });
    now = 129;
    expect(await store.reserveNextOutbox({ workerId: 'sender-b', leaseDurationMs: 20 })).toBeUndefined();

    now = 130;
    const retried = await store.reserveNextOutbox({ workerId: 'sender-b', leaseDurationMs: 20 });
    now = 131;
    const secondAttempt = await store.beginOutboxAttempt({ reservation: retried! });
    expect(secondAttempt).toMatchObject({ kind: 'applied', attempt: { attempt: 2 } });
    if (secondAttempt.kind !== 'applied') throw new Error('expected second attempt');
    now = 132;
    expect(await store.completeOutboxAttempt({
      attempt: secondAttempt.attempt, receipt: { platformMessageId: 'om_1' },
    })).toMatchObject({
      kind: 'applied',
      record: { state: 'delivered', attempts: 2, receipt: { platformMessageId: 'om_1' } },
    });
    const secondMessage = await store.reserveNextOutbox({ workerId: 'sender-c', leaseDurationMs: 20 });
    expect(secondMessage).toMatchObject({ record: { messageId: 'message-2' } });
    now = 133;
    const secondMessageAttempt = await store.beginOutboxAttempt({ reservation: secondMessage! });
    if (secondMessageAttempt.kind !== 'applied') throw new Error('expected second message attempt');
    now = 134;
    expect(await store.completeOutboxAttempt({
      attempt: secondMessageAttempt.attempt, receipt: { platformMessageId: 'om_2' },
    })).toMatchObject({ kind: 'applied', record: { state: 'delivered' } });
    now = 200;
    expect(await store.reserveNextOutbox({ workerId: 'sender-c', leaseDurationMs: 20 })).toBeUndefined();

    const takeover = acquired(await store.acquireSessionLease({
      sessionKey: 'session-1', ownerId: 'worker-b', leaseDurationMs: 50,
    }));
    expect(takeover.epoch).toBe(2);
    expect(await store.enqueueOutbox({
      lease, message: { ...message, messageId: 'late-message' },
    })).toEqual({ kind: 'stale_lease' });
    await store.close();
  });

  it('orders one Session outbox by store insertion sequence instead of client timestamps or ids', async () => {
    let now = 10;
    const store = makeStore(() => now);
    const lease = acquired(await store.acquireSessionLease({
      sessionKey: 'session-order', ownerId: 'worker-a', leaseDurationMs: 100,
    }));
    await store.enqueueOutbox({
      lease,
      message: {
        messageId: 'message-z-first', sessionKey: 'session-order', payload: { order: 1 },
        visibleAt: 0, createdAt: 9_000,
      },
    });
    await store.enqueueOutbox({
      lease,
      message: {
        messageId: 'message-a-second', sessionKey: 'session-order', payload: { order: 2 },
        visibleAt: 0, createdAt: 1,
      },
    });

    const first = await store.reserveNextOutbox({ workerId: 'sender-a', leaseDurationMs: 20 });
    expect(first?.record.messageId).toBe('message-z-first');
    const attempt = await store.beginOutboxAttempt({ reservation: first! });
    if (attempt.kind !== 'applied') throw new Error('expected first outbox attempt');
    now = 11;
    expect(await store.completeOutboxAttempt({
      attempt: attempt.attempt, receipt: { platformMessageId: 'om_first' },
    })).toMatchObject({ kind: 'applied', record: { state: 'delivered' } });
    const second = await store.reserveNextOutbox({ workerId: 'sender-b', leaseDurationMs: 20 });
    expect(second?.record.messageId).toBe('message-a-second');
    await store.close();
  });

  it('allows outbox delivery for different sessions to run in parallel', async () => {
    let now = 1;
    const store = makeStore(() => now);
    const leaseA = acquired(await store.acquireSessionLease({
      sessionKey: 'session-a', ownerId: 'worker-a', leaseDurationMs: 100,
    }));
    const leaseB = acquired(await store.acquireSessionLease({
      sessionKey: 'session-b', ownerId: 'worker-b', leaseDurationMs: 100,
    }));
    await store.enqueueOutbox({
      lease: leaseA,
      message: { messageId: 'message-a', sessionKey: 'session-a', payload: {}, visibleAt: 1, createdAt: 1 },
    });
    await store.enqueueOutbox({
      lease: leaseB,
      message: { messageId: 'message-b', sessionKey: 'session-b', payload: {}, visibleAt: 1, createdAt: 2 },
    });

    expect(await store.reserveNextOutbox({ workerId: 'sender-a', leaseDurationMs: 10 }))
      .toMatchObject({ record: { messageId: 'message-a' } });
    expect(await store.reserveNextOutbox({ workerId: 'sender-b', leaseDurationMs: 10 }))
      .toMatchObject({ record: { messageId: 'message-b' } });
    await store.close();
  });

  it('turns an expired side-effect attempt ambiguous instead of replaying it', async () => {
    let now = 1;
    const store = makeStore(() => now);
    const lease = acquired(await store.acquireSessionLease({
      sessionKey: 'session-1', ownerId: 'worker-a', leaseDurationMs: 100,
    }));
    await store.enqueueOutbox({
      lease,
      message: {
        messageId: 'message-ambiguous', sessionKey: 'session-1', payload: { text: 'hello' },
        visibleAt: 1, createdAt: 1,
      },
    });
    now = 2;
    const reservation = await store.reserveNextOutbox({ workerId: 'sender-a', leaseDurationMs: 10 });
    now = 3;
    const begun = await store.beginOutboxAttempt({ reservation: reservation! });
    if (begun.kind !== 'applied') throw new Error('expected begun attempt');

    now = 12;
    expect(await store.reserveNextOutbox({ workerId: 'sender-b', leaseDurationMs: 10 })).toBeUndefined();
    expect(await store.readOutbox('message-ambiguous')).toMatchObject({
      state: 'ambiguous', attempts: 1, lastError: 'delivery attempt lease expired before receipt',
    });
    expect(await store.retryOutboxAttempt({
      attempt: begun.attempt, visibleAt: 30, error: 'must not reopen result-unknown work',
    })).toEqual({ kind: 'stale' });
    expect(await store.markOutboxAmbiguous({
      attempt: begun.attempt, error: 'already ambiguous',
    })).toEqual({ kind: 'stale' });
    expect(await store.readOutbox('message-ambiguous')).toMatchObject({
      state: 'ambiguous', attempts: 1,
    });
    // Exact delayed receipt may still settle the same attempt. A different claim epoch/attempt cannot.
    now = 13;
    expect(await store.completeOutboxAttempt({
      attempt: { ...begun.attempt, attempt: begun.attempt.attempt + 1 },
      receipt: { platformMessageId: 'om_wrong_attempt' },
    })).toEqual({ kind: 'stale' });
    expect(await store.completeOutboxAttempt({
      attempt: begun.attempt, receipt: { platformMessageId: 'om_late' },
    })).toMatchObject({ kind: 'applied', record: { state: 'delivered' } });
    now = 14;
    expect(await store.completeOutboxAttempt({
      attempt: { ...begun.attempt, claimEpoch: begun.attempt.claimEpoch + 1 },
      receipt: { platformMessageId: 'om_wrong' },
    })).toEqual({ kind: 'stale' });

    await store.enqueueOutbox({
      lease,
      message: {
        messageId: 'message-explicit-ambiguous', sessionKey: 'session-1', payload: { text: 'later' },
        visibleAt: 14, createdAt: 2,
      },
    });
    const nextReservation = await store.reserveNextOutbox({ workerId: 'sender-a', leaseDurationMs: 10 });
    const nextAttempt = await store.beginOutboxAttempt({ reservation: nextReservation! });
    if (nextAttempt.kind !== 'applied') throw new Error('expected explicit ambiguous attempt');
    expect(await store.markOutboxAmbiguous({
      attempt: nextAttempt.attempt, error: 'transport outcome unknown',
    })).toMatchObject({ kind: 'applied', record: { state: 'ambiguous' } });
    expect(await store.retryOutboxAttempt({
      attempt: nextAttempt.attempt, visibleAt: 40, error: 'must stay ambiguous',
    })).toEqual({ kind: 'stale' });
    expect(await store.completeOutboxAttempt({
      attempt: nextAttempt.attempt, receipt: { platformMessageId: 'om_delayed' },
    })).toMatchObject({ kind: 'applied', record: { state: 'delivered' } });
    await store.close();
  });

  it('persists coordination state across store reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-durable-coordination-'));
    tempDirs.push(dir);
    const path = join(dir, 'coordination.db');
    let now = 1;
    const first = new SqliteDurableCoordinationStore(path, { now: () => now });
    const lease = acquired(await first.acquireSessionLease({
      sessionKey: 'session-1', ownerId: 'worker-a', leaseDurationMs: 10,
    }));
    now = 2;
    await first.writeSession({ lease, expectedRevision: null, value: { persisted: true } });
    await first.close();

    const reopened = new SqliteDurableCoordinationStore(path, { now: () => now });
    expect(await reopened.readSession('session-1')).toMatchObject({
      revision: 1, value: { persisted: true }, updatedAt: 2,
    });
    now = 11;
    const takeover = acquired(await reopened.acquireSessionLease({
      sessionKey: 'session-1', ownerId: 'worker-b', leaseDurationMs: 10,
    }));
    expect(takeover.epoch).toBe(2);
    await reopened.close();
  });
});
