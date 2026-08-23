/**
 * Unit tests for StuckDetector.
 *
 * Covers arm/disarm, timeout firing, isActuallyStuck gating, pattern matching
 * (level 1 hooks browser + level 2 per-hook review, using official Codex TUI
 * snapshots), dispose, and re-arming behavior.
 *
 * Run:  pnpm vitest run test/stuck-detector.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  StuckDetector,
  matchHookReviewScreen,
  shouldHoldInputForHookReview,
} from '../src/utils/stuck-detector.js';

// Official Codex TUI snapshots read from fixture files (not inline constants)
// so the classifier is tested against the real on-disk representation.
const FIXTURES = join(__dirname, 'fixtures');
const LEVEL_1_SNAPSHOT = readFileSync(join(FIXTURES, 'codex-hooks-browser-level1.snap'), 'utf-8');
const LEVEL_2_SNAPSHOT = readFileSync(join(FIXTURES, 'codex-hooks-browser-level2.snap'), 'utf-8');
const STARTUP_HOOKS_REVIEW_SNAPSHOT = readFileSync(
  join(FIXTURES, 'codex-startup-hooks-review-rust-v0.147.0.snap'),
  'utf-8',
);

describe('StuckDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onStuck after timeout when isActuallyStuck returns true (level 1)', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => LEVEL_1_SNAPSHOT,
    });

    detector.arm();
    vi.advanceTimersByTime(1000);

    expect(onStuck).toHaveBeenCalledTimes(1);
    const [elapsedMs, matchedLabel] = onStuck.mock.calls[0];
    expect(elapsedMs).toBeGreaterThanOrEqual(1000);
    expect(matchedLabel).toBe('hook review level 1');
    detector.dispose();
  });

  it('fires onStuck for level 2 per-hook review screen', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => LEVEL_2_SNAPSHOT,
    });

    detector.arm();
    vi.advanceTimersByTime(1000);

    expect(onStuck).toHaveBeenCalledTimes(1);
    expect(onStuck.mock.calls[0][1]).toBe('hook review level 2');
    detector.dispose();
  });

  it('does not fire when isActuallyStuck returns false', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => false,
      onStuck,
      getSnapshot: () => LEVEL_1_SNAPSHOT,
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
      getSnapshot: () => LEVEL_1_SNAPSHOT,
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
      getSnapshot: () => LEVEL_1_SNAPSHOT,
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
      getSnapshot: () => LEVEL_1_SNAPSHOT,
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

  it('silently re-arms when snapshot does not match hook-review (no false warning)', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => 'Proceed? [Y/n]\nPress space or enter to toggle',
    });

    detector.arm();
    // First tick: isActuallyStuck=true but no pattern match → silently re-arms
    vi.advanceTimersByTime(1000);
    expect(onStuck).not.toHaveBeenCalled();

    // Second tick: still no match → still no warning
    vi.advanceTimersByTime(1000);
    expect(onStuck).not.toHaveBeenCalled();
    detector.dispose();
  });

  it.each([
    ['ordinary chat quoting the title', 'I am investigating PreToolUse hooks today.'],
    ['pasted incident text without controls', 'PreToolUse hooks\n1 hook needs review before it can run.'],
    ['level 1 control hint without title and pending state', 'Press t to trust all; enter to review hooks; esc to close'],
    ['level 2 control hint without title and pending state', 'Press t to trust; esc to go back'],
    ['mixed: level 2 title with level 1 controls (does not exist in real UI)', 'PreToolUse hooks\n1 hook needs review before it can run.\nPress t to trust all; enter to review hooks; esc to close'],
    ['mixed: level 1 title with level 2 controls (does not exist in real UI)', 'Hooks\n1 hook needs review before it can run.\nPress t to trust; esc to go back'],
  ])('does not fire for %s', (_name, snapshot) => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => snapshot,
    });

    detector.arm();
    vi.advanceTimersByTime(1000);

    expect(onStuck).not.toHaveBeenCalled();
    detector.dispose();
  });

  it('dispose prevents any further firing', () => {
    const onStuck = vi.fn();
    const detector = new StuckDetector(1000, {
      isActuallyStuck: () => true,
      onStuck,
      getSnapshot: () => LEVEL_1_SNAPSHOT,
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
      getSnapshot: () => LEVEL_1_SNAPSHOT,
    });

    detector.arm();
    vi.advanceTimersByTime(1000);
    // Advance more time without re-arming — should NOT fire again
    vi.advanceTimersByTime(5000);

    expect(onStuck).toHaveBeenCalledTimes(1);
    detector.dispose();
  });
});

describe('shouldHoldInputForHookReview', () => {
  it('holds input on the official Codex startup review snapshot so Enter cannot trust all', () => {
    expect(shouldHoldInputForHookReview(STARTUP_HOOKS_REVIEW_SNAPSHOT)).toBe(true);
  });

  it('accepts the singular count and a selection arrow on any option', () => {
    const singularWithThirdSelected = STARTUP_HOOKS_REVIEW_SNAPSHOT
      .replace('2 hooks are new or changed.', '1 hook is new or changed.')
      .replace('› 1. Review hooks', '  1. Review hooks')
      .replace('  3. Continue without trusting (hooks won\'t run)', '› 3. Continue without trusting (hooks won\'t run)');
    expect(shouldHoldInputForHookReview(singularWithThirdSelected)).toBe(true);
  });

  it('releases input on an ordinary Codex composer', () => {
    expect(shouldHoldInputForHookReview('› Ask Codex to do anything')).toBe(false);
  });

  it('does not mistake quoted startup-review text for an active menu', () => {
    expect(shouldHoldInputForHookReview(
      `The terminal printed:\n${STARTUP_HOOKS_REVIEW_SNAPSHOT}\n\n› Ask Codex to do anything`,
    )).toBe(false);
  });
});

describe('matchHookReviewScreen classifier (P1-3 footer anchoring + level binding)', () => {
  it('matches official level 1 snapshot', () => {
    expect(matchHookReviewScreen(LEVEL_1_SNAPSHOT)).toBe('hook review level 1');
  });

  it('matches official level 2 snapshot', () => {
    expect(matchHookReviewScreen(LEVEL_2_SNAPSHOT)).toBe('hook review level 2');
  });

  it('rejects when footer is not the last non-empty line (content below)', () => {
    const snap = LEVEL_1_SNAPSHOT + '\nSome output below the footer';
    expect(matchHookReviewScreen(snap)).toBeUndefined();
  });

  it('rejects when footer line contains extra text (not anchored ^...$)', () => {
    const snap = LEVEL_1_SNAPSHOT.replace(
      'Press t to trust all; enter to review hooks; esc to close',
      'The old footer said: Press t to trust all; enter to review hooks; esc to close',
    );
    expect(matchHookReviewScreen(snap)).toBeUndefined();
  });

  it('rejects L1 body paired with L2 footer (level-title binding)', () => {
    // Take the L1 body (title + table) but swap in the L2 footer.
    const snap = LEVEL_1_SNAPSHOT.replace(
      'Press t to trust all; enter to review hooks; esc to close',
      'Press t to trust; esc to go back',
    );
    expect(matchHookReviewScreen(snap)).toBeUndefined();
  });

  it('rejects L2 body paired with L1 footer (level-title binding)', () => {
    const snap = LEVEL_2_SNAPSHOT.replace(
      'Press t to trust; esc to go back',
      'Press t to trust all; enter to review hooks; esc to close',
    );
    expect(matchHookReviewScreen(snap)).toBeUndefined();
  });

  it('rejects ANSI-colorized footer that does not strip to exact match', () => {
    // If the footer line has trailing junk after ANSI stripping, it must not match.
    const snap = LEVEL_1_SNAPSHOT.replace(
      'Press t to trust all; enter to review hooks; esc to close',
      '\x1b[32mPress t to trust all; enter to review hooks; esc to close\x1b[0m (more)',
    );
    expect(matchHookReviewScreen(snap)).toBeUndefined();
  });

  it('accepts ANSI-colorized footer that strips to exact match', () => {
    const snap = LEVEL_1_SNAPSHOT.replace(
      'Press t to trust all; enter to review hooks; esc to close',
      '\x1b[32mPress t to trust all; enter to review hooks; esc to close\x1b[0m',
    );
    expect(matchHookReviewScreen(snap)).toBe('hook review level 1');
  });

  it('strips \\r from lines', () => {
    const snap = LEVEL_1_SNAPSHOT.replace(/\n/g, '\r\n');
    expect(matchHookReviewScreen(snap)).toBe('hook review level 1');
  });
});
