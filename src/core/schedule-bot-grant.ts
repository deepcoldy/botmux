/** Explicit host service authority. It never turns a bot into the current human. */
import type { ScheduleDelegationGlobalConfig, ScheduleBotGrant } from '../global-config.js';
import type { DispatchUserAuthority } from './dispatch-user-delegation.js';
import type { ScheduleAuthorityRecord } from '../services/schedule-authority-store.js';

export function matchingScheduleBotGrant(
  policy: ScheduleDelegationGlobalConfig | undefined,
  sourceAppId: string, targetAppIds: readonly string[], chatId: string,
): ScheduleBotGrant | undefined {
  if (!policy?.createEnabled || !targetAppIds.length) return;
  const matches = (policy.botGrants ?? []).filter(g => g.sourceAppId === sourceAppId
    && g.chatIds.includes(chatId) && targetAppIds.every(id => g.targetAppIds.includes(id)));
  return matches.length === 1 ? matches[0] : undefined;
}

export function botScheduleAuthority(input: {
  grant: ScheduleBotGrant; sourceOpenId: string; targetAppIds: string[]; chatId: string;
  selfManage: boolean;
}): DispatchUserAuthority {
  return {
    appId: input.grant.sourceAppId, openId: input.sourceOpenId,
    unionId: input.grant.controllerUnionId, tools: [],
    capabilities: input.targetAppIds.map(targetAppId => ({
      action: 'schedule:create', targetAppId, targetChatId: input.chatId,
      allowedExecutionPositions: ['top-level', 'topic'], allowedRunScopes: [],
      allowSelfManage: input.selfManage, botGrantId: input.grant.id,
    })),
  };
}

/** Grant provenance survives in the existing host-only authority record. */
export function assertScheduleBotGrantActive(
  record: ScheduleAuthorityRecord, policy: ScheduleDelegationGlobalConfig | undefined,
): void {
  if (!record.grantId?.startsWith('bot-policy:')) return;
  const [, sourceAppId, grantId] = record.grantId.split(':');
  const grant = matchingScheduleBotGrant(policy, sourceAppId, [record.task.larkAppId ?? ''], record.task.chatId);
  if (!grant || grant.id !== grantId || grant.controllerUnionId !== record.controlUnionId
    || record.runScopes.length) throw new Error('schedule bot grant is revoked or out of scope');
}
