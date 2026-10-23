import { describe, it, expect } from 'vitest';
import { activeVcMeetingInviters, applyVcMeetingInviterPolicyPatch, createVcMeetingInviterGrant, isVcMeetingInviterGrant, type VcMeetingInviterPolicy } from '../src/services/vc-meeting-inviter-policy.js';
import { parseVcMeetingPushEvent, VC_BOT_MEETING_INVITED_EVENT } from '../src/vc-agent/push-source.js';

const now = 1_790_000_000_000;
const policy = { inviterManagementEnabled: true, inviterManagementEnabledAt: now - 1000 };
const invitation = { openId: 'ou_inviter', eventId: 'evt_invite', invitedAt: now };

describe('meeting inviter authority', () => {
  it('defaults off, and never treats string true as owner consent', () => {
    expect(createVcMeetingInviterGrant({}, invitation, now)).toBeUndefined();
    expect(createVcMeetingInviterGrant({ inviterManagementEnabled: 'true' } as never, invitation, now)).toBeUndefined();
  });
  it('activates only after membership verification; preserves no authority after end/off/re-enable', () => {
    const grant = createVcMeetingInviterGrant(policy, invitation, now)!;
    expect(activeVcMeetingInviters(policy, [grant])).toEqual([]);
    grant.memberReady = true;
    expect(activeVcMeetingInviters(policy, [grant])).toEqual([grant]);
    expect(activeVcMeetingInviters(policy, [grant], true)).toEqual([]);
    const next = { ...policy };
    applyVcMeetingInviterPolicyPatch(next, false, now + 1);
    expect(activeVcMeetingInviters(next, [grant])).toEqual([]);
    applyVcMeetingInviterPolicyPatch(next, true, now + 2);
    expect(activeVcMeetingInviters(next, [grant])).toEqual([]);
    expect(createVcMeetingInviterGrant(next, invitation, now + 2)).toBeUndefined();
  });
  it.each([
    { openId: 'on_union' }, { openId: 'ou_bad_id' }, { eventId: undefined },
    { invitedAt: undefined }, { invitedAt: now - 2000 }, { invitedAt: now + 120000 },
  ])('rejects unverified/old invitation %j', patch => {
    expect(createVcMeetingInviterGrant(policy, { ...invitation, ...patch }, now)).toBeUndefined();
  });
  it('preserves enable epoch for old clients and ordinary policy edits', () => {
    const next: VcMeetingInviterPolicy = { ...policy };
    applyVcMeetingInviterPolicyPatch(next, undefined, now);
    applyVcMeetingInviterPolicyPatch(next, true, now);
    expect(next).toEqual(policy);
    expect(isVcMeetingInviterGrant({ ...invitation, policyEnabledAt: 0, memberReady: true })).toBe(true);
    expect(isVcMeetingInviterGrant({ ...invitation, policyEnabledAt: 0, memberReady: 'true' })).toBe(false);
  });
});

describe('native invitation identity extraction', () => {
  const native = { event_id: 'evt1', inviter: { id: 'ou_inviter', user_type: 1 }, invite_time: String(now), meeting: { id: '123', meeting_no: '123456789' } };
  const parse = (data: unknown, kind: 'meeting_invited' | 'meeting_activity' = 'meeting_invited') => parseVcMeetingPushEvent({ data, kind, eventType: VC_BOT_MEETING_INVITED_EVENT, larkAppId: 'cli_listener' });
  it.each([native, { event: native }, { data: { event: native } }])('extracts only a real human inviter, retaining event provenance', data => {
    expect(parse(data).inviter).toEqual({ openId: 'ou_inviter', invitedAt: now });
  });
  it('does not promote hosts, names, bots, other ID types or non-invitation events', () => {
    expect(parse({ meeting: { host_user: { open_id: 'ou_host' } } }).inviter).toBeUndefined();
    expect(parse({ ...native, inviter: { id: 'on_other', user_type: 1 } }).inviter).toBeUndefined();
    expect(parse({ ...native, inviter: { id: 'ou_bot', user_type: 10 } }).inviter).toBeUndefined();
    expect(parse(native, 'meeting_activity').inviter).toBeUndefined();
  });
});
