import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { __setScheduleStoreBeforeRenameTestHook, getTask, markRun, setScheduleScope, updateTask as updateStoredTask } from '../src/services/schedule-store.js';
import { resolveSchedulePrecondition, schedulePreconditionPath } from '../src/services/schedule-precondition-store.js';
import { createTaskWithOptionalPrecondition } from '../src/core/schedule-precondition-config.js';
import { applyManagedScheduleUpdate } from '../src/core/schedule-managed-update.js';
import * as scheduler from '../src/core/scheduler.js';
import { scheduleTimeZone } from '../src/utils/timezone.js';

// The commit half of `botmux schedule update`: the daemon's managed route
// calls this after authorization, against the real schedule and protected
// precondition stores.
const APP_ID = 'cli_managed_update_test';
const NOW = new Date('2026-11-06T10:17:00.000Z');
let tempDir: string;
let previousDataDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'botmux-schedule-managed-update-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = join(tempDir, 'data');
  setScheduleScope(APP_ID);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  __setScheduleStoreBeforeRenameTestHook(undefined);
  vi.useRealTimers();
  config.session.dataDir = previousDataDir;
  setScheduleScope('cli_ipc_test_bot001');
  rmSync(tempDir, { recursive: true, force: true });
});

/** A patrol-like task: silent, own fresh topic, workday calendar, a creator,
 *  a Bash precondition and some run history. */
function patrolTask() {
  const created = createTaskWithOptionalPrecondition({
    name: 'patrol',
    schedule: 'every 1h',
    prompt: 'patrol the board\n',
    workingDir: tempDir,
    chatId: 'oc_patrol',
    larkAppId: APP_ID,
    executionPosition: 'new-topic',
    silent: true,
    calendar: 'cn',
    ownerOpenId: 'ou_owner',
    ownerUnionId: 'on_owner',
  }, APP_ID, { enabled: true, source: { kind: 'inline', script: 'printf 1' } });
  updateStoredTask(created.id, {
    lastRunAt: '2026-11-06T10:00:00.000Z', lastStatus: 'ok', lastRunId: 'run-9',
    runStats: { dispatched: 9, failed: 1, missed: 0, skipped: 2, consecutiveFailures: 0 },
  });
  return getTask(created.id, APP_ID)!;
}

function withoutFrequency(task: Record<string, unknown>) {
  const { schedule: _s, parsed: _p, nextRunAt: _n, ...rest } = task;
  return rest;
}

function localTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: scheduleTimeZone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(iso));
}

describe('managed schedule frequency update', () => {
  it('changes a cron frequency and keeps every other field, the precondition and the history', () => {
    const before = patrolTask();
    const result = applyManagedScheduleUpdate(before.id, APP_ID, { schedule: '30 */4 * * *' });

    expect(result).toMatchObject({ ok: true, task: { schedule: '30 */4 * * *', enabled: true, calendar: 'cn' } });
    const after = getTask(before.id, APP_ID)!;
    expect(after.parsed).toMatchObject({ kind: 'cron', expr: '30 */4 * * *' });
    expect(withoutFrequency(after as never)).toEqual(withoutFrequency(before as never));
    expect(resolveSchedulePrecondition(after, APP_ID)).toEqual({
      kind: 'configured', enabled: true, source: { kind: 'inline', script: 'printf 1' },
    });
    // Next run is the first cron slot after now, never now (no catch-up).
    const next = Date.parse(after.nextRunAt!);
    expect(next).toBeGreaterThan(NOW.getTime());
    expect(next - NOW.getTime()).toBeLessThanOrEqual(4 * 3600_000);
    expect(new Date(next).getUTCMinutes()).toBe(30);
    expect(after.manualRunRequested).toBeUndefined();
    if (result.ok) expect(result.task.nextRunAt).toBe(after.nextRunAt);
  });

  it('changes to an interval and counts the next run from now', () => {
    const before = patrolTask();
    const result = applyManagedScheduleUpdate(before.id, APP_ID, { schedule: 'every 4h' });
    expect(result).toMatchObject({ ok: true });
    const after = getTask(before.id, APP_ID)!;
    expect(after.parsed).toMatchObject({ kind: 'interval', minutes: 240 });
    expect(after.nextRunAt).toBe(new Date(NOW.getTime() + 4 * 3600_000).toISOString());
    expect(after.lastRunAt).toBe(before.lastRunAt);
  });

  it('accepts the Chinese natural-language frequency add accepts', () => {
    const before = patrolTask();
    const result = applyManagedScheduleUpdate(before.id, APP_ID, { schedule: '每日17:50' });
    expect(result).toMatchObject({ ok: true, task: { schedule: '每日17:50' } });
    const after = getTask(before.id, APP_ID)!;
    expect(after.parsed.kind).toBe('cron');
    const next = Date.parse(after.nextRunAt!);
    expect(next).toBeGreaterThan(NOW.getTime());
    expect(next - NOW.getTime()).toBeLessThanOrEqual(24 * 3600_000);
    expect(localTime(after.nextRunAt!)).toBe('17:50');
  });

  it('changes frequency and prompt together', () => {
    const before = patrolTask();
    expect(applyManagedScheduleUpdate(before.id, APP_ID, { schedule: 'every 4h', prompt: 'new prompt' }))
      .toMatchObject({ ok: true });
    expect(getTask(before.id, APP_ID)).toMatchObject({ schedule: 'every 4h', prompt: 'new prompt', silent: true });
  });

  it('refuses an unreadable frequency and leaves the task untouched', () => {
    const before = patrolTask();
    const result = applyManagedScheduleUpdate(before.id, APP_ID, { schedule: 'sometimes' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^invalid_schedule/);
    expect(getTask(before.id, APP_ID)).toEqual(before);
    expect(resolveSchedulePrecondition(getTask(before.id, APP_ID)!, APP_ID)).toMatchObject({ kind: 'configured' });
  });

  it('refuses a one-shot frequency while a work calendar is bound', () => {
    const before = patrolTask();
    expect(applyManagedScheduleUpdate(before.id, APP_ID, { schedule: '30m' }))
      .toEqual({ ok: false, error: 'calendar_once_unsupported' });
    expect(getTask(before.id, APP_ID)).toEqual(before);
  });

  it('keeps a paused task paused and reports it', () => {
    const before = patrolTask();
    scheduler.disableTask(before.id);
    const result = applyManagedScheduleUpdate(before.id, APP_ID, { schedule: 'every 4h' });
    expect(result).toMatchObject({ ok: true, task: { enabled: false } });
    expect(getTask(before.id, APP_ID)).toMatchObject({ enabled: false, disabledReason: 'manual', schedule: 'every 4h' });
  });

  it('gives a finished one-shot a next run only for a new expression, the same one resume then schedules', () => {
    // The CLI points a finished one-shot at `schedule resume` only when the
    // update receipt carries a next run, so the receipt has to agree with what
    // resume actually schedules.
    const finishedOneShot = () => {
      const created = scheduler.addTask({
        name: 'once', schedule: '30m', prompt: 'p', workingDir: tempDir, chatId: 'oc_patrol', larkAppId: APP_ID,
      });
      markRun(created.id, true);
      return created.id;
    };
    const resent = finishedOneShot();
    const changed = finishedOneShot();
    vi.setSystemTime(new Date(NOW.getTime() + 24 * 3600_000));
    const fourHoursOn = new Date(NOW.getTime() + 28 * 3600_000).toISOString();

    expect(applyManagedScheduleUpdate(resent, APP_ID, { schedule: '30m' })).toMatchObject({
      ok: true, task: { schedule: '30m', nextRunAt: null, enabled: false, disabledReason: 'once_completed' },
    });
    expect(applyManagedScheduleUpdate(changed, APP_ID, { schedule: 'every 4h' })).toMatchObject({
      ok: true, task: { schedule: 'every 4h', nextRunAt: fourHoursOn, enabled: false, disabledReason: 'once_completed' },
    });

    expect(scheduler.enableTask(resent)).toBe(true);
    expect(scheduler.enableTask(changed)).toBe(true);
    expect(getTask(resent, APP_ID)).toMatchObject({ enabled: true });
    expect(getTask(resent, APP_ID)!.nextRunAt).toBeUndefined();
    expect(getTask(changed, APP_ID)).toMatchObject({ enabled: true, nextRunAt: fourHoursOn });
  });

  it('keeps the until-done retry rule tied to a one-shot', () => {
    const created = scheduler.addTask({
      name: 'follow-up', schedule: '2026-11-07T10:00', prompt: 'clean up', workingDir: tempDir,
      chatId: 'oc_patrol', larkAppId: APP_ID, untilDone: { retryMinutes: 360 },
    });
    const before = getTask(created.id, APP_ID)!;
    expect(applyManagedScheduleUpdate(created.id, APP_ID, { schedule: 'every 4h' }))
      .toEqual({ ok: false, error: 'until_done_retry_requires_once' });
    expect(getTask(created.id, APP_ID)).toEqual(before);
  });

  it('refuses a frequency change while a claimed run is still in flight', () => {
    // The run settles against the task as it is when it finishes: a one-shot
    // written mid-run would be consumed by the old recurring run.
    const before = patrolTask();
    updateStoredTask(before.id, { lastStatus: 'running', lastRunId: 'run-10' });
    const inFlight = getTask(before.id, APP_ID)!;
    expect(applyManagedScheduleUpdate(before.id, APP_ID, { schedule: 'every 4h' }))
      .toEqual({ ok: false, error: 'schedule_run_in_flight' });
    expect(getTask(before.id, APP_ID)).toEqual(inFlight);
  });

  it('refuses a one-shot time that has already passed', () => {
    const created = scheduler.addTask({
      name: 'plain', schedule: 'every 1h', prompt: 'p', workingDir: tempDir,
      chatId: 'oc_patrol', larkAppId: APP_ID,
    });
    const before = getTask(created.id, APP_ID)!;
    expect(applyManagedScheduleUpdate(created.id, APP_ID, { schedule: '2026-11-01T09:00' }))
      .toEqual({ ok: false, error: 'schedule_in_past' });
    expect(getTask(created.id, APP_ID)).toEqual(before);
    expect(applyManagedScheduleUpdate(created.id, APP_ID, { schedule: '2026-11-08T09:00' }))
      .toMatchObject({ ok: true, task: { nextRunAt: expect.any(String) } });
  });

  it('keeps the first run no later than an until-done deadline', () => {
    const created = scheduler.addTask({
      name: 'bounded', schedule: '2026-11-07T10:00', prompt: 'wrap up', workingDir: tempDir,
      chatId: 'oc_patrol', larkAppId: APP_ID, untilDone: { deadline: '2026-11-08T10:00' },
    });
    const before = getTask(created.id, APP_ID)!;
    expect(applyManagedScheduleUpdate(created.id, APP_ID, { schedule: '2026-11-09T09:00' }))
      .toEqual({ ok: false, error: 'until_done_deadline_before_first_run' });
    expect(getTask(created.id, APP_ID)).toEqual(before);
    // A future time still before the deadline is accepted and reschedules.
    expect(applyManagedScheduleUpdate(created.id, APP_ID, { schedule: '2026-11-07T18:00' }))
      .toMatchObject({ ok: true, task: { schedule: '2026-11-07T18:00' } });
  });

  it('rolls the calendar back with the frequency when the precondition rebind fails', () => {
    const before = patrolTask();
    // Losing the protected record between the row write and the rebind makes
    // the compound edit fail after the row already changed.
    __setScheduleStoreBeforeRenameTestHook(() => {
      __setScheduleStoreBeforeRenameTestHook(undefined);
      rmSync(schedulePreconditionPath(APP_ID, before.id), { force: true });
    });
    const result = applyManagedScheduleUpdate(before.id, APP_ID, { schedule: 'every 4h', calendar: null });
    expect(result).toEqual({ ok: false, error: 'schedule_precondition_update_failed' });
    expect(getTask(before.id, APP_ID)).toMatchObject({
      schedule: before.schedule, nextRunAt: before.nextRunAt, calendar: 'cn',
    });
  });

  it('restores a pending manual run together with the frequency when the rebind fails', () => {
    // "Run now" was requested but no tick has claimed it yet. A failed edit
    // reports that nothing changed, so the manual flag must survive the
    // frequency rollback instead of silently cancelling that run.
    const before = patrolTask();
    updateStoredTask(before.id, { manualRunRequested: true });
    expect(getTask(before.id, APP_ID)!.manualRunRequested).toBe(true);
    __setScheduleStoreBeforeRenameTestHook(() => {
      __setScheduleStoreBeforeRenameTestHook(undefined);
      rmSync(schedulePreconditionPath(APP_ID, before.id), { force: true });
    });
    expect(applyManagedScheduleUpdate(before.id, APP_ID, { schedule: 'every 4h' }))
      .toEqual({ ok: false, error: 'schedule_precondition_update_failed' });
    expect(getTask(before.id, APP_ID)).toMatchObject({
      schedule: before.schedule, nextRunAt: before.nextRunAt, manualRunRequested: true,
    });
  });
});
