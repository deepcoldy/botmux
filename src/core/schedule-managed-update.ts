import { updateTaskWithOptionalPrecondition } from './schedule-precondition-config.js';
import { previewTaskCalendar } from '../services/work-calendar.js';
import { logger } from '../utils/logger.js';
import type { CalendarDayType } from '../services/work-calendar.js';
import type { ScheduledTask } from '../types.js';

/** Fields `botmux schedule update` may change through the daemon's managed
 *  mutation route. Everything else on the task (id, silent, position, creator,
 *  run history, precondition) is left exactly as it is. */
export interface ManagedScheduleUpdate {
  prompt?: string;
  schedule?: string;
  calendar?: string | null;
  calendarDayType?: CalendarDayType;
}

/** What the CLI prints after a successful update. */
export interface ManagedScheduleUpdateReceipt {
  schedule: string;
  display?: string;
  nextRunAt: string | null;
  enabled: boolean;
  disabledReason?: ScheduledTask['disabledReason'];
  calendar?: string;
  nextEligibleRunAt?: string | null;
}

/** The longest schedule expression accepted from the managed route; the CLI
 *  sends what the user typed, which is a handful of characters in practice. */
const MAX_SCHEDULE_CHARS = 256;

/** Validate the wire body of a managed `update` before any authority write. */
export function readManagedScheduleUpdate(
  body: Record<string, unknown>,
): { ok: true; updates: ManagedScheduleUpdate } | { ok: false; error: string } {
  const hasPrompt = typeof body.prompt === 'string' && body.prompt.trim().length > 0;
  const hasSchedule = typeof body.schedule === 'string' && body.schedule.trim().length > 0;
  const hasCalendar = body.calendar !== undefined || body.calendarDayType !== undefined;
  if (body.prompt !== undefined && !hasPrompt) return { ok: false, error: 'invalid_schedule_prompt' };
  if (body.schedule !== undefined
    && (!hasSchedule || Array.from(body.schedule as string).length > MAX_SCHEDULE_CHARS)) {
    return { ok: false, error: 'invalid_schedule_expression' };
  }
  if (!hasPrompt && !hasSchedule && !hasCalendar) return { ok: false, error: 'invalid_schedule_update' };
  if (body.calendar !== undefined && body.calendar !== null && typeof body.calendar !== 'string') {
    return { ok: false, error: 'invalid_schedule_calendar' };
  }
  if (body.calendarDayType !== undefined
    && body.calendarDayType !== 'workday' && body.calendarDayType !== 'restday') {
    return { ok: false, error: 'invalid_schedule_calendar_day_type' };
  }
  return {
    ok: true,
    updates: {
      ...(hasPrompt ? { prompt: body.prompt as string } : {}),
      ...(hasSchedule ? { schedule: (body.schedule as string).trim() } : {}),
      ...(body.calendar !== undefined ? { calendar: body.calendar as string | null } : {}),
      ...(body.calendarDayType !== undefined ? { calendarDayType: body.calendarDayType as CalendarDayType } : {}),
    },
  };
}

function receiptFor(task: ScheduledTask, appId: string): ManagedScheduleUpdateReceipt {
  const calendar = task.calendar !== undefined ? previewTaskCalendar(task, appId) : undefined;
  return {
    schedule: task.schedule,
    ...(task.parsed?.display ? { display: task.parsed.display } : {}),
    nextRunAt: task.nextRunAt ?? null,
    enabled: task.enabled,
    ...(!task.enabled && task.disabledReason ? { disabledReason: task.disabledReason } : {}),
    ...(task.calendar !== undefined ? { calendar: task.calendar } : {}),
    ...(calendar ? { nextEligibleRunAt: calendar.nextEligibleRunAt } : {}),
  };
}

/**
 * Commit an already-authorized managed update through the same compound
 * operation the Dashboard PATCH uses: the scheduler re-parses a changed
 * schedule and recomputes `nextRunAt` from now (no catch-up, no immediate
 * fire), and a configured precondition is kept and rebound to the new
 * canonical task input instead of being left with a stale checksum.
 */
export function applyManagedScheduleUpdate(
  id: string,
  appId: string,
  updates: ManagedScheduleUpdate,
): { ok: true; task: ManagedScheduleUpdateReceipt } | { ok: false; error: string } {
  let result;
  try {
    result = updateTaskWithOptionalPrecondition(id, updates, appId);
  } catch {
    // Rolled back by the compound operation; never report a half-applied edit.
    logger.error(`[schedule-precondition] managed update failed for task ${id}`);
    return { ok: false, error: 'schedule_precondition_update_failed' };
  }
  if (!result.ok || !result.task) return { ok: false, error: result.error ?? 'not_found_or_denied' };
  return { ok: true, task: receiptFor(result.task, appId) };
}
