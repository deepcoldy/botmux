// src/services/session-message-store.ts
//
// Local per-session message archive — the durable record behind the dashboard
// chat console (and any future IM-agnostic reader).
//
// Why this exists: Feishu history (`/api/sessions/:id/history`) is a live pull
// from the Lark API — it breaks when the bot loses chat visibility, and it is
// the only message source today. This store keeps an append-only local copy of
// every turn (user input + bot final reply) so the dashboard can render the
// full conversation even when Lark is unreachable, and so replies that were
// suppressed from Feishu (`suppressFinalOutput` console turns) still surface
// in the UI.
//
// Layout: one JSONL file per session under `<dataDir>/messages/<sessionId>.jsonl`.
// Rows are self-describing and append-only; nothing in this store is ever
// rewritten in place. A malformed trailing row (concurrent write / crash) is
// skipped on read and overwritten on the next append.
//
// Message shape:
//   { seq, role: 'user'|'bot', content, senderId?, senderName?, turnId?,
//     messageId?, createTime (epoch ms) }

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface SessionMessage {
  seq: number;
  role: 'user' | 'bot';
  content: string;
  senderId?: string;
  senderName?: string;
  /** Daemon-side turn id (Lark message_id for IM turns, synthetic for console turns). */
  turnId?: string;
  /** Feishu message_id when the message originated from Lark; absent for console turns. */
  messageId?: string;
  /** Epoch ms. */
  createTime: number;
}

export interface ListSessionMessagesOptions {
  /** Return the most recent N messages (default 100, max 500). */
  limit?: number;
  /** Return only messages with seq < beforeSeq (cursor for older pages). */
  beforeSeq?: number;
}

const READ_TAIL_BYTES = 256 * 1024;
const READ_TAIL_ROWS = 2_000;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 100;
const MAX_CONTENT_BYTES = 256 * 1024;

function messagesDir(): string {
  return join(config.session.dataDir, 'messages');
}

function messageFilePath(sessionId: string): string {
  return join(messagesDir(), `${sessionId}.jsonl`);
}

function safeSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function safeRole(value: unknown): 'user' | 'bot' | null {
  return value === 'user' || value === 'bot' ? value : null;
}

function parseRow(line: string, fallbackSeq: number): SessionMessage | null {
  try {
    const raw = JSON.parse(line);
    if (!raw || typeof raw !== 'object') return null;
    const role = safeRole(raw.role);
    if (!role) return null;
    const content = typeof raw.content === 'string' ? raw.content : '';
    if (!content) return null;
    const seq = safeSeq(raw.seq) ?? fallbackSeq;
    const createTime = typeof raw.createTime === 'number' && Number.isFinite(raw.createTime)
      ? raw.createTime
      : Date.now();
    return {
      seq,
      role,
      content,
      ...(typeof raw.senderId === 'string' && raw.senderId ? { senderId: raw.senderId } : {}),
      ...(typeof raw.senderName === 'string' && raw.senderName ? { senderName: raw.senderName } : {}),
      ...(typeof raw.turnId === 'string' && raw.turnId ? { turnId: raw.turnId } : {}),
      ...(typeof raw.messageId === 'string' && raw.messageId ? { messageId: raw.messageId } : {}),
      createTime,
    };
  } catch {
    return null;
  }
}

/** Read the bounded JSONL tail, newest-first, skipping malformed rows. */
function readTailNewestFirst(path: string): SessionMessage[] {
  if (!existsSync(path)) return [];
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    const size = stat.size;
    if (size <= 0) return [];
    const length = Math.min(size, READ_TAIL_BYTES);
    const start = size - length;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    const rows: SessionMessage[] = [];
    let fallbackSeq = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const row = parseRow(line, fallbackSeq);
      if (row) {
        rows.push(row);
        if (row.seq >= fallbackSeq) fallbackSeq = row.seq + 1;
      }
    }
    return rows.reverse();
  } catch (err) {
    logger.warn(`[session-messages] read failed ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

/**
 * Append one message to the session archive. `seq` is derived from the file
 * tail at write time (callers never pass it). Content is length-capped so a
 * runaway CLI reply cannot balloon the archive. Returns the persisted message
 * (with seq), or null on write failure / duplicate (`dedupeKey` already seen).
 */
export function appendSessionMessage(
  sessionId: string,
  input: Omit<SessionMessage, 'seq' | 'createTime'> & { createTime?: number },
  dedupeKey?: string,
): SessionMessage | null {
  if (!sessionId || /[^A-Za-z0-9_-]/.test(sessionId)) {
    logger.warn(`[session-messages] refused append for unsafe sessionId ${JSON.stringify(sessionId)}`);
    return null;
  }
  const content = String(input.content ?? '').slice(0, MAX_CONTENT_BYTES);
  if (!content.trim()) return null;
  const path = messageFilePath(sessionId);
  try {
    mkdirSync(messagesDir(), { recursive: true });
  } catch (err) {
    logger.warn(`[session-messages] mkdir failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const tail = readTailNewestFirst(path);
  // Dedupe: if the caller supplied a dedupe key (e.g. turnId for bot replies)
  // and the tail already contains a row with the same key, skip the append.
  // The tail window is bounded but turn replies are written sequentially per
  // session, so a replay of the SAME turn always lands inside the window.
  if (dedupeKey) {
    const seen = tail.some(m => (m.turnId ?? m.messageId) === dedupeKey);
    if (seen) return null;
  }
  const nextSeq = (tail.length > 0 && tail[0]?.seq !== undefined ? tail[0].seq : -1) + 1;
  const message: SessionMessage = {
    seq: nextSeq,
    role: input.role,
    content,
    ...(input.senderId ? { senderId: input.senderId } : {}),
    ...(input.senderName ? { senderName: input.senderName } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    createTime: input.createTime ?? Date.now(),
  };
  try {
    appendFileSync(path, `${JSON.stringify(message)}\n`, 'utf8');
    return message;
  } catch (err) {
    logger.warn(`[session-messages] append failed ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * List archived messages for a session, newest-first, with a `beforeSeq`
 * cursor for paging into older history.
 */
export function listSessionMessages(
  sessionId: string,
  options: ListSessionMessagesOptions = {},
): SessionMessage[] {
  const limit = Math.min(
    Math.max(Number.isFinite(options.limit) ? Math.floor(options.limit!) : DEFAULT_LIST_LIMIT, 1),
    MAX_LIST_LIMIT,
  );
  const beforeSeq = options.beforeSeq !== undefined && Number.isFinite(options.beforeSeq)
    ? Math.floor(options.beforeSeq)
    : undefined;
  const all = readTailNewestFirst(messageFilePath(sessionId));
  const filtered = beforeSeq !== undefined ? all.filter(m => m.seq < beforeSeq) : all;
  return filtered.slice(0, limit);
}

/** Total archived message count for a session (used for "load older" affordance). */
export function countSessionMessages(sessionId: string): number {
  const path = messageFilePath(sessionId);
  if (!existsSync(path)) return 0;
  let count = 0;
  try {
    const tail = readTailNewestFirst(path);
    if (tail.length > 0) count = tail[0].seq + 1;
  } catch { /* best effort */ }
  return count;
}

/** True when the archive has any row for this session. */
export function hasSessionMessages(sessionId: string): boolean {
  const path = messageFilePath(sessionId);
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  return stat.size > 0;
}

/** Test-only helper: wipe one session's archive (mirrors session-store delete). */
export function deleteSessionMessages(sessionId: string): void {
  try {
    const path = messageFilePath(sessionId);
    if (existsSync(path)) writeFileSync(path, '', 'utf8');
  } catch { /* best effort */ }
}
