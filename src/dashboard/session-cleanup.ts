export const IDLE_CLEANUP_HOUR_OPTIONS = [24, 72, 168] as const;
export type IdleCleanupHours = typeof IDLE_CLEANUP_HOUR_OPTIONS[number];

export interface IdleCleanupSessionRow {
  sessionId: string;
  status?: string;
  lastMessageAt?: unknown;
  pendingRepo?: unknown;
  tuiPromptActive?: unknown;
  agentAttention?: unknown;
  locked?: unknown;
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

export function selectIdleCleanupCandidates<T extends IdleCleanupSessionRow>(
  rows: T[],
  hours: IdleCleanupHours,
  now = Date.now(),
): T[] {
  return rows.filter(row => isIdleCleanupCandidate(row, hours, now));
}

export interface IdleCleanupCloseResult {
  sessionId: string;
  ok: boolean;
  error?: string;
}

export interface IdleCleanupResult {
  ok: boolean;
  olderThanHours: IdleCleanupHours;
  cutoffMs: number;
  matched: number;
  closed: number;
  failed: number;
  results: IdleCleanupCloseResult[];
}

export async function cleanupIdleSessions<T extends IdleCleanupSessionRow>(
  rows: T[],
  hours: IdleCleanupHours,
  closeCandidate: (row: T) => Promise<IdleCleanupCloseResult>,
  now = Date.now(),
): Promise<IdleCleanupResult> {
  const candidates = selectIdleCleanupCandidates(rows, hours, now);
  const results: IdleCleanupCloseResult[] = [];
  for (const row of candidates) {
    results.push(await closeCandidate(row));
  }
  const closed = results.filter(r => r.ok).length;
  const failed = results.length - closed;
  return {
    ok: failed === 0,
    olderThanHours: hours,
    cutoffMs: idleCleanupCutoffMs(hours, now),
    matched: candidates.length,
    closed,
    failed,
    results,
  };
}
