import { describe, expect, it, vi } from 'vitest';
import type { DurableInboxStore } from '../src/services/durable-coordination.js';
import {
  durableLarkMessageEvent,
  enqueueDurableLarkMessage,
  observeDurableLarkMessageClaim,
} from '../src/services/durable-inbox-shadow.js';

describe('durable Lark inbox shadow', () => {
  it('builds a stable provider-neutral envelope behind the ACK boundary', () => {
    const data = {
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        content: '{"text":"hello"}',
      },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
    };
    expect(durableLarkMessageEvent({
      larkAppId: 'cli_1',
      eventId: 'im.message.receive_v1:cli_1:om_1',
      partitionKey: 'lark-message-routing:cli_1:oc_1',
      data,
      now: 1234,
    })).toEqual({
      eventId: 'im.message.receive_v1:cli_1:om_1',
      lane: 'lark-message',
      partitionKey: 'lark-message-routing:cli_1:oc_1',
      payload: {
        version: 1,
        type: 'lark.im.message.receive_v1',
        larkAppId: 'cli_1',
        event: data,
      },
      visibleAt: 1234,
      createdAt: 1234,
    });
  });

  it('forwards insert outcomes without treating duplicate as failure', async () => {
    const enqueueInbox = vi.fn(async () => ({ kind: 'duplicate' as const }));
    const store = { enqueueInbox } as unknown as DurableInboxStore;
    await expect(enqueueDurableLarkMessage(store, {
      larkAppId: 'cli_1',
      eventId: 'event-1',
      partitionKey: 'partition-1',
      data: { message: { message_id: 'om_1' } },
      now: 10,
    })).resolves.toEqual({ kind: 'duplicate' });
    expect(enqueueInbox).toHaveBeenCalledOnce();
  });

  it('keeps volatile timestamps outside the payload fingerprint', () => {
    const first = durableLarkMessageEvent({
      larkAppId: 'cli_1', eventId: 'event-1', partitionKey: 'partition-1', data: { value: 1 }, now: 10,
    });
    const second = durableLarkMessageEvent({
      larkAppId: 'cli_1', eventId: 'event-1', partitionKey: 'partition-1', data: { value: 1 }, now: 20,
    });
    expect(first.payload).toEqual(second.payload);
    expect(first.createdAt).not.toBe(second.createdAt);
  });

  it('revalidates stable message identity after a durable claim', () => {
    const event = durableLarkMessageEvent({
      larkAppId: 'cli_1',
      eventId: 'im.message.receive_v1:cli_1:om_1',
      partitionKey: 'lark-message-routing:cli_1:oc_1',
      data: { message: { message_id: 'om_1' } },
      now: 10,
    });
    expect(observeDurableLarkMessageClaim({
      event,
      workerId: 'worker-1',
      claimEpoch: 1,
      claimUntil: 100,
      attempts: 1,
    })).toEqual({
      eventType: 'lark.im.message.receive_v1',
      eventId: event.eventId,
      partitionKey: event.partitionKey,
      larkAppId: 'cli_1',
      messageId: 'om_1',
      attempts: 1,
    });
  });

  it('persists and revalidates a message-updated event for primary processing', () => {
    const event = durableLarkMessageEvent({
      larkAppId: 'cli_1',
      eventType: 'lark.im.message.updated_v1',
      eventId: 'im.message.updated_v1:cli_1:evt_edit_1',
      partitionKey: 'lark-message-routing:cli_1:oc_1',
      data: { event_id: 'evt_edit_1', message: { message_id: 'om_1', chat_id: 'oc_1' } },
      now: 10,
    });
    expect(observeDurableLarkMessageClaim({
      event,
      workerId: 'worker-1',
      claimEpoch: 1,
      claimUntil: 100,
      attempts: 1,
    })).toMatchObject({
      eventType: 'lark.im.message.updated_v1',
      eventId: 'im.message.updated_v1:cli_1:evt_edit_1',
      messageId: 'om_1',
    });
  });

  it('rejects a claimed envelope whose durable event id does not match the message', () => {
    const event = durableLarkMessageEvent({
      larkAppId: 'cli_1',
      eventId: 'im.message.receive_v1:cli_1:om_wrong',
      partitionKey: 'lark-message-routing:cli_1:oc_1',
      data: { message: { message_id: 'om_1' } },
      now: 10,
    });
    expect(() => observeDurableLarkMessageClaim({
      event,
      workerId: 'worker-1',
      claimEpoch: 1,
      claimUntil: 100,
      attempts: 1,
    })).toThrow(/mismatched message identity/);
  });

  it('rejects a control-lane claim before exposing it to the message router', () => {
    const event = durableLarkMessageEvent({
      larkAppId: 'cli_1',
      eventId: 'im.message.receive_v1:cli_1:om_1',
      partitionKey: 'lark-message-routing:cli_1:oc_1',
      data: { message: { message_id: 'om_1' } },
      now: 10,
    });
    expect(() => observeDurableLarkMessageClaim({
      event: { ...event, lane: 'session-control' },
      workerId: 'worker-1',
      claimEpoch: 1,
      claimUntil: 100,
      attempts: 1,
    })).toThrow(/invalid shadow envelope/);
  });
});
