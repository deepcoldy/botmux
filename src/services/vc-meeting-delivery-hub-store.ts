/**
 * Durable hub-side metadata for VC meeting delivery fan-out.
 *
 * The receiver ledger is authoritative for execution. This store records only
 * the sender's membership projection, independently assigned deliverySeq,
 * frozen envelope identity, and the receiver cursor the hub has observed.
 * Meeting/chat/transcript text is deliberately absent. A frozen entry retains
 * source identity plus hashes (including the rendered text hash), so recovery
 * can re-render content and prove that it rebuilt the exact envelope.
 *
 * One JSON file is used per (listenerAppId, meetingId). Every RMW is protected
 * by the repository file lock and written with tmp+rename at mode 0600.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  VC_MEETING_DELIVERY_GAP_REASONS,
  VC_MEETING_DELIVERY_KINDS,
  VC_MEETING_MEMBER_STATUSES,
  VC_MEETING_RESPONSE_MODES,
  type VcMeetingDeliveryGap,
  type VcMeetingDeliveryKind,
  type VcMeetingMemberStatus,
  type VcMeetingResponseMode,
} from './vc-meeting-delivery-protocol.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import type {
  VcMeetingConsumerManagedSink,
  VcMeetingConsumerProfileFilter,
} from '../types.js';
import {
  isExactVcMeetingLegacyMemberIdentity,
  normalizeVcMeetingMemberPolicy,
  vcMeetingCanonicalStringListsEqual,
  vcMeetingMemberFilterEquals,
} from './vc-meeting-member-policy.js';
import { normalizeVcMeetingProfileInstructions } from './vc-meeting-profile-instructions.js';

const DIR_NAME = 'vc-meeting-delivery-hub';
const SCHEMA_VERSION = 1 as const;

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const DELIVERY_KEY_RE = /^vc_[0-9a-f]{1,47}$/;

export interface VcMeetingHubMemberKey {
  listenerAppId: string;
  meetingId: string;
  memberId: string;
  memberEpoch: number;
}

export interface VcMeetingHubMemberProjectionInput extends VcMeetingHubMemberKey {
  ownerBootId: string;
  ownerEpoch: number;
  agentAppId: string;
  role: string;
  /** Canonical trusted profile instructions, immutable within a member epoch. */
  instructions?: string;
  /** Immutable hash of role filter/profile semantics for this member epoch. */
  deliveryProfileHash: string;
  membershipGeneration: number;
  status: VcMeetingMemberStatus;
  responseMode: VcMeetingResponseMode;
  /** Optional only for exact MA-P0 legacy records; apply/read canonicalize it. */
  filter?: VcMeetingConsumerProfileFilter;
  capabilities?: string[];
  ownedSinks?: VcMeetingConsumerManagedSink[];
  sinkOwnerGeneration?: number;
  joinedAtIngestSeq: number;
  receiverSessionId: string;
  outputChatId: string;
}

/** Metadata-only counterpart of VcMeetingDeliveryEntry. */
export interface VcMeetingHubDeliveryEntryRef {
  deliverySeq: number;
  ingestSeq?: number;
  itemVersionKey?: string;
  contentHash?: string;
  kind: VcMeetingDeliveryKind;
  controlKey?: string;
  gap?: VcMeetingDeliveryGap;
  /** Hash of the exact rawText render; rawText itself must never enter this store. */
  renderedTextHash: string;
}

export interface VcMeetingHubRenderContext {
  timeZone: string;
  /** Sorted unique identity list used only for deterministic trust labels. */
  authorizedActorIds: string[];
}

export interface VcMeetingHubFrozenAssignment {
  deliveryKey: string;
  inputHash: string;
  ownerBootId: string;
  ownerEpoch: number;
  membershipGeneration: number;
  fromSeq: number;
  toSeq: number;
  batchId: string;
  final: boolean;
  entries: VcMeetingHubDeliveryEntryRef[];
  renderContext: VcMeetingHubRenderContext;
  instructionVersion: string;
  target: { sessionId: string; chatId: string };
  createdAt: number;
  updatedAt: number;
  lastObservation?: VcMeetingHubReceiverObservation;
}

export type VcMeetingHubReceiverStatus =
  | 'accepted'
  | 'dispatched'
  | 'completed'
  | 'duplicate'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'ambiguous';

export interface VcMeetingHubReceiverObservation {
  status: VcMeetingHubReceiverStatus;
  receiverCommittedThrough: number;
  observedAt: number;
}

export interface VcMeetingHubAckedAssignment {
  deliveryKey: string;
  inputHash: string;
  fromSeq: number;
  toSeq: number;
  final: boolean;
  receiverCommittedThrough: number;
  ackedAt: number;
}

/** Hole-aware per-member delivery history. A scalar ingest high-water cannot
 * represent a transcript that stabilizes after a later chat item was already
 * ACKed, so item versions remain indexed for the meeting epoch lifetime. */
export interface VcMeetingHubAckedItemVersion {
  ingestSeq: number;
  itemVersionKey: string;
  contentHash: string;
  deliverySeq: number;
  ackedAt: number;
}

export interface VcMeetingHubMemberRecord extends VcMeetingHubMemberProjectionInput {
  /** Highest contiguous prefix durably observed completed by the receiver. */
  senderAckedThrough: number;
  /** Next sequence to allocate. It advances when an assignment freezes. */
  nextDeliverySeq: number;
  inFlight?: VcMeetingHubFrozenAssignment;
  /** One compact tombstone makes a lost ACK response idempotent. */
  lastAckedAssignment?: VcMeetingHubAckedAssignment;
  /** Metadata only; no rendered/raw meeting content. */
  ackedItemVersions: VcMeetingHubAckedItemVersion[];
  finalAssignedSeq?: number;
  finalAckedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type VcMeetingHubClosePhase = 'active' | 'data_closing' | 'finalizing' | 'closed';

export interface VcMeetingHubCloseRecord {
  phase: VcMeetingHubClosePhase;
  finalizationDeadlineAt?: number;
  closedAt?: number;
  reason?: string;
  updatedAt: number;
}

interface VcMeetingHubMemberState {
  maxKnownEpoch: number;
  generationHighWater: number;
  epochs: Record<string, VcMeetingHubMemberRecord>;
}

interface VcMeetingHubStateFile {
  schemaVersion: typeof SCHEMA_VERSION;
  listenerAppId: string;
  meetingId: string;
  owner: {
    ownerBootId: string;
    ownerEpoch: number;
    retiredBootIds: string[];
  };
  close: VcMeetingHubCloseRecord;
  members: Record<string, VcMeetingHubMemberState>;
  createdAt: number;
  updatedAt: number;
}

export type VcMeetingHubProjectionRejectReason =
  | 'invalid'
  | 'meeting_closed'
  | 'stale_owner_epoch'
  | 'stale_owner_boot'
  | 'stale_member_epoch'
  | 'stale_membership_generation'
  | 'stale_sink_owner_generation'
  | 'sink_owner_conflict'
  | 'projection_conflict'
  | 'epoch_required'
  | 'epoch_removed';

export type VcMeetingHubProjectionResult =
  | { ok: true; record: VcMeetingHubMemberRecord }
  | { ok: false; reason: VcMeetingHubProjectionRejectReason; detail?: string };

export interface VcMeetingHubFreezeInput extends VcMeetingHubMemberKey {
  ownerBootId: string;
  ownerEpoch: number;
  membershipGeneration: number;
  deliveryKey: string;
  inputHash: string;
  fromSeq: number;
  toSeq: number;
  batchId: string;
  final: boolean;
  entries: VcMeetingHubDeliveryEntryRef[];
  renderContext: VcMeetingHubRenderContext;
  instructionVersion: string;
  target: { sessionId: string; chatId: string };
}

export type VcMeetingHubFreezeRejectReason =
  | 'invalid'
  | 'unknown_meeting'
  | 'meeting_closed'
  | 'unknown_member'
  | 'stale_owner_epoch'
  | 'owner_epoch_not_registered'
  | 'stale_owner_boot'
  | 'stale_member_epoch'
  | 'stale_membership_generation'
  | 'membership_generation_not_registered'
  | 'membership_paused'
  | 'membership_removed'
  | 'target_mismatch'
  | 'delivery_in_flight'
  | 'assignment_conflict'
  | 'delivery_partial_overlap'
  | 'delivery_gap'
  | 'item_already_acked'
  | 'acked_item_conflict'
  | 'stream_finalized'
  | 'final_already_assigned';

export type VcMeetingHubFreezeResult =
  | { kind: 'frozen'; assignment: VcMeetingHubFrozenAssignment; senderAckedThrough: number }
  | { kind: 'existing'; assignment: VcMeetingHubFrozenAssignment; senderAckedThrough: number }
  | { kind: 'already_acked'; ack: VcMeetingHubAckedAssignment; senderAckedThrough: number }
  | {
      kind: 'conflict';
      reason: VcMeetingHubFreezeRejectReason;
      expectedFromSeq?: number;
      activeDeliveryKey?: string;
    };

export interface VcMeetingHubReceiptObservationInput extends VcMeetingHubMemberKey {
  ownerBootId: string;
  ownerEpoch: number;
  deliveryKey: string;
  inputHash: string;
  fromSeq: number;
  toSeq: number;
  status: VcMeetingHubReceiverStatus;
  receiverCommittedThrough: number;
}

export type VcMeetingHubObserveRejectReason =
  | 'invalid'
  | 'unknown_meeting'
  | 'unknown_member'
  | 'stale_owner_epoch'
  | 'owner_epoch_not_registered'
  | 'stale_owner_boot'
  | 'stale_member_epoch'
  | 'no_in_flight'
  | 'delivery_key_mismatch'
  | 'input_hash_mismatch'
  | 'range_mismatch'
  | 'acked_item_conflict'
  | 'receiver_cursor_regression'
  | 'receiver_cursor_short';

export type VcMeetingHubObserveResult =
  | {
      ok: true;
      kind: 'observed' | 'acked' | 'already_acked';
      senderAckedThrough: number;
      assignment?: VcMeetingHubFrozenAssignment;
      ack?: VcMeetingHubAckedAssignment;
    }
  | { ok: false; reason: VcMeetingHubObserveRejectReason };

export interface VcMeetingHubCloseInput {
  listenerAppId: string;
  meetingId: string;
  ownerBootId: string;
  ownerEpoch: number;
  phase: VcMeetingHubClosePhase;
  finalizationDeadlineAt?: number;
  reason?: string;
}

export type VcMeetingHubCloseResult =
  | { ok: true; close: VcMeetingHubCloseRecord }
  | {
      ok: false;
      reason: 'invalid' | 'unknown_meeting' | 'stale_owner_epoch' | 'owner_epoch_not_registered'
        | 'stale_owner_boot' | 'close_phase_regression' | 'close_phase_jump' | 'final_not_acked'
        | 'in_flight_not_settled';
    };

function safeFileToken(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, (ch) => `%${ch.charCodeAt(0).toString(16)}`);
}

function meetingFilePath(dataDir: string, listenerAppId: string, meetingId: string): string {
  return join(dataDir, DIR_NAME, `${safeFileToken(listenerAppId)}__${safeFileToken(meetingId)}.json`);
}

function stateDirectory(dataDir: string): string {
  return join(dataDir, DIR_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

function isDeliveryKey(value: unknown): value is string {
  return typeof value === 'string' && DELIVERY_KEY_RE.test(value);
}

function validGap(value: unknown): value is VcMeetingDeliveryGap {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'occurredFromMs',
      'occurredToMs',
      'missingItemVersionKey',
      'originalContentHash',
      'reason',
    ])
    || typeof value.reason !== 'string'
    || !(VC_MEETING_DELIVERY_GAP_REASONS as readonly string[]).includes(value.reason)) return false;
  if (value.occurredFromMs !== undefined && !isFiniteNonNegative(value.occurredFromMs)) return false;
  if (value.occurredToMs !== undefined && !isFiniteNonNegative(value.occurredToMs)) return false;
  if (typeof value.occurredFromMs === 'number' && typeof value.occurredToMs === 'number'
    && value.occurredFromMs > value.occurredToMs) return false;
  if (value.missingItemVersionKey !== undefined && !isNonEmpty(value.missingItemVersionKey)) return false;
  if (value.originalContentHash !== undefined && !isHash(value.originalContentHash)) return false;
  return true;
}

function validEntryRef(value: unknown): value is VcMeetingHubDeliveryEntryRef {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'deliverySeq',
      'ingestSeq',
      'itemVersionKey',
      'contentHash',
      'kind',
      'controlKey',
      'gap',
      'renderedTextHash',
    ])
    || !isPositiveInteger(value.deliverySeq)
    || typeof value.kind !== 'string'
    || !(VC_MEETING_DELIVERY_KINDS as readonly string[]).includes(value.kind)
    || !isHash(value.renderedTextHash)) return false;
  if (value.ingestSeq !== undefined && !isPositiveInteger(value.ingestSeq)) return false;
  for (const field of ['itemVersionKey', 'controlKey'] as const) {
    if (value[field] !== undefined && !isNonEmpty(value[field])) return false;
  }
  if (value.contentHash !== undefined && !isHash(value.contentHash)) return false;
  if (value.kind === 'item'
    && (!isPositiveInteger(value.ingestSeq)
      || !isNonEmpty(value.itemVersionKey)
      || !isHash(value.contentHash))) return false;
  if (value.kind === 'gap') {
    if (!validGap(value.gap)) return false;
  } else if (value.gap !== undefined) return false;
  if (value.kind === 'control' || value.kind === 'effect_result') {
    if (!isNonEmpty(value.controlKey)) return false;
  } else if (value.controlKey !== undefined) return false;
  return true;
}

function validObservation(value: unknown): value is VcMeetingHubReceiverObservation {
  return isRecord(value)
    && hasOnlyKeys(value, ['status', 'receiverCommittedThrough', 'observedAt'])
    && typeof value.status === 'string'
    && (['accepted', 'dispatched', 'completed', 'duplicate', 'failed_retryable', 'failed_terminal', 'ambiguous'] as const)
      .includes(value.status as VcMeetingHubReceiverStatus)
    && isNonNegativeInteger(value.receiverCommittedThrough)
    && isFiniteNonNegative(value.observedAt);
}

function validRenderContext(value: unknown): value is VcMeetingHubRenderContext {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['timeZone', 'authorizedActorIds'])
    || !isNonEmpty(value.timeZone)
    || !Array.isArray(value.authorizedActorIds)
    || !value.authorizedActorIds.every(isNonEmpty)) return false;
  const authorizedActorIds = value.authorizedActorIds as string[];
  const sorted = [...authorizedActorIds].sort();
  return new Set(authorizedActorIds).size === authorizedActorIds.length
    && sorted.every((item, index) => item === authorizedActorIds[index]);
}

function validAssignment(value: unknown): value is VcMeetingHubFrozenAssignment {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'deliveryKey',
      'inputHash',
      'ownerBootId',
      'ownerEpoch',
      'membershipGeneration',
      'fromSeq',
      'toSeq',
      'batchId',
      'final',
      'entries',
      'renderContext',
      'instructionVersion',
      'target',
      'createdAt',
      'updatedAt',
      'lastObservation',
    ])
    || !isDeliveryKey(value.deliveryKey)
    || !isHash(value.inputHash)
    || !isNonEmpty(value.ownerBootId)
    || !isPositiveInteger(value.ownerEpoch)
    || !isPositiveInteger(value.membershipGeneration)
    || !isPositiveInteger(value.fromSeq)
    || !isPositiveInteger(value.toSeq)
    || value.fromSeq > value.toSeq
    || !isNonEmpty(value.batchId)
    || typeof value.final !== 'boolean'
    || !Array.isArray(value.entries)
    || !validRenderContext(value.renderContext)
    || !isNonEmpty(value.instructionVersion)
    || !isRecord(value.target)
    || !hasOnlyKeys(value.target, ['sessionId', 'chatId'])
    || !isNonEmpty(value.target.sessionId)
    || !isNonEmpty(value.target.chatId)
    || !isFiniteNonNegative(value.createdAt)
    || !isFiniteNonNegative(value.updatedAt)
    || (value.lastObservation !== undefined && !validObservation(value.lastObservation))) return false;
  if (value.entries.length !== value.toSeq - value.fromSeq + 1) return false;
  let finalCount = 0;
  const itemVersionKeys = new Set<string>();
  const ingestSeqs = new Set<number>();
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = value.entries[index];
    if (!validEntryRef(entry) || entry.deliverySeq !== value.fromSeq + index) return false;
    if (entry.kind === 'final') finalCount += 1;
    if (entry.kind === 'item') {
      if (itemVersionKeys.has(entry.itemVersionKey!) || ingestSeqs.has(entry.ingestSeq!)) return false;
      itemVersionKeys.add(entry.itemVersionKey!);
      ingestSeqs.add(entry.ingestSeq!);
    }
  }
  return value.final
    ? finalCount === 1 && value.entries[value.entries.length - 1]?.kind === 'final'
    : finalCount === 0;
}

function validAck(value: unknown): value is VcMeetingHubAckedAssignment {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'deliveryKey',
      'inputHash',
      'fromSeq',
      'toSeq',
      'final',
      'receiverCommittedThrough',
      'ackedAt',
    ])
    && isDeliveryKey(value.deliveryKey)
    && isHash(value.inputHash)
    && isPositiveInteger(value.fromSeq)
    && isPositiveInteger(value.toSeq)
    && value.fromSeq <= value.toSeq
    && typeof value.final === 'boolean'
    && isNonNegativeInteger(value.receiverCommittedThrough)
    && value.receiverCommittedThrough >= value.toSeq
    && isFiniteNonNegative(value.ackedAt);
}

function validAckedItemVersion(value: unknown): value is VcMeetingHubAckedItemVersion {
  return isRecord(value)
    && hasOnlyKeys(value, ['ingestSeq', 'itemVersionKey', 'contentHash', 'deliverySeq', 'ackedAt'])
    && isPositiveInteger(value.ingestSeq)
    && isNonEmpty(value.itemVersionKey)
    && isHash(value.contentHash)
    && isPositiveInteger(value.deliverySeq)
    && isFiniteNonNegative(value.ackedAt);
}

function validMemberRecord(value: unknown): value is VcMeetingHubMemberRecord {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'listenerAppId',
      'meetingId',
      'memberId',
      'memberEpoch',
      'ownerBootId',
      'ownerEpoch',
      'agentAppId',
      'role',
      'instructions',
      'deliveryProfileHash',
      'membershipGeneration',
      'status',
      'responseMode',
      'filter',
      'capabilities',
      'ownedSinks',
      'sinkOwnerGeneration',
      'joinedAtIngestSeq',
      'receiverSessionId',
      'outputChatId',
      'senderAckedThrough',
      'nextDeliverySeq',
      'inFlight',
      'lastAckedAssignment',
      'ackedItemVersions',
      'finalAssignedSeq',
      'finalAckedAt',
      'createdAt',
      'updatedAt',
    ])
    || !isNonEmpty(value.listenerAppId)
    || !isNonEmpty(value.meetingId)
    || !isNonEmpty(value.memberId)
    || !isPositiveInteger(value.memberEpoch)
    || !isNonEmpty(value.ownerBootId)
    || !isPositiveInteger(value.ownerEpoch)
    || !isNonEmpty(value.agentAppId)
    || !isNonEmpty(value.role)
    || !isHash(value.deliveryProfileHash)
    || !isPositiveInteger(value.membershipGeneration)
    || typeof value.status !== 'string'
    || !(VC_MEETING_MEMBER_STATUSES as readonly string[]).includes(value.status)
    || typeof value.responseMode !== 'string'
    || !(VC_MEETING_RESPONSE_MODES as readonly string[]).includes(value.responseMode)
    || !isNonNegativeInteger(value.joinedAtIngestSeq)
    || !isNonEmpty(value.receiverSessionId)
    || !isNonEmpty(value.outputChatId)
    || !isNonNegativeInteger(value.senderAckedThrough)
    || !isPositiveInteger(value.nextDeliverySeq)
    || value.nextDeliverySeq < value.senderAckedThrough + 1
    || (value.inFlight !== undefined && !validAssignment(value.inFlight))
    || (value.lastAckedAssignment !== undefined && !validAck(value.lastAckedAssignment))
    || !Array.isArray(value.ackedItemVersions)
    || !value.ackedItemVersions.every(validAckedItemVersion)
    || (value.finalAssignedSeq !== undefined && !isPositiveInteger(value.finalAssignedSeq))
    || (value.finalAckedAt !== undefined && !isFiniteNonNegative(value.finalAckedAt))
    || !isFiniteNonNegative(value.createdAt)
    || !isFiniteNonNegative(value.updatedAt)) return false;
  const normalizedInstructions = normalizeVcMeetingProfileInstructions(value.instructions);
  if (!normalizedInstructions.ok
    || normalizedInstructions.instructions !== value.instructions) return false;
  const policy = normalizeVcMeetingMemberPolicy({
    memberId: value.memberId as string,
    role: value.role as string,
    membershipGeneration: value.membershipGeneration as number,
    responseMode: value.responseMode as VcMeetingResponseMode,
    filter: value.filter,
    capabilities: value.capabilities,
    ownedSinks: value.ownedSinks,
    sinkOwnerGeneration: value.sinkOwnerGeneration,
  });
  if (!policy
    || !vcMeetingMemberFilterEquals(
      value.filter as VcMeetingConsumerProfileFilter | undefined,
      policy.filter,
    )
    || !vcMeetingCanonicalStringListsEqual(value.capabilities as string[], policy.capabilities)
    || !vcMeetingCanonicalStringListsEqual(
      value.ownedSinks as VcMeetingConsumerManagedSink[],
      policy.ownedSinks,
    )
    || value.sinkOwnerGeneration !== policy.sinkOwnerGeneration) return false;
  const ackedKeys = new Set<string>();
  for (const item of value.ackedItemVersions) {
    if (ackedKeys.has(item.itemVersionKey)) return false;
    ackedKeys.add(item.itemVersionKey);
    if (item.deliverySeq > value.senderAckedThrough) return false;
  }
  if (value.inFlight) {
    if (value.inFlight.fromSeq !== value.senderAckedThrough + 1
      || value.nextDeliverySeq !== value.inFlight.toSeq + 1) return false;
  } else if (value.nextDeliverySeq !== value.senderAckedThrough + 1) return false;
  if (value.finalAckedAt !== undefined
    && (value.finalAssignedSeq === undefined || value.senderAckedThrough < value.finalAssignedSeq)) return false;
  return true;
}

function validClose(value: unknown): value is VcMeetingHubCloseRecord {
  return isRecord(value)
    && hasOnlyKeys(value, ['phase', 'finalizationDeadlineAt', 'closedAt', 'reason', 'updatedAt'])
    && typeof value.phase === 'string'
    && (['active', 'data_closing', 'finalizing', 'closed'] as const).includes(value.phase as VcMeetingHubClosePhase)
    && (value.finalizationDeadlineAt === undefined || isFiniteNonNegative(value.finalizationDeadlineAt))
    && (value.closedAt === undefined || isFiniteNonNegative(value.closedAt))
    && (value.reason === undefined || isNonEmpty(value.reason))
    && isFiniteNonNegative(value.updatedAt)
    && (value.phase === 'closed' ? value.closedAt !== undefined : value.closedAt === undefined);
}

function validState(value: unknown): value is VcMeetingHubStateFile {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'schemaVersion',
      'listenerAppId',
      'meetingId',
      'owner',
      'close',
      'members',
      'createdAt',
      'updatedAt',
    ])
    || value.schemaVersion !== SCHEMA_VERSION
    || !isNonEmpty(value.listenerAppId)
    || !isNonEmpty(value.meetingId)
    || !isRecord(value.owner)
    || !hasOnlyKeys(value.owner, ['ownerBootId', 'ownerEpoch', 'retiredBootIds'])
    || !isNonEmpty(value.owner.ownerBootId)
    || !isPositiveInteger(value.owner.ownerEpoch)
    || !Array.isArray(value.owner.retiredBootIds)
    || !value.owner.retiredBootIds.every(isNonEmpty)
    || new Set(value.owner.retiredBootIds).size !== value.owner.retiredBootIds.length
    || !validClose(value.close)
    || !isRecord(value.members)
    || !isFiniteNonNegative(value.createdAt)
    || !isFiniteNonNegative(value.updatedAt)) return false;
  for (const [memberId, rawMember] of Object.entries(value.members)) {
    if (!isNonEmpty(memberId) || !isRecord(rawMember)
      || !hasOnlyKeys(rawMember, ['maxKnownEpoch', 'generationHighWater', 'epochs'])
      || !isPositiveInteger(rawMember.maxKnownEpoch)
      || !isPositiveInteger(rawMember.generationHighWater)
      || !isRecord(rawMember.epochs)) return false;
    let maxEpoch = 0;
    let maxGeneration = 0;
    for (const [epochKey, record] of Object.entries(rawMember.epochs)) {
      if (!validMemberRecord(record)
        || record.listenerAppId !== value.listenerAppId
        || record.meetingId !== value.meetingId
        || record.memberId !== memberId
        || String(record.memberEpoch) !== epochKey) return false;
      maxEpoch = Math.max(maxEpoch, record.memberEpoch);
      maxGeneration = Math.max(maxGeneration, record.membershipGeneration);
    }
    if (maxEpoch !== rawMember.maxKnownEpoch || maxGeneration !== rawMember.generationHighWater) return false;
  }
  return true;
}

function normalizePersistedMemberPolicies(value: unknown): void {
  if (!isRecord(value) || !isRecord(value.members)) return;
  for (const rawMember of Object.values(value.members)) {
    if (!isRecord(rawMember) || !isRecord(rawMember.epochs)) continue;
    for (const rawRecord of Object.values(rawMember.epochs)) {
      if (!isRecord(rawRecord)
        || typeof rawRecord.memberId !== 'string'
        || typeof rawRecord.role !== 'string'
        || typeof rawRecord.membershipGeneration !== 'number'
        || (rawRecord.responseMode !== 'silent' && rawRecord.responseMode !== 'listener_thread')) continue;
      const policy = normalizeVcMeetingMemberPolicy({
        memberId: rawRecord.memberId,
        role: rawRecord.role,
        membershipGeneration: rawRecord.membershipGeneration,
        responseMode: rawRecord.responseMode,
        filter: rawRecord.filter,
        capabilities: rawRecord.capabilities,
        ownedSinks: rawRecord.ownedSinks,
        sinkOwnerGeneration: rawRecord.sinkOwnerGeneration,
      });
      if (policy) Object.assign(rawRecord, policy);
      const normalizedInstructions = normalizeVcMeetingProfileInstructions(rawRecord.instructions);
      if (normalizedInstructions.ok) {
        if (normalizedInstructions.instructions === undefined) delete rawRecord.instructions;
        else rawRecord.instructions = normalizedInstructions.instructions;
      }
    }
  }
}

function readStateForAccess(filePath: string): VcMeetingHubStateFile | undefined {
  if (!existsSync(filePath)) {
    const prefix = `${basename(filePath)}.corrupt.`;
    let quarantined = false;
    try { quarantined = readdirSync(dirname(filePath)).some(name => name.startsWith(prefix)); }
    catch { /* a genuinely absent directory/state is initializable */ }
    if (quarantined) throw new Error(`vc meeting hub state has quarantined evidence for ${filePath}`);
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    normalizePersistedMemberPolicies(parsed);
    if (!validState(parsed)) throw new Error('state failed schema/invariant validation');
    return parsed;
  } catch (err) {
    const aside = `${filePath}.corrupt.${Date.now()}.${process.pid}`;
    try { renameSync(filePath, aside); } catch { /* another process may already quarantine it */ }
    logger.warn(
      `[vc-meeting-delivery-hub-store] corrupt state at ${filePath}, moved aside to ${aside}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    // Missing state may be initialized by an authoritative projection;
    // corrupt state must not be mistaken for missing or cursor zero. The
    // caller pauses this meeting until an operator reconciles the quarantined
    // evidence.
    throw new Error(`vc meeting hub state is corrupt: ${aside}`);
  }
}

function writeState(filePath: string, state: VcMeetingHubStateFile, now: number): void {
  state.updatedAt = now;
  if (!validState(state)) {
    throw new Error('refusing to write invalid vc meeting hub state');
  }
  const actualDir = join(filePath, '..');
  if (!existsSync(actualDir)) mkdirSync(actualDir, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(filePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

function mutateState<T>(
  dataDir: string,
  listenerAppId: string,
  meetingId: string,
  now: number,
  fn: (state: VcMeetingHubStateFile | undefined) => { result: T; write?: VcMeetingHubStateFile },
): T {
  const dir = stateDirectory(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = meetingFilePath(dataDir, listenerAppId, meetingId);
  return withFileLockSync(filePath, () => {
    const state = readStateForAccess(filePath);
    const mutation = fn(state);
    if (mutation.write) writeState(filePath, mutation.write, now);
    return mutation.result;
  });
}

function readState(dataDir: string, listenerAppId: string, meetingId: string): VcMeetingHubStateFile | undefined {
  const filePath = meetingFilePath(dataDir, listenerAppId, meetingId);
  if (!existsSync(filePath)) return undefined;
  return withFileLockSync(filePath, () => readStateForAccess(filePath));
}

function newState(input: VcMeetingHubMemberProjectionInput, now: number): VcMeetingHubStateFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    listenerAppId: input.listenerAppId,
    meetingId: input.meetingId,
    owner: { ownerBootId: input.ownerBootId, ownerEpoch: input.ownerEpoch, retiredBootIds: [] },
    close: { phase: 'active', updatedAt: now },
    members: {},
    createdAt: now,
    updatedAt: now,
  };
}

function projectionInputValid(input: VcMeetingHubMemberProjectionInput): boolean {
  return isRecord(input)
    && hasOnlyKeys(input, [
      'listenerAppId',
      'meetingId',
      'memberId',
      'memberEpoch',
      'ownerBootId',
      'ownerEpoch',
      'agentAppId',
      'role',
      'instructions',
      'deliveryProfileHash',
      'membershipGeneration',
      'status',
      'responseMode',
      'filter',
      'capabilities',
      'ownedSinks',
      'sinkOwnerGeneration',
      'joinedAtIngestSeq',
      'receiverSessionId',
      'outputChatId',
    ])
    && isNonEmpty(input.listenerAppId)
    && isNonEmpty(input.meetingId)
    && isNonEmpty(input.memberId)
    && isPositiveInteger(input.memberEpoch)
    && isNonEmpty(input.ownerBootId)
    && isPositiveInteger(input.ownerEpoch)
    && isNonEmpty(input.agentAppId)
    && isNonEmpty(input.role)
    && isHash(input.deliveryProfileHash)
    && isPositiveInteger(input.membershipGeneration)
    && (VC_MEETING_MEMBER_STATUSES as readonly string[]).includes(input.status)
    && (VC_MEETING_RESPONSE_MODES as readonly string[]).includes(input.responseMode)
    && normalizeVcMeetingMemberPolicy({
      memberId: input.memberId,
      role: input.role,
      membershipGeneration: input.membershipGeneration,
      responseMode: input.responseMode,
      filter: input.filter,
      capabilities: input.capabilities,
      ownedSinks: input.ownedSinks,
      sinkOwnerGeneration: input.sinkOwnerGeneration,
    }) !== undefined
    && isNonNegativeInteger(input.joinedAtIngestSeq)
    && isNonEmpty(input.receiverSessionId)
    && isNonEmpty(input.outputChatId)
    && (() => {
      const normalized = normalizeVcMeetingProfileInstructions(input.instructions);
      return normalized.ok && normalized.instructions === input.instructions;
    })();
}

function streamIdentityEquals(
  a: VcMeetingHubMemberProjectionInput,
  b: VcMeetingHubMemberProjectionInput,
): boolean {
  return a.agentAppId === b.agentAppId
    && a.role === b.role
    && a.instructions === b.instructions
    && a.deliveryProfileHash === b.deliveryProfileHash
    && vcMeetingMemberFilterEquals(a.filter, b.filter)
    && a.joinedAtIngestSeq === b.joinedAtIngestSeq
    && a.receiverSessionId === b.receiverSessionId
    && a.outputChatId === b.outputChatId;
}

function projectionContentEquals(
  a: VcMeetingHubMemberProjectionInput,
  b: VcMeetingHubMemberProjectionInput,
): boolean {
  return streamIdentityEquals(a, b)
    && a.status === b.status
    && a.responseMode === b.responseMode
    && vcMeetingCanonicalStringListsEqual(a.capabilities ?? [], b.capabilities ?? [])
    && vcMeetingCanonicalStringListsEqual(a.ownedSinks ?? [], b.ownedSinks ?? [])
    && a.sinkOwnerGeneration === b.sinkOwnerGeneration;
}

function updateOwner(
  state: VcMeetingHubStateFile,
  ownerEpoch: number,
  ownerBootId: string,
): void {
  if (ownerEpoch > state.owner.ownerEpoch) {
    state.owner = { ownerEpoch, ownerBootId, retiredBootIds: [] };
    return;
  }
  if (ownerBootId === state.owner.ownerBootId) return;
  const retired = state.owner.retiredBootIds.slice();
  if (state.owner.ownerBootId && !retired.includes(state.owner.ownerBootId)) {
    retired.push(state.owner.ownerBootId);
  }
  state.owner = { ownerEpoch, ownerBootId, retiredBootIds: retired };
}

export function applyVcMeetingHubMemberProjection(
  dataDir: string,
  input: VcMeetingHubMemberProjectionInput,
  now = Date.now(),
): VcMeetingHubProjectionResult {
  const normalizedInstructions = normalizeVcMeetingProfileInstructions(input.instructions);
  if (!normalizedInstructions.ok) return { ok: false, reason: 'invalid' };
  const policy = normalizeVcMeetingMemberPolicy({
    memberId: input.memberId,
    role: input.role,
    membershipGeneration: input.membershipGeneration,
    responseMode: input.responseMode,
    filter: input.filter,
    capabilities: input.capabilities,
    ownedSinks: input.ownedSinks,
    sinkOwnerGeneration: input.sinkOwnerGeneration,
  });
  if (policy) input = { ...input, ...policy };
  else input = { ...input };
  if (normalizedInstructions.instructions === undefined) delete input.instructions;
  else input.instructions = normalizedInstructions.instructions;
  if (!projectionInputValid(input) || !isFiniteNonNegative(now)) {
    return { ok: false, reason: 'invalid' };
  }
  return mutateState<VcMeetingHubProjectionResult>(dataDir, input.listenerAppId, input.meetingId, now, (existing) => {
    const state = existing ?? newState(input, now);
    if (state.close.phase === 'closed') {
      return { result: { ok: false as const, reason: 'meeting_closed' as const } };
    }
    if (input.ownerEpoch < state.owner.ownerEpoch) {
      return { result: { ok: false as const, reason: 'stale_owner_epoch' as const } };
    }
    if (input.ownerEpoch === state.owner.ownerEpoch
      && state.owner.retiredBootIds.includes(input.ownerBootId)) {
      return { result: { ok: false as const, reason: 'stale_owner_boot' as const } };
    }

    const member = state.members[input.memberId] ?? {
      maxKnownEpoch: input.memberEpoch,
      generationHighWater: input.membershipGeneration,
      epochs: {},
    };
    if (input.memberEpoch < member.maxKnownEpoch) {
      return { result: { ok: false as const, reason: 'stale_member_epoch' as const } };
    }
    if (input.membershipGeneration < member.generationHighWater) {
      return { result: { ok: false as const, reason: 'stale_membership_generation' as const } };
    }
    const prior = member.epochs[String(input.memberEpoch)];
    if (prior?.status === 'removed' && input.status !== 'removed') {
      return { result: { ok: false as const, reason: 'epoch_removed' as const } };
    }
    if (prior && input.membershipGeneration === prior.membershipGeneration
      && !projectionContentEquals(input, prior)) {
      return { result: { ok: false as const, reason: 'projection_conflict' as const } };
    }
    if (prior
      && (input.sinkOwnerGeneration ?? 0) < (prior.sinkOwnerGeneration ?? 0)) {
      return { result: { ok: false as const, reason: 'stale_sink_owner_generation' as const } };
    }
    const sinkOwnershipChanged = !vcMeetingCanonicalStringListsEqual(
      input.ownedSinks ?? [],
      prior?.ownedSinks ?? [],
    );
    if (prior && sinkOwnershipChanged
      && (input.sinkOwnerGeneration ?? 0) <= (prior.sinkOwnerGeneration ?? 0)) {
      return { result: { ok: false as const, reason: 'stale_sink_owner_generation' as const } };
    }
    if (prior && !streamIdentityEquals(input, prior)) {
      return { result: { ok: false as const, reason: 'epoch_required' as const } };
    }

    // Profile-mode ownership is a durable invariant, not merely config-time
    // validation. Exact MA-P0 legacy epochs are exempt until the daemon's
    // single-agent switch path is migrated to explicit remove-then-claim.
    if (input.status !== 'removed'
      && !isExactVcMeetingLegacyMemberIdentity(input)
      && (input.ownedSinks?.length ?? 0) > 0) {
      for (const [otherMemberId, otherState] of Object.entries(state.members)) {
        // A higher epoch atomically supersedes this same logical member's old
        // epoch. Requiring a separate remove first creates a crash window where
        // restore cannot publish the successor at all. Other logical members
        // still compete against the latest epoch and remain conflict-fenced.
        if (otherMemberId === input.memberId) continue;
        const other = otherState.epochs[String(otherState.maxKnownEpoch)];
        if (!other || other.status === 'removed') continue;
        const overlap = (input.ownedSinks ?? []).find(sink => other.ownedSinks?.includes(sink));
        if (overlap) {
          return {
            result: {
              ok: false as const,
              reason: 'sink_owner_conflict' as const,
              detail: `${overlap} is already owned by ${other.memberId}@${other.memberEpoch}`,
            },
          };
        }
      }
    }

    updateOwner(state, input.ownerEpoch, input.ownerBootId);
    const record: VcMeetingHubMemberRecord = {
      ...input,
      senderAckedThrough: prior?.senderAckedThrough ?? 0,
      nextDeliverySeq: prior?.nextDeliverySeq ?? 1,
      ...(prior?.inFlight ? { inFlight: prior.inFlight } : {}),
      ...(prior?.lastAckedAssignment ? { lastAckedAssignment: prior.lastAckedAssignment } : {}),
      ackedItemVersions: prior?.ackedItemVersions.map(item => ({ ...item })) ?? [],
      ...(prior?.finalAssignedSeq !== undefined ? { finalAssignedSeq: prior.finalAssignedSeq } : {}),
      ...(prior?.finalAckedAt !== undefined ? { finalAckedAt: prior.finalAckedAt } : {}),
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    member.epochs[String(input.memberEpoch)] = record;
    member.maxKnownEpoch = Math.max(member.maxKnownEpoch, input.memberEpoch);
    member.generationHighWater = Math.max(member.generationHighWater, input.membershipGeneration);
    state.members[input.memberId] = member;
    return { result: { ok: true as const, record }, write: state };
  });
}

function freezeInputValid(input: VcMeetingHubFreezeInput): boolean {
  if (!isRecord(input)
    || !hasOnlyKeys(input, [
      'listenerAppId',
      'meetingId',
      'memberId',
      'memberEpoch',
      'ownerBootId',
      'ownerEpoch',
      'membershipGeneration',
      'deliveryKey',
      'inputHash',
      'fromSeq',
      'toSeq',
      'batchId',
      'final',
      'entries',
      'renderContext',
      'instructionVersion',
      'target',
    ])
    || !isNonEmpty(input.listenerAppId)
    || !isNonEmpty(input.meetingId)
    || !isNonEmpty(input.memberId)
    || !isPositiveInteger(input.memberEpoch)
    || !isNonEmpty(input.ownerBootId)
    || !isPositiveInteger(input.ownerEpoch)
    || !isPositiveInteger(input.membershipGeneration)
    || !isDeliveryKey(input.deliveryKey)
    || !isHash(input.inputHash)
    || !isPositiveInteger(input.fromSeq)
    || !isPositiveInteger(input.toSeq)
    || input.fromSeq > input.toSeq
    || !isNonEmpty(input.batchId)
    || typeof input.final !== 'boolean'
    || !Array.isArray(input.entries)
    || !validRenderContext(input.renderContext)
    || !isNonEmpty(input.instructionVersion)
    || !isRecord(input.target)
    || !hasOnlyKeys(input.target, ['sessionId', 'chatId'])
    || !isNonEmpty(input.target.sessionId)
    || !isNonEmpty(input.target.chatId)) return false;
  if (input.entries.length !== input.toSeq - input.fromSeq + 1) return false;
  let finalCount = 0;
  const itemVersionKeys = new Set<string>();
  const ingestSeqs = new Set<number>();
  for (let index = 0; index < input.entries.length; index += 1) {
    const entry = input.entries[index];
    if (!validEntryRef(entry) || entry.deliverySeq !== input.fromSeq + index) return false;
    if (entry.kind === 'final') finalCount += 1;
    if (entry.kind === 'item') {
      if (itemVersionKeys.has(entry.itemVersionKey!) || ingestSeqs.has(entry.ingestSeq!)) return false;
      itemVersionKeys.add(entry.itemVersionKey!);
      ingestSeqs.add(entry.ingestSeq!);
    }
  }
  return input.final
    ? finalCount === 1 && input.entries[input.entries.length - 1]?.kind === 'final'
    : finalCount === 0;
}

function assignmentMetadataEquals(a: VcMeetingHubFrozenAssignment, b: VcMeetingHubFreezeInput): boolean {
  return a.deliveryKey === b.deliveryKey
    && a.inputHash === b.inputHash
    && a.ownerBootId === b.ownerBootId
    && a.ownerEpoch === b.ownerEpoch
    && a.membershipGeneration === b.membershipGeneration
    && a.fromSeq === b.fromSeq
    && a.toSeq === b.toSeq
    && a.batchId === b.batchId
    && a.final === b.final
    && a.renderContext.timeZone === b.renderContext.timeZone
    && a.renderContext.authorizedActorIds.length === b.renderContext.authorizedActorIds.length
    && a.renderContext.authorizedActorIds.every((id, index) => id === b.renderContext.authorizedActorIds[index])
    && a.instructionVersion === b.instructionVersion
    && a.target.sessionId === b.target.sessionId
    && a.target.chatId === b.target.chatId
    && a.entries.length === b.entries.length
    && a.entries.every((entry, index) => entryRefEquals(entry, b.entries[index]!));
}

function entryRefEquals(a: VcMeetingHubDeliveryEntryRef, b: VcMeetingHubDeliveryEntryRef): boolean {
  return a.deliverySeq === b.deliverySeq
    && a.ingestSeq === b.ingestSeq
    && a.itemVersionKey === b.itemVersionKey
    && a.contentHash === b.contentHash
    && a.kind === b.kind
    && a.controlKey === b.controlKey
    && a.renderedTextHash === b.renderedTextHash
    && a.gap?.occurredFromMs === b.gap?.occurredFromMs
    && a.gap?.occurredToMs === b.gap?.occurredToMs
    && a.gap?.missingItemVersionKey === b.gap?.missingItemVersionKey
    && a.gap?.originalContentHash === b.gap?.originalContentHash
    && a.gap?.reason === b.gap?.reason;
}

function ackIdentityEquals(a: VcMeetingHubAckedAssignment, b: VcMeetingHubFreezeInput): boolean {
  return a.deliveryKey === b.deliveryKey
    && a.inputHash === b.inputHash
    && a.fromSeq === b.fromSeq
    && a.toSeq === b.toSeq
    && a.final === b.final;
}

export function freezeVcMeetingHubDeliveryAssignment(
  dataDir: string,
  input: VcMeetingHubFreezeInput,
  now = Date.now(),
): VcMeetingHubFreezeResult {
  if (!freezeInputValid(input) || !isFiniteNonNegative(now)) {
    return { kind: 'conflict', reason: 'invalid' };
  }
  return mutateState<VcMeetingHubFreezeResult>(dataDir, input.listenerAppId, input.meetingId, now, (state) => {
    if (!state) return { result: { kind: 'conflict' as const, reason: 'unknown_meeting' as const } };
    if (state.close.phase === 'closed') {
      return { result: { kind: 'conflict' as const, reason: 'meeting_closed' as const } };
    }
    if (input.ownerEpoch < state.owner.ownerEpoch) {
      return { result: { kind: 'conflict' as const, reason: 'stale_owner_epoch' as const } };
    }
    if (input.ownerEpoch > state.owner.ownerEpoch) {
      return { result: { kind: 'conflict' as const, reason: 'owner_epoch_not_registered' as const } };
    }
    if (input.ownerBootId !== state.owner.ownerBootId) {
      return { result: { kind: 'conflict' as const, reason: 'stale_owner_boot' as const } };
    }
    const memberState = state.members[input.memberId];
    if (!memberState) return { result: { kind: 'conflict' as const, reason: 'unknown_member' as const } };
    if (input.memberEpoch !== memberState.maxKnownEpoch) {
      return { result: { kind: 'conflict' as const, reason: 'stale_member_epoch' as const } };
    }
    const member = memberState.epochs[String(input.memberEpoch)];
    if (!member) return { result: { kind: 'conflict' as const, reason: 'unknown_member' as const } };
    if (input.membershipGeneration < memberState.generationHighWater) {
      return { result: { kind: 'conflict' as const, reason: 'stale_membership_generation' as const } };
    }
    if (input.membershipGeneration > memberState.generationHighWater) {
      return { result: { kind: 'conflict' as const, reason: 'membership_generation_not_registered' as const } };
    }
    if (member.status === 'paused') {
      return { result: { kind: 'conflict' as const, reason: 'membership_paused' as const } };
    }
    if (member.status === 'removed') {
      return { result: { kind: 'conflict' as const, reason: 'membership_removed' as const } };
    }
    if (input.target.sessionId !== member.receiverSessionId || input.target.chatId !== member.outputChatId) {
      return { result: { kind: 'conflict' as const, reason: 'target_mismatch' as const } };
    }

    if (member.inFlight) {
      if (assignmentMetadataEquals(member.inFlight, input)) {
        return {
          result: {
            kind: 'existing' as const,
            assignment: member.inFlight,
            senderAckedThrough: member.senderAckedThrough,
          },
        };
      }
      return {
        result: {
          kind: 'conflict' as const,
          reason: member.inFlight.deliveryKey === input.deliveryKey
            ? 'assignment_conflict' as const
            : 'delivery_in_flight' as const,
          activeDeliveryKey: member.inFlight.deliveryKey,
        },
      };
    }
    if (member.lastAckedAssignment && ackIdentityEquals(member.lastAckedAssignment, input)) {
      return {
        result: {
          kind: 'already_acked' as const,
          ack: member.lastAckedAssignment,
          senderAckedThrough: member.senderAckedThrough,
        },
      };
    }
    if (member.finalAssignedSeq !== undefined
      && input.entries.some(entry => entry.kind === 'item' || entry.kind === 'gap')) {
      return { result: { kind: 'conflict' as const, reason: 'stream_finalized' as const } };
    }
    for (const entry of input.entries) {
      if (entry.kind !== 'item') continue;
      const priorAck = member.ackedItemVersions.find(item => item.itemVersionKey === entry.itemVersionKey);
      if (!priorAck) continue;
      const sameIdentity = priorAck.ingestSeq === entry.ingestSeq
        && priorAck.contentHash === entry.contentHash;
      return {
        result: {
          kind: 'conflict' as const,
          reason: sameIdentity ? 'item_already_acked' as const : 'acked_item_conflict' as const,
        },
      };
    }
    const expected = member.senderAckedThrough + 1;
    if (input.fromSeq <= member.senderAckedThrough) {
      return {
        result: {
          kind: 'conflict' as const,
          reason: 'delivery_partial_overlap' as const,
          expectedFromSeq: expected,
        },
      };
    }
    if (input.fromSeq > expected) {
      return {
        result: { kind: 'conflict' as const, reason: 'delivery_gap' as const, expectedFromSeq: expected },
      };
    }
    if (input.final && member.finalAssignedSeq !== undefined) {
      return { result: { kind: 'conflict' as const, reason: 'final_already_assigned' as const } };
    }

    const assignment: VcMeetingHubFrozenAssignment = {
      deliveryKey: input.deliveryKey,
      inputHash: input.inputHash,
      ownerBootId: input.ownerBootId,
      ownerEpoch: input.ownerEpoch,
      membershipGeneration: input.membershipGeneration,
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      batchId: input.batchId,
      final: input.final,
      entries: input.entries.map((entry) => ({
        deliverySeq: entry.deliverySeq,
        ...(entry.ingestSeq !== undefined ? { ingestSeq: entry.ingestSeq } : {}),
        ...(entry.itemVersionKey !== undefined ? { itemVersionKey: entry.itemVersionKey } : {}),
        ...(entry.contentHash !== undefined ? { contentHash: entry.contentHash } : {}),
        kind: entry.kind,
        ...(entry.controlKey !== undefined ? { controlKey: entry.controlKey } : {}),
        ...(entry.gap !== undefined ? { gap: { ...entry.gap } } : {}),
        renderedTextHash: entry.renderedTextHash,
      })),
      renderContext: {
        timeZone: input.renderContext.timeZone,
        authorizedActorIds: [...input.renderContext.authorizedActorIds],
      },
      instructionVersion: input.instructionVersion,
      target: { sessionId: input.target.sessionId, chatId: input.target.chatId },
      createdAt: now,
      updatedAt: now,
    };
    member.inFlight = assignment;
    member.nextDeliverySeq = input.toSeq + 1;
    if (input.final) member.finalAssignedSeq = input.toSeq;
    member.updatedAt = now;
    return {
      result: { kind: 'frozen' as const, assignment, senderAckedThrough: member.senderAckedThrough },
      write: state,
    };
  });
}

function observationInputValid(input: VcMeetingHubReceiptObservationInput): boolean {
  return isRecord(input)
    && hasOnlyKeys(input, [
      'listenerAppId',
      'meetingId',
      'memberId',
      'memberEpoch',
      'ownerBootId',
      'ownerEpoch',
      'deliveryKey',
      'inputHash',
      'fromSeq',
      'toSeq',
      'status',
      'receiverCommittedThrough',
    ])
    && isNonEmpty(input.listenerAppId)
    && isNonEmpty(input.meetingId)
    && isNonEmpty(input.memberId)
    && isPositiveInteger(input.memberEpoch)
    && isNonEmpty(input.ownerBootId)
    && isPositiveInteger(input.ownerEpoch)
    && isDeliveryKey(input.deliveryKey)
    && isHash(input.inputHash)
    && isPositiveInteger(input.fromSeq)
    && isPositiveInteger(input.toSeq)
    && input.fromSeq <= input.toSeq
    && (['accepted', 'dispatched', 'completed', 'duplicate', 'failed_retryable', 'failed_terminal', 'ambiguous'] as const)
      .includes(input.status)
    && isNonNegativeInteger(input.receiverCommittedThrough);
}

function observationMatchesAck(
  input: VcMeetingHubReceiptObservationInput,
  ack: VcMeetingHubAckedAssignment,
): boolean {
  return input.deliveryKey === ack.deliveryKey
    && input.inputHash === ack.inputHash
    && input.fromSeq === ack.fromSeq
    && input.toSeq === ack.toSeq;
}

export function observeVcMeetingHubReceiverReceipt(
  dataDir: string,
  input: VcMeetingHubReceiptObservationInput,
  now = Date.now(),
): VcMeetingHubObserveResult {
  if (!observationInputValid(input) || !isFiniteNonNegative(now)) {
    return { ok: false, reason: 'invalid' };
  }
  return mutateState<VcMeetingHubObserveResult>(dataDir, input.listenerAppId, input.meetingId, now, (state) => {
    if (!state) return { result: { ok: false as const, reason: 'unknown_meeting' as const } };
    if (input.ownerEpoch < state.owner.ownerEpoch) {
      return { result: { ok: false as const, reason: 'stale_owner_epoch' as const } };
    }
    if (input.ownerEpoch > state.owner.ownerEpoch) {
      return { result: { ok: false as const, reason: 'owner_epoch_not_registered' as const } };
    }
    if (input.ownerBootId !== state.owner.ownerBootId) {
      return { result: { ok: false as const, reason: 'stale_owner_boot' as const } };
    }
    const memberState = state.members[input.memberId];
    if (!memberState) return { result: { ok: false as const, reason: 'unknown_member' as const } };
    if (input.memberEpoch !== memberState.maxKnownEpoch) {
      return { result: { ok: false as const, reason: 'stale_member_epoch' as const } };
    }
    const member = memberState.epochs[String(input.memberEpoch)];
    if (!member) return { result: { ok: false as const, reason: 'unknown_member' as const } };

    if (!member.inFlight) {
      if (member.lastAckedAssignment
        && observationMatchesAck(input, member.lastAckedAssignment)
        && (input.status === 'completed' || input.status === 'duplicate')
        && input.receiverCommittedThrough >= input.toSeq) {
        return {
          result: {
            ok: true as const,
            kind: 'already_acked' as const,
            senderAckedThrough: member.senderAckedThrough,
            ack: member.lastAckedAssignment,
          },
        };
      }
      return { result: { ok: false as const, reason: 'no_in_flight' as const } };
    }
    const assignment = member.inFlight;
    if (input.deliveryKey !== assignment.deliveryKey) {
      return { result: { ok: false as const, reason: 'delivery_key_mismatch' as const } };
    }
    if (input.inputHash !== assignment.inputHash) {
      return { result: { ok: false as const, reason: 'input_hash_mismatch' as const } };
    }
    if (input.fromSeq !== assignment.fromSeq || input.toSeq !== assignment.toSeq) {
      return { result: { ok: false as const, reason: 'range_mismatch' as const } };
    }
    if (input.receiverCommittedThrough < member.senderAckedThrough) {
      return { result: { ok: false as const, reason: 'receiver_cursor_regression' as const } };
    }
    const terminal = input.status === 'completed' || input.status === 'duplicate';
    if (terminal && input.receiverCommittedThrough < assignment.toSeq) {
      return { result: { ok: false as const, reason: 'receiver_cursor_short' as const } };
    }
    if (!terminal) {
      assignment.lastObservation = {
        status: input.status,
        receiverCommittedThrough: input.receiverCommittedThrough,
        observedAt: now,
      };
      assignment.updatedAt = now;
      member.updatedAt = now;
      return {
        result: {
          ok: true as const,
          kind: 'observed' as const,
          senderAckedThrough: member.senderAckedThrough,
          assignment,
        },
        write: state,
      };
    }

    const ack: VcMeetingHubAckedAssignment = {
      deliveryKey: assignment.deliveryKey,
      inputHash: assignment.inputHash,
      fromSeq: assignment.fromSeq,
      toSeq: assignment.toSeq,
      final: assignment.final,
      receiverCommittedThrough: input.receiverCommittedThrough,
      ackedAt: now,
    };
    const newlyAckedItems: VcMeetingHubAckedItemVersion[] = [];
    for (const entry of assignment.entries) {
      if (entry.kind !== 'item') continue;
      // validAssignment guarantees these fields for item entries. Keep the
      // runtime guard so a future schema change cannot silently weaken the
      // durable per-member dedup index.
      if (entry.ingestSeq === undefined || entry.itemVersionKey === undefined || entry.contentHash === undefined) {
        return { result: { ok: false as const, reason: 'acked_item_conflict' as const } };
      }
      const existing = member.ackedItemVersions.find(item => item.itemVersionKey === entry.itemVersionKey);
      if (existing) {
        if (existing.ingestSeq !== entry.ingestSeq || existing.contentHash !== entry.contentHash) {
          return { result: { ok: false as const, reason: 'acked_item_conflict' as const } };
        }
        continue;
      }
      const pendingDuplicate = newlyAckedItems.find(item => item.itemVersionKey === entry.itemVersionKey);
      if (pendingDuplicate) {
        return { result: { ok: false as const, reason: 'acked_item_conflict' as const } };
      }
      newlyAckedItems.push({
        ingestSeq: entry.ingestSeq,
        itemVersionKey: entry.itemVersionKey,
        contentHash: entry.contentHash,
        deliverySeq: entry.deliverySeq,
        ackedAt: now,
      });
    }
    member.senderAckedThrough = assignment.toSeq;
    member.nextDeliverySeq = assignment.toSeq + 1;
    member.lastAckedAssignment = ack;
    member.ackedItemVersions.push(...newlyAckedItems);
    delete member.inFlight;
    if (assignment.final) member.finalAckedAt = now;
    member.updatedAt = now;
    return {
      result: { ok: true as const, kind: 'acked' as const, senderAckedThrough: member.senderAckedThrough, ack },
      write: state,
    };
  });
}

export function getVcMeetingHubMember(
  dataDir: string,
  key: VcMeetingHubMemberKey,
): VcMeetingHubMemberRecord | undefined {
  return readState(dataDir, key.listenerAppId, key.meetingId)
    ?.members[key.memberId]?.epochs[String(key.memberEpoch)];
}

export function getVcMeetingHubDeliveryAssignment(
  dataDir: string,
  key: VcMeetingHubMemberKey,
): VcMeetingHubFrozenAssignment | undefined {
  return getVcMeetingHubMember(dataDir, key)?.inFlight;
}

export function listVcMeetingHubMembers(
  dataDir: string,
  scope: { listenerAppId: string; meetingId: string },
): VcMeetingHubMemberRecord[] {
  const state = readState(dataDir, scope.listenerAppId, scope.meetingId);
  if (!state) return [];
  const records = Object.values(state.members).flatMap((member) => Object.values(member.epochs));
  return records.sort((a, b) => a.memberId.localeCompare(b.memberId) || a.memberEpoch - b.memberEpoch);
}

export function getVcMeetingHubCloseState(
  dataDir: string,
  scope: { listenerAppId: string; meetingId: string },
): VcMeetingHubCloseRecord | undefined {
  return readState(dataDir, scope.listenerAppId, scope.meetingId)?.close;
}

const CLOSE_PHASE_ORDER: Record<VcMeetingHubClosePhase, number> = {
  active: 0,
  data_closing: 1,
  finalizing: 2,
  closed: 3,
};

export function updateVcMeetingHubCloseState(
  dataDir: string,
  input: VcMeetingHubCloseInput,
  now = Date.now(),
): VcMeetingHubCloseResult {
  if (!isRecord(input)
    || !hasOnlyKeys(input, [
      'listenerAppId',
      'meetingId',
      'ownerBootId',
      'ownerEpoch',
      'phase',
      'finalizationDeadlineAt',
      'reason',
    ])
    || !isNonEmpty(input.listenerAppId)
    || !isNonEmpty(input.meetingId)
    || !isNonEmpty(input.ownerBootId)
    || !isPositiveInteger(input.ownerEpoch)
    || !(Object.keys(CLOSE_PHASE_ORDER) as VcMeetingHubClosePhase[]).includes(input.phase)
    || (input.finalizationDeadlineAt !== undefined && !isFiniteNonNegative(input.finalizationDeadlineAt))
    || (input.reason !== undefined && !isNonEmpty(input.reason))
    || !isFiniteNonNegative(now)) return { ok: false, reason: 'invalid' };

  return mutateState<VcMeetingHubCloseResult>(dataDir, input.listenerAppId, input.meetingId, now, (state) => {
    if (!state) return { result: { ok: false as const, reason: 'unknown_meeting' as const } };
    if (input.ownerEpoch < state.owner.ownerEpoch) {
      return { result: { ok: false as const, reason: 'stale_owner_epoch' as const } };
    }
    if (input.ownerEpoch > state.owner.ownerEpoch) {
      return { result: { ok: false as const, reason: 'owner_epoch_not_registered' as const } };
    }
    if (input.ownerBootId !== state.owner.ownerBootId) {
      return { result: { ok: false as const, reason: 'stale_owner_boot' as const } };
    }
    if (CLOSE_PHASE_ORDER[input.phase] < CLOSE_PHASE_ORDER[state.close.phase]) {
      return { result: { ok: false as const, reason: 'close_phase_regression' as const } };
    }
    if (CLOSE_PHASE_ORDER[input.phase] > CLOSE_PHASE_ORDER[state.close.phase] + 1) {
      return { result: { ok: false as const, reason: 'close_phase_jump' as const } };
    }
    if (input.phase === 'closed') {
      for (const memberState of Object.values(state.members)) {
        const member = memberState.epochs[String(memberState.maxKnownEpoch)];
        if (!member || member.status === 'removed') continue;
        if (member.inFlight) {
          return { result: { ok: false as const, reason: 'in_flight_not_settled' as const } };
        }
        if (member.finalAckedAt === undefined) {
          return { result: { ok: false as const, reason: 'final_not_acked' as const } };
        }
      }
    }
    const close: VcMeetingHubCloseRecord = {
      phase: input.phase,
      ...(input.finalizationDeadlineAt !== undefined
        ? { finalizationDeadlineAt: input.finalizationDeadlineAt }
        : state.close.finalizationDeadlineAt !== undefined
          ? { finalizationDeadlineAt: state.close.finalizationDeadlineAt }
          : {}),
      ...(input.phase === 'closed' ? { closedAt: state.close.closedAt ?? now } : {}),
      ...(input.reason !== undefined
        ? { reason: input.reason }
        : state.close.reason !== undefined
          ? { reason: state.close.reason }
          : {}),
      updatedAt: now,
    };
    state.close = close;
    return { result: { ok: true as const, close }, write: state };
  });
}
