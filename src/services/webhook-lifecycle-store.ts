import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { withFileLock } from '../utils/file-lock.js';

export type WebhookLifecycleStatus = 'creating' | 'active' | 'resolved';

export interface WebhookLifecycleRecord {
  lifecycleId: string;
  connectorId: string;
  dedupKey: string;
  status: WebhookLifecycleStatus;
  chatId?: string;
  creatorLarkAppId?: string;
  pendingResolved?: boolean;
  creatingExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export type BeginLifecycleFiringResult =
  | { action: 'create'; record: WebhookLifecycleRecord }
  | { action: 'reuse'; record: WebhookLifecycleRecord }
  | { action: 'creating'; record: WebhookLifecycleRecord };

export interface WebhookLifecycleStoreFile {
  version: 1;
  records: WebhookLifecycleRecord[];
}

function storePath(dataDir: string = config.session.dataDir): string {
  return join(dataDir, 'webhook-lifecycle.json');
}

function emptyStore(): WebhookLifecycleStoreFile {
  return { version: 1, records: [] };
}

function normalizeStore(raw: unknown): WebhookLifecycleStoreFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyStore();
  const r = raw as Partial<WebhookLifecycleStoreFile>;
  return {
    version: 1,
    records: Array.isArray(r.records)
      ? r.records.filter((x): x is WebhookLifecycleRecord =>
        !!x
        && typeof x === 'object'
        && typeof (x as any).connectorId === 'string'
        && typeof (x as any).dedupKey === 'string'
        && typeof (x as any).lifecycleId === 'string')
      : [],
  };
}

function readStore(dataDir: string = config.session.dataDir): WebhookLifecycleStoreFile {
  const fp = storePath(dataDir);
  if (!existsSync(fp)) return emptyStore();
  try {
    return normalizeStore(JSON.parse(readFileSync(fp, 'utf-8')));
  } catch {
    return emptyStore();
  }
}

function writeStore(dataDir: string, store: WebhookLifecycleStoreFile): void {
  const fp = storePath(dataDir);
  mkdirSync(dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(normalizeStore(store), null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  renameSync(tmp, fp);
}

function keyOf(connectorId: string, dedupKey: string): string {
  return `${connectorId}\0${dedupKey}`;
}

function findIndex(store: WebhookLifecycleStoreFile, connectorId: string, dedupKey: string): number {
  const key = keyOf(connectorId, dedupKey);
  return store.records.findIndex(r => keyOf(r.connectorId, r.dedupKey) === key);
}

const CREATING_TTL_MS = 10 * 60 * 1000;

function creatingExpired(record: WebhookLifecycleRecord, nowMs: number): boolean {
  const raw = record.creatingExpiresAt ?? record.createdAt;
  const ms = Date.parse(raw);
  const expiresAt = record.creatingExpiresAt ? ms : ms + CREATING_TTL_MS;
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

export function listWebhookLifecycleRecords(
  opts: { connectorId?: string; status?: WebhookLifecycleStatus } = {},
  dataDir: string = config.session.dataDir,
): WebhookLifecycleRecord[] {
  return readStore(dataDir).records.filter(r =>
    (!opts.connectorId || r.connectorId === opts.connectorId)
    && (!opts.status || r.status === opts.status));
}

export async function beginWebhookLifecycleFiring(
  connectorId: string,
  dedupKey: string,
  dataDir: string = config.session.dataDir,
): Promise<BeginLifecycleFiringResult> {
  const fp = storePath(dataDir);
  return withFileLock(fp, async () => {
    const nowMs = Date.now();
    const store = readStore(dataDir);
    const idx = findIndex(store, connectorId, dedupKey);
    const existing = idx >= 0 ? store.records[idx] : undefined;
    if (existing?.status === 'active' && existing.chatId) return { action: 'reuse', record: existing };
    if (existing?.status === 'creating' && !creatingExpired(existing, nowMs)) {
      return { action: 'creating', record: existing };
    }

    const now = new Date(nowMs).toISOString();
    const record: WebhookLifecycleRecord = {
      lifecycleId: randomUUID(),
      connectorId,
      dedupKey,
      status: 'creating',
      creatingExpiresAt: new Date(nowMs + CREATING_TTL_MS).toISOString(),
      createdAt: now,
      updatedAt: now,
    };
    if (idx >= 0) store.records[idx] = record;
    else store.records.push(record);
    writeStore(dataDir, store);
    return { action: 'create', record };
  });
}

export async function activateWebhookLifecycleGroup(
  connectorId: string,
  dedupKey: string,
  lifecycleId: string,
  chatId: string,
  opts: { creatorLarkAppId?: string } = {},
  dataDir: string = config.session.dataDir,
): Promise<{ status: 'active' | 'pending_resolved' | 'stale'; record?: WebhookLifecycleRecord }> {
  const fp = storePath(dataDir);
  return withFileLock(fp, async () => {
    const store = readStore(dataDir);
    const idx = findIndex(store, connectorId, dedupKey);
    const existing = idx >= 0 ? store.records[idx] : undefined;
    if (!existing || existing.lifecycleId !== lifecycleId || existing.status !== 'creating') {
      return { status: 'stale' };
    }
    const now = new Date().toISOString();
    const next: WebhookLifecycleRecord = existing.pendingResolved
      ? {
        ...existing,
        status: 'resolved',
        chatId,
        creatorLarkAppId: opts.creatorLarkAppId,
        creatingExpiresAt: undefined,
        pendingResolved: false,
        updatedAt: now,
        resolvedAt: now,
      }
      : {
        ...existing,
        status: 'active',
        chatId,
        creatorLarkAppId: opts.creatorLarkAppId,
        creatingExpiresAt: undefined,
        updatedAt: now,
      };
    store.records[idx] = next;
    writeStore(dataDir, store);
    return { status: next.status === 'resolved' ? 'pending_resolved' : 'active', record: next };
  });
}

export async function failWebhookLifecycleGroup(
  connectorId: string,
  dedupKey: string,
  lifecycleId: string,
  dataDir: string = config.session.dataDir,
): Promise<void> {
  const fp = storePath(dataDir);
  await withFileLock(fp, async () => {
    const store = readStore(dataDir);
    const idx = findIndex(store, connectorId, dedupKey);
    const existing = idx >= 0 ? store.records[idx] : undefined;
    if (existing?.lifecycleId === lifecycleId && existing.status === 'creating') {
      store.records.splice(idx, 1);
      writeStore(dataDir, store);
    }
  });
}

export async function resolveWebhookLifecycleGroup(
  connectorId: string,
  dedupKey: string,
  dataDir: string = config.session.dataDir,
): Promise<{ action: 'close' | 'pending' | 'noop'; record?: WebhookLifecycleRecord }> {
  const fp = storePath(dataDir);
  return withFileLock(fp, async () => {
    const store = readStore(dataDir);
    const idx = findIndex(store, connectorId, dedupKey);
    const existing = idx >= 0 ? store.records[idx] : undefined;
    if (!existing || existing.status === 'resolved') return { action: 'noop' };

    const now = new Date().toISOString();
    const next: WebhookLifecycleRecord = existing.status === 'creating'
      ? { ...existing, pendingResolved: true, updatedAt: now }
      : { ...existing, status: 'resolved', updatedAt: now, resolvedAt: now };
    store.records[idx] = next;
    writeStore(dataDir, store);
    return { action: existing.status === 'creating' ? 'pending' : 'close', record: next };
  });
}
