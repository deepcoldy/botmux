import { describe, expect, it } from 'vitest';
import { truncateUtf16WellFormed } from '../src/utils/unicode.js';

describe('truncateUtf16WellFormed', () => {
  it('keeps the UTF-16 budget without splitting a surrogate pair', () => {
    const value = truncateUtf16WellFormed('a'.repeat(4) + '😀x', 5);
    expect(value).toBe('a'.repeat(4));
    expect(value.isWellFormed()).toBe(true);
    expect(value.length).toBeLessThanOrEqual(5);
  });

  it('preserves a complete astral code point when it fits', () => {
    expect(truncateUtf16WellFormed('a'.repeat(3) + '😀x', 5))
      .toBe('a'.repeat(3) + '😀');
  });

  it('repairs an isolated surrogate in truncated input', () => {
    const value = truncateUtf16WellFormed(`a\ud83db`, 2);
    expect(value).toBe('a\ufffd');
    expect(value.isWellFormed()).toBe(true);
  });

  it('repairs an isolated surrogate even when no truncation is needed', () => {
    expect(truncateUtf16WellFormed('a\ud83d', 10)).toBe('a\ufffd');
  });
});
