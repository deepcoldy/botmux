import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTask } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  listTasks: vi.fn<() => ScheduledTask[]>(),
  getTask: vi.fn<(id: string) => ScheduledTask | undefined>(),
  updateTask: vi.fn(),
  claimRun: vi.fn(),
  requestRunNow: vi.fn(),
  markRun: vi.fn(),
  markSkipped: vi.fn(),
  removeTask: vi.fn(),
  createTask: vi.fn(),
  getScheduleScope: vi.fn(() => 'cli_app'),
  removePrecondition: vi.fn(),
  removeRunLogs: vi.fn(),
  publish: vi.fn(),
  emitHook: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../src/services/schedule-store.js', () => ({
  listTasks: mocks.listTasks,
  getTask: mocks.getTask,
  updateTask: mocks.updateTask,
  claimRun: mocks.claimRun,
  requestRunNow: mocks.requestRunNow,
  markRun: mocks.markRun,
  markSkipped: mocks.markSkipped,
  removeTask: mocks.removeTask,
  createTask: mocks.createTask,
  getScheduleScope: mocks.getScheduleScope,
  effectiveScheduleChatIds: (scheduled: ScheduledTask) => scheduled.chatIds ?? [scheduled.chatId],
}));
vi.mock('../src/services/schedule-precondition-store.js', () => ({
  removeSchedulePrecondition: mocks.removePrecondition,
}));
vi.mock('../src/services/schedule-run-log-store.js', () => ({
  removeScheduleRunLogs: mocks.removeRunLogs,
}));
vi.mock('../src/services/hook-runner.js', () => ({ emitHookEvent: mocks.emitHook }));
vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: mocks.publish },
}));
vi.mock('../src/utils/timezone.js', () => ({
  scheduleTimeZone: () => 'UTC',
  zonedTomorrowAt: vi.fn(),
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: mocks.warn,
  },
}));

import {
  disableTask,
  enableTask,
  removeTask,
  runNow,
  runTaskNow,
  setExecuteCallback,
  setEnabled,
  startScheduler,
  stopScheduler,
  type ScheduleExecutionContext,
} from '../src/core/scheduler.js';

const task: ScheduledTask = {
  id: 'task-context-1',
  name: 'context task',
  schedule: '2026-08-31T00:00:00.000Z',
  parsed: {
    kind: 'once',
    runAt: '2026-08-31T00:00:00.000Z',
    display: 'once',
  },
  prompt: 'private task prompt',
  workingDir: '/tmp',
  chatId: 'oc_chat',
  larkAppId: 'cli_app',
  enabled: true,
  createdAt: '2026-08-30T00:00:00.000Z',
  nextRunAt: '2026-08-31T00:00:00.000Z',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-31T00:01:00.000Z'));
  vi.clearAllMocks();
  mocks.listTasks.mockReturnValue([]);
  mocks.getTask.mockReturnValue(task);
  mocks.claimRun.mockImplementation((id, claim) => {
    const current = mocks.getTask(id);
    return current
      ? { ok: true, task: { ...current, ...claim, lastStatus: 'running' } }
      : { ok: false, error: 'not_found' };
  });
  mocks.requestRunNow.mockReturnValue({ ok: true });
  mocks.removeTask.mockReturnValue(true);
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
});

describe('scheduler execution context', () => {
  it('marks operator disable and clears the reason on enable', () => {
    expect(disableTask(task.id)).toBe(true);
    expect(mocks.updateTask).toHaveBeenCalledWith(task.id, {
      enabled: false, disabledReason: 'manual',
    });

    expect(enableTask(task.id)).toBe(true);
    expect(mocks.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      enabled: true, disabledReason: undefined,
    }));
  });

  it('lets an explicit pause override auto-completed provenance', () => {
    mocks.getTask.mockReturnValue({
      ...task, enabled: false, disabledReason: 'once_completed',
    });
    expect(setEnabled(task.id, false)).toEqual({ ok: true });
    expect(mocks.updateTask).toHaveBeenCalledWith(task.id, {
      enabled: false, disabledReason: 'manual',
    });
  });

  it('marks direct Dashboard runs with one UUID context and matching start time', async () => {
    let received: ScheduleExecutionContext | undefined;
    setExecuteCallback(async (_task, context) => { received = context; });

    expect(runNow(task.id)).toEqual({ ok: true });
    await vi.runAllTicks();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(received).toEqual({
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      trigger: 'dashboard',
      startedAt: '2026-08-31T00:01:00.000Z',
    });
    expect(mocks.claimRun).toHaveBeenCalledWith(task.id, expect.objectContaining({
      lastRunAt: received!.startedAt,
      lastRunId: received!.runId,
    }));
    const firedPayload = mocks.emitHook.mock.calls.find(([name]) => name === 'schedule.fired')?.[1];
    expect(firedPayload).not.toHaveProperty('chatIds');
  });

  it('marks a naturally due tick as scheduler-triggered', async () => {
    let received: ScheduleExecutionContext | undefined;
    mocks.listTasks.mockReturnValue([task]);
    setExecuteCallback(async (_task, context) => { received = context; });

    startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(received).toEqual({
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      trigger: 'scheduler',
      startedAt: '2026-08-31T00:01:05.000Z',
    });
    expect(mocks.claimRun).toHaveBeenCalledWith(task.id, {
      lastRunAt: received!.startedAt,
      nextRunAt: undefined,
      lastRunId: received!.runId,
    });
  });

  it('claims a one-shot before dispatch so a long model turn cannot fire twice', async () => {
    const liveTask = structuredClone(task);
    mocks.listTasks.mockImplementation(() => [structuredClone(liveTask)]);
    mocks.claimRun.mockImplementation((id: string, claim: Partial<ScheduledTask>) => {
      if (id !== liveTask.id || liveTask.lastStatus === 'running') {
        return { ok: false, error: 'already_running' };
      }
      Object.assign(liveTask, claim, { lastStatus: 'running' });
      return { ok: true, task: structuredClone(liveTask) };
    });
    const execute = vi.fn(() => new Promise<void>(() => {}));
    setExecuteCallback(execute);

    startScheduler();
    await vi.advanceTimersByTimeAsync(65_000);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(liveTask).toMatchObject({
      enabled: true,
      lastRunAt: '2026-08-31T00:01:05.000Z',
      lastStatus: 'running',
      lastRunId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(liveTask.nextRunAt).toBeUndefined();
  });

  it('rejects a second Dashboard run while the first callback is pending', async () => {
    const liveTask = structuredClone(task);
    mocks.getTask.mockImplementation(() => structuredClone(liveTask));
    mocks.claimRun.mockImplementation((_id: string, claim: Partial<ScheduledTask>) => {
      if (liveTask.lastStatus === 'running') {
        return { ok: false, error: 'already_running' };
      }
      Object.assign(liveTask, claim, { lastStatus: 'running' });
      return { ok: true, task: structuredClone(liveTask) };
    });
    const execute = vi.fn(() => new Promise<void>(() => {}));
    setExecuteCallback(execute);

    expect(runNow(task.id)).toEqual({ ok: true });
    expect(runNow(task.id)).toEqual({ ok: false, error: 'already_running' });
    await vi.runAllTicks();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not re-arm a task that is already running through the chat path', () => {
    mocks.requestRunNow.mockReturnValue({ ok: false, error: 'already_running' });

    expect(runTaskNow(task.id)).toBe(false);
    expect(mocks.requestRunNow).toHaveBeenCalledWith(task.id);
  });

  it('settles a persisted running run as interrupted before startup scheduling', () => {
    const interrupted: ScheduledTask = {
      ...task,
      lastRunAt: '2026-08-31T00:00:30.000Z',
      nextRunAt: undefined,
      lastStatus: 'running',
      lastRunId: '11111111-2222-4333-8444-555555555555',
    };
    mocks.listTasks.mockReturnValue([interrupted]);

    startScheduler();

    expect(mocks.markRun).toHaveBeenCalledWith(
      interrupted.id,
      false,
      'schedule run interrupted by daemon restart',
      undefined,
      interrupted.lastRunId,
    );
  });

  it('keeps chatId as the primary fired-hook target and adds chatIds only for fan-out', async () => {
    const multiChatTask: ScheduledTask = {
      ...task,
      chatId: 'oc_primary',
      chatIds: ['oc_primary', 'oc_secondary'],
    };
    mocks.getTask.mockReturnValue(multiChatTask);
    setExecuteCallback(async () => undefined);

    expect(runNow(multiChatTask.id)).toEqual({ ok: true });
    await vi.runAllTicks();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(mocks.emitHook).toHaveBeenCalledWith('schedule.fired', expect.objectContaining({
      id: multiChatTask.id,
      chatId: 'oc_primary',
      chatIds: ['oc_primary', 'oc_secondary'],
    }));
  });

  it('deletes both sidecars best-effort without changing task removal success', () => {
    mocks.removePrecondition.mockImplementation(() => { throw new Error('precondition cleanup failed'); });
    mocks.removeRunLogs.mockImplementation(() => { throw new Error('run log cleanup failed'); });

    expect(removeTask(task.id)).toBe(true);

    expect(mocks.removePrecondition).toHaveBeenCalledWith('cli_app', task.id);
    expect(mocks.removeRunLogs).toHaveBeenCalledWith(task.id, 'cli_app');
    expect(mocks.warn).toHaveBeenCalledTimes(2);
  });
});
