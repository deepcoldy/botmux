import { describe, expect, it } from 'vitest';
import { groupTaskForwardIds, groupTaskHasMedia, groupTaskPlaceholder, groupTaskPrompt, groupTaskPromptAttachments, groupTaskQuoteId, groupTaskSenderIsBot, startGroupTask } from '../src/core/group-task-start.js';

describe('groupTaskPlaceholder', () => {
  it('uses the first non-empty line and cuts by grapheme', () => {
    expect(groupTaskPlaceholder('\n  修复  购物车\n细节')).toBe('修复 购物车');
    expect(groupTaskPlaceholder('一二三四五六七八九十👍🏽', 10)).toBe('一二三四五六七八九十…');
    expect(groupTaskPlaceholder('👍🏽👍🏽👍🏽', 2)).toBe('👍🏽👍🏽…');
    expect(groupTaskPlaceholder('   ')).toBe('');
  });
});

describe('groupTaskForwardIds', () => {
  it('forwards the command only when it carries media, plus a real quote', () => {
    expect(groupTaskForwardIds({ messageId: 'om_cmd', msgType: 'text' })).toEqual([]);
    expect(groupTaskForwardIds({ messageId: 'om_cmd', msgType: 'text', parentId: 'om_q' })).toEqual(['om_q']);
    expect(groupTaskForwardIds({ messageId: 'om_cmd', msgType: 'image', parentId: 'om_q' })).toEqual(['om_cmd', 'om_q']);
  });
  it('reads post media from the raw content, not from downloaded attachments', () => {
    const withImage = JSON.stringify({ title: '', content: [[{ tag: 'text', text: '/g x' }, { tag: 'img', image_key: 'img_1' }]] });
    const textOnly = JSON.stringify({ title: '', content: [[{ tag: 'text', text: '/g x' }]] });
    expect(groupTaskHasMedia({ msgType: 'post', rawPostContent: withImage })).toBe(true);
    expect(groupTaskHasMedia({ msgType: 'post', rawPostContent: textOnly })).toBe(false);
    expect(groupTaskHasMedia({ msgType: 'file' })).toBe(true);
  });
});

describe('groupTaskPromptAttachments', () => {
  it('exposes rich-text file metadata before download', () => {
    const rawPostContent = JSON.stringify({ title: '', content: [[
      { tag: 'text', text: '/g --start inspect' },
      { tag: 'file', file_key: 'file_env', file_name: 'prod.env' },
    ]] });
    expect(groupTaskPromptAttachments({ msgType: 'post', rawPostContent }))
      .toEqual([{ type: 'file', name: 'prod.env' }]);
    expect(groupTaskPromptAttachments({ msgType: 'text' })).toEqual([]);
  });

  it('uses already materialized attachment metadata when supplied', () => {
    expect(groupTaskPromptAttachments({
      msgType: 'post', attachments: [{ type: 'image', name: 'shot.png' }],
    })).toEqual([{ type: 'image', name: 'shot.png' }]);
  });
});

describe('groupTaskSenderIsBot', () => {
  it('accepts Lark bot stamps and the learned-peer fallback, never a human lookalike', () => {
    expect(groupTaskSenderIsBot({ senderType: 'app', senderId: 'ou_bot' }, 'ou_self', false)).toBe(true);
    expect(groupTaskSenderIsBot({ senderType: 'bot', senderId: 'ou_bot' }, 'ou_self', false)).toBe(true);
    expect(groupTaskSenderIsBot({ senderType: 'user', senderId: 'ou_peer' }, 'ou_self', true)).toBe(true);
    expect(groupTaskSenderIsBot({ senderType: 'user', senderId: 'ou_human' }, 'ou_self', false)).toBe(false);
    expect(groupTaskSenderIsBot({ senderType: 'user', senderId: 'ou_self' }, 'ou_self', true)).toBe(false);
  });
});

describe('groupTaskQuoteId', () => {
  it('ignores the topic root Lark puts in parent_id inside a topic', () => {
    expect(groupTaskQuoteId({ messageId: 'om_cmd', threadId: 'omt_1', rootId: 'om_root', parentId: 'om_root' })).toBeUndefined();
    expect(groupTaskQuoteId({ messageId: 'om_cmd', threadId: 'omt_1', rootId: 'om_root', parentId: 'om_q' })).toBe('om_q');
    expect(groupTaskQuoteId({ messageId: 'om_cmd', rootId: 'om_root', parentId: 'om_root' })).toBe('om_root');
    expect(groupTaskQuoteId({ messageId: 'om_cmd', parentId: 'om_cmd' })).toBeUndefined();
  });
});

describe('groupTaskPrompt', () => {
  const base = { chatId: 'oc_src', messageId: 'om_cmd', task: '修复价格\n第二行' };
  it('carries the user words and every available locator', () => {
    const prompt = groupTaskPrompt({ ...base, chatName: 'Team', threadId: 'omt_1', rootId: 'om_root', parentId: 'om_q' }, 'zh');
    for (const part of ['修复价格\n第二行', 'oc_src', 'Team', 'om_cmd', 'omt_1', 'om_root', 'om_q']) expect(prompt).toContain(part);
  });
  it('omits thread lines outside threads and marks quote-only tasks', () => {
    const prompt = groupTaskPrompt({ ...base, task: '', rootId: 'om_root', chatType: 'p2p' }, 'en');
    expect(prompt).not.toContain('om_root');
    expect(prompt).toContain('oc_src');
    expect(prompt.split('\n').length).toBe(5);
  });
});

describe('startGroupTask', () => {
  it('forwards before starting and still starts when a forward fails', async () => {
    const calls: string[] = [];
    const result = await startGroupTask('oc_new', ['om_a', 'om_b'], 'PROMPT', {
      forward: async id => { calls.push(`fwd:${id}`); if (id === 'om_a') throw new Error('denied'); },
      startSession: async (chatId, prompt) => { calls.push(`start:${chatId}:${prompt}`); return { ok: true }; },
    });
    expect(calls).toEqual(['fwd:om_a', 'fwd:om_b', 'start:oc_new:PROMPT']);
    expect(result).toEqual({ forwardFailed: ['om_a'] });
  });
  it('reports a refused or throwing start without throwing', async () => {
    const refused = await startGroupTask('oc_new', [], 'P', {
      forward: async () => undefined,
      startSession: async () => ({ ok: false, error: 'session_exists' }),
    });
    expect(refused.startError).toBe('session_exists');
    const thrown = await startGroupTask('oc_new', [], 'P', {
      forward: async () => undefined,
      startSession: async () => { throw new Error('boom'); },
    });
    expect(thrown.startError).toBe('boom');
  });
});
