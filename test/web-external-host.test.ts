import { afterEach, describe, expect, it, vi } from 'vitest';

describe('web external host', () => {
  const originalWebExternalHost = process.env.WEB_EXTERNAL_HOST;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('node:os');
    vi.doUnmock('../src/setup/ensure-tmux.js');
    if (originalWebExternalHost === undefined) delete process.env.WEB_EXTERNAL_HOST;
    else process.env.WEB_EXTERNAL_HOST = originalWebExternalHost;
  });

  it('re-resolves the LAN IP when WEB_EXTERNAL_HOST is not configured', async () => {
    delete process.env.WEB_EXTERNAL_HOST;
    let interfaces: Record<string, any[]> = {
      en0: [{ family: 'IPv4', internal: false, address: '10.0.12.34' }],
    };

    vi.doMock('node:os', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:os')>()),
      networkInterfaces: vi.fn(() => interfaces),
    }));
    vi.doMock('../src/setup/ensure-tmux.js', () => ({
      probeTmuxFunctional: () => ({ ok: false }),
    }));

    const { config } = await import('../src/config.js');
    expect(config.web.externalHost).toBe('10.0.12.34');

    interfaces = {
      en0: [{ family: 'IPv4', internal: false, address: '192.168.31.88' }],
    };
    expect(config.web.externalHost).toBe('192.168.31.88');
  });

  it('keeps an explicit WEB_EXTERNAL_HOST fixed', async () => {
    process.env.WEB_EXTERNAL_HOST = 'terminal.example.com';
    let interfaces: Record<string, any[]> = {
      en0: [{ family: 'IPv4', internal: false, address: '10.0.12.34' }],
    };

    vi.doMock('node:os', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:os')>()),
      networkInterfaces: vi.fn(() => interfaces),
    }));
    vi.doMock('../src/setup/ensure-tmux.js', () => ({
      probeTmuxFunctional: () => ({ ok: false }),
    }));

    const { config } = await import('../src/config.js');
    expect(config.web.externalHost).toBe('terminal.example.com');

    interfaces = {
      en0: [{ family: 'IPv4', internal: false, address: '192.168.31.88' }],
    };
    expect(config.web.externalHost).toBe('terminal.example.com');
  });
});
