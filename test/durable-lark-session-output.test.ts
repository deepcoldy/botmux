import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';
import type {
  DurableOutboxRecord,
  DurableOutboxStore,
  DurableSessionRecord,
  WriteSessionResult,
} from '../src/services/durable-coordination.js';
import { createDurableSessionFacade, type DurableSessionFacadeStore } from '../src/services/durable-session-facade.js';
import type { DurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';
import { enqueueDurableLarkSessionOutput } from '../src/services/durable-lark-session-output.js';
import {
  admitDurableLarkSession,
  parseDurablePrimarySessionRecord,
} from '../src/services/durable-session-primary.js';

function session(): Session {
  return {
    sessionId: 'session-1', chatId: 'oc_chat', rootMessageId: 'om_root', scope: 'thread',
    title: 'Task', status: 'active', createdAt: '2026-10-05T00:00:00.000Z', larkAppId: 'cli_test',
  };
}

function inbound(messageId = 'om_input'): DurableLarkMessageClaim {
  return {
    eventType: 'lark.im.message.receive_v1',
    eventId: `im.message.receive_v1:cli_test:${messageId}`,
    partitionKey: 'lark-message-routing:cli_test:oc_chat',
    larkAppId: 'cli_test', messageId, attempts: 1,
    data: { message: { message_id: messageId } },
  };
}

function outbox(state: DurableOutboxRecord['state'] = 'pending'): DurableOutboxRecord {
  return {
    messageId: 'outbox-1', sessionKey: 'om_root::cli_test', payload: { text: 'done' },
    visibleAt: 1, createdAt: 1, state, originEpoch: 9, attempts: state === 'pending' ? 0 : 1,
    updatedAt: 2,
  };
}

function fakeStore() {
  const order: string[] = [];
  const records = new Map<string, DurableSessionRecord>();
  const store: DurableSessionFacadeStore & DurableOutboxStore = {
    acquireSessionLease: vi.fn(async input => ({
      kind: 'acquired',
      lease: { sessionKey: input.sessionKey, ownerId: input.ownerId, epoch: 9, leaseUntil: 60_000 },
    })),
    renewSessionLease: vi.fn(),
    releaseSessionLease: vi.fn(async lease => ({ kind: 'applied', lease })),
    readSession: vi.fn(async key => records.get(key)),
    writeSession: vi.fn(async input => {
      order.push('session');
      const record: DurableSessionRecord = {
        sessionKey: input.lease.sessionKey,
        revision: (records.get(input.lease.sessionKey)?.revision ?? 0) + 1,
        value: input.value,
        updatedAt: 10_000,
      };
      records.set(record.sessionKey, record);
      return { kind: 'written', record } as WriteSessionResult;
    }),
    enqueueOutbox: vi.fn(async ({ lease }) => {
      order.push(`outbox:${lease.epoch}`);
      return { kind: 'inserted' } as const;
    }),
    reserveNextOutbox: vi.fn(),
    beginOutboxAttempt: vi.fn(),
    completeOutboxAttempt: vi.fn(),
    retryOutboxAttempt: vi.fn(),
    markOutboxAmbiguous: vi.fn(),
    readOutbox: vi.fn(async () => outbox('delivered')),
  };
  return { store, order };
}

describe('durable Lark Session output', () => {
  it('commits the Session before fenced enqueue and exposes authoritative settlement', async () => {
    const { store, order } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'output-boot' });
    const result = await enqueueDurableLarkSessionOutput({
      facade, store, inbound: inbound(), session: session(), message: outbox('pending'),
    });

    expect(result).toMatchObject({
      kind: 'accepted', inserted: true,
      admissionReceipt: { sessionEpoch: 9, sessionRevision: 1 },
    });
    expect(order).toEqual(['session', 'outbox:9']);
    if (result.kind !== 'accepted') throw new Error('expected accepted output');
    await expect(result.settlement).resolves.toMatchObject({ kind: 'delivered' });
    await facade.stop();
  });

  it('delivers turn N after type-ahead turn N+1 has already committed', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'output-type-ahead-boot' });
    await admitDurableLarkSession({ facade, message: inbound('om_n'), session: session() });
    await admitDurableLarkSession({ facade, message: inbound('om_n_plus_1'), session: session() });
    const beforeOutput = await store.readSession('om_root::cli_test');
    expect(parseDurablePrimarySessionRecord(beforeOutput!).admissions.map(entry => entry.messageId))
      .toEqual(['om_n', 'om_n_plus_1']);

    const result = await enqueueDurableLarkSessionOutput({
      facade,
      store,
      inbound: inbound('om_n'),
      session: session(),
      message: outbox('pending'),
    });

    expect(result.kind).toBe('accepted');
    expect(store.enqueueOutbox).toHaveBeenCalledOnce();
    if (result.kind !== 'accepted') throw new Error('expected accepted output');
    await expect(result.settlement).resolves.toMatchObject({ kind: 'delivered' });
    const afterOutput = await store.readSession('om_root::cli_test');
    expect(new Set(parseDurablePrimarySessionRecord(afterOutput!).admissions.map(entry => entry.messageId)))
      .toEqual(new Set(['om_n', 'om_n_plus_1']));
    await facade.stop();
  });

  it('rejects a cross-Session outbox target before mutating Session state', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'output-boot' });
    await expect(enqueueDurableLarkSessionOutput({
      facade,
      store,
      inbound: inbound(),
      session: session(),
      message: { ...outbox('pending'), sessionKey: 'om_other::cli_test' },
    })).rejects.toThrow(/does not belong/);
    expect(store.writeSession).not.toHaveBeenCalled();
    expect(store.enqueueOutbox).not.toHaveBeenCalled();
    await facade.stop();
  });

  it.each([
    ['conflict', 'outbox_conflict'],
    ['stale_lease', 'stale_lease'],
  ] as const)('surfaces outbox %s after the Session commit', async (outcome, expected) => {
    const { store } = fakeStore();
    vi.mocked(store.enqueueOutbox).mockResolvedValue({ kind: outcome } as never);
    const facade = createDurableSessionFacade({ store, ownerId: 'output-boot' });
    await expect(enqueueDurableLarkSessionOutput({
      facade, store, inbound: inbound(), session: session(), message: outbox('pending'),
    })).resolves.toMatchObject({ kind: expected });
    expect(store.writeSession).toHaveBeenCalledOnce();
    await facade.stop();
  });

  it('does not enqueue output when Session ownership is occupied', async () => {
    const { store } = fakeStore();
    vi.mocked(store.acquireSessionLease).mockResolvedValue({
      kind: 'occupied', ownerId: 'other', epoch: 4, leaseUntil: 60_000,
    });
    const facade = createDurableSessionFacade({ store, ownerId: 'output-boot' });
    await expect(enqueueDurableLarkSessionOutput({
      facade, store, inbound: inbound(), session: session(), message: outbox('pending'),
    })).resolves.toEqual({ kind: 'session_unavailable', reason: 'occupied' });
    expect(store.enqueueOutbox).not.toHaveBeenCalled();
    await facade.stop();
  });
});
