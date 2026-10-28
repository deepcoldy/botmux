import { describe, expect, it } from 'vitest';
import { isValidMarkerIdentityTurnId } from '../src/core/turn-id-shape.js';

describe('isValidMarkerIdentityTurnId marker shape guard', () => {
  it('accepts ordinary bounded turn ids', () => {
    expect(isValidMarkerIdentityTurnId('om_x100b62b497f')).toBe(true);
    expect(isValidMarkerIdentityTurnId('schedule:once:abcdef')).toBe(true);
    expect(isValidMarkerIdentityTurnId('a'.repeat(256))).toBe(true);
  });

  it('rejects non-string shapes without coercing them', () => {
    // The original bug surface: a number was the only malformation reaching
    // the typeof guard in a shared adopt loop, so the string cases were never
    // exercised. Pin each class independently.
    expect(isValidMarkerIdentityTurnId(12345)).toBe(false);
    expect(isValidMarkerIdentityTurnId(null)).toBe(false);
    expect(isValidMarkerIdentityTurnId(undefined)).toBe(false);
    expect(isValidMarkerIdentityTurnId({ turnId: 'om_x' })).toBe(false);
    expect(isValidMarkerIdentityTurnId(['om_x'])).toBe(false);
    expect(isValidMarkerIdentityTurnId(true)).toBe(false);
  });

  it('rejects embedded newlines and other control characters', () => {
    expect(isValidMarkerIdentityTurnId('bad\nturn')).toBe(false);
    expect(isValidMarkerIdentityTurnId('bad\rturn')).toBe(false);
    expect(isValidMarkerIdentityTurnId('bad\tturn')).toBe(false);
    expect(isValidMarkerIdentityTurnId('bad\0turn')).toBe(false);
    expect(isValidMarkerIdentityTurnId('bad\u007fturn')).toBe(false);
  });

  it('rejects overlong values beyond the 256-char marker bound', () => {
    expect(isValidMarkerIdentityTurnId('x'.repeat(257))).toBe(false);
    expect(isValidMarkerIdentityTurnId('x'.repeat(1024))).toBe(false);
  });

  it('rejects empty and whitespace-only values', () => {
    expect(isValidMarkerIdentityTurnId('')).toBe(false);
    expect(isValidMarkerIdentityTurnId(' ')).toBe(false);
    expect(isValidMarkerIdentityTurnId('\n')).toBe(false);
    expect(isValidMarkerIdentityTurnId('  \t ')).toBe(false);
  });
});
