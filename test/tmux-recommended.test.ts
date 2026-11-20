import { describe, expect, it } from 'vitest';
import {
  TMUX_RECOMMENDED_MIN,
  compareTmuxRelease,
  isTmuxBelowRecommended,
  parseTmuxRelease,
  tmuxRecommendationWarning,
  tmuxReleaseLabel,
  type TmuxRecommendation,
} from '../src/setup/tmux-recommended.js';

/** A recommendation one minor above / at / below `version`, built from the
 *  live constant so the tests follow a future bump instead of pinning it. */
function relative(minorDelta: number, suffix = ''): string {
  const min = parseTmuxRelease(TMUX_RECOMMENDED_MIN.version)!;
  return `${min.major}.${min.minor + minorDelta}${suffix}`;
}

describe('tmux release parsing', () => {
  it('reads `tmux -V` output, bare versions and dev builds', () => {
    expect(parseTmuxRelease('tmux 3.3a')).toEqual({ major: 3, minor: 3, suffix: 'a' });
    expect(parseTmuxRelease('tmux 2.8\n')).toEqual({ major: 2, minor: 8, suffix: '' });
    expect(parseTmuxRelease('3.5a-2~bpo12+1')).toEqual({ major: 3, minor: 5, suffix: 'a' });
    expect(parseTmuxRelease('tmux next-3.7')).toEqual({ major: 3, minor: 7, suffix: '' });
    expect(parseTmuxRelease('3.3a_git20230428')).toEqual({ major: 3, minor: 3, suffix: 'a' });
    expect(parseTmuxRelease('tmux master')).toBeNull();
    expect(parseTmuxRelease(undefined)).toBeNull();
    expect(tmuxReleaseLabel('tmux 3.6b')).toBe('3.6b');
  });

  it('orders point releases by their letter suffix', () => {
    const order = ['2.8', '3.3', '3.3a', '3.3b', '3.4', '3.10'];
    for (let i = 0; i < order.length - 1; i++) {
      expect(compareTmuxRelease(parseTmuxRelease(order[i])!, parseTmuxRelease(order[i + 1])!)).toBe(-1);
      expect(compareTmuxRelease(parseTmuxRelease(order[i + 1])!, parseTmuxRelease(order[i])!)).toBe(1);
    }
    expect(compareTmuxRelease(parseTmuxRelease('3.5a')!, parseTmuxRelease('tmux 3.5a')!)).toBe(0);
  });
});

describe('below the recommended version', () => {
  it('is true strictly below the recommendation, false at or above it', () => {
    expect(isTmuxBelowRecommended(`tmux ${relative(-1)}`)).toBe(true);
    expect(isTmuxBelowRecommended(`tmux ${relative(-1, 'a')}`)).toBe(true);
    expect(isTmuxBelowRecommended(`tmux ${TMUX_RECOMMENDED_MIN.version}`)).toBe(false);
    expect(isTmuxBelowRecommended(`tmux ${relative(1)}`)).toBe(false);
    expect(isTmuxBelowRecommended('tmux 2.8')).toBe(true);
  });

  it('never calls an unreadable version too old', () => {
    expect(isTmuxBelowRecommended(null)).toBe(false);
    expect(isTmuxBelowRecommended('tmux master')).toBe(false);
    expect(isTmuxBelowRecommended('')).toBe(false);
  });

  it('respects a letter-suffixed recommendation (e.g. a future 3.5a bar)', () => {
    const rec: TmuxRecommendation = { version: '3.5a', why: { zh: 'x', en: 'x' } };
    expect(isTmuxBelowRecommended('tmux 3.5', rec)).toBe(true);
    expect(isTmuxBelowRecommended('tmux 3.5a', rec)).toBe(false);
  });

  it('the setup/status warning appears only below the recommendation and carries both versions', () => {
    const low = `tmux ${relative(-1, 'a')}`;
    const zh = tmuxRecommendationWarning(low, 'zh');
    expect(zh).toContain(relative(-1, 'a'));
    expect(zh).toContain(TMUX_RECOMMENDED_MIN.version);
    expect(zh).toContain(TMUX_RECOMMENDED_MIN.why.zh);
    expect(tmuxRecommendationWarning(low, 'en')).toContain(TMUX_RECOMMENDED_MIN.why.en);
    expect(tmuxRecommendationWarning(`tmux ${TMUX_RECOMMENDED_MIN.version}`, 'zh')).toBeNull();
    expect(tmuxRecommendationWarning(undefined, 'zh')).toBeNull();
  });
});
