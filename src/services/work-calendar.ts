/** Independent named calendars, bundled or user-defined. No runtime network or inferred holidays. */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Cron } from 'croner';
import { z } from 'zod';
import { botHomePath } from '../adapters/cli/read-isolation.js';
import { config } from '../config.js';
import { scheduleTimeZone } from '../utils/timezone.js';
import type { ScheduledTask } from '../types.js';
import { BUILTIN_WORK_CALENDARS } from './work-calendars/catalog.js';
export { BUILTIN_WORK_CALENDARS } from './work-calendars/catalog.js';

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 10_000;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'invalid_date');
const definitionSchema = z.object({
  displayNames: z.object({ zh: z.string().min(1).max(120).optional(), en: z.string().min(1).max(120).optional() }).strict().optional(),
  timeZone: z.string().refine(value => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return value !== 'Etc/Unknown'; }
    catch { return false; }
  }, 'invalid_timezone'),
  coverage: z.object({ start: dateSchema, end: dateSchema }).strict(),
  workWeek: z.array(z.number().int().min(0).max(6)).max(7),
  restDates: z.array(dateSchema),
  workDates: z.array(dateSchema),
}).strict().superRefine((value, ctx) => {
  const { start, end } = value.coverage;
  if (start > end) ctx.addIssue({ code: 'custom', message: 'invalid_coverage' });
  const rest = new Set(value.restDates);
  if (value.workDates.some(date => rest.has(date))) ctx.addIssue({ code: 'custom', message: 'conflicting_dates' });
  if ([...value.restDates, ...value.workDates].some(date => date < start || date > end)) {
    ctx.addIssue({ code: 'custom', message: 'date_outside_coverage' });
  }
  for (const dates of [value.workWeek, value.restDates, value.workDates]) {
    if (new Set<string | number>(dates).size !== dates.length) ctx.addIssue({ code: 'custom', message: 'duplicate_dates' });
  }
});
export type WorkCalendar = z.infer<typeof definitionSchema>;
export type CalendarDayType = 'workday' | 'restday';
export type CalendarReason = 'work_date' | 'rest_date' | 'work_week' | 'rest_week'
  | 'calendar_missing' | 'calendar_invalid' | 'calendar_out_of_coverage'
  | 'manual_bypass' | 'calendar_scope_missing' | 'calendar_once_unsupported' | 'invalid_calendar_day_type' | 'search_limit' | 'schedule_exhausted';
export interface CalendarCheck {
  calendar: string;
  status: 'working' | 'rest' | 'error' | 'bypassed';
  reason: CalendarReason;
  date?: string;
  timeZone?: string;
  displayNames?: WorkCalendar['displayNames'];
  dayType?: CalendarDayType;
  matches?: boolean;
}
export interface CalendarPreview {
  nextEligibleRunAt: string | null;
  calendarCheck: CalendarCheck;
}

export function normalizeCalendarBinding(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value === 'none' || !NAME.test(value)) throw new Error('invalid_calendar_name');
  return value;
}

export function normalizeCalendarDayType(value: unknown): CalendarDayType {
  if (value === undefined || value === null || value === 'workday') return 'workday';
  if (value === 'restday') return 'restday';
  throw new Error('invalid_calendar_day_type');
}

export function workCalendarPath(appId: string, dataDir = config.session.dataDir): string {
  return join(botHomePath(dirname(dataDir), appId), 'work-calendars.json');
}

export function parseWorkCalendar(value: unknown): WorkCalendar {
  const result = definitionSchema.safeParse(value);
  if (!result.success) throw new Error('calendar_invalid');
  return result.data;
}

/** Parse definitions separately so a broken unrelated profile does not block a valid one. */
export function readWorkCalendarDefinitions(appId: string, dataDir = config.session.dataDir): Record<string, unknown> {
  const path = workCalendarPath(appId, dataDir);
  if (statSync(path).size > MAX_BYTES) throw new Error('calendar_invalid');
  const file = z.object({ version: z.literal(1), calendars: z.record(z.unknown()) }).strict()
    .parse(JSON.parse(readFileSync(path, 'utf8')));
  return file.calendars;
}

function resolveCalendar(name: unknown, appId: string | undefined): WorkCalendar {
  if (!appId) throw new Error('calendar_scope_missing');
  if (!normalizeCalendarBinding(name)) throw new Error('calendar_invalid');
  // Built-in IDs are reserved; local entities use their own IDs and the same rule schema.
  if (Object.hasOwn(BUILTIN_WORK_CALENDARS, name as string)) {
    const entity = BUILTIN_WORK_CALENDARS[name as string];
    return { ...parseWorkCalendar(entity.calendar), displayNames: entity.displayNames };
  }
  let definitions: Record<string, unknown>;
  try { definitions = readWorkCalendarDefinitions(appId); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('calendar_missing');
    throw new Error('calendar_invalid');
  }
  if (!Object.hasOwn(definitions, name as string)) throw new Error('calendar_missing');
  return parseWorkCalendar(definitions[name as string]);
}

export function listWorkCalendars(appId: string): { calendars: Array<{
  id: string; kind: 'builtin' | 'local'; displayNames?: WorkCalendar['displayNames'];
  timeZone?: string; coverage?: WorkCalendar['coverage']; error?: string;
}>; localError?: string } {
  const calendars: ReturnType<typeof listWorkCalendars>['calendars'] = Object.entries(BUILTIN_WORK_CALENDARS).map(([id, entity]) => {
    const data = parseWorkCalendar(entity.calendar);
    return { id, kind: 'builtin', displayNames: entity.displayNames, timeZone: data.timeZone, coverage: data.coverage };
  });
  let definitions: Record<string, unknown>;
  try { definitions = readWorkCalendarDefinitions(appId); }
  catch (error) {
    return { calendars, ...((error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : { localError: 'calendar_invalid' }) };
  }
  for (const [id, value] of Object.entries(definitions)) {
    if (Object.hasOwn(BUILTIN_WORK_CALENDARS, id)) continue;
    try {
      normalizeCalendarBinding(id);
      const data = parseWorkCalendar(value);
      calendars.push({ id, kind: 'local', displayNames: data.displayNames, timeZone: data.timeZone, coverage: data.coverage });
    } catch { calendars.push({ id, kind: 'local', error: 'calendar_invalid' }); }
  }
  return { calendars };
}

export function checkWorkCalendar(calendar: WorkCalendar, name: string, instant: Date): CalendarCheck {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: calendar.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  const base = { calendar: name, date, timeZone: calendar.timeZone, ...(calendar.displayNames ? { displayNames: calendar.displayNames } : {}) };
  if (date < calendar.coverage.start || date > calendar.coverage.end) {
    return { ...base, status: 'error', reason: 'calendar_out_of_coverage' };
  }
  if (calendar.workDates.includes(date)) return { ...base, status: 'working', reason: 'work_date' };
  if (calendar.restDates.includes(date)) return { ...base, status: 'rest', reason: 'rest_date' };
  const working = calendar.workWeek.includes(new Date(`${date}T00:00:00Z`).getUTCDay());
  return { ...base, status: working ? 'working' : 'rest', reason: working ? 'work_week' : 'rest_week' };
}

function calendarError(task: Pick<ScheduledTask, 'calendar'>, error: unknown): CalendarCheck {
  const code = error instanceof Error ? error.message : '';
  const reason = ['calendar_missing', 'calendar_scope_missing', 'invalid_calendar_day_type'].includes(code)
    ? code as CalendarReason : 'calendar_invalid';
  return { calendar: typeof task.calendar === 'string' && NAME.test(task.calendar) ? task.calendar : '(invalid)', status: 'error', reason, ...builtinDisplayNames(task.calendar) };
}

function builtinDisplayNames(name: string | undefined): Pick<CalendarCheck, 'displayNames'> {
  return name && Object.hasOwn(BUILTIN_WORK_CALENDARS, name)
    ? { displayNames: BUILTIN_WORK_CALENDARS[name].displayNames } : {};
}

function checkForTask(calendar: WorkCalendar, task: Pick<ScheduledTask, 'calendar' | 'calendarDayType'>, instant: Date): CalendarCheck {
  const dayType = normalizeCalendarDayType(task.calendarDayType);
  const check = checkWorkCalendar(calendar, task.calendar!, instant);
  return { ...check, dayType, matches: check.status === (dayType === 'restday' ? 'rest' : 'working') };
}

/** Evaluate the actual dispatch instant, including a late catch-up after restart. */
export function checkTaskCalendar(
  task: Pick<ScheduledTask, 'calendar' | 'calendarDayType' | 'parsed' | 'larkAppId'>,
  appId = task.larkAppId,
  instant = new Date(),
): CalendarCheck | undefined {
  if (task.calendar === undefined) return undefined;
  if (task.parsed.kind === 'once') {
    return { calendar: task.calendar, status: 'error', reason: 'calendar_once_unsupported', ...builtinDisplayNames(task.calendar) };
  }
  try { return checkForTask(resolveCalendar(task.calendar, appId), task, instant); }
  catch (error) { return calendarError(task, error); }
}

/** Preview only: never rewrites the raw cron/interval trigger or creates weekend triggers. */
export function previewTaskCalendar(
  task: Pick<ScheduledTask, 'calendar' | 'calendarDayType' | 'parsed' | 'larkAppId' | 'nextRunAt'>,
  appId = task.larkAppId,
  now = new Date(),
): CalendarPreview | undefined {
  if (task.calendar === undefined) return undefined;
  if (task.parsed.kind === 'once') return { nextEligibleRunAt: null, calendarCheck: checkTaskCalendar(task, appId, now)! };
  try {
    const calendar = resolveCalendar(task.calendar, appId);
    const current = checkForTask(calendar, task, now);
    const job = task.parsed.kind === 'cron' && task.parsed.expr
      ? new Cron(task.parsed.expr, { timezone: scheduleTimeZone() }) : undefined;
    const interval = (task.parsed.minutes ?? 0) * 60_000;
    let candidate = task.nextRunAt ? new Date(task.nextRunAt) : undefined;
    if (!candidate || candidate < now) candidate = job?.nextRun(now) ?? (interval > 0 ? new Date(+now + interval) : undefined);
    for (let i = 0; candidate && i < MAX_CANDIDATES; i++) {
      const check = checkForTask(calendar, task, candidate);
      if (check.matches) return { nextEligibleRunAt: candidate.toISOString(), calendarCheck: current };
      // Before coverage starts we can still search forward, but never infer a workday.
      if (check.status === 'error' && check.date! > calendar.coverage.end) {
        return { nextEligibleRunAt: null, calendarCheck: check };
      }
      // Skip the rest of this local date in one step, preserving interval phase.
      // This bounds work for second/minute cron without losing DST or UTC boundaries.
      const midnight = new Cron('0 0 * * *', { timezone: calendar.timeZone }).nextRun(candidate);
      if (!midnight) break;
      candidate = job
        ? job.nextRun(new Date(+midnight - 1)) ?? undefined
        : interval > 0 ? new Date(+candidate + Math.max(1, Math.ceil((+midnight - +candidate) / interval)) * interval) : undefined;
    }
    return { nextEligibleRunAt: null, calendarCheck: {
      ...current, status: 'error', reason: candidate ? 'search_limit' : 'schedule_exhausted',
    } };
  } catch (error) { return { nextEligibleRunAt: null, calendarCheck: calendarError(task, error) }; }
}

export function manualCalendarCheck(task: Pick<ScheduledTask, 'calendar' | 'calendarDayType'>): CalendarCheck | undefined {
  return task.calendar === undefined ? undefined : { calendar: task.calendar, status: 'bypassed', reason: 'manual_bypass', dayType: task.calendarDayType === 'restday' ? 'restday' : 'workday', ...builtinDisplayNames(task.calendar) };
}
