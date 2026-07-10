import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

export interface VcMeetingRuntimeSessionRecord {
  larkAppId: string;
  meeting: {
    id: string;
    meetingNo?: string;
    topic?: string;
  };
  listenerChatId: string;
  attentionTargetOpenId?: string;
  consumerMode?: 'pending' | 'listenOnly' | 'agent';
  selectedAgentAppId?: string;
  selectedAgentLabel?: string;
  consumerPaused?: boolean;
  textOutputPolicy?: VcMeetingOutputPolicy;
  voiceOutputPolicy?: VcMeetingOutputPolicy;
  syncIntervalMs?: number;
  consumerSelectionExpiresAt?: number;
  consumerCardMessageId?: string;
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
  byListenerAgent: Map<string, VcMeetingRuntimeSessionRecord>;
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

function readStore(dataDir: string): Record<string, VcMeetingRuntimeSessionRecord> {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return {};
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>;
    const out: Record<string, VcMeetingRuntimeSessionRecord> = {};
    for (const [key, value] of Object.entries(raw)) {
      const record = normalizeRecord(value);
      if (record) out[key] = record;
    }
    return out;
  } catch (err) {
    logger.warn(
      `[vc-meeting-runtime-store] failed to read ${fp}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
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
  if (!existsSync(fp)) return {};
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>;
    const out: Record<string, VcMeetingEndedTombstoneRecord> = {};
    for (const [key, value] of Object.entries(raw)) {
      const record = normalizeEndedTombstoneRecord(value);
      if (record) out[key] = record;
    }
    return out;
  } catch (err) {
    logger.warn(
      `[vc-meeting-runtime-store] failed to read ${fp}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

function writeEndedTombstoneStore(dataDir: string, store: Record<string, VcMeetingEndedTombstoneRecord>): void {
  const fp = endedTombstoneFilePath(dataDir);
  const dir = dirname(fp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, fp);
}

function normalizeRecord(value: unknown): VcMeetingRuntimeSessionRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const meeting = r.meeting;
  if (!meeting || typeof meeting !== 'object' || Array.isArray(meeting)) return undefined;
  const m = meeting as Record<string, unknown>;
  if (typeof r.larkAppId !== 'string' || !r.larkAppId.trim()) return undefined;
  if (typeof m.id !== 'string' || !m.id.trim()) return undefined;
  if (typeof r.listenerChatId !== 'string' || !r.listenerChatId.trim()) return undefined;
  const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : Date.now();
  const updatedAt = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : createdAt;
  const expiresAt = typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt)
    ? r.expiresAt
    : updatedAt + DEFAULT_TTL_MS;
  return {
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
    ...(typeof r.selectedAgentAppId === 'string' && r.selectedAgentAppId.trim()
      ? { selectedAgentAppId: r.selectedAgentAppId.trim() }
      : {}),
    ...(typeof r.selectedAgentLabel === 'string' && r.selectedAgentLabel.trim()
      ? { selectedAgentLabel: r.selectedAgentLabel.trim() }
      : {}),
    ...(typeof r.consumerPaused === 'boolean' ? { consumerPaused: r.consumerPaused } : {}),
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
  const endedAt = typeof r.endedAt === 'number' && Number.isFinite(r.endedAt) ? r.endedAt : Date.now();
  const expiresAt = typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt)
    ? r.expiresAt
    : endedAt + DEFAULT_ENDED_TOMBSTONE_TTL_MS;
  return {
    larkAppId: r.larkAppId.trim(),
    meetingId: r.meetingId.trim(),
    endedAt,
    expiresAt,
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
  const store = readStore(dataDir);
  const out: VcMeetingRuntimeSessionRecord[] = [];
  for (const record of Object.values(store)) {
    if (record.expiresAt <= now) continue;
    if (record.larkAppId === larkAppId) out.push(record);
  }
  return out;
}

export function pruneExpiredVcMeetingRuntimeSessions(dataDir: string, now = Date.now()): number {
  const store = readStore(dataDir);
  let removed = 0;
  for (const [key, record] of Object.entries(store)) {
    if (record.expiresAt > now) continue;
    delete store[key];
    removed += 1;
  }
  if (removed > 0) writeStore(dataDir, store);
  return removed;
}

export function findVcMeetingRuntimeSessionByListenerAndAgent(
  dataDir: string,
  input: {
    listenerChatId: string;
    selectedAgentAppId: string;
  },
  now = Date.now(),
): VcMeetingRuntimeSessionRecord | undefined {
  const listenerChatId = input.listenerChatId.trim();
  const selectedAgentAppId = input.selectedAgentAppId.trim();
  if (!listenerChatId || !selectedAgentAppId) return undefined;

  const fp = filePath(dataDir);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(fp);
  } catch {
    invalidateListenerAgentIndex();
    return undefined;
  }

  const cached = listenerAgentIndexCache;
  let byListenerAgent: Map<string, VcMeetingRuntimeSessionRecord>;
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
    const store = readStore(dataDir);
    byListenerAgent = new Map<string, VcMeetingRuntimeSessionRecord>();
    for (const record of Object.values(store)) {
      if (
        record.consumerMode === 'agent'
        && record.selectedAgentAppId
        && record.consumerPaused !== true
      ) {
        const key = listenerAgentIndexKey(record.listenerChatId, record.selectedAgentAppId);
        const prior = byListenerAgent.get(key);
        if (!prior || record.updatedAt > prior.updatedAt) byListenerAgent.set(key, record);
      }
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

  const record = byListenerAgent.get(listenerAgentIndexKey(listenerChatId, selectedAgentAppId));
  if (!record) return undefined;
  if (record.expiresAt <= now) {
    invalidateListenerAgentIndex();
    return undefined;
  }
  return record;
}

export function recordVcMeetingRuntimeSession(
  dataDir: string,
  input: {
    larkAppId: string;
    meeting: { id: string; meetingNo?: string; topic?: string };
    listenerChatId: string;
    attentionTargetOpenId?: string;
    consumerMode?: 'pending' | 'listenOnly' | 'agent';
    selectedAgentAppId?: string;
    selectedAgentLabel?: string;
    consumerPaused?: boolean;
    textOutputPolicy?: VcMeetingOutputPolicy;
    voiceOutputPolicy?: VcMeetingOutputPolicy;
    syncIntervalMs?: number;
    consumerSelectionExpiresAt?: number;
    consumerCardMessageId?: string;
    temporaryInstructionOpenIds?: string[];
    temporaryInstructionUnionIds?: string[];
  },
  now = Date.now(),
): void {
  if (!input.larkAppId.trim() || !input.meeting.id.trim() || !input.listenerChatId.trim()) return;
  const store = readStore(dataDir);
  const key = sessionKey(input.larkAppId, input.meeting.id);
  const prior = store[key];
  store[key] = {
    larkAppId: input.larkAppId,
    meeting: {
      id: input.meeting.id,
      ...(input.meeting.meetingNo ? { meetingNo: input.meeting.meetingNo } : {}),
      ...(input.meeting.topic ? { topic: input.meeting.topic } : {}),
    },
    listenerChatId: input.listenerChatId,
    ...(input.attentionTargetOpenId ? { attentionTargetOpenId: input.attentionTargetOpenId } : {}),
    ...(input.consumerMode ? { consumerMode: input.consumerMode } : {}),
    ...(input.selectedAgentAppId ? { selectedAgentAppId: input.selectedAgentAppId } : {}),
    ...(input.selectedAgentLabel ? { selectedAgentLabel: input.selectedAgentLabel } : {}),
    ...(input.consumerPaused !== undefined ? { consumerPaused: input.consumerPaused } : {}),
    ...(input.textOutputPolicy ? { textOutputPolicy: input.textOutputPolicy } : {}),
    ...(input.voiceOutputPolicy ? { voiceOutputPolicy: input.voiceOutputPolicy } : {}),
    ...(input.syncIntervalMs !== undefined ? { syncIntervalMs: input.syncIntervalMs } : {}),
    ...(input.consumerSelectionExpiresAt !== undefined ? { consumerSelectionExpiresAt: input.consumerSelectionExpiresAt } : {}),
    ...(input.consumerCardMessageId ? { consumerCardMessageId: input.consumerCardMessageId } : {}),
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
}

export function removeVcMeetingRuntimeSession(
  dataDir: string,
  larkAppId: string,
  meetingId: string,
): void {
  const store = readStore(dataDir);
  const key = sessionKey(larkAppId, meetingId);
  if (!store[key]) return;
  delete store[key];
  writeStore(dataDir, store);
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
  const store = readEndedTombstoneStore(dataDir);
  const record = store[key];
  if (!record) return false;
  if (record.expiresAt <= now) {
    delete store[key];
    writeEndedTombstoneStore(dataDir, store);
    return false;
  }
  return true;
}
