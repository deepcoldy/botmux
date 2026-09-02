import { randomUUID } from 'node:crypto';
import * as scheduler from './scheduler.js';
import * as scheduleStore from '../services/schedule-store.js';
import { logger } from '../utils/logger.js';
import {
  abortSchedulePrecondition,
  activateSchedulePrecondition,
  getSchedulePreconditionSummary,
  rebindSchedulePrecondition,
  removeSchedulePrecondition,
  resolveSchedulePrecondition,
  setSchedulePreconditionEnabled,
  stageSchedulePrecondition,
  validateSchedulePreconditionDefinition,
  validateSchedulePreconditionSource,
  type SchedulePreconditionDefinition,
  type SchedulePreconditionSource,
} from '../services/schedule-precondition-store.js';
import type { ScheduledTask } from '../types.js';

export type ScheduleCreateParams = Parameters<typeof scheduler.addTask>[0];
export type ScheduleUpdateParams = Parameters<typeof scheduler.updateTask>[1];
export type ScheduleDeliveryUpdateResult = ReturnType<typeof scheduler.toggleDelivery>;

export type SchedulePreconditionCreateInput = string | SchedulePreconditionDefinition | undefined;

export type SchedulePreconditionMutation =
  | { action: 'keep' }
  | { action: 'clear' }
  | { action: 'replace'; source: SchedulePreconditionSource; enabled?: boolean }
  | { action: 'set-enabled'; enabled: boolean };

export type SchedulePreconditionUpdateInput =
  | string
  | null
  | SchedulePreconditionMutation
  | undefined;

function allocateTaskId(appId: string): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = randomUUID().substring(0, 8);
    if (!scheduleStore.getTask(id, appId)) return id;
  }
  throw new Error('schedule_precondition_id_allocation_failed');
}

function logRollbackFailure(taskId: string, action: string, error: unknown): void {
  logger.error(
    `[schedule-precondition] ${action} failed for task ${taskId}: `
    + `${error instanceof Error ? error.message : String(error)}`,
  );
}

/** Create a task without changing the legacy path when no condition is supplied. */
export function createTaskWithOptionalPrecondition(
  params: ScheduleCreateParams,
  appId: string,
  precondition?: SchedulePreconditionCreateInput,
): ScheduledTask {
  if (precondition === undefined) return scheduler.addTask(params);
  const definition = typeof precondition === 'string'
    ? precondition
    : validateSchedulePreconditionDefinition(precondition);

  // A pending sidecar exists before the task row, so every observable partial
  // state fails closed. Fixed IDs let the sidecar and sandbox-writable row bind
  // to the same immutable key without storing executable material in the row.
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = allocateTaskId(appId);
    const staged = stageSchedulePrecondition(appId, id, definition);
    if (staged.previous.kind !== 'absent') {
      abortSchedulePrecondition(appId, id, staged.preconditionRef, staged.previous);
      continue;
    }

    try {
      const task = scheduler.addTask({
        ...params,
        id,
        preconditionRef: staged.preconditionRef,
      });
      if (task.preconditionRef !== staged.preconditionRef) {
        throw new Error('schedule_precondition_id_collision');
      }
      activateSchedulePrecondition(task, appId);
      return task;
    } catch (error) {
      // No half-configured task may survive a failed create. Cleanup is best
      // effort because either residue (pending sidecar or marker-only task)
      // fails closed; the original error remains the actionable one.
      try {
        const current = scheduleStore.getTask(id, appId);
        if (current?.preconditionRef === staged.preconditionRef) {
          scheduleStore.removeTask(id, appId);
        }
      } catch (cleanupError) {
        logRollbackFailure(id, 'task-row cleanup after create failure', cleanupError);
      }
      try {
        abortSchedulePrecondition(appId, id, staged.preconditionRef, staged.previous);
      } catch (cleanupError) {
        logRollbackFailure(id, 'protected-record rollback after create failure', cleanupError);
      }
      throw error;
    }
  }
  throw new Error('schedule_precondition_id_allocation_failed');
}

export interface SchedulePreconditionUpdateResult {
  ok: boolean;
  error?: string;
  task?: ScheduledTask;
  hasPrecondition?: boolean;
  preconditionEnabled?: boolean;
  preconditionSourceKind?: SchedulePreconditionSource['kind'];
}

type NormalizedMutation =
  | { action: 'keep' }
  | { action: 'clear' }
  | { action: 'replace'; definition: SchedulePreconditionDefinition }
  | { action: 'set-enabled'; enabled: boolean };

function normalizeMutation(
  input: SchedulePreconditionUpdateInput,
  existing: SchedulePreconditionDefinition | undefined,
): NormalizedMutation {
  if (input === undefined) return { action: 'keep' };
  if (input === null) return { action: 'clear' };
  if (typeof input === 'string') {
    return {
      action: 'replace',
      definition: {
        enabled: existing?.enabled ?? true,
        source: validateSchedulePreconditionSource({ kind: 'inline', script: input }),
      },
    };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('invalid_schedule_precondition_mutation');
  }
  if (input.action === 'keep') {
    if (Object.keys(input).length !== 1) throw new TypeError('invalid_schedule_precondition_keep');
    return input;
  }
  if (input.action === 'clear') {
    if (Object.keys(input).length !== 1) throw new TypeError('invalid_schedule_precondition_clear');
    return input;
  }
  if (input.action === 'set-enabled') {
    if (Object.keys(input).length !== 2 || typeof input.enabled !== 'boolean') {
      throw new TypeError('invalid_schedule_precondition_enabled');
    }
    if (!existing) throw new Error('schedule_precondition_not_configured');
    return { action: 'set-enabled', enabled: input.enabled };
  }
  if (input.action === 'replace') {
    const expectedKeys = input.enabled === undefined
      ? ['action', 'source']
      : ['action', 'enabled', 'source'];
    if (
      Object.keys(input).sort().join('\0') !== expectedKeys.sort().join('\0')
      || (input.enabled !== undefined && typeof input.enabled !== 'boolean')
    ) {
      throw new TypeError('invalid_schedule_precondition_replace');
    }
    return {
      action: 'replace',
      definition: {
        enabled: input.enabled ?? existing?.enabled ?? true,
        source: validateSchedulePreconditionSource(input.source),
      },
    };
  }
  throw new TypeError('invalid_schedule_precondition_action');
}

function restoreUpdatedTaskRow(
  before: ScheduledTask,
  updates: ScheduleUpdateParams,
  appId: string,
): void {
  const patch: Parameters<typeof scheduleStore.updateTask>[1] = {
    preconditionRef: before.preconditionRef,
  };
  if (updates.name !== undefined) patch.name = before.name;
  if (updates.prompt !== undefined) patch.prompt = before.prompt;
  if (updates.silent !== undefined) patch.silent = before.silent;
  if (updates.schedule !== undefined) {
    patch.schedule = before.schedule;
    patch.parsed = before.parsed;
    patch.nextRunAt = before.nextRunAt;
  }
  if (
    updates.deliver !== undefined
    || updates.executionPosition !== undefined
    || updates.rootMessageId !== undefined
    || updates.chatId !== undefined
    || updates.chatIds !== undefined
  ) {
    patch.deliver = before.deliver;
    patch.scope = before.scope;
    patch.executionPosition = before.executionPosition;
    patch.rootMessageId = before.rootMessageId;
  }
  if (updates.chatId !== undefined || updates.chatIds !== undefined) {
    patch.chatId = before.chatId;
    patch.chatIds = before.chatIds ?? null;
  }
  if (updates.topicTitle !== undefined) patch.topicTitle = before.topicTitle;
  scheduleStore.updateTask(before.id, patch, appId);
}

function resultForTask(task: ScheduledTask, appId: string): SchedulePreconditionUpdateResult {
  const summary = getSchedulePreconditionSummary(task, appId);
  return summary.hasPrecondition
    ? {
        ok: true,
        task,
        hasPrecondition: true,
        preconditionEnabled: summary.enabled,
        preconditionSourceKind: summary.sourceKind,
      }
    : { ok: true, task, hasPrecondition: false };
}

/** Update task fields and its protected condition as one fail-closed operation.
 * Legacy `undefined`/`null`/string inputs remain keep/clear/replace-inline. */
export function updateTaskWithOptionalPrecondition(
  id: string,
  updates: ScheduleUpdateParams,
  appId: string,
  precondition?: SchedulePreconditionUpdateInput,
): SchedulePreconditionUpdateResult {
  const before = scheduleStore.getTask(id, appId);
  if (!before) return { ok: false, error: 'not_found' };

  // Resolution validates ref/state/instance/hash even for disabled records.
  // A malformed old condition must never be silently replaced, cleared, or
  // blessed by an ordinary task edit.
  const resolvedBefore = resolveSchedulePrecondition(before, appId);
  const existing = resolvedBefore.kind === 'configured'
    ? { enabled: resolvedBefore.enabled, source: resolvedBefore.source }
    : undefined;
  const mutation = normalizeMutation(precondition, existing);

  // Replacement is staged before the task row changes. The pending record
  // blocks every partial state and also gives rollback a CAS token.
  const staged = mutation.action === 'replace'
    ? stageSchedulePrecondition(appId, id, mutation.definition)
    : undefined;

  // Do not expose a task-row event until the protected sidecar transition has
  // also committed. A later failure restores the row without Dashboard ever
  // observing a transient chat target or other editable value.
  const updated = scheduler.updateTask(id, updates, { deferEvent: true });
  if (!updated.ok) {
    if (staged) {
      try {
        abortSchedulePrecondition(appId, id, staged.preconditionRef, staged.previous);
      } catch (rollbackError) {
        logRollbackFailure(id, 'protected-record rollback after rejected update', rollbackError);
      }
    }
    return updated;
  }

  let task = scheduleStore.getTask(id, appId);
  if (!task) {
    if (staged) {
      try {
        abortSchedulePrecondition(appId, id, staged.preconditionRef, staged.previous);
      } catch (rollbackError) {
        logRollbackFailure(id, 'protected-record rollback after task disappearance', rollbackError);
      }
    }
    return { ok: false, error: 'not_found_after_update' };
  }

  try {
    if (mutation.action === 'keep') {
      if (existing) rebindSchedulePrecondition(task, appId);
    } else if (mutation.action === 'clear') {
      if (existing) {
        // Removing executable authority before the sandbox-writable marker
        // means the only observable intermediate is marker-without-sidecar,
        // which resolve treats as an error rather than an absent condition.
        removeSchedulePrecondition(appId, id);
        scheduleStore.updateTask(id, { preconditionRef: undefined }, appId);
      }
    } else if (mutation.action === 'set-enabled') {
      if (!existing) throw new Error('schedule_precondition_not_configured');
      rebindSchedulePrecondition(task, appId);
      task = scheduleStore.getTask(id, appId);
      if (!task) throw new Error('schedule_missing_during_precondition_update');
      setSchedulePreconditionEnabled(task, appId, mutation.enabled);
    } else {
      if (!staged) throw new Error('schedule_precondition_stage_missing');
      scheduleStore.updateTask(id, { preconditionRef: staged.preconditionRef }, appId);
      task = scheduleStore.getTask(id, appId);
      if (!task) throw new Error('schedule_missing_during_precondition_update');
      activateSchedulePrecondition(task, appId);
    }
  } catch (error) {
    // Restore only fields this operation could have changed; runtime status
    // may have advanced concurrently and must not be clobbered.
    try {
      restoreUpdatedTaskRow(before, updates, appId);
    } catch (rollbackError) {
      logRollbackFailure(id, 'task-row rollback after update failure', rollbackError);
    }
    if (staged) {
      try {
        abortSchedulePrecondition(appId, id, staged.preconditionRef, staged.previous);
      } catch (rollbackError) {
        logRollbackFailure(id, 'protected-record rollback after update failure', rollbackError);
      }
    }
    try {
      const restored = scheduleStore.getTask(id, appId);
      if (restored && existing) rebindSchedulePrecondition(restored, appId);
    } catch (rollbackError) {
      logRollbackFailure(id, 'protected-record rebind after update rollback', rollbackError);
    }
    throw error;
  }

  task = scheduleStore.getTask(id, appId);
  if (!task) return { ok: false, error: 'not_found_after_update' };
  const result = resultForTask(task, appId);
  scheduler.publishScheduleTaskUpdated(id, updated.deferredEventPatch ?? {});
  return result;
}

export function removeTaskWithPrecondition(
  id: string,
  appId: string,
): { ok: boolean; error?: string } {
  const task = scheduleStore.getTask(id, appId);
  if (!task) return { ok: false, error: 'not_found' };
  const result = scheduler.removeTaskForDashboard(id);
  if (!result.ok) return result;
  // scheduler.removeTaskForDashboard owns the central cleanup so CLI/card and
  // finite-repeat deletion paths receive the same protected-sidecar behavior.
  return { ok: true };
}

/** Keep a configured condition bound when a legacy delivery-toggle client
 * changes executionPosition outside the main PATCH form. */
export function toggleTaskDeliveryWithPrecondition(
  id: string,
  appId: string,
): ScheduleDeliveryUpdateResult {
  const before = scheduleStore.getTask(id, appId);
  if (!before) return { ok: false, error: 'not_found' };
  const configured = resolveSchedulePrecondition(before, appId).kind === 'configured';

  const result = scheduler.toggleDelivery(id);
  if (result.ok && configured) {
    const task = scheduleStore.getTask(id, appId);
    if (!task) return { ok: false, error: 'not_found_after_update' };
    rebindSchedulePrecondition(task, appId);
  }
  return result;
}
