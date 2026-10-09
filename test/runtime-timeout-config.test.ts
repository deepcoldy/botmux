import { describe, expect, it } from 'vitest';
import {
  resolveStuckDetectorTimeoutMs,
  resolveWorktreeSlugAiTimeoutMs,
} from '../src/config.js';

describe('runtime timeout config', () => {
  it('uses the documented defaults when overrides are absent', () => {
    expect(resolveStuckDetectorTimeoutMs({})).toBe(45_000);
    expect(resolveWorktreeSlugAiTimeoutMs({})).toBe(5_000);
  });

  it('accepts positive delays within the runtime timer range', () => {
    expect(resolveStuckDetectorTimeoutMs({ STUCK_DETECTOR_TIMEOUT_MS: '60000' })).toBe(60_000);
    expect(resolveWorktreeSlugAiTimeoutMs({
      BOTMUX_WORKTREE_SLUG_AI_TIMEOUT_MS: '2500.5',
    })).toBe(2_500.5);
  });

  it.each(['', ' ', '0', '-1', 'Infinity', 'not-a-number', '2147483648'])(
    'falls back for invalid timer override %j',
    value => {
      expect(resolveStuckDetectorTimeoutMs({ STUCK_DETECTOR_TIMEOUT_MS: value })).toBe(45_000);
      expect(resolveWorktreeSlugAiTimeoutMs({
        BOTMUX_WORKTREE_SLUG_AI_TIMEOUT_MS: value,
      })).toBe(5_000);
    },
  );
});
