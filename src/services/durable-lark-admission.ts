import type {
  DurableSessionRecord,
  SessionLease,
} from './durable-coordination.js';
import type { DurableLarkMessageClaim } from './durable-inbox-shadow.js';

export const DURABLE_LARK_ADMISSION_RECEIPT_VERSION = 1 as const;

/**
 * Canonical proof that one durable inbox event crossed the Session admission
 * boundary under a fenced owner. A caller may construct this value only from
 * the Session lease and record returned by the durable store after the write.
 * Merely appending work to an in-memory queue cannot supply either revision.
 */
export interface DurableLarkAdmissionReceipt {
  version: typeof DURABLE_LARK_ADMISSION_RECEIPT_VERSION;
  type: 'botmux.lark.durable-admission';
  eventId: string;
  partitionKey: string;
  larkAppId: string;
  sessionKey: string;
  sessionEpoch: number;
  sessionRevision: number;
  sessionUpdatedAt: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
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

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function timestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function expectedIdentity(message: DurableLarkMessageClaim): Pick<
  DurableLarkAdmissionReceipt,
  'eventId' | 'partitionKey' | 'larkAppId'
> {
  return {
    eventId: boundedText(message.eventId, 'admission eventId', 1_024),
    partitionKey: boundedText(message.partitionKey, 'admission partitionKey', 1_024),
    larkAppId: boundedText(message.larkAppId, 'admission larkAppId', 256),
  };
}

/** Build a receipt from the exact fenced Session mutation result. */
export function durableLarkAdmissionReceipt(input: {
  message: DurableLarkMessageClaim;
  lease: SessionLease;
  record: DurableSessionRecord;
}): DurableLarkAdmissionReceipt {
  const identity = expectedIdentity(input.message);
  const sessionKey = boundedText(input.lease.sessionKey, 'admission sessionKey', 1_024);
  if (input.record.sessionKey !== sessionKey) {
    throw new Error('durable Lark admission lease and Session record do not match');
  }
  return {
    version: DURABLE_LARK_ADMISSION_RECEIPT_VERSION,
    type: 'botmux.lark.durable-admission',
    ...identity,
    sessionKey,
    sessionEpoch: positiveInteger(input.lease.epoch, 'admission sessionEpoch'),
    sessionRevision: positiveInteger(input.record.revision, 'admission sessionRevision'),
    sessionUpdatedAt: timestamp(input.record.updatedAt, 'admission sessionUpdatedAt'),
  };
}

/** Revalidate a returned receipt against the claimed inbox identity. */
export function parseDurableLarkAdmissionReceipt(
  value: unknown,
  message: DurableLarkMessageClaim,
): DurableLarkAdmissionReceipt {
  const candidate = record(value);
  if (!candidate
      || candidate.version !== DURABLE_LARK_ADMISSION_RECEIPT_VERSION
      || candidate.type !== 'botmux.lark.durable-admission') {
    throw new Error(`durable Lark admission for ${message.eventId} has an invalid receipt envelope`);
  }
  const identity = expectedIdentity(message);
  const receipt: DurableLarkAdmissionReceipt = {
    version: DURABLE_LARK_ADMISSION_RECEIPT_VERSION,
    type: 'botmux.lark.durable-admission',
    eventId: boundedText(candidate.eventId, 'admission eventId', 1_024),
    partitionKey: boundedText(candidate.partitionKey, 'admission partitionKey', 1_024),
    larkAppId: boundedText(candidate.larkAppId, 'admission larkAppId', 256),
    sessionKey: boundedText(candidate.sessionKey, 'admission sessionKey', 1_024),
    sessionEpoch: positiveInteger(candidate.sessionEpoch, 'admission sessionEpoch'),
    sessionRevision: positiveInteger(candidate.sessionRevision, 'admission sessionRevision'),
    sessionUpdatedAt: timestamp(candidate.sessionUpdatedAt, 'admission sessionUpdatedAt'),
  };
  if (receipt.eventId !== identity.eventId
      || receipt.partitionKey !== identity.partitionKey
      || receipt.larkAppId !== identity.larkAppId) {
    throw new Error(`durable Lark admission for ${message.eventId} has a mismatched inbox identity`);
  }
  return receipt;
}
