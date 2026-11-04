import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedbackAnalyticsQuery, feedbackDateRange } from '../src/dashboard/web/feedback-filters.js';

describe('feedback calendar filters', () => {
  beforeEach(() => vi.stubEnv('TZ', 'Asia/Shanghai'));
  afterEach(() => vi.unstubAllEnvs());

  it('includes both selected local dates and encodes the bot filter', () => {
    const query = feedbackAnalyticsQuery({ fromDate: '2026-10-27', toDate: '2026-10-27', botAppId: 'app & one' });
    expect(query.get('from')).toBe('2026-10-26T16:00:00.000Z');
    expect(query.get('to')).toBe('2026-10-27T16:00:00.000Z');
    expect(new URLSearchParams(query.toString()).get('bot')).toBe('app & one');
    expect(feedbackAnalyticsQuery({ fromDate: '2026-10-27', toDate: '2026-10-28', botAppId: '' }).has('bot')).toBe(false);
  });

  it('builds today and recent calendar-day presets across month and year boundaries', () => {
    const now = new Date('2026-01-02T12:00:00+08:00');
    expect(feedbackDateRange(1, now)).toEqual({ fromDate: '2026-01-02', toDate: '2026-01-02' });
    expect(feedbackDateRange(7, now)).toEqual({ fromDate: '2025-12-27', toDate: '2026-01-02' });
    expect(feedbackDateRange(30, now)).toEqual({ fromDate: '2025-12-04', toDate: '2026-01-02' });
  });

  it('rejects missing, impossible, reversed and overly broad ranges before fetching', () => {
    for (const [fromDate, toDate] of [['', '2026-10-27'], ['2026-02-30', '2026-03-01'], ['2026-10-28', '2026-10-27'], ['2026-10-27', 'bad']]) {
      expect(() => feedbackAnalyticsQuery({ fromDate: fromDate!, toDate: toDate!, botAppId: '' })).toThrow('feedback.invalidRange');
    }
    expect(() => feedbackAnalyticsQuery({ fromDate: '2025-01-01', toDate: '2026-01-01', botAppId: '' })).not.toThrow();
    expect(() => feedbackAnalyticsQuery({ fromDate: '2025-01-01', toDate: '2026-01-02', botAppId: '' })).toThrow('feedback.rangeTooLarge');
  });

  it('keeps local calendar boundaries on both DST transition days', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const spring = feedbackAnalyticsQuery({ fromDate: '2026-03-08', toDate: '2026-03-08', botAppId: '' });
    expect(spring.get('from')).toBe('2026-03-08T05:00:00.000Z');
    expect(spring.get('to')).toBe('2026-03-09T04:00:00.000Z');
    const fall = feedbackAnalyticsQuery({ fromDate: '2026-11-01', toDate: '2026-11-01', botAppId: '' });
    expect(fall.get('from')).toBe('2026-11-01T04:00:00.000Z');
    expect(fall.get('to')).toBe('2026-11-02T05:00:00.000Z');
  });
});
