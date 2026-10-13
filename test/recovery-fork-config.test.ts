import { describe, expect, it } from 'vitest';
import { resolveRecoveryForkConfig } from '../src/config.js';

describe('resolveRecoveryForkConfig', () => {
  it('uses the documented defaults when overrides are absent', () => {
    expect(resolveRecoveryForkConfig({})).toEqual({ batchSize: 5, delayMs: 250 });
  });

  it('accepts positive integer batches and non-negative integer delays', () => {
    expect(resolveRecoveryForkConfig({
      BOTMUX_RECOVERY_FORK_BATCH: '12',
      BOTMUX_RECOVERY_FORK_DELAY_MS: '0',
    })).toEqual({ batchSize: 12, delayMs: 0 });
  });

  it.each([
    ['non-numeric values', 'nope', 'later'],
    ['blank values', ' ', ' '],
    ['negative values', '-1', '-1'],
    ['fractional values', '2.5', '10.5'],
    ['infinite values', 'Infinity', 'Infinity'],
  ])('falls back for %s', (_label, batch, delay) => {
    expect(resolveRecoveryForkConfig({
      BOTMUX_RECOVERY_FORK_BATCH: batch,
      BOTMUX_RECOVERY_FORK_DELAY_MS: delay,
    })).toEqual({ batchSize: 5, delayMs: 250 });
  });

  it('rejects delays that overflow the runtime timer range', () => {
    expect(resolveRecoveryForkConfig({
      BOTMUX_RECOVERY_FORK_BATCH: '1',
      BOTMUX_RECOVERY_FORK_DELAY_MS: '2147483648',
    })).toEqual({ batchSize: 1, delayMs: 250 });
  });
});
