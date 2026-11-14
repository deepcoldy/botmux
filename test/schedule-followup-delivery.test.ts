import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { logger } from '../src/utils/logger.js';
import * as scheduler from '../src/core/scheduler.js';
import * as scheduleStore from '../src/services/schedule-store.js';
import { ScheduleAuthorityStore } from '../src/services/schedule-authority-store.js';
import { scheduleCreatePlacement, scheduleSupportDetails } from '../src/core/schedule-followup.js';
import { toScheduleDetailDto } from '../src/dashboard/schedule-card-model.js';
import type { ScheduledTask } from '../src/types.js';

const APP = 'cli_schedule_followup_delivery';
const START = Date.parse('2026-11-14T00:00:00Z');
let directory: string;
let previousDataDir: string;
let authority: ScheduleAuthorityStore;
let fires: Array<{ task: ScheduledTask; context: scheduler.ScheduleExecutionContext }>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  directory = mkdtempSync(join(tmpdir(), 'schedule-followup-delivery-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = join(directory, 'data');
  for (const level of ['info', 'warn', 'error', 'debug'] as const) vi.spyOn(logger, level).mockImplementation(() => undefined);
  scheduleStore.setScheduleScope(APP);
  authority = ScheduleAuthorityStore.open(config.session.dataDir);
  authority.initializeApp(APP, []);
  scheduler.setScheduleAuthorityStore(authority);
  scheduler.setOwnerFilter(APP, true);
  fires = [];
  scheduler.setExecuteCallback(async (task, context) => { fires.push({ task, context }); });
});

afterEach(() => {
  scheduler.stopScheduler();
  scheduler.setExecuteCallback(async () => undefined);
  scheduler.setScheduleAuthorityStore(null);
  authority.close();
  config.session.dataDir = previousDataDir;
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

function addFollowup(overrides: Partial<Parameters<typeof scheduler.addTask>[0]> = {}): ScheduledTask {
  const placement = scheduleCreatePlacement({
    newTopic: false, topLevel: false, topic: false, followActive: false, untilDone: true,
    chatId: 'oc_question', currentChatId: 'oc_question', currentChatType: 'group',
    currentScope: 'thread', rootMessageId: 'om_question',
  });
  return scheduler.addTask({
    id: 'f0110a01', name: 'follow the original question', prompt: 'check rule 123',
    schedule: 'every 1m', workingDir: directory, chatId: 'oc_question',
    rootMessageId: placement.position === 'topic' ? 'om_question' : undefined,
    executionPosition: placement.position, larkAppId: APP, untilDone: {}, ...overrides,
  });
}

const current = (id: string) => authority.getRecord(APP, id)!.task;
const detail = (task: ScheduledTask) => toScheduleDetailDto(task, { nowMs: Date.now(), timezone: 'UTC' });

function reloadAuthority(): void {
  scheduler.stopScheduler();
  scheduler.setScheduleAuthorityStore(null);
  authority.close();
  authority = ScheduleAuthorityStore.open(config.session.dataDir);
  scheduler.setScheduleAuthorityStore(authority);
}

describe('follow-up summaries from real scheduler state', () => {
  it('recognizes completion without an optional note and retains it through restart', async () => {
    const task = addFollowup();
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fires).toHaveLength(1);
    expect(scheduleSupportDetails(current(task.id)).outcome).toBe('ok');

    vi.advanceTimersByTime(1000);
    expect(scheduler.completeTask(task.id)).toEqual({ ok: true, replay: false });
    const done = current(task.id);
    const summary = scheduleSupportDetails(done);
    expect(done.untilDone?.doneNote).toBeUndefined();
    expect(summary.outcome).toBe('completed');
    expect(summary.lastResultNote).toBeUndefined();
    expect(summary.stop).toMatchObject({ kind: 'until-done', status: 'done', completedAt: done.untilDone?.doneAt });
    expect(detail(done).support).toEqual(summary);

    reloadAuthority();
    expect(scheduleSupportDetails(current(task.id)).outcome).toBe('completed');
    expect(detail(current(task.id)).support?.lastResultNote).toBeUndefined();
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fires).toHaveLength(1);
  });

  it.each([
    { label: 'configured retry', configured: 5, expected: 5 },
    { label: 'default retry', configured: undefined, expected: 24 * 60 },
  ])('exposes the actual one-shot $label cadence', async ({ configured, expected }) => {
    const task = addFollowup({ schedule: '1m', untilDone: configured === undefined ? {} : { retryMinutes: configured } });
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(fires).toHaveLength(1);
    const latest = current(task.id);
    const summary = scheduleSupportDetails(latest);
    expect(summary.retryMinutes).toBe(expected);
    expect(detail(latest).support?.retryMinutes).toBe(expected);
    // Check the projection against the actual persisted next execution time.
    expect(Date.parse(latest.nextRunAt!) - Date.parse(latest.lastRunAt!)).toBe(summary.retryMinutes! * 60_000);

    if (configured !== undefined) {
      await vi.advanceTimersByTimeAsync(configured * 60_000 + 30_000);
      expect(fires).toHaveLength(2);
      expect(Date.parse(fires[1].context.startedAt) - Date.parse(fires[0].context.startedAt)).toBe(configured * 60_000);
    }
    reloadAuthority();
    expect(scheduleSupportDetails(current(task.id)).retryMinutes).toBe(expected);
  });
});
