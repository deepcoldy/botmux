import { describe, expect, it } from 'vitest';
import { ReadOnlyRemoteScrollLimiter } from '../src/utils/web-terminal-scroll.js';
import type { ReadOnlyRemoteScrollPayload } from '../src/utils/web-terminal-scroll.js';

const WINDOW_MS = 1_000;

function payload(direction: ReadOnlyRemoteScrollPayload['direction'], eventCount: number): ReadOnlyRemoteScrollPayload {
  return { direction, eventCount };
}

describe('ReadOnlyRemoteScrollLimiter', () => {
  it('allows up to the configured budget of events within one window', () => {
    let now = 0;
    const limiter = new ReadOnlyRemoteScrollLimiter({ budget: 3, windowMs: WINDOW_MS }, () => now);

    expect(limiter.tryConsume(1)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(true);
  });

  it('denies events that would exceed the budget within one window', () => {
    let now = 0;
    const limiter = new ReadOnlyRemoteScrollLimiter({ budget: 3, windowMs: WINDOW_MS }, () => now);

    expect(limiter.tryConsume(1)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(false);
    expect(limiter.tryConsume(2)).toBe(false);
  });

  it('drops a single over-budget payload without consuming the window budget', () => {
    let now = 0;
    const limiter = new ReadOnlyRemoteScrollLimiter({ budget: 2, windowMs: WINDOW_MS }, () => now);

    expect(limiter.tryConsume(6)).toBe(false);
    expect(limiter.tryConsume(1)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(false);
  });

  it('shares one budget across multiple callers of the same limiter instance', () => {
    let now = 0;
    const limiter = new ReadOnlyRemoteScrollLimiter({ budget: 2, windowMs: WINDOW_MS }, () => now);

    const callerA: boolean[] = [];
    const callerB: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      callerA.push(limiter.tryConsume(1));
      callerB.push(limiter.tryConsume(1));
    }

    const allowedCount = [...callerA, ...callerB].filter(allowed => allowed).length;
    expect(allowedCount).toBe(2);
    expect(callerA[0]).toBe(true);
    expect(callerB[0]).toBe(true);
    expect(callerA[1]).toBe(false);
    expect(callerB[1]).toBe(false);
  });

  it('reopens the budget when a later window begins', () => {
    let now = 0;
    const limiter = new ReadOnlyRemoteScrollLimiter({ budget: 2, windowMs: WINDOW_MS }, () => now);

    expect(limiter.tryConsume(1)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(false);

    now = WINDOW_MS - 1;
    expect(limiter.tryConsume(1)).toBe(false);

    now = WINDOW_MS;
    expect(limiter.tryConsume(1)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(false);
  });

  it('shares the budget across directions so mixed scroll cannot bypass the limit', () => {
    let now = 0;
    const limiter = new ReadOnlyRemoteScrollLimiter({ budget: 2, windowMs: WINDOW_MS }, () => now);

    const bursts: readonly ReadOnlyRemoteScrollPayload[] = [
      payload('up', 1),
      payload('down', 1),
      payload('up', 1),
      payload('down', 1),
    ];

    const allowed: ReadOnlyRemoteScrollPayload[] = [];
    for (const burst of bursts) {
      if (limiter.tryConsume(burst.eventCount)) allowed.push(burst);
    }

    expect(allowed).toEqual([bursts[0], bursts[1]]);
  });

  it('works with the default wall-clock nowMs when no clock is injected', () => {
    const limiter = new ReadOnlyRemoteScrollLimiter({ budget: 1, windowMs: WINDOW_MS });

    expect(limiter.tryConsume(1)).toBe(true);
  });

  it('rejects non-positive budget or window configuration', () => {
    expect(() => new ReadOnlyRemoteScrollLimiter({ budget: 0, windowMs: WINDOW_MS })).toThrow();
    expect(() => new ReadOnlyRemoteScrollLimiter({ budget: 1, windowMs: 0 })).toThrow();
  });
});
