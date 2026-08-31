/**
 * pinMessage / unpinMessage 的 boolean 契约：只有 Lark 明确 code===0 才返回 true；
 * SDK 抛错或非 0 / missing code 返回 false（Pin 是 QoL，必须 fail-open）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '../src/utils/logger.js';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import { pinMessage, unpinMessage } from '../src/im/lark/client.js';

function setPinImpl(appId: string, impl: (req: any) => Promise<any>) {
  registerBot({ larkAppId: appId, larkAppSecret: 's', cliId: 'claude-code' });
  getBot(appId).client = { im: { v1: { pin: { create: impl } } } } as any;
}

function setUnpinImpl(appId: string, impl: (req: any) => Promise<any>) {
  registerBot({ larkAppId: appId, larkAppSecret: 's', cliId: 'claude-code' });
  getBot(appId).client = { im: { v1: { pin: { delete: impl } } } } as any;
}

afterEach(() => vi.restoreAllMocks());

describe('pinMessage/unpinMessage boolean contract', () => {
  it('pin calls SDK with exact create payload', async () => {
    const create = vi.fn(async () => ({ code: 0 }));
    setPinImpl('p_payload', create);
    await pinMessage('p_payload', 'om_pin');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ data: { message_id: 'om_pin' } });
  });

  it('unpin calls SDK with exact delete payload', async () => {
    const del = vi.fn(async () => ({ code: 0 }));
    setUnpinImpl('u_payload', del);
    await unpinMessage('u_payload', 'om_pin');
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith({ path: { message_id: 'om_pin' } });
  });

  it('returns true only when Lark confirms (code 0)', async () => {
    setPinImpl('p_ok', async () => ({ code: 0, msg: 'success' }));
    setUnpinImpl('u_ok', async () => ({ code: 0, msg: 'success' }));
    await expect(pinMessage('p_ok', 'om_pin')).resolves.toBe(true);
    await expect(unpinMessage('u_ok', 'om_pin')).resolves.toBe(true);
  });

  it('returns false on non-zero code', async () => {
    setPinImpl('p_bad', async () => ({ code: 230001, msg: 'fail' }));
    setUnpinImpl('u_bad', async () => ({ code: 230001, msg: 'fail' }));
    await expect(pinMessage('p_bad', 'om_pin')).resolves.toBe(false);
    await expect(unpinMessage('u_bad', 'om_pin')).resolves.toBe(false);
  });

  it('returns false when response has no code field (treated as failure)', async () => {
    setPinImpl('p_missing', async () => ({}));
    setUnpinImpl('u_missing', async () => ({}));
    await expect(pinMessage('p_missing', 'om_pin')).resolves.toBe(false);
    await expect(unpinMessage('u_missing', 'om_pin')).resolves.toBe(false);
  });

  it('returns false when the SDK throws and logs only at debug without leaking auth tokens', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const err: any = new Error('sdk failed');
    err.config = { headers: { Authorization: 'Bearer fake_authorization_token' } };
    setPinImpl('p_throw', async () => { throw err; });
    await expect(pinMessage('p_throw', 'om_pin')).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
    const joined = debug.mock.calls.map((c) => c.join(' ')).join(' ');
    const lowered = joined.toLowerCase();
    expect(lowered).not.toContain('fake_authorization_token');
    expect(lowered).not.toContain('authorization');
  });

  it('unpin failures log only at debug (not warn)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    setUnpinImpl('u_debug_code', async () => ({ code: 230001, msg: 'fail' }));
    await expect(unpinMessage('u_debug_code', 'om_pin')).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();

    warn.mockClear();
    debug.mockClear();

    const err: any = new Error('sdk failed');
    err.config = { headers: { Authorization: 'Bearer fake_authorization_token' } };
    setUnpinImpl('u_debug_throw', async () => { throw err; });
    await expect(unpinMessage('u_debug_throw', 'om_pin')).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
    const joined = debug.mock.calls.map((c) => c.join(' ')).join(' ');
    const lowered = joined.toLowerCase();
    expect(lowered).not.toContain('fake_authorization_token');
    expect(lowered).not.toContain('authorization');
  });

  it('two successful unpin calls both return true (wrapper is stateless)', async () => {
    setUnpinImpl('u_idem', async () => ({ code: 0 }));
    await expect(unpinMessage('u_idem', 'om_pin')).resolves.toBe(true);
    await expect(unpinMessage('u_idem', 'om_pin')).resolves.toBe(true);
  });
});
