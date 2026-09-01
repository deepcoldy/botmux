import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

type SpawnCall = [string, string[], { env: NodeJS.ProcessEnv }];

function trackedSpawn(child?: ReturnType<typeof childProcessStub>) {
  const calls: SpawnCall[] = [];
  // Plain function, not `vi.fn(() => child)`: bun drops mock implementations
  // (measured: spawn returned undefined and the 25s jlist timer never settled,
  // so the file hit FILE_WALL SIGKILL).
  const spawn = ((command: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    calls.push([command, args, opts]);
    return child;
  }) as typeof import('node:child_process').spawn;
  return { spawn, calls };
}

const runningPm2 = { pm2QueryAvailable: () => true };

afterEach(() => {
  vi.useRealTimers();
});

describe('desktop PM2 app listing', () => {
  it('passes the inspected God generation to the read-only helper', async () => {
    const child = childProcessStub();
    const { spawn, calls } = trackedSpawn(child);
    const expectedGod = {
      pid: 7310,
      cgroup: '/user.slice/botmux.service',
      startIdentity: 'desktop-generation',
    };
    const promise = listPm2Apps(paths, runtime, {
      pm2QueryAvailable: () => expectedGod,
      existsSync: () => true,
      spawn: spawn as any,
      execPath: '/Electron',
      env: {},
    });
    child.stdout.emit('data', '[]');
    child.emit('close', 0);

    expect(await promise).toEqual([]);
    const env = calls[0][2].env;
    expect(JSON.parse(env.BOTMUX_PM2_EXPECTED_GOD!)).toEqual(expectedGod);
  });

  it('runs PM2 through the bundled Node absolute path', async () => {
    const child = childProcessStub();
    const { spawn, calls } = trackedSpawn(child);
    const bundled: RuntimeLaunchTarget = {
      kind: 'bundled',
      root: '/Applications/Botmux.app/Contents/Resources/runtime',
      cliPath: '/Applications/Botmux.app/Contents/Resources/runtime/dist/cli.js',
      nodePath: '/Applications/Botmux.app/Contents/Resources/node/darwin-arm64/bin/node',
      version: '3.0.0',
      runtimeSource: 'bundled',
    };
    const promise = listPm2Apps(paths, bundled, {
      ...runningPm2,
      existsSync: () => true,
      spawn: spawn as any,
      env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' },
    });

    child.stdout.emit('data', '[]');
    child.emit('close', 0);
    expect(await promise).toEqual([]);
    expect(calls[0][0]).toBe(bundled.nodePath);
    expect(calls[0][1]).toEqual([`${bundled.root}/dist/cli/pm2-readonly-client.js`, 'jlist']);
    expect(calls[0][2].env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('keeps the probed shell PATH in the bundled PM2 environment', async () => {
    const child = childProcessStub();
    const { spawn, calls } = trackedSpawn(child);
    const bundled: RuntimeLaunchTarget = {
      kind: 'bundled',
      root: '/Applications/Botmux.app/Contents/Resources/runtime',
      cliPath: '/Applications/Botmux.app/Contents/Resources/runtime/dist/cli.js',
      nodePath: '/Applications/Botmux.app/Contents/Resources/node/darwin-arm64/bin/node',
      version: '3.0.0',
      runtimeSource: 'bundled',
    };
    const promise = listPm2Apps(paths, bundled, {
      ...runningPm2,
      existsSync: () => true,
      spawn: spawn as any,
      env: { PATH: '/usr/bin:/bin' },
      pathEnv: '/Users/me/.nvm/versions/node/v22.22.2/bin',
    });

    child.stdout.emit('data', '[]');
    child.emit('close', 0);
    expect(await promise).toEqual([]);
    const env = calls[0][2].env;
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
    const { spawn } = trackedSpawn(child);
    const promise = listPm2Apps(paths, runtime, {
      ...runningPm2,
      existsSync: () => true,
      spawn: spawn as any,
      execPath: '/Electron',
      env: {},
      timeoutMs: 10_000,
    });

    child.emit('close', 1);

    await expect(promise).rejects.toThrow('PM2 jlist failed');
  });

  it('treats the read-only helper absence code as an empty process list', async () => {
    const child = childProcessStub();
    const { spawn } = trackedSpawn(child);
    const promise = listPm2Apps(paths, runtime, {
      ...runningPm2,
      existsSync: () => true,
      spawn: spawn as any,
      execPath: '/Electron',
      env: {},
    });

    child.emit('close', 3);

    expect(await promise).toEqual([]);
  });

  it('rejects and kills PM2 discovery when it times out', async () => {
    vi.useFakeTimers();
    const child = childProcessStub();
    const { spawn } = trackedSpawn(child);
    const pending = listPm2Apps(paths, runtime, {
      ...runningPm2,
      existsSync: () => true,
      spawn: spawn as any,
      execPath: '/Electron',
      env: {},
      timeoutMs: 25,
    });
    // Swallow until the assertion below; bun hangs if `.rejects` is attached
    // before the fake clock fires, and vitest flags an unhandled rejection if
    // the clock fires first with no handler.
    void pending.catch(() => {});

    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).rejects.toThrow('timed out');
    expect(child.kill).toHaveBeenCalled();
  });

  it('uses a desktop-friendly default timeout before marking PM2 discovery failed', async () => {
    vi.useFakeTimers();
    const child = childProcessStub();
    const { spawn } = trackedSpawn(child);
    const pending = listPm2Apps(paths, runtime, {
      ...runningPm2,
      existsSync: () => true,
      spawn: spawn as any,
      execPath: '/Electron',
      env: {},
    });
    void pending.catch(() => {});

    await vi.advanceTimersByTimeAsync(defaultPm2ListTimeoutMs - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).rejects.toThrow(`PM2 jlist timed out after ${defaultPm2ListTimeoutMs}ms`);
    expect(child.kill).toHaveBeenCalled();
  });

  it('uses the discovered login shell PATH when spawning PM2 for a wrapper runtime', async () => {
    const child = childProcessStub();
    const { spawn, calls } = trackedSpawn(child);
    const shellPath = '/Users/me/.nvm/versions/node/v22.22.2/bin:/usr/bin:/bin';
    const promise = listPm2Apps(paths, {
      ...runtime,
      binPath: '/home/.botmux/bin/botmux',
      pathEnv: shellPath,
    }, {
      ...runningPm2,
      existsSync: () => true,
      spawn: spawn as any,
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 10_000,
    });

    child.stdout.emit('data', '[]');
    child.emit('close', 0);

    expect(await promise).toEqual([]);
    const pathEntries = calls[0][2].env.PATH!.split(':');
    expect(pathEntries.indexOf('/Users/me/.nvm/versions/node/v22.22.2/bin')).toBeGreaterThan(-1);
    expect(pathEntries.indexOf('/Users/me/.nvm/versions/node/v22.22.2/bin')).toBeLessThan(pathEntries.indexOf('/usr/bin'));
  });

  it('does not spawn PM2 while listing an absent daemon', async () => {
    const { spawn, calls } = trackedSpawn();
    expect(await listPm2Apps(paths, runtime, {
      existsSync: () => true,
      spawn: spawn as any,
      pm2QueryAvailable: () => false,
    })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
