import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { dashboardEventBus, type DashboardEvent } from '../src/core/dashboard-events.js';
import { createTaskWithOptionalPrecondition } from '../src/core/schedule-precondition-config.js';
import { addTask, updateTask as editTask, runNow, disableTask, enableTask, setEnabled, setExecuteCallback, setOwnerFilter, startScheduler, stopScheduler } from '../src/core/scheduler.js';
import { executeScheduledTaskWithPrecondition } from '../src/services/schedule-precondition-gate.js';
import { readSchedulePreconditionFile } from '../src/services/schedule-precondition-file.js';
import { resolveSchedulePrecondition } from '../src/services/schedule-precondition-store.js';
import { getScheduleScope, getTask, importTasks, requestRunNow, scheduleFilePathFor, setScheduleScope, updateTask } from '../src/services/schedule-store.js';
import { queryScheduleRunLogs } from '../src/services/schedule-run-log-store.js';
import { workCalendarPath } from '../src/services/work-calendar.js';
import { emitHookEvent } from '../src/services/hook-runner.js';
import type { ScheduledTask } from '../src/types.js';

vi.mock('../src/services/hook-runner.js', () => ({ emitHookEvent: vi.fn() }));
const APP = 'calendar_scheduler_test';
const OTHER = 'calendar_scheduler_other';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/work-calendar/demo.json', import.meta.url), 'utf8'));
let root: string;
let previousDataDir: string;
let previousScope: string | null;
let events: DashboardEvent[];
let unsubscribe: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2028-01-04T01:00:00Z'));
  vi.stubEnv('BOTMUX_SCHEDULE_TIMEZONE', 'Asia/Shanghai');
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'botmux-calendar-scheduler-'));
  previousDataDir = config.session.dataDir;
  previousScope = getScheduleScope();
  config.session.dataDir = join(root, 'data');
  setScheduleScope(APP);
  setOwnerFilter(APP, true);
  const file = workCalendarPath(APP);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(fixture));
  events = [];
  unsubscribe = dashboardEventBus.subscribe(event => events.push(event));
});
afterEach(() => {
  stopScheduler();
  unsubscribe();
  vi.clearAllTimers();
  setExecuteCallback(async () => undefined);
  config.session.dataDir = previousDataDir;
  setScheduleScope(previousScope ?? APP);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function create(calendar: string | null = 'demo', extra: Partial<Parameters<typeof addTask>[0]> = {}) {
  return createTaskWithOptionalPrecondition({
    name: 'fixture calendar task', schedule: 'every 1m', prompt: 'fixture prompt',
    workingDir: root, chatId: 'fixture_chat', larkAppId: APP, calendar: calendar ?? undefined,
    repeat: { times: 3, completed: 0 }, ...extra,
  }, APP, { enabled: true, source: { kind: 'inline', script: 'printf 1' } });
}
function installGate() {
  const model = vi.fn(async () => undefined);
  const bash = vi.fn(async () => {
    writeFileSync(join(root, 'side-effect'), 'called');
    return { decision: 'pass' as const };
  });
  const execute = vi.fn(async (task: ScheduledTask) => executeScheduledTaskWithPrecondition(task, APP, model, {
    resolve: resolveSchedulePrecondition, readFile: readSchedulePreconditionFile, run: bash,
  }));
  setExecuteCallback(execute);
  return { model, bash, execute };
}
async function advance(ms = 60_000) { await vi.advanceTimersByTimeAsync(ms); }
function snapshot(id: string) { return JSON.parse(readFileSync(scheduleFilePathFor(APP), 'utf8'))[id]; }

describe('calendar admission before task side effects', () => {
  it.each([
    ['2026-10-01T01:00:00Z', true],
    ['2026-10-10T01:00:00Z', false],
    ['2027-01-01T01:00:00Z', false],
  ])('runs rest-day tasks only on confirmed CN rest dates at %s', async (now, allowed) => {
    vi.setSystemTime(new Date(now));
    const task = create('cn', { calendarDayType: 'restday' });
    const gate = installGate();
    startScheduler();
    await advance();
    expect(gate.bash).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(gate.model).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(snapshot(task.id)).toMatchObject({ calendarDayType: 'restday', repeat: { completed: allowed ? 1 : 0 } });
    if (!allowed && !now.startsWith('2027')) {
      expect(queryScheduleRunLogs(task.id, {}, APP).logs[0]).toMatchObject({ outcome: 'calendar_skipped', calendarCheck: { status: 'working', dayType: 'restday', matches: false, displayNames: { zh: '中国法定工作日历' } } });
    }
  });
  it('preserves rest-day selection through JSON reload and scheduler restart', async () => {
    vi.setSystemTime(new Date('2028-01-03T01:00:00Z'));
    const task = create('demo', { calendarDayType: 'restday' });
    startScheduler();
    await advance();
    stopScheduler();
    const persisted = snapshot(task.id);
    config.session.dataDir = join(root, 'reloaded', 'data');
    importTasks(APP, [[task.id, persisted]]);
    const file = workCalendarPath(APP);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, calendars: { demo: { ...fixture.calendars.demo, workWeek: [] } } }));
    const execute = vi.fn(async () => undefined);
    setExecuteCallback(execute);
    startScheduler();
    await advance();
    expect(getTask(task.id)?.calendarDayType).toBe('restday');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['2026-10-01T01:00:00Z', false],
    ['2026-10-10T01:00:00Z', true],
    ['2027-01-01T01:00:00Z', false],
  ])('admits CN official rest/makeup/unknown dates before Bash at %s', async (now, allowed) => {
    vi.setSystemTime(new Date(now));
    rmSync(workCalendarPath(APP));
    const task = create('cn');
    const gate = installGate();
    startScheduler();
    await advance();
    expect(gate.bash).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(gate.model).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(snapshot(task.id)).toMatchObject({ calendar: 'cn', repeat: { completed: allowed ? 1 : 0 } });
    if (!allowed) expect(snapshot(task.id).lastCalendarCheck).toMatchObject({ reason: now.startsWith('2027') ? 'calendar_out_of_coverage' : 'rest_date' });
  });
  it('skips before Bash/model, preserves repeat/follow-active/multi-chat and records a non-failure reason', async () => {
    const task = create('demo', { chatIds: ['fixture_chat', 'fixture_chat_2'], executionPosition: 'new-topic' });
    const gate = installGate();
    startScheduler();
    await advance(180_000);
    expect(gate.execute).not.toHaveBeenCalled();
    expect(gate.bash).not.toHaveBeenCalled();
    expect(gate.model).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'side-effect'))).toBe(false);
    expect(snapshot(task.id)).toMatchObject({
      calendar: 'demo', lastStatus: 'skipped', enabled: true,
      chatIds: ['fixture_chat', 'fixture_chat_2'], executionPosition: 'new-topic',
      repeat: { times: 3, completed: 0 },
      lastCalendarCheck: { reason: 'rest_date', date: '2028-01-04' },
    });
    expect(snapshot(task.id).lastError).toBeUndefined();
    expect(queryScheduleRunLogs(task.id, {}, APP).logs).toHaveLength(3);
    expect(queryScheduleRunLogs(task.id, {}, APP).logs[0]).toMatchObject({
      outcome: 'calendar_skipped', precondition: 'not_checked', calendarCheck: { reason: 'rest_date' },
    });
    expect(events.filter(e => e.type === 'schedule.fired')).toHaveLength(3);
    expect(vi.mocked(emitHookEvent).mock.calls.filter(([name]) => name === 'schedule.fired').map(([, value]) => value.status))
      .toEqual(['skipped', 'skipped', 'skipped']);
  });
  it.each(['2028-01-03T01:00:00Z', '2028-01-08T01:00:00Z'])('allows the normal/makeup workday %s', async now => {
    vi.setSystemTime(new Date(now));
    const task = create('demo', { executionPosition: 'topic', rootMessageId: 'fixture_root', followActive: true });
    const gate = installGate();
    startScheduler();
    await advance();
    expect(gate.bash).toHaveBeenCalledTimes(1);
    expect(gate.model).toHaveBeenCalledTimes(1);
    expect(getTask(task.id)).toMatchObject({ lastStatus: 'ok', followActive: true, rootMessageId: 'fixture_root', repeat: { completed: 1 } });
  });
  it.each(['missing', 'broken', 'coverage'])('blocks %s data without consuming runs and lets unbound tasks run', async kind => {
    const guarded = create(kind === 'missing' ? 'absent' : 'demo');
    const legacy = create(null);
    if (kind === 'broken') writeFileSync(workCalendarPath(APP), '{}');
    if (kind === 'coverage') vi.setSystemTime(new Date('2029-01-01T01:00:00Z'));
    const gate = installGate();
    // Claim both at the current instant, preserving repeat/owner/precondition setup.
    updateTask(guarded.id, { nextRunAt: new Date().toISOString() });
    updateTask(legacy.id, { nextRunAt: new Date().toISOString() });
    startScheduler();
    await advance(5_000);
    expect(gate.execute).toHaveBeenCalledTimes(1);
    expect(gate.execute.mock.calls[0][0].id).toBe(legacy.id);
    expect(snapshot(guarded.id)).toMatchObject({ enabled: true, lastStatus: 'error', repeat: { completed: 0 } });
    expect(queryScheduleRunLogs(guarded.id, {}, APP).logs[0]).toMatchObject({ outcome: 'error', errorCode: `calendar_${kind === 'missing' ? 'missing' : kind === 'broken' ? 'invalid' : 'out_of_coverage'}` });
  });
  it('keeps bot ownership and profile isolation', async () => {
    const own = create();
    setScheduleScope(OTHER);
    const other = addTask({ name: 'other task', schedule: 'every 1m', prompt: 'fixture', workingDir: root, chatId: 'fixture_chat', larkAppId: OTHER, calendar: 'demo' });
    setScheduleScope(APP);
    const gate = installGate();
    startScheduler();
    await advance();
    expect(gate.execute).not.toHaveBeenCalled();
    expect(getTask(own.id)?.lastStatus).toBe('skipped');
    expect(getTask(other.id, OTHER)?.lastStatus).toBeUndefined();
  });
  it('persists the binding through scheduler restart and profile updates take effect without daemon restart', async () => {
    const task = create();
    const gate = installGate();
    startScheduler();
    await advance();
    stopScheduler();
    vi.clearAllTimers();
    vi.setSystemTime(new Date('2028-01-04T01:01:00Z'));
    const persisted = snapshot(task.id);
    // Reload the JSON row through the migration path into a fresh store/bot home.
    const freshRoot = join(root, 'restarted');
    config.session.dataDir = join(freshRoot, 'data');
    importTasks(APP, [[task.id, persisted]]);
    const file = workCalendarPath(APP);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, calendars: { demo: { ...fixture.calendars.demo, restDates: [], workDates: [] } } }));
    startScheduler();
    // The protected sidecar is intentionally absent in the fresh home; use the
    // dispatcher spy here to inspect calendar admission independently of Bash.
    const restarted = vi.fn(async () => undefined);
    setExecuteCallback(restarted);
    await advance();
    expect(getTask(task.id)?.calendar).toBe('demo');
    expect(restarted).toHaveBeenCalledTimes(1);
  });
  it.each(['dashboard', 'cli'])('manual %s run bypasses even missing calendars', async trigger => {
    const task = create('absent');
    const gate = installGate();
    if (trigger === 'dashboard') {
      expect(runNow(task.id)).toEqual({ ok: true });
      await advance(0);
    } else {
      expect(requestRunNow(task.id)).toEqual({ ok: true });
      // Durable manual intent survives JSON migration/restart.
      expect(snapshot(task.id).manualRunRequested).toBe(true);
      startScheduler();
      await advance(5_000);
    }
    // runNow dispatches in the background. Wait for its persisted completion;
    // advancing by zero does not drain the whole Promise chain under Bun.
    await vi.waitFor(() => expect(snapshot(task.id)).toMatchObject({ lastStatus: 'ok', lastCalendarCheck: { reason: 'manual_bypass' } }));
    expect(gate.bash).toHaveBeenCalledTimes(1);
    expect(gate.model).toHaveBeenCalledTimes(1);
    expect(snapshot(task.id).manualRunRequested).toBeUndefined();
  });
  it.each([
    ['cron', '0 9 * * *', '2026-09-30T04:00:00Z', '2026-09-30T09:00:00Z', '2026-10-01T01:00:00Z'],
    ['interval', 'every 1m', '2026-10-01T00:55:00Z', '2026-10-01T01:00:00Z', '2026-10-01T01:01:05Z'],
  ])('consumes a %s manual request after downtime beyond grace without bypassing the next automatic rest-day run', async (_kind, schedule, requestedAt, restartedAt, automaticAt) => {
    vi.setSystemTime(new Date(requestedAt));
    const task = addTask({ name: 'durable manual request', schedule, prompt: 'fixture',
      workingDir: root, chatId: 'fixture_chat', larkAppId: APP, calendar: 'cn',
      repeat: { times: 3, completed: 0 } });
    const execute = vi.fn(async () => undefined);
    setExecuteCallback(execute);
    startScheduler();
    expect(requestRunNow(task.id)).toEqual({ ok: true });
    stopScheduler();
    vi.clearAllTimers();
    const persisted = snapshot(task.id);
    expect(persisted.manualRunRequested).toBe(true);
    // Reload persisted intent into a fresh store/home, as on daemon restart.
    config.session.dataDir = join(root, 'restarted-manual', 'data');
    importTasks(APP, [[task.id, persisted]]);
    vi.setSystemTime(new Date(restartedAt));
    startScheduler();
    await advance(5_000);
    await vi.waitFor(() => expect(snapshot(task.id)).toMatchObject({
      lastStatus: 'ok', lastCalendarCheck: { reason: 'manual_bypass' }, repeat: { completed: 1 },
    }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(snapshot(task.id).manualRunRequested).toBeUndefined();
    expect(snapshot(task.id).nextRunAt).toBe(new Date(automaticAt).toISOString());
    // Let the actual persisted next occurrence become due on a confirmed CN rest day.
    stopScheduler();
    vi.clearAllTimers();
    vi.setSystemTime(new Date(Date.parse(automaticAt) - 5_000));
    startScheduler();
    await advance(5_000);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(snapshot(task.id)).toMatchObject({ lastStatus: 'skipped',
      lastCalendarCheck: { reason: 'rest_date', matches: false }, repeat: { completed: 1 } });
    expect(snapshot(task.id).manualRunRequested).toBeUndefined();
    expect(queryScheduleRunLogs(task.id, {}, APP).logs[0]).toMatchObject({
      trigger: 'scheduler', outcome: 'calendar_skipped', calendarCheck: { reason: 'rest_date' },
    });
  });
  it.each(['0 9 * * *', 'every 1m'])('still fast-forwards a stale automatic occurrence for %s', async schedule => {
    vi.setSystemTime(new Date('2026-09-30T04:00:00Z'));
    const task = addTask({ name: 'stale automatic task', schedule, prompt: 'fixture',
      workingDir: root, chatId: 'fixture_chat', larkAppId: APP });
    updateTask(task.id, { nextRunAt: new Date().toISOString() });
    const execute = vi.fn(async () => undefined);
    setExecuteCallback(execute);
    vi.setSystemTime(new Date('2026-09-30T09:00:00Z'));
    startScheduler();
    await advance(5_000);
    expect(execute).not.toHaveBeenCalled();
    expect(Date.parse(snapshot(task.id).nextRunAt)).toBeGreaterThan(Date.now());
    expect(snapshot(task.id).lastRunAt).toBeUndefined();
    expect(snapshot(task.id).manualRunRequested).toBeUndefined();
  });
  it.each(['dashboard', 'cli'])('cancels pending manual intent when paused through %s before resuming on a rest day', async entry => {
    vi.setSystemTime(new Date('2026-09-30T04:00:00Z'));
    const task = addTask({ name: 'pause pending manual task', schedule: '0 9 * * *', prompt: 'fixture',
      workingDir: root, chatId: 'fixture_chat', larkAppId: APP, calendar: 'cn' });
    const execute = vi.fn(async () => undefined);
    setExecuteCallback(execute);
    expect(requestRunNow(task.id)).toEqual({ ok: true });
    if (entry === 'dashboard') expect(setEnabled(task.id, false)).toEqual({ ok: true });
    else expect(disableTask(task.id)).toBe(true);
    expect(snapshot(task.id).manualRunRequested).toBeUndefined();
    vi.setSystemTime(new Date('2026-10-01T00:59:55Z'));
    if (entry === 'dashboard') expect(setEnabled(task.id, true)).toEqual({ ok: true });
    else expect(enableTask(task.id)).toBe(true);
    startScheduler();
    await advance(5_000);
    expect(execute).not.toHaveBeenCalled();
    expect(snapshot(task.id)).toMatchObject({ lastStatus: 'skipped', lastCalendarCheck: { reason: 'rest_date' } });
  });
  it('rejects durable run requests while paused without mutating the next occurrence', () => {
    const task = create();
    expect(disableTask(task.id)).toBe(true);
    const paused = snapshot(task.id);
    expect(requestRunNow(task.id)).toEqual({ ok: false, error: 'disabled' });
    expect(snapshot(task.id)).toEqual(paused);
  });
  it('clears legacy pending intent even when Dashboard pause is repeated', () => {
    const task = create();
    updateTask(task.id, { enabled: false, disabledReason: 'manual', manualRunRequested: true });
    expect(setEnabled(task.id, false)).toEqual({ ok: true });
    expect(snapshot(task.id).manualRunRequested).toBeUndefined();
  });
  it('keeps Dashboard immediate execution available for a paused task without resuming it', async () => {
    const task = create('absent');
    const gate = installGate();
    expect(setEnabled(task.id, false)).toEqual({ ok: true });
    expect(runNow(task.id)).toEqual({ ok: true });
    await vi.waitFor(() => expect(snapshot(task.id)).toMatchObject({ enabled: false,
      lastStatus: 'ok', lastCalendarCheck: { reason: 'manual_bypass' } }));
    expect(gate.model).toHaveBeenCalledTimes(1);
    expect(snapshot(task.id).manualRunRequested).toBeUndefined();
  });
  it.each(['dashboard', 'cli'])('drops legacy paused manual intent when resumed through %s', entry => {
    const task = create();
    updateTask(task.id, { enabled: false, disabledReason: 'manual', manualRunRequested: true });
    if (entry === 'dashboard') expect(setEnabled(task.id, true)).toEqual({ ok: true });
    else expect(enableTask(task.id)).toBe(true);
    expect(snapshot(task.id).manualRunRequested).toBeUndefined();
  });
  it('does not defer a valid pending request when CLI resume is repeated on an enabled task', async () => {
    const task = create('absent');
    const gate = installGate();
    expect(requestRunNow(task.id)).toEqual({ ok: true });
    const pending = snapshot(task.id);
    expect(enableTask(task.id)).toBe(true);
    expect(snapshot(task.id)).toEqual(pending);
    startScheduler();
    await advance(5_000);
    await vi.waitFor(() => expect(snapshot(task.id).lastStatus).toBe('ok'));
    expect(gate.model).toHaveBeenCalledTimes(1);
    expect(snapshot(task.id).manualRunRequested).toBeUndefined();
  });
  it('cancels pending manual intent when a changed schedule next fires on a rest day', async () => {
    vi.setSystemTime(new Date('2026-09-30T04:00:00Z'));
    const task = addTask({ name: 'edit pending manual task', schedule: '0 9 * * 1', prompt: 'fixture',
      workingDir: root, chatId: 'fixture_chat', larkAppId: APP, calendar: 'cn',
      repeat: { times: 3, completed: 0 } });
    const execute = vi.fn(async () => undefined);
    setExecuteCallback(execute);
    expect(requestRunNow(task.id)).toEqual({ ok: true });
    expect(snapshot(task.id).manualRunRequested).toBe(true);
    expect(editTask(task.id, { schedule: '0 9 * * *' })).toEqual({ ok: true });
    expect(snapshot(task.id).manualRunRequested).toBeUndefined();
    expect(snapshot(task.id).nextRunAt).toBe('2026-10-01T01:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-01T00:59:55Z'));
    startScheduler();
    await advance(5_000);
    expect(execute).not.toHaveBeenCalled();
    expect(snapshot(task.id)).toMatchObject({ lastStatus: 'skipped',
      lastCalendarCheck: { reason: 'rest_date', matches: false }, repeat: { completed: 0 } });
    expect(queryScheduleRunLogs(task.id, {}, APP).logs[0]).toMatchObject({
      trigger: 'scheduler', outcome: 'calendar_skipped', calendarCheck: { reason: 'rest_date' },
    });
  });
  it('preserves a valid pending manual request when editing without changing its schedule', async () => {
    const task = addTask({ name: 'edit pending label', schedule: 'every 1m', prompt: 'fixture',
      workingDir: root, chatId: 'fixture_chat', larkAppId: APP, calendar: 'absent' });
    const execute = vi.fn(async () => undefined);
    setExecuteCallback(execute);
    expect(requestRunNow(task.id)).toEqual({ ok: true });
    const pendingAt = snapshot(task.id).nextRunAt;
    expect(editTask(task.id, { name: 'updated label', schedule: task.schedule })).toEqual({ ok: true });
    expect(snapshot(task.id)).toMatchObject({ manualRunRequested: true, nextRunAt: pendingAt });
    startScheduler();
    await advance(5_000);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(snapshot(task.id).manualRunRequested).toBeUndefined();
    expect(snapshot(task.id).lastCalendarCheck.reason).toBe('manual_bypass');
  });
  it('rejects once binding on create/update while preserving legacy once', () => {
    expect(() => create('demo', { schedule: '30m' })).toThrow('calendar_once_unsupported');
    const task = create(null, { schedule: '30m' });
    expect(editTask(task.id, { calendar: 'demo' })).toEqual({ ok: false, error: 'calendar_once_unsupported' });
    expect(getTask(task.id)?.calendar).toBeUndefined();
  });
});
