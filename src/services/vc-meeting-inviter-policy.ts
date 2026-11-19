/** Meeting-local authority, never a bot administrator or a chat-wide grant. */
export interface VcMeetingInviterPolicy {
  inviterManagementEnabled?: boolean;
  /** Rotated on each Dashboard enable; disabling/re-enabling cannot revive old grants. */
  inviterManagementEnabledAt?: number;
}

export interface VcMeetingInviterGrant {
  openId: string;
  /** Learned only from this listener application's trusted VC actor events. */
  unionId?: string;
  eventId: string;
  invitedAt: number;
  policyEnabledAt: number;
  /** Authority is activated only after membership has been independently established. */
  memberReady: boolean;
}

export function isVcMeetingInviterGrant(value: unknown): value is VcMeetingInviterGrant {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.openId === 'string' && /^ou_[A-Za-z0-9]+$/.test(r.openId)
    && (r.unionId === undefined || (typeof r.unionId === 'string' && /^on_[A-Za-z0-9]+$/.test(r.unionId)))
    && typeof r.eventId === 'string' && !!r.eventId.trim()
    && typeof r.invitedAt === 'number' && Number.isSafeInteger(r.invitedAt) && r.invitedAt > 0
    && typeof r.policyEnabledAt === 'number' && Number.isSafeInteger(r.policyEnabledAt) && r.policyEnabledAt >= 0
    && typeof r.memberReady === 'boolean';
}

export function activeVcMeetingInviters(
  policy: VcMeetingInviterPolicy,
  grants: readonly VcMeetingInviterGrant[] = [],
  ended = false,
): VcMeetingInviterGrant[] {
  if (ended || policy.inviterManagementEnabled !== true) return [];
  return grants.filter(g => isVcMeetingInviterGrant(g) && g.memberReady
    && g.policyEnabledAt === (policy.inviterManagementEnabledAt ?? 0));
}

export function createVcMeetingInviterGrant(
  policy: VcMeetingInviterPolicy,
  invitation: { openId: string; eventId?: string; invitedAt?: number },
  now = Date.now(),
): VcMeetingInviterGrant | undefined {
  const epoch = policy.inviterManagementEnabledAt ?? 0;
  const time = invitation.invitedAt;
  if (policy.inviterManagementEnabled !== true || !invitation.eventId || time === undefined
    || time < epoch || time < now - 30 * 60_000 || time > now + 60_000) return undefined;
  const grant = { openId: invitation.openId, eventId: invitation.eventId,
    invitedAt: time, policyEnabledAt: epoch, memberReady: false };
  return isVcMeetingInviterGrant(grant) ? grant : undefined;
}

/** Optional patch preserves existing values for old Dashboard clients. */
export function applyVcMeetingInviterPolicyPatch(
  policy: VcMeetingInviterPolicy, enabled: boolean | undefined, now = Date.now(),
): void {
  if (enabled === undefined) return;
  if (enabled && policy.inviterManagementEnabled !== true) {
    policy.inviterManagementEnabledAt = Math.max(now, (policy.inviterManagementEnabledAt ?? 0) + 1);
  }
  policy.inviterManagementEnabled = enabled;
}
