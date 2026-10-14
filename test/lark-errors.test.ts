import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LARK_CODE_APP_SCOPE_MISSING,
  LARK_CODE_CARD_CONTENT_REJECTED,
  LARK_CODE_CHAT_RATE_LIMITED,
  LARK_CODE_CONTACT_INVALID_PARAM,
  LARK_CODE_CONTACT_NO_SUCH_USER,
  LARK_CODE_CONTACT_NOT_VISIBLE,
  LARK_CODE_CROSS_APP_OPEN_ID,
  LARK_CODE_EPHEMERAL_NOT_GROUP,
  LARK_CODE_FREQUENCY_LIMITED,
  LARK_CODE_MESSAGE_BEING_SENT,
  LARK_CODE_MESSAGE_UPDATE_EXPIRED,
  LARK_CODE_MESSAGE_WITHDRAWN,
  LARK_CODE_USER_SCOPE_MISSING,
  LarkApiError,
  extractLarkBusinessCode,
  larkApiError,
  larkCodeFromMessage,
  messageHasLarkCode,
  structuredLarkCode,
} from '../src/im/lark/lark-errors.js';
import { TRANSIENT_LARK_CODES, extractLarkBusinessCode as gateExtract } from '../src/im/lark/api-gate.js';
import { classifyAskDispatchError } from '../src/im/lark/ask-card.js';
import { getLarkErrorCode, LARK_CODE_EPHEMERAL_NOT_GROUP as clientEphemeralCode } from '../src/im/lark/client.js';

/** 重构前三份“各写各的”提取实现的逐字副本，作差分基线。 */
function legacyApiGateExtract(err: unknown): number | undefined {
  const e = err as {
    response?: { data?: { code?: number } };
    code?: unknown;
    message?: string;
  } | null | undefined;
  const structured = e?.response?.data?.code ?? e?.code;
  if (typeof structured === 'number' && Number.isFinite(structured)) return structured;
  const message = typeof e?.message === 'string' ? e.message : '';
  const m = /\(code:\s*(\d+)\)/.exec(message);
  return m ? Number(m[1]) : undefined;
}
function legacyClientGetLarkErrorCode(err: any): number | undefined {
  const code = err?.response?.data?.code ?? err?.code;
  return typeof code === 'number' ? code : undefined;
}
function legacyAskCardExtract(e: {
  response?: { data?: { code?: number } }; code?: number; message?: string;
} | null | undefined, rawMessage: string): number | undefined {
  const structured = e?.response?.data?.code ?? e?.code;
  if (typeof structured === 'number') return structured;
  const m = /\(code:\s*(\d+)\)/.exec(rawMessage);
  return m ? Number(m[1]) : undefined;
}

const SAMPLES: unknown[] = [
  undefined, null, 'plain string', 'x (code: 230049)', 42,
  new Error('no code here'),
  new Error('Failed to send message: boom (code: 230049)'),
  new Error('Failed to reply message: ErrCode: 200570; card contains invalid image keys (code:230099)'),
  new Error('first (code: 1) then (code: 2)'),
  { code: 230011 }, { code: '230011' }, { code: 'ENOENT' }, { code: NaN }, { code: Infinity },
  { code: NaN, message: 'tail (code: 99991400)' },
  { response: { data: { code: 99991672 } } },
  { response: { data: { code: 99991672 } }, code: 5 },
  { response: { data: { code: '99991672' } }, code: 5 },
  { response: { data: { code: null } }, code: 7 },
  { response: { data: {} }, message: 'axios (code: 230020)' },
  { response: { data: { msg: 'm (code: 230049)' } }, message: 'Request failed with status code 400' },
  { message: 12345 },
  new LarkApiError('Failed to send message: x (code: 230049)', 230049, 'x'),
];

describe('lark-errors 提取函数与重构前实现等价', () => {
  it('extractLarkBusinessCode === 旧 api-gate 实现（含再导出）', () => {
    expect(gateExtract).toBe(extractLarkBusinessCode);
    for (const s of SAMPLES) {
      expect(extractLarkBusinessCode(s)).toBe(legacyApiGateExtract(s));
    }
  });

  it('structuredLarkCode === 旧 client.getLarkErrorCode（仅结构化、无 message 回落）', () => {
    for (const s of SAMPLES) {
      expect(structuredLarkCode(s)).toBe(legacyClientGetLarkErrorCode(s));
      expect(getLarkErrorCode(s)).toBe(legacyClientGetLarkErrorCode(s));
    }
  });

  it('ask-card 的组合（结构化 ?? detail 尾部）=== 旧 extractLarkCode，含 NaN/字符串边界', () => {
    const texts = ['', 'no code', 'x (code: 230049)', 'a (code: 1) b (code: 2)'];
    for (const s of SAMPLES) {
      for (const text of texts) {
        expect(structuredLarkCode(s) ?? larkCodeFromMessage(text))
          .toBe(legacyAskCardExtract(s as any, text));
      }
    }
  });

  it('messageHasLarkCode 等价于旧 card-image-fallback 的内联正则', () => {
    const msgs = [
      '', 'x', 'boom (code: 230099)', 'boom (code:230099)', '(code: 2300991)',
      'first (code: 1) then (code: 230099)', 'ErrCode: 200570 (code: 230098)',
    ];
    for (const m of msgs) {
      expect(messageHasLarkCode(m, 230099)).toBe(/\(code:\s*230099\)/.test(m));
    }
    expect(messageHasLarkCode(undefined, 230099)).toBe(false);
  });
});

describe('ask-card 边界差异保留（本次重构刻意不抹平）', () => {
  it('ask-card 会扫 response.data.msg / 裸字符串里的 (code: N)；api-gate 只看 err.message', () => {
    // 抛出裸字符串：api-gate 取不到码，ask-card 的 detail 就是该字符串 → 瞬时码 → 可重试
    expect(extractLarkBusinessCode('boom (code: 230049)')).toBeUndefined();
    expect(classifyAskDispatchError('boom (code: 230049)').retryable).toBe(true);
    // msg 里带尾部码、message 里没有
    const e = { response: { data: { msg: 'x (code: 230049)' } }, message: 'Request failed' };
    expect(extractLarkBusinessCode(e)).toBeUndefined();
    expect(classifyAskDispatchError(e).retryable).toBe(true);
  });

  it('LarkApiError 与历史 plain Error 在 ask-card / api-gate 下分类一致', () => {
    for (const code of [230049, 230020, 99991400, 230011, 230002]) {
      const typed = larkApiError('send message', { code, msg: 'boom' });
      const plain = new Error(`Failed to send message: boom (code: ${code})`);
      expect(typed.message).toBe(plain.message);
      expect(extractLarkBusinessCode(typed)).toBe(extractLarkBusinessCode(plain));
      expect(classifyAskDispatchError(typed)).toEqual(classifyAskDispatchError(plain));
    }
  });
});

describe('LarkApiError / larkApiError', () => {
  it('message 与重构前 `new Error(`Failed to …: ${res.msg} (code: ${res.code})`)` 逐字一致', () => {
    const actions = [
      'send message', 'reply message', 'forward message', 'add reaction', 'remove reaction',
      'send user message', 'get chat info', 'list chat members', 'send ephemeral card',
      'update message', 'resolve CardKit id', 'update CardKit streaming settings',
      'stream CardKit element content', 'patch CardKit element', 'get message',
      'list thread messages', 'list chat messages', 'list messages',
    ];
    for (const action of actions) {
      for (const res of [{ code: 230002, msg: 'bot not in chat' }, { code: 99991672, msg: undefined }, { code: 1 }]) {
        const legacy = `Failed to ${action}: ${(res as any).msg} (code: ${res.code})`;
        const err = larkApiError(action, res);
        expect(err.message).toBe(legacy);
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(LarkApiError);
        expect(err.code).toBe(res.code);
      }
    }
  });

  it('msgFallback 只在 msg 缺失时替代（urgent 用 ""，pins 用 "unknown error"）', () => {
    expect(larkApiError('urgent message (sms)', { code: 5, msg: undefined }, '').message)
      .toBe('Failed to urgent message (sms):  (code: 5)');
    expect(larkApiError('urgent message (sms)', { code: 5, msg: 'm' }, '').message)
      .toBe('Failed to urgent message (sms): m (code: 5)');
    expect(larkApiError('list chat pins', { code: 5 }, 'unknown error').message)
      .toBe('Failed to list chat pins: unknown error (code: 5)');
    expect(larkApiError('list chat pins', { code: 5, msg: '' }, 'unknown error').message)
      .toBe('Failed to list chat pins:  (code: 5)'); // `??` 语义：空串不触发回落
  });

  it('结构化 code 可被所有读取方式拿到；非 number 的 code 不挂', () => {
    const err = larkApiError('get message', { code: 230011, msg: 'withdrawn' });
    expect(err.code).toBe(230011);
    expect(err.larkMsg).toBe('withdrawn');
    expect(structuredLarkCode(err)).toBe(230011);
    expect(larkApiError('x', { code: '5' as any, msg: 'm' }).code).toBeUndefined();
  });

  it('client.ts 不再有手写的 `Failed to … (code: N)` 抛错（防回退）', () => {
    const src = readFileSync(resolve('src/im/lark/client.ts'), 'utf8');
    expect(src).not.toMatch(/throw (new Error|Object\.assign\(new Error)\(`Failed to [^`]*\(code: \$\{/);
  });
});

describe('具名常量', () => {
  it('取值与历史魔数一致', () => {
    expect(LARK_CODE_APP_SCOPE_MISSING).toBe(99991672);
    expect(LARK_CODE_USER_SCOPE_MISSING).toBe(99991679);
    expect(LARK_CODE_FREQUENCY_LIMITED).toBe(99991400);
    expect(LARK_CODE_CROSS_APP_OPEN_ID).toBe(99992361);
    expect(LARK_CODE_CONTACT_INVALID_PARAM).toBe(40001);
    expect(LARK_CODE_CONTACT_NO_SUCH_USER).toBe(41012);
    expect(LARK_CODE_CONTACT_NOT_VISIBLE).toBe(41050);
    expect(LARK_CODE_MESSAGE_WITHDRAWN).toBe(230011);
    expect(LARK_CODE_MESSAGE_UPDATE_EXPIRED).toBe(230031);
    expect(LARK_CODE_MESSAGE_BEING_SENT).toBe(230049);
    expect(LARK_CODE_CHAT_RATE_LIMITED).toBe(230020);
    expect(LARK_CODE_CARD_CONTENT_REJECTED).toBe(230099);
    expect(LARK_CODE_EPHEMERAL_NOT_GROUP).toBe(18053);
    expect(clientEphemeralCode).toBe(18053);
  });

  it('瞬时码白名单内容不变', () => {
    expect([...TRANSIENT_LARK_CODES].sort()).toEqual([230020, 230049, 99991400]);
  });
});
