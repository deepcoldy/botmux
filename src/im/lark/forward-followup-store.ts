import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { logger } from '../../utils/logger.js';

export interface PersistedForwardFollowup<T = unknown> {
  messageId: string;
  dueAt: number;
  payload: T;
}

function fileFor(larkAppId: string): string {
  return join(config.session.dataDir, 'pending', `forward-followups-${larkAppId}.json`);
}

export function listForwardFollowups<T = unknown>(larkAppId: string): PersistedForwardFollowup<T>[] {
  const file = fileFor(larkAppId);
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(record =>
      record
      && typeof record.messageId === 'string'
      && typeof record.dueAt === 'number'
      && record.payload != null,
    ) as PersistedForwardFollowup<T>[];
  } catch (err) {
    logger.warn(`[forward-followup-store] load failed (${file}): ${err}`);
    return [];
  }
}

function writeForwardFollowups<T>(larkAppId: string, records: PersistedForwardFollowup<T>[]): void {
  const file = fileFor(larkAppId);
  try {
    mkdirSync(dirname(file), { recursive: true });
    atomicWriteFileSync(file, JSON.stringify(records));
  } catch (err) {
    throw new Error(`persist forward follow-up failed (${file}): ${err}`);
  }
}

export function putForwardFollowup<T>(larkAppId: string, record: PersistedForwardFollowup<T>): void {
  const records = listForwardFollowups<T>(larkAppId).filter(item => item.messageId !== record.messageId);
  records.push(record);
  writeForwardFollowups(larkAppId, records);
}

export function removeForwardFollowup(larkAppId: string, messageId: string): void {
  const records = listForwardFollowups(larkAppId);
  if (!records.some(item => item.messageId === messageId)) return;
  writeForwardFollowups(larkAppId, records.filter(item => item.messageId !== messageId));
}
