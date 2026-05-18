/**
 * 单测 src/setup/register-app.ts — 扫码建应用包装层.
 *
 * Run: pnpm vitest run test/setup-register-app.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 必须 hoist 到 vi.mock 工厂里; vitest 不允许工厂函数引用顶层变量.
vi.mock('@larksuiteoapi/node-sdk', () => ({
  registerApp: vi.fn(),
}));

vi.mock('qrcode-terminal', () => ({
  default: { generate: (_: string, _opts: unknown, cb?: (q: string) => void) => cb?.('FAKE-QR') },
}));

import { registerApp } from '@larksuiteoapi/node-sdk';
import { tryRegisterApp } from '../src/setup/register-app.js';

const mockedRegisterApp = registerApp as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedRegisterApp.mockReset();
});

describe('tryRegisterApp', () => {
  it('returns ok with appId+secret on success (feishu tenant)', async () => {
    mockedRegisterApp.mockResolvedValue({
      client_id: 'cli_test_feishu',
      client_secret: 'secret-feishu-xxx',
      user_info: { tenant_brand: 'feishu', open_id: 'ou_abc123' },
    });

    const onQR = vi.fn();
    const r = await tryRegisterApp({ onQRCodeReady: onQR, onStatusChange: () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.appId).toBe('cli_test_feishu');
      expect(r.appSecret).toBe('secret-feishu-xxx');
      expect(r.brand).toBe('feishu');
      expect(r.userOpenId).toBe('ou_abc123');
    }
  });

  it('passes through scanner open_id (only when prefixed with ou_)', async () => {
    mockedRegisterApp.mockResolvedValueOnce({
      client_id: 'cli_x', client_secret: 'sec', user_info: { open_id: 'ou_valid_xxx' },
    });
    const r1 = await tryRegisterApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r1.ok && r1.userOpenId).toBe('ou_valid_xxx');

    // Bad prefix → ignore, undefined
    mockedRegisterApp.mockResolvedValueOnce({
      client_id: 'cli_x', client_secret: 'sec', user_info: { open_id: 'weird_no_prefix' },
    });
    const r2 = await tryRegisterApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r2.ok && r2.userOpenId).toBeUndefined();
  });

  it('returns brand=lark when SDK reports tenant_brand=lark', async () => {
    mockedRegisterApp.mockResolvedValue({
      client_id: 'cli_lark',
      client_secret: 'lark-secret',
      user_info: { tenant_brand: 'lark' },
    });
    const r = await tryRegisterApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.brand).toBe('lark');
  });

  it('maps SDK error code=abort to aborted (user Ctrl-C)', async () => {
    const err = Object.assign(new Error('Registration was aborted'), { code: 'abort' });
    mockedRegisterApp.mockRejectedValue(err);
    const r = await tryRegisterApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('aborted');
  });

  it('maps SDK code=expired_token to expired (QR expired)', async () => {
    mockedRegisterApp.mockRejectedValue(Object.assign(new Error('Polling timed out'), { code: 'expired_token' }));
    const r = await tryRegisterApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('expired');
  });

  it('maps SDK code=access_denied to denied (user rejected in browser)', async () => {
    mockedRegisterApp.mockRejectedValue(Object.assign(new Error('denied'), { code: 'access_denied' }));
    const r = await tryRegisterApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('denied');
  });

  it('classifies axios network errors as network', async () => {
    mockedRegisterApp.mockRejectedValue(new Error('connect ETIMEDOUT 10.0.0.1:443'));
    const r = await tryRegisterApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('network');
  });

  it('falls through to unknown for unmapped errors and masks long tokens in message', async () => {
    // 模拟 SDK 抛了一个携带长 token 的错误信息. 实测 SDK 不会泄露 secret,
    // 但 register-app 的 safeMsg 保险层会把 30+ 长串替换成 ***.
    mockedRegisterApp.mockRejectedValue(new Error('weird abcdefghijklmnopqrstuvwxyz1234567890_xyz error'));
    const r = await tryRegisterApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('unknown');
      expect(r.message).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
      expect(r.message).toContain('***');
    }
  });

  it('treats missing client_id/secret in successful response as unknown error', async () => {
    mockedRegisterApp.mockResolvedValue({ client_id: '', client_secret: '' });
    const r = await tryRegisterApp({ onQRCodeReady: () => {}, onStatusChange: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unknown');
  });
});
