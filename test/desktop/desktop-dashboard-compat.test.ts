import { describe, expect, it, vi } from 'vitest';

describe('desktop dashboard compat validation', () => {
  it('accepts the supported desktop compat manifest', async () => {
    const { validateDashboardCompat } = await import('../../src/desktop/main/dashboard-compat.js');
    const fetch = vi.fn().mockResolvedValue(response(200, {
      schemaVersion: 1,
      product: 'botmux',
      runtimeVersion: '2.95.0',
      dashboardProtocolVersion: 1,
      desktopShell: { supported: true },
      features: ['desktop-shell'],
      routes: ['#/'],
    }));

    await expect(validateDashboardCompat('http://127.0.0.1:7891/?token=x', { fetch })).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:7891/__desktop/compat?token=x', expect.any(Object));
  });

  it('preserves platform dashboard auth query params when probing compat', async () => {
    const { validateDashboardCompat } = await import('../../src/desktop/main/dashboard-compat.js');
    const fetch = vi.fn().mockResolvedValue(response(200, {
      schemaVersion: 1,
      product: 'botmux',
      runtimeVersion: '2.95.0',
      dashboardProtocolVersion: 1,
      desktopShell: { supported: true },
      features: ['desktop-shell'],
      routes: ['#/'],
    }));

    await expect(validateDashboardCompat('https://m-test.botmux.bytedance.net/?t=secret-token#/sessions', { fetch }))
      .resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(
      'https://m-test.botmux.bytedance.net/__desktop/compat?t=secret-token',
      expect.any(Object),
    );
  });

  it('degrades safely when an old CLI does not expose the compat manifest', async () => {
    const { validateDashboardCompat } = await import('../../src/desktop/main/dashboard-compat.js');
    const fetch = vi.fn().mockResolvedValue(response(404, { error: 'not found' }));

    const result = await validateDashboardCompat('http://127.0.0.1:7891/?token=x', { fetch });

    expect(result).toMatchObject({
      ok: false,
      reason: 'incompatible',
      message: expect.stringContaining('/__desktop/compat'),
    });
    expect(result.message).toContain('升级或切换全局 botmux CLI');
    expect(result.message).not.toContain('src/desktop/install-local.sh');
  });

  it('degrades safely when the compat manifest is malformed', async () => {
    const { validateDashboardCompat } = await import('../../src/desktop/main/dashboard-compat.js');
    const fetch = vi.fn().mockResolvedValue(response(200, {
      schemaVersion: 1,
      product: 'botmux',
      dashboardProtocolVersion: 1,
    }));

    const result = await validateDashboardCompat('http://127.0.0.1:7891/', { fetch });

    expect(result).toMatchObject({
      ok: false,
      reason: 'incompatible',
      message: expect.stringContaining('兼容信息格式不正确'),
    });
  });

  it('treats invalid compat JSON as an incompatible manifest, not as a network outage', async () => {
    const { validateDashboardCompat } = await import('../../src/desktop/main/dashboard-compat.js');
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError('bad json')),
    });

    const result = await validateDashboardCompat('http://127.0.0.1:7891/', { fetch });

    expect(result).toMatchObject({
      ok: false,
      reason: 'incompatible',
      message: expect.stringContaining('兼容信息格式不正确'),
    });
  });

  it('blocks embedding when the dashboard protocol is newer than this app supports', async () => {
    const { validateDashboardCompat } = await import('../../src/desktop/main/dashboard-compat.js');
    const fetch = vi.fn().mockResolvedValue(response(200, {
      schemaVersion: 1,
      product: 'botmux',
      runtimeVersion: '3.0.0',
      dashboardProtocolVersion: 2,
      desktopShell: { supported: true },
      features: ['desktop-shell'],
      routes: ['#/'],
    }));

    const result = await validateDashboardCompat('http://127.0.0.1:7891/', { fetch });

    expect(result).toMatchObject({
      ok: false,
      reason: 'incompatible',
      message: expect.stringContaining('高于 Desktop 支持'),
    });
  });
});

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}
