import type { ScheduledTask } from '../types.js';
import type { ScheduleAuthorityRecord } from '../services/schedule-authority-store.js';

export interface DelegatedScheduleRuntimeDependencies {
  runEnabled: boolean;
  triggerUserAuthEnabled: boolean;
  adminOpenIds: readonly string[];
  resolveTargetOpenId: (unionId: string) => Promise<string | undefined>;
  listChatMemberOpenIds: (chatId: string) => Promise<readonly string[]>;
}

/** Re-authorize a delegated task at the last daemon-controlled boundary before
 * it can enter a worker queue. The returned task is deliberately anonymous:
 * control authority never becomes general-purpose user execution identity. */
export async function authorizeDelegatedScheduleRun(
  task: ScheduledTask,
  authority: ScheduleAuthorityRecord,
  deps: DelegatedScheduleRuntimeDependencies,
): Promise<ScheduledTask> {
  if (authority.kind !== 'delegated') return task;
  if (authority.state !== 'active') throw new Error(`schedule authority state is ${authority.state}`);
  if (!deps.runEnabled) throw new Error('delegated schedule execution is revoked by host policy');
  if (!deps.triggerUserAuthEnabled) {
    throw new Error('delegated schedule requires triggerUserAuth isolation when runScopes is empty');
  }
  if (!authority.controlOpenId || !authority.controlUnionId
    || !deps.adminOpenIds.includes(authority.controlOpenId)) {
    throw new Error('delegated schedule controller is no longer an allowed bot operator');
  }
  const currentOpenId = await deps.resolveTargetOpenId(authority.controlUnionId);
  if (currentOpenId !== authority.controlOpenId) {
    throw new Error('delegated schedule controller identity is no longer resolvable');
  }
  const members = await deps.listChatMemberOpenIds(task.chatId);
  if (!members.includes(authority.controlOpenId)) {
    throw new Error('delegated schedule controller is no longer a target chat member');
  }
  if (authority.runScopes.length !== 0) {
    throw new Error('delegated schedule run scopes are unsupported by this version');
  }
  return { ...task, ownerOpenId: undefined, ownerUnionId: undefined };
}
