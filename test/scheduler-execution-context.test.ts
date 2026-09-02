import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTask } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  listTasks: vi.fn<() => ScheduledTask[]>(),
  getTask: vi.fn<(id: string) => ScheduledTask | undefined>(),
  updateTask: vi.fn(),
  markRun: vi.fn(),
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
  markRun: mocks.markRun,
  removeTask: mocks.removeTask,
  createTask: mocks.createTask,
  getScheduleScope: mocks.getScheduleScope,
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
  removeTask,
  runNow,
  setExecuteCallback,
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
  mocks.removeTask.mockReturnValue(true);
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
});

describe('scheduler execution context', () => {
  it('marks direct Dashboard runs with one UUID context and matching start time', async () => {
    let received: ScheduleExecutionContext | undefined;
    setExecuteCallback(async (_task, context) => { received = context; });

    expect(runNow(task.id)).toEqual({ ok: true });
    await vi.runAllTicks();

    expect(received).toEqual({
      runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      trigger: 'dashboard',
      startedAt: '2026-08-31T00:01:00.000Z',
    });
    expect(mocks.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      lastRunAt: received!.startedAt,
    }));
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
    expect(mocks.updateTask).toHaveBeenCalledWith(task.id, {
      lastRunAt: received!.startedAt,
    });
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
