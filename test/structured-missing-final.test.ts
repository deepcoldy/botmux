import { describe, expect, it } from 'vitest';
import { StructuredMissingFinalWatchdog } from '../src/services/structured-missing-final.js';

describe('StructuredMissingFinalWatchdog', () => {
  it('expires only the same continuously idle turn after the bounded wait', () => {
    const watchdog = new StructuredMissingFinalWatchdog(20);
    expect(watchdog.observe('turn-A', 1_000)).toBe(false);
    expect(watchdog.observe('turn-A', 1_019)).toBe(false);
    expect(watchdog.observe('turn-A', 1_020)).toBe(true);
    // Retirement is explicit: the worker drains/revalidates, then clears the
    // candidate. Merely reaching the deadline does not forget it by itself.
    expect(watchdog.observe(undefined, 1_021)).toBe(false);
    expect(watchdog.observe('turn-A', 1_021)).toBe(false);
  });

  it('resets on output/activity identity changes, a successor, or stop', () => {
    const watchdog = new StructuredMissingFinalWatchdog(20);
    watchdog.observe('turn-A/output-1', 0);
    expect(watchdog.observe('turn-A/output-2', 19)).toBe(false);
    expect(watchdog.observe('turn-A/output-2', 39)).toBe(true);
    watchdog.observe('turn-B/output-2', 40);
    expect(watchdog.observe('turn-A/output-2', 1_000)).toBe(false);
    watchdog.observe(undefined, 1_001);
    expect(watchdog.observe('turn-A/output-2', 1_001)).toBe(false);
  });
});
