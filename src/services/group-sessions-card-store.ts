/** Durable newest-card pointer for `/sessions`, scoped to one caller in one group. */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

interface GroupSessionsCardRecord {
  messageId: string;
  updatedAt: number;
}

type GroupSessionsCardStore = Record<string, GroupSessionsCardRecord>;

function storePath(dataDir: string): string {
  return join(dataDir, 'group-sessions-cards.json');
}

function cardKey(larkAppId: string, chatId: string, invokerOpenId: string): string {
  return JSON.stringify([larkAppId, chatId, invokerOpenId]);
}

function readStore(path: string): GroupSessionsCardStore {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const valid: GroupSessionsCardStore = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Partial<GroupSessionsCardRecord>;
      if (typeof record.messageId !== 'string' || !record.messageId) continue;
      if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) continue;
      valid[key] = { messageId: record.messageId, updatedAt: record.updatedAt };
    }
    return valid;
  } catch {
    return {};
  }
}

/** Atomically publish the latest `/sessions` card and return its predecessor. */
export function replaceLatestGroupSessionsCard(
  dataDir: string,
  larkAppId: string,
  chatId: string,
  invokerOpenId: string,
  messageId: string,
  nowMs: number = Date.now(),
): string | undefined {
  mkdirSync(dataDir, { recursive: true });
  const path = storePath(dataDir);
  return withFileLockSync(path, () => {
    const store = readStore(path);
    const key = cardKey(larkAppId, chatId, invokerOpenId);
    const previous = store[key]?.messageId;
    store[key] = { messageId, updatedAt: nowMs };
    atomicWriteFileSync(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    return previous;
  });
}
