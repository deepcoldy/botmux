import { describe, expect, it } from 'bun:test';
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

  it('does NOT merge same-named bots with different app_ids (fail-open guard)', () => {
    // app_id-form @s have no open/user/union id; keys are re-numbered per message
    // (@_user_1…), so keying on key+name would fold two distinct bots into one
    // and silently drop the second (its participant vanishes from the turn).
    const merged = mergeMessageMentions(
      [{ key: '@_user_1', name: 'Codex', appId: 'cli_self' }],
      [{ key: '@_user_1', name: 'Codex', appId: 'cli_other' }],
    );
    expect(merged).toHaveLength(2);
    expect(merged!.map(m => m.appId).sort()).toEqual(['cli_other', 'cli_self']);
  });

  it('preserves appId when enriching an app_id-keyed mention across seed/follow-up', () => {
    // Both key on app:cli_peer (no open/user/union id); the follow-up adds a name.
    const merged = mergeMessageMentions(
      [{ key: '@_user_1', name: '', appId: 'cli_peer' }],
      [{ key: '@_user_2', name: 'Peer', appId: 'cli_peer' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged![0].appId).toBe('cli_peer');
  });
});
