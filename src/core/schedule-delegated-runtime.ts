import type { ScheduledTask } from '../types.js';
import type { ScheduleAuthorityRecord } from '../services/schedule-authority-store.js';
import { TRIGGER_USER_AUTH_TOOLS, type TriggerUserAuthTool } from '../services/trigger-user-auth.js';

export interface DelegatedScheduleRuntimeDependencies {
  runEnabled: boolean;
  validateBotGrant?: (record: ScheduleAuthorityRecord) => void;
  hostRunScopes: readonly TriggerUserAuthTool[];
  triggerUserAuthTools: readonly TriggerUserAuthTool[];
  adminOpenIds: readonly string[];
  resolveTargetOpenId: (unionId: string) => Promise<string | undefined>;
  listChatMemberOpenIds: (chatId: string) => Promise<readonly string[]>;
}

export interface AuthorizedDelegatedScheduleRun {
  task: ScheduledTask;
  targetOpenId: string;
}

async function revalidateController(
  task: ScheduledTask,
  authority: ScheduleAuthorityRecord,
  deps: Pick<DelegatedScheduleRuntimeDependencies,
    'adminOpenIds' | 'resolveTargetOpenId' | 'listChatMemberOpenIds'>,
  targetChatId: string = task.chatId,
): Promise<string> {
  if (!authority.controlOpenId || !authority.controlUnionId
    || !deps.adminOpenIds.includes(authority.controlOpenId)) {
    throw new Error('schedule controller is no longer an allowed bot operator');
  }
  const currentOpenId = await deps.resolveTargetOpenId(authority.controlUnionId);
  if (currentOpenId !== authority.controlOpenId) {
    throw new Error('schedule controller identity is no longer resolvable');
  }
  const members = await deps.listChatMemberOpenIds(targetChatId);
  if (!members.includes(authority.controlOpenId)) {
    throw new Error('schedule controller is no longer a target chat member');
  }
  return currentOpenId;
}

/** Re-authorize a delegated task at the last daemon-controlled boundary before
 * it can enter a worker queue. The returned task is deliberately anonymous as
 * a current actor; any allowed tool identity is published separately and only
 * for the exact scheduled turn. */
export async function authorizeDelegatedScheduleRun(
  task: ScheduledTask,
  authority: ScheduleAuthorityRecord,
  deps: DelegatedScheduleRuntimeDependencies,
): Promise<AuthorizedDelegatedScheduleRun> {
  if (authority.grantId?.startsWith('bot-policy:')) {
    if (!deps.validateBotGrant) throw new Error('schedule bot grant validator unavailable');
    deps.validateBotGrant(authority);
  }
  if (authority.kind !== 'delegated') throw new Error('schedule authority is not delegated');
  if (authority.state !== 'active') throw new Error(`schedule authority state is ${authority.state}`);
  if (!deps.runEnabled) throw new Error('delegated schedule execution is revoked by host policy');
  if (!TRIGGER_USER_AUTH_TOOLS.every(tool => deps.triggerUserAuthTools.includes(tool))) {
    throw new Error('delegated schedule requires triggerUserAuth isolation for every identity tool');
  }
  if (authority.runScopes.some(scope => !deps.hostRunScopes.includes(scope)
    || !deps.triggerUserAuthTools.includes(scope))) {
    throw new Error('delegated schedule run scope is no longer allowed by host policy');
  }
  if (authority.runScopes.length > 0 && !authority.credentialOpenId) {
    throw new Error('delegated schedule credential identity is missing');
  }
  const targetOpenId = await revalidateController(task, authority, deps);
  return { task: { ...task, ownerOpenId: undefined, ownerUnionId: undefined }, targetOpenId };
}

export async function authorizeScheduleSelfManage(
  authority: ScheduleAuthorityRecord,
  deps: Pick<DelegatedScheduleRuntimeDependencies,
    'adminOpenIds' | 'resolveTargetOpenId' | 'listChatMemberOpenIds'> & {
      selfManageEnabled: boolean;
      allowPaused?: boolean;
      validateBotGrant?: (record: ScheduleAuthorityRecord) => void;
      targetChatId: string;
    },
): Promise<void> {
  if (authority.grantId?.startsWith('bot-policy:')) {
    if (!deps.validateBotGrant) throw new Error('schedule bot grant validator unavailable');
    deps.validateBotGrant(authority);
  }
  const completedRunStillLive = authority.state === 'completed'
    && authority.task.enabled === false
    && authority.task.disabledReason === 'once_completed';
  if (authority.state !== 'active' && !completedRunStillLive
    && !(deps.allowPaused && authority.state === 'paused' && authority.grantId?.startsWith('bot-policy:'))) {
    throw new Error(`schedule authority state is ${authority.state}`);
  }
  if (authority.kind === 'direct') {
    await revalidateController(authority.task, authority, deps, deps.targetChatId);
    return;
  }
  if (authority.kind !== 'delegated'
    || !authority.selfManage || !deps.selfManageEnabled) {
    throw new Error('schedule self-management is not allowed');
  }
  await revalidateController(authority.task, authority, deps, deps.targetChatId);
}
