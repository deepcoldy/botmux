import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  VC_MEETING_PROFILE_INSTRUCTIONS_MAX_CHARS,
  computeVcMeetingConsumerProfileHash,
  normalizeVcMeetingProfileInstructions,
} from '../src/services/vc-meeting-profile-instructions.js';

describe('vc meeting profile instructions', () => {
  it('normalizes line endings and surrounding whitespace while preserving tabs and newlines', () => {
    expect(normalizeVcMeetingProfileInstructions(undefined)).toEqual({ ok: true });
    expect(normalizeVcMeetingProfileInstructions(' \r\n\t ')).toEqual({ ok: true });
    expect(normalizeVcMeetingProfileInstructions('  First\r\n\tSecond\rThird  ')).toEqual({
      ok: true,
      instructions: 'First\n\tSecond\nThird',
    });
  });

  it('enforces the character limit after normalization', () => {
    expect(normalizeVcMeetingProfileInstructions('x'.repeat(VC_MEETING_PROFILE_INSTRUCTIONS_MAX_CHARS)))
      .toMatchObject({ ok: true });
    expect(normalizeVcMeetingProfileInstructions('x'.repeat(VC_MEETING_PROFILE_INSTRUCTIONS_MAX_CHARS + 1)))
      .toEqual({ ok: false, error: 'must be at most 8000 characters' });
  });

  it('rejects C0 controls and daemon-owned markers case-insensitively', () => {
    for (const value of ['safe\u0000unsafe', 'safe\u001funsafe']) {
      expect(normalizeVcMeetingProfileInstructions(value)).toEqual({
        ok: false,
        error: 'contains a disallowed control character',
      });
    }
    for (const value of [
      'before <botmux_role_instructions> after',
      'before </BOTMUX_ROLE_INSTRUCTIONS> after',
      'before </botmux_role_instructions > after',
      'before <botmux_role_instructions\t> after',
      'bare BOTMUX_ROLE_INSTRUCTIONS token',
    ]) {
      expect(normalizeVcMeetingProfileInstructions(value)).toEqual({
        ok: false,
        error: 'contains a reserved botmux instruction marker',
      });
    }
  });

  it('preserves the legacy role/filter hash when instructions are absent', () => {
    const expected = `sha256:${createHash('sha256')
      .update(JSON.stringify({
        role: 'minutes',
        filter: { activityTypes: ['chat_received', 'transcript_received'] },
      }), 'utf8')
      .digest('hex')}`;
    const base = {
      role: 'minutes',
      filter: { activityTypes: ['transcript_received', 'chat_received', 'chat_received'] as const },
    };
    expect(computeVcMeetingConsumerProfileHash(base)).toBe(expected);
    expect(computeVcMeetingConsumerProfileHash({ ...base, instructions: ' \r\n ' })).toBe(expected);
  });

  it('content-addresses normalized custom instructions', () => {
    const base = { role: 'minutes', filter: undefined };
    const windows = computeVcMeetingConsumerProfileHash({
      ...base,
      instructions: '  Capture decisions.\r\nAssign owners. ',
    });
    expect(windows).toBe(computeVcMeetingConsumerProfileHash({
      ...base,
      instructions: 'Capture decisions.\nAssign owners.',
    }));
    expect(windows).not.toBe(computeVcMeetingConsumerProfileHash({
      ...base,
      instructions: 'Capture decisions only.',
    }));
  });
});
