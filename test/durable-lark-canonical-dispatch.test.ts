import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';
import type {
  DurableInboxStore,
  DurableOutboxStore,
  DurableSessionRecord,
  InboxClaim,
  WriteSessionResult,
} from '../src/services/durable-coordination.js';
import {
  createDurableLarkCanonicalDispatch,
  type DurableLarkCanonicalHandlerContext,
} from '../src/services/durable-lark-canonical-dispatch.js';
import { createDurableSessionFacade, type DurableSessionFacadeStore } from '../src/services/durable-session-facade.js';
import type { DurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';
import { startDurableInboxPrimaryConsumer } from '../src/services/durable-inbox-primary-consumer.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import {
  admitDurableLarkSession,
  parseDurablePrimarySessionRecord,
} from '../src/services/durable-session-primary.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

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
  it('retains a pre-admission checkpoint when the task still needs an Inbox retry', async () => {
    const { store, records } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-checkpoint' });
    const previous = {
      ...message(),
      eventId: 'im.message.receive_v1:cli_test:om_previous',
      messageId: 'om_previous',
    };
    await admitDurableLarkSession({ facade, message: previous, session: session() });
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async (_message, context) => {
        await context.checkpointPreAdmissionSession(session({ reasoningEffort: 'high' }));
        return { kind: 'retry', reason: 'worker replacement is not ready' };
      },
    });

    await expect(dispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .resolves.toEqual({ kind: 'retry', reason: 'worker replacement is not ready' });
    expect(parseDurablePrimarySessionRecord(records.get('om_root::cli_test')!)).toMatchObject({
      session: { reasoningEffort: 'high' },
      admission: { messageId: 'om_previous' },
      admissions: [{ messageId: 'om_previous' }],
    });
    expect(records.get('om_root::cli_test')?.revision).toBe(2);
    expect(store.enqueueOutbox).not.toHaveBeenCalled();
    expect(store.enqueueInbox).not.toHaveBeenCalled();
    await facade.stop();
  });

  it('rejects a leaked pre-admission checkpoint callback after handler completion', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-checkpoint-late' });
    let checkpointLate: DurableLarkCanonicalHandlerContext['checkpointPreAdmissionSession'] | undefined;
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async (_message, context) => {
        checkpointLate = context.checkpointPreAdmissionSession;
        return { kind: 'retry', reason: 'worker unavailable' };
      },
    });

    await expect(dispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .resolves.toEqual({ kind: 'retry', reason: 'worker unavailable' });
    if (!checkpointLate) throw new Error('expected checkpoint callback');
    await expect(checkpointLate(session())).rejects.toThrow(/after handler completion/);
    expect(store.acquireSessionLease).not.toHaveBeenCalled();
    expect(store.writeSession).not.toHaveBeenCalled();
    await facade.stop();
  });

  it('fails the dispatch when a checkpoint loses fencing even if the handler catches it', async () => {
    const { store, records } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-checkpoint-stale' });
    await admitDurableLarkSession({ facade, message: message(), session: session() });
    const before = records.get('om_root::cli_test');
    vi.mocked(store.writeSession).mockResolvedValueOnce({ kind: 'stale_lease' });
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async (_message, context) => {
        await context.checkpointPreAdmissionSession(session({ reasoningEffort: 'high' }))
          .catch(() => undefined);
        return { kind: 'admitted', session: session({ reasoningEffort: 'high' }) };
      },
    });

    await expect(dispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .rejects.toThrow(/checkpoint failed: stale_lease/);
    expect(records.get('om_root::cli_test')).toEqual(before);
    expect(store.writeSession).toHaveBeenCalledTimes(2);
    await facade.stop();
  });

  it('returns explicit retry when an awaited checkpoint failure is caught by the handler', async () => {
    const { store, records } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-checkpoint-caught-retry' });
    await admitDurableLarkSession({ facade, message: message(), session: session() });
    const before = records.get('om_root::cli_test');
    vi.mocked(store.writeSession).mockResolvedValueOnce({ kind: 'stale_lease' });
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async (_message, context) => {
        await context.checkpointPreAdmissionSession(session({ reasoningEffort: 'high' })).catch(() => undefined);
        return { kind: 'retry', reason: 'checkpoint is not yet durable' };
      },
    });

    await expect(dispatch(message(), { claim: claim(), signal: new AbortController().signal }))
      .resolves.toEqual({ kind: 'retry', reason: 'checkpoint is not yet durable' });
    expect(records.get('om_root::cli_test')).toEqual(before);
    expect(store.enqueueOutbox).not.toHaveBeenCalled();
    expect(store.enqueueInbox).not.toHaveBeenCalled();
    await facade.stop();
  });

  it('retains the real SQLite Inbox task beyond maxAttempts while checkpoint storage is unavailable', async () => {
    mkdirSync(join(homedir(), 'temp'), { recursive: true });
    const root = mkdtempSync(join(homedir(), 'temp', 'canonical-checkpoint-retry-'));
    let now = 10_000;
    const store = new SqliteDurableCoordinationStore(join(root, 'coordination.db'), { now: () => now });
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-checkpoint-outage' });
    try {
      const previous = { ...message(), eventId: 'im.message.receive_v1:cli_test:om_previous', messageId: 'om_previous' };
      await admitDurableLarkSession({ facade, message: previous, session: session() });
      const before = await store.readSession('om_root::cli_test');
      const event = {
        eventId: message().eventId, partitionKey: message().partitionKey, visibleAt: now, createdAt: now,
        payload: { version: 1, type: 'lark.im.message.receive_v1', larkAppId: 'cli_test', event: message().data },
      } as const;
      await store.enqueueInbox(event);
      const write = vi.spyOn(store, 'writeSession').mockRejectedValue(new Error('checkpoint database outage'));
      const complete = vi.spyOn(store, 'completeInboxClaim');
      const retry = vi.spyOn(store, 'retryInboxClaim');
      const dispatch = createDurableLarkCanonicalDispatch({
        facade, store,
        handle: async (_message, context) => {
          try {
            await context.checkpointPreAdmissionSession(session({ reasoningEffort: 'high' }));
          } catch {
            return { kind: 'retry', reason: 'checkpoint is not yet durable' };
          }
          return { kind: 'admitted', session: session({ reasoningEffort: 'high' }) };
        },
      });
      const errors: unknown[] = [];
      const consumer = startDurableInboxPrimaryConsumer({
        store, dispatch, workerId: 'checkpoint-outage-inbox', concurrency: 1, intervalMs: 60_000,
        maxAttempts: 1, retryDelayMs: 100, now: () => now, onError: error => errors.push(error),
      });
      try {
        await consumer.ready;
        expect(retry).toHaveBeenCalledOnce();
        expect(complete).not.toHaveBeenCalled();
        expect(errors).toEqual([]);
        expect(await store.readSession('om_root::cli_test')).toEqual(before);
      } finally {
        await consumer.stop();
      }
      write.mockRestore();
      now += 100;
      const recoveredDispatch = vi.fn(dispatch);
      const recovery = startDurableInboxPrimaryConsumer({
        store, dispatch: recoveredDispatch, workerId: 'checkpoint-recovery', concurrency: 1, intervalMs: 60_000,
        maxAttempts: 1, retryDelayMs: 100, now: () => now, onError: error => errors.push(error),
      });
      try {
        await recovery.ready;
        expect(recoveredDispatch).toHaveBeenCalledWith(
          expect.objectContaining({ attempts: 2, eventId: event.eventId, data: event.payload.event }),
          expect.objectContaining({ claim: expect.objectContaining({ event: expect.objectContaining({ payload: event.payload }) }) }),
        );
        expect(complete).toHaveBeenCalledOnce();
        expect(retry).toHaveBeenCalledOnce();
        expect(errors).toEqual([]);
        expect(parseDurablePrimarySessionRecord((await store.readSession('om_root::cli_test'))!)).toMatchObject({
          session: { reasoningEffort: 'high' },
          admission: { messageId: message().messageId },
          admissions: [{ messageId: 'om_previous' }, { messageId: message().messageId }],
        });
      } finally {
        await recovery.stop();
      }
    } finally {
      await facade.stop();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rechecks Inbox ownership inside the checkpoint lane before writing', async () => {
    const { store, records } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-checkpoint-abort' });
    await admitDurableLarkSession({ facade, message: message(), session: session() });
    const before = records.get('om_root::cli_test');
    const readStarted = deferred<void>();
    const unblockRead = deferred<DurableSessionRecord | undefined>();
    vi.mocked(store.readSession).mockImplementationOnce(() => {
      readStarted.resolve();
      return unblockRead.promise;
    });
    const abort = new AbortController();
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async (_message, context) => {
        await context.checkpointPreAdmissionSession(session({ reasoningEffort: 'high' }));
        return { kind: 'admitted', session: session({ reasoningEffort: 'high' }) };
      },
    });
    const dispatched = dispatch(message(), { claim: claim(), signal: abort.signal });
    const outcome = dispatched.catch(error => error as Error);
    await Promise.race([
      readStarted.promise,
      outcome.then(error => { throw error; }),
    ]);
    abort.abort(new Error('claim lost before checkpoint write'));
    unblockRead.resolve(before);
    expect(await outcome).toMatchObject({ message: 'claim lost before checkpoint write' });
    expect(records.get('om_root::cli_test')).toEqual(before);
    expect(store.writeSession).toHaveBeenCalledOnce();
    await facade.stop();
  });

  it('does not let an unawaited checkpoint write after its handler returns', async () => {
    const { store, records } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-checkpoint-unawaited' });
    await admitDurableLarkSession({ facade, message: message(), session: session() });
    const before = records.get('om_root::cli_test');
    const unblockRead = deferred<DurableSessionRecord | undefined>();
    const handlerReturned = deferred<void>();
    vi.mocked(store.readSession).mockImplementationOnce(() => unblockRead.promise);
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async (_message, context) => {
        void context.checkpointPreAdmissionSession(session({ reasoningEffort: 'high' }));
        handlerReturned.resolve();
        return { kind: 'retry', reason: 'worker unavailable' };
      },
    });
    const dispatched = dispatch(message(), { claim: claim(), signal: new AbortController().signal });
    const outcome = dispatched.catch(error => error as Error);
    await Promise.race([
      handlerReturned.promise,
      outcome.then(error => { throw error; }),
    ]);
    await Promise.resolve();
    unblockRead.resolve(before);
    expect(await outcome).toMatchObject({ message: expect.stringMatching(/after handler completion/) });
    expect(records.get('om_root::cli_test')).toEqual(before);
    expect(store.writeSession).toHaveBeenCalledOnce();
    await facade.stop();
  });

  it('preserves a completed checkpoint but stops task input when the Inbox claim aborts during write', async () => {
    const { store, records } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-checkpoint-abort-after-write' });
    const previous = { ...message(), eventId: 'im.message.receive_v1:cli_test:om_previous', messageId: 'om_previous' };
    await admitDurableLarkSession({ facade, message: previous, session: session() });
    const write = vi.mocked(store.writeSession).getMockImplementation()!;
    const abort = new AbortController();
    vi.mocked(store.writeSession).mockImplementationOnce(async input => {
      const written = await write(input);
      abort.abort(new Error('claim lost after checkpoint write'));
      return written;
    });
    const submitTask = vi.fn();
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async (_message, context) => {
        await context.checkpointPreAdmissionSession(session({ reasoningEffort: 'high' }));
        submitTask();
        return { kind: 'admitted', session: session({ reasoningEffort: 'high' }) };
      },
    });

    await expect(dispatch(message(), { claim: claim(), signal: abort.signal }))
      .rejects.toThrow('claim lost after checkpoint write');
    expect(submitTask).not.toHaveBeenCalled();
    expect(parseDurablePrimarySessionRecord(records.get('om_root::cli_test')!)).toMatchObject({
      session: { reasoningEffort: 'high' },
      admission: { messageId: 'om_previous' },
      admissions: [{ messageId: 'om_previous' }],
    });
    expect(store.writeSession).toHaveBeenCalledTimes(2);
    await facade.stop();
  });

  it('rechecks the caller runtime identity inside the checkpoint lane before writing', async () => {
    const { store, records } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-checkpoint-runtime' });
    await admitDurableLarkSession({ facade, message: message(), session: session() });
    const before = records.get('om_root::cli_test');
    const readStarted = deferred<void>();
    const unblockRead = deferred<DurableSessionRecord | undefined>();
    vi.mocked(store.readSession).mockImplementationOnce(() => {
      readStarted.resolve();
      return unblockRead.promise;
    });
    let runtimeCurrent = true;
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async (_message, context) => {
        await context.checkpointPreAdmissionSession(session({ reasoningEffort: 'high' }), () => runtimeCurrent);
        return { kind: 'admitted', session: session({ reasoningEffort: 'high' }) };
      },
    });
    const outcome = dispatch(message(), { claim: claim(), signal: new AbortController().signal })
      .catch(error => error as Error);
    await Promise.race([readStarted.promise, outcome.then(error => { throw error; })]);
    runtimeCurrent = false;
    unblockRead.resolve(before);
    expect(await outcome).toMatchObject({ message: expect.stringMatching(/checkpoint.*runtime.*changed/) });
    expect(records.get('om_root::cli_test')).toEqual(before);
    expect(store.writeSession).toHaveBeenCalledOnce();
    await facade.stop();
  });

  it('drains a started checkpoint before returning a handler error to the Inbox', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-checkpoint-handler-error' });
    await admitDurableLarkSession({ facade, message: message(), session: session() });
    const write = vi.mocked(store.writeSession).getMockImplementation()!;
    const writeStarted = deferred<void>();
    const unblockWrite = deferred<void>();
    vi.mocked(store.writeSession).mockImplementationOnce(async input => {
      writeStarted.resolve();
      await unblockWrite.promise;
      return write(input);
    });
    const handlerFailed = deferred<void>();
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async (_message, context) => {
        void context.checkpointPreAdmissionSession(session({ reasoningEffort: 'high' }));
        await writeStarted.promise;
        handlerFailed.resolve();
        throw new Error('handler failed');
      },
    });
    let settled = false;
    const outcome = dispatch(message(), { claim: claim(), signal: new AbortController().signal })
      .catch(error => error as Error).finally(() => { settled = true; });
    await handlerFailed.promise;
    await new Promise(resolve => setTimeout(resolve, 0));
    const settledBeforeCheckpoint = settled;
    unblockWrite.resolve();
    expect(await outcome).toMatchObject({ message: 'handler failed' });
    expect(settledBeforeCheckpoint).toBe(false);
    await facade.stop();
  });

  it('drains every checkpoint before returning the first checkpoint failure', async () => {
    const { store } = fakeStore();
    const facade = createDurableSessionFacade({ store, ownerId: 'canonical-checkpoint-multiple' });
    await admitDurableLarkSession({ facade, message: message(), session: session() });
    await admitDurableLarkSession({ facade, message: message(), session: session({ rootMessageId: 'om_second' }) });
    const write = vi.mocked(store.writeSession).getMockImplementation()!;
    const bothStarted = deferred<void>();
    const unblockFirst = deferred<void>();
    const unblockSecond = deferred<void>();
    let started = 0;
    vi.mocked(store.writeSession).mockImplementation(async input => {
      started += 1;
      if (started === 2) bothStarted.resolve();
      if (input.lease.sessionKey === 'om_root::cli_test') {
        await unblockFirst.promise;
        throw new Error('first checkpoint failed');
      }
      await unblockSecond.promise;
      return write(input);
    });
    const handlerReturned = deferred<void>();
    const dispatch = createDurableLarkCanonicalDispatch({
      facade,
      store,
      handle: async (_message, context) => {
        void context.checkpointPreAdmissionSession(session({ reasoningEffort: 'high' }));
        void context.checkpointPreAdmissionSession(session({ rootMessageId: 'om_second', reasoningEffort: 'high' }));
        await bothStarted.promise;
        handlerReturned.resolve();
        return { kind: 'retry', reason: 'worker unavailable' };
      },
    });
    let settled = false;
    const outcome = dispatch(message(), { claim: claim(), signal: new AbortController().signal })
      .catch(error => error as Error).finally(() => { settled = true; });
    await handlerReturned.promise;
    unblockFirst.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    const settledBeforeSecondCheckpoint = settled;
    unblockSecond.resolve();
    expect(await outcome).toMatchObject({ message: 'first checkpoint failed' });
    expect(settledBeforeSecondCheckpoint).toBe(false);
    await facade.stop();
  });

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
