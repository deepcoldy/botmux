import { activeVcMeetingInviters, type VcMeetingInviterPolicy } from './vc-meeting-inviter-policy.js';
import { listVcMeetingRuntimeSessionsByListenerAndAgent, hasVcMeetingEndedTombstone } from './vc-meeting-runtime-store.js';
import { resolveDurableVcMeetingImRouting } from './vc-meeting-im-routing.js';

/** Only an unambiguous, active managed receiver may inherit meeting-local talk.
 * No ordinary session, global command or shared-chat-wide grant is created. */
export function canInviterTalkToMeeting(input: {
  dataDir: string;
  agentAppId: string;
  chatId?: string;
  openId?: string;
  unionId?: string;
  policyFor: (listenerAppId: string) => VcMeetingInviterPolicy | undefined;
  isBlockedFor: (listenerAppId: string, inviterOpenId: string) => boolean;
}): boolean {
  if (!input.chatId || !input.openId) return false;
  try {
    const route = resolveDurableVcMeetingImRouting(input.dataDir, {
      listenerChatId: input.chatId, agentAppId: input.agentAppId,
    });
    if (route.kind !== 'receiver' || route.candidate.lifecycle !== 'active') return false;
    const candidate = route.candidate;
    if (hasVcMeetingEndedTombstone(input.dataDir, candidate.listenerAppId, candidate.meetingId)) return false;
    const record = listVcMeetingRuntimeSessionsByListenerAndAgent(input.dataDir, {
      listenerChatId: input.chatId, agentAppId: input.agentAppId,
    }).find(r => r.larkAppId === candidate.listenerAppId && r.meeting.id === candidate.meetingId);
    if (!record || record.consumerClosePhase) return false;
    const policy = input.policyFor(candidate.listenerAppId);
    if (!policy) return false;
    return activeVcMeetingInviters(policy, record.inviterManagers).some(g =>
      !input.isBlockedFor(candidate.listenerAppId, g.openId)
      && (candidate.listenerAppId === input.agentAppId
        ? g.openId === input.openId
        : !!input.unionId && g.unionId === input.unionId));
  } catch {
    // A corrupt/unavailable meeting store must never widen normal IM access.
    return false;
  }
}
