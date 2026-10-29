/**
 * 定时任务连续失败告警的接线回归（维护者复审 P2-2）：阈值 crossed 信号在两条
 * 「非正常 catch」路径上也曾被丢弃——daemon 重启把在途任务对账为失败、以及
 * execute callback 未初始化——水印已经落库而私信永不发出，此后任务持续真失败
 * 也不再 crossed，整串失败 owner 零告警。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTask } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  listTasks: vi.fn<() => ScheduledTask[]>(),
  getTask: vi.fn<(id: string) => ScheduledTask | undefined>(),
  updateTask: vi.fn(),
  claimRun: vi.fn(),
  markRun: vi.fn(),
  markSkipped: vi.fn(),
  removeTask: vi.fn(),
  createTask: vi.fn(),
  getScheduleScope: vi.fn(() => 'cli_app'),
  removePrecondition: vi.fn(),
  removeRunLogs: vi.fn(),
  publish: vi.fn(),
  emitHook: vi.fn(),
}));

vi.mock('../src/services/schedule-store.js', () => ({
  listTasks: mocks.listTasks,
  getTask: mocks.getTask,
  updateTask: mocks.updateTask,
  claimRun: mocks.claimRun,
  markRun: mocks.markRun,
  markSkipped: mocks.markSkipped,
  removeTask: mocks.removeTask,
  createTask: mocks.createTask,
  getScheduleScope: mocks.getScheduleScope,
  SCHEDULE_FAILURE_ALERT_THRESHOLD: 3,
  effectiveScheduleChatIds: (scheduled: ScheduledTask) => scheduled.chatIds ?? [scheduled.chatId],
}));
vi.mock('../src/services/schedule-precondition-store.js', () => ({ removeSchedulePrecondition: mocks.removePrecondition }));
vi.mock('../src/services/schedule-run-log-store.js', () => ({ removeScheduleRunLogs: mocks.removeRunLogs }));
vi.mock('../src/services/hook-runner.js', () => ({ emitHookEvent: mocks.emitHook }));
vi.mock('../src/core/dashboard-events.js', () => ({ dashboardEventBus: { publish: mocks.publish } }));
vi.mock('../src/utils/timezone.js', () => ({ scheduleTimeZone: () => 'UTC', zonedTomorrowAt: vi.fn() }));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

async function freshScheduler() {
  vi.resetModules();
  return import('../src/core/scheduler.js');
}

const task: ScheduledTask = {
  id: 'wf_alert',
  name: 'alert task',
  schedule: '2026-08-31T00:00:00.000Z',
  parsed: { kind: 'once', runAt: '2026-08-31T00:00:00.000Z', display: 'once' },
  prompt: 'do something',
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
  mocks.getTask.mockImplementation((id: string) => (id === task.id ? task : undefined));
  mocks.claimRun.mockImplementation((id: string, claim?: Record<string, unknown>) => {
    const current = mocks.getTask(id);
    return current
      ? { ok: true, task: { ...current, ...claim, lastStatus: 'running' } }
      : { ok: false, error: 'not_found' };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('failure alert delivery on previously-silent paths', () => {
  it('alerts when the daemon-restart reconciliation crosses the threshold', async () => {
    const interrupted: ScheduledTask = {
      ...task,
      lastStatus: 'running',
      lastRunId: '11111111-2222-4333-8444-555555555555',
      lastError: 'previous boom',
    };
    mocks.listTasks.mockReturnValue([interrupted]);
    mocks.getTask.mockReturnValue(interrupted);
    mocks.markRun.mockReturnValue({ crossedFailureThreshold: true, consecutiveFailures: 3 });

    const scheduler = await freshScheduler();
    const alert = vi.fn();
    scheduler.setScheduleFailureAlert(alert);
    scheduler.startScheduler();
    scheduler.stopScheduler();

    expect(mocks.markRun).toHaveBeenCalledWith(
      task.id, false, 'schedule run interrupted by daemon restart', undefined, interrupted.lastRunId,
    );
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), 3, 'previous boom');
  });

  it('does not alert when the reconciliation did not cross the threshold', async () => {
    mocks.listTasks.mockReturnValue([{ ...task, lastStatus: 'running', lastRunId: 'r1' }]);
    mocks.markRun.mockReturnValue({ crossedFailureThreshold: false, consecutiveFailures: 1 });

    const scheduler = await freshScheduler();
    const alert = vi.fn();
    scheduler.setScheduleFailureAlert(alert);
    scheduler.startScheduler();
    scheduler.stopScheduler();

    expect(alert).not.toHaveBeenCalled();
  });

  it('alerts from the execute-callback-missing branch of tick', async () => {
    mocks.listTasks.mockReturnValue([task]);
    mocks.getTask.mockReturnValue({ ...task, lastError: 'scheduler execute callback is not initialised' });
    mocks.markRun.mockReturnValue({ crossedFailureThreshold: true, consecutiveFailures: 3 });

    const scheduler = await freshScheduler();
    const alert = vi.fn();
    scheduler.setScheduleFailureAlert(alert);
    // 故意不 setExecuteCallback：走 tick 的 callback-missing 分支。
    scheduler.startScheduler();
    await vi.advanceTimersByTimeAsync(5_000);
    scheduler.stopScheduler();

    expect(mocks.markRun).toHaveBeenCalledWith(
      task.id, false, 'scheduler execute callback is not initialised', undefined, expect.any(String),
    );
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }),
      3,
      'scheduler execute callback is not initialised',
    );
  });
});
