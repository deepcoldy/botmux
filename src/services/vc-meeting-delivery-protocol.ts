import { createHash } from 'node:crypto';
import { canonicalJson, computeInputHash } from '../utils/canonical-input-hash.js';
import type {
  VcMeetingConsumerManagedSink,
  VcMeetingConsumerProfileFilter,
} from '../types.js';
import { normalizeVcMeetingMemberPolicy } from './vc-meeting-member-policy.js';
import { normalizeVcMeetingProfileInstructions } from './vc-meeting-profile-instructions.js';

export const VC_MEETING_DELIVERY_SCHEMA_VERSION = 1 as const;
export const VC_MEETING_DELIVERY_KEY_NAMESPACE = 'vc_';
export const VC_MEETING_DELIVERY_KEY_MAX_LENGTH = 50;

export const VC_MEETING_DELIVERY_KINDS = [
  'item',
  'final',
  'gap',
  'effect_result',
  'control',
] as const;

export type VcMeetingDeliveryKind = typeof VC_MEETING_DELIVERY_KINDS[number];

export const VC_MEETING_DELIVERY_GAP_REASONS = [
  'retention_expired',
  'poll_unavailable',
  'recovery_ambiguous',
  'backpressure_skipped',
  'operator_skip',
] as const;

export type VcMeetingDeliveryGapReason = typeof VC_MEETING_DELIVERY_GAP_REASONS[number];

export const VC_MEETING_MEMBER_STATUSES = ['active', 'paused', 'removed'] as const;
export type VcMeetingMemberStatus = typeof VC_MEETING_MEMBER_STATUSES[number];

export const VC_MEETING_RESPONSE_MODES = ['silent', 'listener_thread'] as const;
export type VcMeetingResponseMode = typeof VC_MEETING_RESPONSE_MODES[number];

export interface VcMeetingMemberProjectionRequest {
  schemaVersion: typeof VC_MEETING_DELIVERY_SCHEMA_VERSION;
  meeting: {
    listenerAppId: string;
    meetingId: string;
    ownerBootId: string;
    ownerEpoch: number;
  };
  member: {
    memberId: string;
    agentAppId: string;
    role: string;
    /** Trusted operator-authored profile instructions. They belong to the
     * membership projection, not to individual delivery envelopes. */
    instructions?: string;
    epoch: number;
    membershipGeneration: number;
    status: VcMeetingMemberStatus;
    joinedAtIngestSeq: number;
    responseMode: VcMeetingResponseMode;
    /** Optional only so an MA-P0 sender can be rolled forward without a flag day. */
    filter?: VcMeetingConsumerProfileFilter;
    capabilities?: string[];
    ownedSinks?: VcMeetingConsumerManagedSink[];
    sinkOwnerGeneration?: number;
  };
  outputRoute: { chatId: string };
}

export type NormalizedVcMeetingMemberProjectionRequest = Omit<
  VcMeetingMemberProjectionRequest,
  'member'
> & {
  member: VcMeetingMemberProjectionRequest['member'] & {
    capabilities: string[];
    ownedSinks: VcMeetingConsumerManagedSink[];
    sinkOwnerGeneration: number;
  };
};

export type VcMeetingMemberProjectionValidationResult =
  | { ok: true; request: NormalizedVcMeetingMemberProjectionRequest }
  | { ok: false; errorCode: 'bad_request'; error: string; path?: string };

export interface VcMeetingDeliveryGap {
  occurredFromMs?: number;
  occurredToMs?: number;
  missingItemVersionKey?: string;
  originalContentHash?: string;
  reason: VcMeetingDeliveryGapReason;
}

export interface VcMeetingDeliveryEntry {
  deliverySeq: number;
  ingestSeq?: number;
  itemVersionKey?: string;
  contentHash?: string;
  kind: VcMeetingDeliveryKind;
  controlKey?: string;
  gap?: VcMeetingDeliveryGap;
  rawText: string;
}

export interface VcMeetingDeliveryRequest {
  schemaVersion: typeof VC_MEETING_DELIVERY_SCHEMA_VERSION;
  meeting: {
    listenerAppId: string;
    meetingId: string;
    ownerBootId: string;
    ownerEpoch: number;
  };
  member: {
    memberId: string;
    agentAppId: string;
    role: string;
    epoch: number;
    membershipGeneration: number;
  };
  stream: {
    fromSeq: number;
    toSeq: number;
    /** Observability-only identifier. It is frozen with an accepted envelope. */
    batchId: string;
    inputHash: string;
    final: boolean;
  };
  entries: VcMeetingDeliveryEntry[];
  target: {
    sessionId: string;
    chatId: string;
  };
  instructionVersion: string;
  /** Transport metadata is deliberately outside the canonical input. */
  sentAt?: string;
  traceId?: string;
}

export type CanonicalVcMeetingDeliveryInput = Omit<
  VcMeetingDeliveryRequest,
  'stream' | 'sentAt' | 'traceId'
> & {
  stream: Omit<VcMeetingDeliveryRequest['stream'], 'inputHash'>;
};

export interface VcMeetingDeliveryIdentity {
  inputHash: string;
  deliveryKey: string;
}

export type VcMeetingDeliveryValidationErrorCode =
  | 'bad_request'
  | 'entries_not_contiguous'
  | 'final_mismatch'
  | 'input_hash_mismatch';

export type VcMeetingDeliveryValidationResult =
  | {
      ok: true;
      request: VcMeetingDeliveryRequest;
      identity: VcMeetingDeliveryIdentity;
    }
  | {
      ok: false;
      errorCode: VcMeetingDeliveryValidationErrorCode;
      error: string;
      path?: string;
      expectedInputHash?: string;
    };

export interface VcMeetingDeliveryKeyInput {
  meetingId: string;
  memberId: string;
  epoch: number;
  fromSeq: number;
  toSeq: number;
  inputHash: string;
}

/** Validate the fenced hub -> receiver membership projection. The receiver
 *  chooses receiverSessionId after this step; the hub cannot inject one. */
export function validateVcMeetingMemberProjectionRequest(
  raw: unknown,
): VcMeetingMemberProjectionValidationResult {
  if (!isRecord(raw)) return badProjectionRequest('request body must be an object');
  if (raw.schemaVersion !== VC_MEETING_DELIVERY_SCHEMA_VERSION) {
    return badProjectionRequest('schemaVersion must be 1', 'schemaVersion');
  }
  if (!isRecord(raw.meeting)) return badProjectionRequest('meeting must be an object', 'meeting');
  if (!isRecord(raw.member)) return badProjectionRequest('member must be an object', 'member');
  if (!isRecord(raw.outputRoute)) return badProjectionRequest('outputRoute must be an object', 'outputRoute');

  for (const [value, path] of [
    [raw.meeting.listenerAppId, 'meeting.listenerAppId'],
    [raw.meeting.meetingId, 'meeting.meetingId'],
    [raw.meeting.ownerBootId, 'meeting.ownerBootId'],
    [raw.member.memberId, 'member.memberId'],
    [raw.member.agentAppId, 'member.agentAppId'],
    [raw.member.role, 'member.role'],
    [raw.outputRoute.chatId, 'outputRoute.chatId'],
  ] as Array<[unknown, string]>) {
    const error = validateIdentifier(value, path);
    if (error) return { ...error, errorCode: 'bad_request' };
  }
  for (const [value, path] of [
    [raw.meeting.ownerEpoch, 'meeting.ownerEpoch'],
    [raw.member.epoch, 'member.epoch'],
    [raw.member.membershipGeneration, 'member.membershipGeneration'],
  ] as Array<[unknown, string]>) {
    if (!isPositiveSafeInteger(value)) {
      return badProjectionRequest(`${path} must be a positive safe integer`, path);
    }
  }
  if (typeof raw.member.joinedAtIngestSeq !== 'number'
    || !Number.isSafeInteger(raw.member.joinedAtIngestSeq)
    || raw.member.joinedAtIngestSeq < 0) {
    return badProjectionRequest(
      'member.joinedAtIngestSeq must be a non-negative safe integer',
      'member.joinedAtIngestSeq',
    );
  }
  if (typeof raw.member.status !== 'string'
    || !(VC_MEETING_MEMBER_STATUSES as readonly string[]).includes(raw.member.status)) {
    return badProjectionRequest('member.status is not supported', 'member.status');
  }
  if (typeof raw.member.responseMode !== 'string'
    || !(VC_MEETING_RESPONSE_MODES as readonly string[]).includes(raw.member.responseMode)) {
    return badProjectionRequest('member.responseMode is not supported', 'member.responseMode');
  }
  const policy = normalizeVcMeetingMemberPolicy({
    memberId: raw.member.memberId as string,
    role: raw.member.role as string,
    membershipGeneration: raw.member.membershipGeneration as number,
    responseMode: raw.member.responseMode as VcMeetingResponseMode,
    filter: raw.member.filter,
    capabilities: raw.member.capabilities,
    ownedSinks: raw.member.ownedSinks,
    sinkOwnerGeneration: raw.member.sinkOwnerGeneration,
  });
  if (!policy) {
    return badProjectionRequest(
      'member filter/capabilities/ownedSinks/sinkOwnerGeneration are invalid',
      'member',
    );
  }
  const normalizedInstructions = normalizeVcMeetingProfileInstructions(raw.member.instructions);
  if (!normalizedInstructions.ok) {
    return badProjectionRequest(
      `member.instructions ${normalizedInstructions.error}`,
      'member.instructions',
    );
  }
  return {
    ok: true,
    request: {
      schemaVersion: VC_MEETING_DELIVERY_SCHEMA_VERSION,
      meeting: {
        listenerAppId: raw.meeting.listenerAppId as string,
        meetingId: raw.meeting.meetingId as string,
        ownerBootId: raw.meeting.ownerBootId as string,
        ownerEpoch: raw.meeting.ownerEpoch as number,
      },
      member: {
        memberId: raw.member.memberId as string,
        agentAppId: raw.member.agentAppId as string,
        role: raw.member.role as string,
        ...(normalizedInstructions.instructions !== undefined
          ? { instructions: normalizedInstructions.instructions }
          : {}),
        epoch: raw.member.epoch as number,
        membershipGeneration: raw.member.membershipGeneration as number,
        status: raw.member.status as VcMeetingMemberStatus,
        joinedAtIngestSeq: raw.member.joinedAtIngestSeq as number,
        responseMode: raw.member.responseMode as VcMeetingResponseMode,
        ...policy,
      },
      outputRoute: { chatId: raw.outputRoute.chatId as string },
    },
  };
}

/**
 * Return the full semantic delivery envelope used for input immutability.
 * Transport timestamps/trace ids and the claimed inputHash are excluded.
 *
 * This function intentionally copies the v1 schema field-by-field. Callers
 * must bump schemaVersion and this projection together when adding a semantic
 * field, so an unrecognised transport property cannot silently change runtime
 * behaviour without entering the hash.
 */
export function canonicalVcMeetingDeliveryInput(
  request: VcMeetingDeliveryRequest,
): CanonicalVcMeetingDeliveryInput {
  return {
    schemaVersion: request.schemaVersion,
    meeting: {
      listenerAppId: request.meeting.listenerAppId,
      meetingId: request.meeting.meetingId,
      ownerBootId: request.meeting.ownerBootId,
      ownerEpoch: request.meeting.ownerEpoch,
    },
    member: {
      memberId: request.member.memberId,
      agentAppId: request.member.agentAppId,
      role: request.member.role,
      epoch: request.member.epoch,
      membershipGeneration: request.member.membershipGeneration,
    },
    stream: {
      fromSeq: request.stream.fromSeq,
      toSeq: request.stream.toSeq,
      batchId: request.stream.batchId,
      final: request.stream.final,
    },
    entries: request.entries.map((entry) => ({
      deliverySeq: entry.deliverySeq,
      ...(entry.ingestSeq !== undefined ? { ingestSeq: entry.ingestSeq } : {}),
      ...(entry.itemVersionKey !== undefined ? { itemVersionKey: entry.itemVersionKey } : {}),
      ...(entry.contentHash !== undefined ? { contentHash: entry.contentHash } : {}),
      kind: entry.kind,
      ...(entry.controlKey !== undefined ? { controlKey: entry.controlKey } : {}),
      ...(entry.gap !== undefined ? {
        gap: {
          ...(entry.gap.occurredFromMs !== undefined ? { occurredFromMs: entry.gap.occurredFromMs } : {}),
          ...(entry.gap.occurredToMs !== undefined ? { occurredToMs: entry.gap.occurredToMs } : {}),
          ...(entry.gap.missingItemVersionKey !== undefined
            ? { missingItemVersionKey: entry.gap.missingItemVersionKey }
            : {}),
          ...(entry.gap.originalContentHash !== undefined
            ? { originalContentHash: entry.gap.originalContentHash }
            : {}),
          reason: entry.gap.reason,
        },
      } : {}),
      rawText: entry.rawText,
    })),
    target: {
      sessionId: request.target.sessionId,
      chatId: request.target.chatId,
    },
    instructionVersion: request.instructionVersion,
  };
}

export function computeVcMeetingDeliveryInputHash(request: VcMeetingDeliveryRequest): string {
  return computeInputHash(canonicalVcMeetingDeliveryInput(request));
}

/**
 * Derive a provider-safe, bounded key from the ordered stream identity and
 * canonical input hash. The canonical tuple avoids delimiter-boundary
 * collisions; the `vc_` prefix leaves 188 bits of truncated SHA-256 entropy.
 */
export function deriveVcMeetingDeliveryKey(input: VcMeetingDeliveryKeyInput): string {
  assertDeliveryKeyString(input.meetingId, 'meetingId');
  assertDeliveryKeyString(input.memberId, 'memberId');
  assertPositiveSafeInteger(input.epoch, 'epoch');
  assertPositiveSafeInteger(input.fromSeq, 'fromSeq');
  assertPositiveSafeInteger(input.toSeq, 'toSeq');
  if (input.fromSeq > input.toSeq) {
    throw new Error('deriveVcMeetingDeliveryKey: fromSeq must be <= toSeq');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.inputHash)) {
    throw new Error('deriveVcMeetingDeliveryKey: inputHash must be a lowercase sha256 hash');
  }
  const hash = createHash('sha256')
    .update(canonicalJson(input), 'utf8')
    .digest('hex');
  return VC_MEETING_DELIVERY_KEY_NAMESPACE
    + hash.slice(0, VC_MEETING_DELIVERY_KEY_MAX_LENGTH - VC_MEETING_DELIVERY_KEY_NAMESPACE.length);
}

export function deriveVcMeetingDeliveryIdentity(
  request: VcMeetingDeliveryRequest,
): VcMeetingDeliveryIdentity {
  const inputHash = computeVcMeetingDeliveryInputHash(request);
  return {
    inputHash,
    deliveryKey: deriveVcMeetingDeliveryKey({
      meetingId: request.meeting.meetingId,
      memberId: request.member.memberId,
      epoch: request.member.epoch,
      fromSeq: request.stream.fromSeq,
      toSeq: request.stream.toSeq,
      inputHash,
    }),
  };
}

/** Validate and seal the v1 delivery envelope before any durable claim. */
export function validateVcMeetingDeliveryRequest(raw: unknown): VcMeetingDeliveryValidationResult {
  if (!isRecord(raw)) return badRequest('request body must be an object');
  if (raw.schemaVersion !== VC_MEETING_DELIVERY_SCHEMA_VERSION) {
    return badRequest('schemaVersion must be 1', 'schemaVersion');
  }
  if (!isRecord(raw.meeting)) return badRequest('meeting must be an object', 'meeting');
  if (!isRecord(raw.member)) return badRequest('member must be an object', 'member');
  if (raw.member.instructions !== undefined) {
    return badRequest(
      'member.instructions belongs to the registered membership projection, not a delivery envelope',
      'member.instructions',
    );
  }
  if (!isRecord(raw.stream)) return badRequest('stream must be an object', 'stream');
  if (!Array.isArray(raw.entries)) return badRequest('entries must be an array', 'entries');
  if (!isRecord(raw.target)) return badRequest('target must be an object', 'target');

  const stringFields: Array<[unknown, string]> = [
    [raw.meeting.listenerAppId, 'meeting.listenerAppId'],
    [raw.meeting.meetingId, 'meeting.meetingId'],
    [raw.meeting.ownerBootId, 'meeting.ownerBootId'],
    [raw.member.memberId, 'member.memberId'],
    [raw.member.agentAppId, 'member.agentAppId'],
    [raw.member.role, 'member.role'],
    [raw.stream.batchId, 'stream.batchId'],
    [raw.target.sessionId, 'target.sessionId'],
    [raw.target.chatId, 'target.chatId'],
    [raw.instructionVersion, 'instructionVersion'],
  ];
  for (const [value, path] of stringFields) {
    const error = validateIdentifier(value, path);
    if (error) return error;
  }
  if (raw.sentAt !== undefined && typeof raw.sentAt !== 'string') {
    return badRequest('sentAt must be a string when present', 'sentAt');
  }
  if (raw.traceId !== undefined && typeof raw.traceId !== 'string') {
    return badRequest('traceId must be a string when present', 'traceId');
  }

  const integerFields: Array<[unknown, string]> = [
    [raw.meeting.ownerEpoch, 'meeting.ownerEpoch'],
    [raw.member.epoch, 'member.epoch'],
    [raw.member.membershipGeneration, 'member.membershipGeneration'],
    [raw.stream.fromSeq, 'stream.fromSeq'],
    [raw.stream.toSeq, 'stream.toSeq'],
  ];
  for (const [value, path] of integerFields) {
    if (!isPositiveSafeInteger(value)) {
      return badRequest(`${path} must be a positive safe integer`, path);
    }
  }
  if ((raw.stream.fromSeq as number) > (raw.stream.toSeq as number)) {
    return badRequest('stream.fromSeq must be <= stream.toSeq', 'stream');
  }
  if (typeof raw.stream.final !== 'boolean') {
    return badRequest('stream.final must be a boolean', 'stream.final');
  }
  if (typeof raw.stream.inputHash !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(raw.stream.inputHash)) {
    return badRequest('stream.inputHash must be a lowercase sha256 hash', 'stream.inputHash');
  }

  const fromSeq = raw.stream.fromSeq as number;
  const toSeq = raw.stream.toSeq as number;
  const expectedLength = toSeq - fromSeq + 1;
  if (raw.entries.length !== expectedLength) {
    return {
      ok: false,
      errorCode: 'entries_not_contiguous',
      error: `entries must exactly cover [${fromSeq}, ${toSeq}] (${expectedLength} entries)`,
      path: 'entries',
    };
  }

  let finalIndex = -1;
  for (let index = 0; index < raw.entries.length; index += 1) {
    const entry = raw.entries[index];
    const path = `entries[${index}]`;
    if (!isRecord(entry)) return badRequest(`${path} must be an object`, path);
    const expectedSeq = fromSeq + index;
    if (entry.deliverySeq !== expectedSeq) {
      return {
        ok: false,
        errorCode: 'entries_not_contiguous',
        error: `${path}.deliverySeq must be ${expectedSeq}`,
        path: `${path}.deliverySeq`,
      };
    }
    if (entry.ingestSeq !== undefined && !isPositiveSafeInteger(entry.ingestSeq)) {
      return badRequest(`${path}.ingestSeq must be a positive safe integer when present`, `${path}.ingestSeq`);
    }
    if (typeof entry.rawText !== 'string') {
      return badRequest(`${path}.rawText must be a string`, `${path}.rawText`);
    }
    if (!isDeliveryKind(entry.kind)) {
      return badRequest(`${path}.kind is not supported`, `${path}.kind`);
    }
    for (const field of ['itemVersionKey', 'contentHash', 'controlKey'] as const) {
      if (entry[field] !== undefined) {
        const error = validateIdentifier(entry[field], `${path}.${field}`);
        if (error) return error;
      }
    }

    if (entry.kind === 'item') {
      if (!isPositiveSafeInteger(entry.ingestSeq)) {
        return badRequest(`${path}.ingestSeq is required for item entries`, `${path}.ingestSeq`);
      }
      for (const field of ['itemVersionKey', 'contentHash'] as const) {
        const error = validateIdentifier(entry[field], `${path}.${field}`);
        if (error) return error;
      }
    }

    if (entry.kind === 'gap') {
      const gapError = validateGap(entry.gap, `${path}.gap`);
      if (gapError) return gapError;
    } else if (entry.gap !== undefined) {
      return badRequest(`${path}.gap is only valid for gap entries`, `${path}.gap`);
    }

    if (entry.kind === 'control' || entry.kind === 'effect_result') {
      const error = validateIdentifier(entry.controlKey, `${path}.controlKey`);
      if (error) return error;
    } else if (entry.controlKey !== undefined) {
      return badRequest(
        `${path}.controlKey is only valid for control or effect_result entries`,
        `${path}.controlKey`,
      );
    }

    if (entry.kind === 'final') {
      if (finalIndex !== -1) {
        return finalMismatch('a delivery batch may contain at most one final entry', `${path}.kind`);
      }
      finalIndex = index;
    }
  }

  const final = raw.stream.final as boolean;
  if (final && finalIndex !== raw.entries.length - 1) {
    return finalMismatch('stream.final requires one final entry at the end of entries', 'stream.final');
  }
  if (!final && finalIndex !== -1) {
    return finalMismatch('a final entry requires stream.final=true', `entries[${finalIndex}].kind`);
  }

  const request = raw as unknown as VcMeetingDeliveryRequest;
  const identity = deriveVcMeetingDeliveryIdentity(request);
  if (request.stream.inputHash !== identity.inputHash) {
    return {
      ok: false,
      errorCode: 'input_hash_mismatch',
      error: 'stream.inputHash does not match the canonical delivery input',
      path: 'stream.inputHash',
      expectedInputHash: identity.inputHash,
    };
  }
  return { ok: true, request, identity };
}

function validateGap(raw: unknown, path: string): VcMeetingDeliveryValidationResult & { ok: false } | undefined {
  if (!isRecord(raw)) return badRequest(`${path} is required for gap entries`, path);
  if (!isGapReason(raw.reason)) {
    return badRequest(`${path}.reason is not supported`, `${path}.reason`);
  }
  for (const field of ['occurredFromMs', 'occurredToMs'] as const) {
    if (raw[field] !== undefined
      && (typeof raw[field] !== 'number' || !Number.isFinite(raw[field]) || raw[field] < 0)) {
      return badRequest(`${path}.${field} must be a finite non-negative number`, `${path}.${field}`);
    }
  }
  if (typeof raw.occurredFromMs === 'number'
    && typeof raw.occurredToMs === 'number'
    && raw.occurredFromMs > raw.occurredToMs) {
    return badRequest(`${path}.occurredFromMs must be <= occurredToMs`, path);
  }
  for (const field of ['missingItemVersionKey', 'originalContentHash'] as const) {
    if (raw[field] !== undefined) {
      const error = validateIdentifier(raw[field], `${path}.${field}`);
      if (error) return error;
    }
  }
  return undefined;
}

function validateIdentifier(
  value: unknown,
  path: string,
): VcMeetingDeliveryValidationResult & { ok: false } | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    return badRequest(`${path} must be a non-empty string without surrounding whitespace`, path);
  }
  return undefined;
}

function badRequest(
  error: string,
  path?: string,
): VcMeetingDeliveryValidationResult & { ok: false } {
  return { ok: false, errorCode: 'bad_request', error, ...(path ? { path } : {}) };
}

function badProjectionRequest(
  error: string,
  path?: string,
): VcMeetingMemberProjectionValidationResult & { ok: false } {
  return { ok: false, errorCode: 'bad_request', error, ...(path ? { path } : {}) };
}

function finalMismatch(
  error: string,
  path: string,
): VcMeetingDeliveryValidationResult & { ok: false } {
  return { ok: false, errorCode: 'final_mismatch', error, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isDeliveryKind(value: unknown): value is VcMeetingDeliveryKind {
  return typeof value === 'string'
    && (VC_MEETING_DELIVERY_KINDS as readonly string[]).includes(value);
}

function isGapReason(value: unknown): value is VcMeetingDeliveryGapReason {
  return typeof value === 'string'
    && (VC_MEETING_DELIVERY_GAP_REASONS as readonly string[]).includes(value);
}

function assertDeliveryKeyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`deriveVcMeetingDeliveryKey: ${field} must be a non-empty string`);
  }
}

function assertPositiveSafeInteger(value: unknown, field: string): asserts value is number {
  if (!isPositiveSafeInteger(value)) {
    throw new Error(`deriveVcMeetingDeliveryKey: ${field} must be a positive safe integer`);
  }
}
