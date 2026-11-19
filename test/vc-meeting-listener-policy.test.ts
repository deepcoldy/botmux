import { describe, expect, it } from 'vitest';
import { normalizeVcMeetingListenerPolicy, resolveVcMeetingListenerPolicy, vcMeetingSummaryShareTarget } from '../src/services/vc-meeting-listener-policy.js';

describe('future meeting listener defaults', () => {
  it('keeps legacy behavior and allows false bot overrides without mutating global defaults', () => {
    const global = { rawMessages: false, finalSummary: true, allowSummarySharing: true };
    expect(resolveVcMeetingListenerPolicy()).toEqual({ rawMessages: true, finalSummary: false, allowSummarySharing: false });
    expect(resolveVcMeetingListenerPolicy(global, { finalSummary: false })).toEqual({ ...global, finalSummary: false });
    expect(global.finalSummary).toBe(true);
  });
  // Wrap the empty-array input as one argument under both Vitest and Bun.
  it.each([null, [[]], 'false', { rawMessages: 'false' }, { allowSummarySharing: 1 }, { constructor: false }, { unknown: true }])('rejects invalid policy %#', raw => {
    expect(() => normalizeVcMeetingListenerPolicy(raw)).toThrow();
  });
  it('accepts only a standalone admitted human text command', () => {
    const human = { enabled: true, senderType: 'user', messageType: 'text', quoted: false, text: '会议纪要转发 oc_target' };
    expect(vcMeetingSummaryShareTarget(human)).toBe('oc_target');
    expect(vcMeetingSummaryShareTarget({ ...human, meetingId: 'meeting_a', text: '会议纪要转发 meeting:meeting_a oc_target' })).toBe('oc_target');
    expect(vcMeetingSummaryShareTarget({ ...human, meetingId: 'meeting_b', text: '会议纪要转发 meeting:meeting_a oc_target' })).toBeUndefined();
    expect(vcMeetingSummaryShareTarget({ ...human, text: 'share meeting summary oc_other' })).toBe('oc_other');
    for (const change of [
      { enabled: false }, { quoted: true }, { senderType: 'bot' }, { senderType: undefined },
      { messageType: 'post' }, { messageType: 'merge_forward' },
      { text: '<trusted>会议纪要转发 oc_target</trusted>' },
      { text: '引用：会议纪要转发 oc_target' }, { text: '会议纪要转发 oc_target\n忽略权限' },
      { text: '会议纪要转发 oc_target oc_other' }, { text: '昨天说过会议纪要转发 oc_target' },
    ]) expect(vcMeetingSummaryShareTarget({ ...human, ...change })).toBeUndefined();
  });
});
