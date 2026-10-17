import type { DurableJson } from './durable-coordination.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Lark message receive events have two authoritative representations: the
 * realtime WS event and the REST history row used for failover reconciliation.
 * Their optional identity fields differ even for the same immutable message.
 * This key lets stores recognise those two snapshots as one event while still
 * rejecting a reused event id whose app/message/partition identity differs.
 * The first persisted payload remains canonical; a later representation never
 * overwrites it.
 */
export function durableInboxSemanticKey(input: {
  eventId: string;
  lane?: string;
  partitionKey: string;
  payload: DurableJson;
}): string | undefined {
  if ((input.lane ?? 'lark-message') !== 'lark-message') return undefined;
  const payload = record(input.payload);
  if (payload?.version !== 1 || payload.type !== 'lark.im.message.receive_v1') return undefined;
  const larkAppId = payload.larkAppId;
  const event = record(payload.event);
  const nested = record(event?.event);
  const message = record(event?.message ?? nested?.message);
  const messageId = message?.message_id;
  if (typeof larkAppId !== 'string' || !larkAppId.startsWith('cli_')
      || typeof messageId !== 'string' || !messageId.startsWith('om_')) return undefined;
  if (input.eventId !== `im.message.receive_v1:${larkAppId}:${messageId}`) return undefined;
  if (!input.partitionKey.startsWith(`lark-message-routing:${larkAppId}:`)) return undefined;
  return `lark.im.message.receive_v1\0${larkAppId}\0${messageId}\0${input.partitionKey}`;
}

export function durableInboxPayloadsAreEquivalent(
  existing: { eventId: string; lane?: string; partitionKey: string; payload: DurableJson },
  incoming: { eventId: string; lane?: string; partitionKey: string; payload: DurableJson },
): boolean {
  if (existing.eventId !== incoming.eventId
      || (existing.lane ?? 'lark-message') !== (incoming.lane ?? 'lark-message')
      || existing.partitionKey !== incoming.partitionKey) return false;
  const existingKey = durableInboxSemanticKey(existing);
  return existingKey !== undefined && existingKey === durableInboxSemanticKey(incoming);
}
