/**
 * §6.1 item 7 as a pure rule (review P2-3): a reply inside a node topic must
 * reach the executing bot as its own topic session. Normal-group bots whose
 * reply mode folds native topics into the group session (`chat` / `shared`)
 * can never run or submit a node there.
 */

import { describe, expect, it } from 'vitest';

import { v3OpensTopicSessions } from '../src/workflows/v3/node-executor-mode.js';

describe('v3OpensTopicSessions', () => {
  it.each([
    ['topic chat, any mode', 'topic', { regularGroupReplyMode: 'chat' }, 'yes'],
    ['normal group, chat-topic', 'group', { regularGroupReplyMode: 'chat-topic' }, 'yes'],
    ['normal group, new-topic', 'group', { regularGroupReplyMode: 'new-topic' }, 'yes'],
    ['normal group, default (chat-topic)', 'group', {}, 'yes'],
    ['normal group, chat', 'group', { regularGroupReplyMode: 'chat' }, 'no'],
    ['normal group, shared', 'group', { regularGroupReplyMode: 'shared' }, 'no'],
    ['normal group, per-chat override folds', 'group', { regularGroupReplyMode: 'new-topic', chatReplyModes: { oc_1: 'shared' } }, 'no'],
    ['normal group, per-chat override keeps topics', 'group', { regularGroupReplyMode: 'chat', chatReplyModes: { oc_1: 'chat-topic' } }, 'yes'],
  ] as const)('%s → %s', (_label, chatMode, config, expected) => {
    expect(v3OpensTopicSessions(chatMode, config, 'oc_1')).toBe(expected);
  });

  it('an unknown chat mode is unknown, never assumed', () => {
    expect(v3OpensTopicSessions('unknown', {}, 'oc_1')).toEqual({ unknown: expect.any(String) });
  });
});
