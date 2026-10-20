import type { DurableJson } from './durable-coordination.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

interface CanonicalIdentity {
  openId?: string;
  unionId?: string;
  userId?: string;
  appId?: string;
}

interface CanonicalMention extends CanonicalIdentity {
  key?: string;
}

interface CanonicalLarkReceive {
  larkAppId: string;
  messageId: string;
  chatId: string;
  chatType?: string;
  rootId?: string;
  threadId?: string;
  parentId?: string;
  messageType?: string;
  content?: string;
  createTime?: string;
  senderType?: string;
  sender: CanonicalIdentity;
  mentions: CanonicalMention[];
}

function canonicalIdentity(value: unknown, rawIdType?: unknown): CanonicalIdentity {
  const id = record(value);
  const idType = text(rawIdType);
  const rawId = typeof value === 'string' ? value : undefined;
  return {
    ...(text(id?.open_id) ?? (rawId && (!idType || idType === 'open_id') ? rawId : undefined)
      ? { openId: text(id?.open_id) ?? rawId! }
      : {}),
    ...(text(id?.union_id) ?? (rawId && idType === 'union_id' ? rawId : undefined)
      ? { unionId: text(id?.union_id) ?? rawId! }
      : {}),
    ...(text(id?.user_id) ?? (rawId && idType === 'user_id' ? rawId : undefined)
      ? { userId: text(id?.user_id) ?? rawId! }
      : {}),
    ...(text(id?.app_id) ?? (rawId && idType === 'app_id' ? rawId : undefined)
      ? { appId: text(id?.app_id) ?? rawId! }
      : {}),
  };
}

function canonicalMention(value: unknown): CanonicalMention | undefined {
  const mention = record(value);
  if (!mention) return undefined;
  // Display names are mutable presentation metadata and are inconsistently
  // populated by message.list, message.get, and realtime delivery. Routing is
  // bound by the placeholder key plus stable identity overlap below.
  return {
    ...(text(mention.key) ? { key: text(mention.key)! } : {}),
    ...canonicalIdentity(mention.id, text(mention.id_type) ?? text(mention.idType)),
  };
}

function canonicalLarkReceive(input: {
  eventId: string;
  lane?: string;
  partitionKey: string;
  payload: DurableJson;
}): CanonicalLarkReceive | undefined {
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
  const sender = record(event?.sender ?? nested?.sender);
  const senderId = record(sender?.sender_id);
  const senderType = text(sender?.sender_type);
  const mentions = Array.isArray(message?.mentions)
    ? message.mentions.map(canonicalMention).filter((item): item is CanonicalMention => !!item)
    : [];
  return {
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
    sender: canonicalIdentity(senderId),
    mentions,
  };
}

function identitiesCompatible(left: CanonicalIdentity, right: CanonicalIdentity): boolean {
  const keys: Array<keyof CanonicalIdentity> = ['openId', 'unionId', 'userId', 'appId'];
  let leftHasIdentity = false;
  let rightHasIdentity = false;
  let sharedIdentity = false;
  for (const key of keys) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue) leftHasIdentity = true;
    if (rightValue) rightHasIdentity = true;
    if (leftValue && rightValue) {
      if (leftValue !== rightValue) return false;
      sharedIdentity = true;
    }
  }
  return (!leftHasIdentity && !rightHasIdentity) || sharedIdentity;
}

function mentionsCompatible(left: CanonicalMention[], right: CanonicalMention[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((mention, index) => {
    const other = right[index]!;
    return mention.key === other.key
      && identitiesCompatible(mention, other);
  });
}

const LARK_CARD_UPGRADE_FALLBACK = '请升级至最新版本客户端';

function messageContentsCompatible(
  left: Pick<CanonicalLarkReceive, 'messageType' | 'content'>,
  right: Pick<CanonicalLarkReceive, 'messageType' | 'content'>,
): boolean {
  if (left.content === right.content) return true;
  return left.messageType === 'interactive'
    && right.messageType === 'interactive'
    && (left.content?.includes(LARK_CARD_UPGRADE_FALLBACK) === true
      || right.content?.includes(LARK_CARD_UPGRADE_FALLBACK) === true);
}

function receivePayloadsAreEquivalent(
  left: CanonicalLarkReceive,
  right: CanonicalLarkReceive,
): boolean {
  const {
    sender: leftSender, mentions: leftMentions, content: leftContent, ...leftMessage
  } = left;
  const {
    sender: rightSender, mentions: rightMentions, content: rightContent, ...rightMessage
  } = right;
  return JSON.stringify(leftMessage) === JSON.stringify(rightMessage)
    && messageContentsCompatible(
      { messageType: left.messageType, content: leftContent },
      { messageType: right.messageType, content: rightContent },
    )
    && identitiesCompatible(leftSender, rightSender)
    && mentionsCompatible(leftMentions, rightMentions);
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
  const canonical = canonicalLarkReceive(input);
  return canonical ? JSON.stringify(canonical) : undefined;
}

export function durableInboxPayloadsAreEquivalent(
  existing: { eventId: string; lane?: string; partitionKey: string; payload: DurableJson },
  incoming: { eventId: string; lane?: string; partitionKey: string; payload: DurableJson },
): boolean {
  if (existing.eventId !== incoming.eventId
      || (existing.lane ?? 'lark-message') !== (incoming.lane ?? 'lark-message')
      || existing.partitionKey !== incoming.partitionKey) return false;
  const existingKey = durableInboxSemanticKey(existing);
  const existingCanonical = canonicalLarkReceive(existing);
  const incomingCanonical = canonicalLarkReceive(incoming);
  return existingKey !== undefined
    && incomingCanonical !== undefined
    && existingCanonical !== undefined
    && receivePayloadsAreEquivalent(existingCanonical, incomingCanonical);
}
