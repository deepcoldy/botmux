import { afterEach, describe, expect, it, vi } from 'vitest';

describe('web external host', () => {
  const original = {
    WEB_EXTERNAL_HOST: process.env.WEB_EXTERNAL_HOST,
    BOTMUX_DASHBOARD_EXTERNAL_HOST: process.env.BOTMUX_DASHBOARD_EXTERNAL_HOST,
    BOTMUX_DASHBOARD_HOST: process.env.BOTMUX_DASHBOARD_HOST,
  };

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('node:os');
    vi.doUnmock('../src/setup/ensure-tmux.js');
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Fresh config with node:os / ensure-tmux mocked. `lanIp` is read lazily each
   *  access, so a test can flip it and re-read config.*.externalHost. */
  async function loadConfig(lanIp: () => string) {
    vi.resetModules();
    vi.doMock('node:os', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:os')>()),
      networkInterfaces: vi.fn(() => ({
        en0: [{ family: 'IPv4', internal: false, address: lanIp() }],
      })),
    }));
    vi.doMock('../src/setup/ensure-tmux.js', () => ({
      probeTmuxFunctional: () => ({ ok: false }),
    }));
    return (await import('../src/config.js')).config;
  }

  const setEnv = (env: Record<string, string | undefined>) => {
    for (const k of Object.keys(original)) delete process.env[k];
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  };

  it('re-resolves the LAN IP when WEB_EXTERNAL_HOST is not configured', async () => {
    setEnv({});
    let lan = '10.0.12.34';
    const config = await loadConfig(() => lan);
    expect(config.web.externalHost).toBe('10.0.12.34');
    lan = '192.168.31.88';
    expect(config.web.externalHost).toBe('192.168.31.88');
  });

  it('keeps an explicit WEB_EXTERNAL_HOST fixed', async () => {
    setEnv({ WEB_EXTERNAL_HOST: 'terminal.example.com' });
    let lan = '10.0.12.34';
    const config = await loadConfig(() => lan);
    expect(config.web.externalHost).toBe('terminal.example.com');
    lan = '192.168.31.88';
    expect(config.web.externalHost).toBe('terminal.example.com');
  });

  it('treats blank host settings as unset', async () => {
    setEnv({ WEB_EXTERNAL_HOST: '   ', BOTMUX_DASHBOARD_EXTERNAL_HOST: '' });
    let lan = '10.0.12.34';
    const config = await loadConfig(() => lan);
    expect(config.web.externalHost).toBe('10.0.12.34');
    expect(config.dashboard.externalHost).toBe('10.0.12.34');
    lan = '192.168.31.88';
    expect(config.web.externalHost).toBe('192.168.31.88');
    expect(config.dashboard.externalHost).toBe('192.168.31.88');
  });

  it('falls back to WEB_EXTERNAL_HOST when the dashboard external host is blank', async () => {
    setEnv({ WEB_EXTERNAL_HOST: 'terminal.example.com', BOTMUX_DASHBOARD_EXTERNAL_HOST: ' ' });
    const config = await loadConfig(() => '10.0.12.34');
    expect(config.dashboard.externalHost).toBe('terminal.example.com');
  });

  it('advertises a concrete BOTMUX_DASHBOARD_HOST bind instead of the LAN IP', async () => {
    setEnv({ BOTMUX_DASHBOARD_HOST: '127.0.0.1' });
    const config = await loadConfig(() => '10.0.12.34');
    expect(config.dashboard.externalHost).toBe('127.0.0.1');
    expect(config.web.externalHost).toBe('10.0.12.34');
  });

  it('returns a concrete IPv6 bind raw (URL layer brackets it)', async () => {
    setEnv({ BOTMUX_DASHBOARD_HOST: '::1' });
    const config = await loadConfig(() => '10.0.12.34');
    // config layer stays raw; bracketing for the URL is formatUrlHost's job and
    // is covered hermetically in dashboard-url.test.ts (this suite doesn't mock
    // the platform-binding / remote-access state buildDashboardUrl reads).
    expect(config.dashboard.externalHost).toBe('::1');
  });

  it('autodetects the LAN IP for wildcard or blank dashboard binds', async () => {
    for (const bind of ['0.0.0.0', '::', '', '   ']) {
      setEnv({ BOTMUX_DASHBOARD_HOST: bind });
      const config = await loadConfig(() => '10.0.12.34');
      expect(config.dashboard.externalHost).toBe('10.0.12.34');
    }
  });

  it('lets an explicit external host win over the bind host', async () => {
    setEnv({ BOTMUX_DASHBOARD_EXTERNAL_HOST: 'dash.example.com', BOTMUX_DASHBOARD_HOST: '127.0.0.1' });
    const config = await loadConfig(() => '10.0.12.34');
    expect(config.dashboard.externalHost).toBe('dash.example.com');
  });
});
