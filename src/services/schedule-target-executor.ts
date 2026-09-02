import type { ScheduledTask } from '../types.js';
import type { ScheduleRunTargetResult } from './schedule-run-log-store.js';

export type ScheduledTaskTargetExecutor = (task: ScheduledTask) => Promise<void>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function taskForTarget(task: ScheduledTask, chatId: string): ScheduledTask {
  const singleTargetTask = { ...task };
  delete singleTargetTask.chatIds;
  return { ...singleTargetTask, chatId };
}

/**
 * Executes every target independently and waits for all targets to settle.
 * A single-target rejection is rethrown unchanged to preserve the legacy
 * scheduler error path. Multi-target failures carry every per-chat result.
 */
export class ScheduleTargetExecutionError extends Error {
  readonly targetResults: ScheduleRunTargetResult[];

  constructor(targetResults: ScheduleRunTargetResult[]) {
    const failures = targetResults.filter(result => result.outcome === 'error');
    super(
      `Scheduled task failed for ${failures.length}/${targetResults.length} target chats: `
      + failures.map(result => result.chatId).join(', '),
    );
    this.name = 'ScheduleTargetExecutionError';
    this.targetResults = targetResults;
  }
}

export async function executeScheduledTaskForTargets(
  task: ScheduledTask,
  targetChatIds: readonly string[],
  execute: ScheduledTaskTargetExecutor,
): Promise<ScheduleRunTargetResult[]> {
  if (targetChatIds.length === 0) {
    throw new Error('Scheduled task has no target chats');
  }

  const settled = await Promise.allSettled(
    targetChatIds.map(chatId => Promise.resolve().then(
      () => execute(taskForTarget(task, chatId)),
    )),
  );
  const targetResults = settled.map<ScheduleRunTargetResult>((result, index) => (
    result.status === 'fulfilled'
      ? { chatId: targetChatIds[index]!, outcome: 'model_dispatched' }
      : { chatId: targetChatIds[index]!, outcome: 'error', error: errorMessage(result.reason) }
  ));
  const failed = settled.find(result => result.status === 'rejected');
  if (!failed) return targetResults;

  if (targetChatIds.length === 1 && failed.status === 'rejected') {
    throw failed.reason;
  }
  throw new ScheduleTargetExecutionError(targetResults);
}
