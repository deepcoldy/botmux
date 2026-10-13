import { describe, expect, it } from 'vitest';
import {
  hasScheduleTopicTitleRuntimeTemplate,
  renderScheduleTopicTitle,
} from '../src/core/schedule-topic-title.js';

describe('renderScheduleTopicTitle', () => {
  const firedAt = new Date(2026, 0, 1, 0, 5, 0);

  it('keeps literal titles unchanged', () => {
    expect(renderScheduleTopicTitle('每日发布巡检', { firedAt })).toBe('每日发布巡检');
  });

  it('renders local fire date and bounded calendar-day offsets', () => {
    expect(renderScheduleTopicTitle('{{date}} 日报', { firedAt })).toBe('2026-01-01 日报');
    expect(renderScheduleTopicTitle('{{date:-1d}} 日报', { firedAt })).toBe('2025-12-31 日报');
    expect(renderScheduleTopicTitle('{{date:+2d}} 日报', { firedAt })).toBe('2026-01-03 日报');
  });

  it('renders the task owner as a native text-message mention', () => {
    expect(renderScheduleTopicTitle(
      '{{date:-1d}} 工作总结（00:00-24:00） {{owner}}',
      { firedAt, ownerOpenId: 'ou_owner123' },
    )).toBe(
      '2025-12-31 工作总结（00:00-24:00） <at user_id="ou_owner123"></at>',
    );
    expect(renderScheduleTopicTitle('{{owner}}', { firedAt, ownerOpenId: 'ou_a_b-c' }))
      .toBe('<at user_id="ou_a_b-c"></at>');
  });

  it('fails closed when owner or date offset cannot be rendered safely', () => {
    expect(() => renderScheduleTopicTitle('{{owner}}', { firedAt }))
      .toThrow('topic_title_owner_unavailable');
    expect(() => renderScheduleTopicTitle('{{owner}}', { firedAt, ownerOpenId: 'not-open-id' }))
      .toThrow('topic_title_owner_unavailable');
    expect(() => renderScheduleTopicTitle('{{date:-367d}}', { firedAt }))
      .toThrow('topic_title_date_offset_invalid');
  });

  it('keeps unknown placeholders literal for backwards compatibility', () => {
    expect(renderScheduleTopicTitle('{{service}} 巡检', { firedAt })).toBe('{{service}} 巡检');
    expect(renderScheduleTopicTitle('{{date:1d}} 日报', { firedAt })).toBe('{{date:1d}} 日报');
  });

  it('detects only the documented runtime placeholders', () => {
    expect(hasScheduleTopicTitleRuntimeTemplate('{{date}} {{date:-1d}} {{owner}}')).toBe(true);
    expect(hasScheduleTopicTitleRuntimeTemplate('{{date:1d}} {{service}}')).toBe(false);
  });

  it('checks the rendered title length after owner expansion', () => {
    expect(() => renderScheduleTopicTitle(
      `${'x'.repeat(180)}{{owner}}`,
      { firedAt, ownerOpenId: 'ou_owner1234567890' },
    )).toThrow('topic_title_rendered_too_long');
  });
});
