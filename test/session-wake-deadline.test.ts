import { describe, expect, it } from 'vitest';
import { SESSION_WAKE_TIMEOUT_MS, sessionWakeAcquireTimeoutMs } from '../src/core/session-wake-deadline.js';

describe('sessionWakeAcquireTimeoutMs', () => {
  const now = 1_000_000;

  it('defaults to the daemon cap when no header is present', () => {
    expect(sessionWakeAcquireTimeoutMs(undefined, now)).toBe(SESSION_WAKE_TIMEOUT_MS);
  });

  it('honours a requested deadline shorter than the cap', () => {
    expect(sessionWakeAcquireTimeoutMs(String(now + 250), now)).toBe(250);
  });

  it('clamps a requested deadline longer than the daemon cap', () => {
    expect(sessionWakeAcquireTimeoutMs(String(now + 999_999), now)).toBe(SESSION_WAKE_TIMEOUT_MS);
  });

  it('falls back to the cap for non-numeric or non-positive headers', () => {
    expect(sessionWakeAcquireTimeoutMs('abc', now)).toBe(SESSION_WAKE_TIMEOUT_MS);
    expect(sessionWakeAcquireTimeoutMs('-5', now)).toBe(SESSION_WAKE_TIMEOUT_MS);
    expect(sessionWakeAcquireTimeoutMs('0', now)).toBe(SESSION_WAKE_TIMEOUT_MS);
  });

  it('takes the first value when the header is an array', () => {
    expect(sessionWakeAcquireTimeoutMs([String(now + 100), String(now + 200)], now)).toBe(100);
  });
});
