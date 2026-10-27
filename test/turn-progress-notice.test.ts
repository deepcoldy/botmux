import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROGRESS_NOTICE_MINUTES,
  TurnProgressNotice,
  progressNoticeIntervalMinutes,
} from '../src/utils/turn-progress-notice.js';

describe('progress notice interval', () => {
  it('defaults when unset and honours an explicit value', () => {
    expect(progressNoticeIntervalMinutes({})).toBe(DEFAULT_PROGRESS_NOTICE_MINUTES);
    expect(progressNoticeIntervalMinutes({ BOTMUX_PROGRESS_NOTICE_MINUTES: '12' })).toBe(12);
    // 0 is an explicit opt-out, not a fallback case.
    expect(progressNoticeIntervalMinutes({ BOTMUX_PROGRESS_NOTICE_MINUTES: '0' })).toBe(0);
    // Garbage must not silently disable the safety net.
    expect(progressNoticeIntervalMinutes({ BOTMUX_PROGRESS_NOTICE_MINUTES: 'soon' })).toBe(DEFAULT_PROGRESS_NOTICE_MINUTES);
    expect(progressNoticeIntervalMinutes({ BOTMUX_PROGRESS_NOTICE_MINUTES: '-3' })).toBe(DEFAULT_PROGRESS_NOTICE_MINUTES);
  });
});

describe('TurnProgressNotice', () => {
  it('stays quiet until one full interval of unbroken work has passed', () => {
    const notice = new TurnProgressNotice(5);
    expect(notice.poll(true, 0)).toBeNull();          // first poll only starts the clock
    expect(notice.poll(true, 4 * 60_000)).toBeNull(); // 4 minutes: too early
    expect(notice.poll(true, 5 * 60_000)).toBe(5);    // due, reports whole minutes
    expect(notice.poll(true, 9 * 60_000)).toBeNull(); // not again before the next interval
    expect(notice.poll(true, 10 * 60_000)).toBe(10);
  });

  it('resets on idle so only a continuous stretch is reported', () => {
    const notice = new TurnProgressNotice(5);
    notice.poll(true, 0);
    expect(notice.poll(false, 4 * 60_000)).toBeNull();
    // Back to work: the clock restarts rather than resuming the old stretch.
    expect(notice.poll(true, 4 * 60_000)).toBeNull();
    expect(notice.poll(true, 8 * 60_000)).toBeNull();
    expect(notice.poll(true, 9 * 60_000)).toBe(5);
  });

  it('is fully disabled at zero minutes', () => {
    const notice = new TurnProgressNotice(0);
    expect(notice.poll(true, 0)).toBeNull();
    expect(notice.poll(true, 60 * 60_000)).toBeNull();
  });

  it('never reports less than a minute even on a coarse clock', () => {
    const notice = new TurnProgressNotice(0.01);
    notice.poll(true, 0);
    expect(notice.poll(true, 1_000)).toBe(1);
  });
});
