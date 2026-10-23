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
  it('rejects a stale invitation even when it is newer than the enable epoch', () => {
    const olderPolicy = { ...policy, inviterManagementEnabledAt: now - 2 * 60 * 60_000 };
    expect(createVcMeetingInviterGrant(olderPolicy, { ...invitation, invitedAt: now - 31 * 60_000 }, now)).toBeUndefined();
    expect(createVcMeetingInviterGrant(olderPolicy, { ...invitation, invitedAt: now - 29 * 60_000 }, now)).toBeDefined();
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
  const withoutInviteTime = { event_id: 'evt_no_time', inviter: native.inviter, meeting: native.meeting };
  it.each([
    { ...withoutInviteTime, header: { create_time: String(now) } },
    { header: { create_time: String(now) }, event: withoutInviteTime },
    { header: { create_time: String(now) }, data: { event: withoutInviteTime } },
  ])('rejects envelope-only invitation time through parser and grant policy: %#', data => {
    const parsed = parse(data);
    expect(parsed.inviter).toEqual({ openId: 'ou_inviter' });
    expect(parsed.occurredAtMs).toBe(now); // General event timing remains available, not authority.
    expect(createVcMeetingInviterGrant(policy, { ...parsed.inviter!, eventId: parsed.eventId }, now)).toBeUndefined();
  });
  it('does not substitute a fresh envelope for malformed invite_time', () => {
    const parsed = parse({ header: { create_time: String(now) }, event: { ...native, invite_time: 'not-a-time' } });
    expect(parsed.inviter?.invitedAt).toBeUndefined();
    expect(createVcMeetingInviterGrant(policy, { ...parsed.inviter!, eventId: parsed.eventId }, now)).toBeUndefined();
  });
  it('grants a valid native invitation using invite_time rather than envelope time', () => {
    const invitedAt = now - 500;
    const parsed = parse({ header: { create_time: String(now) }, event: { ...native, invite_time: String(invitedAt) } });
    expect(parsed.inviter).toEqual({ openId: 'ou_inviter', invitedAt });
    expect(createVcMeetingInviterGrant(policy, { ...parsed.inviter!, eventId: parsed.eventId }, now))
      .toEqual({ openId: 'ou_inviter', eventId: native.event_id, invitedAt,
        policyEnabledAt: policy.inviterManagementEnabledAt, memberReady: false });
  });
  it('rejects a native invitation before enable even when its envelope is fresh', () => {
    const parsed = parse({ header: { create_time: String(now) }, event: { ...native, invite_time: String(now - 2000) } });
    expect(parsed.inviter?.invitedAt).toBe(now - 2000);
    expect(createVcMeetingInviterGrant(policy, { ...parsed.inviter!, eventId: parsed.eventId }, now)).toBeUndefined();
  });
  it('does not promote hosts, names, bots, other ID types or non-invitation events', () => {
    expect(parse({ meeting: { host_user: { open_id: 'ou_host' } } }).inviter).toBeUndefined();
    expect(parse({ ...native, inviter: { id: 'on_other', user_type: 1 } }).inviter).toBeUndefined();
    expect(parse({ ...native, inviter: { id: 'ou_bot', user_type: 10 } }).inviter).toBeUndefined();
    expect(parse(native, 'meeting_activity').inviter).toBeUndefined();
  });
});
