import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withFileLockSync } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import { normalizeVcMeetingProfileInstructions } from './vc-meeting-profile-instructions.js';
import type {
  VcMeetingConsumerManagedSink,
  VcMeetingConsumerProfileFilter,
  VcMeetingConsumerResponseMode,
} from '../types.js';
import type { VcMeetingActivityType } from '../vc-agent/types.js';

const RUNTIME_SCHEMA_VERSION = 3 as const;

export type VcMeetingRuntimeSelectedAgentStatus =
  | 'activating'
  | 'active'
  | 'failed'
  | 'paused';

export interface VcMeetingRuntimeSelectedAgent {
  profileId: string;
  memberId: string;
  agentAppId: string;
  label?: string;
  role: string;
  /** Frozen role instructions for this meeting membership snapshot. */
  instructions?: string;
  status: VcMeetingRuntimeSelectedAgentStatus;
  /** Last activation failure shown on the profile card. Cleared on retry/success. */
  activationError?: string;
  filter?: VcMeetingConsumerProfileFilter;
  responseMode: VcMeetingConsumerResponseMode;
  capabilities: string[];
  ownedSinks: VcMeetingConsumerManagedSink[];
  /** Immutable P0/P1 delivery semantics snapshot; optional for new records until hub activation. */
  deliveryProfileHash?: string;
}

export const VC_MEETING_RUNTIME_LEGACY_PROFILE_ID = 'legacy-generalist';
export const VC_MEETING_RUNTIME_LEGACY_MEMBER_ID = 'meeting_assistant';
export const VC_MEETING_RUNTIME_LEGACY_ROLE = 'meeting_assistant';
export const VC_MEETING_RUNTIME_LEGACY_PROFILE_HASH = `sha256:${createHash('sha256')
  .update(JSON.stringify({ role: VC_MEETING_RUNTIME_LEGACY_ROLE, filter: 'all' }), 'utf8')
  .digest('hex')}`;

export interface VcMeetingRuntimeSessionRecord {
  schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
  larkAppId: string;
  meeting: {
    id: string;
    meetingNo?: string;
    topic?: string;
  };
  listenerChatId: string;
  attentionTargetOpenId?: string;
  consumerMode?: 'pending' | 'listenOnly' | 'agent';
  selectedAgents: VcMeetingRuntimeSelectedAgent[];
  /** @deprecated Derived only when selectedAgents contains exactly one entry. */
  selectedAgentAppId?: string;
  /** @deprecated Derived only when selectedAgents contains exactly one entry. */
  selectedAgentLabel?: string;
  /** @deprecated Derived only when selectedAgents contains exactly one entry. */
  consumerPaused?: boolean;
  consumerClosePhase?: 'data_closing' | 'finalizing';
  consumerFinalizationDeadlineAt?: number;
  /** Fixed hard-stop for post-deadline receiver reconciliation. It is
   * persisted so daemon restarts can never extend the recovery window. */
  consumerCloseResolutionDeadlineAt?: number;
  textOutputPolicy?: VcMeetingOutputPolicy;
  voiceOutputPolicy?: VcMeetingOutputPolicy;
  syncIntervalMs?: number;
  consumerSelectionExpiresAt?: number;
  consumerCardMessageId?: string;
  /** Durable fence set when the listener bot's own participant_left event is observed. */
  listenerPresenceStale?: boolean;
  listenerPresenceChangedAtMs?: number;
  listenerPresenceGeneration?: number;
  /** Keeps an already-sent recovery card safely actionable across daemon restarts. */
  listenerRejoinNonce?: string;
  listenerRejoinCardMessageId?: string;
  temporaryInstructionOpenIds?: string[];
  temporaryInstructionUnionIds?: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export type VcMeetingOutputPolicy = 'deny' | 'approval' | 'allow';

const FILE_NAME = 'vc-meeting-runtime-sessions.json';
const ENDED_TOMBSTONE_FILE_NAME = 'vc-meeting-ended-tombstones.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ENDED_TOMBSTONE_TTL_MS = 30 * 60 * 1000;

interface VcMeetingEndedTombstoneRecord {
  larkAppId: string;
  meetingId: string;
  endedAt: number;
  expiresAt: number;
}

type ListenerAgentIndexCache = {
  fp: string;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  byListenerAgent: Map<string, VcMeetingRuntimeSessionRecord[]>;
};

let listenerAgentIndexCache: ListenerAgentIndexCache | undefined;

function filePath(dataDir: string): string {
  return join(dataDir, FILE_NAME);
}

function endedTombstoneFilePath(dataDir: string): string {
  return join(dataDir, ENDED_TOMBSTONE_FILE_NAME);
}

function sessionKey(larkAppId: string, meetingId: string): string {
  return `${larkAppId}:${meetingId}`;
}

function listenerAgentIndexKey(listenerChatId: string, selectedAgentAppId: string): string {
  return `${selectedAgentAppId}:${listenerChatId}`;
}

function invalidateListenerAgentIndex(): void {
  listenerAgentIndexCache = undefined;
}

function ensureLockParent(fp: string): void {
  const dir = dirname(fp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertNoQuarantinedEvidence(fp: string, label: string): void {
  const prefix = `${basename(fp)}.corrupt.`;
  let quarantined = false;
  try {
    quarantined = readdirSync(dirname(fp)).some(name => name.startsWith(prefix));
  } catch {
    // A genuinely absent directory/store is initializable.
  }
  if (quarantined) {
    throw new Error(`vc meeting ${label} store has quarantined evidence for ${fp}`);
  }
}

function quarantineCorruptStore(fp: string, label: string, err: unknown): never {
  const aside = `${fp}.corrupt.${Date.now()}.${process.pid}`;
  try { renameSync(fp, aside); } catch { /* another process may already have quarantined it */ }
  invalidateListenerAgentIndex();
  logger.warn(
    `[vc-meeting-runtime-store] corrupt ${label} store at ${fp}, moved aside to ${aside}: `
    + `${err instanceof Error ? err.message : String(err)}`,
  );
  throw new Error(`vc meeting ${label} store is corrupt: ${aside}`);
}

function readStore(dataDir: string): Record<string, VcMeetingRuntimeSessionRecord> {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) {
    assertNoQuarantinedEvidence(fp, 'runtime session');
    return {};
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(fp, 'utf-8'));
    if (!isRecord(raw)) throw new Error('store root must be an object');
    const out = Object.create(null) as Record<string, VcMeetingRuntimeSessionRecord>;
    for (const [key, value] of Object.entries(raw)) {
      const record = normalizeRecord(value);
      if (!record) throw new Error(`invalid runtime session record at ${key}`);
      if (key !== sessionKey(record.larkAppId, record.meeting.id)) {
        throw new Error(`runtime session key mismatch at ${key}`);
      }
      out[key] = record;
    }
    return out;
  } catch (err) {
    return quarantineCorruptStore(fp, 'runtime session', err);
  }
}

function readStoreForAccess(dataDir: string): Record<string, VcMeetingRuntimeSessionRecord> {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) {
    assertNoQuarantinedEvidence(fp, 'runtime session');
    return {};
  }
  ensureLockParent(fp);
  return withFileLockSync(fp, () => readStore(dataDir));
}

function writeStore(dataDir: string, store: Record<string, VcMeetingRuntimeSessionRecord>): void {
  const fp = filePath(dataDir);
  const dir = dirname(fp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, fp);
  invalidateListenerAgentIndex();
}

function readEndedTombstoneStore(dataDir: string): Record<string, VcMeetingEndedTombstoneRecord> {
  const fp = endedTombstoneFilePath(dataDir);
  if (!existsSync(fp)) {
    assertNoQuarantinedEvidence(fp, 'ended tombstone');
    return {};
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(fp, 'utf-8'));
    if (!isRecord(raw)) throw new Error('store root must be an object');
    const out = Object.create(null) as Record<string, VcMeetingEndedTombstoneRecord>;
    for (const [key, value] of Object.entries(raw)) {
      const record = normalizeEndedTombstoneRecord(value);
      if (!record) throw new Error(`invalid ended tombstone record at ${key}`);
      if (key !== sessionKey(record.larkAppId, record.meetingId)) {
        throw new Error(`ended tombstone key mismatch at ${key}`);
      }
      out[key] = record;
    }
    return out;
  } catch (err) {
    return quarantineCorruptStore(fp, 'ended tombstone', err);
  }
}

function readEndedTombstoneStoreForAccess(
  dataDir: string,
): Record<string, VcMeetingEndedTombstoneRecord> {
  const fp = endedTombstoneFilePath(dataDir);
  if (!existsSync(fp)) {
    assertNoQuarantinedEvidence(fp, 'ended tombstone');
    return {};
  }
  ensureLockParent(fp);
  return withFileLockSync(fp, () => readEndedTombstoneStore(dataDir));
}

function writeEndedTombstoneStore(dataDir: string, store: Record<string, VcMeetingEndedTombstoneRecord>): void {
  const fp = endedTombstoneFilePath(dataDir);
  const dir = dirname(fp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, fp);
}

const SAFE_RUNTIME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_RUNTIME_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const RUNTIME_ACTIVITY_TYPES = [
  'participant_joined',
  'participant_left',
  'chat_received',
  'transcript_received',
  'magic_share_started',
  'magic_share_ended',
] as const satisfies readonly VcMeetingActivityType[];
const RUNTIME_OWNED_SINKS = ['meeting_text', 'meeting_voice'] as const satisfies readonly VcMeetingConsumerManagedSink[];
const RUNTIME_LISTENER_OUTPUT_CAPABILITY = 'listener.output.request';
const DELIVERY_PROFILE_HASH_RE = /^sha256:[0-9a-f]{64}$/;

function isSafeRuntimeId(value: unknown): value is string {
  return typeof value === 'string'
    && SAFE_RUNTIME_ID_RE.test(value)
    && !RESERVED_RUNTIME_IDS.has(value);
}

function normalizeUniqueStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return undefined;
    const normalized = item.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

type NormalizeFilterResult =
  | { ok: true; filter?: VcMeetingConsumerProfileFilter }
  | { ok: false };

function normalizeSelectedAgentFilter(value: unknown): NormalizeFilterResult {
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const filter = value as Record<string, unknown>;
  if (Object.keys(filter).some(key => key !== 'activityTypes')) return { ok: false };
  if (filter.activityTypes === undefined) return { ok: true };
  const activityTypes = normalizeUniqueStringList(filter.activityTypes);
  if (!activityTypes
    || activityTypes.some(type => !(RUNTIME_ACTIVITY_TYPES as readonly string[]).includes(type))) {
    return { ok: false };
  }
  return activityTypes.length > 0
    ? { ok: true, filter: { activityTypes: activityTypes as VcMeetingActivityType[] } }
    : { ok: true };
}

type NormalizeSelectedAgentResult =
  | { ok: true; agent: VcMeetingRuntimeSelectedAgent }
  | { ok: false };

function normalizeSelectedAgent(value: unknown): NormalizeSelectedAgentResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const agent = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'profileId',
    'memberId',
    'agentAppId',
    'label',
    'role',
    'instructions',
    'status',
    'activationError',
    'filter',
    'responseMode',
    'capabilities',
    'ownedSinks',
    'deliveryProfileHash',
  ]);
  if (Object.keys(agent).some(key => !allowedKeys.has(key))) return { ok: false };
  if (!isSafeRuntimeId(agent.profileId) || !isSafeRuntimeId(agent.memberId)) return { ok: false };
  if (typeof agent.agentAppId !== 'string' || !agent.agentAppId.trim()) return { ok: false };
  if (typeof agent.role !== 'string' || !agent.role.trim()) return { ok: false };
  const normalizedInstructions = normalizeVcMeetingProfileInstructions(agent.instructions);
  if (!normalizedInstructions.ok) return { ok: false };
  if (agent.label !== undefined && (typeof agent.label !== 'string' || !agent.label.trim())) return { ok: false };
  if (agent.activationError !== undefined
    && (typeof agent.activationError !== 'string' || !agent.activationError.trim())) return { ok: false };
  if (!(['activating', 'active', 'failed', 'paused'] as const).includes(
    agent.status as VcMeetingRuntimeSelectedAgentStatus,
  )) return { ok: false };
  if (agent.responseMode !== 'silent' && agent.responseMode !== 'listener_thread') return { ok: false };
  const capabilities = normalizeUniqueStringList(agent.capabilities);
  const ownedSinks = normalizeUniqueStringList(agent.ownedSinks);
  if (!capabilities || !ownedSinks) return { ok: false };
  if (ownedSinks.some(sink => !(RUNTIME_OWNED_SINKS as readonly string[]).includes(sink))) return { ok: false };
  if (ownedSinks.length > 0 && !capabilities.includes('meeting.output.request')) return { ok: false };
  const filter = normalizeSelectedAgentFilter(agent.filter);
  if (!filter.ok) return { ok: false };
  if (agent.deliveryProfileHash !== undefined
    && (typeof agent.deliveryProfileHash !== 'string'
      || !DELIVERY_PROFILE_HASH_RE.test(agent.deliveryProfileHash))) return { ok: false };
  return {
    ok: true,
    agent: {
      profileId: agent.profileId,
      memberId: agent.memberId,
      agentAppId: agent.agentAppId.trim(),
      ...(typeof agent.label === 'string' ? { label: agent.label.trim() } : {}),
      role: agent.role.trim(),
      ...(normalizedInstructions.instructions
        ? { instructions: normalizedInstructions.instructions }
        : {}),
      status: agent.status as VcMeetingRuntimeSelectedAgentStatus,
      ...(typeof agent.activationError === 'string'
        ? { activationError: agent.activationError.trim().slice(0, 500) }
        : {}),
      ...(filter.filter ? { filter: filter.filter } : {}),
      responseMode: agent.responseMode,
      capabilities,
      ownedSinks: ownedSinks as VcMeetingConsumerManagedSink[],
      ...(typeof agent.deliveryProfileHash === 'string'
        ? { deliveryProfileHash: agent.deliveryProfileHash }
        : {}),
    },
  };
}

type NormalizeSelectedAgentsResult =
  | { ok: true; agents: VcMeetingRuntimeSelectedAgent[] }
  | { ok: false };

function normalizeSelectedAgents(value: unknown): NormalizeSelectedAgentsResult {
  if (!Array.isArray(value)) return { ok: false };
  const agents: VcMeetingRuntimeSelectedAgent[] = [];
  const profileIds = new Set<string>();
  const memberIds = new Set<string>();
  const agentAppIds = new Set<string>();
  const ownedSinks = new Set<VcMeetingConsumerManagedSink>();
  let listenerThreadMemberId: string | undefined;
  for (const item of value) {
    const normalized = normalizeSelectedAgent(item);
    if (!normalized.ok) return { ok: false };
    const agent = normalized.agent;
    if (profileIds.has(agent.profileId)
      || memberIds.has(agent.memberId)
      || agentAppIds.has(agent.agentAppId)) return { ok: false };
    profileIds.add(agent.profileId);
    memberIds.add(agent.memberId);
    agentAppIds.add(agent.agentAppId);
    for (const sink of agent.ownedSinks) {
      if (ownedSinks.has(sink)) return { ok: false };
      ownedSinks.add(sink);
    }
    if (agent.responseMode === 'listener_thread') {
      if (listenerThreadMemberId) return { ok: false };
      listenerThreadMemberId = agent.memberId;
    }
    agents.push(agent);
  }

  const legacySingleton = agents.length === 1
    && agents[0]?.profileId === VC_MEETING_RUNTIME_LEGACY_PROFILE_ID
    && agents[0].memberId === VC_MEETING_RUNTIME_LEGACY_MEMBER_ID
    && agents[0].role === VC_MEETING_RUNTIME_LEGACY_ROLE;
  for (const agent of agents) {
    if (agent.responseMode === 'listener_thread'
      && !legacySingleton
      && !agent.capabilities.includes(RUNTIME_LISTENER_OUTPUT_CAPABILITY)) return { ok: false };
  }
  return { ok: true, agents };
}

function legacySelectedAgent(value: Record<string, unknown>): VcMeetingRuntimeSelectedAgent | undefined {
  if (typeof value.selectedAgentAppId !== 'string' || !value.selectedAgentAppId.trim()) return undefined;
  return {
    profileId: VC_MEETING_RUNTIME_LEGACY_PROFILE_ID,
    memberId: VC_MEETING_RUNTIME_LEGACY_MEMBER_ID,
    agentAppId: value.selectedAgentAppId.trim(),
    ...(typeof value.selectedAgentLabel === 'string' && value.selectedAgentLabel.trim()
      ? { label: value.selectedAgentLabel.trim() }
      : {}),
    role: VC_MEETING_RUNTIME_LEGACY_ROLE,
    status: value.consumerPaused === true ? 'paused' : 'active',
    responseMode: 'listener_thread',
    capabilities: ['meeting.read', 'meeting.output.request'],
    ownedSinks: ['meeting_text', 'meeting_voice'],
    deliveryProfileHash: VC_MEETING_RUNTIME_LEGACY_PROFILE_HASH,
  };
}

function singularSelectionAliases(
  selectedAgents: readonly VcMeetingRuntimeSelectedAgent[],
): Pick<VcMeetingRuntimeSessionRecord, 'selectedAgentAppId' | 'selectedAgentLabel' | 'consumerPaused'> {
  if (selectedAgents.length !== 1) return {};
  const selected = selectedAgents[0]!;
  return {
    selectedAgentAppId: selected.agentAppId,
    ...(selected.label ? { selectedAgentLabel: selected.label } : {}),
    // The legacy boolean cannot represent activating/failed. Fail closed so a
    // P0 reader never mistakes a non-active v2 member for an injectable one.
    consumerPaused: selected.status !== 'active',
  };
}

function isValidStoredTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasOwnField(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isCanonicalStoredIdList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  const normalized = normalizeIdList(value);
  return normalized.length === value.length
    && normalized.every((id, index) => id === value[index]);
}

function hasValidCurrentOptionalFields(r: Record<string, unknown>): boolean {
  if (hasOwnField(r, 'consumerMode')
    && r.consumerMode !== 'pending'
    && r.consumerMode !== 'listenOnly'
    && r.consumerMode !== 'agent') return false;
  if (hasOwnField(r, 'consumerClosePhase')
    && r.consumerClosePhase !== 'data_closing'
    && r.consumerClosePhase !== 'finalizing') return false;
  if (hasOwnField(r, 'textOutputPolicy') && !isOutputPolicy(r.textOutputPolicy)) return false;
  if (hasOwnField(r, 'voiceOutputPolicy') && !isOutputPolicy(r.voiceOutputPolicy)) return false;
  for (const key of [
    'consumerFinalizationDeadlineAt',
    'consumerCloseResolutionDeadlineAt',
    'consumerSelectionExpiresAt',
    'listenerPresenceChangedAtMs',
  ] as const) {
    if (hasOwnField(r, key) && !isValidStoredTimestamp(r[key])) return false;
  }
  if (hasOwnField(r, 'syncIntervalMs')
    && (typeof r.syncIntervalMs !== 'number'
      || !Number.isFinite(r.syncIntervalMs)
      || r.syncIntervalMs <= 0)) return false;
  if (hasOwnField(r, 'listenerPresenceStale') && typeof r.listenerPresenceStale !== 'boolean') return false;
  if (hasOwnField(r, 'listenerPresenceGeneration')
    && (typeof r.listenerPresenceGeneration !== 'number'
      || !Number.isInteger(r.listenerPresenceGeneration)
      || r.listenerPresenceGeneration < 0)) return false;
  for (const key of [
    'attentionTargetOpenId',
    'consumerCardMessageId',
    'listenerRejoinNonce',
    'listenerRejoinCardMessageId',
  ] as const) {
    if (hasOwnField(r, key) && (typeof r[key] !== 'string' || !r[key].trim())) return false;
  }
  for (const key of ['temporaryInstructionOpenIds', 'temporaryInstructionUnionIds'] as const) {
    if (hasOwnField(r, key) && !isCanonicalStoredIdList(r[key])) return false;
  }
  return true;
}

function hasValidCurrentMeetingFields(meeting: Record<string, unknown>): boolean {
  for (const key of ['meetingNo', 'topic'] as const) {
    if (hasOwnField(meeting, key)
      && (typeof meeting[key] !== 'string' || !meeting[key].trim())) return false;
  }
  return true;
}

function normalizeRecord(value: unknown): VcMeetingRuntimeSessionRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (r.schemaVersion !== undefined
    && r.schemaVersion !== 1
    && r.schemaVersion !== 2
    && r.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
    return undefined;
  }
  // Records written before schemaVersion was introduced have the v1 shape.
  // Only that legacy shape may recover selection from the singular aliases;
  // v2/v3 selectedAgents is authoritative and therefore required.
  const sourceSchemaVersion = r.schemaVersion ?? 1;
  const meeting = r.meeting;
  if (!meeting || typeof meeting !== 'object' || Array.isArray(meeting)) return undefined;
  const m = meeting as Record<string, unknown>;
  if (typeof r.larkAppId !== 'string' || !r.larkAppId.trim()) return undefined;
  if (typeof m.id !== 'string' || !m.id.trim()) return undefined;
  if (typeof r.listenerChatId !== 'string' || !r.listenerChatId.trim()) return undefined;
  if (sourceSchemaVersion === RUNTIME_SCHEMA_VERSION
    && (!isValidStoredTimestamp(r.createdAt)
      || !isValidStoredTimestamp(r.updatedAt)
      || !isValidStoredTimestamp(r.expiresAt)
      || !hasValidCurrentMeetingFields(m)
      || !hasValidCurrentOptionalFields(r))) {
    return undefined;
  }
  const createdAt = isValidStoredTimestamp(r.createdAt) ? r.createdAt : Date.now();
  const updatedAt = isValidStoredTimestamp(r.updatedAt) ? r.updatedAt : createdAt;
  const expiresAt = isValidStoredTimestamp(r.expiresAt)
    ? r.expiresAt
    : updatedAt + DEFAULT_TTL_MS;
  let selectedAgents: VcMeetingRuntimeSelectedAgent[];
  if (Object.prototype.hasOwnProperty.call(r, 'selectedAgents')) {
    const normalized = normalizeSelectedAgents(r.selectedAgents);
    if (!normalized.ok) return undefined;
    selectedAgents = normalized.agents;
  } else if (sourceSchemaVersion === 1) {
    const legacy = legacySelectedAgent(r);
    selectedAgents = legacy ? [legacy] : [];
  } else {
    return undefined;
  }
  const singularAliases = singularSelectionAliases(selectedAgents);
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    larkAppId: r.larkAppId.trim(),
    meeting: {
      id: m.id.trim(),
      ...(typeof m.meetingNo === 'string' && m.meetingNo.trim() ? { meetingNo: m.meetingNo.trim() } : {}),
      ...(typeof m.topic === 'string' && m.topic.trim() ? { topic: m.topic.trim() } : {}),
    },
    listenerChatId: r.listenerChatId.trim(),
    ...(typeof r.attentionTargetOpenId === 'string' && r.attentionTargetOpenId.trim()
      ? { attentionTargetOpenId: r.attentionTargetOpenId.trim() }
      : {}),
    ...(r.consumerMode === 'pending' || r.consumerMode === 'listenOnly' || r.consumerMode === 'agent'
      ? { consumerMode: r.consumerMode }
      : {}),
    selectedAgents,
    ...singularAliases,
    ...(r.consumerClosePhase === 'data_closing' || r.consumerClosePhase === 'finalizing'
      ? { consumerClosePhase: r.consumerClosePhase }
      : {}),
    ...(typeof r.consumerFinalizationDeadlineAt === 'number'
      && Number.isFinite(r.consumerFinalizationDeadlineAt)
      && r.consumerFinalizationDeadlineAt >= 0
      ? { consumerFinalizationDeadlineAt: r.consumerFinalizationDeadlineAt }
      : {}),
    ...(typeof r.consumerCloseResolutionDeadlineAt === 'number'
      && Number.isFinite(r.consumerCloseResolutionDeadlineAt)
      && r.consumerCloseResolutionDeadlineAt >= 0
      ? { consumerCloseResolutionDeadlineAt: r.consumerCloseResolutionDeadlineAt }
      : {}),
    ...(isOutputPolicy(r.textOutputPolicy) ? { textOutputPolicy: r.textOutputPolicy } : {}),
    ...(isOutputPolicy(r.voiceOutputPolicy) ? { voiceOutputPolicy: r.voiceOutputPolicy } : {}),
    ...(typeof r.syncIntervalMs === 'number' && Number.isFinite(r.syncIntervalMs) && r.syncIntervalMs > 0
      ? { syncIntervalMs: r.syncIntervalMs }
      : {}),
    ...(typeof r.consumerSelectionExpiresAt === 'number' && Number.isFinite(r.consumerSelectionExpiresAt)
      ? { consumerSelectionExpiresAt: r.consumerSelectionExpiresAt }
      : {}),
    ...(typeof r.consumerCardMessageId === 'string' && r.consumerCardMessageId.trim()
      ? { consumerCardMessageId: r.consumerCardMessageId.trim() }
      : {}),
    ...(r.listenerPresenceStale === true ? { listenerPresenceStale: true } : {}),
    ...(typeof r.listenerPresenceChangedAtMs === 'number'
      && Number.isFinite(r.listenerPresenceChangedAtMs)
      && r.listenerPresenceChangedAtMs >= 0
      ? { listenerPresenceChangedAtMs: r.listenerPresenceChangedAtMs }
      : {}),
    ...(typeof r.listenerPresenceGeneration === 'number'
      && Number.isInteger(r.listenerPresenceGeneration)
      && r.listenerPresenceGeneration >= 0
      ? { listenerPresenceGeneration: r.listenerPresenceGeneration }
      : {}),
    ...(typeof r.listenerRejoinNonce === 'string' && r.listenerRejoinNonce.trim()
      ? { listenerRejoinNonce: r.listenerRejoinNonce.trim() }
      : {}),
    ...(typeof r.listenerRejoinCardMessageId === 'string' && r.listenerRejoinCardMessageId.trim()
      ? { listenerRejoinCardMessageId: r.listenerRejoinCardMessageId.trim() }
      : {}),
    ...(Array.isArray(r.temporaryInstructionOpenIds)
      ? { temporaryInstructionOpenIds: normalizeIdList(r.temporaryInstructionOpenIds) }
      : {}),
    ...(Array.isArray(r.temporaryInstructionUnionIds)
      ? { temporaryInstructionUnionIds: normalizeIdList(r.temporaryInstructionUnionIds) }
      : {}),
    createdAt,
    updatedAt,
    expiresAt,
  };
}

function normalizeEndedTombstoneRecord(value: unknown): VcMeetingEndedTombstoneRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.larkAppId !== 'string' || !r.larkAppId.trim()) return undefined;
  if (typeof r.meetingId !== 'string' || !r.meetingId.trim()) return undefined;
  if (!isValidStoredTimestamp(r.endedAt) || !isValidStoredTimestamp(r.expiresAt)) return undefined;
  return {
    larkAppId: r.larkAppId.trim(),
    meetingId: r.meetingId.trim(),
    endedAt: r.endedAt,
    expiresAt: r.expiresAt,
  };
}

function isOutputPolicy(value: unknown): value is VcMeetingOutputPolicy {
  return value === 'deny' || value === 'approval' || value === 'allow';
}

function normalizeIdList(value: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function listVcMeetingRuntimeSessions(
  dataDir: string,
  larkAppId: string,
  now = Date.now(),
): VcMeetingRuntimeSessionRecord[] {
  const store = readStoreForAccess(dataDir);
  const out: VcMeetingRuntimeSessionRecord[] = [];
  for (const record of Object.values(store)) {
    if (record.expiresAt <= now) continue;
    if (record.larkAppId === larkAppId) out.push(record);
  }
  return out;
}

export function pruneExpiredVcMeetingRuntimeSessions(dataDir: string, now = Date.now()): number {
  const fp = filePath(dataDir);
  ensureLockParent(fp);
  return withFileLockSync(fp, () => {
    const store = readStore(dataDir);
    let removed = 0;
    for (const [key, record] of Object.entries(store)) {
      if (record.expiresAt > now) continue;
      delete store[key];
      removed += 1;
    }
    if (removed > 0) writeStore(dataDir, store);
    return removed;
  });
}

export function listVcMeetingRuntimeSessionsByListenerAndAgent(
  dataDir: string,
  input: {
    listenerChatId: string;
    agentAppId: string;
  },
  now = Date.now(),
): VcMeetingRuntimeSessionRecord[] {
  const listenerChatId = input.listenerChatId.trim();
  const agentAppId = input.agentAppId.trim();
  if (!listenerChatId || !agentAppId) return [];

  const fp = filePath(dataDir);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(fp);
  } catch {
    invalidateListenerAgentIndex();
    assertNoQuarantinedEvidence(fp, 'runtime session');
    return [];
  }

  const cached = listenerAgentIndexCache;
  let byListenerAgent: Map<string, VcMeetingRuntimeSessionRecord[]>;
  if (
    cached
    && cached.fp === fp
    && cached.ino === stats.ino
    && cached.mtimeMs === stats.mtimeMs
    && cached.ctimeMs === stats.ctimeMs
    && cached.size === stats.size
  ) {
    byListenerAgent = cached.byListenerAgent;
  } else {
    const store = readStoreForAccess(dataDir);
    byListenerAgent = new Map<string, VcMeetingRuntimeSessionRecord[]>();
    for (const record of Object.values(store)) {
      if (record.consumerMode !== 'agent') continue;
      for (const selected of record.selectedAgents) {
        if (selected.status !== 'active') continue;
        const key = listenerAgentIndexKey(record.listenerChatId, selected.agentAppId);
        const matches = byListenerAgent.get(key) ?? [];
        matches.push(record);
        byListenerAgent.set(key, matches);
      }
    }
    for (const matches of byListenerAgent.values()) {
      matches.sort((a, b) => b.updatedAt - a.updatedAt
        || a.larkAppId.localeCompare(b.larkAppId)
        || a.meeting.id.localeCompare(b.meeting.id));
    }
    listenerAgentIndexCache = {
      fp,
      ino: stats.ino,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      size: stats.size,
      byListenerAgent,
    };
  }

  const matches = byListenerAgent.get(listenerAgentIndexKey(listenerChatId, agentAppId)) ?? [];
  const active = matches.filter(record => record.expiresAt > now);
  if (active.length !== matches.length) {
    invalidateListenerAgentIndex();
  }
  return active;
}

/**
 * @deprecated P0 compatibility wrapper. It preserves the historical
 * latest-updated match until daemon routing is migrated to the list API.
 */
export function findVcMeetingRuntimeSessionByListenerAndAgent(
  dataDir: string,
  input: {
    listenerChatId: string;
    selectedAgentAppId: string;
  },
  now = Date.now(),
): VcMeetingRuntimeSessionRecord | undefined {
  return listVcMeetingRuntimeSessionsByListenerAndAgent(dataDir, {
    listenerChatId: input.listenerChatId,
    agentAppId: input.selectedAgentAppId,
  }, now)[0];
}

export function recordVcMeetingRuntimeSession(
  dataDir: string,
  input: {
    larkAppId: string;
    meeting: { id: string; meetingNo?: string; topic?: string };
    listenerChatId: string;
    attentionTargetOpenId?: string;
    consumerMode?: 'pending' | 'listenOnly' | 'agent';
    selectedAgents?: VcMeetingRuntimeSelectedAgent[];
    /** @deprecated Use selectedAgents. Accepted for the P0 daemon writer. */
    selectedAgentAppId?: string;
    /** @deprecated Use selectedAgents. Accepted for the P0 daemon writer. */
    selectedAgentLabel?: string;
    /** @deprecated Use selectedAgents[].status=paused. */
    consumerPaused?: boolean;
    consumerClosePhase?: 'data_closing' | 'finalizing';
    consumerFinalizationDeadlineAt?: number;
    consumerCloseResolutionDeadlineAt?: number;
    textOutputPolicy?: VcMeetingOutputPolicy;
    voiceOutputPolicy?: VcMeetingOutputPolicy;
    syncIntervalMs?: number;
    consumerSelectionExpiresAt?: number;
    consumerCardMessageId?: string;
    listenerPresenceStale?: boolean;
    listenerPresenceChangedAtMs?: number;
    listenerPresenceGeneration?: number;
    listenerRejoinNonce?: string;
    listenerRejoinCardMessageId?: string;
    temporaryInstructionOpenIds?: string[];
    temporaryInstructionUnionIds?: string[];
  },
  now = Date.now(),
): void {
  const larkAppId = input.larkAppId.trim();
  const meetingId = input.meeting.id.trim();
  const listenerChatId = input.listenerChatId.trim();
  if (!larkAppId || !meetingId || !listenerChatId) return;
  const fp = filePath(dataDir);
  ensureLockParent(fp);
  withFileLockSync(fp, () => {
    const store = readStore(dataDir);
    const key = sessionKey(larkAppId, meetingId);
    const prior = store[key];
    let selectedAgents: VcMeetingRuntimeSelectedAgent[];
    if (input.selectedAgents !== undefined) {
      const normalized = normalizeSelectedAgents(input.selectedAgents);
      if (!normalized.ok) throw new Error('invalid vc meeting runtime selectedAgents');
      selectedAgents = normalized.agents;
    } else {
      const legacy = legacySelectedAgent({
        selectedAgentAppId: input.selectedAgentAppId,
        selectedAgentLabel: input.selectedAgentLabel,
        consumerPaused: input.consumerPaused,
      });
      selectedAgents = legacy ? [legacy] : [];
    }
    const singularAliases = singularSelectionAliases(selectedAgents);
    store[key] = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      larkAppId,
      meeting: {
        id: meetingId,
        ...(input.meeting.meetingNo ? { meetingNo: input.meeting.meetingNo } : {}),
        ...(input.meeting.topic ? { topic: input.meeting.topic } : {}),
      },
      listenerChatId,
      ...(input.attentionTargetOpenId ? { attentionTargetOpenId: input.attentionTargetOpenId } : {}),
      ...(input.consumerMode ? { consumerMode: input.consumerMode } : {}),
      selectedAgents,
      ...singularAliases,
      ...(input.consumerClosePhase ? { consumerClosePhase: input.consumerClosePhase } : {}),
      ...(input.consumerFinalizationDeadlineAt !== undefined
        ? { consumerFinalizationDeadlineAt: input.consumerFinalizationDeadlineAt }
        : {}),
      ...(input.consumerCloseResolutionDeadlineAt !== undefined
        ? { consumerCloseResolutionDeadlineAt: input.consumerCloseResolutionDeadlineAt }
        : {}),
      ...(input.textOutputPolicy ? { textOutputPolicy: input.textOutputPolicy } : {}),
      ...(input.voiceOutputPolicy ? { voiceOutputPolicy: input.voiceOutputPolicy } : {}),
      ...(input.syncIntervalMs !== undefined ? { syncIntervalMs: input.syncIntervalMs } : {}),
      ...(input.consumerSelectionExpiresAt !== undefined ? { consumerSelectionExpiresAt: input.consumerSelectionExpiresAt } : {}),
      ...(input.consumerCardMessageId ? { consumerCardMessageId: input.consumerCardMessageId } : {}),
      ...(input.listenerPresenceStale === true ? { listenerPresenceStale: true } : {}),
      ...(input.listenerPresenceChangedAtMs !== undefined
        ? { listenerPresenceChangedAtMs: input.listenerPresenceChangedAtMs }
        : {}),
      ...(input.listenerPresenceGeneration !== undefined
        ? { listenerPresenceGeneration: input.listenerPresenceGeneration }
        : {}),
      ...(input.listenerRejoinNonce ? { listenerRejoinNonce: input.listenerRejoinNonce } : {}),
      ...(input.listenerRejoinCardMessageId
        ? { listenerRejoinCardMessageId: input.listenerRejoinCardMessageId }
        : {}),
      ...(input.temporaryInstructionOpenIds !== undefined
        ? { temporaryInstructionOpenIds: normalizeIdList(input.temporaryInstructionOpenIds) }
        : {}),
      ...(input.temporaryInstructionUnionIds !== undefined
        ? { temporaryInstructionUnionIds: normalizeIdList(input.temporaryInstructionUnionIds) }
        : {}),
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      expiresAt: now + DEFAULT_TTL_MS,
    };
    writeStore(dataDir, store);
  });
}

export function removeVcMeetingRuntimeSession(
  dataDir: string,
  larkAppId: string,
  meetingId: string,
): void {
  const fp = filePath(dataDir);
  ensureLockParent(fp);
  withFileLockSync(fp, () => {
    const store = readStore(dataDir);
    const key = sessionKey(larkAppId, meetingId);
    if (!store[key]) return;
    delete store[key];
    writeStore(dataDir, store);
  });
}

export function recordVcMeetingEndedTombstone(
  dataDir: string,
  input: { larkAppId: string; meetingId: string },
  now = Date.now(),
  ttlMs = DEFAULT_ENDED_TOMBSTONE_TTL_MS,
): void {
  const larkAppId = input.larkAppId.trim();
  const meetingId = input.meetingId.trim();
  if (!larkAppId || !meetingId) return;
  const fp = endedTombstoneFilePath(dataDir);
  ensureLockParent(fp);
  withFileLockSync(fp, () => {
    const store = readEndedTombstoneStore(dataDir);
    const key = sessionKey(larkAppId, meetingId);
    store[key] = {
      larkAppId,
      meetingId,
      endedAt: now,
      expiresAt: now + ttlMs,
    };
    for (const [itemKey, record] of Object.entries(store)) {
      if (record.expiresAt <= now) delete store[itemKey];
    }
    writeEndedTombstoneStore(dataDir, store);
  });
}

export function hasVcMeetingEndedTombstone(
  dataDir: string,
  larkAppId: string,
  meetingId: string,
  now = Date.now(),
): boolean {
  const normalizedLarkAppId = larkAppId.trim();
  const normalizedMeetingId = meetingId.trim();
  if (!normalizedLarkAppId || !normalizedMeetingId) return false;
  const key = sessionKey(normalizedLarkAppId, normalizedMeetingId);
  const store = readEndedTombstoneStoreForAccess(dataDir);
  const record = store[key];
  if (!record) return false;
  if (record.expiresAt > now) return true;

  // Expiry cleanup is a read-modify-write. Re-read under the shared file lock
  // so we cannot delete a concurrently refreshed tombstone or overwrite a
  // different daemon's newly appended meeting record.
  const fp = endedTombstoneFilePath(dataDir);
  ensureLockParent(fp);
  return withFileLockSync(fp, () => {
    const currentStore = readEndedTombstoneStore(dataDir);
    const current = currentStore[key];
    if (!current) return false;
    if (current.expiresAt > now) return true;
    delete currentStore[key];
    writeEndedTombstoneStore(dataDir, currentStore);
    return false;
  });
}
