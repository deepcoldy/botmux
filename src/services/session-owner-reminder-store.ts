import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import type {
  SessionOwnerReminderRecord,
  SessionOwnerReminderRecords,
} from '../core/session-owner-reminder.js';

function safeAppId(appId: string): string {
  return /^[A-Za-z0-9_-]+$/.test(appId) ? appId : Buffer.from(appId).toString('base64url');
}

export function sessionOwnerReminderStorePath(dataDir: string, appId: string): string {
  return join(dataDir, `session-owner-reminders-${safeAppId(appId)}.json`);
}

function normalizeRecord(sessionId: string, raw: unknown): SessionOwnerReminderRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.sessionId !== sessionId
    || typeof value.stateFingerprint !== 'string'
    || !Number.isFinite(value.actionableSince)
    || !Number.isFinite(value.lastObservedActivityAt)) return undefined;
  const record: SessionOwnerReminderRecord = {
    sessionId,
    stateFingerprint: value.stateFingerprint,
    actionableSince: value.actionableSince as number,
    lastObservedActivityAt: value.lastObservedActivityAt as number,
  };
  for (const key of ['lastRemindedAt', 'retryAfterAt'] as const) {
    if (Number.isFinite(value[key])) record[key] = value[key] as number;
  }
  return record;
}

export function loadSessionOwnerReminderRecords(dataDir: string, appId: string): SessionOwnerReminderRecords {
  const path = sessionOwnerReminderStorePath(dataDir, appId);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const records: SessionOwnerReminderRecords = {};
    for (const [sessionId, value] of Object.entries(raw as Record<string, unknown>)) {
      const record = normalizeRecord(sessionId, value);
      if (record) records[sessionId] = record;
    }
    return records;
  } catch {
    return {};
  }
}

export function saveSessionOwnerReminderRecords(
  dataDir: string,
  appId: string,
  records: SessionOwnerReminderRecords,
): void {
  atomicWriteFileSync(
    sessionOwnerReminderStorePath(dataDir, appId),
    `${JSON.stringify(records, null, 2)}\n`,
    { mode: 0o600, followTargetSymlink: false },
  );
}
