import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';
import type {
  DurableInboxStore,
  DurableOutboxStore,
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

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    scope: 'thread',
    title: 'Task',
    status: 'active',
    createdAt: '2026-10-05T00:00:00.000Z',
    larkAppId: 'cli_test',
    ...overrides,
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
  const store: DurableSessionFacadeStore
    & Pick<DurableOutboxStore, 'enqueueOutbox'>
    & Pick<DurableInboxStore, 'enqueueInbox'> = {
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
    enqueueOutbox: vi.fn(async () => ({ kind: 'inserted' as const })),
    enqueueInbox: vi.fn(async () => ({ kind: 'inserted' as const })),
  };
  return { store, records };
}

describe('durable Lark canonical dispatch', () => {
  it('turns an admitted canonical Session into the consumer committed receipt', async () => {
    const { store, records } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-boot' });
    const handle = vi.fn(async () => ({ kind: 'admitted' as const, session: session() }));
    const dispatch = createDurableLarkCanonicalDispatch({ facade, store, handle });

    await expect(dispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .resolves.toMatchObject({
        kind: 'committed',
        receipt: { eventId: message().eventId, sessionEpoch: 4, sessionRevision: 1 },
      });
    expect(handle).toHaveBeenCalledWith(message(), expect.objectContaining({ data: message().data }));
    expect(records.has('om_root::cli_test')).toBe(true);
    await facade.stop();
  });

  it('releases the Session lease after a closed canonical snapshot is committed', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-close-owner' });
    const releaseLease = vi.spyOn(facade, 'releaseLease');
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async () => ({
        kind: 'admitted',
        session: session({
          status: 'closed',
          closedAt: '2026-10-16T00:01:00.000Z',
        }),
      }),
    });

    await expect(dispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .resolves.toMatchObject({ kind: 'committed' });
    expect(releaseLease).toHaveBeenCalledWith('om_root::cli_test');
    expect(store.releaseSessionLease).toHaveBeenCalledOnce();
    expect(vi.mocked(store.writeSession).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(store.releaseSessionLease).mock.invocationCallOrder[0]!);
    await facade.stop();
    expect(store.releaseSessionLease).toHaveBeenCalledOnce();
  });

  it('returns explicit ignored results without writing a Session', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-boot' });
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async () => ({ kind: 'ignored', reason: 'not addressed to this bot' }),
    });

    await expect(dispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .resolves.toEqual({ kind: 'ignored', reason: 'not addressed to this bot' });
    expect(store.writeSession).not.toHaveBeenCalled();
    await facade.stop();
  });

  it('propagates explicit retry results without writing Session or Outbox state', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-boot' });
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async () => ({ kind: 'retry', reason: 'session has an unfinished turn' }),
    });

    await expect(dispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .resolves.toEqual({ kind: 'retry', reason: 'session has an unfinished turn' });
    expect(store.writeSession).not.toHaveBeenCalled();
    expect(store.enqueueOutbox).not.toHaveBeenCalled();
    await facade.stop();
  });

  it('fails closed when a retry result queued a post-admission output', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-boot' });
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async (_message, context) => {
        context.queuePostAdmissionOutput({
          target: { kind: 'send', chatId: 'oc_chat' },
          content: 'must not escape a retry',
          providerUuid: 'retry_output',
        });
        return { kind: 'retry', reason: 'session has an unfinished turn' };
      },
    });

    await expect(dispatch(message(), {
      claim: claim(), signal: new AbortController().signal,
    })).rejects.toThrow(/retry result cannot publish/);
    expect(store.writeSession).not.toHaveBeenCalled();
    expect(store.enqueueOutbox).not.toHaveBeenCalled();
    await facade.stop();
  });

  it('fails closed on aborts, invalid handler results, and Session admission conflicts', async () => {
    const aborted = new AbortController();
    aborted.abort(new Error('claim lost'));
    const first = fakeStore();
    const firstFacade = createDurableSessionFacade({ store: first.store, ownerId: 'canonical-boot' });
    const firstDispatch = createDurableLarkCanonicalDispatch({
      facade: firstFacade,
      store: first.store,
      handle: async () => ({ kind: 'admitted', session: session() }),
    });
    await expect(firstDispatch(message(), { claim: claim(), signal: aborted.signal }))
      .rejects.toThrow('claim lost');
    expect(first.store.writeSession).not.toHaveBeenCalled();

    const invalidDispatch = createDurableLarkCanonicalDispatch({
      facade: firstFacade,
      store: first.store,
      handle: async () => ({ kind: 'queued' } as never),
    });
    await expect(invalidDispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .rejects.toThrow(/invalid result/);

    const conflict = fakeStore();
    vi.mocked(conflict.store.writeSession).mockResolvedValue({ kind: 'conflict' });
    const conflictFacade = createDurableSessionFacade({ store: conflict.store, ownerId: 'canonical-boot' });
    const conflictDispatch = createDurableLarkCanonicalDispatch({
      facade: conflictFacade,
      store: conflict.store,
      handle: async () => ({ kind: 'admitted', session: session() }),
    });
    await expect(conflictDispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .rejects.toThrow(/admission failed: conflict/);
    await firstFacade.stop();
    await conflictFacade.stop();
  });

  it('persists queued outputs only after the canonical Session admission', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-boot' });
    let queueLate: ((output: any) => void) | undefined;
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async (_message, context) => {
        queueLate = context.queuePostAdmissionOutput;
        context.queuePostAdmissionOutput({
          target: { kind: 'reply', messageId: 'om_root', replyInThread: true },
          content: 'worker admission rejected',
          providerUuid: 'admission_blocked_1',
        });
        expect(store.enqueueOutbox).not.toHaveBeenCalled();
        return { kind: 'admitted', session: session() };
      },
    });

    await expect(dispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .resolves.toMatchObject({ kind: 'committed' });
    expect(store.enqueueOutbox).toHaveBeenCalledWith({
      lease: expect.objectContaining({ sessionKey: 'om_root::cli_test', epoch: 4 }),
      message: expect.objectContaining({
        messageId: 'out_admission_blocked_1',
        sessionKey: 'om_root::cli_test',
        visibleAt: 1,
        createdAt: 1,
      }),
    });
    expect(vi.mocked(store.writeSession).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(store.enqueueOutbox).mock.invocationCallOrder[0]!);
    expect(() => queueLate?.({
      target: { kind: 'send', chatId: 'oc_chat' },
      content: 'late',
      providerUuid: 'late_output',
    })).toThrow(/after handler completion/);
    await facade.stop();
  });

  it('persists queued controls only after the canonical Session admission', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-boot' });
    const control = {
      eventId: 'lark-command.session-control:cli_test:om_message',
      lane: 'session-control',
      partitionKey: 'lark-session-control:cli_test:session-1',
      payload: { type: 'botmux.session.control' },
      visibleAt: 1,
      createdAt: 1,
    } as const;
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async (_message, context) => {
        context.queuePostAdmissionControl(control);
        expect(store.enqueueInbox).not.toHaveBeenCalled();
        return { kind: 'admitted', session: session() };
      },
    });

    await expect(dispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .resolves.toMatchObject({ kind: 'committed' });
    expect(store.enqueueInbox).toHaveBeenCalledWith(control);
    expect(vi.mocked(store.writeSession).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(store.enqueueInbox).mock.invocationCallOrder[0]!);
    await facade.stop();
  });

  it('fails closed when queued output has no Session authority or loses fencing', async () => {
    const ignored = fakeStore();
    const ignoredFacade = createDurableSessionFacade({ store: ignored.store, ownerId: 'canonical-boot' });
    const ignoredDispatch = createDurableLarkCanonicalDispatch({
      facade: ignoredFacade,
      store: ignored.store,
      handle: async (_message, context) => {
        context.queuePostAdmissionOutput({
          target: { kind: 'send', chatId: 'oc_chat' },
          content: 'must not send',
          providerUuid: 'ignored_output',
        });
        return { kind: 'ignored', reason: 'no Session' };
      },
    });
    await expect(ignoredDispatch(message(), {
      claim: claim(), signal: new AbortController().signal,
    })).rejects.toThrow(/ignored result cannot publish/);
    expect(ignored.store.enqueueOutbox).not.toHaveBeenCalled();

    const stale = fakeStore();
    vi.mocked(stale.store.enqueueOutbox).mockResolvedValue({ kind: 'stale_lease' });
    const staleFacade = createDurableSessionFacade({ store: stale.store, ownerId: 'canonical-boot' });
    const staleDispatch = createDurableLarkCanonicalDispatch({
      facade: staleFacade,
      store: stale.store,
      handle: async (_message, context) => {
        context.queuePostAdmissionOutput({
          target: { kind: 'send', chatId: 'oc_chat' },
          content: 'retry through Inbox',
          providerUuid: 'stale_output',
        });
        return { kind: 'admitted', session: session() };
      },
    });
    await expect(staleDispatch(message(), {
      claim: claim(), signal: new AbortController().signal,
    })).rejects.toThrow(/post-admission output failed: stale_lease/);
    await ignoredFacade.stop();
    await staleFacade.stop();
  });
});
