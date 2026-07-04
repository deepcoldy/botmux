/**
 * Unit tests for the daemon-side `POST /api/asks` body parser (parseAskBody).
 * Pure-function tests, no HTTP server, no bot-registry mocking.
 *
 * Run:  pnpm vitest run test/ask-api.test.ts
 */
import { describe, expect, it } from 'vitest';

import { parseAskBody } from '../src/core/ask-api.js';

function validBody(over: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    chatId: 'oc_chat',
    larkAppId: 'cli_app',
    rootMessageId: 'om_root',
    options: [
      { key: 'yes', label: '继续' },
      { key: 'no', label: '回滚' },
    ],
    prompt: '继续发版吗？',
    timeoutMs: 60_000,
    ...over,
  };
}

describe('parseAskBody — happy path', () => {
  it('accepts a fully populated body and returns the parsed shape', () => {
    const out = parseAskBody(validBody());
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.sessionId).toBe('sess-1');
    // 旧格式（options+prompt）归一化为 questions[0]
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0].options).toHaveLength(2);
    expect(out.questions[0].options[0]).toEqual({ key: 'yes', label: '继续' });
    expect(out.rootMessageId).toBe('om_root');
  });

  it('accepts rootMessageId=null (chat-scope ask)', () => {
    const out = parseAskBody(validBody({ rootMessageId: null }));
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.rootMessageId).toBeNull();
  });
});

describe('parseAskBody — validation', () => {
  it.each([
    ['bad_body', null],
    ['bad_body', undefined],
    ['bad_body', []],
    ['bad_body', 'not an object'],
  ] as const)('returns %s for non-object raw=%j', (expected, raw) => {
    const out = parseAskBody(raw);
    expect(out).toEqual({ error: expected });
  });

  it.each([
    ['bad_sessionId', { sessionId: '' }],
    ['bad_sessionId', { sessionId: '   ' }],
    ['bad_chatId', { chatId: '' }],
    ['bad_larkAppId', { larkAppId: '' }],
    ['bad_rootMessageId', { rootMessageId: 42 }],
    ['bad_prompt', { prompt: '' }],
    ['bad_prompt', { prompt: '   ' }],
    ['bad_timeoutMs', { timeoutMs: 500 }],          // below minimum (1s)
    ['bad_timeoutMs', { timeoutMs: NaN }],
    ['bad_timeoutMs', { timeoutMs: 'forever' }],
    ['bad_options', { options: [] }],
    ['bad_options', { options: [{ key: 'only', label: 'only' }] }],
    ['bad_options', { options: 'not-an-array' }],
  ] as const)('returns %s when %s', (expected, override) => {
    expect(parseAskBody(validBody(override))).toEqual({ error: expected });
  });

  it('rejects option with empty key', () => {
    const out = parseAskBody(
      validBody({
        options: [
          { key: '', label: 'bad' },
          { key: 'yes', label: 'good' },
        ],
      }),
    );
    expect(out).toEqual({ error: 'bad_option_key' });
  });

  it('rejects option without a string label', () => {
    const out = parseAskBody(
      validBody({
        options: [
          { key: 'yes', label: 1 as unknown as string },
          { key: 'no', label: 'no' },
        ],
      }),
    );
    expect(out).toEqual({ error: 'bad_option_label' });
  });

  it('rejects duplicate option keys', () => {
    const out = parseAskBody(
      validBody({
        options: [
          { key: 'yes', label: '继续' },
          { key: 'yes', label: '再继续' },
        ],
      }),
    );
    expect(out).toEqual({ error: 'duplicate_option_key' });
  });
});

describe('parseAskBody — questions[] 多问多选', () => {
  it('接受 questions[]（多问多选）', () => {
    const body = parseAskBody({
      sessionId: 's', chatId: 'c', larkAppId: 'a', rootMessageId: null,
      timeoutMs: 60000,
      questions: [
        { prompt: 'q1', multiSelect: false, options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }] },
        { prompt: 'q2', multiSelect: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
      ],
    });
    expect('error' in body).toBe(false);
    if (!('error' in body)) { expect(body.questions).toHaveLength(2); expect(body.questions[1].multiSelect).toBe(true); }
  });

  it('兼容旧 options[]+prompt：归一成单问单选', () => {
    const body = parseAskBody({
      sessionId: 's', chatId: 'c', larkAppId: 'a', rootMessageId: null,
      timeoutMs: 60000, prompt: 'go?', options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }],
    });
    if (!('error' in body)) { expect(body.questions).toHaveLength(1); expect(body.questions[0].prompt).toBe('go?'); expect(body.questions[0].multiSelect).toBe(false); }
  });

  it('每问 options<2 报错', () => {
    const body = parseAskBody({ sessionId: 's', chatId: 'c', larkAppId: 'a', rootMessageId: null, timeoutMs: 60000, questions: [{ prompt: 'q', multiSelect: false, options: [{ key: 'x', label: 'X' }] }] });
    expect('error' in body).toBe(true);
  });
});
