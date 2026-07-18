import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export type VcMeetingPreparationQaMode = 'off' | 'auto';

export interface VcMeetingPreparationRecord {
  larkAppId: string;
  meetingNo: string;
  meetingLink?: string;
  topic?: string;
  prepChatId: string;
  agentAppId: string;
  agentSessionId?: string;
  ownerOpenId?: string;
  qaMode: VcMeetingPreparationQaMode;
  createdAt: number;
  updatedAt: number;
}

const FILE_NAME = 'vc-meeting-preparations.json';

function filePath(dataDir: string): string {
  return join(dataDir, FILE_NAME);
}

function preparationKey(larkAppId: string, meetingNo: string): string {
  return `${larkAppId}:${meetingNo}`;
}

export function normalizeVcMeetingNumber(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : undefined;
}

function normalizeRecord(value: unknown): VcMeetingPreparationRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const larkAppId = typeof r.larkAppId === 'string' ? r.larkAppId.trim() : '';
  const meetingNo = normalizeVcMeetingNumber(r.meetingNo);
  const prepChatId = typeof r.prepChatId === 'string' ? r.prepChatId.trim() : '';
  const agentAppId = typeof r.agentAppId === 'string' ? r.agentAppId.trim() : '';
  if (!larkAppId || !meetingNo || !prepChatId || !agentAppId) return undefined;
  const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)
    ? r.createdAt
    : Date.now();
  const updatedAt = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt)
    ? r.updatedAt
    : createdAt;
  return {
    larkAppId,
    meetingNo,
    prepChatId,
    agentAppId,
    qaMode: r.qaMode === 'off' ? 'off' : 'auto',
    ...(typeof r.meetingLink === 'string' && r.meetingLink.trim() ? { meetingLink: r.meetingLink.trim() } : {}),
    ...(typeof r.topic === 'string' && r.topic.trim() ? { topic: r.topic.trim() } : {}),
    ...(typeof r.agentSessionId === 'string' && r.agentSessionId.trim()
      ? { agentSessionId: r.agentSessionId.trim() }
      : {}),
    ...(typeof r.ownerOpenId === 'string' && r.ownerOpenId.trim() ? { ownerOpenId: r.ownerOpenId.trim() } : {}),
    createdAt,
    updatedAt,
  };
}

function readStore(dataDir: string): Record<string, VcMeetingPreparationRecord> {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return {};
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>;
    const out: Record<string, VcMeetingPreparationRecord> = {};
    for (const value of Object.values(raw)) {
      const record = normalizeRecord(value);
      if (record) out[preparationKey(record.larkAppId, record.meetingNo)] = record;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(dataDir: string, store: Record<string, VcMeetingPreparationRecord>): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  atomicWriteFileSync(filePath(dataDir), JSON.stringify(store, null, 2) + '\n');
}

export function putVcMeetingPreparation(
  dataDir: string,
  input: Omit<VcMeetingPreparationRecord, 'createdAt' | 'updatedAt'>,
): VcMeetingPreparationRecord {
  const meetingNo = normalizeVcMeetingNumber(input.meetingNo);
  if (!meetingNo) throw new Error('invalid meeting number');
  const store = readStore(dataDir);
  const key = preparationKey(input.larkAppId, meetingNo);
  const prior = store[key];
  const now = Date.now();
  const next: VcMeetingPreparationRecord = {
    ...input,
    meetingNo,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
  store[key] = next;
  writeStore(dataDir, store);
  return next;
}

export function getVcMeetingPreparation(
  dataDir: string,
  larkAppId: string,
  meetingNo: string,
): VcMeetingPreparationRecord | undefined {
  const normalized = normalizeVcMeetingNumber(meetingNo);
  if (!normalized) return undefined;
  return readStore(dataDir)[preparationKey(larkAppId, normalized)];
}

export function listVcMeetingPreparations(
  dataDir: string,
  larkAppId: string,
): VcMeetingPreparationRecord[] {
  return Object.values(readStore(dataDir))
    .filter(record => record.larkAppId === larkAppId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function findVcMeetingPreparationByChat(
  dataDir: string,
  larkAppId: string,
  prepChatId: string,
): VcMeetingPreparationRecord | undefined {
  return listVcMeetingPreparations(dataDir, larkAppId)
    .find(record => record.prepChatId === prepChatId);
}

export function removeVcMeetingPreparation(
  dataDir: string,
  larkAppId: string,
  meetingNo: string,
): VcMeetingPreparationRecord | undefined {
  const normalized = normalizeVcMeetingNumber(meetingNo);
  if (!normalized) return undefined;
  const store = readStore(dataDir);
  const key = preparationKey(larkAppId, normalized);
  const removed = store[key];
  if (!removed) return undefined;
  delete store[key];
  writeStore(dataDir, store);
  return removed;
}

export function removeVcMeetingPreparationsByChat(
  dataDir: string,
  larkAppId: string,
  prepChatId: string,
): number {
  const store = readStore(dataDir);
  let removed = 0;
  for (const [key, record] of Object.entries(store)) {
    if (record.larkAppId !== larkAppId || record.prepChatId !== prepChatId) continue;
    delete store[key];
    removed += 1;
  }
  if (removed > 0) writeStore(dataDir, store);
  return removed;
}
