import type { Session } from '../types.js';
import { sessionKey, storedSessionAnchorId } from '../core/types.js';
import type {
  DurableJson,
  DurableSessionRecord,
  SessionLease,
} from './durable-coordination.js';
import type {
  DurableSessionFacade,
  DurableSessionFacadeWriteResult,
} from './durable-session-facade.js';
import type { DurableLarkMessageClaim } from './durable-inbox-shadow.js';
import type {
  DurableLarkSessionControlAction,
  DurableLarkSessionControlClaim,
} from './durable-lark-session-control.js';
import {
  durableLarkAdmissionReceipt,
  type DurableLarkAdmissionReceipt,
} from './durable-lark-admission.js';

export const DURABLE_PRIMARY_SESSION_VERSION = 1 as const;
export const DURABLE_PRIMARY_ADMISSION_LIMIT = 64 as const;
export const DURABLE_PRIMARY_CONTROL_LIMIT = 64 as const;

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
  /** Latest admission, retained for backward-compatible readers. */
  admission: DurablePrimarySessionAdmission;
  /** Bounded oldest-to-newest admissions for turns that may finish out of order. */
  admissions: DurablePrimarySessionAdmission[];
  /** Latest completed lifecycle control, absent on pre-control records. */
  control?: DurablePrimarySessionControl;
  /** Bounded oldest-to-newest lifecycle controls. */
  controls?: DurablePrimarySessionControl[];
}

export interface DurablePrimarySessionControl {
  version: 1;
  type: 'botmux.lark.session-control-commit';
  operationId: string;
  larkAppId: string;
  action: DurableLarkSessionControlAction;
  sessionId: string;
  operatorOpenId: string;
  cardMessageId: string;
  result: DurableJson;
}

export type DurableLarkSessionAdmissionResult =
  | {
      kind: 'committed';
      receipt: DurableLarkAdmissionReceipt;
      lease: SessionLease;
      record: DurableSessionRecord;
    }
  | Exclude<DurableSessionFacadeWriteResult, { kind: 'written' | 'unchanged' }>;

export type DurableLarkSessionControlCommitResult =
  | {
      kind: 'committed';
      lease: SessionLease;
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

function sameAdmission(
  left: DurablePrimarySessionAdmission,
  right: DurablePrimarySessionAdmission,
): boolean {
  return left.eventId === right.eventId
    && left.partitionKey === right.partitionKey
    && left.larkAppId === right.larkAppId
    && left.messageId === right.messageId;
}

function parseAdmission(
  raw: Record<string, unknown>,
  recordSessionKey: string,
): DurablePrimarySessionAdmission {
  if (raw.version !== 1 || raw.type !== 'botmux.lark.session-admission') {
    throw new Error(`durable primary Session ${recordSessionKey} has an invalid admission`);
  }
  const admission: DurablePrimarySessionAdmission = {
    version: 1,
    type: 'botmux.lark.session-admission',
    eventId: boundedText(raw.eventId, 'durable admission eventId', 1_024),
    partitionKey: boundedText(raw.partitionKey, 'durable admission partitionKey', 1_024),
    larkAppId: boundedText(raw.larkAppId, 'durable admission larkAppId', 256),
    messageId: boundedText(raw.messageId, 'durable admission messageId', 256),
  };
  const receiveEventId = `im.message.receive_v1:${admission.larkAppId}:${admission.messageId}`;
  const updatedEventPrefix = `im.message.updated_v1:${admission.larkAppId}:`;
  if ((admission.eventId !== receiveEventId
        && (!admission.eventId.startsWith(updatedEventPrefix)
          || admission.eventId.length === updatedEventPrefix.length))
      || !admission.partitionKey.startsWith(`lark-message-routing:${admission.larkAppId}:`)) {
    throw new Error(`durable primary Session ${recordSessionKey} has a mismatched admission identity`);
  }
  return admission;
}

function parseControl(
  raw: Record<string, unknown>,
  recordSessionKey: string,
): DurablePrimarySessionControl {
  if (raw.version !== 1 || raw.type !== 'botmux.lark.session-control-commit') {
    throw new Error(`durable primary Session ${recordSessionKey} has an invalid control commit`);
  }
  const action = raw.action;
  if (action !== 'close' && action !== 'resume') {
    throw new Error(`durable primary Session ${recordSessionKey} has an invalid control action`);
  }
  const result = raw.result;
  if (JSON.stringify(result) === undefined) {
    throw new Error(`durable primary Session ${recordSessionKey} has an invalid control result`);
  }
  return {
    version: 1,
    type: 'botmux.lark.session-control-commit',
    operationId: boundedText(raw.operationId, 'durable control operationId', 1_024),
    larkAppId: boundedText(raw.larkAppId, 'durable control larkAppId', 256),
    action,
    sessionId: boundedText(raw.sessionId, 'durable control sessionId', 256),
    operatorOpenId: boundedText(raw.operatorOpenId, 'durable control operatorOpenId', 256),
    cardMessageId: boundedText(raw.cardMessageId, 'durable control cardMessageId', 256),
    result: JSON.parse(JSON.stringify(result)) as DurableJson,
  };
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
    admissions: [admission],
  };
  return { sessionKey: identity.sessionKey, value: value as unknown as DurableJson };
}

/** Parse a full primary snapshot for failover restore and validate its routing key. */
export function parseDurablePrimarySessionRecord(record: DurableSessionRecord): {
  session: Session;
  admission: DurablePrimarySessionAdmission;
  admissions: DurablePrimarySessionAdmission[];
  controls: DurablePrimarySessionControl[];
} {
  const value = object(record.value);
  const rawSession = object(value?.session);
  const rawAdmission = object(value?.admission);
  if (value?.version !== DURABLE_PRIMARY_SESSION_VERSION
      || value.type !== 'botmux.session.primary'
      || !rawSession
      || !rawAdmission) {
    throw new Error(`durable primary Session ${record.sessionKey} has an invalid envelope`);
  }
  const session = rawSession as unknown as Session;
  const identity = primarySessionIdentity(session);
  const admission = parseAdmission(rawAdmission, record.sessionKey);
  const rawAdmissions = value.admissions;
  if (rawAdmissions !== undefined
      && (!Array.isArray(rawAdmissions)
        || rawAdmissions.length < 1
        || rawAdmissions.length > DURABLE_PRIMARY_ADMISSION_LIMIT)) {
    throw new Error(`durable primary Session ${record.sessionKey} has an invalid admission history`);
  }
  const admissions = rawAdmissions === undefined
    ? [admission]
    : rawAdmissions.map(raw => {
      const entry = object(raw);
      if (!entry) {
        throw new Error(`durable primary Session ${record.sessionKey} has an invalid admission history`);
      }
      return parseAdmission(entry, record.sessionKey);
    });
  const uniqueMessageIds = new Set(admissions.map(entry => entry.messageId));
  const rawControls = value.controls ?? (value.control === undefined ? [] : [value.control]);
  if (!Array.isArray(rawControls) || rawControls.length > DURABLE_PRIMARY_CONTROL_LIMIT) {
    throw new Error(`durable primary Session ${record.sessionKey} has an invalid control history`);
  }
  const controls = rawControls.map(raw => {
    const entry = object(raw);
    if (!entry) {
      throw new Error(`durable primary Session ${record.sessionKey} has an invalid control history`);
    }
    return parseControl(entry, record.sessionKey);
  });
  const control = value.control === undefined ? undefined : parseControl(
    object(value.control) ?? {},
    record.sessionKey,
  );
  if (uniqueMessageIds.size !== admissions.length
      || !sameAdmission(admissions.at(-1)!, admission)
      || new Set(controls.map(entry => entry.operationId)).size !== controls.length
      || (controls.length > 0 && !control)
      || (!!control && controls.at(-1)?.operationId !== control.operationId)
      || admissions.some(entry => entry.larkAppId !== identity.larkAppId)
      || controls.some(entry => (
        entry.larkAppId !== identity.larkAppId || entry.sessionId !== session.sessionId
      ))
      || identity.sessionKey !== record.sessionKey
      || identity.larkAppId !== admission.larkAppId) {
    throw new Error(`durable primary Session ${record.sessionKey} has a mismatched routing identity`);
  }
  return { session, admission, admissions, controls };
}

function mergePrimaryProjection(
  current: DurableSessionRecord | undefined,
  next: DurablePrimarySessionProjection,
): DurableJson {
  let previousAdmissions: DurablePrimarySessionAdmission[] = [];
  let previousControls: DurablePrimarySessionControl[] = [];
  if (current) {
    const currentValue = object(current.value);
    // A shadow snapshot may exist during a controlled switch to primary mode.
    // Only primary envelopes contribute admission history; malformed primary
    // envelopes remain fail-closed instead of being silently replaced.
    if (currentValue?.type === 'botmux.session.primary') {
      const parsed = parseDurablePrimarySessionRecord(current);
      previousAdmissions = parsed.admissions;
      previousControls = parsed.controls;
    }
  }
  const admissions = [
    ...previousAdmissions.filter(entry => entry.messageId !== next.admission.messageId),
    next.admission,
  ].slice(-DURABLE_PRIMARY_ADMISSION_LIMIT);
  return {
    ...next,
    admissions,
    ...(previousControls.length > 0
      ? { control: previousControls.at(-1), controls: previousControls }
      : {}),
  } as unknown as DurableJson;
}

/** Commit one completed control result and the resulting full Session snapshot. */
export async function commitDurableLarkSessionControl(input: {
  facade: DurableSessionFacade;
  control: DurableLarkSessionControlClaim;
  session: Session;
  result: DurableJson;
}): Promise<DurableLarkSessionControlCommitResult> {
  const identity = primarySessionIdentity(input.session, input.control.larkAppId);
  if (input.session.sessionId !== input.control.sessionId) {
    throw new Error('durable control Session id does not match the canonical snapshot');
  }
  const control: DurablePrimarySessionControl = {
    version: 1,
    type: 'botmux.lark.session-control-commit',
    operationId: boundedText(input.control.operationId, 'durable control operationId', 1_024),
    larkAppId: identity.larkAppId,
    action: input.control.action,
    sessionId: input.control.sessionId,
    operatorOpenId: boundedText(input.control.operatorOpenId, 'durable control operatorOpenId', 256),
    cardMessageId: boundedText(input.control.cardMessageId, 'durable control cardMessageId', 256),
    result: JSON.parse(JSON.stringify(input.result)) as DurableJson,
  };
  const sessionValue = cloneSession(input.session);
  const written = await input.facade.writeExactFromCurrent(identity.sessionKey, current => {
    if (!current) throw new Error('durable control canonical Session is missing');
    const parsed = parseDurablePrimarySessionRecord(current);
    if (parsed.session.sessionId !== input.session.sessionId) {
      throw new Error('durable control canonical Session was replaced');
    }
    const controls = [
      ...parsed.controls.filter(entry => entry.operationId !== control.operationId),
      control,
    ].slice(-DURABLE_PRIMARY_CONTROL_LIMIT);
    const next: DurablePrimarySessionProjection = {
      version: DURABLE_PRIMARY_SESSION_VERSION,
      type: 'botmux.session.primary',
      session: sessionValue,
      admission: parsed.admission,
      admissions: parsed.admissions,
      control,
      controls,
    };
    return next as unknown as DurableJson;
  });
  if (written.kind !== 'written' && written.kind !== 'unchanged') return written;
  if (written.coalescedCount !== 1) {
    throw new Error('durable control canonical Session commit was unexpectedly coalesced');
  }
  return { kind: 'committed', lease: written.lease, record: written.record };
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
  const next = projection.value as unknown as DurablePrimarySessionProjection;
  const written = await input.facade.writeExactFromCurrent(
    projection.sessionKey,
    current => mergePrimaryProjection(current, next),
  );
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
    lease: written.lease,
    record: written.record,
  };
}
