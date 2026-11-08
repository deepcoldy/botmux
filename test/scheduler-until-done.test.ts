import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as scheduler from '../src/core/scheduler.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import { workCalendarPath } from '../src/services/work-calendar.js';
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

  it('does not grow the missed ledger while the previous run is still in flight', async () => {
    const followUp = add({ name: 'until done', schedule: 'every 1m', untilDone: {} });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    scheduler.setExecuteCallback(async (task, context) => {
      fires.push({ task, context });
      await gate;
    });
    scheduler.startScheduler();

    await minutes(1.5);
    expect(fires).toHaveLength(1);
    expect(current(followUp.id).lastStatus).toBe('running');

    // The turn stays in flight across five later trigger points: the overlap is
    // busyness, not daemon downtime, so nothing enters the missed ledger.
    await minutes(5);
    expect(fires).toHaveLength(1);
    expect(current(followUp.id).runStats?.missed ?? 0).toBe(0);

    release();
    // The settlement must land before the next tick: that tick still owes the
    // overdue window, and while it sees the run in flight it must (by design)
    // record no miss. Node's fake timers drain microtasks between timer
    // callbacks, but bun:test fires the advanced window first — so drain the
    // release() continuation explicitly instead of relying on either runner.
    for (let i = 0; i < 50 && current(followUp.id).lastStatus !== 'ok'; i++) {
      await Promise.resolve();
    }
    expect(current(followUp.id).lastStatus).toBe('ok');
    // The next tick settles the overdue window: the single missed occurrence
    // is caught up once (missed +1) and dispatched. 45s reaches the tick at
    // T+7m but stays before the catch-up run's next regular occurrence.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(current(followUp.id).runStats).toMatchObject({ missed: 1 });
    expect(fires.filter(f => f.task.id === followUp.id)).toHaveLength(2);
    // From here the regular every-1m cadence resumes, but the missed ledger
    // does not keep growing with later ticks.
    await minutes(2);
    expect(current(followUp.id).runStats?.missed).toBe(1);
  });
});

describe('in-flight manual pause', () => {
  function blockRunsOnGate(): () => void {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    scheduler.setExecuteCallback(async (task, context) => {
      fires.push({ task, context });
      await gate;
    });
    return release;
  }

  it('keeps a paused recurring until-done task paused after its run settles', async () => {
    const task = add({ schedule: 'every 1m', untilDone: {} });
    const release = blockRunsOnGate();
    scheduler.startScheduler();

    await minutes(1.5);
    expect(fires).toHaveLength(1);
    expect(current(task.id).lastStatus).toBe('running');

    scheduler.disableTask(task.id);
    release();
    await minutes(0.5);

    // The settlement records the run but must not resurrect the task.
    expect(current(task.id)).toMatchObject({
      enabled: false, disabledReason: 'manual', lastStatus: 'ok',
      runStats: { dispatched: 1 }, untilDone: { status: 'open', attempts: 1 },
    });

    await minutes(5);
    expect(fires).toHaveLength(1);
  });

  it('keeps a paused one-shot until-done task paused, and resumes on request', async () => {
    const task = add({ untilDone: { retryMinutes: 120 } });
    const release = blockRunsOnGate();
    scheduler.startScheduler();

    await minutes(31);
    expect(fires).toHaveLength(1);
    scheduler.disableTask(task.id);
    release();
    await minutes(0.5);

    expect(current(task.id)).toMatchObject({
      enabled: false, disabledReason: 'manual', lastStatus: 'ok',
      untilDone: { status: 'open', attempts: 1 },
    });
    // The computed retry is stored for the resume, not armed while paused.
    expect(Date.parse(current(task.id).nextRunAt!)).toBeGreaterThan(Date.now());

    await minutes(24 * 60);
    expect(fires).toHaveLength(1);

    expect(scheduler.enableTask(task.id)).toBe(true);
    await minutes(1);
    expect(fires).toHaveLength(2);
    expect(current(task.id)).toMatchObject({ enabled: true, lastStatus: 'ok' });
  });

  it('keeps the pause when the failure path settles instead of the success path', async () => {
    const task = add({ schedule: 'every 1m', untilDone: {} });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    scheduler.setExecuteCallback(async (task, context) => {
      fires.push({ task, context });
      await gate;
      throw new Error('dispatch failed');
    });
    scheduler.startScheduler();

    await minutes(1.5);
    scheduler.disableTask(task.id);
    release();
    await minutes(0.5);

    expect(current(task.id)).toMatchObject({
      enabled: false, disabledReason: 'manual', lastStatus: 'error',
      runStats: { failed: 1 }, untilDone: { status: 'open', attempts: 0 },
    });

    await minutes(5);
    expect(fires).toHaveLength(1);
  });
});

describe('closing-run retry window', () => {
  // Regular runs succeed; only the deadline closing run keeps failing.
  function failOnlyClosingRuns(): void {
    scheduler.setExecuteCallback(async (task, context) => {
      fires.push({ task, context });
      if (task.untilDone?.finalRunId === context.runId) throw new Error('closing failed');
    });
  }
  const isFinal = (f: Fire) => f.task.untilDone?.finalRunId === f.context.runId;

  it('stays quiet for the retry hour after a failed closing run (deadline before any regular trigger)', async () => {
    const deadline = new Date(START + 10_000).toISOString();
    const task = add({ schedule: 'every 1m', untilDone: { deadline } });
    failOnlyClosingRuns();
    scheduler.startScheduler();

    await minutes(62);
    // Exactly the closing claim and its finalRetryAt retry: the every-1m
    // cadence never interleaves a turn, so attempts stay honest and the
    // failure streak is never reset by an interleaved success.
    expect(fires).toHaveLength(2);
    expect(fires.every(isFinal)).toBe(true);
    expect(current(task.id).runStats).toMatchObject({ dispatched: 0, failed: 2, consecutiveFailures: 2 });
    expect(current(task.id).untilDone).toMatchObject({ status: 'open', attempts: 0, finalFailures: 2 });
  });

  it('a deadline crossing a regular trigger keeps exactly that pre-deadline run', async () => {
    const deadline = new Date(START + 90_000).toISOString();
    const task = add({ schedule: 'every 1m', untilDone: { deadline } });
    failOnlyClosingRuns();
    scheduler.startScheduler();

    await minutes(62);
    expect(fires).toHaveLength(3); // the T+60s regular run (before the deadline) + two closing runs
    const regular = fires.filter(f => !isFinal(f));
    expect(regular).toHaveLength(1);
    expect(Date.parse(regular[0].context.startedAt)).toBeLessThan(Date.parse(deadline));
    expect(fires.filter(f => !isFinal(f) && Date.parse(f.context.startedAt) >= Date.parse(deadline))).toHaveLength(0);
    expect(current(task.id).runStats).toMatchObject({ dispatched: 1, failed: 2, consecutiveFailures: 2 });
    expect(current(task.id).untilDone).toMatchObject({ status: 'open', attempts: 1, finalFailures: 2 });
  });

  it('regression: a failed one-shot closing run also retries only on the closing schedule', async () => {
    // '30m' one-shot at T+30m; the deadline equals it, so the first fire is
    // already the closing run. The retry window must not revive the one-shot.
    const deadline = new Date(START + 30 * MIN).toISOString();
    const task = add({ untilDone: { deadline } });
    failOnlyClosingRuns();
    scheduler.startScheduler();

    await minutes(31);
    expect(fires).toHaveLength(1);
    expect(isFinal(fires[0])).toBe(true);
    await minutes(60);
    expect(fires).toHaveLength(2);
    expect(fires.every(isFinal)).toBe(true);
    expect(current(task.id).runStats).toMatchObject({ failed: 2, consecutiveFailures: 2 });
  });
});

describe('closing-run retry window bypasses', () => {
  // Same shape as the retry-window group, but every scenario rewrites or
  // bypasses nextRunAt while the window is open — the window, not nextRunAt,
  // must stay the claim floor.
  function failOnlyClosingRuns(): void {
    scheduler.setExecuteCallback(async (task, context) => {
      fires.push({ task, context });
      if (task.untilDone?.finalRunId === context.runId) throw new Error('closing failed');
    });
  }
  const isFinal = (f: Fire) => f.task.untilDone?.finalRunId === f.context.runId;

  it('a recurring pause+resume inside the window does not re-arm the cadence', async () => {
    const deadline = new Date(START + 10_000).toISOString();
    const task = add({ schedule: 'every 1m', untilDone: { deadline } });
    failOnlyClosingRuns();
    scheduler.startScheduler();
    await minutes(2); // closing failed at T+35s; window open until T+60m35s

    scheduler.disableTask(task.id);
    expect(scheduler.enableTask(task.id)).toBe(true); // resume rewrites nextRunAt to the next minute
    await minutes(60);

    expect(fires.filter(f => !isFinal(f))).toHaveLength(0);
    expect(fires).toHaveLength(2);
    expect(current(task.id).runStats).toMatchObject({ dispatched: 0, failed: 2 });
  });

  it('a daemon restart inside the window does not realign a cron task off finalRetryAt', async () => {
    const deadline = new Date(START + 10_000).toISOString();
    const task = add({ schedule: '*/1 * * * *', untilDone: { deadline } });
    failOnlyClosingRuns();
    scheduler.startScheduler();
    await minutes(2);

    scheduler.stopScheduler();
    scheduler.startScheduler(); // startup planCronRealign would recompute nextRunAt
    await minutes(10);

    expect(fires.filter(f => !isFinal(f))).toHaveLength(0);
    await minutes(50);
    expect(fires).toHaveLength(2);
    expect(fires.every(isFinal)).toBe(true);
  });

  it('run-now requests inside the window cannot preempt the closing retry', async () => {
    const deadline = new Date(START + 10_000).toISOString();
    const task = add({ schedule: 'every 1m', untilDone: { deadline } });
    failOnlyClosingRuns();
    scheduler.startScheduler();
    await minutes(2);

    // Queued path (CLI): accepted, but the tick's window gate absorbs it.
    expect(scheduler.runTaskNow(task.id)).toBe(true);
    // Direct dispatch path (dashboard): refused outright, it bypasses the tick.
    expect(scheduler.runNow(task.id)).toEqual({ ok: false, error: 'closing_retry_window' });
    await minutes(60);

    expect(fires.filter(f => !isFinal(f))).toHaveLength(0);
    expect(fires).toHaveLength(2);
  });

  it('editing the schedule inside the window cannot move the claim forward', async () => {
    const deadline = new Date(START + 10_000).toISOString();
    const task = add({ schedule: 'every 1m', untilDone: { deadline } });
    failOnlyClosingRuns();
    scheduler.startScheduler();
    await minutes(2);

    // Equivalent to an updateTask that recomputes nextRunAt into the past.
    store.updateTask(APP, task.id, t => ({ ...t, nextRunAt: new Date(START + 3 * MIN).toISOString() }));
    await minutes(60);

    expect(fires.filter(f => !isFinal(f))).toHaveLength(0);
    expect(fires).toHaveLength(2);
  });

  it('a one-shot resumed inside the window waits for the closing retry, not its past runAt', async () => {
    // runAt = T+30m equals the deadline, so the first fire is the closing run;
    // it fails and parks the retry at T+90m35s.
    const deadline = new Date(START + 30 * MIN).toISOString();
    const task = add({ untilDone: { deadline } });
    failOnlyClosingRuns();
    scheduler.startScheduler();
    await minutes(31);
    expect(fires).toHaveLength(1);
    expect(isFinal(fires[0])).toBe(true);

    scheduler.disableTask(task.id);
    expect(scheduler.enableTask(task.id)).toBe(true); // resume computes max(now, runAt) = now
    await minutes(60);

    expect(fires.filter(f => !isFinal(f))).toHaveLength(0);
    expect(fires).toHaveLength(2);
    expect(current(task.id).untilDone).toMatchObject({ status: 'open', attempts: 0, finalFailures: 2 });
  });
});

describe('calendar error notifications', () => {
  // `{}` fails the strict work-calendars schema: every checkTaskCalendar call
  // returns status 'error', so each claimed run settles as a failed occurrence.
  function breakCalendarFile(): void {
    const file = workCalendarPath(APP);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{}');
  }

  it('authority path: a broken calendar fails the ledger and notifies failing once per streak', async () => {
    breakCalendarFile();
    const task = add({ schedule: 'every 1m', calendar: 'demo', notify: ['failing'] });
    scheduler.startScheduler();

    await minutes(3.5);
    expect(fires).toEqual([]); // blocked before any dispatch
    expect(current(task.id).runStats).toMatchObject({ failed: 3, consecutiveFailures: 3 });
    expect(notices.filter(n => n.event === 'failing')).toHaveLength(1);
  });

  it('legacy JSON path: the same settlement wiring notifies through the projection store', async () => {
    scheduler.setScheduleAuthorityStore(null);
    breakCalendarFile();
    const task = add({ schedule: 'every 1m', calendar: 'demo', notify: ['failing'] });
    scheduler.startScheduler();

    await minutes(3.5);
    expect(fires).toEqual([]);
    expect(scheduleStore.getTask(task.id)).toMatchObject({
      lastStatus: 'error',
      runStats: { failed: 3, consecutiveFailures: 3 },
    });
    expect(notices.filter(n => n.event === 'failing')).toHaveLength(1);
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

  it('marks the streak as notified only after delivery succeeded, so a dropped notice is retried', async () => {
    const delivered: ScheduleNotifyEvent[] = [];
    let failDeliveries = 2;
    scheduler.setScheduleNotifier(async (_task, event) => {
      if (event === 'failing' && failDeliveries > 0) {
        failDeliveries -= 1;
        throw new Error('delivery failed');
      }
      delivered.push(event);
    });
    const task = add({ schedule: 'every 1m', notify: ['failing'] });
    failNext = SCHEDULE_FAILING_THRESHOLD + 2;
    scheduler.startScheduler();

    await minutes(SCHEDULE_FAILING_THRESHOLD + 0.5);
    expect(current(task.id).runStats?.consecutiveFailures).toBe(SCHEDULE_FAILING_THRESHOLD);
    expect(delivered).toEqual([]);
    // Both the notification and its marker are absent: the next failing
    // settlement must offer the event again instead of staying silent.
    expect(current(task.id).runStats?.failingNotifiedAt).toBeUndefined();

    await minutes(2);
    expect(delivered).toEqual(['failing']);
    expect(current(task.id).runStats?.failingNotifiedAt).toBeDefined();
  });

  it('does not burn the streak marker when no notifier is assembled', async () => {
    scheduler.setScheduleNotifier(null);
    const task = add({ schedule: 'every 1m', notify: ['failing'] });
    failNext = SCHEDULE_FAILING_THRESHOLD;
    scheduler.startScheduler();

    await minutes(SCHEDULE_FAILING_THRESHOLD + 0.5);
    expect(current(task.id).runStats?.consecutiveFailures).toBe(SCHEDULE_FAILING_THRESHOLD);
    expect(current(task.id).runStats?.failingNotifiedAt).toBeUndefined();
  });
});

describe('admin alert + owner notify coexistence (#2334 integration)', () => {
  let alerts: Array<{ id: string; consecutiveFailures: number; lastError: string | undefined }>;

  beforeEach(() => {
    alerts = [];
    scheduler.setScheduleFailureAlert((task, consecutiveFailures, lastError) => {
      alerts.push({ id: task.id, consecutiveFailures, lastError });
    });
  });
  afterEach(() => {
    scheduler.setScheduleFailureAlert(null);
  });

  it('a non-opt-in task alerts the admin once per streak and never pages the owner', async () => {
    const task = add({ schedule: 'every 1m' });
    failNext = SCHEDULE_FAILING_THRESHOLD;
    scheduler.startScheduler();

    await minutes(SCHEDULE_FAILING_THRESHOLD + 0.5);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: task.id, consecutiveFailures: SCHEDULE_FAILING_THRESHOLD });
    // 管理员水印落盘即记账（#2334 语义保留）。
    expect(current(task.id).failureAlertSent).toBe(true);
    expect(notices).toEqual([]);

    // 同串后续失败：两个通道都不重复。
    failNext = 1;
    await minutes(1.5);
    expect(alerts).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it('an opted-in task gets the owner notice and the admin alert off the same crossing', async () => {
    const task = add({ schedule: 'every 1m', notify: ['failing'] });
    failNext = SCHEDULE_FAILING_THRESHOLD + 1;
    scheduler.startScheduler();

    await minutes(SCHEDULE_FAILING_THRESHOLD + 0.5);
    expect(alerts).toHaveLength(1);
    expect(notices).toEqual([{ id: task.id, event: 'failing' }]);
    expect(current(task.id).failureAlertSent).toBe(true);
    expect(current(task.id).runStats?.failingNotifiedAt).toBeDefined();
    // owner 水印投递成功才写、管理员水印结算即写——两个水印各自推进，互不代写。
    failNext = 1;
    await minutes(1.5);
    expect(alerts).toHaveLength(1);
    expect(notices).toHaveLength(1);
  });

  it('a dropped owner notice does not un-book the admin watermark (independent semantics)', async () => {
    scheduler.setScheduleNotifier(async () => {
      throw new Error('transport down');
    });
    const task = add({ schedule: 'every 1m', notify: ['failing'] });
    failNext = SCHEDULE_FAILING_THRESHOLD + 1;
    scheduler.startScheduler();

    await minutes(SCHEDULE_FAILING_THRESHOLD + 0.5);
    // 管理员告警在结算点已经发生，owner 投递失败不回滚它。
    expect(alerts).toHaveLength(1);
    expect(current(task.id).failureAlertSent).toBe(true);
    expect(current(task.id).runStats?.failingNotifiedAt).toBeUndefined();

    // owner 通知由下一次失败结算重试，管理员同串保持静默。
    scheduler.setScheduleNotifier((t, event) => { notices.push({ id: t.id, event }); });
    failNext = 1;
    await minutes(1.5);
    expect(notices).toEqual([{ id: task.id, event: 'failing' }]);
    expect(alerts).toHaveLength(1);
  });

  it('a calendar error streak also alerts the admin (shared counter, deliberate consistency)', async () => {
    const file = workCalendarPath(APP);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{}');
    const task = add({ schedule: 'every 1m', calendar: 'demo' });
    scheduler.startScheduler();

    await minutes(3.5);
    expect(fires).toEqual([]);
    expect(current(task.id).runStats).toMatchObject({ failed: 3, consecutiveFailures: 3 });
    expect(alerts).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it('legacy JSON path: a calendar error crossing alerts through the projection store too', async () => {
    scheduler.setScheduleAuthorityStore(null);
    const file = workCalendarPath(APP);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{}');
    add({ schedule: 'every 1m', calendar: 'demo' });
    scheduler.startScheduler();

    await minutes(3.5);
    expect(alerts).toHaveLength(1);
  });
});

describe('planCronRealign closing-window gate (P3 hardening)', () => {
  const closingTask = (finalRetryAt: string): ScheduledTask => ({
    id: 'wf_realign',
    name: 'realign me',
    schedule: '* * * * *',
    parsed: { kind: 'cron', expr: '* * * * *', display: '* * * * *' },
    prompt: 'p',
    workingDir: '/repo',
    chatId: 'oc_chat',
    larkAppId: APP,
    enabled: true,
    createdAt: new Date(START - MIN).toISOString(),
    nextRunAt: finalRetryAt,
    untilDone: { status: 'open', attempts: 1, finalRetryAt },
  });

  it('inside the closing-retry window realign leaves nextRunAt on finalRetryAt', () => {
    const finalRetryAt = new Date(START + 30 * MIN).toISOString();
    const task = closingTask(finalRetryAt);
    // 删掉窗口门时这里会把 nextRunAt 重写到近期 cron 点（维护者探针实测 [] → 近期时间）。
    expect(scheduler.planCronRealign([task], () => true, START + MIN)).toEqual([]);
    expect(task.nextRunAt).toBe(finalRetryAt);
  });

  it('after the window expires the regular cron grid applies again', () => {
    const finalRetryAt = new Date(START + 30 * MIN).toISOString();
    const task = closingTask(finalRetryAt);
    const updates = scheduler.planCronRealign([task], () => true, START + 31 * MIN);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(task.id);
  });

  it('restart realign leaves a windowed task on finalRetryAt', async () => {
    const finalRetryAt = new Date(START + 90 * MIN).toISOString();
    const task = add({ schedule: '*/1 * * * *', untilDone: { deadline: new Date(START + 60 * MIN).toISOString() } });
    // Park the task in its closing retry window with a future finalRetryAt.
    store.updateTask(APP, task.id, t => ({
      ...t,
      nextRunAt: finalRetryAt,
      untilDone: { ...t.untilDone!, status: 'open' as const, finalRetryAt },
    }));
    scheduler.startScheduler(); // runs its startup applyCronRealign over future-dated tasks

    expect(current(task.id).nextRunAt).toBe(finalRetryAt);
    await minutes(2);
    expect(current(task.id).nextRunAt).toBe(finalRetryAt);
  });
});

describe('#2334 migration absorb (authority path)', () => {
  it('parseTask folds a #2334-shaped task counter into the ledger on read', () => {
    const APP2 = 'cli_until_done2';
    const legacy = {
      id: 'wf_legacy_counter',
      name: 'legacy counter',
      schedule: '0 9 * * *',
      parsed: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
      prompt: 'p',
      workingDir: '/repo',
      chatId: 'oc_chat',
      larkAppId: APP2,
      enabled: true,
      createdAt: new Date(START).toISOString(),
      // #2334's shipped shape: counter top-level, no ledger.
      consecutiveFailures: 2,
    } as unknown as ScheduledTask;
    store.initializeApp(APP2, [legacy]);

    const read = store.listTasks(APP2).find(t => t.id === 'wf_legacy_counter')!;
    expect(read.runStats?.consecutiveFailures).toBe(2);
    expect((read as ScheduledTask & { consecutiveFailures?: number }).consecutiveFailures).toBeUndefined();
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
