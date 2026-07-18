import { describe, expect, it } from 'vitest';
import { extractVcMeetingNumber, parseVcMeetingPrepareCommand } from '../src/core/vc-meeting-prepare-command.js';

describe('vc meeting prepare command', () => {
  it('extracts a normalized meeting number from a Lark meeting link', () => {
    expect(extractVcMeetingNumber('https://vc-my.larkoffice.com/j/688542737')).toBe('688542737');
    expect(extractVcMeetingNumber('688 542 737')).toBe('688542737');
  });

  it('parses prepare with automatic Q&A enabled by default', () => {
    expect(parseVcMeetingPrepareCommand('/vc prepare https://vc-my.larkoffice.com/j/688542737')).toEqual({
      kind: 'prepare',
      meetingNo: '688542737',
      meetingLink: 'https://vc-my.larkoffice.com/j/688542737',
      qaMode: 'auto',
    });
  });

  it('parses status, off and explicit Q&A disable', () => {
    expect(parseVcMeetingPrepareCommand('/vc status 688 542 737')).toEqual({ kind: 'status', meetingNo: '688542737' });
    expect(parseVcMeetingPrepareCommand('/vc off all')).toEqual({ kind: 'off', all: true });
    expect(parseVcMeetingPrepareCommand('/vc prepare 688542737 --qa off')).toEqual({
      kind: 'prepare',
      meetingNo: '688542737',
      qaMode: 'off',
    });
  });

  it('does not retain the unmerged /meeting command alias', () => {
    expect(parseVcMeetingPrepareCommand('/meeting prepare 688542737')).toEqual({
      kind: 'invalid',
      reason: 'unknown_command',
    });
  });
});
