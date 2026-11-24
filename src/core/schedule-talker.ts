/**
 * Schedules created by people who can only talk to the bot.
 *
 * By default only a bot administrator (dashboard admin / allowedUsers) may
 * create a scheduled task from a conversation turn. A bot may opt in to let a
 * `directHuman` caller who merely passes canTalk (p2pOpen, oncall group, a
 * per-user grant, …) create tasks for themselves. Such a task is marked
 * `ownerAccess: 'talk'` in the host authority record, and every later decision
 * about it — each fire, the identity its scheduled turn runs as, and who may
 * manage it — goes through this module instead of the administrator checks.
 *
 * The boundary is deliberately narrow: same bot, the chat the task was
 * created in, no persistent run scopes, no delegation, a per-person quota, and
 * the whole feature stops firing the moment the bot-level switch is turned off
 * or the person loses talk access / leaves the group.
 */
import type { ScheduledTask } from '../types.js';
import type { ScheduleAuthorityRecord } from '../services/schedule-authority-store.js';

/** Live (active or paused) talker tasks one person may hold on one bot. */
export const SCHEDULE_TALKER_DEFAULT_MAX_TASKS = 5;
/** Hard ceiling for the configurable per-person quota. */
export const SCHEDULE_TALKER_MAX_TASKS_CEILING = 100;

export interface TalkerSchedulePolicy {
  enabled: boolean;
  maxTasksPerUser: number;
}

/** Bot-level policy as read from bots.json (`scheduleCreateByTalkers`,
 *  `scheduleTalkerMaxTasks`). Default off; an invalid quota falls back to the
 *  built-in default rather than disabling the quota. */
export function talkerSchedulePolicy(
  config: { scheduleCreateByTalkers?: unknown; scheduleTalkerMaxTasks?: unknown } | undefined,
): TalkerSchedulePolicy {
  const raw = config?.scheduleTalkerMaxTasks;
  const maxTasksPerUser = typeof raw === 'number' && Number.isInteger(raw)
    && raw >= 1 && raw <= SCHEDULE_TALKER_MAX_TASKS_CEILING
    ? raw
    : SCHEDULE_TALKER_DEFAULT_MAX_TASKS;
  return { enabled: config?.scheduleCreateByTalkers === true, maxTasksPerUser };
}

/** The policy as it applies to one person in one chat. In personal-assistant
 *  mode the chat's current owner is admitted on the same narrow talker terms
 *  without the bot-level switch; nothing else changes. */
export function effectiveTalkerSchedulePolicy(
  policy: TalkerSchedulePolicy,
  isAssistantOwnerOfChat: boolean,
): TalkerSchedulePolicy {
  return policy.enabled || !isAssistantOwnerOfChat ? policy : { ...policy, enabled: true };
}

/** A task created under the talker policy. Read from the host authority
 *  record's task, never from the CLI-writable schedules.json projection. */
export function isTalkerScheduledTask(task: Pick<ScheduledTask, 'ownerAccess'> | undefined): boolean {
  return task?.ownerAccess === 'talk';
}

export type TalkerScheduleScopeError =
  | 'schedule_talker_scope_invalid'
  | 'schedule_talker_root_mismatch'
  | 'schedule_talker_root_forbidden';

/**
 * The shape a talker may create: delivered into the chat the turn came from,
 * at the top level or in the current topic only. Everything that would widen
 * the blast radius or needs an owner the host can hold accountable (local
 * delivery, following the active topic, dedicated/new topics, until-done with
 * owner notifications, multi-chat targets) is refused.
 */
export function talkerScheduleScopeError(
  task: {
    chatId: string;
    chatIds?: unknown;
    executionPosition: string;
    rootMessageId?: unknown;
    deliver?: unknown;
    followActive?: unknown;
    topicTitle?: unknown;
    untilDone?: unknown;
    notify?: unknown;
  },
  turn: { chatId: string; rootMessageId: string | undefined },
): TalkerScheduleScopeError | undefined {
  if (task.chatId !== turn.chatId
    || task.chatIds !== undefined
    || (task.executionPosition !== 'top-level' && task.executionPosition !== 'topic')
    || task.deliver === 'local'
    || task.followActive === true
    || task.topicTitle !== undefined
    || task.untilDone !== undefined
    || task.notify !== undefined) {
    return 'schedule_talker_scope_invalid';
  }
  if (task.executionPosition === 'topic' && (!turn.rootMessageId || task.rootMessageId !== turn.rootMessageId)) {
    return 'schedule_talker_root_mismatch';
  }
  if (task.executionPosition === 'top-level' && task.rootMessageId !== undefined) {
    return 'schedule_talker_root_forbidden';
  }
  return undefined;
}

/** Talker tasks a person still holds on this bot: active or paused rows.
 *  Completed one-shots and revoked rows no longer count, so finished tasks do
 *  not permanently exhaust the quota. */
export function countLiveTalkerTasks(
  records: readonly Pick<ScheduleAuthorityRecord, 'kind' | 'state' | 'task' | 'controlOpenId'>[],
  ownerOpenId: string,
): number {
  return records.filter(record => record.kind === 'direct'
    && isTalkerScheduledTask(record.task)
    && record.controlOpenId === ownerOpenId
    && (record.state === 'active' || record.state === 'paused')).length;
}

export interface TalkerScheduleRunDependencies {
  /** Read live on every admission check, including again after network waits. */
  policy: () => TalkerSchedulePolicy;
  /** evaluateTalk for this bot: may `openId` (union `unionId`) talk in `chatId`? */
  canTalk: (chatId: string, openId: string, unionId: string, chatType: 'group' | 'p2p') => boolean;
  resolveTargetOpenId: (unionId: string) => Promise<string | undefined>;
  listChatMemberOpenIds: (chatId: string) => Promise<readonly string[]>;
}

export interface AuthorizedTalkerScheduleRun {
  openId: string;
  unionId: string;
}

/** `'p2p'` for a private-chat task, `'group'` for every group shape. */
export function talkerScheduleChatType(task: Pick<ScheduledTask, 'chatType'>): 'group' | 'p2p' {
  return task.chatType === 'p2p' ? 'p2p' : 'group';
}

/**
 * Re-admit a talker task at a daemon-controlled boundary: before it enters a
 * worker queue, and again when its scheduled turn's identity is published.
 * Throws (fail-closed) when the bot-level switch is off, the recorded creator
 * no longer resolves to the same open_id, can no longer talk in the target
 * chat, or has left the group. No claim card is ever offered for these tasks:
 * the only identity they may run as is their creator's.
 */
export async function authorizeTalkerScheduleRun(
  task: ScheduledTask,
  authority: ScheduleAuthorityRecord,
  deps: TalkerScheduleRunDependencies,
  target: { chatId: string; chatType: 'group' | 'p2p' } = { chatId: task.chatId, chatType: talkerScheduleChatType(task) },
): Promise<AuthorizedTalkerScheduleRun> {
  if (authority.kind !== 'direct' || !isTalkerScheduledTask(authority.task)) {
    throw new Error('schedule authority is not a talker-created direct task');
  }
  if (!deps.policy().enabled) {
    throw new Error('talker schedule creation is disabled for this bot; refusing run');
  }
  const openId = authority.controlOpenId;
  const unionId = authority.controlUnionId;
  if (!openId || !unionId
    || authority.task.ownerOpenId !== openId || authority.task.ownerUnionId !== unionId
    || task.ownerOpenId !== openId || task.ownerUnionId !== unionId) {
    throw new Error('talker schedule creator identity is missing or inconsistent');
  }
  // A claim would swap the acting identity for someone else's; talker tasks
  // never post claim cards, so any claim on record is foreign state.
  if (authority.task.runAsClaim !== undefined || task.runAsClaim !== undefined) {
    throw new Error('talker schedule must run as its creator, not a claimant');
  }
  if (authority.runScopes.length > 0 || authority.selfManage) {
    throw new Error('talker schedule carries unexpected delegated authority');
  }
  if (await deps.resolveTargetOpenId(unionId) !== openId) {
    throw new Error('talker schedule creator identity is no longer resolvable');
  }
  if (!deps.canTalk(target.chatId, openId, unionId, target.chatType)) {
    throw new Error('talker schedule creator can no longer talk in the target chat');
  }
  if (target.chatType === 'group'
    && !(await deps.listChatMemberOpenIds(target.chatId)).includes(openId)) {
    throw new Error('talker schedule creator is no longer a target chat member');
  }
  // The policy is a live getter, not a snapshot captured before contact /
  // membership APIs. Re-admit after those waits so a switch or grant revoked
  // while they were pending cannot authorize this run with stale state.
  if (!deps.policy().enabled) {
    throw new Error('talker schedule creation is disabled for this bot; refusing run');
  }
  if (!deps.canTalk(target.chatId, openId, unionId, target.chatType)) {
    throw new Error('talker schedule creator can no longer talk in the target chat');
  }
  return { openId, unionId };
}
