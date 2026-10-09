import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';
import type {
  DurableSessionRecord,
  InboxClaim,
  WriteSessionResult,
} from '../src/services/durable-coordination.js';
import { createDurableLarkCanonicalDispatch } from '../src/services/durable-lark-canonical-dispatch.js';
import { createDurableSessionFacade, type DurableSessionFacadeStore } from '../src/services/durable-session-facade.js';
import type { DurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';

function message(): DurableLarkMessageClaim {
  return {
    eventType: 'lark.im.message.receive_v1',
    eventId: 'im.message.receive_v1:cli_test:om_message',
    partitionKey: 'lark-message-routing:cli_test:oc_chat',
    larkAppId: 'cli_test',
    messageId: 'om_message',
    attempts: 1,
    data: { message: { message_id: 'om_message' } },
  };
}

function session(): Session {
  return {
    sessionId: 'session-1',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    scope: 'thread',
    title: 'Task',
    status: 'active',
    createdAt: '2026-10-05T00:00:00.000Z',
    larkAppId: 'cli_test',
  };
}

function claim(): InboxClaim {
  return {
    event: {
      eventId: message().eventId,
      partitionKey: message().partitionKey,
      payload: {},
      visibleAt: 1,
      createdAt: 1,
    },
    workerId: 'primary-worker',
    claimEpoch: 1,
    claimUntil: 60_000,
    attempts: 1,
  };
}

function fakeStore() {
  const records = new Map<string, DurableSessionRecord>();
  const store: DurableSessionFacadeStore = {
    acquireSessionLease: vi.fn(async input => ({
      kind: 'acquired',
      lease: { sessionKey: input.sessionKey, ownerId: input.ownerId, epoch: 4, leaseUntil: 60_000 },
    })),
    renewSessionLease: vi.fn(),
    releaseSessionLease: vi.fn(async lease => ({ kind: 'applied', lease })),
    readSession: vi.fn(async key => records.get(key)),
    writeSession: vi.fn(async input => {
      const current = records.get(input.lease.sessionKey);
      const record: DurableSessionRecord = {
        sessionKey: input.lease.sessionKey,
        revision: (current?.revision ?? 0) + 1,
        value: input.value,
        updatedAt: 10_000,
      };
      records.set(record.sessionKey, record);
      return { kind: 'written', record } as WriteSessionResult;
    }),
  };
  return { store, records };
}

describe('durable Lark canonical dispatch', () => {
  it('turns an admitted canonical Session into the consumer committed receipt', async () => {
    const { store, records } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-boot' });
    const handle = vi.fn(async () => ({ kind: 'admitted' as const, session: session() }));
    const dispatch = createDurableLarkCanonicalDispatch({ facade, handle });

    await expect(dispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .resolves.toMatchObject({
        kind: 'committed',
        receipt: { eventId: message().eventId, sessionEpoch: 4, sessionRevision: 1 },
      });
    expect(handle).toHaveBeenCalledWith(message(), expect.objectContaining({ data: message().data }));
    expect(records.has('om_root::cli_test')).toBe(true);
    await facade.stop();
  });

  it('returns explicit ignored results without writing a Session', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-boot' });
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      handle: async () => ({ kind: 'ignored', reason: 'not addressed to this bot' }),
    });

    await expect(dispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .resolves.toEqual({ kind: 'ignored', reason: 'not addressed to this bot' });
    expect(store.writeSession).not.toHaveBeenCalled();
    await facade.stop();
  });

  it('fails closed on aborts, invalid handler results, and Session admission conflicts', async () => {
    const aborted = new AbortController();
    aborted.abort(new Error('claim lost'));
    const first = fakeStore();
    const firstFacade = createDurableSessionFacade({ store: first.store, ownerId: 'canonical-boot' });
    const firstDispatch = createDurableLarkCanonicalDispatch({
      facade: firstFacade,
      handle: async () => ({ kind: 'admitted', session: session() }),
    });
    await expect(firstDispatch(message(), { claim: claim(), signal: aborted.signal }))
      .rejects.toThrow('claim lost');
    expect(first.store.writeSession).not.toHaveBeenCalled();

    const invalidDispatch = createDurableLarkCanonicalDispatch({
      facade: firstFacade,
      handle: async () => ({ kind: 'queued' } as never),
    });
    await expect(invalidDispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .rejects.toThrow(/invalid result/);

    const conflict = fakeStore();
    vi.mocked(conflict.store.writeSession).mockResolvedValue({ kind: 'conflict' });
    const conflictFacade = createDurableSessionFacade({ store: conflict.store, ownerId: 'canonical-boot' });
    const conflictDispatch = createDurableLarkCanonicalDispatch({
      facade: conflictFacade,
      handle: async () => ({ kind: 'admitted', session: session() }),
    });
    await expect(conflictDispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .rejects.toThrow(/admission failed: conflict/);
    await firstFacade.stop();
    await conflictFacade.stop();
  });
});
