import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

const HEALTH_DIR = 'group-context-health';
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_APP_ID_LENGTH = 512;
const pendingChecks = new Map<string, Promise<void>>();
const REASONS = new Set([
  'subscribed',
  'update_submitted',
  'readback_incomplete',
  'session_unavailable',
  'skipped_brand',
  'error',
]);

export interface GroupContextRecallStatus {
  covered: boolean;
  reason: string;
  updateSubmitted: boolean;
  checkedAt: number;
  stale: boolean;
}

interface StoredRecallStatus {
  schemaVersion: 1;
  covered: boolean;
  reason: string;
  updateSubmitted: boolean;
  checkedAt: number;
}

const UNKNOWN_STATUS: GroupContextRecallStatus = {
  covered: false,
  reason: 'unknown',
  updateSubmitted: false,
  checkedAt: 0,
  stale: true,
};

function validAppId(appId: string): boolean {
  return typeof appId === 'string' && appId.trim().length > 0 && appId.length <= MAX_APP_ID_LENGTH;
}

function statusPath(appId: string, dataDir: string): string | undefined {
  if (!validAppId(appId)) return undefined;
  const digest = createHash('sha256').update(appId, 'utf8').digest('hex');
  return join(dataDir, HEALTH_DIR, `${digest}.json`);
}

function normalizeReason(reason: unknown): string {
  return typeof reason === 'string' && REASONS.has(reason) ? reason : 'unknown';
}

function defaultStatus(): GroupContextRecallStatus {
  return { ...UNKNOWN_STATUS };
}

export function recordGroupContextRecallStatus(
  appId: string,
  status: { covered: boolean; reason: string; updateSubmitted: boolean },
  dataDir: string = config.session.dataDir,
): void {
  try {
    const path = statusPath(appId, dataDir);
    if (!path || !status || typeof status !== 'object') return;
    const reason = normalizeReason(status.reason);
    const updateSubmitted = status.updateSubmitted === true;
    const record: StoredRecallStatus = {
      schemaVersion: 1,
      covered: status.covered === true && reason === 'subscribed' && !updateSubmitted,
      reason,
      updateSubmitted,
      checkedAt: Date.now(),
    };
    mkdirSync(join(dataDir, HEALTH_DIR), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
      followTargetSymlink: false,
    });
  } catch {
    // Startup health persistence must never break the original daemon route.
  }
}

export function readGroupContextRecallStatus(
  appId: string,
  dataDir: string = config.session.dataDir,
): GroupContextRecallStatus {
  try {
    const path = statusPath(appId, dataDir);
    if (!path || !existsSync(path)) return defaultStatus();
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultStatus();
    const record = parsed as Partial<StoredRecallStatus>;
    if (
      record.schemaVersion !== 1
      || typeof record.covered !== 'boolean'
      || typeof record.updateSubmitted !== 'boolean'
      || !Number.isFinite(record.checkedAt)
      || (record.checkedAt as number) <= 0
    ) return defaultStatus();
    const reason = normalizeReason(record.reason);
    const checkedAt = record.checkedAt as number;
    const stale = Date.now() - checkedAt > STATUS_TTL_MS;
    return {
      covered: !stale && record.covered === true && reason === 'subscribed' && !record.updateSubmitted,
      reason,
      updateSubmitted: record.updateSubmitted,
      checkedAt,
      stale,
    };
  } catch {
    return defaultStatus();
  }
}

export function groupContextRecallGap(
  appId: string,
  dataDir: string = config.session.dataDir,
): string | undefined {
  const status = readGroupContextRecallStatus(appId, dataDir);
  if (status.covered) return undefined;
  if (status.stale) return 'message_recalled subscription status is stale';
  if (status.reason === 'update_submitted' || status.updateSubmitted) {
    return 'message_recalled subscription update pending publication';
  }
  if (status.reason === 'unknown') return 'message_recalled subscription status is unknown';
  return `message_recalled subscription gap: ${status.reason}`;
}

/** Call only for an enabled group; never launches a model or blocks its input. */
export function ensureGroupContextRecallHealth(
  appId: string,
  check: () => Promise<{ covered: boolean; reason: string; updateSubmitted: boolean }>,
  dataDir: string = config.session.dataDir,
): Promise<void> {
  const key = statusPath(appId, dataDir);
  if (!key) return Promise.resolve();
  const pending = pendingChecks.get(key);
  if (pending) return pending;
  const current = readGroupContextRecallStatus(appId, dataDir);
  if (!current.stale && Date.now() - current.checkedAt < 10 * 60_000) return Promise.resolve();
  const task = Promise.resolve().then(check).then(status => {
    recordGroupContextRecallStatus(appId, status, dataDir);
  }, () => {
    recordGroupContextRecallStatus(appId, { covered: false, reason: 'error', updateSubmitted: false }, dataDir);
  }).finally(() => { if (pendingChecks.get(key) === task) pendingChecks.delete(key); });
  pendingChecks.set(key, task);
  return task;
}
