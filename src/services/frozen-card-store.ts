/**
 * Frozen card store — persists historical streaming card state per session.
 * Each session's frozen cards are stored in {dataDir}/frozen-cards/{sessionId}.json.
 * Uses atomic writes (tmp + rename) consistent with session-store.ts.
 */
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { isJsonObject, readJsonFileSoft } from '../utils/json-file.js';
import type { FrozenCard } from '../core/types.js';

function getDir(): string {
  return join(config.session.dataDir, 'frozen-cards');
}

function getFilePath(sessionId: string): string {
  return join(getDir(), `${sessionId}.json`);
}

function ensureDir(): void {
  const dir = getDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Load frozen cards for a session. Returns a Map<nonce, FrozenCard>. */
export function loadFrozenCards(sessionId: string): Map<string, FrozenCard> {
  // 损坏的文件被隔离为 .corrupt-*（而不是被下一次 saveFrozenCards 覆盖），见 utils/json-file.ts。
  const data = readJsonFileSoft<Record<string, FrozenCard>>(getFilePath(sessionId), {
    fallback: () => ({}),
    validate: isJsonObject,
    label: 'frozen-card-store',
  });
  return new Map(Object.entries(data));
}

/** Save frozen cards for a session to disk. */
export function saveFrozenCards(sessionId: string, cards: Map<string, FrozenCard>): void {
  ensureDir();
  const fp = getFilePath(sessionId);
  if (cards.size === 0) {
    // No cards — remove file if it exists
    try { if (existsSync(fp)) unlinkSync(fp); } catch { /* ignore */ }
    return;
  }
  const obj: Record<string, FrozenCard> = {};
  for (const [k, v] of cards) {
    obj[k] = v;
  }
  atomicWriteFileSync(fp, JSON.stringify(obj, null, 2), { followTargetSymlink: false });
}

/** Delete frozen cards file for a session (called on session close). */
export function deleteFrozenCards(sessionId: string): void {
  const fp = getFilePath(sessionId);
  try { if (existsSync(fp)) unlinkSync(fp); } catch { /* ignore */ }
}
