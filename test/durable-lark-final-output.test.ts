import { describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import { finalOutputDeliveryCount } from '../src/core/final-output-delivery-drain.js';
import type {
  DurableOutboxRecord,
  DurableOutboxStore,
  DurableSessionRecord,
  WriteSessionResult,
} from '../src/services/durable-coordination.js';
import { enqueueDurableLarkFinalOutput } from '../src/services/durable-lark-final-output.js';
import { createDurableSessionFacade, type DurableSessionFacadeStore } from '../src/services/durable-session-facade.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function daemonSession(): DaemonSession {
  return {
    session: {
      sessionId: 'session-1', chatId: 'oc_chat', rootMessageId: 'om_root', scope: 'thread',
      title: 'Task', status: 'active', createdAt: '2026-10-05T00:00:00.000Z', larkAppId: 'cli_test',
    },
  } as DaemonSession;
}

function outbox(state: DurableOutboxRecord['state'] = 'pending'): DurableOutboxRecord {
  return {
    messageId: 'outbox-1', sessionKey: 'om_root::cli_test', payload: { text: 'done' },
    visibleAt: 1, createdAt: 1, state, originEpoch: 3, attempts: 0, updatedAt: 1,
  };
}

function store() {
  const records = new Map<string, DurableSessionRecord>();
  const durableStore: DurableSessionFacadeStore & DurableOutboxStore = {
    acquireSessionLease: vi.fn(async input => ({
      kind: 'acquired',
      lease: { sessionKey: input.sessionKey, ownerId: input.ownerId, epoch: 3, leaseUntil: 60_000 },
    })),
    renewSessionLease: vi.fn(),
    releaseSessionLease: vi.fn(async lease => ({ kind: 'applied', lease })),
    readSession: vi.fn(async key => records.get(key)),
    writeSession: vi.fn(async input => {
      const record: DurableSessionRecord = {
        sessionKey: input.lease.sessionKey,
        revision: 1,
        value: input.value,
        updatedAt: 10_000,
      };
      records.set(record.sessionKey, record);
      return { kind: 'written', record } as WriteSessionResult;
    }),
    enqueueOutbox: vi.fn(async () => ({ kind: 'inserted' })),
    reserveNextOutbox: vi.fn(), beginOutboxAttempt: vi.fn(), completeOutboxAttempt: vi.fn(),
    retryOutboxAttempt: vi.fn(), markOutboxAmbiguous: vi.fn(),
    readOutbox: vi.fn(async () => outbox('delivered')),
  };
  return durableStore;
}

const inbound = {
  eventType: 'lark.im.message.receive_v1' as const,
  eventId: 'im.message.receive_v1:cli_test:om_input',
  partitionKey: 'lark-message-routing:cli_test:oc_chat',
  larkAppId: 'cli_test', messageId: 'om_input', attempts: 1,
  data: { message: { message_id: 'om_input' } },
} as const;

describe('durable Lark final output', () => {
  it('registers final-drain before async admission and releases only at terminal settlement', async () => {
    const durableStore = store();
    const terminal = deferred<DurableOutboxRecord>();
    vi.mocked(durableStore.readOutbox).mockReturnValue(terminal.promise);
    const ds = daemonSession();
    const facade = createDurableSessionFacade({ store: durableStore, ownerId: 'final-output-boot' });
    const output = enqueueDurableLarkFinalOutput({
      daemonSession: ds, facade, store: durableStore, inbound, message: outbox(),
    });
    expect(finalOutputDeliveryCount(ds)).toBe(1);
    const accepted = await output;
    expect(accepted.kind).toBe('accepted');
    expect(finalOutputDeliveryCount(ds)).toBe(1);
    if (accepted.kind !== 'accepted') throw new Error('expected accepted output');
    terminal.resolve(outbox('delivered'));
    await accepted.settlement;
    await Promise.resolve();
    expect(finalOutputDeliveryCount(ds)).toBe(0);
    await facade.stop();
  });

  it('releases final-drain after pre-enqueue rejection', async () => {
    const durableStore = store();
    vi.mocked(durableStore.enqueueOutbox).mockResolvedValue({ kind: 'conflict' });
    const ds = daemonSession();
    const facade = createDurableSessionFacade({ store: durableStore, ownerId: 'final-output-boot' });
    await expect(enqueueDurableLarkFinalOutput({
      daemonSession: ds, facade, store: durableStore, inbound, message: outbox(),
    })).resolves.toEqual({ kind: 'outbox_conflict' });
    expect(finalOutputDeliveryCount(ds)).toBe(0);
    await facade.stop();
  });

  it('releases final-drain when a pending settlement is aborted locally', async () => {
    vi.useFakeTimers();
    try {
      const durableStore = store();
      vi.mocked(durableStore.readOutbox).mockResolvedValue(outbox('pending'));
      const ds = daemonSession();
      const facade = createDurableSessionFacade({ store: durableStore, ownerId: 'final-output-boot' });
      const controller = new AbortController();
      const accepted = await enqueueDurableLarkFinalOutput({
        daemonSession: ds, facade, store: durableStore, inbound, message: outbox(),
        intervalMs: 10, signal: controller.signal,
      });
      expect(finalOutputDeliveryCount(ds)).toBe(1);
      controller.abort(new Error('shutdown'));
      if (accepted.kind !== 'accepted') throw new Error('expected accepted output');
      await expect(accepted.settlement).rejects.toThrow('shutdown');
      await Promise.resolve();
      expect(finalOutputDeliveryCount(ds)).toBe(0);
      await facade.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
