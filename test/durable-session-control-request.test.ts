import { describe, expect, it, vi } from 'vitest';
import type {
  DurableCoordinationStore,
  DurableSessionRecord,
} from '../src/services/durable-coordination.js';
import { requestDurableSessionControl } from '../src/services/durable-session-control-request.js';

function record(status: 'active' | 'closed', revision: number, withControl = false): DurableSessionRecord {
  const operationId = 'trusted-host.session-control:cli_test:session-1:7:close';
  return {
    sessionKey: 'om_root::cli_test',
    revision,
    updatedAt: revision,
    value: {
      version: 1,
      type: 'botmux.session.primary',
      session: {
        sessionId: 'session-1',
        chatId: 'oc_chat',
        rootMessageId: 'om_root',
        scope: 'thread',
        title: 'fixture',
        status,
        createdAt: '2026-10-18T00:00:00.000Z',
        larkAppId: 'cli_test',
        streamCardId: 'om_card',
      },
      admission: {
        version: 1,
        type: 'botmux.lark.session-admission',
        eventId: 'im.message.receive_v1:cli_test:om_seed',
        partitionKey: 'lark-message-routing:cli_test:oc_chat',
        larkAppId: 'cli_test',
        messageId: 'om_seed',
      },
      admissions: [{
        version: 1,
        type: 'botmux.lark.session-admission',
        eventId: 'im.message.receive_v1:cli_test:om_seed',
        partitionKey: 'lark-message-routing:cli_test:oc_chat',
        larkAppId: 'cli_test',
        messageId: 'om_seed',
      }],
      ...(withControl ? {
        control: {
          version: 1,
          type: 'botmux.lark.session-control-commit',
          operationId,
          larkAppId: 'cli_test',
          action: 'close',
          sessionId: 'session-1',
          operatorOpenId: 'trusted-host',
          cardMessageId: 'om_card',
          source: 'trusted-host',
          result: { status: 'closed' },
        },
        controls: [{
          version: 1,
          type: 'botmux.lark.session-control-commit',
          operationId,
          larkAppId: 'cli_test',
          action: 'close',
          sessionId: 'session-1',
          operatorOpenId: 'trusted-host',
          cardMessageId: 'om_card',
          source: 'trusted-host',
          result: { status: 'closed' },
        }],
      } : {}),
    },
  };
}

describe('trusted-host durable Session control request', () => {
  it('waits for the exact control commit instead of treating enqueue as close', async () => {
    let current = record('active', 7);
    let clock = 100;
    const enqueueInbox = vi.fn(async event => {
      expect(event).toMatchObject({
        eventId: 'trusted-host.session-control:cli_test:session-1:7:close',
        lane: 'session-control',
        partitionKey: 'lark-session-control:cli_test:session-1',
        payload: {
          type: 'botmux.session.control',
          source: 'trusted-host',
          action: 'close',
          sessionId: 'session-1',
        },
      });
      return { kind: 'inserted' as const };
    });
    const store = {
      readSession: vi.fn(async () => current),
      enqueueInbox,
    } as unknown as DurableCoordinationStore;

    const result = await requestDurableSessionControl({
      store,
      request: {
        larkAppId: 'cli_test',
        sessionKey: 'om_root::cli_test',
        sessionId: 'session-1',
        action: 'close',
      },
      now: () => clock,
      wait: async () => {
        current = record('closed', 8, true);
        clock += 1;
      },
      timeoutMs: 10,
      pollIntervalMs: 1,
    });

    expect(result).toEqual({ ok: true, outcome: 'closed' });
    expect(enqueueInbox).toHaveBeenCalledOnce();
  });

  it('returns idempotent success without enqueueing an already closed canonical Session', async () => {
    const enqueueInbox = vi.fn();
    const store = {
      readSession: vi.fn(async () => record('closed', 9)),
      enqueueInbox,
    } as unknown as DurableCoordinationStore;

    await expect(requestDurableSessionControl({
      store,
      request: {
        larkAppId: 'cli_test',
        sessionKey: 'om_root::cli_test',
        sessionId: 'session-1',
        action: 'close',
      },
    })).resolves.toEqual({ ok: true, outcome: 'closed', alreadyClosed: true });
    expect(enqueueInbox).not.toHaveBeenCalled();
  });

  it('finds a canonical Session by id when the replica has no local routing row', async () => {
    const closed = record('closed', 9);
    const listSessions = vi.fn(async () => ({ records: [closed] }));
    const store = {
      readSession: vi.fn(),
      listSessions,
      enqueueInbox: vi.fn(),
    } as unknown as DurableCoordinationStore;

    await expect(requestDurableSessionControl({
      store,
      request: {
        larkAppId: 'cli_test',
        sessionId: 'session-1',
        action: 'close',
      },
    })).resolves.toEqual({ ok: true, outcome: 'closed', alreadyClosed: true });
    expect(listSessions).toHaveBeenCalledWith({ limit: 256 });
    expect(store.readSession).not.toHaveBeenCalled();
  });
});
