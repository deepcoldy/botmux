/**
 * Session card model (PR1) — pure projection of `SessionRow` (the shape served
 * by `/api/sessions` and emitted by worker-pool publishers) into list-card and
 * detail-card DTOs.
 *
 * Zero runtime IO. The only outside type touched is `SessionRow`, brought in
 * as a TYPE-ONLY import so the runtime imports in `dashboard-rows.ts:11-13`
 * (`terminal-url` / `bot-registry` / `lark-hosts`) never bleed into this
 * module.
 */

import type { SessionRow } from '../core/dashboard-rows.js';
import type {
  ButtonState,
  PaginationMeta,
  StatusDot,
} from './card-model-types.js';

/** Concrete status values a SessionRow can carry (mirrors `StreamStatus | 'closed' | 'dormant'`). */
export type SessionStatus =
  | 'working'
  | 'idle'
  | 'analyzing'
  | 'limited'
  | 'starting'
  | 'dormant'
  | 'closed';

/** Status-chip filter value — all StreamStatus + 'closed' + 'all'. */
export type StatusChip = SessionStatus | 'all';

/** A single row projected for the sessions list card. Keeps `raw` for downstream renderers. */
export interface SessionRowDto {
  sessionId: string;
  /** Display dot — color tone + pulse + i18n-free label key. */
  dot: StatusDot;
  /** Primary text: `title || sessionId`. */
  primary: string;
  /** Secondary text: `cliId · workingDir · relativeTime` joined by ' · '. */
  secondary: string;
  cliId: string;
  status: string;
  lastMessageAt: number;
  webPort: number | null;
  scope?: 'thread' | 'chat';
  /**
   * Raw row preserved for downstream card-builder use.
   */
  raw: SessionRow;
}

/** Locate-button mode — chat-scope sessions open the chat directly; thread-scope opens the topic. */
export type LocateMode = 'openTopic' | 'openChat';

/** Action availability for the 4 primary detail buttons + locate sub-mode. */
export interface SessionActionMatrix {
  resume: ButtonState;
  close: ButtonState;
  openTerminal: ButtonState;
  locate: ButtonState;
  locateMode: LocateMode;
}

/** Detail-card DTO. Action matrix encodes every visibility rule. */
export interface SessionDetailDto {
  sessionId: string;
  status: string;
  dot: StatusDot;
  title: string;
  chatId: string;
  cliId: string;
  workingDir?: string;
  webPort: number | null;
  scope?: 'thread' | 'chat';
  actions: SessionActionMatrix;
  raw: SessionRow;
}

/** Map a SessionRow's status into a UI status dot (tone + pulse + i18n label key). Pure. */
export function statusToDot(status: string): StatusDot {
  switch (status) {
    case 'working':
      return { tone: 'success', pulse: true, label: 'sessions.status.working' };
    case 'analyzing':
      return { tone: 'info', pulse: true, label: 'sessions.status.analyzing' };
    case 'starting':
      return { tone: 'info', pulse: true, label: 'sessions.status.starting' };
    case 'idle':
      return { tone: 'success', pulse: false, label: 'sessions.status.idle' };
    case 'dormant':
      return { tone: 'neutral', pulse: false, label: 'sessions.status.dormant' };
    case 'limited':
      return { tone: 'warning', pulse: false, label: 'sessions.status.limited' };
    case 'closed':
      return { tone: 'neutral', pulse: false, label: 'sessions.status.closed' };
    default:
      return { tone: 'neutral', pulse: false, label: 'sessions.status.unknown' };
  }
}

const PRIMARY_MAX_LEN = 64;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function formatRelative(fromMs: number, nowMs: number): string {
  const diff = nowMs - fromMs;
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h ago`;
  const day = Math.floor(hour / 24);
  return `${day}d ago`;
}

function buildSecondary(row: SessionRow, nowMs?: number): string {
  const parts: string[] = [];
  if (row.cliId) parts.push(String(row.cliId));
  if (row.workingDir) parts.push(row.workingDir);
  if (typeof nowMs === 'number' && Number.isFinite(row.lastMessageAt)) {
    parts.push(formatRelative(row.lastMessageAt, nowMs));
  }
  return parts.join(' · ');
}

function buildPrimary(row: SessionRow): string {
  const raw = row.title && row.title.trim().length > 0 ? row.title : row.sessionId;
  return truncate(raw, PRIMARY_MAX_LEN);
}

/** Build a SessionRowDto from a raw SessionRow, including dot + primary/secondary text. */
export function composeEntries(rows: ReadonlyArray<SessionRow>, nowMs?: number): SessionRowDto[] {
  const out: SessionRowDto[] = [];
  for (const row of rows) {
    out.push({
      sessionId: row.sessionId,
      dot: statusToDot(row.status),
      primary: buildPrimary(row),
      secondary: buildSecondary(row, nowMs),
      cliId: String(row.cliId),
      status: row.status,
      lastMessageAt: row.lastMessageAt,
      webPort: row.webPort,
      scope: row.scope,
      raw: row,
    });
  }
  return out;
}

/**
 * Filter entries by status chip. `all` short-circuits with a shallow copy
 * (same content + order, but a fresh array so downstream pipelines can rely
 * on a non-aliased reference).
 */
export function filterByStatus(entries: ReadonlyArray<SessionRowDto>, chip: StatusChip): SessionRowDto[] {
  if (chip === 'all') return entries.slice();
  return entries.filter(e => e.status === chip);
}

/** Filter entries by case-insensitive substring against sessionId / title / chatId / workingDir. */
export function filterBySearch(entries: ReadonlyArray<SessionRowDto>, query: string | undefined): SessionRowDto[] {
  if (!query) return entries.slice();
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return entries.slice();
  return entries.filter(e => {
    const hay = `${e.sessionId} ${e.raw.title ?? ''} ${e.raw.chatId} ${e.raw.workingDir ?? ''}`.toLowerCase();
    return hay.includes(needle);
  });
}

/** Filter entries by CLI id. `undefined` / empty string returns input unchanged. */
export function filterByCli(entries: ReadonlyArray<SessionRowDto>, cliId: string | undefined): SessionRowDto[] {
  if (cliId === undefined || cliId === '') return entries.slice();
  return entries.filter(e => e.cliId === cliId);
}

const STATUS_ORDER: Record<string, number> = {
  working: 0,
  analyzing: 1,
  starting: 2,
  idle: 3,
  dormant: 4,
  limited: 5,
  closed: 6,
};

function statusRank(status: string): number {
  return STATUS_ORDER[status] ?? 9;
}

/** Sort entries by (status rank ascending, lastMessageAt descending). Returns a new array. */
export function sortByStatus(entries: ReadonlyArray<SessionRowDto>): SessionRowDto[] {
  return entries.slice().sort((a, b) => {
    const ra = statusRank(a.status);
    const rb = statusRank(b.status);
    if (ra !== rb) return ra - rb;
    return b.lastMessageAt - a.lastMessageAt;
  });
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function clampPageSize(pageSize: number | undefined): number {
  if (typeof pageSize !== 'number' || !Number.isFinite(pageSize) || pageSize < 1) return DEFAULT_PAGE_SIZE;
  if (pageSize > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return Math.floor(pageSize);
}

/** Slice a list into the requested page. Clamps invalid page/pageSize to safe values. */
export function paginate<T>(
  items: ReadonlyArray<T>,
  page: number | undefined,
  pageSize: number | undefined,
): { items: T[]; meta: PaginationMeta } {
  const total = items.length;
  const size = clampPageSize(pageSize);
  const totalPages = Math.max(1, Math.ceil(total / size));
  let active = typeof page === 'number' && Number.isFinite(page) ? Math.floor(page) : 1;
  if (active < 1) active = 1;
  if (active > totalPages) active = totalPages;
  const start = (active - 1) * size;
  return {
    items: items.slice(start, start + size),
    meta: { page: active, pageSize: size, total, totalPages },
  };
}

/** Build the detail-card DTO with the full action matrix. */
export function composeDetail(row: SessionRow, _nowMs?: number): SessionDetailDto {
  const isClosed = row.status === 'closed';
  const isStarting = row.status === 'starting';
  const canCloseNow = !isClosed && !isStarting;
  // Closed sessions can still carry a stale
  // webPort (closeSession / dashboard close don't null the field), so a
  // simple `webPort != null` check would surface a dead terminal link on
  // the closed detail card. Gate openTerminal on status too — terminals
  // are only meaningful on a live worker.
  const canOpenTerminal =
    !isClosed && row.webPort !== null && row.webPort !== undefined;
  const locateMode: LocateMode = row.scope === 'chat' ? 'openChat' : 'openTopic';

  const actions: SessionActionMatrix = {
    resume: isClosed ? { enabled: true } : { enabled: false, reasonKey: 'sessions.action.resume.onlyClosed' },
    close: canCloseNow ? { enabled: true } : {
      enabled: false,
      reasonKey: isStarting ? 'sessions.action.close.starting' : 'sessions.action.close.alreadyClosed',
    },
    openTerminal: canOpenTerminal ? { enabled: true } : { enabled: false, reasonKey: 'sessions.action.terminal.noPort' },
    locate: { enabled: true },
    locateMode,
  };

  return {
    sessionId: row.sessionId,
    status: row.status,
    dot: statusToDot(row.status),
    title: row.title && row.title.trim().length > 0 ? row.title : row.sessionId,
    chatId: row.chatId,
    cliId: String(row.cliId),
    workingDir: row.workingDir,
    webPort: row.webPort,
    scope: row.scope,
    actions,
    raw: row,
  };
}
