// test/screen-analyzer.test.ts
//
// stripOptionalSurveyLines: the resident survey banner ("How is Claude doing
// this session?") must be removed line-wise from snapshots. Whole-snapshot
// survey matching used to veto every analysis while the banner was on screen,
// which blinded the analyzer to real prompts (AskUserQuestion + survey 同屏
// 被整屏误吞 — 2026-06-05 用户演示「需要你」状态时踩到).
import { describe, expect, it } from 'vitest';
import { stripOptionalSurveyLines } from '../src/utils/screen-analyzer.js';

describe('stripOptionalSurveyLines', () => {
  it('returns snapshots without a survey untouched', () => {
    const snap = 'some output\n❯ 1. Yes\n  2. No\nEnter to confirm';
    expect(stripOptionalSurveyLines(snap)).toBe(snap);
  });

  it('drops the survey line and its option row', () => {
    const snap = [
      'assistant output',
      'How is Claude doing this session? (optional)',
      '1: Bad · 2: Fine · 3: Great · 0: Dismiss',
      '❯ type your message',
    ].join('\n');
    expect(stripOptionalSurveyLines(snap)).toBe('assistant output\n❯ type your message');
  });

  it('keeps a real prompt that shares the screen with the survey', () => {
    const snap = [
      'PR 怎么切？',
      '❯ 1. 一个 PR 两个 commit',
      '  2. 拆两个 PR',
      '  3. 先不提 PR',
      'Enter to confirm · Esc to cancel',
      'How is Claude doing this session? (optional)',
      '1: Bad · 2: Fine · 3: Great · 0: Dismiss',
    ].join('\n');
    const out = stripOptionalSurveyLines(snap);
    expect(out).toContain('❯ 1. 一个 PR 两个 commit');
    expect(out).toContain('3. 先不提 PR');
    expect(out).not.toMatch(/how is claude doing/i);
    expect(out).not.toContain('0: Dismiss');
  });

  it('handles a survey banner on the last line (no option row after it)', () => {
    const snap = 'output\nHow is Claude doing this session?';
    expect(stripOptionalSurveyLines(snap)).toBe('output');
  });
});
