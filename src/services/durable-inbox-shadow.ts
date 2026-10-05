import type {
  DurableInboxEvent,
  DurableInboxStore,
  DurableInsertResult,
  DurableJson,
} from './durable-coordination.js';

export interface DurableLarkMessageEnvelope {
  version: 1;
  type: 'lark.im.message.receive_v1';
  larkAppId: string;
  event: DurableJson;
}

function jsonValue(value: unknown): DurableJson {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Lark event is not JSON-serializable');
  return JSON.parse(encoded) as DurableJson;
}

/** Build the durable ingress row only after the Lark callback has been ACKed.
 * `eventId` and `partitionKey` are computed synchronously by the existing hot
 * path, but JSON serialization stays behind setImmediate. */
export function durableLarkMessageEvent(input: {
  larkAppId: string;
  eventId: string;
  partitionKey: string;
  data: unknown;
  now?: number;
}): DurableInboxEvent {
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('durable inbox timestamp is invalid');
  const payload: DurableLarkMessageEnvelope = {
    version: 1,
    type: 'lark.im.message.receive_v1',
    larkAppId: input.larkAppId,
    event: jsonValue(input.data),
  };
  return {
    eventId: input.eventId,
    partitionKey: input.partitionKey,
    payload: payload as unknown as DurableJson,
    visibleAt: now,
    createdAt: now,
  };
}

export async function enqueueDurableLarkMessage(
  store: DurableInboxStore,
  input: Parameters<typeof durableLarkMessageEvent>[0],
): Promise<DurableInsertResult> {
  return await store.enqueueInbox(durableLarkMessageEvent(input));
}
