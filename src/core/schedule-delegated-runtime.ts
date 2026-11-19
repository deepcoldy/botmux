import type { ScheduledTask } from '../types.js';
import type { ScheduleAuthorityRecord } from '../services/schedule-authority-store.js';
import { isManualScheduleRun, isManualScheduledTurn } from './scheduled-turn-provenance.js';
import { capabilityOn, type TriggerUserAuthConfig, type TriggerUserAuthTool } from '../services/trigger-user-auth.js';
import { capabilityOfTool } from './identity-policy.js';
import { isAutoCompletedSchedule } from '../services/schedule-until-done.js';

export interface DelegatedScheduleRuntimeDependencies {
  manualRunId?: string;
  manualTurnId?: string;
  /** Re-preparing an already admitted turn (identity-model replay, recovery
   * continuation): a dispatched one-shot is completed before its turn ends. */
  allowCompletedOnce?: boolean;
  assertAuthorityCurrent?: () => void;
  runEnabled: boolean;
  validateBotGrant?: (record: ScheduleAuthorityRecord) => void;
  hostRunScopes: readonly TriggerUserAuthTool[];
  triggerUserAuth: Pick<TriggerUserAuthConfig, 'enabled' | 'tools' | 'capabilities'> | undefined;
  adminOpenIds: readonly string[];
  resolveTargetOpenId: (unionId: string) => Promise<string | undefined>;
  listChatMemberOpenIds: (chatId: string) => Promise<readonly string[]>;
}

export interface AuthorizedDelegatedScheduleRun {
  task: ScheduledTask;
  targetOpenId: string;
  usesControllerToolActor: boolean;
}

/** A same-topic one-shot child keeps delegated lifecycle limits (no descendants
 * or self-management), but may publish the direct parent's controller as an
 * exact-turn tool actor. The task itself stays ownerless, so workflow and
 * schedule mutation authority remain unavailable. Generic cross-bot delegated
 * tasks remain anonymous. All fields come from the host authority store; no
 * request body can nominate this identity. */
export function delegatedScheduleUsesControllerToolActor(
  task: ScheduledTask,
  authority: ScheduleAuthorityRecord,
): boolean {
  return authority.kind === 'delegated'
    && authority.grantId?.startsWith('schedule-child:') === true
    && !!authority.controlOpenId
    && !!authority.controlUnionId
    && authority.credentialOpenId === authority.controlOpenId
    && authority.runScopes.length === 0
    && authority.selfManage === false
    && task.ownerOpenId === undefined
    && task.ownerUnionId === undefined;
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
/** A bot-policy task is checked against the current host grant before and
 * again after the identity lookups, so revoking the grant while they are in
 * flight still refuses this admission. */
function assertBotGrantStillActive(
  authority: ScheduleAuthorityRecord,
  validateBotGrant: ((record: ScheduleAuthorityRecord) => void) | undefined,
): void {
  if (!authority.grantId?.startsWith('bot-policy:')) return;
  if (!validateBotGrant) throw new Error('schedule bot grant validator unavailable');
  validateBotGrant(authority);
}

export async function authorizeDelegatedScheduleRun(
  task: ScheduledTask,
  authority: ScheduleAuthorityRecord,
  deps: DelegatedScheduleRuntimeDependencies,
): Promise<AuthorizedDelegatedScheduleRun> {
  deps.assertAuthorityCurrent?.();
  assertBotGrantStillActive(authority, deps.validateBotGrant);
  if (authority.kind !== 'delegated') throw new Error('schedule authority is not delegated');
  const manual = authority.state === 'paused' && (deps.manualTurnId
    ? isManualScheduledTurn(authority.task, deps.manualTurnId)
    : isManualScheduleRun(authority.task, deps.manualRunId));
  const completedOnce = deps.allowCompletedOnce === true
    && authority.state === 'completed' && isAutoCompletedSchedule(authority.task);
  if (authority.state !== 'active' && !manual && !completedOnce) {
    throw new Error(`schedule authority state is ${authority.state}`);
  }
  if (!deps.runEnabled) throw new Error('delegated schedule execution is revoked by host policy');
  if (!capabilityOn(deps.triggerUserAuth, 'lark-user') || !capabilityOn(deps.triggerUserAuth, 'bytecloud')) {
    throw new Error('delegated schedule requires triggerUserAuth isolation for lark-user and bytecloud');
  }
  if (authority.runScopes.some(scope => !deps.hostRunScopes.includes(scope)
    || !capabilityOn(deps.triggerUserAuth, capabilityOfTool(scope)))) {
    throw new Error('delegated schedule run scope is no longer allowed by host policy');
  }
  if (authority.runScopes.length > 0 && !authority.credentialOpenId) {
    throw new Error('delegated schedule credential identity is missing');
  }
  const targetOpenId = await revalidateController(task, authority, deps);
  deps.assertAuthorityCurrent?.();
  assertBotGrantStillActive(authority, deps.validateBotGrant);
  const usesControllerToolActor = delegatedScheduleUsesControllerToolActor(task, authority);
  return {
    task: usesControllerToolActor ? task : { ...task, ownerOpenId: undefined, ownerUnionId: undefined },
    targetOpenId,
    usesControllerToolActor,
  };
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
  assertBotGrantStillActive(authority, deps.validateBotGrant);
  const completedRunStillLive = authority.state === 'completed'
    && authority.task.enabled === false
    && authority.task.disabledReason === 'once_completed';
  if (authority.state !== 'active' && !completedRunStillLive
    && !(deps.allowPaused && authority.state === 'paused' && authority.grantId?.startsWith('bot-policy:'))) {
    throw new Error(`schedule authority state is ${authority.state}`);
  }
  if (authority.kind === 'direct') {
    // A task added from the host terminal carries no controller at all: its
    // creator is the host administrator, so there is no person whose access
    // could have lapsed. It may still only stop itself (the route limits the
    // action and the exact task). A task with any controller field recorded,
    // even an empty one, keeps the live re-check and fails closed inside it.
    if (authority.controlOpenId === undefined && authority.controlUnionId === undefined) return;
    await revalidateController(authority.task, authority, deps, deps.targetChatId);
    return;
  }
  if (authority.kind !== 'delegated'
    || !authority.selfManage || !deps.selfManageEnabled) {
    throw new Error('schedule self-management is not allowed');
  }
  await revalidateController(authority.task, authority, deps, deps.targetChatId);
  assertBotGrantStillActive(authority, deps.validateBotGrant);
}
