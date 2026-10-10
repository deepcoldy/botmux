import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';
import type {
  DurableSessionRecord,
  WriteSessionResult,
} from '../src/services/durable-coordination.js';
import {
  createDurableSessionFacade,
  type DurableSessionFacadeStore,
} from '../src/services/durable-session-facade.js';
import type { DurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';
import {
  admitDurableLarkSession,
  durablePrimarySessionProjection,
  parseDurablePrimarySessionRecord,
} from '../src/services/durable-session-primary.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    chatId: 'oc_chat',
    chatType: 'group',
    rootMessageId: 'om_root',
    scope: 'thread',
    title: 'Primary Session',
    status: 'active',
    createdAt: '2026-10-05T00:00:00.000Z',
    lastMessageAt: '2026-10-05T00:01:00.000Z',
    larkAppId: 'cli_test',
    ownerOpenId: 'ou_owner',
    workingDir: '/shared/project',
    dispatchInputReceipts: {
      om_previous: {
        rootMessageId: 'om_root',
        committedAt: '2026-10-05T00:00:30.000Z',
        workerGeneration: 2,
      },
    },
    ...overrides,
  };
}

function message(messageId: string): DurableLarkMessageClaim {
  return {
    eventType: 'lark.im.message.receive_v1',
    eventId: `im.message.receive_v1:cli_test:${messageId}`,
    partitionKey: 'lark-message-routing:cli_test:oc_chat',
    larkAppId: 'cli_test',
    messageId,
    attempts: 1,
    data: { message: { message_id: messageId } },
  };
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
        updatedAt: 10_000 + (current?.revision ?? 0),
      };
      records.set(record.sessionKey, record);
      return { kind: 'written', record } as WriteSessionResult;
    }),
  };
  return { store, records };
}

describe('durable primary Session admission', () => {
  it('round-trips the full persisted Session and its canonical admission identity', () => {
    const projected = durablePrimarySessionProjection(session(), message('om_current'));
    const record: DurableSessionRecord = {
      sessionKey: projected.sessionKey,
      revision: 1,
      value: projected.value,
      updatedAt: 10_000,
    };

    expect(projected.sessionKey).toBe('om_root::cli_test');
    expect(parseDurablePrimarySessionRecord(record)).toMatchObject({
      session: {
        sessionId: 'session-1',
        ownerOpenId: 'ou_owner',
        workingDir: '/shared/project',
        dispatchInputReceipts: { om_previous: { workerGeneration: 2 } },
      },
      admission: {
        eventId: 'im.message.receive_v1:cli_test:om_current',
        partitionKey: 'lark-message-routing:cli_test:oc_chat',
        messageId: 'om_current',
      },
      admissions: [{ messageId: 'om_current' }],
    });
  });

  it('reads a version-1 primary record written before admission history was added', () => {
    const projected = durablePrimarySessionProjection(session(), message('om_legacy'));
    const value = projected.value as Record<string, unknown>;
    delete value.admissions;
    const parsed = parseDurablePrimarySessionRecord({
      sessionKey: projected.sessionKey,
      revision: 1,
      value: projected.value,
      updatedAt: 10_000,
    });
    expect(parsed.admissions).toEqual([parsed.admission]);
  });

  it('commits concurrent events as exact FIFO revisions and mints event-bound receipts', async () => {
    const { store, records } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'primary-session-boot' });

    const first = admitDurableLarkSession({ facade, message: message('om_1'), session: session() });
    const second = admitDurableLarkSession({
      facade,
      message: message('om_2'),
      session: session({ lastMessageAt: '2026-10-05T00:02:00.000Z' }),
    });
    await expect(first).resolves.toMatchObject({
      kind: 'committed',
      receipt: { eventId: 'im.message.receive_v1:cli_test:om_1', sessionEpoch: 1, sessionRevision: 1 },
      record: { revision: 1 },
    });
    await expect(second).resolves.toMatchObject({
      kind: 'committed',
      receipt: { eventId: 'im.message.receive_v1:cli_test:om_2', sessionEpoch: 2, sessionRevision: 2 },
      record: { revision: 2 },
    });
    expect(store.writeSession).toHaveBeenCalledTimes(2);
    expect(parseDurablePrimarySessionRecord(records.get('om_root::cli_test')!))
      .toMatchObject({
        admission: { messageId: 'om_2' },
        admissions: [{ messageId: 'om_1' }, { messageId: 'om_2' }],
      });
    await facade.stop();
  });

  it('keeps the earlier turn admission after a type-ahead turn commits', async () => {
    const { store, records } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'primary-type-ahead-boot' });

    await admitDurableLarkSession({ facade, message: message('om_n'), session: session() });
    await admitDurableLarkSession({
      facade,
      message: message('om_n_plus_1'),
      session: session({ lastMessageAt: '2026-10-05T00:02:00.000Z' }),
    });

    const parsed = parseDurablePrimarySessionRecord(records.get('om_root::cli_test')!);
    expect(parsed.admissions.find(entry => entry.messageId === 'om_n')).toMatchObject({
      eventId: 'im.message.receive_v1:cli_test:om_n',
    });
    expect(parsed.admissions.find(entry => entry.messageId === 'om_n_plus_1')).toMatchObject({
      eventId: 'im.message.receive_v1:cli_test:om_n_plus_1',
    });
    await facade.stop();
  });

  it('bounds admission history while retaining the newest 64 turns', async () => {
    const { store, records } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'primary-bounded-boot' });

    for (let index = 0; index < 65; index += 1) {
      await admitDurableLarkSession({
        facade,
        message: message(`om_${index}`),
        session: session({ lastMessageAt: `2026-10-05T00:02:${String(index).padStart(2, '0')}.000Z` }),
      });
    }

    const parsed = parseDurablePrimarySessionRecord(records.get('om_root::cli_test')!);
    expect(parsed.admissions).toHaveLength(64);
    expect(parsed.admissions[0]?.messageId).toBe('om_1');
    expect(parsed.admissions.at(-1)?.messageId).toBe('om_64');
    await facade.stop();
  });

  it('accepts the durable identity of a message-updated first-mention turn', () => {
    const updated: DurableLarkMessageClaim = {
      ...message('om_edited'),
      eventType: 'lark.im.message.updated_v1',
      eventId: 'im.message.updated_v1:cli_test:evt_edit_1',
    };
    const projected = durablePrimarySessionProjection(session(), updated);
    expect(parseDurablePrimarySessionRecord({
      sessionKey: projected.sessionKey,
      revision: 1,
      value: projected.value,
      updatedAt: 10_000,
    }).admission).toMatchObject({
      eventId: 'im.message.updated_v1:cli_test:evt_edit_1',
      messageId: 'om_edited',
    });
  });

  it('forces a new revision for a retried exact event and keeps sensitive Session fields out of the receipt', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'primary-session-boot' });
    const input = { facade, message: message('om_retry'), session: session() };

    const first = await admitDurableLarkSession(input);
    const retry = await admitDurableLarkSession(input);
    expect(first).toMatchObject({ kind: 'committed', receipt: { sessionRevision: 1 } });
    expect(retry).toMatchObject({ kind: 'committed', receipt: { sessionRevision: 2 } });
    if (retry.kind !== 'committed') throw new Error('expected committed retry');
    expect(JSON.stringify(retry.receipt)).not.toContain('ou_owner');
    expect(JSON.stringify(retry.receipt)).not.toContain('/shared/project');
    expect(JSON.stringify(retry.receipt)).not.toContain('Primary Session');
    await facade.stop();
  });

  it('rejects mismatched app and corrupted restore identities', () => {
    expect(() => durablePrimarySessionProjection(
      session({ larkAppId: 'cli_other' }),
      message('om_current'),
    )).toThrow(/does not belong/);

    const projected = durablePrimarySessionProjection(session(), message('om_current'));
    expect(() => parseDurablePrimarySessionRecord({
      sessionKey: 'om_other::cli_test',
      revision: 1,
      value: projected.value,
      updatedAt: 1,
    })).toThrow(/mismatched routing identity/);
  });
});
