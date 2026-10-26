import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoCompactCoordinator } from '../src/core/auto-compact.js';

describe('AutoCompactCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces an over-threshold idle session and rechecks before firing', () => {
    let percent = 76;
    let eligible = true;
    const trigger = vi.fn(() => true);
    const coordinator = new AutoCompactCoordinator(5_000, 600_000, () => Date.now());
    const observation = {
      sessionId: 's1', idle: true, threshold: 75,
      readPercent: () => percent,
      eligible: () => eligible,
      trigger,
    };

    coordinator.observe(observation);
    vi.advanceTimersByTime(4_999);
    expect(trigger).not.toHaveBeenCalled();
    percent = 74;
    vi.advanceTimersByTime(1);
    expect(trigger).not.toHaveBeenCalled();

    percent = 80;
    coordinator.observe(observation);
    eligible = false;
    vi.advanceTimersByTime(5_000);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('cancels on busy and applies a cooldown after dispatch', () => {
    const trigger = vi.fn(() => true);
    const coordinator = new AutoCompactCoordinator(1_000, 10_000, () => Date.now());
    const make = (idle: boolean, percent = 90) => ({
      sessionId: 's1', idle, threshold: 75,
      readPercent: () => percent,
      eligible: () => true,
      trigger,
    });

    coordinator.observe(make(true));
    coordinator.observe(make(false));
    vi.advanceTimersByTime(1_000);
    expect(trigger).not.toHaveBeenCalled();

    coordinator.observe(make(true));
    vi.advanceTimersByTime(1_000);
    expect(trigger).toHaveBeenCalledTimes(1);

    coordinator.observe(make(false));
    coordinator.observe(make(true));
    vi.advanceTimersByTime(1_000);
    expect(trigger).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(9_000);
    coordinator.observe(make(true));
    vi.advanceTimersByTime(1_000);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('clears cooldown state after context falls below threshold', () => {
    const trigger = vi.fn(() => true);
    const coordinator = new AutoCompactCoordinator(1_000, 60_000, () => Date.now());
    const observe = (percent: number) => coordinator.observe({
      sessionId: 's1', idle: true, threshold: 75,
      readPercent: () => percent,
      eligible: () => true,
      trigger,
    });

    observe(90);
    vi.advanceTimersByTime(1_000);
    observe(20);
    observe(90);
    vi.advanceTimersByTime(1_000);
    expect(trigger).toHaveBeenCalledTimes(2);
  });
});
