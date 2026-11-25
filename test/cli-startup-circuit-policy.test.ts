import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decideAutoRestart,
  RESTART_WINDOW_MS,
  type RestartCounter,
} from '../src/core/restart-policy.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

function exit(prev: RestartCounter | undefined, code: number | null | undefined, startupFailure = true) {
  return decideAutoRestart({ prev, now: Date.now(), code, startupFailure });
}

describe('startup circuit: real exits, readiness and independent restart budgets', () => {
  it.each([1, 2, 42, 77, 127])('stops the second unready exit %s even after a long initialization', async code => {
    const first = exit(undefined, code);
    expect(first.shouldRestart).toBe(true);
    await vi.advanceTimersByTimeAsync(RESTART_WINDOW_MS * 4);
    const second = exit(first.next, code);
    expect(second).toMatchObject({ shouldRestart: false, reason: 'startup_failure' });
  });

  it.each([0, null, undefined])('does not spend startup budget on exit %s without a nonzero code', async code => {
    const first = exit(undefined, 1);
    await vi.advanceTimersByTimeAsync(RESTART_WINDOW_MS + 1);
    // Even an inconsistent sender setting startupFailure=true must supply a
    // nonzero exit. Signals / clean exits are not startup-failure evidence.
    const intervening = exit(first.next, code);
    expect(intervening.shouldRestart).toBe(true);
    await vi.advanceTimersByTimeAsync(RESTART_WINDOW_MS + 1);
    expect(exit(intervening.next, 2)).toMatchObject({ shouldRestart: false, reason: 'startup_failure' });
  });

  it('does not forgive a startup failure when an intervening CLI became ready but died quickly', async () => {
    const first = exit(undefined, 1);
    const ready = { ...first.next, readyAt: Date.now() };
    await vi.advanceTimersByTimeAsync(RESTART_WINDOW_MS / 2);
    const runningCrash = exit(ready, 2, false);
    expect(runningCrash.shouldRestart).toBe(true);
    // The next CLI never becomes ready; time spent initializing is NOT time
    // spent healthy in the preceding CLI generation.
    await vi.advanceTimersByTimeAsync(RESTART_WINDOW_MS * 10);
    expect(exit(runningCrash.next, 1)).toMatchObject({ shouldRestart: false, reason: 'startup_failure' });
  });

  it.each([
    { extra: 0, allowed: false },
    { extra: 1, allowed: true },
  ])('uses the ready survival boundary, not time since the previous exit: +$extra ms', async ({ extra, allowed }) => {
    const first = exit(undefined, 1);
    await vi.advanceTimersByTimeAsync(RESTART_WINDOW_MS * 3);
    const ready = { ...first.next, readyAt: Date.now() };
    await vi.advanceTimersByTimeAsync(RESTART_WINDOW_MS + extra);
    const next = exit(ready, 1);
    expect(next.shouldRestart).toBe(allowed);
    expect(next.reason).toBe(allowed ? 'ok' : 'startup_failure');
  });

  it('gives an explicitly new launch batch its own single retry, without resetting another session', async () => {
    const a = exit(undefined, 1);
    const b = exit(undefined, 2);
    await vi.advanceTimersByTimeAsync(RESTART_WINDOW_MS * 2);
    expect(exit(a.next, 1).shouldRestart).toBe(false);
    const retriedByUser = exit(undefined, 1);
    expect(retriedByUser.shouldRestart).toBe(true);
    expect(exit(b.next, 2).shouldRestart).toBe(false);
    expect(exit(retriedByUser.next, 1).shouldRestart).toBe(false);
  });

  it('keeps the old ordinary-crash and permanent-exit paths independent of startup classification', async () => {
    const first = exit(undefined, 1, false);
    await vi.advanceTimersByTimeAsync(RESTART_WINDOW_MS * 2);
    expect(exit(first.next, 2, false)).toMatchObject({ shouldRestart: true, reason: 'ok' });
    const permanent = exit(undefined, 127, false);
    await vi.advanceTimersByTimeAsync(RESTART_WINDOW_MS * 2);
    expect(exit(permanent.next, 77, false)).toMatchObject({ shouldRestart: false, reason: 'permanent_exit' });
  });

  it('accepts a pre-startup-counter record without inventing startup evidence or mutating it', async () => {
    const legacy = Object.freeze({ count: 1, lastAt: Date.now(), lastCode: 1 });
    await vi.advanceTimersByTimeAsync(RESTART_WINDOW_MS * 2);
    const first = exit(legacy, 1);
    expect(first.shouldRestart).toBe(true);
    expect(exit(first.next, 1)).toMatchObject({ shouldRestart: false, reason: 'startup_failure' });
    expect(legacy).toEqual({ count: 1, lastAt: 1_000_000, lastCode: 1 });
  });
});
