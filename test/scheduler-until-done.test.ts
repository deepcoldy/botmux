import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as scheduler from '../src/core/scheduler.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import {
  buildUntilDoneRunPrompt,
  SCHEDULE_FAILING_THRESHOLD,
  UNTIL_DONE_ERROR_RETRY_MINUTES,
} from '../src/services/schedule-until-done.js';
import type { ScheduledTask, ScheduleNotifyEvent } from '../src/types.js';

vi.mock('../src/services/hook-runner.js', () => ({ emitHookEvent: vi.fn() }));

const APP = 'cli_until_done';
const MIN = 60_000;
const START = Date.parse('2026-10-24T02:00:00.000Z');
let tempDir: string;
let store: ScheduleAuthorityStore;
let previousDataDir: string;

type Fire = { task: ScheduledTask; context: scheduler.ScheduleExecutionContext };
let fires: Fire[];
let failNext: number;
let notices: Array<{ id: string; event: ScheduleNotifyEvent }>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  tempDir = mkdtempSync(join(tmpdir(), 'scheduler-until-done-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = join(tempDir, 'data');
  scheduleStore.setScheduleScope(APP);
  store = ScheduleAuthorityStore.open(config.session.dataDir);
  store.initializeApp(APP, []);
  scheduler.setScheduleAuthorityStore(store);
  scheduler.setOwnerFilter(APP, true);
  fires = [];
  failNext = 0;
  notices = [];
  scheduler.setExecuteCallback(async (task, context) => {
    fires.push({ task, context });
    if (failNext > 0) {
      failNext -= 1;
      throw new Error('dispatch failed');
    }
  });
  scheduler.setScheduleNotifier((task, event) => { notices.push({ id: task.id, event }); });
});

afterEach(() => {
  scheduler.stopScheduler();
  scheduler.setScheduleNotifier(null);
  scheduler.setExecuteCallback(async () => undefined);
  scheduler.setScheduleAuthorityStore(null);
  store.close();
  config.session.dataDir = previousDataDir;
  vi.useRealTimers();
  rmSync(tempDir, { recursive: true, force: true });
});

function add(overrides: Partial<Parameters<typeof scheduler.addTask>[0]> = {}): ScheduledTask {
  return scheduler.addTask({
    name: 'follow up', schedule: '30m', prompt: 'after the PR merges, switch the fleet',
    workingDir: '/repo', chatId: 'oc_chat', larkAppId: APP,
    ...overrides,
  });
}

const current = (id: string) => store.getRecord(APP, id)!.task;
const minutes = (n: number) => vi.advanceTimersByTimeAsync(n * MIN);

describe('until-done one-shot', () => {
  it('keeps re-running until its run marks it done, then never again', async () => {
    const task = add({ untilDone: { retryMinutes: 120 } });
    scheduler.startScheduler();

    await minutes(31);
    expect(fires).toHaveLength(1);
    expect(current(task.id)).toMatchObject({
      enabled: true, lastStatus: 'ok',
      untilDone: { status: 'open', attempts: 1 },
      runStats: { dispatched: 1, failed: 0 },
    });
    expect(Date.parse(current(task.id).nextRunAt!)).toBeGreaterThan(Date.now() + 115 * MIN);

    await minutes(121);
    expect(fires).toHaveLength(2);
    expect(current(task.id).untilDone).toMatchObject({ attempts: 2 });

    expect(scheduler.completeTask(task.id, 'fleet switched')).toEqual({ ok: true, replay: false });
    expect(current(task.id)).toMatchObject({
      enabled: false, disabledReason: 'once_completed',
      untilDone: { status: 'done', doneNote: 'fleet switched' },
    });
    expect(store.getRecord(APP, task.id)!.state).toBe('completed');
    expect(scheduler.completeTask(task.id)).toEqual({ ok: true, replay: true });
    expect(scheduler.enableTask(task.id)).toBe(false);

    await minutes(3 * 24 * 60);
    expect(fires).toHaveLength(2);
  });

  it('retries a failed run soon, where a plain one-shot is consumed by the failure', async () => {
    const plain = add({ name: 'plain' });
    const followUp = add({ name: 'until done', untilDone: {} });
    failNext = 2;
    scheduler.startScheduler();

    await minutes(31);
    expect(fires.map(f => f.task.id).sort()).toEqual([plain.id, followUp.id].sort());
    expect(current(plain.id)).toMatchObject({ enabled: false, lastStatus: 'error' });
    expect(current(followUp.id)).toMatchObject({
      enabled: true, lastStatus: 'error',
      runStats: { failed: 1, consecutiveFailures: 1 },
    });

    await minutes(UNTIL_DONE_ERROR_RETRY_MINUTES + 1);
    expect(fires.filter(f => f.task.id === followUp.id)).toHaveLength(2);
    expect(fires.filter(f => f.task.id === plain.id)).toHaveLength(1);
    expect(current(followUp.id).runStats).toMatchObject({ dispatched: 1, failed: 1, consecutiveFailures: 0 });
  });

  it('survives a daemon restart that interrupted its run', async () => {
    const task = add({ untilDone: {} });
    store.updateTask(APP, task.id, t => ({ ...t, lastStatus: 'running', lastRunId: 'interrupted-run',
      lastRunAt: new Date().toISOString(), nextRunAt: undefined }));

    scheduler.startScheduler();
    expect(current(task.id)).toMatchObject({
      enabled: true, lastStatus: 'error', runStats: { failed: 1 },
      untilDone: { status: 'open' },
    });
    await minutes(UNTIL_DONE_ERROR_RETRY_MINUTES + 1);
    expect(fires).toHaveLength(1);
  });
});

describe('missed windows', () => {
  it('records a missed occurrence on every task and catches up only until-done ones', async () => {
    const plain = add({ name: 'plain', schedule: 'every 60m' });
    const followUp = add({ name: 'until done', schedule: 'every 60m', untilDone: {} });
    // The daemon was down for three hours: both tasks are far past their grace window.
    for (const id of [plain.id, followUp.id]) {
      store.updateTask(APP, id, t => ({ ...t, nextRunAt: new Date(START - 3 * 60 * MIN).toISOString() }));
    }

    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(fires.map(f => f.task.id)).toEqual([followUp.id]);
    for (const id of [plain.id, followUp.id]) {
      expect(current(id).runStats).toMatchObject({ missed: 1, lastMissedAt: new Date(START - 3 * 60 * MIN).toISOString() });
      expect(Date.parse(current(id).nextRunAt!)).toBeGreaterThan(Date.now());
    }
  });
});

describe('deadline', () => {
  it('runs one closing run at the deadline, tells the run so, then expires and notifies', async () => {
    const deadline = new Date(START + 90 * MIN).toISOString();
    const task = add({ schedule: 'every 1d', untilDone: { deadline }, notify: ['expired'] });
    scheduler.startScheduler();

    await minutes(91);
    expect(fires).toHaveLength(1);
    const [closing] = fires;
    expect(closing.task.untilDone?.finalRunId).toBe(closing.context.runId);
    const fmt = (iso: string) => iso;
    expect(buildUntilDoneRunPrompt(closing.task, closing.context.runId, fmt))
      .not.toEqual(buildUntilDoneRunPrompt({ ...closing.task, untilDone: { status: 'open', attempts: 0, deadline } },
        closing.context.runId, fmt));

    expect(current(task.id)).toMatchObject({
      enabled: false, disabledReason: 'once_completed',
      untilDone: { status: 'expired', attempts: 1 },
    });
    expect(notices).toEqual([{ id: task.id, event: 'expired' }]);

    await minutes(2 * 24 * 60);
    expect(fires).toHaveLength(1);
  });
});

describe('failure notifications', () => {
  it('notifies a failure streak once, and again only after a success resets it', async () => {
    const task = add({ schedule: 'every 1m', notify: ['failing'] });
    failNext = SCHEDULE_FAILING_THRESHOLD + 1;
    scheduler.startScheduler();

    await minutes(SCHEDULE_FAILING_THRESHOLD + 1.5);
    expect(current(task.id).runStats?.consecutiveFailures).toBe(SCHEDULE_FAILING_THRESHOLD + 1);
    expect(notices).toEqual([{ id: task.id, event: 'failing' }]);

    await minutes(1);
    expect(current(task.id).runStats).toMatchObject({ consecutiveFailures: 0 });
    expect(current(task.id).runStats?.failingNotifiedAt).toBeUndefined();

    failNext = SCHEDULE_FAILING_THRESHOLD;
    await minutes(SCHEDULE_FAILING_THRESHOLD + 0.5);
    expect(notices).toEqual([{ id: task.id, event: 'failing' }, { id: task.id, event: 'failing' }]);
  });
});

describe('parseUntilDoneInput', () => {
  it('reuses the schedule grammar: one-shot times for deadlines, durations for retries', () => {
    expect(scheduler.parseUntilDoneInput({ deadline: '2026-11-20T00:00:00.000Z', retryEvery: '6h' }))
      .toEqual({ deadline: '2026-11-20T00:00:00.000Z', retryMinutes: 360 });
    expect(scheduler.parseUntilDoneInput({ deadline: '7d' }))
      .toEqual({ deadline: new Date(START + 7 * 24 * 60 * MIN).toISOString() });
    expect(() => scheduler.parseUntilDoneInput({ deadline: '0 9 * * *' })).toThrow('until_done_deadline_invalid');
    expect(() => scheduler.parseUntilDoneInput({ retryEvery: 'sometimes' })).toThrow('until_done_retry_invalid');
  });
});
