import { describe, expect, it, vi } from 'vitest';
import type { DurableCoordinationStore } from '../src/services/durable-coordination.js';
import { startDurableLarkPrimaryRuntime } from '../src/services/durable-lark-primary-runtime.js';

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
});
