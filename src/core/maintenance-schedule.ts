/**
 * Pure scheduling logic for the maintenance timer (auto-update / auto-restart).
 * No I/O — the timer in core/maintenance.ts feeds it the current time and the
 * per-task last-handled date, then acts on the decision.
 *
 * Times are interpreted in a fixed local timezone (Asia/Shanghai, matching the
 * scheduler) and fire at most once per local day. "Handled" covers both fired
 * and skipped-because-busy, so a busy collision deterministically slips to the
 * next day rather than retrying.
 */
import type { MaintenanceTask } from '../global-config.js';
import { isValidHhMm } from '../global-config.js';

export const MAINTENANCE_TZ = 'Asia/Shanghai';
/** How late a run may fire after its scheduled minute before it's "missed"
 *  (e.g. the daemon was down at the scheduled time). */
export const DEFAULT_GRACE_MINUTES = 60;

export type MaintenanceDecision =
  | 'disabled'        // not enabled / no valid time
  | 'already-handled' // the most recent occurrence is already fired or skipped
  | 'not-yet'         // waiting for the next occurrence
  | 'due'             // act now (then mark `markDate` handled)
  | 'missed';         // occurrence past grace — mark `markDate` handled, no action

export interface DueResult {
  decision: MaintenanceDecision;
  /** For 'due'/'missed': the local date the handled occurrence belongs to.
   *  Usually today, but the PREVIOUS day for a late run that crossed midnight
   *  within grace — so the caller marks the run's own day, not "today". */
  markDate?: string;
}

/** Previous calendar day for a 'YYYY-MM-DD' string. */
function prevDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** Local date ('YYYY-MM-DD') and minutes-since-midnight for `nowMs` in `tz`. */
export function localParts(nowMs: number, tz: string = MAINTENANCE_TZ): { dateStr: string; minutesOfDay: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(nowMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  // hour can come back as '24' at midnight in some environments — normalize.
  const hour = Number(parts.hour) % 24;
  const minutesOfDay = hour * 60 + Number(parts.minute);
  return { dateStr, minutesOfDay };
}

export function parseHhMmToMinutes(time: string): number | null {
  if (!isValidHhMm(time)) return null;
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function evaluateDue(
  task: MaintenanceTask,
  lastDate: string | undefined,
  nowMs: number,
  opts?: { tz?: string; graceMinutes?: number },
): DueResult {
  if (!task.enabled || !task.time) return { decision: 'disabled' };
  const taskMinutes = parseHhMmToMinutes(task.time);
  if (taskMinutes === null) return { decision: 'disabled' };

  const tz = opts?.tz ?? MAINTENANCE_TZ;
  const grace = opts?.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const { dateStr, minutesOfDay } = localParts(nowMs, tz);

  // The most recent scheduled occurrence at or before `now`. When `now` is
  // before today's minute, the relevant occurrence is yesterday's — this lets a
  // late-night run (e.g. 23:30) still fire within grace after midnight.
  let occDate: string;
  let lateness: number;
  if (minutesOfDay >= taskMinutes) {
    occDate = dateStr;
    lateness = minutesOfDay - taskMinutes;
  } else {
    occDate = prevDateStr(dateStr);
    lateness = minutesOfDay + (1440 - taskMinutes);
  }

  if (lastDate === occDate) return { decision: 'already-handled' };
  if (lateness <= grace) return { decision: 'due', markDate: occDate };
  // Past grace, unhandled. A today occurrence is genuinely missed (mark it so it
  // won't retry today). A previous-day occurrence this far late is dropped — we
  // simply wait for today's run rather than firing a stale one.
  if (occDate === dateStr) return { decision: 'missed', markDate: occDate };
  return { decision: 'not-yet' };
}
