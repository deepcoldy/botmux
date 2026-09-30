import type { ParsedCloseResidual } from '../core/close-residual.js';
export const IDLE_CLEANUP_HOUR_OPTIONS = [24, 72, 168] as const;
export type IdleCleanupHours = typeof IDLE_CLEANUP_HOUR_OPTIONS[number];

export function idleCleanupHoursLabel(hours: IdleCleanupHours): string {
  return hours === 168 ? '7d' : `${hours}H`;
}

export interface IdleCleanupSessionRow {
  sessionId: string;
  status?: string;
  lastMessageAt?: unknown;
  pendingRepo?: unknown;
  tuiPromptActive?: unknown;
  agentAttention?: unknown;
  locked?: unknown;
  webPort?: unknown;
  /** Owning daemon's app id — used to route the per-session close via
   *  proxyToDaemon. Present on aggregator rows; optional here since the pure
   *  selection logic never reads it. */
  larkAppId?: string;
}

const OPTIONS = new Set<number>(IDLE_CLEANUP_HOUR_OPTIONS);

export function parseIdleCleanupHours(value: unknown): IdleCleanupHours | null {
  const normalized = value === '7d' ? 168 : Number(value);
  if (!Number.isFinite(normalized) || !OPTIONS.has(normalized)) return null;
  return normalized as IdleCleanupHours;
}

function numericTime(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function idleCleanupCutoffMs(hours: IdleCleanupHours, now = Date.now()): number {
  return now - hours * 60 * 60 * 1000;
}

export function isIdleCleanupCandidate(
  row: IdleCleanupSessionRow,
  hours: IdleCleanupHours,
  now = Date.now(),
): boolean {
  if (!row.sessionId) return false;
  if (row.status !== 'idle') return false;
  if (row.locked) return false;
  if (row.pendingRepo || row.tuiPromptActive || row.agentAttention) return false;
  const last = numericTime(row.lastMessageAt);
  return last !== null && last < idleCleanupCutoffMs(hours, now);
}

/**
 * Dormant rows have no live worker process. They are cleanable with the same
 * guards as idle rows, plus one extra: a non-null webPort means a terminal is
 * still being served for the row, so never sweep it from the dashboard.
 */
export function isDormantCleanupCandidate(
  row: IdleCleanupSessionRow,
  hours: IdleCleanupHours,
  now = Date.now(),
): boolean {
  if (!row.sessionId) return false;
  if (row.status !== 'dormant') return false;
  if (row.locked) return false;
  if (row.pendingRepo || row.tuiPromptActive || row.agentAttention) return false;
  if (row.webPort !== undefined && row.webPort !== null) return false;
  const last = numericTime(row.lastMessageAt);
  return last !== null && last < idleCleanupCutoffMs(hours, now);
}

export function selectIdleCleanupCandidates<T extends IdleCleanupSessionRow>(
  rows: T[],
  hours: IdleCleanupHours,
  now = Date.now(),
): T[] {
  return rows.filter(row => isIdleCleanupCandidate(row, hours, now));
}

export interface CleanupCandidateGroups<T> {
  idle: T[];
  dormant: T[];
}

export function selectCleanupCandidates<T extends IdleCleanupSessionRow>(
  rows: T[],
  hours: IdleCleanupHours,
  now = Date.now(),
): CleanupCandidateGroups<T> {
  const idle: T[] = [];
  const dormant: T[] = [];
  for (const row of rows) {
    if (isIdleCleanupCandidate(row, hours, now)) idle.push(row);
    else if (isDormantCleanupCandidate(row, hours, now)) dormant.push(row);
  }
  return { idle, dormant };
}

export interface IdleCleanupCloseResult {
  sessionId: string;
  ok: boolean;
  error?: string;
  /** Closed locally, but its remote session survived and needs manual cleanup. */
  residual?: ParsedCloseResidual;
}

export interface IdleCleanupResult {
  ok: boolean;
  olderThanHours: IdleCleanupHours;
  cutoffMs: number;
  matched: number;
  closed: number;
  failed: number;
  /** Subset of `closed` whose remote session was NOT cancelled. */
  residual: number;
  results: IdleCleanupCloseResult[];
}

export async function cleanupIdleSessions<T extends IdleCleanupSessionRow>(
  rows: T[],
  hours: IdleCleanupHours,
  closeCandidate: (row: T) => Promise<IdleCleanupCloseResult>,
  now = Date.now(),
): Promise<IdleCleanupResult> {
  const groups = selectCleanupCandidates(rows, hours, now);
  const candidates = [...groups.idle, ...groups.dormant];
  const results: IdleCleanupCloseResult[] = [];
  for (const row of candidates) {
    results.push(await closeCandidate(row));
  }
  const closed = results.filter(r => r.ok).length;
  const failed = results.length - closed;
  // Counted, never folded into `closed`: an idle/workerless mojo row can carry a
  // parked lineage, so "closed N, failed 0" would otherwise hide live remotes.
  const residual = results.filter(r => r.ok && r.residual).length;
  return {
    ok: failed === 0,
    olderThanHours: hours,
    cutoffMs: idleCleanupCutoffMs(hours, now),
    matched: candidates.length,
    closed,
    failed,
    residual,
    results,
  };
}
