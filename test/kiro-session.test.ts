import { describe, expect, it } from 'vitest';
import { extractKiroSessionIdFromOutput } from '../src/services/kiro-session.js';

const KIROID = 'f2946a26-3735-4b08-8d05-c928010302d5';

describe('extractKiroSessionIdFromOutput', () => {
  it('extracts the id from Kiro resume command output', () => {
    expect(extractKiroSessionIdFromOutput(`Resume with: kiro-cli chat --resume-id ${KIROID}`))
      .toBe(KIROID);
  });

  it('extracts a bare UUID line printed by /session-id', () => {
    expect(extractKiroSessionIdFromOutput(`\x1b[32m/session-id\x1b[0m\n${KIROID}\nKiro>`))
      .toBe(KIROID);
  });

  it('does not treat labelled botmux Session ID text as a Kiro native id', () => {
    expect(extractKiroSessionIdFromOutput(`Session ID: ${KIROID}`)).toBeUndefined();
  });
});
