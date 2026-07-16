/**
 * Canonical meeting-feed metadata journal.
 *
 * The journal assigns the listener-wide ingestSeq before per-member filters
 * create their own deliverySeq streams. It intentionally stores no transcript
 * or chat body: only item identity, revision, semantic hash, and timestamps.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import type { NormalizedVcMeetingItem, VcMeetingActivityType } from '../vc-agent/types.js';
import {
  computeVcMeetingItemContentHash,
} from './vc-meeting-delivery-feed.js';

const SCHEMA_VERSION = 1 as const;
const DIR_NAME = 'vc-meeting-feed-metadata';
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_CONFLICT_AUDIT = 100;
const ITEM_TYPES: readonly VcMeetingActivityType[] = [
  'participant_joined',
  'participant_left',
  'chat_received',
  'transcript_received',
  'magic_share_started',
  'magic_share_ended',
];

export interface VcMeetingFeedMetadataKey {
  listenerAppId: string;
  meetingId: string;
}

export interface VcMeetingFeedItemMetadata {
  itemVersionKey: string;
  itemKey: string;
  itemType: VcMeetingActivityType;
  revision: number;
  ingestSeq: number;
  contentHash: string;
  occurredAtMs?: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface VcMeetingFeedIdentityConflict {
  itemVersionKey: string;
  existingContentHash: string;
  conflictingContentHash: string;
  observedAt: number;
}

export interface VcMeetingFeedMetadataState extends VcMeetingFeedMetadataKey {
  schemaVersion: typeof SCHEMA_VERSION;
  nextIngestSeq: number;
  items: Record<string, VcMeetingFeedItemMetadata>;
  latestByItemKey: Record<string, {
    revision: number;
    itemVersionKey: string;
    ingestSeq: number;
    contentHash: string;
  }>;
  conflicts: VcMeetingFeedIdentityConflict[];
  createdAt: number;
  updatedAt: number;
}

export type VcMeetingFeedIngestDisposition = 'accepted' | 'duplicate' | 'stale_revision' | 'identity_conflict';

export interface VcMeetingFeedIngestOutcome {
  disposition: VcMeetingFeedIngestDisposition;
  item: NormalizedVcMeetingItem;
  metadata?: VcMeetingFeedItemMetadata;
  existing?: VcMeetingFeedItemMetadata;
}

export interface VcMeetingFeedIngestResult {
  outcomes: VcMeetingFeedIngestOutcome[];
  accepted: VcMeetingFeedIngestOutcome[];
  duplicates: VcMeetingFeedIngestOutcome[];
  stale: VcMeetingFeedIngestOutcome[];
  conflicts: VcMeetingFeedIngestOutcome[];
  nextIngestSeq: number;
}

function assertIdentifier(value: string, path: string): void {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${path} must be a non-empty string without surrounding whitespace`);
  }
  if (value === '__proto__' || value === 'prototype' || value === 'constructor') {
    throw new Error(`${path} uses a reserved object key`);
  }
}

function isSafeMapKey(value: string): boolean {
  return value !== '__proto__' && value !== 'prototype' && value !== 'constructor';
}

function scopeId(key: VcMeetingFeedMetadataKey): string {
  assertIdentifier(key.listenerAppId, 'listenerAppId');
  assertIdentifier(key.meetingId, 'meetingId');
  return createHash('sha256')
    .update(JSON.stringify([key.listenerAppId, key.meetingId]), 'utf8')
    .digest('hex');
}

function statePath(dataDir: string, key: VcMeetingFeedMetadataKey): string {
  return join(dataDir, DIR_NAME, `${scopeId(key)}.json`);
}

function ensureDir(dataDir: string): void {
  mkdirSync(join(dataDir, DIR_NAME), { recursive: true });
}

function emptyState(key: VcMeetingFeedMetadataKey, now: number): VcMeetingFeedMetadataState {
  return {
    schemaVersion: SCHEMA_VERSION,
    listenerAppId: key.listenerAppId,
    meetingId: key.meetingId,
    nextIngestSeq: 1,
    items: {},
    latestByItemKey: {},
    conflicts: [],
    createdAt: now,
    updatedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

function normalizeItemMetadata(value: unknown): VcMeetingFeedItemMetadata | undefined {
  if (!isRecord(value)) return undefined;
  if (!hasOnlyKeys(value, [
    'itemVersionKey', 'itemKey', 'itemType', 'revision', 'ingestSeq', 'contentHash',
    'occurredAtMs', 'firstSeenAt', 'lastSeenAt',
  ])) return undefined;
  if (typeof value.itemVersionKey !== 'string' || !value.itemVersionKey.trim()) return undefined;
  if (typeof value.itemKey !== 'string' || !value.itemKey.trim() || !isSafeMapKey(value.itemKey)) return undefined;
  if (typeof value.itemType !== 'string'
    || !(ITEM_TYPES as readonly string[]).includes(value.itemType)) return undefined;
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) <= 0) return undefined;
  if (!Number.isSafeInteger(value.ingestSeq) || (value.ingestSeq as number) <= 0) return undefined;
  if (typeof value.contentHash !== 'string' || !HASH_RE.test(value.contentHash)) return undefined;
  if (typeof value.firstSeenAt !== 'number' || !Number.isFinite(value.firstSeenAt)) return undefined;
  if (typeof value.lastSeenAt !== 'number' || !Number.isFinite(value.lastSeenAt)) return undefined;
  if (value.occurredAtMs !== undefined
    && (typeof value.occurredAtMs !== 'number' || !Number.isFinite(value.occurredAtMs))) return undefined;
  return value as unknown as VcMeetingFeedItemMetadata;
}

function normalizeState(raw: unknown, key: VcMeetingFeedMetadataKey): VcMeetingFeedMetadataState | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (!hasOnlyKeys(raw, [
    'schemaVersion', 'listenerAppId', 'meetingId', 'nextIngestSeq', 'items',
    'latestByItemKey', 'conflicts', 'createdAt', 'updatedAt',
  ])) return undefined;
  if (raw.listenerAppId !== key.listenerAppId || raw.meetingId !== key.meetingId) return undefined;
  if (!Number.isSafeInteger(raw.nextIngestSeq) || (raw.nextIngestSeq as number) <= 0) return undefined;
  if (!isRecord(raw.items) || !isRecord(raw.latestByItemKey) || !Array.isArray(raw.conflicts)) return undefined;
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return undefined;
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return undefined;
  const items: Record<string, VcMeetingFeedItemMetadata> = {};
  let maxIngestSeq = 0;
  const ingestSeqs = new Set<number>();
  const versionsByItemKey = new Map<string, VcMeetingFeedItemMetadata[]>();
  for (const [versionKey, value] of Object.entries(raw.items)) {
    const normalized = normalizeItemMetadata(value);
    if (!normalized
      || normalized.itemVersionKey !== versionKey
      || normalized.itemVersionKey !== `${normalized.itemKey}:r${normalized.revision}`
      || ingestSeqs.has(normalized.ingestSeq)) return undefined;
    ingestSeqs.add(normalized.ingestSeq);
    items[versionKey] = normalized;
    maxIngestSeq = Math.max(maxIngestSeq, normalized.ingestSeq);
    const versions = versionsByItemKey.get(normalized.itemKey) ?? [];
    versions.push(normalized);
    versionsByItemKey.set(normalized.itemKey, versions);
  }
  if ((raw.nextIngestSeq as number) !== maxIngestSeq + 1 || ingestSeqs.size !== maxIngestSeq) return undefined;
  const latestByItemKey: VcMeetingFeedMetadataState['latestByItemKey'] = {};
  for (const [itemKey, value] of Object.entries(raw.latestByItemKey)) {
    if (!isSafeMapKey(itemKey)
      || !isRecord(value)
      || !hasOnlyKeys(value, ['revision', 'itemVersionKey', 'ingestSeq', 'contentHash'])
      || !Number.isSafeInteger(value.revision) || (value.revision as number) <= 0
      || typeof value.itemVersionKey !== 'string'
      || !Number.isSafeInteger(value.ingestSeq) || (value.ingestSeq as number) <= 0
      || typeof value.contentHash !== 'string' || !HASH_RE.test(value.contentHash)) return undefined;
    const item = items[value.itemVersionKey];
    if (!item || item.itemKey !== itemKey || item.revision !== value.revision
      || item.ingestSeq !== value.ingestSeq || item.contentHash !== value.contentHash) return undefined;
    latestByItemKey[itemKey] = value as unknown as VcMeetingFeedMetadataState['latestByItemKey'][string];
  }
  const conflicts: VcMeetingFeedIdentityConflict[] = [];
  for (const value of raw.conflicts) {
    if (!isRecord(value)
      || !hasOnlyKeys(value, [
        'itemVersionKey', 'existingContentHash', 'conflictingContentHash', 'observedAt',
      ])
      || typeof value.itemVersionKey !== 'string'
      || typeof value.existingContentHash !== 'string' || !HASH_RE.test(value.existingContentHash)
      || typeof value.conflictingContentHash !== 'string' || !HASH_RE.test(value.conflictingContentHash)
      || typeof value.observedAt !== 'number' || !Number.isFinite(value.observedAt)) return undefined;
    conflicts.push(value as unknown as VcMeetingFeedIdentityConflict);
  }
  if (versionsByItemKey.size !== Object.keys(latestByItemKey).length) return undefined;
  for (const [itemKey, versions] of versionsByItemKey) {
    const types = new Set(versions.map(item => item.itemType));
    if (types.size !== 1) return undefined;
    const ordered = versions.slice().sort((a, b) => a.revision - b.revision);
    if (ordered.some((item, index) => item.revision !== index + 1)) return undefined;
    const latest = ordered.at(-1)!;
    const pointer = latestByItemKey[itemKey];
    if (!pointer || pointer.itemVersionKey !== latest.itemVersionKey) return undefined;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    listenerAppId: key.listenerAppId,
    meetingId: key.meetingId,
    nextIngestSeq: raw.nextIngestSeq as number,
    items,
    latestByItemKey,
    conflicts,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function quarantineCorrupt(path: string): string {
  const quarantined = `${path}.corrupt.${Date.now()}`;
  renameSync(path, quarantined);
  return quarantined;
}

function readState(dataDir: string, key: VcMeetingFeedMetadataKey, now: number): VcMeetingFeedMetadataState {
  const path = statePath(dataDir, key);
  if (!existsSync(path)) {
    const prefix = `${basename(path)}.corrupt.`;
    let quarantined = false;
    try { quarantined = readdirSync(dirname(path)).some(name => name.startsWith(prefix)); }
    catch { /* a genuinely new scope is initializable */ }
    if (quarantined) throw new Error(`VC meeting feed metadata has quarantined evidence for ${path}`);
    return emptyState(key, now);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const quarantined = quarantineCorrupt(path);
    throw new Error(`VC meeting feed metadata was corrupt and moved to ${quarantined}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const normalized = normalizeState(raw, key);
  if (normalized) return normalized;
  const quarantined = quarantineCorrupt(path);
  throw new Error(`VC meeting feed metadata failed validation and moved to ${quarantined}`);
}

function writeState(dataDir: string, key: VcMeetingFeedMetadataKey, state: VcMeetingFeedMetadataState): void {
  ensureDir(dataDir);
  if (!normalizeState(state, key)) throw new Error('refusing to write invalid VC meeting feed metadata');
  atomicWriteFileSync(statePath(dataDir, key), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function validateItem(key: VcMeetingFeedMetadataKey, item: NormalizedVcMeetingItem): void {
  if (item.meetingId !== key.meetingId) throw new Error('item meetingId does not match feed scope');
  assertIdentifier(item.itemKey, 'item.itemKey');
  if (item.occurredAtMs !== undefined && !Number.isFinite(item.occurredAtMs)) {
    throw new Error('item.occurredAtMs must be finite when present');
  }
}

export function ingestVcMeetingFeedMetadata(
  dataDir: string,
  key: VcMeetingFeedMetadataKey,
  items: readonly NormalizedVcMeetingItem[],
  now = Date.now(),
): VcMeetingFeedIngestResult {
  ensureDir(dataDir);
  const path = statePath(dataDir, key);
  return withFileLockSync(path, () => {
    const state = readState(dataDir, key, now);
    const outcomes: VcMeetingFeedIngestOutcome[] = [];
    let changed = false;
    for (const item of items) {
      validateItem(key, item);
      const contentHash = computeVcMeetingItemContentHash(item);
      const versions = Object.values(state.items)
        .filter(record => record.itemKey === item.itemKey)
        .sort((a, b) => a.revision - b.revision);
      const latest = versions.at(-1);
      if (latest && latest.itemType !== item.type) {
        state.conflicts.push({
          itemVersionKey: latest.itemVersionKey,
          existingContentHash: latest.contentHash,
          conflictingContentHash: contentHash,
          observedAt: now,
        });
        if (state.conflicts.length > MAX_CONFLICT_AUDIT) state.conflicts.shift();
        changed = true;
        outcomes.push({ disposition: 'identity_conflict', item, existing: latest });
        continue;
      }
      const semanticMatch = versions.find(record => record.contentHash === contentHash);
      if (semanticMatch) {
        semanticMatch.lastSeenAt = now;
        changed = true;
        const disposition = semanticMatch.itemVersionKey === latest?.itemVersionKey
          ? 'duplicate' as const
          : 'stale_revision' as const;
        outcomes.push({ disposition, item, metadata: semanticMatch, existing: semanticMatch });
        continue;
      }
      if (latest && item.type !== 'transcript_received') {
        state.conflicts.push({
          itemVersionKey: latest.itemVersionKey,
          existingContentHash: latest.contentHash,
          conflictingContentHash: contentHash,
          observedAt: now,
        });
        if (state.conflicts.length > MAX_CONFLICT_AUDIT) state.conflicts.shift();
        changed = true;
        outcomes.push({ disposition: 'identity_conflict', item, existing: latest });
        continue;
      }

      // Transcript revision is listener-journal identity, not the process-local
      // observation counter carried by NormalizedVcTranscriptItem. This keeps
      // rebuilds stable when a daemon restarts and first observes the latest
      // text as local revision 1 again.
      const revision = (latest?.revision ?? 0) + 1;
      const itemVersionKey = `${item.itemKey}:r${revision}`;
      const metadata: VcMeetingFeedItemMetadata = {
        itemVersionKey,
        itemKey: item.itemKey,
        itemType: item.type,
        revision,
        ingestSeq: state.nextIngestSeq,
        contentHash,
        ...(item.occurredAtMs !== undefined ? { occurredAtMs: item.occurredAtMs } : {}),
        firstSeenAt: now,
        lastSeenAt: now,
      };
      state.nextIngestSeq++;
      state.items[itemVersionKey] = metadata;
      state.latestByItemKey[item.itemKey] = {
        revision,
        itemVersionKey,
        ingestSeq: metadata.ingestSeq,
        contentHash,
      };
      outcomes.push({ disposition: 'accepted', item, metadata });
      changed = true;
    }
    if (changed) {
      state.updatedAt = now;
      writeState(dataDir, key, state);
    }
    return {
      outcomes,
      accepted: outcomes.filter(outcome => outcome.disposition === 'accepted'),
      duplicates: outcomes.filter(outcome => outcome.disposition === 'duplicate'),
      stale: outcomes.filter(outcome => outcome.disposition === 'stale_revision'),
      conflicts: outcomes.filter(outcome => outcome.disposition === 'identity_conflict'),
      nextIngestSeq: state.nextIngestSeq,
    };
  });
}

export function getVcMeetingFeedMetadataState(
  dataDir: string,
  key: VcMeetingFeedMetadataKey,
  now = Date.now(),
): VcMeetingFeedMetadataState {
  ensureDir(dataDir);
  const path = statePath(dataDir, key);
  return withFileLockSync(path, () => structuredClone(readState(dataDir, key, now)));
}

export function listVcMeetingFeedMetadataAfter(
  dataDir: string,
  key: VcMeetingFeedMetadataKey,
  ingestSeqExclusive: number,
): VcMeetingFeedItemMetadata[] {
  if (!Number.isSafeInteger(ingestSeqExclusive) || ingestSeqExclusive < 0) {
    throw new Error('ingestSeqExclusive must be a non-negative safe integer');
  }
  const state = getVcMeetingFeedMetadataState(dataDir, key);
  return Object.values(state.items)
    .filter(item => item.ingestSeq > ingestSeqExclusive)
    .sort((a, b) => a.ingestSeq - b.ingestSeq)
    .map(item => structuredClone(item));
}

export function removeVcMeetingFeedMetadata(
  dataDir: string,
  key: VcMeetingFeedMetadataKey,
): boolean {
  ensureDir(dataDir);
  const path = statePath(dataDir, key);
  return withFileLockSync(path, () => {
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  });
}
