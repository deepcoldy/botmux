import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  XpiSessionStoreBusyRetryScheduler,
  type XpiSessionStoreBusyRetryEvent,
} from '../src/core/xpi-session-store-busy-retry.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('XPI session-store busy retry policy', () => {
  it('bounds exponential fast retries, escalates once, then keeps a slow observable cadence', async () => {
    vi.useFakeTimers();
    const scheduled: XpiSessionStoreBusyRetryEvent[] = [];
    const escalated: XpiSessionStoreBusyRetryEvent[] = [];
    const settled: string[] = [];
    let invocations = 0;
    const scheduler = new XpiSessionStoreBusyRetryScheduler({
      onScheduled: event => scheduled.push(event),
      onEscalated: event => escalated.push(event),
      onSettled: key => settled.push(key),
    });
    const task = () => {
      invocations++;
      if (invocations < 7) scheduler.schedule('release:group-a:turn-a', task);
    };

    scheduler.schedule('release:group-a:turn-a', task);
    for (let i = 0; i < 7; i++) await vi.advanceTimersToNextTimerAsync();

    expect(scheduled.map(event => [event.phase, event.attempt, event.delayMs])).toEqual([
      ['fast', 1, 100],
      ['fast', 2, 200],
      ['fast', 3, 400],
      ['fast', 4, 800],
      ['fast', 5, 1_600],
      ['slow', 1, 5_000],
      ['slow', 2, 5_000],
    ]);
    expect(escalated).toEqual([expect.objectContaining({ phase: 'slow', attempt: 1 })]);
    expect(settled).toEqual(['release:group-a:turn-a']);
    expect(scheduler.snapshot('release:group-a:turn-a')).toBeUndefined();
  });

  it('deduplicates a pending key instead of multiplying timers', async () => {
    vi.useFakeTimers();
    const task = vi.fn();
    const scheduler = new XpiSessionStoreBusyRetryScheduler();

    expect(scheduler.schedule('dispatch:group-a', task)).toBe(true);
    expect(scheduler.schedule('dispatch:group-a', task)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersToNextTimerAsync();
    expect(task).toHaveBeenCalledTimes(1);
  });
});
