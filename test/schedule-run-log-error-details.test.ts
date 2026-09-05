import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { __testOnly_resolveScheduleRunLogErrorDetails as resolveErrorDetails } from '../src/daemon.js';
import { SchedulePreconditionError } from '../src/services/schedule-precondition-runner.js';
import { appendScheduleRunLog, queryScheduleRunLogs } from '../src/services/schedule-run-log-store.js';
import { executeScheduledTaskForTargets } from '../src/services/schedule-target-executor.js';
import type { ScheduledTask } from '../src/types.js';

describe('scheduled-task run-log error details', () => {
  it('persists the precondition runner code and complete exit-code message', () => {
    const error = new SchedulePreconditionError(
      'non_zero_exit',
      'Scheduled task precondition failed with exit code 35',
    );

    expect(resolveErrorDetails('error', error)).toEqual({
      errorCode: 'non_zero_exit',
      error: 'Scheduled task precondition failed with exit code 35',
    });
  });

  it('keeps a diagnostic message for other precondition errors', () => {
    expect(resolveErrorDetails('error', new Error('Could not read Bash file'))).toEqual({
      errorCode: 'precondition_error',
      error: 'Could not read Bash file',
    });
  });

  it.each(['passed', 'none', 'disabled'] as const)(
    'persists the model-dispatch message when the precondition status is %s', precondition => {
      expect(resolveErrorDetails(precondition, new Error('model failed'))).toEqual({
        errorCode: 'model_dispatch_error',
        error: 'model failed',
      });
    },
  );

  it.each([
    ['string', 'dispatch rejected', 'dispatch rejected'],
    ['number', 503, '503'],
    ['null', null, 'null'],
  ])('stringifies a non-Error %s thrown during model dispatch', (_type, thrown, message) => {
    expect(resolveErrorDetails('none', thrown)).toEqual({
      errorCode: 'model_dispatch_error',
      error: message,
    });
  });

  it('reads back a single-target dispatch failure message from isolated run-log storage', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'botmux-single-target-error-log-'));
    const dataDir = join(scratch, 'data');
    const appId = 'cli_error_details_test';
    const startedAt = '2026-09-03T00:00:00.000Z';
    const task: ScheduledTask = {
      id: 'single-target-error-log-test',
      name: 'Single target error log test',
      schedule: '*/10 * * * *',
      parsed: { kind: 'cron', expr: '*/10 * * * *', display: '*/10 * * * *' },
      prompt: 'Test-only dispatch',
      workingDir: scratch,
      chatId: 'oc_error_details_test',
      enabled: true,
      createdAt: startedAt,
    };
    const failure = new Error('Single target model failed: provider unavailable');
    const execute = vi.fn(async () => { throw failure; });

    try {
      let caught: unknown;
      try {
        await executeScheduledTaskForTargets(task, [task.chatId], execute);
      } catch (error) {
        caught = error;
      }
      expect(execute).toHaveBeenCalledTimes(1);
      expect(caught).toBe(failure);

      appendScheduleRunLog({
        id: 'single-target-error-run',
        taskId: task.id,
        trigger: 'scheduler',
        startedAt,
        finishedAt: '2026-09-03T00:00:01.000Z',
        durationMs: 1000,
        outcome: 'error',
        precondition: 'none',
        additionalPrompt: false,
        ...resolveErrorDetails('none', caught),
      }, appId, dataDir);

      expect(queryScheduleRunLogs(task.id, {}, appId, dataDir)).toMatchObject({
        total: 1,
        logs: [{
          id: 'single-target-error-run',
          taskId: task.id,
          outcome: 'error',
          precondition: 'none',
          errorCode: 'model_dispatch_error',
          error: failure.message,
        }],
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
