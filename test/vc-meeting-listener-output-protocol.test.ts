import { describe, expect, it } from 'vitest';
import {
  parseVcMeetingListenerOutput,
  VC_MEETING_LISTENER_OUTPUT_CONTRACT,
  vcMeetingListenerOutputProtocolForInstructionVersion,
} from '../src/services/vc-meeting-listener-output-protocol.js';

describe('VC meeting listener output protocol', () => {
  it('accepts only the minimal skip envelope', () => {
    expect(parseVcMeetingListenerOutput('{"decision":"skip"}')).toEqual({
      ok: true,
      decision: 'skip',
    });
    expect(parseVcMeetingListenerOutput('{"decision":"skip","content":"nothing"}'))
      .toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it('extracts publish content without exposing the control envelope', () => {
    expect(parseVcMeetingListenerOutput(JSON.stringify({
      decision: 'publish',
      content: '  发布窗口由 10 点调整到 11 点。  ',
    }))).toEqual({
      ok: true,
      decision: 'publish',
      content: '发布窗口由 10 点调整到 11 点。',
    });
    expect(parseVcMeetingListenerOutput('```json\n{"decision":"publish","content":"更新"}\n```'))
      .toEqual({ ok: true, decision: 'publish', content: '更新' });
  });

  it('fails closed on prose, empty content, unknown decisions, and extra fields', () => {
    for (const raw of [
      '暂无重要更新',
      '{"decision":"publish","content":"   "}',
      '{"decision":"wait"}',
      '{"decision":"publish","content":"更新","fingerprint":"x"}',
      'prefix {"decision":"skip"}',
    ]) {
      expect(parseVcMeetingListenerOutput(raw).ok).toBe(false);
    }
  });

  it('keeps semantic timing, corrections, fingerprints, and cadence out of the schema', () => {
    expect(VC_MEETING_LISTENER_OUTPUT_CONTRACT).toContain('time, owner, scope, status, or conclusion');
    expect(VC_MEETING_LISTENER_OUTPUT_CONTRACT).not.toContain('fingerprint');
    expect(VC_MEETING_LISTENER_OUTPUT_CONTRACT).not.toContain('debounce');
  });

  it('keeps pre-upgrade deliveries on plain output while enabling the v2 contract', () => {
    expect(vcMeetingListenerOutputProtocolForInstructionVersion('meeting-consumer-v1')).toBe('plain');
    expect(vcMeetingListenerOutputProtocolForInstructionVersion('meeting-consumer-v2')).toBe('decision_v1');
    expect(vcMeetingListenerOutputProtocolForInstructionVersion('unknown-future-version')).toBe('plain');
  });
});
