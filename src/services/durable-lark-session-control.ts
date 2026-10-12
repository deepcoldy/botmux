import {
  DURABLE_INBOX_LANE_SESSION_CONTROL,
  type DurableInboxEvent,
  type DurableJson,
  type InboxClaim,
} from './durable-coordination.js';

export const DURABLE_LARK_SESSION_CONTROL_VERSION = 1 as const;

export type DurableLarkSessionControlAction = 'close' | 'resume';

export interface DurableLarkSessionControlEnvelope {
  version: typeof DURABLE_LARK_SESSION_CONTROL_VERSION;
  type: 'botmux.lark.session-control';
  larkAppId: string;
  event: DurableJson;
}

export interface DurableLarkSessionControlClaim {
  operationId: string;
  partitionKey: string;
  larkAppId: string;
  action: DurableLarkSessionControlAction;
  sessionId: string;
  rootId: string;
  operatorOpenId: string;
  cardMessageId: string;
  attempts: number;
  data: DurableJson;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function bounded(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${name} must contain bounded non-empty text`);
  }
  return normalized;
}

function jsonValue(value: unknown): DurableJson {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Lark session control event is not JSON-serializable');
  return JSON.parse(encoded) as DurableJson;
}

function rawCardFields(rawValue: unknown): {
  stableEventId: string;
  action: DurableLarkSessionControlAction;
  sessionId: string;
  rootId: string;
  operatorOpenId: string;
  cardMessageId: string;
} {
  const outer = record(rawValue);
  const inner = record(outer?.event) ?? outer;
  const header = record(outer?.header) ?? record(inner?.header);
  const action = record(inner?.action ?? outer?.action);
  const value = record(action?.value);
  const operator = record(inner?.operator ?? outer?.operator);
  const context = record(inner?.context ?? outer?.context);
  const stableEventId = bounded(
    outer?.event_id ?? outer?.uuid ?? header?.event_id ?? inner?.event_id,
    'Lark card event id',
    512,
  );
  const actionType = value?.action ?? action?.name ?? action?.option ?? action?.tag;
  if (actionType !== 'close' && actionType !== 'resume') {
    throw new Error('durable Lark session control action must be close or resume');
  }
  const sessionId = bounded(value?.session_id, 'Lark card sessionId', 256);
  const rootId = bounded(value?.root_id, 'Lark card rootId', 512);
  const operatorOpenId = bounded(operator?.open_id, 'Lark card operatorOpenId', 256);
  const cardMessageId = bounded(
    context?.open_message_id ?? inner?.open_message_id ?? outer?.open_message_id,
    'Lark card messageId',
    256,
  );
  if (!operatorOpenId.startsWith('ou_') || !cardMessageId.startsWith('om_')) {
    throw new Error('durable Lark session control principal/card identity is invalid');
  }
  if (!rootId.startsWith('om_') && !rootId.startsWith('oc_')) {
    throw new Error('durable Lark session control root identity is invalid');
  }
  return {
    stableEventId,
    action: actionType,
    sessionId,
    rootId,
    operatorOpenId,
    cardMessageId,
  };
}

export function durableLarkSessionControlEventId(larkAppId: string, stableEventId: string): string {
  return `card.action.trigger:${bounded(larkAppId, 'larkAppId', 256)}:${bounded(stableEventId, 'eventId', 512)}`;
}

export function durableLarkSessionControlPartition(larkAppId: string, sessionId: string): string {
  return `lark-session-control:${bounded(larkAppId, 'larkAppId', 256)}:${bounded(sessionId, 'sessionId', 256)}`;
}

/**
 * 持久化 close/resume 卡片动作。operationId 直接复用 Lark interaction event id；
 * 没有稳定 event id 的回调不得进入该路径，避免把两次真实点击误合并成一次。
 */
export function durableLarkSessionControlEvent(input: {
  larkAppId: string;
  eventId: string;
  partitionKey: string;
  data: unknown;
  now?: number;
}): DurableInboxEvent {
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('durable session control timestamp is invalid');
  }
  const event: DurableInboxEvent = {
    eventId: bounded(input.eventId, 'eventId', 1_024),
    lane: DURABLE_INBOX_LANE_SESSION_CONTROL,
    partitionKey: bounded(input.partitionKey, 'partitionKey', 1_024),
    payload: {
      version: DURABLE_LARK_SESSION_CONTROL_VERSION,
      type: 'botmux.lark.session-control',
      larkAppId: bounded(input.larkAppId, 'larkAppId', 256),
      event: jsonValue(input.data),
    } satisfies DurableLarkSessionControlEnvelope as unknown as DurableJson,
    visibleAt: now,
    createdAt: now,
  };
  // 入口与 consumer 共用同一份严格解析，避免 ACK 前校验和持久化后校验漂移。
  parseDurableLarkSessionControlClaim({
    event,
    workerId: 'ingress-validation',
    claimEpoch: 1,
    claimUntil: now + 1,
    attempts: 1,
  });
  return event;
}

export function parseDurableLarkSessionControlClaim(
  claim: InboxClaim,
): DurableLarkSessionControlClaim {
  const payload = record(claim.event.payload);
  if (claim.event.lane !== DURABLE_INBOX_LANE_SESSION_CONTROL
      || payload?.version !== DURABLE_LARK_SESSION_CONTROL_VERSION
      || payload.type !== 'botmux.lark.session-control') {
    throw new Error(`durable session control ${claim.event.eventId} has an invalid envelope`);
  }
  const larkAppId = bounded(payload.larkAppId, 'larkAppId', 256);
  if (!larkAppId.startsWith('cli_')) {
    throw new Error(`durable session control ${claim.event.eventId} has an invalid application`);
  }
  const fields = rawCardFields(payload.event);
  const expectedEventId = durableLarkSessionControlEventId(larkAppId, fields.stableEventId);
  const expectedPartition = durableLarkSessionControlPartition(larkAppId, fields.sessionId);
  if (claim.event.eventId !== expectedEventId || claim.event.partitionKey !== expectedPartition) {
    throw new Error(`durable session control ${claim.event.eventId} has a mismatched identity`);
  }
  return {
    operationId: claim.event.eventId,
    partitionKey: claim.event.partitionKey,
    larkAppId,
    action: fields.action,
    sessionId: fields.sessionId,
    rootId: fields.rootId,
    operatorOpenId: fields.operatorOpenId,
    cardMessageId: fields.cardMessageId,
    attempts: claim.attempts,
    data: payload.event as DurableJson,
  };
}
