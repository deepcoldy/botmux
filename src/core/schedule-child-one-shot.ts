import type { ScheduleDelegationGlobalConfig } from '../global-config.js';
import type { ScheduleAuthorityRecord } from '../services/schedule-authority-store.js';
import type { ParsedSchedule, ScheduleExecutionPosition } from '../types.js';

export type ScheduleChildOneShotError =
  | 'schedule_child_one_shot_disabled'
  | 'schedule_child_one_shot_parent_ineligible'
  | 'schedule_child_one_shot_descendant_denied'
  | 'schedule_child_one_shot_scope_invalid'
  | 'schedule_child_one_shot_requires_once'
  | 'schedule_child_one_shot_in_past'
  | 'schedule_child_one_shot_horizon_exceeded';

export interface ScheduleChildOneShotRequest {
  chatId: string;
  rootMessageId?: string;
  workingDir: string;
  larkAppId?: string;
  executionPosition?: ScheduleExecutionPosition;
  deliver?: 'origin' | 'local' | 'new-topic';
  followActive?: boolean;
  topicTitle?: string;
  calendar?: string | null;
  calendarDayType?: 'workday' | 'restday';
  untilDone?: unknown;
  notify?: unknown;
}

export interface ScheduleChildOneShotValidation {
  runAtMs: number;
  maxTasksPerTurn: number;
}

export type ScheduleChildOneShotDecision =
  | { ok: true; value: ScheduleChildOneShotValidation }
  | { ok: false; error: ScheduleChildOneShotError };

/**
 * Validate the complete non-identity scope of a scheduled child task.
 *
 * The caller still has to prove that `parent` belongs to the exact live
 * scheduled turn and revalidate its controller. Keeping those asynchronous
 * checks outside makes this helper deterministic and reusable at both sides of
 * the identity lookup (the daemon calls it again immediately before commit).
 */
export function validateScheduleChildOneShot(input: {
  policy: ScheduleDelegationGlobalConfig | undefined;
  parent: ScheduleAuthorityRecord | undefined;
  task: ScheduleChildOneShotRequest;
  parsed: ParsedSchedule;
  larkAppId: string;
  chatId: string;
  rootMessageId: string | undefined;
  workingDir: string;
  nowMs: number;
}): ScheduleChildOneShotDecision {
  const policy = input.policy;
  if (policy?.childOneShotEnabled !== true || policy.runEnabled === false) {
    return { ok: false, error: 'schedule_child_one_shot_disabled' };
  }
  const parent = input.parent;
  if (!parent) return { ok: false, error: 'schedule_child_one_shot_parent_ineligible' };
  if (parent.kind === 'delegated') {
    return { ok: false, error: 'schedule_child_one_shot_descendant_denied' };
  }
  if (!parent.controlOpenId || !parent.controlUnionId
    || parent.task.ownerOpenId !== parent.controlOpenId
    || parent.task.ownerUnionId !== parent.controlUnionId) {
    return { ok: false, error: 'schedule_child_one_shot_parent_ineligible' };
  }

  const task = input.task;
  if (!input.rootMessageId
    || task.larkAppId !== input.larkAppId
    || task.chatId !== input.chatId
    || task.rootMessageId !== input.rootMessageId
    || task.workingDir !== input.workingDir
    || task.executionPosition !== 'topic'
    || (task.deliver !== undefined && task.deliver !== 'origin')
    || task.followActive === true
    || task.topicTitle !== undefined
    || task.calendar !== undefined
    || task.calendarDayType !== undefined
    || task.untilDone !== undefined
    || task.notify !== undefined) {
    return { ok: false, error: 'schedule_child_one_shot_scope_invalid' };
  }
  if (input.parsed.kind !== 'once' || typeof input.parsed.runAt !== 'string') {
    return { ok: false, error: 'schedule_child_one_shot_requires_once' };
  }
  const runAtMs = Date.parse(input.parsed.runAt);
  if (!Number.isFinite(runAtMs) || runAtMs <= input.nowMs) {
    return { ok: false, error: 'schedule_child_one_shot_in_past' };
  }
  const maxDelayMinutes = policy.childOneShotMaxDelayMinutes;
  if (typeof maxDelayMinutes !== 'number'
    || runAtMs - input.nowMs > maxDelayMinutes * 60_000) {
    return { ok: false, error: 'schedule_child_one_shot_horizon_exceeded' };
  }
  const maxTasksPerTurn = policy.childOneShotMaxTasksPerTurn;
  if (typeof maxTasksPerTurn !== 'number') {
    return { ok: false, error: 'schedule_child_one_shot_parent_ineligible' };
  }
  return { ok: true, value: { runAtMs, maxTasksPerTurn } };
}
