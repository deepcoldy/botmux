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
  it('parses explicit result acknowledgement without treating it as a new Ask', () => {
    expect(parseAskBody(validBody({ requestId: 'stable', originKind: 'explicit', acknowledge: true }))).toMatchObject({ acknowledge: true, requestId: 'stable' });
  });
  it.each(['true', 1, null])('rejects non-boolean acknowledgement %s', acknowledge => {
    expect(parseAskBody(validBody({ acknowledge }))).toEqual({ error: 'bad_acknowledge' });
  });
  it.each(['host_explicit', 'host_cross_principal_wait', 'host_anything'])
  ('rejects daemon-internal host_ originKind %s over HTTP', originKind => {
    // host_* claimants are constructed in-process only; a client typing one
    // would collect broker GC/handoff exemptions without a daemon-owned record.
    expect(parseAskBody(validBody({ originKind }))).toEqual({ error: 'bad_originKind' });
  });
  it('still accepts the client-facing explicit originKind', () => {
    const out = parseAskBody(validBody({ originKind: 'explicit' }));
    expect('error' in out).toBe(false);
  });

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

describe('parseAskBody — supported request semantics', () => {
  it('rejects an unsupported request contract instead of reducing it to an ordinary Ask', () => {
    expect(parseAskBody(validBody({
      requestId: 'original-request', originKind: 'explicit',
      requiredContract: { kind: 'durable-approval', revision: 1 },
    }))).toEqual({ error: 'unsupported_fields' });
  });

  it('preserves native hook identity while leaving route claims to the authorizer', () => {
    const out = parseAskBody(validBody({
      requestId: 'original-hook', originKind: 'hook',
      originCapability: 'fixture-capability', originTurnId: 'original-turn', originDispatchAttempt: 2,
    }));
    expect(out).toMatchObject({ requestId: 'original-hook', originKind: 'hook' });
    expect(out).not.toHaveProperty('originCapability');
    expect(out).not.toHaveProperty('originTurnId');
    expect(out).not.toHaveProperty('originDispatchAttempt');
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

describe('parseAskBody — requestId / originKind (invocation identity)', () => {
  it('接受并透传合法 requestId + originKind', () => {
    const out = parseAskBody(validBody({ requestId: 'req-abc', originKind: 'hook' }));
    expect('error' in out).toBe(false);
    if (!('error' in out)) {
      expect(out.requestId).toBe('req-abc');
      expect(out.originKind).toBe('hook');
    }
  });

  it('缺省时 requestId/originKind 为 undefined（旧调用方兼容）', () => {
    const out = parseAskBody(validBody());
    if (!('error' in out)) {
      expect(out.requestId).toBeUndefined();
      expect(out.originKind).toBeUndefined();
    }
  });

  it('非法 requestId（空 / 超 128 / 非字符串）报错', () => {
    expect('error' in parseAskBody(validBody({ requestId: '' }))).toBe(true);
    expect('error' in parseAskBody(validBody({ requestId: 'x'.repeat(129) }))).toBe(true);
    expect('error' in parseAskBody(validBody({ requestId: 123 }))).toBe(true);
  });

  it('非法 originKind（空 / 超 32 / 非字符串）报错', () => {
    expect('error' in parseAskBody(validBody({ originKind: '' }))).toBe(true);
    expect('error' in parseAskBody(validBody({ originKind: 'x'.repeat(33) }))).toBe(true);
    expect('error' in parseAskBody(validBody({ originKind: {} }))).toBe(true);
  });
});

describe('parseAskBody — mentionedOpenId (--mention)', () => {
  it('接受合法人类 open_id 并透传', () => {
    const out = parseAskBody(validBody({ mentionedOpenId: 'ou_humanTarget0001' }));
    expect('error' in out).toBe(false);
    if (!('error' in out)) {
      expect(out.mentionedOpenId).toBe('ou_humanTarget0001');
    }
  });

  it('缺省时 mentionedOpenId 为 undefined（旧调用方兼容）', () => {
    const out = parseAskBody(validBody());
    if (!('error' in out)) expect(out.mentionedOpenId).toBeUndefined();
  });

  it.each([
    ['union_id', 'on_6741d98b6423c1b46e1ef7a5e6dd'],
    ['裸字符串', 'some-user'],
    ['空串', ''],
    ['数字', 12345],
    ['对象', { id: 'ou_x' }],
    ['null 视为缺省不报错', null],
  ])('%s', (_label, value) => {
    const out = parseAskBody(validBody({ mentionedOpenId: value }));
    if (value === null) {
      expect('error' in out).toBe(false);
    } else {
      expect('error' in out).toBe(true);
      if ('error' in out) expect(out.error).toBe('bad_mentionedOpenId');
    }
  });
});

describe('parseAskBody — options[].description 透传', () => {
  it('新 questions 格式保留合法 description', () => {
    const out = parseAskBody({
      sessionId: 's', chatId: 'c', larkAppId: 'a', rootMessageId: null, timeoutMs: 60000,
      questions: [{
        prompt: '选哪种发布方式？', multiSelect: false,
        options: [
          { key: 'gray', label: '灰度', description: '先放 5% 流量观察 30 分钟' },
          { key: 'full', label: '全量' },
        ],
      }],
    });
    expect('error' in out).toBe(false);
    if (!('error' in out)) {
      expect(out.questions[0].options[0]).toEqual({ key: 'gray', label: '灰度', description: '先放 5% 流量观察 30 分钟' });
      expect(out.questions[0].options[1]).toEqual({ key: 'full', label: '全量' });
    }
  });

  it('旧 options+prompt 格式同样保留 description', () => {
    const out = parseAskBody(validBody({
      options: [
        { key: 'yes', label: '继续', description: '先灰度 10%' },
        { key: 'no', label: '停止' },
      ],
    }));
    expect('error' in out).toBe(false);
    if (!('error' in out)) {
      expect(out.questions[0].options[0].description).toBe('先灰度 10%');
      expect(out.questions[0].options[1].description).toBeUndefined();
    }
  });

  it('空白 description 归一化为 undefined，非字符串/超长报错', () => {
    const ok = parseAskBody(validBody({
      options: [
        { key: 'yes', label: '继续', description: '   ' },
        { key: 'no', label: '停止' },
      ],
    }));
    expect('error' in ok).toBe(false);
    if (!('error' in ok)) expect(ok.questions[0].options[0].description).toBeUndefined();

    expect('error' in parseAskBody(validBody({
      options: [
        { key: 'yes', label: '继续', description: 123 },
        { key: 'no', label: '停止' },
      ],
    }))).toBe(true);
    expect('error' in parseAskBody(validBody({
      options: [
        { key: 'yes', label: '继续', description: 'x'.repeat(1001) },
        { key: 'no', label: '停止' },
      ],
    }))).toBe(true);
  });
});
