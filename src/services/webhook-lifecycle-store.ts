import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { withFileLock } from '../utils/file-lock.js';

export type WebhookLifecycleStatus = 'creating' | 'active' | 'resolved';
export type WebhookLifecycleSetupStatus = 'pending' | 'repairing' | 'ready' | 'degraded';

export interface WebhookLifecycleRecord {
  lifecycleId: string;
  connectorId: string;
  dedupKey: string;
  status: WebhookLifecycleStatus;
  chatId?: string;
  creatorLarkAppId?: string;
  pendingResolved?: boolean;
  indeterminate?: boolean;
  indeterminateReason?: string;
  setupStatus?: WebhookLifecycleSetupStatus;
  setupError?: string;
  setupIntentVersion?: 1;
  setupReviewerLarkAppIds?: string[];
  setupReviewersReady?: boolean;
  setupWorkingDir?: string;
  setupWorkingDirReady?: boolean;
  setupOwnerIssues?: string[];
  setupRepairId?: string;
  setupRepairExpiresAt?: string;
  creatingExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export type BeginLifecycleFiringResult =
  | { action: 'create'; record: WebhookLifecycleRecord }
  | { action: 'reuse'; record: WebhookLifecycleRecord }
  | { action: 'creating'; record: WebhookLifecycleRecord };

export type GuardedBeginLifecycleFiringResult =
  | BeginLifecycleFiringResult
  | { action: 'resolved'; record: WebhookLifecycleRecord }
  | { action: 'indeterminate'; record: WebhookLifecycleRecord }
  | { action: 'reconcile'; record: WebhookLifecycleRecord };

export interface WebhookLifecycleStoreFile {
  version: 1;
  records: WebhookLifecycleRecord[];
}

export interface WebhookLifecycleSetupIntent {
  reviewerLarkAppIds: string[];
  workingDir?: string;
  ownerIssues?: string[];
}

export type BeginWebhookLifecycleSetupRepairResult =
  | { action: 'repair'; record: WebhookLifecycleRecord; repairId: string }
  | { action: 'ready'; record: WebhookLifecycleRecord }
  | { action: 'busy'; record: WebhookLifecycleRecord }
  | { action: 'inactive'; record?: WebhookLifecycleRecord };

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
const SETUP_REPAIR_TTL_MS = 30 * 60 * 1000;

function uniqueStrings(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map(value => value.trim()).filter(Boolean)));
}

function creatingExpired(record: WebhookLifecycleRecord, nowMs: number): boolean {
  if (record.indeterminate) return false;
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

export function beginWebhookLifecycleFiring(
  connectorId: string,
  dedupKey: string,
  dataDir?: string,
): Promise<BeginLifecycleFiringResult>;
export function beginWebhookLifecycleFiring(
  connectorId: string,
  dedupKey: string,
  dataDir: string,
  opts: {
    blockResolvedReopen: boolean;
    blockIndeterminateRetry?: boolean;
    adoptIndeterminate?: boolean;
  },
): Promise<GuardedBeginLifecycleFiringResult>;
export async function beginWebhookLifecycleFiring(
  connectorId: string,
  dedupKey: string,
  dataDir: string = config.session.dataDir,
  opts: {
    blockResolvedReopen?: boolean;
    blockIndeterminateRetry?: boolean;
    adoptIndeterminate?: boolean;
  } = {},
): Promise<GuardedBeginLifecycleFiringResult> {
  const fp = storePath(dataDir);
  return withFileLock(fp, async () => {
    const nowMs = Date.now();
    const store = readStore(dataDir);
    const idx = findIndex(store, connectorId, dedupKey);
    const existing = idx >= 0 ? store.records[idx] : undefined;
    if (existing?.status === 'active' && existing.chatId) return { action: 'reuse', record: existing };
    if (existing?.status === 'resolved' && opts.blockResolvedReopen) {
      return { action: 'resolved', record: existing };
    }
    if (existing?.status === 'creating' && existing.indeterminate) {
      if (opts.adoptIndeterminate) return { action: 'reconcile', record: existing };
      if (opts.blockIndeterminateRetry) return { action: 'indeterminate', record: existing };
    }
    if (existing?.status === 'creating' && !creatingExpired(existing, nowMs)) {
      return { action: 'creating', record: existing };
    }
    if (
      existing?.status === 'creating'
      && (opts.blockIndeterminateRetry || opts.adoptIndeterminate)
    ) {
      const indeterminate: WebhookLifecycleRecord = {
        ...existing,
        indeterminate: true,
        indeterminateReason: existing.indeterminateReason ?? 'creating_claim_expired',
        creatingExpiresAt: undefined,
        updatedAt: new Date(nowMs).toISOString(),
      };
      store.records[idx] = indeterminate;
      writeStore(dataDir, store);
      return opts.adoptIndeterminate
        ? { action: 'reconcile', record: indeterminate }
        : { action: 'indeterminate', record: indeterminate };
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

export async function markWebhookLifecycleIndeterminate(
  connectorId: string,
  dedupKey: string,
  lifecycleId: string,
  reason: string,
  dataDir: string = config.session.dataDir,
): Promise<void> {
  const fp = storePath(dataDir);
  await withFileLock(fp, async () => {
    const store = readStore(dataDir);
    const idx = findIndex(store, connectorId, dedupKey);
    const existing = idx >= 0 ? store.records[idx] : undefined;
    if (existing?.lifecycleId !== lifecycleId || existing.status !== 'creating') return;
    store.records[idx] = {
      ...existing,
      indeterminate: true,
      indeterminateReason: reason,
      creatingExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    writeStore(dataDir, store);
  });
}

export async function activateWebhookLifecycleGroup(
  connectorId: string,
  dedupKey: string,
  lifecycleId: string,
  chatId: string,
  opts: {
    creatorLarkAppId?: string;
    setupStatus?: WebhookLifecycleRecord['setupStatus'];
    setup?: WebhookLifecycleSetupIntent;
  } = {},
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
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const setupRepairId = opts.setup ? randomUUID() : undefined;
    const reviewerLarkAppIds = opts.setup
      ? uniqueStrings(opts.setup.reviewerLarkAppIds)
      : existing.setupReviewerLarkAppIds;
    const workingDir = opts.setup?.workingDir?.trim() || existing.setupWorkingDir;
    const ownerIssues = opts.setup
      ? uniqueStrings(opts.setup.ownerIssues)
      : existing.setupOwnerIssues;
    const setupFields = opts.setup
      ? {
        setupStatus: 'repairing' as const,
        setupError: undefined,
        setupIntentVersion: 1 as const,
        setupReviewerLarkAppIds: reviewerLarkAppIds,
        setupReviewersReady: (reviewerLarkAppIds ?? []).length === 0,
        setupWorkingDir: workingDir,
        setupWorkingDirReady: !workingDir,
        setupOwnerIssues: ownerIssues,
        setupRepairId,
        setupRepairExpiresAt: new Date(nowMs + SETUP_REPAIR_TTL_MS).toISOString(),
      }
      : {
        setupStatus: opts.setupStatus,
        setupError: undefined,
      };
    const next: WebhookLifecycleRecord = existing.pendingResolved
      ? {
        ...existing,
        status: 'resolved',
        chatId,
        creatorLarkAppId: opts.creatorLarkAppId,
        creatingExpiresAt: undefined,
        pendingResolved: false,
        indeterminate: false,
        indeterminateReason: undefined,
        ...setupFields,
        setupStatus: opts.setup ? 'degraded' : setupFields.setupStatus,
        setupError: opts.setup ? 'finished_before_setup' : undefined,
        setupRepairId: undefined,
        setupRepairExpiresAt: undefined,
        updatedAt: now,
        resolvedAt: now,
      }
      : {
        ...existing,
        status: 'active',
        chatId,
        creatorLarkAppId: opts.creatorLarkAppId,
        creatingExpiresAt: undefined,
        indeterminate: false,
        indeterminateReason: undefined,
        ...setupFields,
        updatedAt: now,
      };
    store.records[idx] = next;
    writeStore(dataDir, store);
    return { status: next.status === 'resolved' ? 'pending_resolved' : 'active', record: next };
  });
}

function setupRepairExpired(record: WebhookLifecycleRecord, nowMs: number): boolean {
  if (!record.setupRepairExpiresAt) return true;
  const expiresAt = Date.parse(record.setupRepairExpiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs;
}

export async function beginWebhookLifecycleSetupRepair(
  connectorId: string,
  dedupKey: string,
  opts: {
    reviewerLarkAppIds?: string[];
    workingDir?: string;
    acknowledgeOwnerIssues?: boolean;
  } = {},
  dataDir: string = config.session.dataDir,
): Promise<BeginWebhookLifecycleSetupRepairResult> {
  const fp = storePath(dataDir);
  return withFileLock(fp, async () => {
    const store = readStore(dataDir);
    const idx = findIndex(store, connectorId, dedupKey);
    const existing = idx >= 0 ? store.records[idx] : undefined;
    if (!existing || existing.status !== 'active') {
      return { action: 'inactive', record: existing };
    }
    const nowMs = Date.now();
    if (existing.pendingResolved) {
      if (
        existing.setupStatus === 'repairing'
        && existing.setupRepairId
        && !setupRepairExpired(existing, nowMs)
      ) {
        return { action: 'busy', record: existing };
      }
      const now = new Date(nowMs).toISOString();
      const resolved: WebhookLifecycleRecord = {
        ...existing,
        status: 'resolved',
        pendingResolved: false,
        setupStatus: existing.setupStatus === 'repairing' ? 'degraded' : existing.setupStatus,
        setupError: existing.setupStatus === 'repairing'
          ? (existing.setupError ?? 'setup_repair_expired_after_finish')
          : existing.setupError,
        setupRepairId: undefined,
        setupRepairExpiresAt: undefined,
        updatedAt: now,
        resolvedAt: now,
      };
      store.records[idx] = resolved;
      writeStore(dataDir, store);
      return { action: 'inactive', record: resolved };
    }
    if (existing.setupStatus === 'ready') return { action: 'ready', record: existing };
    if (
      existing.setupStatus === 'repairing'
      && existing.setupRepairId
      && !setupRepairExpired(existing, nowMs)
    ) {
      return { action: 'busy', record: existing };
    }

    const repairId = randomUUID();
    const reviewerOverride = opts.reviewerLarkAppIds === undefined
      ? undefined
      : uniqueStrings(opts.reviewerLarkAppIds);
    const workingDirOverride = opts.workingDir?.trim() || undefined;
    const next: WebhookLifecycleRecord = {
      ...existing,
      setupStatus: 'repairing',
      setupIntentVersion: existing.setupIntentVersion
        ?? (reviewerOverride !== undefined || workingDirOverride || opts.acknowledgeOwnerIssues ? 1 : undefined),
      setupReviewerLarkAppIds: reviewerOverride ?? existing.setupReviewerLarkAppIds,
      setupReviewersReady: reviewerOverride === undefined
        ? existing.setupReviewersReady
        : reviewerOverride.length === 0,
      setupWorkingDir: workingDirOverride ?? existing.setupWorkingDir,
      setupWorkingDirReady: workingDirOverride ? false : existing.setupWorkingDirReady,
      setupOwnerIssues: opts.acknowledgeOwnerIssues ? [] : existing.setupOwnerIssues,
      setupRepairId: repairId,
      setupRepairExpiresAt: new Date(nowMs + SETUP_REPAIR_TTL_MS).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    };
    store.records[idx] = next;
    writeStore(dataDir, store);
    return { action: 'repair', record: next, repairId };
  });
}

export async function isWebhookLifecycleSetupRepairCurrent(
  connectorId: string,
  dedupKey: string,
  lifecycleId: string,
  repairId: string,
  dataDir: string = config.session.dataDir,
): Promise<boolean> {
  const fp = storePath(dataDir);
  return withFileLock(fp, async () => {
    const store = readStore(dataDir);
    const idx = findIndex(store, connectorId, dedupKey);
    const existing = idx >= 0 ? store.records[idx] : undefined;
    return existing?.status === 'active'
      && existing.lifecycleId === lifecycleId
      && existing.setupStatus === 'repairing'
      && existing.setupRepairId === repairId
      && !setupRepairExpired(existing, Date.now());
  });
}

export async function completeWebhookLifecycleSetupRepair(
  connectorId: string,
  dedupKey: string,
  lifecycleId: string,
  repairId: string,
  result: {
    error?: string;
    reviewersReady?: boolean;
    workingDirReady?: boolean;
    ownerIssues?: string[];
  },
  dataDir: string = config.session.dataDir,
): Promise<{ status: 'active' | 'pending_resolved' | 'stale'; record?: WebhookLifecycleRecord }> {
  const fp = storePath(dataDir);
  return withFileLock(fp, async () => {
    const store = readStore(dataDir);
    const idx = findIndex(store, connectorId, dedupKey);
    const existing = idx >= 0 ? store.records[idx] : undefined;
    if (
      !existing
      || existing.status !== 'active'
      || existing.lifecycleId !== lifecycleId
      || existing.setupStatus !== 'repairing'
      || existing.setupRepairId !== repairId
    ) {
      return { status: 'stale' };
    }

    const reviewersReady = result.reviewersReady ?? existing.setupReviewersReady ?? false;
    const workingDirReady = result.workingDirReady ?? existing.setupWorkingDirReady ?? false;
    const ownerIssues = result.ownerIssues === undefined
      ? uniqueStrings(existing.setupOwnerIssues)
      : uniqueStrings(result.ownerIssues);
    const setupError = result.error?.trim() || undefined;
    const setupReady = !setupError
      && existing.setupIntentVersion === 1
      && reviewersReady
      && workingDirReady
      && ownerIssues.length === 0;
    const now = new Date().toISOString();
    const next: WebhookLifecycleRecord = {
      ...existing,
      status: existing.pendingResolved ? 'resolved' : 'active',
      pendingResolved: false,
      setupStatus: setupReady ? 'ready' : 'degraded',
      setupError,
      setupReviewersReady: reviewersReady,
      setupWorkingDirReady: workingDirReady,
      setupOwnerIssues: ownerIssues,
      setupRepairId: undefined,
      setupRepairExpiresAt: undefined,
      updatedAt: now,
      resolvedAt: existing.pendingResolved ? now : existing.resolvedAt,
    };
    store.records[idx] = next;
    writeStore(dataDir, store);
    return {
      status: next.status === 'resolved' ? 'pending_resolved' : 'active',
      record: next,
    };
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
    const nowMs = Date.now();
    const waitsForActivation = existing.status === 'creating' && !existing.indeterminate;
    const waitsForSetup = existing.status === 'active'
      && existing.setupStatus === 'repairing'
      && !!existing.setupRepairId
      && !setupRepairExpired(existing, nowMs);
    const waitsForCompletion = waitsForActivation || waitsForSetup;
    const abandonedSetup = existing.status === 'active'
      && existing.setupStatus === 'repairing'
      && !waitsForSetup;
    const next: WebhookLifecycleRecord = waitsForCompletion
      ? { ...existing, pendingResolved: true, updatedAt: now }
      : {
        ...existing,
        status: 'resolved',
        indeterminate: false,
        indeterminateReason: undefined,
        setupStatus: abandonedSetup ? 'degraded' : existing.setupStatus,
        setupError: abandonedSetup
          ? (existing.setupError ?? 'setup_repair_expired_after_finish')
          : existing.setupError,
        setupRepairId: abandonedSetup ? undefined : existing.setupRepairId,
        setupRepairExpiresAt: abandonedSetup ? undefined : existing.setupRepairExpiresAt,
        updatedAt: now,
        resolvedAt: now,
      };
    store.records[idx] = next;
    writeStore(dataDir, store);
    return { action: waitsForCompletion ? 'pending' : 'close', record: next };
  });
}
