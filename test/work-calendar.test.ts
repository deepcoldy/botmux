import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import {
  checkTaskCalendar, checkWorkCalendar, normalizeCalendarBinding, parseWorkCalendar,
  previewTaskCalendar, workCalendarPath,
  BUILTIN_WORK_CALENDARS,
  normalizeCalendarDayType, listWorkCalendars, manualCalendarCheck,
} from '../src/services/work-calendar.js';
import type { ScheduledTask } from '../src/types.js';
import { readScheduleUpdate } from '../src/cli/schedule-update.js';

// Synthetic fixture only; none of these exceptions claims to be statutory data.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/work-calendar/demo.json', import.meta.url), 'utf8'));
const definition = fixture.calendars.demo;
let root: string;
let previousDataDir: string;
const app = 'calendar_test_bot';
const task = { calendar: 'demo', larkAppId: app, parsed: { kind: 'cron', expr: '0 9 * * *', display: 'daily' } } as ScheduledTask;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-calendar-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = join(root, 'data');
  const file = workCalendarPath(app);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(fixture));
  vi.stubEnv('BOTMUX_SCHEDULE_TIMEZONE', 'Asia/Shanghai');
});

afterEach(() => {
  config.session.dataDir = previousDataDir;
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('local work calendar schema and dates', () => {
  it.each([
    ['2028-01-03T01:00:00Z', 'working', 'work_week', '2028-01-03'],
    ['2028-01-04T01:00:00Z', 'rest', 'rest_date', '2028-01-04'],
    ['2028-01-08T01:00:00Z', 'working', 'work_date', '2028-01-08'],
    ['2028-01-09T01:00:00Z', 'rest', 'rest_week', '2028-01-09'],
    ['2028-01-03T16:00:00Z', 'rest', 'rest_date', '2028-01-04'],
    ['2028-02-29T01:00:00Z', 'working', 'work_week', '2028-02-29'],
    ['2027-12-31T16:00:00Z', 'working', 'work_date', '2028-01-01'],
    ['2029-01-01T01:00:00Z', 'error', 'calendar_out_of_coverage', '2029-01-01'],
    ['2027-12-29T01:00:00Z', 'error', 'calendar_out_of_coverage', '2027-12-29'],
  ])('%s -> %s (%s)', (instant, status, reason, date) => {
    expect(checkWorkCalendar(parseWorkCalendar(definition), 'demo', new Date(instant)))
      .toMatchObject({ status, reason, date, timeZone: 'Asia/Shanghai' });
  });
  it.each([
    { restDates: ['2028-01-08'] }, { workDates: ['2028-02-30'] },
    { restDates: ['2027-02-29'] }, { timeZone: 'Mars/City' }, { workWeek: [7] },
    { workWeek: [1, 1] }, { workDates: ['2029-01-01'] },
    { coverage: { start: '2029-01-01', end: '2028-12-31' } },
  ])('rejects invalid definition %j', patch => {
    expect(() => parseWorkCalendar({ ...definition, ...patch })).toThrow('calendar_invalid');
  });
  it('allows an empty workWeek with explicit work dates', () => {
    expect(checkWorkCalendar(parseWorkCalendar({ ...definition, workWeek: [] }), 'demo', new Date('2028-01-03T01:00:00Z')).status).toBe('rest');
  });
  it.each(['../demo', 'a/b', 'bad name', 42])('rejects invalid binding %j', name => {
    expect(() => normalizeCalendarBinding(name)).toThrow('invalid_calendar_name');
  });
  it('parses CLI calendar updates and clears explicitly', () => {
    expect(readScheduleUpdate(['abcd1234', '--calendar', 'demo'])).toEqual({ calendar: 'demo' });
    expect(readScheduleUpdate(['abcd1234', '--calendar=none', '--prompt', 'hello\n'])).toEqual({ calendar: null, prompt: 'hello\n' });
  });
});

describe('calendar loading, isolation and next eligible trigger', () => {
  it('selects rest days using the same data and never treats missing coverage as rest', () => {
    const restTask = { ...task, calendarDayType: 'restday' as const };
    expect(checkTaskCalendar(restTask, app, new Date('2028-01-04T01:00:00Z'))).toMatchObject({ status: 'rest', dayType: 'restday', matches: true });
    expect(checkTaskCalendar(restTask, app, new Date('2028-01-08T01:00:00Z'))).toMatchObject({ status: 'working', dayType: 'restday', matches: false });
    expect(checkTaskCalendar(restTask, app, new Date('2029-01-01T01:00:00Z'))).toMatchObject({ status: 'error', matches: false });
    expect(previewTaskCalendar(restTask, app, new Date('2028-01-03T02:00:00Z'))?.nextEligibleRunAt).toBe('2028-01-04T01:00:00.000Z');
    const interval = { ...restTask, parsed: { kind: 'interval' as const, minutes: 17, display: '17m' }, nextRunAt: '2028-01-03T15:58:00Z' };
    expect(previewTaskCalendar(interval, app, new Date('2028-01-03T15:57:00Z'))?.nextEligibleRunAt).toBe('2028-01-03T16:15:00.000Z');
    expect(checkTaskCalendar({ ...task, calendarDayType: 'bad' as any }, app)).toMatchObject({ status: 'error', reason: 'invalid_calendar_day_type' });
    expect(normalizeCalendarDayType(undefined)).toBe('workday');
    expect(() => normalizeCalendarDayType('weekday')).toThrow('invalid_calendar_day_type');
    expect(readScheduleUpdate(['abcd1234', '--calendar-day-type', 'restday'])).toEqual({ calendarDayType: 'restday' });
  });
  it('lists translated built-in and user calendar names and isolates local data errors', () => {
    writeFileSync(workCalendarPath(app), JSON.stringify({ version: 1, calendars: {
      shifts: { ...definition, displayNames: { zh: '公司排班日历', en: 'Company Shift Calendar' } },
      broken: {},
    } }));
    const list = listWorkCalendars(app);
    expect(list.calendars.find(row => row.id === 'cn')).toMatchObject({ kind: 'builtin', displayNames: { zh: '中国法定工作日历', en: 'China Statutory Work Calendar' } });
    expect(list.calendars.find(row => row.id === 'shifts')).toMatchObject({ displayNames: { zh: '公司排班日历', en: 'Company Shift Calendar' } });
    expect(checkTaskCalendar({ ...task, calendar: 'shifts' }, app, new Date('2028-01-04T01:00:00Z'))).toMatchObject({ displayNames: { zh: '公司排班日历' } });
    expect(list.calendars.find(row => row.id === 'broken')?.error).toBe('calendar_invalid');
    writeFileSync(workCalendarPath(app), '{broken');
    expect(listWorkCalendars(app)).toMatchObject({ localError: 'calendar_invalid', calendars: [{ id: 'cn' }] });
  });
  it('fails closed for missing/invalid data and remains independent of unbound tasks', () => {
    expect(checkTaskCalendar({ ...task, calendar: undefined })).toBeUndefined();
    expect(checkTaskCalendar({ ...task, calendar: 'absent' })).toMatchObject({ status: 'error', reason: 'calendar_missing' });
    expect(checkTaskCalendar(task, 'different_bot')).toMatchObject({ status: 'error', reason: 'calendar_missing' });
    expect(checkTaskCalendar({ ...task, larkAppId: undefined })).toMatchObject({ reason: 'calendar_scope_missing' });
    writeFileSync(workCalendarPath(app), '{bad json');
    expect(checkTaskCalendar(task)).toMatchObject({ reason: 'calendar_invalid' });
    expect(checkTaskCalendar({ ...task, calendar: undefined })).toBeUndefined();
  });
  it('isolates malformed unrelated profiles', () => {
    writeFileSync(workCalendarPath(app), JSON.stringify({ ...fixture, calendars: { ...fixture.calendars, broken: {} } }));
    expect(checkTaskCalendar(task, app, new Date('2028-01-03T01:00:00Z')).status).toBe('working');
    expect(checkTaskCalendar({ ...task, calendar: 'broken' })).toMatchObject({ reason: 'calendar_invalid' });
  });
  it('treats user calendars as independent entities without a country-specific default', () => {
    writeFileSync(workCalendarPath(app), JSON.stringify({ version: 1, calendars: {
      demo: definition,
      'company-weekdays': { ...definition, timeZone: 'UTC', restDates: [], workDates: [] },
    } }));
    const instant = new Date('2028-01-08T01:00:00Z');
    expect(checkTaskCalendar(task, app, instant)).toMatchObject({ calendar: 'demo', status: 'working', reason: 'work_date' });
    expect(checkTaskCalendar({ ...task, calendar: 'company-weekdays' }, app, instant))
      .toMatchObject({ calendar: 'company-weekdays', status: 'rest', reason: 'rest_week', timeZone: 'UTC' });
    expect(checkTaskCalendar({ ...task, calendar: 'cn' }, app, instant)).toMatchObject({ reason: 'calendar_out_of_coverage' });
  });
  it('rejects a stored once binding at runtime', () => {
    expect(checkTaskCalendar({ ...task, parsed: { kind: 'once', runAt: '2028-01-04T01:00:00Z', display: 'once' } })).toMatchObject({ reason: 'calendar_once_unsupported' });
  });
  it('previews daily makeup dates without inventing weekday cron triggers', () => {
    const now = new Date('2028-01-07T02:00:00Z');
    expect(previewTaskCalendar(task, app, now)?.nextEligibleRunAt).toBe('2028-01-08T01:00:00.000Z');
    expect(previewTaskCalendar({ ...task, parsed: { ...task.parsed, expr: '0 9 * * 1-5' } }, app, now)?.nextEligibleRunAt).toBe('2028-01-10T01:00:00.000Z');
  });
  it('skips a weekday exception and reports missing future coverage', () => {
    expect(previewTaskCalendar(task, app, new Date('2028-01-03T02:00:00Z'))?.nextEligibleRunAt).toBe('2028-01-05T01:00:00.000Z');
    expect(previewTaskCalendar(task, app, new Date('2029-01-01T01:00:00Z'))).toMatchObject({ nextEligibleRunAt: null, calendarCheck: { reason: 'calendar_out_of_coverage' } });
  });
  it('preserves interval phase when jumping over a local rest day', () => {
    const interval = { ...task, parsed: { kind: 'interval' as const, minutes: 17, display: '17m' }, nextRunAt: '2028-01-03T16:03:00Z' };
    expect(previewTaskCalendar(interval, app, new Date('2028-01-03T16:00:00Z'))?.nextEligibleRunAt).toBe('2028-01-04T16:08:00.000Z');
  });
  it('handles DST midnight when scanning minute cron', () => {
    writeFileSync(workCalendarPath(app), JSON.stringify({ version: 1, calendars: { demo: { ...definition, timeZone: 'America/New_York', workWeek: [1] } } }));
    vi.stubEnv('BOTMUX_SCHEDULE_TIMEZONE', 'America/New_York');
    expect(previewTaskCalendar({ ...task, parsed: { ...task.parsed, expr: '* * * * *' } }, app, new Date('2028-03-12T06:00:00Z'))?.nextEligibleRunAt).toBe('2028-03-13T04:00:00.000Z');
  });
});

describe('mainland China official 2026 snapshot', () => {
  const cnTask = { ...task, calendar: 'cn' };
  it('matches all 365 days against the seven official rest ranges and six makeup dates', () => {
    // Independently transcribed from 国办发明电〔2025〕7号, not generated from the bundled date arrays.
    const ranges = [
      ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'],
      ['2026-04-04', '2026-04-06'], ['2026-05-01', '2026-05-05'],
      ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'], ['2026-10-01', '2026-10-07'],
    ];
    const makeup = new Set(['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']);
    const calendar = parseWorkCalendar(BUILTIN_WORK_CALENDARS.cn.calendar);
    expect(calendar.restDates).toHaveLength(33);
    expect(calendar.workDates).toHaveLength(6);
    for (let day = new Date('2026-01-01T01:00:00Z'); day.getUTCFullYear() === 2026; day = new Date(+day + 86_400_000)) {
      const date = day.toISOString().slice(0, 10);
      const rest = ranges.some(([start, end]) => date >= start && date <= end);
      const working = makeup.has(date) || (!rest && day.getUTCDay() >= 1 && day.getUTCDay() <= 5);
      expect(checkTaskCalendar(cnTask, app, day), date).toMatchObject({ date, timeZone: 'Asia/Shanghai', status: working ? 'working' : 'rest' });
    }
    expect(BUILTIN_WORK_CALENDARS.cn).toMatchObject({ region: 'CN', dataVersion: '2026.1', source: {
      authority: '国务院办公厅', documentNo: '国办发明电〔2025〕7号', publishedAt: '2025-11-04',
    } });
  });
  it('requires no local file and cannot be replaced by a bot-local cn definition', () => {
    rmSync(workCalendarPath(app));
    expect(checkTaskCalendar(cnTask, app, new Date('2026-10-01T01:00:00Z'))).toMatchObject({ status: 'rest', reason: 'rest_date' });
    writeFileSync(workCalendarPath(app), '{broken');
    expect(checkTaskCalendar(cnTask, app, new Date('2026-10-10T01:00:00Z'))).toMatchObject({ status: 'working', reason: 'work_date' });
    writeFileSync(workCalendarPath(app), JSON.stringify({ version: 1, calendars: { cn: { ...definition, coverage: { start: '2026-01-01', end: '2026-12-31' }, restDates: [], workDates: [], workWeek: [] } } }));
    expect(checkTaskCalendar(cnTask, app, new Date('2026-10-10T01:00:00Z'))).toMatchObject({ status: 'working', reason: 'work_date' });
    expect(checkTaskCalendar({ ...task, calendar: 'absent' }, app, new Date('2026-10-10T01:00:00Z'))).toMatchObject({ status: 'error', reason: 'calendar_missing' });
  });
  it.each([
    ['2025-12-31T15:59:59Z', 'error', '2025-12-31'],
    ['2025-12-31T16:00:00Z', 'rest', '2026-01-01'],
    ['2026-12-31T15:59:59Z', 'working', '2026-12-31'],
    ['2026-12-31T16:00:00Z', 'error', '2027-01-01'],
  ])('uses the CN date and stops outside confirmed coverage at %s', (instant, status, date) => {
    expect(checkTaskCalendar(cnTask, app, new Date(instant))).toMatchObject({ status, date });
    if (status === 'error') expect(checkTaskCalendar(cnTask, app, new Date(instant))?.reason).toBe('calendar_out_of_coverage');
  });
  it('previews the official Saturday makeup trigger and reports unknown next-year data', () => {
    expect(manualCalendarCheck(cnTask)?.displayNames?.zh).toBe('中国法定工作日历');
    expect(checkTaskCalendar({ ...cnTask, calendarDayType: 'invalid' as never }, app)?.displayNames?.en).toBe('China Statutory Work Calendar');
    expect(checkTaskCalendar({ ...cnTask, parsed: { kind: 'once', display: 'once' } }, app)?.displayNames?.zh).toBe('中国法定工作日历');
    expect(previewTaskCalendar(cnTask, app, new Date('2026-10-09T02:00:00Z'))?.nextEligibleRunAt).toBe('2026-10-10T01:00:00.000Z');
    expect(previewTaskCalendar(cnTask, app, new Date('2026-12-31T02:00:00Z'))).toMatchObject({ nextEligibleRunAt: null, calendarCheck: { reason: 'calendar_out_of_coverage' } });
  });
});
