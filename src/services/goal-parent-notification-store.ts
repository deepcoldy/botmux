import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import type { GoalDecisionOption } from './goal-decision-options.js';

export interface GoalParentNotificationRecord {
  messageId: string;
  larkAppId: string;
  parentChatId: string;
  parentRoot?: string;
  parentSessionId?: string;
  supervisorSessionId?: string;
  goalChatId: string;
  goalTitle?: string;
  taskId?: string;
  taskTitle?: string;
  summary: string;
  attentionKind?: string;
  attentionReason?: string;
  decisionOptions?: GoalDecisionOption[];
  done?: boolean;
  createdAt: number;
}

const MAX_RECORDS = 1000;

function storePath(): string {
  return join(config.session.dataDir, 'goal-parent-notifications.json');
}

function ensureDir(): void {
  mkdirSync(config.session.dataDir, { recursive: true });
}

function loadAll(): Record<string, GoalParentNotificationRecord> {
  const fp = storePath();
  if (!existsSync(fp)) return {};
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, GoalParentNotificationRecord>;
  } catch (err) {
    logger.warn(`[goal-parent-notification-store] failed to read store: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function saveAll(records: Record<string, GoalParentNotificationRecord>): void {
  ensureDir();
  const entries = Object.entries(records)
    .sort((a, b) => (b[1].createdAt ?? 0) - (a[1].createdAt ?? 0))
    .slice(0, MAX_RECORDS);
  atomicWriteFileSync(storePath(), JSON.stringify(Object.fromEntries(entries), null, 2));
}

export function rememberGoalParentNotification(record: GoalParentNotificationRecord): void {
  const all = loadAll();
  all[record.messageId] = record;
  saveAll(all);
}

export function getGoalParentNotification(messageId: string | undefined): GoalParentNotificationRecord | undefined {
  if (!messageId) return undefined;
  return loadAll()[messageId];
}
