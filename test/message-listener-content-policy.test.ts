import { describe, expect, it } from 'bun:test';
import {
  evaluateMessageListener,
  matchesContentPolicy,
  previewMessageListenerMatches,
} from '../src/services/message-listener.js';

function bot(config: any = {}, botOpenId = 'ou_self'): any {
  return { botOpenId, config: { larkAppId: 'app_listener', ...config } };
}

function textMessage(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 'om_msg',
    chat_id: 'oc_chat',
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text: 'CPU 告警持续 5 分钟，ERROR 500' }),
    ...overrides,
  };
}

function listenerConfig(contentPolicy: unknown, extra: Record<string, unknown> = {}) {
  return {
    enabled: true,
    prompt: '判断是否需要响应告警',
    senderPolicy: { includeSenderOpenIds: ['ou_allowed'], includeSenderTypes: ['user'] },
    messagePolicy: { includeMsgTypes: ['text'], scope: 'top_level' },
    ...(contentPolicy ? { contentPolicy } : {}),
    ...extra,
  };
}

function evaluate(config: any, messageOverrides: Record<string, unknown> = {}, mention = false) {
  return evaluateMessageListener({
    bot: bot({ messageListeners: { oc_chat: config } }),
    chatId: 'oc_chat',
    message: textMessage(messageOverrides),
    senderOpenId: 'ou_allowed',
    senderTypeRaw: 'user',
    explicitlyMentionedThisBot: mention,
  });
}

describe('matchesContentPolicy', () => {
  it('matches everything when policy is absent or all-empty', () => {
    expect(matchesContentPolicy('任意文本', undefined)).toBe(true);
    expect(matchesContentPolicy('任意文本', {})).toBe(true);
    expect(matchesContentPolicy('任意文本', { includeKeywords: [] })).toBe(true);
  });

  it('matches keywords case-insensitively as substrings (Chinese-friendly)', () => {
    expect(matchesContentPolicy('CPU 告警持续 5 分钟', { includeKeywords: ['告警'] })).toBe(true);
    expect(matchesContentPolicy('CPU 告警持续 5 分钟', { includeKeywords: ['报警'] })).toBe(false);
    expect(matchesContentPolicy('ERROR 500', { includeKeywords: ['error'] })).toBe(true);
    expect(matchesContentPolicy('Error 500', { includeKeywords: ['ERROR'] })).toBe(true);
    expect(matchesContentPolicy('出报错了', { includeKeywords: ['报错'] })).toBe(true);
  });

  it('any mode (default): one keyword hit is enough', () => {
    expect(matchesContentPolicy('ERROR 500', { includeKeywords: ['不存在', '500'], matchMode: 'any' })).toBe(true);
    expect(matchesContentPolicy('plain text', { includeKeywords: ['nope', 'nada'], matchMode: 'any' })).toBe(false);
    // Default mode is 'any' when omitted.
    expect(matchesContentPolicy('ERROR 500', { includeKeywords: ['不存在', '500'] })).toBe(true);
  });

  it('all mode: every keyword must hit', () => {
    expect(matchesContentPolicy('ERROR 500', {
      includeKeywords: ['error', '500'],
      matchMode: 'all',
    })).toBe(true);
    expect(matchesContentPolicy('ERROR 500', {
      includeKeywords: ['error', '不存在'],
      matchMode: 'all',
    })).toBe(false);
  });

  it('V1 安全回归：regex 元字符按字面子串处理，对攻击文本不回溯、不挂起', () => {
    // `(a+)+$` 作为 JS 正则是典型 catastrophic-backtracking payload（~30 字符
    // 即可冻结主事件循环十几秒）。V1 只做子串匹配：它必须被当作普通字符串，
    // 对纯 a 序列不命中，且对超长输入立即返回。
    const evilLooking = '(a+)+$';
    expect(matchesContentPolicy('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!!', { includeKeywords: [evilLooking] })).toBe(false);
    // 字面出现时才命中（证明没有被当成正则，也没有被简单「忽略」）。
    expect(matchesContentPolicy('pattern is (a+)+$ here', { includeKeywords: [evilLooking] })).toBe(true);
    const huge = 'a'.repeat(100_000) + '!';
    const started = Date.now();
    expect(matchesContentPolicy(huge, { includeKeywords: [evilLooking] })).toBe(false);
    // 线性子串搜索：100KB 远低于 100ms；若退化成指数回溯会直接超时。
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('evaluateMessageListener contentPolicy integration', () => {
  it('matches when the keyword policy hits', () => {
    const match = evaluate(listenerConfig({ includeKeywords: ['告警'] }));
    expect(match).toMatchObject({ messageText: 'CPU 告警持续 5 分钟，ERROR 500' });
  });

  it('does not match when the keyword policy misses', () => {
    expect(evaluate(listenerConfig({ includeKeywords: ['磁盘满'] }))).toBeUndefined();
  });

  it('applies matchMode all across keywords', () => {
    expect(evaluate(listenerConfig({
      includeKeywords: ['告警', '500'],
      matchMode: 'all',
    }))).toBeDefined();
    expect(evaluate(listenerConfig({
      includeKeywords: ['告警', '磁盘满'],
      matchMode: 'all',
    }))).toBeUndefined();
  });

  it('keeps matching every message when contentPolicy is absent (legacy default)', () => {
    expect(evaluate(listenerConfig(undefined))).toBeDefined();
    expect(evaluate(listenerConfig(null))).toBeDefined();
    expect(evaluate(listenerConfig({ includeKeywords: [] }))).toBeDefined();
  });

  it('does not affect the @-mention path: mentioned messages never go through the listener', () => {
    // Even a message that WOULD be filtered out by contentPolicy is simply not a
    // listener candidate when it explicitly mentions this bot — it keeps using
    // the normal mention route, and the listener never sees it.
    expect(evaluate(listenerConfig({ includeKeywords: ['不可能出现的词'] }), {}, true)).toBeUndefined();
    expect(evaluate(listenerConfig({ includeKeywords: ['告警'] }), {}, true)).toBeUndefined();
  });

  it('shares the filter with the preview leg (previewMessageListenerMatches)', () => {
    const state = bot({
      messageListeners: {
        oc_chat: listenerConfig({ includeKeywords: ['告警'] }),
      },
    });
    const messages = [
      textMessage({ message_id: 'om_1', content: JSON.stringify({ text: '无关内容' }) }),
      textMessage({ message_id: 'om_2', content: JSON.stringify({ text: 'CPU 告警' }) }),
    ];
    const matches = previewMessageListenerMatches({
      bot: state,
      chatId: 'oc_chat',
      messages,
      limit: 5,
      senderForMessage: () => ({ senderOpenId: 'ou_allowed', senderTypeRaw: 'user' }),
    });
    expect(matches.map(m => m.messageId)).toEqual(['om_2']);
  });
});
