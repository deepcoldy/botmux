/**
 * Unit tests for StuckDetector.
 *
 * Covers arm/disarm, timeout firing, isActuallyStuck gating, pattern matching,
 * dispose, and re-arming behavior.
 *
 * Run:  pnpm vitest run test/stuck-detector.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StuckDetector } from '../src/utils/stuck-detector.js';

describe('StuckDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onStuck after timeout when isActuallyStuck returns true', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => '',
    });

    detector.arm();
    vi.advanceTimersByTime(1000);

    expect(onStuck).toHaveBeenCalledTimes(1);
    const [elapsedMs, matchedLabel] = onStuck.mock.calls[0];
    expect(elapsedMs).toBeGreaterThanOrEqual(1000);
    expect(matchedLabel).toBeUndefined();
    detector.dispose();
  });

  it('does not fire when isActuallyStuck returns false', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => false,
      onStuck,
      getSnapshot: () => '',
    });

    detector.arm();
    vi.advanceTimersByTime(1000);

    expect(onStuck).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('re-arms when isActuallyStuck returns false', () => {
    let stuck = false;
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => stuck,
      onStuck,
      getSnapshot: () => '',
    });

    detector.arm();
    // First tick: not stuck → re-arms
    vi.advanceTimersByTime(1000);
    expect(onStuck).not.toHaveBeenCalled();

    // Second tick: now stuck → fires
    stuck = true;
    vi.advanceTimersByTime(1000);
    expect(onStuck).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it('disarm cancels the pending timer', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => '',
    });

    detector.arm();
    detector.disarm();
    vi.advanceTimersByTime(2000);

    expect(onStuck).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('arm resets the firedThisWindow flag so a new window can fire', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => '',
    });

    detector.arm();
    vi.advanceTimersByTime(1000);
    expect(onStuck).toHaveBeenCalledTimes(1);

    // Re-arm without disarm (simulating a new write)
    detector.arm();
    vi.advanceTimersByTime(1000);
    expect(onStuck).toHaveBeenCalledTimes(2);
    detector.dispose();
  });

  it('passes matched pattern label when snapshot matches', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => 'PreToolUse hooks\n1 hook needs review before it can run.',
    });

    detector.arm();
    vi.advanceTimersByTime(1000);

    expect(onStuck).toHaveBeenCalledTimes(1);
    expect(onStuck.mock.calls[0][1]).toBe('hook review prompt');
    detector.dispose();
  });

  it('matches [Y/n] confirmation pattern', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => 'Proceed? [Y/n]',
    });

    detector.arm();
    vi.advanceTimersByTime(1000);

    expect(onStuck).toHaveBeenCalledTimes(1);
    expect(onStuck.mock.calls[0][1]).toBe('yes/no confirmation');
    detector.dispose();
  });

  it('matches Press ... to pattern', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => 'Press space or enter to toggle',
    });

    detector.arm();
    vi.advanceTimersByTime(1000);

    expect(onStuck).toHaveBeenCalledTimes(1);
    expect(onStuck.mock.calls[0][1]).toBe('key-press prompt');
    detector.dispose();
  });

  it('dispose prevents any further firing', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => '',
    });

    detector.arm();
    detector.dispose();
    vi.advanceTimersByTime(5000);

    expect(onStuck).not.toHaveBeenCalled();
  });

  it('does not fire twice within the same window', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => '',
    });

    detector.arm();
    vi.advanceTimersByTime(1000);
    // Advance more time without re-arming — should NOT fire again
    vi.advanceTimersByTime(5000);

    expect(onStuck).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});
