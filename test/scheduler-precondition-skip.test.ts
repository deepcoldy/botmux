import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { dashboardEventBus, type DashboardEvent } from '../src/core/dashboard-events.js';
import { createTaskWithOptionalPrecondition } from '../src/core/schedule-precondition-config.js';
import {
  runNow,
  setExecuteCallback,
  setOwnerFilter,
  startScheduler,
  stopScheduler,
  type ScheduleExecutionContext,
} from '../src/core/scheduler.js';
import {
  executeScheduledTaskWithPrecondition,
  type ScheduledTaskPreconditionObservation,
} from '../src/services/schedule-precondition-gate.js';
import { readSchedulePreconditionFile } from '../src/services/schedule-precondition-file.js';
import { emitHookEvent } from '../src/services/hook-runner.js';
import type { SchedulePreconditionResult } from '../src/services/schedule-precondition-runner.js';
import {
  resolveSchedulePrecondition,
  schedulePreconditionPath,
} from '../src/services/schedule-precondition-store.js';
import {
  appendScheduleRunLog,
  queryScheduleRunLogs,
  scheduleRunLogPath,
} from '../src/services/schedule-run-log-store.js';
import { getScheduleScope, getTask, scheduleFilePathFor, setScheduleScope, updateTask } from '../src/services/schedule-store.js';
import type { ScheduledTask } from '../src/types.js';

vi.mock('../src/services/hook-runner.js', () => ({ emitHookEvent: vi.fn() }));

const APP_ID = 'cli_scheduler_precondition_skip_test';
const TRIGGERS = ['scheduler', 'dashboard'] as const;
let tempDir: string;
let dataDir: string;
let previousDataDir: string;
let previousScope: string | null;
let events: DashboardEvent[];
let unsubscribeEvents: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
  vi.clearAllMocks();
  tempDir = mkdtempSync(join(tmpdir(), 'botmux-scheduler-precondition-skip-'));
  dataDir = join(tempDir, 'data');
  previousDataDir = config.session.dataDir;
  previousScope = getScheduleScope();
  config.session.dataDir = dataDir;
  setScheduleScope(APP_ID);
  setOwnerFilter(APP_ID, true);
  events = [];
  unsubscribeEvents = dashboardEventBus.subscribe(event => events.push(event));
});

afterEach(() => {
  stopScheduler();
  unsubscribeEvents();
  vi.clearAllTimers();
  setExecuteCallback(async () => undefined);
  config.session.dataDir = previousDataDir;
  setScheduleScope(previousScope ?? APP_ID);
  vi.useRealTimers();
  rmSync(tempDir, { recursive: true, force: true });
});

function createGuardedTask(schedule = 'every 1m', precondition: 'enabled' | 'disabled' | 'none' = 'enabled') {
  return createTaskWithOptionalPrecondition({
    name: 'Three model dispatches',
    schedule,
    prompt: 'Test-only model dispatch',
    workingDir: tempDir,
    chatId: 'oc_precondition_skip_test',
    larkAppId: APP_ID,
    repeat: { times: 3, completed: 0 },
  }, APP_ID, precondition === 'none' ? undefined : {
    enabled: precondition === 'enabled',
    source: { kind: 'inline', script: 'printf 1' },
  });
}

function installGate() {
  let allowExecution = false;
  const runPrecondition = vi.fn(async (): Promise<SchedulePreconditionResult> => ({
    decision: allowExecution ? 'pass' : 'skip',
  }));
  const executeModel = vi.fn(async () => undefined);
  const execute = vi.fn(async (scheduled: ScheduledTask, context: ScheduleExecutionContext) => {
    let observation: ScheduledTaskPreconditionObservation = { precondition: 'none', additionalPrompt: false };
    const outcome = await executeScheduledTaskWithPrecondition(
      scheduled,
      APP_ID,
      executeModel,
      { resolve: resolveSchedulePrecondition, readFile: readSchedulePreconditionFile, run: runPrecondition },
      current => { observation = current; },
    );
    appendScheduleRunLog({
      id: context.runId,
      taskId: scheduled.id,
      trigger: context.trigger,
      startedAt: context.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - Date.parse(context.startedAt),
      outcome: outcome === 'skipped' ? 'precondition_skipped' : 'model_dispatched',
      ...observation,
    }, APP_ID, dataDir);
    return outcome;
  });
  setExecuteCallback(execute);
  return { execute, executeModel, runPrecondition, allowExecution: () => { allowExecution = true; } };
}

function persistedTask(taskId: string): ScheduledTask | undefined {
  return JSON.parse(readFileSync(scheduleFilePathFor(APP_ID), 'utf8'))[taskId];
}

async function settleExecution(): Promise<void> {
  // runNow is intentionally non-blocking; drain the gate and scheduler's
  // completion handlers without advancing into another automatic tick.
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function advance(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await settleExecution();
}

async function triggerNext(taskId: string, trigger: ScheduleExecutionContext['trigger']): Promise<void> {
  if (trigger === 'scheduler') {
    await vi.advanceTimersByTimeAsync(60_000);
  } else {
    expect(runNow(taskId)).toEqual({ ok: true });
  }
  await settleExecution();
}

describe('scheduler repeat accounting after a precondition skip', () => {
  it.each(TRIGGERS)(
    'keeps a three-run task and its sidecars after three %s skips, then counts an execution',
    async trigger => {
      const task = createGuardedTask();
      updateTask(task.id, { lastStatus: 'error', lastError: 'old execution failure', lastDeliveryError: 'old delivery failure' });
      const protectedPath = schedulePreconditionPath(APP_ID, task.id, dataDir);
      const protectedBefore = readFileSync(protectedPath, 'utf8');
      const logPath = scheduleRunLogPath(task.id, APP_ID, dataDir);
      const gate = installGate();
      if (trigger === 'scheduler') startScheduler();

      for (let index = 0; index < 3; index += 1) await triggerNext(task.id, trigger);

      expect(gate.execute).toHaveBeenCalledTimes(3);
      expect(gate.runPrecondition).toHaveBeenCalledTimes(3);
      expect(gate.executeModel).not.toHaveBeenCalled();
      expect(getTask(task.id, APP_ID)).toMatchObject({
        enabled: true,
        lastStatus: 'skipped',
        repeat: { times: 3, completed: 0 },
        preconditionRef: task.preconditionRef,
      });
      expect(getTask(task.id, APP_ID)?.lastError).toBeUndefined();
      expect(getTask(task.id, APP_ID)?.lastDeliveryError).toBeUndefined();
      expect(persistedTask(task.id)).toMatchObject({ lastStatus: 'skipped', repeat: { times: 3, completed: 0 } });
      expect(persistedTask(task.id)).not.toHaveProperty('lastError');
      expect(persistedTask(task.id)).not.toHaveProperty('lastDeliveryError');
      expect(events.filter(event => event.type === 'schedule.fired').map(event => event.body))
        .toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ id: task.id, status: 'skipped' })));
      expect(vi.mocked(emitHookEvent).mock.calls.filter(([name]) => name === 'schedule.fired').map(([, body]) => body))
        .toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ id: task.id, status: 'skipped' })));
      expect(existsSync(protectedPath)).toBe(true);
      expect(readFileSync(protectedPath, 'utf8')).toBe(protectedBefore);
      expect(existsSync(logPath)).toBe(true);
      const skippedLogs = queryScheduleRunLogs(task.id, {}, APP_ID, dataDir);
      expect(skippedLogs.total).toBe(3);
      expect(skippedLogs.logs.map(log => ({ trigger: log.trigger, outcome: log.outcome, precondition: log.precondition })))
        .toEqual(Array.from({ length: 3 }, () => ({ trigger, outcome: 'precondition_skipped', precondition: 'skipped' })));

      gate.allowExecution();
      await triggerNext(task.id, trigger);

      expect(gate.execute).toHaveBeenCalledTimes(4);
      expect(gate.executeModel).toHaveBeenCalledTimes(1);
      expect(getTask(task.id, APP_ID)?.repeat).toEqual({ times: 3, completed: 1 });
      expect(readFileSync(protectedPath, 'utf8')).toBe(protectedBefore);
      expect(queryScheduleRunLogs(task.id, {}, APP_ID, dataDir)).toMatchObject({
        total: 4,
        logs: [
          { outcome: 'model_dispatched', precondition: 'passed' },
          { outcome: 'precondition_skipped', precondition: 'skipped' },
          { outcome: 'precondition_skipped', precondition: 'skipped' },
          { outcome: 'precondition_skipped', precondition: 'skipped' },
        ],
      });
    },
  );

  it.each(TRIGGERS)('keeps counting a legacy void callback under %s execution', async trigger => {
    const task = createGuardedTask();
    const execute = vi.fn(async () => undefined);
    setExecuteCallback(execute);
    if (trigger === 'scheduler') startScheduler();

    await triggerNext(task.id, trigger);
    expect(getTask(task.id, APP_ID)?.repeat).toEqual({ times: 3, completed: 1 });
    await triggerNext(task.id, trigger);
    expect(getTask(task.id, APP_ID)?.repeat).toEqual({ times: 3, completed: 2 });
    await triggerNext(task.id, trigger);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(getTask(task.id, APP_ID)).toBeUndefined();
  });

  it.each([
    ['scheduler', 'none'],
    ['scheduler', 'disabled'],
    ['dashboard', 'none'],
    ['dashboard', 'disabled'],
  ] as const)('counts %s execution with a %s precondition as a successful run', async (trigger, precondition) => {
    const task = createGuardedTask('every 1m', precondition);
    const gate = installGate();
    if (trigger === 'scheduler') startScheduler();

    await triggerNext(task.id, trigger);

    expect(gate.runPrecondition).not.toHaveBeenCalled();
    expect(gate.executeModel).toHaveBeenCalledTimes(1);
    await expect(gate.execute.mock.results[0].value).resolves.toBe('executed');
    expect(getTask(task.id, APP_ID)).toMatchObject({ lastStatus: 'ok', repeat: { times: 3, completed: 1 } });
    expect(queryScheduleRunLogs(task.id, {}, APP_ID, dataDir)).toMatchObject({
      total: 1,
      logs: [{ outcome: 'model_dispatched', precondition }],
    });
  });

  it.each(TRIGGERS)('keeps counting execution failures under %s execution', async trigger => {
    const task = createGuardedTask();
    const execute = vi.fn(async () => { throw new Error('test-only model failure'); });
    setExecuteCallback(execute);
    if (trigger === 'scheduler') startScheduler();

    await triggerNext(task.id, trigger);
    expect(getTask(task.id, APP_ID)?.repeat).toEqual({ times: 3, completed: 1 });
    await triggerNext(task.id, trigger);
    expect(getTask(task.id, APP_ID)?.repeat).toEqual({ times: 3, completed: 2 });
    await triggerNext(task.id, trigger);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(getTask(task.id, APP_ID)).toBeUndefined();
  });
});

describe('one-shot scheduler retries after a precondition skip', () => {
  it.each(TRIGGERS)(
    'keeps a skipped %s one-shot enabled and retries every scheduler tick until it executes',
    async trigger => {
      const task = createGuardedTask('2026-09-03T00:01:00.000Z');
      const gate = installGate();
      if (trigger === 'scheduler') startScheduler();
      await advance(60_000);
      if (trigger === 'dashboard') {
        await triggerNext(task.id, trigger);
        startScheduler();
      }

      expect(gate.execute).toHaveBeenCalledTimes(1);
      expect(getTask(task.id, APP_ID)).toMatchObject({
        enabled: true,
        lastStatus: 'skipped',
        nextRunAt: '2026-09-03T00:01:30.000Z',
        repeat: { times: 3, completed: 0 },
      });
      expect(existsSync(schedulePreconditionPath(APP_ID, task.id, dataDir))).toBe(true);
      expect(queryScheduleRunLogs(task.id, {}, APP_ID, dataDir).total).toBe(1);

      await advance(30_000);
      expect(gate.execute).toHaveBeenCalledTimes(2);
      expect(getTask(task.id, APP_ID)).toMatchObject({
        enabled: true,
        lastStatus: 'skipped',
        nextRunAt: '2026-09-03T00:02:00.000Z',
        repeat: { times: 3, completed: 0 },
      });

      gate.allowExecution();
      await advance(30_000);
      expect(gate.execute).toHaveBeenCalledTimes(3);
      expect(gate.executeModel).toHaveBeenCalledTimes(1);
      expect(getTask(task.id, APP_ID)).toMatchObject({
        enabled: false,
        lastStatus: 'ok',
        repeat: { times: 3, completed: 1 },
      });
      expect(getTask(task.id, APP_ID)?.nextRunAt).toBeUndefined();
      expect(gate.execute.mock.calls.map(([, context]) => context.trigger)).toEqual([trigger, 'scheduler', 'scheduler']);
      expect(queryScheduleRunLogs(task.id, {}, APP_ID, dataDir).total).toBe(3);
      await advance(60_000);
      expect(gate.execute).toHaveBeenCalledTimes(3);
    },
  );

  it('preserves the persisted one-shot retry across stopping and restarting the scheduler', async () => {
    const task = createGuardedTask('2026-09-03T00:01:00.000Z');
    const gate = installGate();
    startScheduler();
    await advance(60_000);
    stopScheduler();
    expect(persistedTask(task.id)).toMatchObject({
      enabled: true,
      lastStatus: 'skipped',
      nextRunAt: '2026-09-03T00:01:30.000Z',
      repeat: { times: 3, completed: 0 },
    });

    await advance(5 * 60_000);
    expect(gate.execute).toHaveBeenCalledTimes(1);
    gate.allowExecution();
    startScheduler();
    await advance(5_000);
    expect(gate.execute).toHaveBeenCalledTimes(2);
    expect(gate.execute.mock.calls[1][1].startedAt).toBe('2026-09-03T00:06:05.000Z');
    expect(gate.executeModel).toHaveBeenCalledTimes(1);
    expect(getTask(task.id, APP_ID)).toMatchObject({ enabled: false, repeat: { times: 3, completed: 1 } });
    expect(queryScheduleRunLogs(task.id, {}, APP_ID, dataDir).total).toBe(2);
  });

  it('does not move a future one-shot earlier after a manual run skips', async () => {
    const task = createGuardedTask('2026-09-03T00:02:00.000Z');
    const gate = installGate();
    await triggerNext(task.id, 'dashboard');
    expect(getTask(task.id, APP_ID)).toMatchObject({
      enabled: true,
      lastStatus: 'skipped',
      nextRunAt: task.nextRunAt,
      repeat: { times: 3, completed: 0 },
    });
    startScheduler();
    await advance(90_000);
    expect(gate.execute).toHaveBeenCalledTimes(1);
    gate.allowExecution();
    await advance(30_000);
    expect(gate.execute).toHaveBeenCalledTimes(2);
    expect(gate.execute.mock.calls[1][1].startedAt).toBe('2026-09-03T00:02:00.000Z');
    expect(getTask(task.id, APP_ID)).toMatchObject({ enabled: false, repeat: { times: 3, completed: 1 } });
  });

  it('starts the one-shot retry delay when the precondition check finishes', async () => {
    const task = createGuardedTask('2026-09-03T00:01:00.000Z');
    const gate = installGate();
    gate.runPrecondition.mockImplementationOnce(() => new Promise(resolve => {
      setTimeout(() => resolve({ decision: 'skip' }), 10_000);
    }));
    await advance(60_000);
    await triggerNext(task.id, 'dashboard');
    await advance(10_000);
    expect(getTask(task.id, APP_ID)).toMatchObject({
      enabled: true,
      nextRunAt: '2026-09-03T00:01:40.000Z',
      repeat: { times: 3, completed: 0 },
    });
    gate.allowExecution();
    startScheduler();
    await advance(29_000);
    expect(gate.execute).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(gate.execute).toHaveBeenCalledTimes(2);
    expect(getTask(task.id, APP_ID)).toMatchObject({ enabled: false, repeat: { times: 3, completed: 1 } });
  });

  it('does not re-enable a disabled one-shot when its manual run skips', async () => {
    const task = createGuardedTask('2026-09-03T00:01:00.000Z');
    updateTask(task.id, { enabled: false });
    const gate = installGate();
    await triggerNext(task.id, 'dashboard');
    expect(getTask(task.id, APP_ID)).toMatchObject({
      enabled: false,
      lastStatus: 'skipped',
      repeat: { times: 3, completed: 0 },
    });
    startScheduler();
    await advance(90_000);
    expect(gate.execute).toHaveBeenCalledTimes(1);
    expect(gate.executeModel).not.toHaveBeenCalled();
    expect(queryScheduleRunLogs(task.id, {}, APP_ID, dataDir).total).toBe(1);
  });
});
