import { resolve } from 'node:path';
import type { ScheduledTask } from '../types.js';
import { expandHomePath } from '../utils/working-dir.js';
import { logger } from '../utils/logger.js';
import { readSchedulePreconditionFile } from './schedule-precondition-file.js';
import { resolveSchedulePrecondition } from './schedule-precondition-store.js';
import { runSchedulePrecondition } from './schedule-precondition-runner.js';

export type ScheduledTaskPreconditionOutcome = 'executed' | 'skipped';

export type ScheduledTaskPreconditionStatus =
  | 'none'
  | 'disabled'
  | 'passed'
  | 'skipped'
  | 'error';

export interface ScheduledTaskPreconditionObservation {
  precondition: ScheduledTaskPreconditionStatus;
  additionalPrompt: boolean;
}

export type ScheduledTaskPreconditionObserver = (
  observation: ScheduledTaskPreconditionObservation,
) => void;

interface SchedulePreconditionGateDependencies {
  resolve: typeof resolveSchedulePrecondition;
  readFile: typeof readSchedulePreconditionFile;
  run: typeof runSchedulePrecondition;
}

const defaultDependencies: SchedulePreconditionGateDependencies = {
  resolve: resolveSchedulePrecondition,
  readFile: readSchedulePreconditionFile,
  run: runSchedulePrecondition,
};

function resolvePreconditionWorkingDir(workingDir: string): string {
  // Keep malformed empty directories on the existing fail-closed path instead
  // of turning them into the daemon cwd via path.resolve(''). Normal schedule
  // directories use the same home expansion as ordinary model sessions, then
  // become absolute once so file lookup and Bash execution cannot disagree.
  return workingDir.trim().length === 0
    ? workingDir
    : resolve(expandHomePath(workingDir));
}

function observePreconditionSafely(
  task: ScheduledTask,
  observer: ScheduledTaskPreconditionObserver | undefined,
  observation: ScheduledTaskPreconditionObservation,
): void {
  if (!observer) return;
  try {
    observer(observation);
  } catch (error) {
    logger.warn(
      `[scheduler] Precondition observer failed for task ${task.id}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Execute a scheduled turn only after its daemon-owned Bash precondition passes.
 *
 * Resolution, live file reads, and Bash execution all happen before `execute`
 * is entered. A normal false result resolves as `skipped`; sidecar corruption,
 * unsafe file state, and operational Bash failures reject so the scheduler
 * records an error. Legacy tasks with no definition and explicitly-disabled
 * definitions call `execute` directly.
 */
export async function executeScheduledTaskWithPrecondition(
  task: ScheduledTask,
  effectiveAppId: string,
  execute: (additionalPrompt?: string) => Promise<void>,
  dependencies: SchedulePreconditionGateDependencies = defaultDependencies,
  observer?: ScheduledTaskPreconditionObserver,
): Promise<ScheduledTaskPreconditionOutcome> {
  let condition: ReturnType<typeof resolveSchedulePrecondition>;
  try {
    condition = dependencies.resolve(task, effectiveAppId);
  } catch (error) {
    observePreconditionSafely(task, observer, {
      precondition: 'error',
      additionalPrompt: false,
    });
    throw error;
  }

  if (condition.kind === 'none') {
    observePreconditionSafely(task, observer, {
      precondition: 'none',
      additionalPrompt: false,
    });
    await execute();
    return 'executed';
  }
  if (!condition.enabled) {
    observePreconditionSafely(task, observer, {
      precondition: 'disabled',
      additionalPrompt: false,
    });
    await execute();
    return 'executed';
  }

  const workingDir = resolvePreconditionWorkingDir(task.workingDir);
  let result: Awaited<ReturnType<typeof runSchedulePrecondition>>;
  try {
    const script = condition.source.kind === 'inline'
      ? condition.source.script
      : dependencies.readFile(condition.source.path, workingDir);
    result = await dependencies.run(script, workingDir);
  } catch (error) {
    observePreconditionSafely(task, observer, {
      precondition: 'error',
      additionalPrompt: false,
    });
    throw error;
  }
  if (result.decision === 'skip') {
    observePreconditionSafely(task, observer, {
      precondition: 'skipped',
      additionalPrompt: false,
    });
    logger.info(
      `[scheduler] Task "${task.name}" (${task.id}) skipped: Bash precondition did not return 1`,
    );
    return 'skipped';
  }

  observePreconditionSafely(task, observer, {
    precondition: 'passed',
    additionalPrompt: result.additionalPrompt !== undefined,
  });
  if (result.additionalPrompt === undefined) {
    await execute();
  } else {
    await execute(result.additionalPrompt);
  }
  return 'executed';
}
