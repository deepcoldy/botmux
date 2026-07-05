/**
 * Unit tests for the dashboard-side Feishu web-login manager: the QR → scan →
 * success/failure state machine, idempotent start, and the injected
 * prepareSession/renderQr seams. No network — prepareSession is a fake that
 * drives onQrCode/onStatus and resolves a canned result.
 *
 * Run: pnpm vitest run test/feishu-login-manager.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { FeishuLoginManager } from '../src/dashboard/feishu-login.js';
import type { FeishuWebSessionOptions, FeishuWebSessionPrepareResult } from '../src/setup/open-platform-automation.js';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('FeishuLoginManager', () => {
  it('walks starting → awaiting_scan (renders QR) → success', async () => {
    let resolveResult!: (r: FeishuWebSessionPrepareResult) => void;
    const prepareSession = vi.fn(async (opts: FeishuWebSessionOptions) => {
      // 真实实现会先异步验证缓存才弹码；前置一个 await 让 start() 返回时仍是 starting。
      await Promise.resolve();
      await opts.onQrCode?.({ qrText: 'ascii', qrPayload: '{"qrlogin":{"token":"tok"}}' });
      await opts.onStatus?.('等待飞书扫码');
      return new Promise<FeishuWebSessionPrepareResult>((res) => { resolveResult = res; });
    });
    const mgr = new FeishuLoginManager({
      prepareSession,
      renderQr: (payload) => `data:qr:${payload}`,
      now: () => 1000,
      maxWaitMs: 5000,
    });

    const started = mgr.start();
    expect(started.status).toBe('starting');
    await flush();

    const scanning = mgr.get()!;
    expect(scanning.status).toBe('awaiting_scan');
    expect(scanning.qrDataUrl).toBe('data:qr:{"qrlogin":{"token":"tok"}}');
    expect(scanning.expireAt).toBe(1000 + 5000);
    expect(scanning.message).toBe('等待飞书扫码');

    resolveResult({ ok: true, sessionFile: '/x', source: 'qr_login', cookies: [], cookieCount: 7 });
    await flush();

    const done = mgr.get()!;
    expect(done.status).toBe('success');
    expect(done.cookieCount).toBe(7);
    expect(done.source).toBe('qr_login');
    expect(done.qrDataUrl).toBeUndefined();
  });

  it('reports a failed prepareSession result with its reason/message', async () => {
    const mgr = new FeishuLoginManager({
      prepareSession: async () => ({ ok: false, reason: 'qr_expired', message: '二维码已过期', sessionFile: '/x' }),
      renderQr: () => 'data:qr',
      now: () => 0,
    });
    mgr.start();
    await flush();
    const snap = mgr.get()!;
    expect(snap.status).toBe('failed');
    expect(snap.reason).toBe('qr_expired');
    expect(snap.message).toBe('二维码已过期');
  });

  it('treats a thrown prepareSession as an unexpected failure (no crash)', async () => {
    const mgr = new FeishuLoginManager({
      prepareSession: async () => { throw new Error('boom'); },
      renderQr: () => 'data:qr',
      now: () => 0,
    });
    mgr.start();
    await flush();
    const snap = mgr.get()!;
    expect(snap.status).toBe('failed');
    expect(snap.reason).toBe('unexpected');
    expect(snap.message).toBe('boom');
  });

  it('is idempotent while in flight — a second start() does not launch a new flow', async () => {
    let calls = 0;
    let resolveResult!: (r: FeishuWebSessionPrepareResult) => void;
    const prepareSession = vi.fn(async (opts: FeishuWebSessionOptions) => {
      calls++;
      await opts.onQrCode?.({ qrText: 'a', qrPayload: 'p' });
      return new Promise<FeishuWebSessionPrepareResult>((res) => { resolveResult = res; });
    });
    const mgr = new FeishuLoginManager({ prepareSession, renderQr: () => 'q', now: () => 0 });

    mgr.start();
    await flush();
    expect(mgr.get()!.status).toBe('awaiting_scan');
    mgr.start(); // in-flight → reuse
    mgr.start();
    await flush();
    expect(calls).toBe(1);

    // After it settles, a fresh start() launches a new flow (retry with a new QR).
    resolveResult({ ok: false, reason: 'timeout', message: 'timed out', sessionFile: '/x' });
    await flush();
    expect(mgr.get()!.status).toBe('failed');
    mgr.start();
    await flush();
    expect(calls).toBe(2);
  });

  it('returns null from get() before any start()', () => {
    const mgr = new FeishuLoginManager({ prepareSession: async () => ({ ok: true, sessionFile: '/x', source: 'botmux_cache', cookies: [], cookieCount: 1 }) });
    expect(mgr.get()).toBeNull();
  });
});
