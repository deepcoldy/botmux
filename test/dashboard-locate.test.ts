// test/dashboard-locate.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LocateRateLimiter } from '../src/core/dashboard-locate.js';

describe('LocateRateLimiter', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(0)); });
  afterEach(() => { vi.useRealTimers(); });

  it('first call allowed, second within window denied', () => {
    const rl = new LocateRateLimiter(30_000);
    expect(rl.tryAcquire('s1')).toEqual({ ok: true });
    const r = rl.tryAcquire('s1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it('different sessionIds do not interfere', () => {
    const rl = new LocateRateLimiter(30_000);
    expect(rl.tryAcquire('s1').ok).toBe(true);
    expect(rl.tryAcquire('s2').ok).toBe(true);
  });

  it('after window passes, next call allowed', () => {
    const rl = new LocateRateLimiter(30_000);
    rl.tryAcquire('s1');
    vi.advanceTimersByTime(30_001);
    expect(rl.tryAcquire('s1').ok).toBe(true);
  });
});
