import type { Session } from '../types.js';
import { sessionKey, storedSessionAnchorId } from '../core/types.js';
import type {
  DurableJson,
  DurableSessionRecord,
} from './durable-coordination.js';
import type {
  DurableSessionFacade,
  DurableSessionFacadeWriteResult,
} from './durable-session-facade.js';
import type { DurableLarkMessageClaim } from './durable-inbox-shadow.js';
import {
  durableLarkAdmissionReceipt,
  type DurableLarkAdmissionReceipt,
} from './durable-lark-admission.js';

export const DURABLE_PRIMARY_SESSION_VERSION = 1 as const;

export interface DurablePrimarySessionAdmission {
  version: 1;
  type: 'botmux.lark.session-admission';
  eventId: string;
  partitionKey: string;
  larkAppId: string;
  messageId: string;
}

export interface DurablePrimarySessionProjection {
  version: typeof DURABLE_PRIMARY_SESSION_VERSION;
  type: 'botmux.session.primary';
  session: DurableJson;
  admission: DurablePrimarySessionAdmission;
}

export type DurableLarkSessionAdmissionResult =
  | {
      kind: 'committed';
      receipt: DurableLarkAdmissionReceipt;
      record: DurableSessionRecord;
    }
  | Exclude<DurableSessionFacadeWriteResult, { kind: 'written' | 'unchanged' }>;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${name} must contain bounded non-empty text`);
  }
  return normalized;
}

function cloneSession(session: Session): DurableJson {
  const encoded = JSON.stringify(session);
  if (encoded === undefined) throw new Error('durable primary Session is not JSON-serializable');
  return JSON.parse(encoded) as DurableJson;
}

function primarySessionIdentity(session: Session, expectedAppId?: string): {
  sessionKey: string;
  larkAppId: string;
} {
  boundedText(session.sessionId, 'durable primary sessionId', 256);
  const larkAppId = boundedText(session.larkAppId, 'durable primary larkAppId', 256);
  if (expectedAppId && larkAppId !== expectedAppId) {
    throw new Error('durable primary Session does not belong to the inbox application');
  }
  const anchorId = boundedText(storedSessionAnchorId(session), 'durable primary anchorId', 512);
  return { sessionKey: sessionKey(anchorId, larkAppId), larkAppId };
}

export function durablePrimarySessionProjection(
  session: Session,
  message: DurableLarkMessageClaim,
): { sessionKey: string; value: DurableJson } {
  const identity = primarySessionIdentity(session, message.larkAppId);
  const admission: DurablePrimarySessionAdmission = {
    version: 1,
    type: 'botmux.lark.session-admission',
    eventId: boundedText(message.eventId, 'durable admission eventId', 1_024),
    partitionKey: boundedText(message.partitionKey, 'durable admission partitionKey', 1_024),
    larkAppId: identity.larkAppId,
    messageId: boundedText(message.messageId, 'durable admission messageId', 256),
  };
  const value: DurablePrimarySessionProjection = {
    version: DURABLE_PRIMARY_SESSION_VERSION,
    type: 'botmux.session.primary',
    session: cloneSession(session),
    admission,
  };
  return { sessionKey: identity.sessionKey, value: value as unknown as DurableJson };
}

/** Parse a full primary snapshot for failover restore and validate its routing key. */
export function parseDurablePrimarySessionRecord(record: DurableSessionRecord): {
  session: Session;
  admission: DurablePrimarySessionAdmission;
} {
  const value = object(record.value);
  const rawSession = object(value?.session);
  const rawAdmission = object(value?.admission);
  if (value?.version !== DURABLE_PRIMARY_SESSION_VERSION
      || value.type !== 'botmux.session.primary'
      || !rawSession
      || !rawAdmission
      || rawAdmission.version !== 1
      || rawAdmission.type !== 'botmux.lark.session-admission') {
    throw new Error(`durable primary Session ${record.sessionKey} has an invalid envelope`);
  }
  const session = rawSession as unknown as Session;
  const identity = primarySessionIdentity(session);
  const admission: DurablePrimarySessionAdmission = {
    version: 1,
    type: 'botmux.lark.session-admission',
    eventId: boundedText(rawAdmission.eventId, 'durable admission eventId', 1_024),
    partitionKey: boundedText(rawAdmission.partitionKey, 'durable admission partitionKey', 1_024),
    larkAppId: boundedText(rawAdmission.larkAppId, 'durable admission larkAppId', 256),
    messageId: boundedText(rawAdmission.messageId, 'durable admission messageId', 256),
  };
  if (identity.sessionKey !== record.sessionKey || identity.larkAppId !== admission.larkAppId) {
    throw new Error(`durable primary Session ${record.sessionKey} has a mismatched routing identity`);
  }
  if (admission.eventId !== `im.message.receive_v1:${admission.larkAppId}:${admission.messageId}`
      || !admission.partitionKey.startsWith(`lark-message-routing:${admission.larkAppId}:`)) {
    throw new Error(`durable primary Session ${record.sessionKey} has a mismatched admission identity`);
  }
  return { session, admission };
}

/**
 * Persist one exact canonical Session snapshot and mint the only committed
 * result accepted by the primary inbox consumer.
 */
export async function admitDurableLarkSession(input: {
  facade: DurableSessionFacade;
  message: DurableLarkMessageClaim;
  session: Session;
}): Promise<DurableLarkSessionAdmissionResult> {
  const projection = durablePrimarySessionProjection(input.session, input.message);
  const written = await input.facade.writeExact(projection.sessionKey, projection.value);
  if (written.kind !== 'written' && written.kind !== 'unchanged') return written;
  if (written.coalescedCount !== 1) {
    throw new Error('durable primary admission was unexpectedly coalesced');
  }
  return {
    kind: 'committed',
    receipt: durableLarkAdmissionReceipt({
      message: input.message,
      lease: written.lease,
      record: written.record,
    }),
    record: written.record,
  };
}
