import { mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { HEADLESS_CHAT_PREFIX, isHeadlessSessionChatId } from '../core/types.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export const HEADLESS_ID_PREFIX = 'hl_';
const HEADLESS_ID_RE = /^hl_[A-Za-z0-9_-]{8,128}$/;

export interface HeadlessSessionRecord {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  larkAppId: string;
  title: string;
  workingDir?: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  createdAt: string;
  updatedAt: string;
  latestTriggerId?: string;
  lastRunAt?: string;
  lastPublishedAt?: string;
  lastPublishedMessageId?: string;
  boundAt?: string;
  boundChatId?: string;
  boundRootMessageId?: string;
  boundScope?: 'thread' | 'chat';
}

export interface NewHeadlessSessionRecordInput {
  id?: string;
  sessionId: string;
  larkAppId: string;
  title: string;
  workingDir?: string;
  model?: string;
  reasoningEffort?: HeadlessSessionRecord['reasoningEffort'];
  now?: Date;
}

export function isHeadlessChatId(chatId: string | undefined | null): boolean {
  return isHeadlessSessionChatId(chatId);
}

export function isHeadlessId(id: string | undefined | null): boolean {
  return !!id && HEADLESS_ID_RE.test(id);
}

export function newHeadlessId(): string {
  return `${HEADLESS_ID_PREFIX}${randomUUID()}`;
}

export function headlessChatId(id: string): string {
  if (!isHeadlessId(id)) throw new Error(`invalid headless id: ${id}`);
  return `${HEADLESS_CHAT_PREFIX}${id}`;
}

function dir(): string {
  return join(config.session.dataDir, 'headless-sessions');
}

function fileFor(id: string): string {
  return join(dir(), `${id}.json`);
}

function ensureDir(): void {
  const d = dir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(raw: unknown): HeadlessSessionRecord | null {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== 1) return null;
  if (typeof raw.id !== 'string' || !isHeadlessId(raw.id)) return null;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
  if (typeof raw.larkAppId !== 'string' || !raw.larkAppId) return null;
  if (typeof raw.title !== 'string') return null;
  if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') return null;
  const out: HeadlessSessionRecord = {
    schemaVersion: 1,
    id: raw.id,
    sessionId: raw.sessionId,
    larkAppId: raw.larkAppId,
    title: raw.title,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
  if (typeof raw.workingDir === 'string') out.workingDir = raw.workingDir;
  if (typeof raw.model === 'string') out.model = raw.model;
  if (
    raw.reasoningEffort === 'low' || raw.reasoningEffort === 'medium'
    || raw.reasoningEffort === 'high' || raw.reasoningEffort === 'xhigh'
    || raw.reasoningEffort === 'max' || raw.reasoningEffort === 'ultra'
  ) out.reasoningEffort = raw.reasoningEffort;
  if (typeof raw.latestTriggerId === 'string') out.latestTriggerId = raw.latestTriggerId;
  if (typeof raw.lastRunAt === 'string') out.lastRunAt = raw.lastRunAt;
  if (typeof raw.lastPublishedAt === 'string') out.lastPublishedAt = raw.lastPublishedAt;
  if (typeof raw.lastPublishedMessageId === 'string') out.lastPublishedMessageId = raw.lastPublishedMessageId;
  if (typeof raw.boundAt === 'string') out.boundAt = raw.boundAt;
  if (typeof raw.boundChatId === 'string') out.boundChatId = raw.boundChatId;
  if (typeof raw.boundRootMessageId === 'string') out.boundRootMessageId = raw.boundRootMessageId;
  if (raw.boundScope === 'thread' || raw.boundScope === 'chat') out.boundScope = raw.boundScope;
  return out;
}

export function saveHeadlessSession(record: HeadlessSessionRecord): void {
  ensureDir();
  atomicWriteFileSync(fileFor(record.id), `${JSON.stringify(record, null, 2)}\n`, {
    durable: true,
    followTargetSymlink: false,
  });
}

export function createHeadlessRecord(input: NewHeadlessSessionRecordInput): HeadlessSessionRecord {
  const now = (input.now ?? new Date()).toISOString();
  return {
    schemaVersion: 1,
    id: input.id ?? newHeadlessId(),
    sessionId: input.sessionId,
    larkAppId: input.larkAppId,
    title: input.title,
    ...(input.workingDir ? { workingDir: input.workingDir } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export function readHeadlessSession(idOrSessionId: string): HeadlessSessionRecord | null {
  const directId = idOrSessionId.startsWith(HEADLESS_ID_PREFIX)
    && isHeadlessId(idOrSessionId)
    ? idOrSessionId
    : undefined;
  if (directId) {
    try {
      const parsed = parseRecord(JSON.parse(readFileSync(fileFor(directId), 'utf-8')));
      if (parsed) return parsed;
    } catch {
      return null;
    }
  }
  for (const record of listHeadlessSessions()) {
    if (record.sessionId === idOrSessionId) return record;
  }
  return null;
}

export function listHeadlessSessions(): HeadlessSessionRecord[] {
  const d = dir();
  if (!existsSync(d)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(d);
  } catch {
    return [];
  }
  const out: HeadlessSessionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = parseRecord(JSON.parse(readFileSync(join(d, name), 'utf-8')));
      if (parsed) out.push(parsed);
    } catch {
      // Keep listing best-effort; a corrupt row should not hide healthy rows.
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function updateHeadlessSession(
  idOrSessionId: string,
  mutate: (record: HeadlessSessionRecord) => void,
): HeadlessSessionRecord | null {
  const existing = readHeadlessSession(idOrSessionId);
  if (!existing) return null;
  return withFileLockSync(fileFor(existing.id), () => {
    const latest = readHeadlessSession(existing.id) ?? existing;
    mutate(latest);
    latest.updatedAt = new Date().toISOString();
    saveHeadlessSession(latest);
    return latest;
  });
}
