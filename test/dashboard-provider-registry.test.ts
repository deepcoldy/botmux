// provider 注册表：一行数据属于哪个平台、未知平台拿到什么、身份键与受控写请求。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isWecomSource,
  providerBotKey,
  providerOf,
  providerOfBotKey,
  sessionMutationPayload,
  sessionSupports,
  sessionWriteHeaders,
} from '../src/dashboard/web/providers/registry.js';
import { SESSION_CAPABILITIES } from '../src/dashboard/web/providers/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider registry', () => {
  it('treats legacy rows, lark and feishu as Feishu, wecom as WeCom, and any other value as an explicit unknown', () => {
    for (const provider of [undefined, null, '', 'lark', 'feishu']) expect(providerOf({ provider }), String(provider)).toBe('lark');
    expect(providerOf(undefined)).toBe('lark');
    expect(providerOf({ provider: 'wecom' })).toBe('wecom');
    for (const provider of ['WECOM', 'slack', 7]) expect(providerOf({ provider }), String(provider)).toBe('unknown');
  });

  it('gives an unknown provider none of the operations Feishu rows get by default, and no WeCom-only treatment', () => {
    const unknown = { provider: 'slack', sessionId: 's', larkAppId: 'cli_shared', providerBotId: 'conn', controlGeneration: 3 };
    const larkDefaults = SESSION_CAPABILITIES.filter(capability => sessionSupports({ sessionId: 'legacy' }, capability));
    expect(larkDefaults.length).toBeGreaterThan(0);
    for (const capability of larkDefaults) expect(sessionSupports(unknown, capability), capability).toBe(false);
    // 服务端逐项声明的仍然算数（与飞书、企业微信同一条规则）。
    expect(sessionSupports({ ...unknown, capabilities: { history: true } }, 'history')).toBe(true);
    expect(isWecomSource(unknown)).toBe(false);
    expect(sessionMutationPayload(unknown, { title: 'x' })).toEqual({ title: 'x' });
  });

  it('builds bot keys that map back to the platform that issued them', () => {
    const lark = { larkAppId: 'cli_same' };
    const wecom = { provider: 'wecom', providerBotId: 'cli_same' };
    expect(providerOfBotKey(providerBotKey(lark))).toBe('lark');
    expect(providerOfBotKey(providerBotKey(wecom))).toBe('wecom');
    expect(providerBotKey(wecom)).not.toBe(providerBotKey(lark));
    // 未知平台不另起身份键形态，也不会被当成企业微信的键。
    expect(providerOfBotKey(providerBotKey({ provider: 'slack', larkAppId: 'cli_x' }))).toBe('lark');
  });

  it('sends the control CSRF ticket and the row generation only with WeCom session writes', () => {
    vi.stubGlobal('document', { querySelector: () => ({ getAttribute: () => 'ticket-1' }) });
    const wecom = { provider: 'wecom', sessionId: 'w', controlGeneration: 9 };
    expect(sessionWriteHeaders(wecom)).toEqual({ 'x-botmux-csrf': 'ticket-1' });
    expect(sessionMutationPayload(wecom, { locked: true })).toEqual({ locked: true, expectedGeneration: 9 });
    for (const row of [{ sessionId: 'l' }, { provider: 'feishu', sessionId: 'f' }, { provider: 'slack', sessionId: 'u' }]) {
      expect(sessionWriteHeaders(row)).toEqual({});
      const payload = { locked: true };
      expect(sessionMutationPayload(row, payload)).toBe(payload);
    }
  });
});
