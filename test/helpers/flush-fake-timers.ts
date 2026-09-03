import { vi } from 'vitest';

/**
 * Pump fake timers in steps so delays scheduled after an `await` still fire.
 *
 * Bun's `runAllTimersAsync` / a single `advanceTimersByTimeAsync(n)` only
 * flushes timers that are already queued. Sequential `await delay()` calls
 * schedule the next timeout after the previous one resolves, so a one-shot
 * advance leaves the rest parked on the fake clock until the test times out.
 */
export async function flushFakeTimers(ms = 10_000, step = 50): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await vi.advanceTimersByTimeAsync(step);
  }
}
