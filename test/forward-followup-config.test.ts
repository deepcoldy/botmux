import { describe, expect, it } from 'vitest';
import { resolveForwardFollowupWaitMs } from '../src/config.js';

describe('resolveForwardFollowupWaitMs', () => {
  it('defaults to 1500ms when unset', () => {
    expect(resolveForwardFollowupWaitMs({})).toBe(1_500);
  });

  it('allows zero to disable coalescing', () => {
    expect(resolveForwardFollowupWaitMs({ BOTMUX_FORWARD_FOLLOWUP_WAIT_MS: '0' })).toBe(0);
  });

  it('truncates positive decimals and clamps the maximum', () => {
    expect(resolveForwardFollowupWaitMs({ BOTMUX_FORWARD_FOLLOWUP_WAIT_MS: '123.9' })).toBe(123);
    expect(resolveForwardFollowupWaitMs({ BOTMUX_FORWARD_FOLLOWUP_WAIT_MS: '20000' })).toBe(10_000);
  });

  it('falls back to the default for invalid or negative values', () => {
    expect(resolveForwardFollowupWaitMs({ BOTMUX_FORWARD_FOLLOWUP_WAIT_MS: 'nope' })).toBe(1_500);
    expect(resolveForwardFollowupWaitMs({ BOTMUX_FORWARD_FOLLOWUP_WAIT_MS: '-1' })).toBe(1_500);
  });
});
