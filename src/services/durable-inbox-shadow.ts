import type {
  InboxClaim,
  DurableInboxEvent,
  DurableInboxStore,
  DurableInsertResult,
  DurableJson,
} from './durable-coordination.js';

export type DurableLarkMessageEventType =
  | 'lark.im.message.receive_v1'
  | 'lark.im.message.updated_v1';

export interface DurableLarkMessageEnvelope {
  version: 1;
  type: DurableLarkMessageEventType;
  larkAppId: string;
  event: DurableJson;
}

export interface DurableLarkMessageObservation {
  eventType: DurableLarkMessageEventType;
  eventId: string;
  partitionKey: string;
  larkAppId: string;
  messageId: string;
  attempts: number;
}

export interface DurableLarkMessageClaim extends DurableLarkMessageObservation {
  /** 原始 receive_v1 event；只在完整身份校验通过后暴露给 consumer。 */
  data: DurableJson;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Validate the shadow row independently from the live Lark route. A row that
 * cannot prove the same stable message identity is retried instead of being
 * silently acknowledged, so schema drift remains visible before `primary` is
 * enabled. */
export function observeDurableLarkMessageClaim(claim: InboxClaim): DurableLarkMessageObservation {
  const parsed = parseDurableLarkMessageClaim(claim);
  const { data: _data, ...observation } = parsed;
  return observation;
}

/**
 * Validate and unwrap one durable Lark event for a real consumer. Keeping this
 * beside the shadow observer guarantees both modes enforce the same stable
 * app/message/partition identity before any handler can see the payload.
 */
export function parseDurableLarkMessageClaim(claim: InboxClaim): DurableLarkMessageClaim {
  const payload = record(claim.event.payload);
  const event = record(payload?.event);
  const nestedEvent = record(event?.event);
  const message = record(event?.message ?? nestedEvent?.message);
  const eventType = payload?.type;
  const larkAppId = payload?.larkAppId;
  const messageId = message?.message_id;
  if (payload?.version !== 1
      || (eventType !== 'lark.im.message.receive_v1'
        && eventType !== 'lark.im.message.updated_v1')
      || typeof larkAppId !== 'string'
      || !larkAppId.startsWith('cli_')
      || larkAppId.length > 256
      || typeof messageId !== 'string'
      || !messageId.startsWith('om_')
      || messageId.length > 256) {
    throw new Error(`durable Lark inbox event ${claim.event.eventId} has an invalid shadow envelope`);
  }
  const expectedReceiveEventId = `im.message.receive_v1:${larkAppId}:${messageId}`;
  const expectedUpdatedPrefix = `im.message.updated_v1:${larkAppId}:`;
  if ((eventType === 'lark.im.message.receive_v1'
      && claim.event.eventId !== expectedReceiveEventId)
      || (eventType === 'lark.im.message.updated_v1'
        && (!claim.event.eventId.startsWith(expectedUpdatedPrefix)
          || claim.event.eventId.length === expectedUpdatedPrefix.length))) {
    throw new Error(`durable Lark inbox event ${claim.event.eventId} has a mismatched message identity`);
  }
  if (!claim.event.partitionKey.startsWith(`lark-message-routing:${larkAppId}:`)) {
    throw new Error(`durable Lark inbox event ${claim.event.eventId} has a mismatched routing partition`);
  }
  return {
    eventType,
    eventId: claim.event.eventId,
    partitionKey: claim.event.partitionKey,
    larkAppId,
    messageId,
    attempts: claim.attempts,
    data: payload.event as DurableJson,
  };
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
  eventType?: DurableLarkMessageEventType;
  eventId: string;
  partitionKey: string;
  data: unknown;
  now?: number;
}): DurableInboxEvent {
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('durable inbox timestamp is invalid');
  const payload: DurableLarkMessageEnvelope = {
    version: 1,
    type: input.eventType ?? 'lark.im.message.receive_v1',
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
