import { describe, expect, it } from 'vitest';
import {
  filterMentionBots,
  findMentionTrigger,
  insertBotMention,
  insertImageMarkers,
  removeAndReindexImageMarkers,
  removeImageMarker,
} from '../src/dashboard/web/create-session-composer.js';

const bots = [
  { larkAppId: 'cli_lead', botName: 'LeadBot' },
  { larkAppId: 'cli_reviewer', botName: '审核员(grok)' },
];

describe('create-session @ composer', () => {
  it('finds a mention at line start or after whitespace, but not inside email', () => {
    expect(findMentionTrigger('@审', 2)).toEqual({ start: 0, end: 2, query: '审' });
    expect(findMentionTrigger('请 @Lead', 7)).toEqual({ start: 2, end: 7, query: 'Lead' });
    expect(findMentionTrigger('a@Lead', 6)).toBeNull();
  });

  it('inserts the selected bot and returns the next caret position', () => {
    const result = insertBotMention('请 @审 完成', { start: 2, end: 4 }, '审核员(grok)');
    expect(result.text).toBe('请 @审核员(grok) 完成');
    expect(result.caret).toBe('请 @审核员(grok) '.length);
  });

  it('filters by display name or app id', () => {
    expect(filterMentionBots(bots, '审核')).toEqual([bots[1]]);
    expect(filterMentionBots(bots, 'cli_lead')).toEqual([bots[0]]);
  });

  it('inserts image markers at the textarea selection and returns the next caret', () => {
    expect(insertImageMarkers('前文后文', 2, 2, ['[图片 1]', '[图片 2]'])).toEqual({
      text: '前文 [图片 1] [图片 2] 后文',
      caret: '前文 [图片 1] [图片 2] '.length,
    });
    expect(insertImageMarkers('', 0, 0, ['[图片 1]'])).toEqual({ text: '[图片 1]', caret: 6 });
  });

  it('removes the matching image marker without joining surrounding words', () => {
    expect(removeImageMarker('前文 [图片 1] 后文', '[图片 1]')).toBe('前文 后文');
    expect(removeImageMarker('marker edited', '[图片 1]')).toBe('marker edited');
  });

  it('compacts remaining image markers after deleting from the middle', () => {
    expect(removeAndReindexImageMarkers(
      '[图片 1] 前 [图片 2] 中 [图片 3] 后',
      '[图片 2]',
      ['[图片 1]', '[图片 3]'],
      index => `[图片 ${index + 1}]`,
    )).toEqual({
      text: '[图片 1] 前 中 [图片 2] 后',
      markers: ['[图片 1]', '[图片 2]'],
    });
  });
});
