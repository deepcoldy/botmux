import { describe, expect, it } from 'vitest';
import {
  bindResourcesToMessage,
  composeForwardFollowupContent,
  mergeMessageMentions,
} from '../src/im/lark/forward-followup-content.js';

describe('forward follow-up content', () => {
  it('keeps forwarded context before the later user request', () => {
    expect(composeForwardFollowupContent('慢查询报告内容', '分析它从哪里来的')).toBe(
      '<forwarded_context>\n慢查询报告内容\n</forwarded_context>\n\n' +
      '<user_request>\n分析它从哪里来的\n</user_request>',
    );
  });

  it('falls back cleanly when one side is empty', () => {
    expect(composeForwardFollowupContent('', '只保留请求')).toBe('只保留请求');
    expect(composeForwardFollowupContent('只保留转发', '')).toBe('只保留转发');
  });

  it('binds seed resources to the seed message without overwriting explicit ids', () => {
    expect(bindResourcesToMessage([
      { type: 'image', key: 'img-1', name: 'img-1.jpg' },
      { type: 'file', key: 'file-1', name: 'a.txt', messageId: 'nested-message' },
    ], 'seed-message')).toEqual([
      { type: 'image', key: 'img-1', name: 'img-1.jpg', messageId: 'seed-message' },
      { type: 'file', key: 'file-1', name: 'a.txt', messageId: 'nested-message' },
    ]);
  });

  it('merges mention metadata and deduplicates the same identity', () => {
    expect(mergeMessageMentions(
      [{ key: '@seed', name: 'Bot A', openId: 'ou_a' }],
      [
        { key: '@followup', name: 'Bot A', openId: 'ou_a', unionId: 'on_a' },
        { key: '@user', name: 'User B', openId: 'ou_b' },
      ],
    )).toEqual([
      { key: '@seed', name: 'Bot A', openId: 'ou_a', unionId: 'on_a' },
      { key: '@user', name: 'User B', openId: 'ou_b' },
    ]);
  });
});
