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

const runningPm2 = { pm2QueryAvailable: () => true };

describe('desktop PM2 app listing', () => {
  it('passes the inspected God generation to the read-only helper', async () => {
    const child = childProcessStub();
    const spawn = vi.fn(() => child);
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

    await expect(promise).resolves.toEqual([]);
    const env = (spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env;
    expect(JSON.parse(env.BOTMUX_PM2_EXPECTED_GOD!)).toEqual(expectedGod);
  });

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
      ...runningPm2,
      existsSync: () => true,
      spawn: spawn as any,
      env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' },
    });

    child.stdout.emit('data', '[]');
    child.emit('close', 0);
    await expect(promise).resolves.toEqual([]);
    expect(spawn).toHaveBeenCalledWith(
      bundled.nodePath,
      [`${bundled.root}/dist/cli/pm2-readonly-client.js`, 'jlist'],
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
      ...runningPm2,
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
    const spawn = vi.fn(() => child);
    const promise = listPm2Apps(paths, runtime, {
      ...runningPm2,
      existsSync: () => true,
      spawn: spawn as any,
      execPath: '/Electron',
      env: {},
    });

    child.emit('close', 3);

    await expect(promise).resolves.toEqual([]);
  });

  // The next two tests must START the call, advance the fake timers, and only
  // THEN build the `.rejects` assertion — never `expect(call).rejects` before the
  // advance. Reason (bun-specific, measured on bun 1.4.0): bun's
  // `expect(promise).rejects/.resolves` EAGERLY DRAINS THE EVENT LOOP while the
  // assertion object is being CONSTRUCTED, so construction blocks until the
  // promise settles (measured: `expect(p).resolves.toBe(...)` on a promise that
  // settles in 300ms takes 301ms to construct, while `p.then(v => v)` takes 0ms).
  // vitest's `.rejects` does not do this — it returns a thenable immediately
  // (same probe under vitest: 1ms) — which is why the old shape was green there.
  // Here the promise can only settle once `vi.advanceTimersByTimeAsync` fires the
  // SUT's timeout timer, so constructing the assertion first deadlocks: the spin
  // waits for a fake timer that only the not-yet-reached advance line can fire.
  // And because it is a synchronous busy spin (bun at ~40-70% CPU, STAT=R), bun's
  // own `--timeout` watchdog cannot interrupt it: the process is SIGKILLed with no
  // summary line, which suppressed the OTHER 8 tests in this file too (bun
  // reported 0 of 10 tests).
  //
  // The `void call.catch(() => undefined)` guard is required by the OTHER runner:
  // once the assertion moves after the advance, the rejection is momentarily
  // unobserved, and vitest then fails the run with "Vitest caught 2 unhandled
  // errors ... might cause false positive tests" (measured with the guard deleted;
  // bun alone did not complain). It attaches a no-op observer only — it asserts
  // nothing, and every assertion below is unchanged and still awaited.
  it('rejects and kills PM2 discovery when it times out', async () => {
    vi.useFakeTimers();
    const child = childProcessStub();
    const spawn = vi.fn(() => child);
    const call = listPm2Apps(paths, runtime, {
      ...runningPm2,
      existsSync: () => true,
      spawn: spawn as any,
      execPath: '/Electron',
      env: {},
      timeoutMs: 25,
    });
    void call.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(25);

    await expect(call).rejects.toThrow('timed out');
    expect(child.kill).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('uses a desktop-friendly default timeout before marking PM2 discovery failed', async () => {
    vi.useFakeTimers();
    const child = childProcessStub();
    const spawn = vi.fn(() => child);
    // Same deferral as above (see the comment on the previous test). The
    // `defaultPm2ListTimeoutMs - 1` / `+1` boundary check is unchanged: kill must
    // still not have fired one tick BEFORE the deadline, only after it.
    const call = listPm2Apps(paths, runtime, {
      ...runningPm2,
      existsSync: () => true,
      spawn: spawn as any,
      execPath: '/Electron',
      env: {},
    });
    void call.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(defaultPm2ListTimeoutMs - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(call).rejects.toThrow(`PM2 jlist timed out after ${defaultPm2ListTimeoutMs}ms`);
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
      ...runningPm2,
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

  it('does not spawn PM2 while listing an absent daemon', async () => {
    const spawn = vi.fn();
    await expect(listPm2Apps(paths, runtime, {
      existsSync: () => true,
      spawn: spawn as any,
      pm2QueryAvailable: () => false,
    })).resolves.toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });
});
