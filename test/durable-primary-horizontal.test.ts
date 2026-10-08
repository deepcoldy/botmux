import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../src/types.js';
import { sessionKey } from '../src/core/types.js';
import { durableLarkOutboxMessage } from '../src/services/durable-lark-outbox.js';
import { enqueueDurableLarkSessionOutput } from '../src/services/durable-lark-session-output.js';
import { startDurableLarkPrimaryRuntime, type DurableLarkPrimaryRuntime } from '../src/services/durable-lark-primary-runtime.js';
import { parseDurablePrimarySessionRecord } from '../src/services/durable-session-primary.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('durable primary horizontal failover', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('admits and delivers 100 independent Sessions across ingress leader failover', async () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-primary-horizontal-'));
    roots.push(root);
    const dbPath = join(root, 'coordination.db');
    const stores = [
      new SqliteDurableCoordinationStore(dbPath),
      new SqliteDurableCoordinationStore(dbPath),
    ];
    const handled = new Set<string>();
    const delivered = new Set<string>();
    const sessions = new Map<string, Session>();
    const makeRuntime = (index: number): DurableLarkPrimaryRuntime => startDurableLarkPrimaryRuntime({
      store: stores[index],
      larkAppId: 'cli_horizontal',
      ingressOwnerId: `ingress-${index}`,
      inboxWorkerId: `inbox-${index}`,
      outboxWorkerId: `outbox-${index}`,
      sessionOwnerId: `session-${index}`,
      ingressElectionIntervalMs: 100,
      inboxIntervalMs: 10,
      outboxIntervalMs: 10,
      handleCanonical: async message => {
        handled.add(message.eventId);
        const session: Session = {
          sessionId: `session-${message.messageId}`,
          chatId: `oc_${message.messageId.slice(3)}`,
          rootMessageId: message.messageId,
          scope: 'thread',
          title: message.messageId,
          status: 'active',
          createdAt: '2026-10-06T00:00:00.000Z',
          larkAppId: message.larkAppId,
        };
        sessions.set(message.messageId, session);
        return { kind: 'admitted', session };
      },
      deliverOutbox: async record => {
        if (!delivered.has(record.messageId)) delivered.add(record.messageId);
        return {
          kind: 'delivered',
          receipt: { provider: 'fixture', providerMessageId: `om_${record.messageId}` },
        };
      },
    });
    const runtimes = [makeRuntime(0), makeRuntime(1)];

    try {
      await Promise.all(runtimes.map(runtime => runtime.ready));
      await waitUntil(() => runtimes.filter(runtime => runtime.status().kind === 'leader').length === 1);
      const firstLeaderIndex = runtimes.findIndex(runtime => runtime.status().kind === 'leader');
      const firstLeader = runtimes[firstLeaderIndex];
      const survivorIndex = firstLeaderIndex === 0 ? 1 : 0;
      const survivor = runtimes[survivorIndex];

      for (let i = 0; i < 50; i++) {
        const messageId = `om_event_${i}`;
        await firstLeader.ingress.enqueueBeforeAck({
          eventId: `im.message.receive_v1:cli_horizontal:${messageId}`,
          partitionKey: `lark-message-routing:cli_horizontal:oc_chat_${i}`,
          data: { message: { message_id: messageId } },
        });
      }
      await waitUntil(() => handled.size === 50);
      await firstLeader.stop();
      await waitUntil(() => survivor.status().kind === 'leader');

      const staleSession = sessions.get('om_event_0')!;
      await expect(enqueueDurableLarkSessionOutput({
        facade: firstLeader.session,
        store: stores[firstLeaderIndex],
        inbound: {
          eventType: 'lark.im.message.receive_v1',
          eventId: 'im.message.receive_v1:cli_horizontal:om_event_0',
          partitionKey: 'lark-message-routing:cli_horizontal:oc_chat_0',
          larkAppId: 'cli_horizontal',
          messageId: 'om_event_0',
          attempts: 1,
          data: {},
        },
        session: staleSession,
        message: durableLarkOutboxMessage({
          messageId: 'out_stale_owner',
          sessionKey: sessionKey(staleSession.rootMessageId, 'cli_horizontal'),
          larkAppId: 'cli_horizontal',
          target: { kind: 'send', chatId: 'oc_result' },
          content: 'must not deliver',
          providerUuid: 'stale_owner',
        }),
        intervalMs: 10,
      })).resolves.toEqual({ kind: 'session_unavailable', reason: 'stopped' });
      await expect(stores[firstLeaderIndex].readOutbox('out_stale_owner')).resolves.toBeUndefined();

      for (let i = 50; i < 100; i++) {
        const messageId = `om_event_${i}`;
        await survivor.ingress.enqueueBeforeAck({
          eventId: `im.message.receive_v1:cli_horizontal:${messageId}`,
          partitionKey: `lark-message-routing:cli_horizontal:oc_chat_${i}`,
          data: { message: { message_id: messageId } },
        });
      }
      await waitUntil(() => handled.size === 100);
      await waitUntil(async () => {
        for (const session of sessions.values()) {
          if (!await stores[survivorIndex].readSession(sessionKey(session.rootMessageId, 'cli_horizontal'))) {
            return false;
          }
        }
        return true;
      });

      const settlements: Promise<unknown>[] = [];
      for (let i = 0; i < 100; i++) {
        const messageId = `om_event_${i}`;
        const session = sessions.get(messageId)!;
        const record = await stores[survivorIndex].readSession(
          sessionKey(session.rootMessageId, 'cli_horizontal'),
        );
        expect(record).toBeDefined();
        expect(parseDurablePrimarySessionRecord(record!).admission.messageId).toBe(messageId);
        const output = await enqueueDurableLarkSessionOutput({
          facade: survivor.session,
          store: stores[survivorIndex],
          inbound: {
            eventType: 'lark.im.message.receive_v1',
            eventId: `im.message.receive_v1:cli_horizontal:${messageId}`,
            partitionKey: `lark-message-routing:cli_horizontal:oc_chat_${i}`,
            larkAppId: 'cli_horizontal',
            messageId,
            attempts: 1,
            data: {},
          },
          session,
          message: durableLarkOutboxMessage({
            messageId: `out_${i}`,
            sessionKey: sessionKey(session.rootMessageId, 'cli_horizontal'),
            larkAppId: 'cli_horizontal',
            target: { kind: 'send', chatId: 'oc_result' },
            content: `result ${i}`,
            providerUuid: `horizontal_${i}`,
          }),
          intervalMs: 10,
        });
        expect(output.kind).toBe('accepted');
        if (output.kind === 'accepted') settlements.push(output.settlement);
      }
      await Promise.all(settlements);

      expect(handled.size).toBe(100);
      expect(delivered.size).toBe(100);
      for (let i = 0; i < 100; i++) {
        await expect(stores[survivorIndex].readOutbox(`out_${i}`)).resolves.toMatchObject({
          state: 'delivered',
          attempts: 1,
        });
      }
    } finally {
      await Promise.all(runtimes.map(runtime => runtime.stop().catch(() => undefined)));
      await Promise.all(stores.map(store => store.close()));
    }
  }, 20_000);
});
