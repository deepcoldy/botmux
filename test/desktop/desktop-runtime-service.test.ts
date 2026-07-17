import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeService, type ExternalRuntimeCandidate } from '../../src/desktop/main/runtime-service.js';

const paths = {
  botmuxHome: '/home/.botmux',
  dataDir: '/home/.botmux/data',
  logsDir: '/home/.botmux/logs',
  pm2Home: '/home/.botmux/pm2',
};

const configuredBots = '[{"larkAppId":"cli_x","larkAppSecret":"secret"}]';

function globalCli(version = '2.9.0'): ExternalRuntimeCandidate {
  return {
    kind: 'external',
    root: '/usr/local/lib/node_modules/botmux',
    cliPath: '/usr/local/lib/node_modules/botmux/dist/cli.js',
    binPath: '/usr/local/bin/botmux',
    version,
    runtimeSource: 'global-cli',
  };
}

describe('runtime service', () => {
  it('reports not_configured without binding a private runtime when no global CLI exists', async () => {
    const svc = createRuntimeService({
      paths,
      appVersion: '1.0.0',
      execPath: '/Electron',
      env: {},
      fs: { existsSync: () => false, readFileSync: () => '' },
      run: vi.fn(),
    });

    const state = await svc.getState();

    expect(state).toMatchObject({
      status: 'not_configured',
      runtimeManaged: false,
      runtimePath: null,
      runtimeSource: 'none',
      message: expect.stringContaining('Install the global botmux CLI'),
    });
    expect(state.botCount).toBe(0);
  });

  it('reports degraded when configured bots exist but no global CLI is installed', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
    const svc = createRuntimeService({
      paths,
      appVersion: '1.0.0',
      execPath: '/Electron',
      env: { PATH: '/usr/bin' },
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      run,
    });

    const state = await svc.getState();
    const start = await svc.start();

    expect(state).toMatchObject({
      status: 'degraded',
      runtimeManaged: false,
      runtimeSource: 'none',
      message: expect.stringContaining('Install the global botmux CLI'),
    });
    expect(start.stderr).toContain('Install the global botmux CLI');
    expect(run).not.toHaveBeenCalled();
  });

  it('reports malformed bots.json as degraded and blocks CLI actions', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
    const svc = createRuntimeService({
      paths,
      appVersion: '1.0.0',
      execPath: '/Electron',
      env: { PATH: '/usr/bin' },
      fs: {
        existsSync: path => path === '/home/.botmux/bots.json',
        readFileSync: () => '[{"larkAppId":""}]',
      },
      run,
      externalRuntime: globalCli(),
    });

    const state = await svc.getState();
    const restart = await svc.restart();

    expect(state).toMatchObject({
      status: 'degraded',
      runtimeManaged: false,
      runtimeSource: 'global-cli',
      runtimePath: '/usr/local/lib/node_modules/botmux/dist/cli.js',
    });
    expect(state.message).toContain('larkAppId');
    expect(restart.stderr).toContain('larkAppId');
    expect(run).not.toHaveBeenCalled();
  });

  it('reports running without counting dashboard as an online daemon', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
    const svc = createRuntimeService({
      paths,
      appVersion: '1.0.0',
      execPath: '/Electron',
      env: { PATH: '/usr/bin' },
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      run,
      externalRuntime: globalCli(),
      pm2Apps: async () => [
        { name: 'botmux-dashboard', script: '/Users/me/src/botmux/dist/dashboard.js', status: 'online' },
        { name: 'botmux', script: '/Users/me/src/botmux/dist/index-daemon.js', status: 'stopped' },
      ],
    });

    const state = await svc.getState();
    await svc.start();

    expect(state).toMatchObject({
      status: 'running',
      runtimeManaged: true,
      runtimeSource: 'global-cli',
      runtimeVersion: '2.9.0',
      runtimePath: '/Users/me/src/botmux/dist/dashboard.js',
      onlineDaemonCount: 0,
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      command: '/usr/local/bin/botmux',
      args: ['start'],
      env: expect.objectContaining({
        PM2_HOME: '/home/.botmux/pm2',
        SESSION_DATA_DIR: '/home/.botmux/data',
      }),
    }));
    expect(run.mock.calls[0]![0].env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('keeps the discovered login shell PATH when invoking a wrapper runtime', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
    const shellPath = '/Users/me/.nvm/versions/node/v22.22.2/bin:/usr/bin:/bin';
    const svc = createRuntimeService({
      paths,
      appVersion: '1.0.0',
      execPath: '/Electron',
      env: { PATH: '/usr/bin:/bin' },
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      run,
      externalRuntime: {
        ...globalCli(),
        binPath: '/home/.botmux/bin/botmux',
        pathEnv: shellPath,
      },
      pm2Apps: async () => [],
    });

    await svc.start();

    const pathEntries = run.mock.calls[0]![0].env.PATH!.split(':');
    expect(pathEntries.indexOf('/Users/me/.nvm/versions/node/v22.22.2/bin')).toBeGreaterThan(-1);
    expect(pathEntries.indexOf('/Users/me/.nvm/versions/node/v22.22.2/bin')).toBeLessThan(pathEntries.indexOf('/usr/bin'));
  });

  it('reports stopped when global CLI is installed and no botmux PM2 app is running', async () => {
    const svc = createRuntimeService({
      paths,
      appVersion: '1.0.0',
      execPath: '/Electron',
      env: { PATH: '/usr/bin' },
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      externalRuntime: globalCli(),
      pm2Apps: async () => [],
    });

    const state = await svc.getState();

    expect(state).toMatchObject({
      status: 'stopped',
      runtimeManaged: true,
      runtimeSource: 'global-cli',
      runtimePath: '/usr/local/lib/node_modules/botmux/dist/cli.js',
    });
  });

  it('coalesces concurrent state probes so PM2 is queried once', async () => {
    let resolvePm2!: (apps: { name: string; script: string }[]) => void;
    const pm2Apps = vi.fn(() => new Promise<{ name: string; script: string }[]>(resolve => {
      resolvePm2 = resolve;
    }));
    const svc = createRuntimeService({
      paths,
      appVersion: '1.0.0',
      execPath: '/Electron',
      env: { PATH: '/usr/bin' },
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      externalRuntime: globalCli(),
      pm2Apps,
    });

    const first = svc.getState();
    const second = svc.getState();
    expect(pm2Apps).toHaveBeenCalledTimes(1);

    resolvePm2([
      { name: 'botmux-dashboard', script: '/usr/local/lib/node_modules/botmux/dist/dashboard.js' },
    ]);
    const [firstState, secondState] = await Promise.all([first, second]);

    expect(firstState.status).toBe('running');
    expect(firstState.runtimeManaged).toBe(true);
    expect(secondState).toEqual(firstState);
  });

  it('re-checks the global CLI version after the CLI is upgraded', async () => {
    let externalVersion = '2.9.0';
    const svc = createRuntimeService({
      paths,
      appVersion: '1.0.0',
      execPath: '/Electron',
      env: { PATH: '/usr/bin' },
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      discoverExternalRuntime: () => globalCli(externalVersion),
    });

    const beforeUpgrade = await svc.getState();
    externalVersion = '3.0.0';
    const afterUpgrade = await svc.getState();

    // App does not maintain a bundled runtime contract anymore; the selected
    // global CLI version is the runtime version displayed and controlled.
    expect(beforeUpgrade).toMatchObject({ status: 'stopped', runtimeVersion: '2.9.0' });
    expect(afterUpgrade).toMatchObject({ status: 'stopped', runtimeVersion: '3.0.0' });
  });

  it('preserves the local dashboard fallback from the current dashboard endpoint', async () => {
    const svc = createRuntimeService({
      paths,
      appVersion: '1.0.0',
      execPath: '/Electron',
      env: { PATH: '/usr/bin' },
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      externalRuntime: globalCli(),
      dashboardEndpoint: vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://m-test.botmux.bytedance.net/?t=platform-token',
        localUrl: 'http://10.92.89.226:7891/?t=local-token',
      }),
    });

    const result = await svc.currentDashboard();

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toBe([
      'https://m-test.botmux.bytedance.net/?t=platform-token',
      '本地直连(平台异常时可用): http://10.92.89.226:7891/?t=local-token',
    ].join('\n'));
  });

  it('adopts a controllable CLI runtime during legacy takeover without stopping it', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
    const svc = createRuntimeService({
      paths,
      appVersion: '1.0.0',
      execPath: '/Electron',
      env: { PATH: '/usr/bin' },
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      run,
      externalRuntime: globalCli(),
      pm2Apps: async () => [
        { name: 'botmux-dashboard', script: '/usr/local/lib/node_modules/botmux/dist/dashboard.js' },
      ],
    });

    await expect(svc.takeover()).resolves.toMatchObject({ code: 0, stderr: '' });
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses start, stop, restart, and takeover when no CLI runtime is bound', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
    const svc = createRuntimeService({
      paths,
      appVersion: '1.0.0',
      execPath: '/Electron',
      env: { PATH: '/usr/bin' },
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      run,
    });

    await expect(svc.start()).resolves.toMatchObject({ code: 1, stderr: expect.stringContaining('Install the global botmux CLI') });
    await expect(svc.stop()).resolves.toMatchObject({ code: 1, stderr: expect.stringContaining('Install the global botmux CLI') });
    await expect(svc.restart()).resolves.toMatchObject({ code: 1, stderr: expect.stringContaining('Install the global botmux CLI') });
    await expect(svc.takeover()).resolves.toMatchObject({ code: 1, stderr: expect.stringContaining('not controlled') });
    expect(run).not.toHaveBeenCalled();
  });

  it('treats signal-terminated child commands as failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-runtime-service-'));
    const script = join(dir, 'kill-self.sh');
    writeFileSync(script, '#!/bin/sh\nkill -TERM $$\n');
    chmodSync(script, 0o755);
    try {
      const svc = createRuntimeService({
        paths,
        appVersion: '1.0.0',
        execPath: '/Electron',
        env: {},
        fs: { existsSync: () => true, readFileSync: () => configuredBots },
        externalRuntime: {
          ...globalCli(),
          root: dir,
          cliPath: join(dir, 'dist/cli.js'),
          binPath: script,
        },
      });

      const result = await svc.start();
      expect(result.code).not.toBe(0);
      expect(result.signal).toBe('SIGTERM');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('times out runtime actions so renderer controls are not left pending forever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-runtime-timeout-'));
    const script = join(dir, 'hang.sh');
    writeFileSync(script, '#!/bin/sh\nsleep 5\n');
    chmodSync(script, 0o755);
    try {
      const svc = createRuntimeService({
        paths,
        appVersion: '1.0.0',
        execPath: '/Electron',
        env: {},
        fs: { existsSync: () => true, readFileSync: () => configuredBots },
        commandTimeoutMs: 25,
        externalRuntime: {
          ...globalCli(),
          root: dir,
          cliPath: join(dir, 'dist/cli.js'),
          binPath: script,
        },
      });

      const result = await svc.start();

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('timed out');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports degraded instead of stopped when PM2 discovery fails', async () => {
    const svc = createRuntimeService({
      paths,
      appVersion: '1.0.0',
      execPath: '/Electron',
      env: {},
      fs: { existsSync: () => true, readFileSync: () => configuredBots },
      externalRuntime: globalCli(),
      pm2Apps: async () => {
        throw new Error('PM2 jlist timed out');
      },
    });

    const state = await svc.getState();

    expect(state).toMatchObject({
      status: 'degraded',
      runtimeSource: 'global-cli',
      runtimeManaged: false,
    });
    expect(state.message).toContain('PM2 jlist timed out');
  });
});
