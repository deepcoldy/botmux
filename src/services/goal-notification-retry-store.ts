import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import type { GoalDecisionOption } from './goal-decision-options.js';

export type GoalNotificationRetryKind = 'human-attention' | 'completion-confirm';

export interface GoalNotificationRetryRecord {
  id: string;
  ownerLarkAppId: string;
  kind: GoalNotificationRetryKind;
  status?: 'pending' | 'dead';
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
  decisionOptions?: GoalDecisionOption[];
  done?: boolean;
  ownerOpenId?: string;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  deadAt?: number;
  deadReason?: string;
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
    status: record.status ?? (prev?.status === 'dead' ? 'dead' : 'pending'),
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
    .filter((r) => (r.status ?? 'pending') !== 'dead' && r.ownerLarkAppId === ownerLarkAppId && r.nextAttemptAt <= now)
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
}

export function listGoalNotificationRetries(): GoalNotificationRetryRecord[] {
  return Object.values(loadAll())
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
}

export function markGoalNotificationRetryAttempt(id: string, input: { attempts: number; nextAttemptAt: number; lastError?: string }): void {
  const all = loadAll();
  const prev = all[id];
  if (!prev) return;
  all[id] = {
    ...prev,
    status: 'pending',
    attempts: input.attempts,
    nextAttemptAt: input.nextAttemptAt,
    lastError: input.lastError,
    updatedAt: Date.now(),
  };
  saveAll(all);
}

export function markGoalNotificationRetryDead(id: string, input: { reason: string; lastError?: string; now?: number }): GoalNotificationRetryRecord | null {
  const all = loadAll();
  const prev = all[id];
  if (!prev) return null;
  const now = input.now ?? Date.now();
  const next: GoalNotificationRetryRecord = {
    ...prev,
    status: 'dead',
    deadAt: now,
    deadReason: input.reason,
    lastError: input.lastError ?? prev.lastError,
    updatedAt: now,
  };
  all[id] = next;
  saveAll(all);
  return next;
}

export function retryGoalNotification(id: string, now = Date.now()): GoalNotificationRetryRecord | null {
  const all = loadAll();
  const prev = all[id];
  if (!prev) return null;
  const next: GoalNotificationRetryRecord = {
    ...prev,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    deadAt: undefined,
    deadReason: undefined,
    updatedAt: now,
  };
  all[id] = next;
  saveAll(all);
  return next;
}
