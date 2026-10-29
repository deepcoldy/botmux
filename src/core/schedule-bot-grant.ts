/** Explicit host service authority. It never turns a bot into the current human. */
import type { ScheduleDelegationGlobalConfig, ScheduleBotGrant } from '../global-config.js';
import type { DispatchUserAuthority } from './dispatch-user-delegation.js';
import type { ScheduleAuthorityRecord } from '../services/schedule-authority-store.js';

/** Per-field rules of one bot grant, exported so the Dashboard editor can say
 *  which field is wrong without restating them. */
export const scheduleBotGrantFieldValid = {
  id: (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value),
  appId: (value: unknown): value is string => typeof value === 'string' && /^cli_[A-Za-z0-9_-]{1,128}$/.test(value),
  chatId: (value: unknown): value is string => typeof value === 'string' && /^oc_[A-Za-z0-9_-]{1,128}$/.test(value),
  unionId: (value: unknown): value is string => typeof value === 'string' && /^on_[A-Za-z0-9_-]{1,128}$/.test(value),
};

/** Shape of one bot grant. The config reader, the Dashboard write route and
 *  its editor all use it, so every door accepts exactly the same entries. */
export function isScheduleBotGrant(raw: unknown): raw is ScheduleBotGrant {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const g = raw as Record<string, unknown>;
  const valid = scheduleBotGrantFieldValid;
  return valid.id(g.id) && valid.appId(g.sourceAppId) && valid.unionId(g.controllerUnionId)
    && Array.isArray(g.targetAppIds) && g.targetAppIds.length > 0 && g.targetAppIds.every(valid.appId)
    && Array.isArray(g.chatIds) && g.chatIds.length > 0 && g.chatIds.every(valid.chatId);
}

/** Known fields only, with repeated app/chat ids collapsed. */
export function canonicalScheduleBotGrant(g: ScheduleBotGrant): ScheduleBotGrant {
  return { id: g.id, sourceAppId: g.sourceAppId, controllerUnionId: g.controllerUnionId,
    targetAppIds: [...new Set(g.targetAppIds)], chatIds: [...new Set(g.chatIds)] };
}

export function matchingScheduleBotGrant(
  policy: ScheduleDelegationGlobalConfig | undefined,
  sourceAppId: string, targetAppIds: readonly string[], chatId: string,
): ScheduleBotGrant | undefined {
  if (!policy?.createEnabled || !targetAppIds.length) return;
  const matches = (policy.botGrants ?? []).filter(g => g.sourceAppId === sourceAppId
    && g.chatIds.includes(chatId) && targetAppIds.every(id => g.targetAppIds.includes(id)));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Pairs of grant ids that would both match some dispatch: same source, a
 *  shared chat and a shared target. Matching fails closed on that ambiguity,
 *  so such grants would silently never apply; writers reject them instead. */
export function overlappingScheduleBotGrants(grants: readonly ScheduleBotGrant[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  grants.forEach((a, i) => {
    for (const b of grants.slice(i + 1)) {
      if (a.sourceAppId === b.sourceAppId && a.chatIds.some(chat => b.chatIds.includes(chat))
        && a.targetAppIds.some(target => b.targetAppIds.includes(target))) out.push([a.id, b.id]);
    }
  });
  return out;
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
