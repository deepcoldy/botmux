import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoCompactCoordinator,
  isAutoCompactEligible,
  type AutoCompactEligibilitySnapshot,
} from '../src/core/auto-compact.js';

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
      readThreshold: () => 75,
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
      readThreshold: () => 75,
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
      readThreshold: () => 75,
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

  it('rechecks the live switch and threshold before firing', () => {
    let threshold: number | undefined = 75;
    const trigger = vi.fn(() => true);
    const coordinator = new AutoCompactCoordinator(1_000, 60_000, () => Date.now());
    const observation = {
      sessionId: 's1', idle: true, threshold: 75,
      readThreshold: () => threshold,
      readPercent: () => 80,
      eligible: () => true,
      trigger,
    };

    coordinator.observe(observation);
    threshold = undefined;
    vi.advanceTimersByTime(1_000);
    expect(trigger).not.toHaveBeenCalled();

    threshold = 75;
    coordinator.observe(observation);
    threshold = 85;
    vi.advanceTimersByTime(1_000);
    expect(trigger).not.toHaveBeenCalled();

    coordinator.observe({ ...observation, threshold: 85, readPercent: () => 90 });
    vi.advanceTimersByTime(1_000);
    expect(trigger).toHaveBeenCalledWith(85);
  });
});

describe('isAutoCompactEligible', () => {
  const eligible: AutoCompactEligibilitySnapshot = {
    sessionActive: true,
    workerAlive: true,
    workerReady: true,
    cliReady: true,
    idle: true,
    streamCardSettled: true,
    transferring: false,
    protectedMutation: false,
    pendingTurns: false,
    pendingPrompt: false,
    pendingRawInput: false,
    pendingFollowUpInput: false,
    queuedActivationCount: 0,
    cascadeInFlight: false,
    usageLimited: false,
    agentAttention: false,
    finalDeliveriesInFlight: 0,
    adopted: false,
    headless: false,
    vcMeetingReceiver: false,
    remoteRunner: false,
    supportsCompact: true,
  };

  it('admits only the fully idle local session', () => {
    expect(isAutoCompactEligible(eligible)).toBe(true);
  });

  it.each([
    ['sessionActive', false],
    ['workerAlive', false],
    ['workerReady', false],
    ['cliReady', false],
    ['idle', false],
    ['streamCardSettled', false],
    ['transferring', true],
    ['protectedMutation', true],
    ['pendingTurns', true],
    ['pendingPrompt', true],
    ['pendingRawInput', true],
    ['pendingFollowUpInput', true],
    ['queuedActivationCount', 1],
    ['cascadeInFlight', true],
    ['usageLimited', true],
    ['agentAttention', true],
    ['finalDeliveriesInFlight', 1],
    ['adopted', true],
    ['headless', true],
    ['vcMeetingReceiver', true],
    ['remoteRunner', true],
    ['supportsCompact', false],
  ] satisfies Array<[keyof AutoCompactEligibilitySnapshot, boolean | number]>) (
    'rejects when %s is %s',
    (key, value) => {
      expect(isAutoCompactEligible({ ...eligible, [key]: value })).toBe(false);
    },
  );
});
