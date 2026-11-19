import { describe, it, beforeEach, expect, vi } from 'vitest';
import { canInviterTalkToMeeting } from '../src/services/vc-meeting-inviter-access.js';
const fixtures = vi.hoisted(() => ({ route: undefined as any, records: [] as any[], ended: false }));
vi.mock('../src/services/vc-meeting-im-routing.js', () => ({ resolveDurableVcMeetingImRouting: () => fixtures.route }));
vi.mock('../src/services/vc-meeting-runtime-store.js', () => ({
  listVcMeetingRuntimeSessionsByListenerAndAgent: (_dir: string, q: any) => fixtures.records.filter(r => r.listenerChatId === q.listenerChatId),
  hasVcMeetingEndedTombstone: () => fixtures.ended,
}));
const policy = { inviterManagementEnabled: true, inviterManagementEnabledAt: 100 };
const run = (over: any = {}) => canInviterTalkToMeeting({ dataDir: '/isolated', agentAppId: 'cli_listener', chatId: 'oc_meeting', openId: 'ou_inviter', policyFor: () => policy, isBlockedFor: () => false, ...over });
beforeEach(() => {
  fixtures.ended = false;
  fixtures.route = { kind: 'receiver', candidate: { lifecycle: 'active', listenerAppId: 'cli_listener', meetingId: 'm1' } };
  fixtures.records = [{ larkAppId: 'cli_listener', meeting: { id: 'm1' }, listenerChatId: 'oc_meeting', inviterManagers: [
    { openId: 'ou_inviter', eventId: 'evt', invitedAt: 1000, policyEnabledAt: 100, memberReady: true },
  ] }];
});
describe('meeting-scoped IM permission', () => {
  it('permits only the exact active receiver and inviter; other chat/person/app has no new permission', () => {
    expect(run()).toBe(true);
    expect(run({ chatId: 'oc_other' })).toBe(false);
    expect(run({ openId: 'ou_other' })).toBe(false);
    expect(run({ agentAppId: 'cli_other' })).toBe(false);
    fixtures.route.candidate.meetingId = 'm2';
    expect(run()).toBe(false);
  });
  it('never creates ordinary or ambiguous-session access; disabled/ended/closing/pending fail closed', () => {
    expect(run({ policyFor: () => ({}) })).toBe(false);
    fixtures.ended = true; expect(run()).toBe(false); fixtures.ended = false;
    fixtures.records[0].consumerClosePhase = 'data_closing'; expect(run()).toBe(false); delete fixtures.records[0].consumerClosePhase;
    fixtures.records[0].inviterManagers[0].memberReady = false; expect(run()).toBe(false);
    fixtures.records[0].inviterManagers[0].memberReady = true;
    fixtures.route.candidate.lifecycle = 'sealed'; expect(run()).toBe(false);
    fixtures.route = { kind: 'ordinary' }; expect(run()).toBe(false);
    fixtures.route = { kind: 'ambiguous' }; expect(run()).toBe(false);
  });
  it('cross-application IM requires a verified union identity, never copied open_id', () => {
    expect(run({ agentAppId: 'cli_receiver' })).toBe(false);
    fixtures.records[0].inviterManagers[0].unionId = 'on_person';
    expect(run({ agentAppId: 'cli_receiver', openId: 'ou_receiverScoped', unionId: 'on_person' })).toBe(true);
    expect(run({ agentAppId: 'cli_receiver', unionId: 'on_other' })).toBe(false);
    expect(run({ agentAppId: 'cli_receiver', openId: 'ou_receiverScoped', unionId: 'on_person',
      isBlockedFor: (appId: string, openId: string) => appId === 'cli_listener' && openId === 'ou_inviter',
    })).toBe(false);
  });
});
