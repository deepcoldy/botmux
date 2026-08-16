import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type { Session } from '../types.js';
import { BoundedMap } from '../utils/bounded-map.js';

const PREVIEW_TAIL_BYTES = 64 * 1024;
const PREVIEW_TAIL_ROWS = 40;
const USER_PREVIEW_LENGTH = 120;
const BOT_PREVIEW_LENGTH = 220;
const FULL_PREVIEW_LENGTH = 4_000;
const PREVIEW_FILE_CACHE_MAX_ENTRIES = 2_048;

type JsonRow = Record<string, unknown>;
type PreviewRowKind = 'bot' | 'user';
type PreviewFileCacheEntry = {
  mtimeMs: number;
  row?: JsonRow;
  size: number;
};

/** Dashboard snapshots may compose hundreds of rows at once. Keep parsed tails
 * behind a bounded stat-keyed cache so an unchanged `/api/sessions` refresh
 * does not synchronously reread up to 64 KiB twice per session. */
const previewFileCache = new BoundedMap<string, PreviewFileCacheEntry>(
  PREVIEW_FILE_CACHE_MAX_ENTRIES,
);

export interface SessionMessagePreview {
  previewUserText?: string | null;
  previewBotText?: string | null;
  previewUserFullText?: string | null;
  previewBotFullText?: string | null;
  previewUserAt?: number | null;
  previewBotAt?: number | null;
  previewBotState?: 'replied' | 'waiting' | null;
}

const CLEARED_SESSION_MESSAGE_PREVIEW: SessionMessagePreview = {
  previewUserText: null,
  previewBotText: null,
  previewUserFullText: null,
  previewBotFullText: null,
  previewUserAt: null,
  previewBotAt: null,
  previewBotState: null,
};

function compactText(value: unknown, limit: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Length-bound a value while PRESERVING newlines, so the overlay can render
 * the reply's Markdown structure. Horizontal whitespace is tidied but line
 * breaks survive — the compact single-line card summary keeps using
 * compactText(). */
function compactMultiline(value: unknown, limit: number): string {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Read a bounded JSONL tail. A partial first line is discarded when the file
 * is larger than the read window; malformed/truncated rows are skipped. */
function readLatestJsonlRow(path: string, kind: PreviewRowKind): JsonRow | undefined {
  if (!existsSync(path)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    const size = stat.size;
    if (size <= 0) return undefined;
    const cacheKey = `${kind}:${path}`;
    const cached = previewFileCache.get(cacheKey);
    if (cached && cached.size === size && cached.mtimeMs === stat.mtimeMs) {
      return cached.row;
    }
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
    const matches = kind === 'user'
      ? (row: JsonRow) => row.senderType === 'user'
      : (row: JsonRow) => typeof row.sentAtMs === 'number' && typeof row.previewText === 'string';
    let latest: JsonRow | undefined;
    for (let i = rows.length - 1, seen = 0; i >= 0 && seen < PREVIEW_TAIL_ROWS; i--, seen++) {
      if (matches(rows[i])) {
        latest = rows[i];
        break;
      }
    }
    const row = latest
      ? kind === 'user'
        ? {
            senderType: 'user',
            content: compactMultiline(latest.content, FULL_PREVIEW_LENGTH),
            createTime: latest.createTime,
          }
        : {
            previewText: compactMultiline(latest.previewText, FULL_PREVIEW_LENGTH),
            sentAtMs: latest.sentAtMs,
          }
      : undefined;
    previewFileCache.set(cacheKey, {
      mtimeMs: stat.mtimeMs,
      row,
      size,
    });
    return row;
  } catch {
    return undefined;
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
  if (session.status === 'closed') {
    return { ...CLEARED_SESSION_MESSAGE_PREVIEW };
  }

  const queueAnchor = session.deferredScheduleRun?.routingAnchor
    ?? (session.scope === 'chat' ? session.chatId : session.rootMessageId);
  const safeQueueAnchor = safeJsonlKey(queueAnchor);
  // Queue files are keyed by routing anchor, not session id. Both chat-scope
  // (chatId) and thread-scope (rootMessageId) anchors can be re-used after an
  // old session closes, so closed rows are handled by the early return above.
  const latestUser = safeQueueAnchor
    ? readLatestJsonlRow(
        join(config.session.dataDir, 'queues', `${safeQueueAnchor}.jsonl`),
        'user',
      )
    : undefined;

  const safeSessionId = safeJsonlKey(session.sessionId);
  const latestBot = safeSessionId
    ? readLatestJsonlRow(
        join(config.session.dataDir, 'turn-sends', `${safeSessionId}.jsonl`),
        'bot',
      )
    : undefined;

  const userFullText = compactMultiline(
    latestUser?.content ?? session.lastUserPrompt ?? '',
    FULL_PREVIEW_LENGTH,
  );
  const botFullText = compactMultiline(latestBot?.previewText ?? '', FULL_PREVIEW_LENGTH);
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
