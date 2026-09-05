import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface SubjectListenerCursor {
  messageId: string;
  /** Lark message create_time, represented as an integer string. */
  createTime: string;
}

const CURSOR_DIRECTORY = 'subject-listener-cursors';

function cursorRoot(dataDir: string): string {
  return join(dataDir, CURSOR_DIRECTORY);
}

function keyDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Stable per-(bot, chat) path without placing provider-controlled ids in a path. */
export function subjectListenerCursorPath(dataDir: string, larkAppId: string, chatId: string): string {
  return join(cursorRoot(dataDir), keyDigest(larkAppId), `${keyDigest(chatId)}.json`);
}

function normalizeCursor(raw: unknown): SubjectListenerCursor | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const messageId = typeof value.messageId === 'string' ? value.messageId.trim() : '';
  const createTime = typeof value.createTime === 'string' ? value.createTime.trim() : '';
  if (!messageId || !/^\d+$/.test(createTime)) return undefined;
  return { messageId, createTime };
}

/** Compare non-negative integer timestamps without Number precision loss. */
export function compareSubjectListenerCreateTime(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '');
  const normalizedRight = right.replace(/^0+(?=\d)/, '');
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

/** Corrupt, partially migrated, or absent state is deliberately fail-open. */
export function readSubjectListenerCursor(
  dataDir: string,
  larkAppId: string,
  chatId: string,
): SubjectListenerCursor | undefined {
  const filePath = subjectListenerCursorPath(dataDir, larkAppId, chatId);
  if (!existsSync(filePath)) return undefined;
  try {
    return normalizeCursor(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Persist a cursor only when its createTime is strictly newer. Equal time is
 * idempotent only for the same message id; without a provider ordering signal,
 * a different id at the same time must retain the durable current cursor.
 */
export function commitSubjectListenerCursor(
  dataDir: string,
  larkAppId: string,
  chatId: string,
  candidate: SubjectListenerCursor,
): SubjectListenerCursor {
  const normalized = normalizeCursor(candidate);
  if (!normalized) throw new Error('Invalid Subject listener cursor');

  const current = readSubjectListenerCursor(dataDir, larkAppId, chatId);
  if (current) {
    const createTimeOrder = compareSubjectListenerCreateTime(normalized.createTime, current.createTime);
    if (createTimeOrder < 0 || createTimeOrder === 0) return current;
  }

  const filePath = subjectListenerCursorPath(dataDir, larkAppId, chatId);
  mkdirSync(join(cursorRoot(dataDir), keyDigest(larkAppId)), { recursive: true });
  atomicWriteFileSync(filePath, `${JSON.stringify(normalized)}\n`, {
    durable: true,
    mode: 0o600,
    followTargetSymlink: false,
  });
  return normalized;
}

/** Test-only cleanup, scoped to the caller's explicit dataDir. */
export function __resetSubjectListenerCursorStoreForTests(dataDir: string): void {
  rmSync(cursorRoot(dataDir), { recursive: true, force: true });
}
