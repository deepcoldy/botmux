import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type { Session } from '../types.js';

const PREVIEW_TAIL_BYTES = 64 * 1024;
const PREVIEW_TAIL_ROWS = 40;
const USER_PREVIEW_LENGTH = 120;
const BOT_PREVIEW_LENGTH = 220;
const FULL_PREVIEW_LENGTH = 4_000;

type JsonRow = Record<string, unknown>;

export interface SessionMessagePreview {
  previewUserText?: string;
  previewBotText?: string;
  previewUserFullText?: string;
  previewBotFullText?: string;
  previewUserAt?: number;
  previewBotAt?: number;
  previewBotState?: 'replied' | 'waiting';
}

function compactText(value: unknown, limit: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Read a bounded JSONL tail. A partial first line is discarded when the file
 * is larger than the read window; malformed/truncated rows are skipped. */
function readJsonlTail(path: string, limit = PREVIEW_TAIL_ROWS): JsonRow[] {
  if (!existsSync(path)) return [];
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size <= 0) return [];
    const length = Math.min(size, PREVIEW_TAIL_BYTES);
    const start = size - length;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    const rows: JsonRow[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed);
      } catch {
        // Best-effort presentation data: skip malformed or concurrently-written rows.
      }
    }
    return rows.slice(-limit);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function sessionActivityAt(session: Session): number | undefined {
  const value = session.lastMessageAt ?? session.createdAt;
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeJsonlKey(value: unknown): string | undefined {
  const key = String(value ?? '');
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : undefined;
}

/**
 * Build the latest user/bot exchange shown on dashboard session cards.
 *
 * User text comes from the local inbound queue (with persisted lastUserPrompt
 * as a fallback). Bot text comes from the append-only turn-sends marker written
 * by `botmux send`. Both reads are bounded and best-effort so a corrupt marker
 * cannot break `/api/sessions`.
 */
export function buildSessionMessagePreview(session: Session): SessionMessagePreview {
  const queueAnchor = session.deferredScheduleRun?.routingAnchor
    ?? (session.scope === 'chat' ? session.chatId : session.rootMessageId);
  const safeQueueAnchor = safeJsonlKey(queueAnchor);
  const queueRows = safeQueueAnchor
    ? readJsonlTail(join(config.session.dataDir, 'queues', `${safeQueueAnchor}.jsonl`))
    : [];
  const latestUser = queueRows.filter(row => row.senderType === 'user').at(-1);

  const safeSessionId = safeJsonlKey(session.sessionId);
  const markerRows = safeSessionId
    ? readJsonlTail(join(config.session.dataDir, 'turn-sends', `${safeSessionId}.jsonl`))
    : [];
  const latestBot = markerRows
    .filter(row => typeof row.sentAtMs === 'number' && typeof row.previewText === 'string')
    .at(-1);

  const userFullText = compactText(
    latestUser?.content ?? session.lastUserPrompt ?? '',
    FULL_PREVIEW_LENGTH,
  );
  const botFullText = compactText(latestBot?.previewText ?? '', FULL_PREVIEW_LENGTH);
  const previewUserAt = userFullText
    ? (numberOrUndefined(latestUser?.createTime) ?? sessionActivityAt(session))
    : undefined;
  const previewBotAt = numberOrUndefined(latestBot?.sentAtMs);

  let previewBotState: SessionMessagePreview['previewBotState'];
  if (previewBotAt) {
    previewBotState = !previewUserAt || previewBotAt >= previewUserAt ? 'replied' : 'waiting';
  } else if (previewUserAt) {
    previewBotState = 'waiting';
  }

  return {
    previewUserText: compactText(userFullText, USER_PREVIEW_LENGTH) || undefined,
    previewBotText: compactText(botFullText, BOT_PREVIEW_LENGTH) || undefined,
    previewUserFullText: userFullText || undefined,
    previewBotFullText: botFullText || undefined,
    previewUserAt,
    previewBotAt,
    previewBotState,
  };
}
