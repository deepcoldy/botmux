import type { DurableJson } from './durable-coordination.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function canonicalMention(value: unknown): Record<string, string> | undefined {
  const mention = record(value);
  if (!mention) return undefined;
  const rawId = mention.id;
  const id = record(rawId);
  const idType = text(mention.id_type) ?? text(mention.idType);
  const openId = text(id?.open_id)
    ?? (typeof rawId === 'string' && (!idType || idType === 'open_id') ? rawId : undefined);
  const appId = text(id?.app_id)
    ?? (typeof rawId === 'string' && idType === 'app_id' ? rawId : undefined);
  const userId = text(id?.user_id)
    ?? (typeof rawId === 'string' && idType === 'user_id' ? rawId : undefined);
  return {
    ...(text(mention.key) ? { key: text(mention.key)! } : {}),
    ...(text(mention.name) ? { name: text(mention.name)! } : {}),
    ...(openId ? { openId } : {}),
    ...(!openId && appId ? { appId } : {}),
    ...(!openId && !appId && userId ? { userId } : {}),
  };
}

function canonicalLarkReceive(input: {
  eventId: string;
  lane?: string;
  partitionKey: string;
  payload: DurableJson;
}): string | undefined {
  if ((input.lane ?? 'lark-message') !== 'lark-message') return undefined;
  const payload = record(input.payload);
  if (payload?.version !== 1 || payload.type !== 'lark.im.message.receive_v1') return undefined;
  const larkAppId = text(payload.larkAppId);
  const event = record(payload.event);
  const nested = record(event?.event);
  const message = record(event?.message ?? nested?.message);
  const messageId = text(message?.message_id);
  const chatId = text(message?.chat_id);
  if (!larkAppId?.startsWith('cli_') || !messageId?.startsWith('om_') || !chatId) return undefined;
  if (input.eventId !== `im.message.receive_v1:${larkAppId}:${messageId}`) return undefined;
  if (input.partitionKey !== `lark-message-routing:${larkAppId}:${chatId}`) return undefined;
  const sender = record(event?.sender);
  const senderId = record(sender?.sender_id);
  const senderType = text(sender?.sender_type);
  const senderOpenId = text(senderId?.open_id);
  const mentions = Array.isArray(message?.mentions)
    ? message.mentions.map(canonicalMention).filter((item): item is Record<string, string> => !!item)
    : [];
  return JSON.stringify({
    larkAppId,
    messageId,
    chatId,
    chatType: text(message?.chat_type),
    rootId: text(message?.root_id),
    threadId: text(message?.thread_id),
    parentId: text(message?.parent_id),
    messageType: text(message?.message_type) ?? text(message?.msg_type),
    content: text(message?.content) ?? text(record(message?.body)?.content),
    createTime: text(message?.create_time),
    senderType: senderType === 'app' || senderType === 'bot' ? 'bot' : senderType,
    senderOpenId,
    senderAppId: senderOpenId ? undefined : text(senderId?.app_id),
    mentions,
  });
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
  return canonicalLarkReceive(input);
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
