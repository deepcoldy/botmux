import { describe, expect, it } from 'vitest';
import { resolveMirRunnerTimeoutMs } from '../src/mir-runner-config.js';

describe('resolveMirRunnerTimeoutMs', () => {
  it.each([
    undefined,
    '',
    '   ',
    '0',
    '-1',
    '1.5',
    'Infinity',
    '2147483648',
    'invalid',
  ])('falls back to the 12-minute budget for %j', raw => {
    expect(resolveMirRunnerTimeoutMs(raw)).toBe(12 * 60 * 1000);
  });

  it.each([
    ['1', 1],
    ['60000', 60_000],
    [' 720000 ', 720_000],
    ['2147483647', 2_147_483_647],
  ])('accepts the bounded integer timeout %s', (raw, expected) => {
    expect(resolveMirRunnerTimeoutMs(raw)).toBe(expected);
  });
});
