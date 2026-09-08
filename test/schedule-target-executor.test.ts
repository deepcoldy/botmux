import { describe, expect, it, vi } from 'vitest';
import type { ScheduledTask } from '../src/types.js';
import { executeScheduledTaskWithPrecondition } from '../src/services/schedule-precondition-gate.js';
import {
  executeScheduledTaskForTargets,
  ScheduleTargetExecutionError,
} from '../src/services/schedule-target-executor.js';

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'schedule-multi-chat',
    name: 'Multi-chat task',
    schedule: '*/10 * * * *',
    parsed: { kind: 'cron', expr: '*/10 * * * *', display: '*/10 * * * *' },
    prompt: 'inspect latest post',
    workingDir: '/tmp/project',
    chatId: 'oc_one',
    ...overrides,
  };
}

describe('scheduled-task target executor', () => {
  it('shallow-copies the task for every target and removes multi-target routing', async () => {
    const source = task({ chatIds: ['oc_one', 'oc_two'] } as Partial<ScheduledTask>);
    const received: ScheduledTask[] = [];

    await expect(executeScheduledTaskForTargets(
      source,
      ['oc_one', 'oc_two'],
      async targetedTask => { received.push(targetedTask); },
    )).resolves.toEqual([
      { chatId: 'oc_one', outcome: 'model_dispatched' },
      { chatId: 'oc_two', outcome: 'model_dispatched' },
    ]);

    expect(received.map(item => item.chatId)).toEqual(['oc_one', 'oc_two']);
    expect(received.every(item => !Object.hasOwn(item, 'chatIds'))).toBe(true);
    expect(received.every(item => item !== source)).toBe(true);
    expect((source as ScheduledTask & { chatIds?: string[] }).chatIds).toEqual(['oc_one', 'oc_two']);
  });

  it('waits for every target and reports partial failures without cancelling peers', async () => {
    let finishSecond!: () => void;
    const second = new Promise<void>(resolve => { finishSecond = resolve; });
    const execute = vi.fn((targetedTask: ScheduledTask): Promise<void> => {
      if (targetedTask.chatId === 'oc_one') throw new Error('first failed');
      return second;
    });

    const execution = executeScheduledTaskForTargets(
      task(),
      ['oc_one', 'oc_two'],
      execute,
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    let settled = false;
    void execution.finally(() => { settled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(settled).toBe(false);

    finishSecond();
    await expect(execution).rejects.toMatchObject({
      name: 'ScheduleTargetExecutionError',
      targetResults: [
        { chatId: 'oc_one', outcome: 'error', error: 'first failed' },
        { chatId: 'oc_two', outcome: 'model_dispatched' },
      ],
    });
  });

  it('reports every error when all targets fail', async () => {
    try {
      await executeScheduledTaskForTargets(
        task(),
        ['oc_one', 'oc_two'],
        async targetedTask => { throw new Error(`${targetedTask.chatId} failed`); },
      );
      throw new Error('expected multi-target execution to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduleTargetExecutionError);
      expect((error as ScheduleTargetExecutionError).targetResults).toEqual([
        { chatId: 'oc_one', outcome: 'error', error: 'oc_one failed' },
        { chatId: 'oc_two', outcome: 'error', error: 'oc_two failed' },
      ]);
    }
  });

  it('rethrows a single-target failure unchanged for legacy error handling', async () => {
    const expected = new Error('legacy dispatch failure');
    const execution = executeScheduledTaskForTargets(
      task(),
      ['oc_one'],
      async () => { throw expected; },
    );

    await expect(execution).rejects.toBe(expected);
  });

  it('runs one Bash precondition before dispatching all target chats', async () => {
    const runPrecondition = vi.fn(async () => ({
      decision: 'pass' as const,
      additionalPrompt: 'post details',
    }));
    const execute = vi.fn(async (
      _targetedTask: ScheduledTask,
      _additionalPrompt?: string,
    ) => undefined);
    const source = task();

    await expect(executeScheduledTaskWithPrecondition(
      source,
      'cli_app',
      additionalPrompt => executeScheduledTaskForTargets(
        source,
        ['oc_one', 'oc_two'],
        targetedTask => execute(targetedTask, additionalPrompt),
      ).then(() => undefined),
      {
        resolve: () => ({
          enabled: true,
          source: { kind: 'inline', script: 'printf "1\\npost details"' },
        }),
        readFile: vi.fn(),
        run: runPrecondition,
      },
    )).resolves.toBe('executed');

    expect(runPrecondition).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map(([targetedTask, additionalPrompt]) => [
      targetedTask.chatId,
      additionalPrompt,
    ])).toEqual([
      ['oc_one', 'post details'],
      ['oc_two', 'post details'],
    ]);
  });
});
