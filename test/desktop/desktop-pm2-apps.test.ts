import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeLaunchTarget } from '../../src/desktop/main/runtime-service.js';
import { defaultPm2ListTimeoutMs, listPm2Apps } from '../../src/desktop/main/pm2-apps.js';

const paths = {
  botmuxHome: '/home/.botmux',
  dataDir: '/home/.botmux/data',
  logsDir: '/home/.botmux/logs',
  pm2Home: '/home/.botmux/pm2',
};

const runtime: RuntimeLaunchTarget = {
  kind: 'external',
  root: '/usr/local/lib/node_modules/botmux',
  cliPath: '/usr/local/lib/node_modules/botmux/dist/cli.js',
  binPath: '/usr/local/bin/botmux',
  version: '1.0.0',
};

function childProcessStub() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('desktop PM2 app listing', () => {
  it('runs PM2 through the bundled Node absolute path', async () => {
    const child = childProcessStub();
    const spawn = vi.fn(() => child);
    const bundled: RuntimeLaunchTarget = {
      kind: 'bundled',
      root: '/Applications/Botmux.app/Contents/Resources/runtime',
      cliPath: '/Applications/Botmux.app/Contents/Resources/runtime/dist/cli.js',
      nodePath: '/Applications/Botmux.app/Contents/Resources/node/darwin-arm64/bin/node',
      version: '3.0.0',
      runtimeSource: 'bundled',
    };
    const promise = listPm2Apps(paths, bundled, {
      existsSync: () => true,
      spawn: spawn as any,
      env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' },
    });

    child.stdout.emit('data', '[]');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual([]);
    expect(spawn).toHaveBeenCalledWith(
      bundled.nodePath,
      [`${bundled.root}/node_modules/pm2/bin/pm2`, 'jlist'],
      expect.objectContaining({ env: expect.not.objectContaining({ ELECTRON_RUN_AS_NODE: expect.anything() }) }),
    );
  });

  it('keeps the probed shell PATH in the bundled PM2 environment', async () => {
    const child = childProcessStub();
    const spawn = vi.fn(() => child);
    const bundled: RuntimeLaunchTarget = {
      kind: 'bundled',
      root: '/Applications/Botmux.app/Contents/Resources/runtime',
      cliPath: '/Applications/Botmux.app/Contents/Resources/runtime/dist/cli.js',
      nodePath: '/Applications/Botmux.app/Contents/Resources/node/darwin-arm64/bin/node',
      version: '3.0.0',
      runtimeSource: 'bundled',
    };
    const promise = listPm2Apps(paths, bundled, {
      existsSync: () => true,
      spawn: spawn as any,
      env: { PATH: '/usr/bin:/bin' },
      pathEnv: '/Users/me/.nvm/versions/node/v22.22.2/bin',
    });

    child.stdout.emit('data', '[]');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual([]);
    const env = (spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
    // Must match the daemon-start ordering exactly (buildBundledPath): pm2's
    // sticky daemon env propagates into resurrected apps, so which node a
    // per-bot CLI resolves must not depend on pm2 startup order. pm2 itself is
    // launched via the absolute nodePath, never through this PATH.
    expect(env.PATH).toBe([
      '/Users/me/.nvm/versions/node/v22.22.2/bin',
      '/Applications/Botmux.app/Contents/Resources/node/darwin-arm64/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ].join(':'));
  });

  it('rejects when the selected runtime does not contain a PM2 binary', async () => {
    await expect(listPm2Apps(paths, runtime, {
      existsSync: () => false,
      execPath: '/Electron',
      env: {},
    })).rejects.toThrow('PM2 binary not found');
  });

  it('rejects when PM2 exits nonzero so runtime state can degrade', async () => {
    const child = childProcessStub();
    const spawn = vi.fn(() => child);
    const promise = listPm2Apps(paths, runtime, {
      existsSync: () => true,
      spawn: spawn as any,
      execPath: '/Electron',
      env: {},
      timeoutMs: 10_000,
    });

    child.emit('close', 1);

    await expect(promise).rejects.toThrow('PM2 jlist failed');
  });

  it('rejects and kills PM2 discovery when it times out', async () => {
    vi.useFakeTimers();
    const child = childProcessStub();
    const spawn = vi.fn(() => child);
    const promise = expect(listPm2Apps(paths, runtime, {
      existsSync: () => true,
      spawn: spawn as any,
      execPath: '/Electron',
      env: {},
      timeoutMs: 25,
    })).rejects.toThrow('timed out');

    await vi.advanceTimersByTimeAsync(25);

    await promise;
    expect(child.kill).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('uses a desktop-friendly default timeout before marking PM2 discovery failed', async () => {
    vi.useFakeTimers();
    const child = childProcessStub();
    const spawn = vi.fn(() => child);
    const promise = expect(listPm2Apps(paths, runtime, {
      existsSync: () => true,
      spawn: spawn as any,
      execPath: '/Electron',
      env: {},
    })).rejects.toThrow(`PM2 jlist timed out after ${defaultPm2ListTimeoutMs}ms`);

    await vi.advanceTimersByTimeAsync(defaultPm2ListTimeoutMs - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await promise;
    expect(child.kill).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('uses the discovered login shell PATH when spawning PM2 for a wrapper runtime', async () => {
    const child = childProcessStub();
    const spawn = vi.fn(() => child);
    const shellPath = '/Users/me/.nvm/versions/node/v22.22.2/bin:/usr/bin:/bin';
    const promise = listPm2Apps(paths, {
      ...runtime,
      binPath: '/home/.botmux/bin/botmux',
      pathEnv: shellPath,
    }, {
      existsSync: () => true,
      spawn: spawn as any,
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 10_000,
    });

    child.stdout.emit('data', '[]');
    child.emit('close', 0);

    await expect(promise).resolves.toEqual([]);
    const pathEntries = (spawn.mock.calls[0]![2] as any).env.PATH.split(':');
    expect(pathEntries.indexOf('/Users/me/.nvm/versions/node/v22.22.2/bin')).toBeGreaterThan(-1);
    expect(pathEntries.indexOf('/Users/me/.nvm/versions/node/v22.22.2/bin')).toBeLessThan(pathEntries.indexOf('/usr/bin'));
  });
});
