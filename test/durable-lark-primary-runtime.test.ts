import { describe, expect, it, vi } from 'vitest';
import type { DurableCoordinationStore } from '../src/services/durable-coordination.js';
import { startDurableLarkPrimaryRuntime } from '../src/services/durable-lark-primary-runtime.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function store(order: string[]): DurableCoordinationStore {
  return {
    acquireSessionLease: vi.fn(async input => ({
      kind: 'acquired',
      lease: { sessionKey: input.sessionKey, ownerId: input.ownerId, epoch: 1, leaseUntil: 60_000 },
    })),
    renewSessionLease: vi.fn(),
    releaseSessionLease: vi.fn(async lease => {
      order.push(`release:${lease.sessionKey}`);
      return { kind: 'applied', lease };
    }),
    readSession: vi.fn(),
    writeSession: vi.fn(),
    enqueueInbox: vi.fn(async () => ({ kind: 'inserted' })),
    claimNextInbox: vi.fn(async () => undefined),
    renewInboxClaim: vi.fn(),
    completeInboxClaim: vi.fn(),
    retryInboxClaim: vi.fn(),
    enqueueOutbox: vi.fn(),
    reserveNextOutbox: vi.fn(async () => undefined),
    beginOutboxAttempt: vi.fn(),
    completeOutboxAttempt: vi.fn(),
    retryOutboxAttempt: vi.fn(),
    markOutboxAmbiguous: vi.fn(),
    readOutbox: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

describe('durable Lark primary runtime', () => {
  it('starts consumer/pump before owning ingress and stops WS cleanup before lease release', async () => {
    const order: string[] = [];
    const durableStore = store(order);
    const runtime = startDurableLarkPrimaryRuntime({
      store: durableStore,
      larkAppId: 'cli_test',
      ingressOwnerId: 'ingress-boot',
      inboxWorkerId: 'inbox-boot',
      outboxWorkerId: 'outbox-boot',
      sessionOwnerId: 'session-boot',
      handleCanonical: async () => ({ kind: 'ignored', reason: 'fixture' }),
      deliverOutbox: async () => ({ kind: 'ambiguous', error: 'fixture' }),
      onLeadershipAcquired: () => { order.push('ws-start'); },
      onLeadershipLost: async () => { order.push('ws-stop'); },
    });

    await runtime.ready;
    expect(runtime.status()).toEqual({ kind: 'leader', epoch: 1 });
    expect(order).toEqual(['ws-start']);
    await expect(runtime.ingress.enqueueBeforeAck({
      eventId: 'im.message.receive_v1:cli_test:om_message',
      partitionKey: 'lark-message-routing:cli_test:oc_chat',
      data: { message: { message_id: 'om_message' } },
    })).resolves.toEqual({ kind: 'inserted' });

    await expect(runtime.stop()).resolves.toMatchObject({ kind: 'stopped' });
    expect(order.slice(0, 3)).toEqual([
      'ws-start',
      'ws-stop',
      'release:botmux.ingress:lark:cli_test',
    ]);
    expect(runtime.status()).toEqual({ kind: 'stopped' });
  });

  it('validates the shared shutdown budget before stopping any component', async () => {
    const order: string[] = [];
    const runtime = startDurableLarkPrimaryRuntime({
      store: store(order),
      larkAppId: 'cli_test',
      handleCanonical: async () => ({ kind: 'ignored', reason: 'fixture' }),
      deliverOutbox: async () => ({ kind: 'ambiguous', error: 'fixture' }),
    });
    await runtime.ready;

    expect(() => runtime.stop(-1)).toThrow(/timeoutMs/);
    expect(runtime.status()).toEqual({ kind: 'leader', epoch: 1 });
    await runtime.stop();
  });

  it('settles an exact delivered result that arrives after timeout ambiguity', async () => {
    const order: string[] = [];
    const durableStore = store(order);
    const delivered = deferred<{ kind: 'delivered'; receipt: { providerMessageId: string } }>();
    const record = {
        messageId: 'message-late',
        sessionKey: 'session-late',
        payload: { text: 'hello' },
        visibleAt: 1,
        createdAt: 1,
        state: 'reserved' as const,
        originEpoch: 1,
        attempts: 0,
        updatedAt: 1,
    };
    const reservation = {
        record,
        workerId: 'outbox-boot:0',
        claimEpoch: 1,
        claimUntil: 1_001,
    };
    const attempt = {
        ...reservation,
        record: { ...record, state: 'attempting' as const, attempts: 1 },
        attempt: 1,
    };
    durableStore.reserveNextOutbox = vi.fn()
      .mockResolvedValueOnce(reservation)
      .mockResolvedValue(undefined);
    durableStore.beginOutboxAttempt = vi.fn(async () => ({
      kind: 'applied' as const,
      record: attempt.record,
      attempt,
    }));
    durableStore.markOutboxAmbiguous = vi.fn(async () => ({
      kind: 'applied' as const,
      record: { ...attempt.record, state: 'ambiguous' as const },
    }));
    durableStore.completeOutboxAttempt = vi.fn(async () => ({
      kind: 'applied' as const,
      record: { ...attempt.record, state: 'delivered' as const },
    }));
    const onError = vi.fn();
    const runtime = startDurableLarkPrimaryRuntime({
      store: durableStore,
      larkAppId: 'cli_test',
      outboxWorkerId: 'outbox-boot',
      outboxReservationLeaseMs: 1_000,
      outboxAttemptTimeoutMs: 100,
      outboxIntervalMs: 60_000,
      handleCanonical: async () => ({ kind: 'ignored', reason: 'fixture' }),
      deliverOutbox: async () => await delivered.promise,
      onError,
    });

    await runtime.ready;
    expect(durableStore.markOutboxAmbiguous).toHaveBeenCalledOnce();
    expect(durableStore.completeOutboxAttempt).not.toHaveBeenCalled();

    delivered.resolve({ kind: 'delivered', receipt: { providerMessageId: 'om_late' } });
    await vi.waitFor(() => {
      expect(durableStore.completeOutboxAttempt).toHaveBeenCalledWith({
        attempt,
        receipt: { providerMessageId: 'om_late' },
      });
    });
    expect(onError).not.toHaveBeenCalled();
    await runtime.stop();
  });
});
