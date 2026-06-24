import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

export type GoalNotificationRetryKind = 'human-attention' | 'completion-confirm';

export interface GoalNotificationRetryRecord {
  id: string;
  ownerLarkAppId: string;
  kind: GoalNotificationRetryKind;
  candidates: string[];
  parentChatId: string;
  parentRoot?: string;
  parentSessionId?: string;
  supervisorSessionId?: string;
  goalChatId: string;
  goalTitle?: string;
  taskId?: string;
  summary: string;
  attentionKind?: string;
  attentionReason?: string;
  done?: boolean;
  ownerOpenId?: string;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

const MAX_RECORDS = 500;

function storePath(): string {
  return join(config.session.dataDir, 'goal-notification-retries.json');
}

function loadAll(): Record<string, GoalNotificationRetryRecord> {
  const fp = storePath();
  if (!existsSync(fp)) return {};
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, GoalNotificationRetryRecord>;
  } catch (err) {
    logger.warn(`[goal-notification-retry-store] failed to read store: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function saveAll(records: Record<string, GoalNotificationRetryRecord>): void {
  mkdirSync(config.session.dataDir, { recursive: true });
  const entries = Object.entries(records)
    .sort((a, b) => (b[1].updatedAt ?? b[1].createdAt ?? 0) - (a[1].updatedAt ?? a[1].createdAt ?? 0))
    .slice(0, MAX_RECORDS);
  atomicWriteFileSync(storePath(), JSON.stringify(Object.fromEntries(entries), null, 2));
}

export function upsertGoalNotificationRetry(record: Omit<GoalNotificationRetryRecord, 'attempts' | 'createdAt' | 'updatedAt'> & Partial<Pick<GoalNotificationRetryRecord, 'attempts' | 'createdAt' | 'updatedAt'>>): GoalNotificationRetryRecord {
  const all = loadAll();
  const now = Date.now();
  const prev = all[record.id];
  const next: GoalNotificationRetryRecord = {
    ...record,
    attempts: record.attempts ?? prev?.attempts ?? 0,
    createdAt: record.createdAt ?? prev?.createdAt ?? now,
    updatedAt: record.updatedAt ?? now,
  };
  all[next.id] = next;
  saveAll(all);
  return next;
}

export function removeGoalNotificationRetry(id: string): void {
  const all = loadAll();
  if (!all[id]) return;
  delete all[id];
  saveAll(all);
}

export function listDueGoalNotificationRetries(ownerLarkAppId: string, now = Date.now()): GoalNotificationRetryRecord[] {
  return Object.values(loadAll())
    .filter((r) => r.ownerLarkAppId === ownerLarkAppId && r.nextAttemptAt <= now)
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
}

export function markGoalNotificationRetryAttempt(id: string, input: { attempts: number; nextAttemptAt: number; lastError?: string }): void {
  const all = loadAll();
  const prev = all[id];
  if (!prev) return;
  all[id] = {
    ...prev,
    attempts: input.attempts,
    nextAttemptAt: input.nextAttemptAt,
    lastError: input.lastError,
    updatedAt: Date.now(),
  };
  saveAll(all);
}
