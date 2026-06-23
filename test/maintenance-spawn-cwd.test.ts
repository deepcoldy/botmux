/**
 * The dashboard's restart button (and the auto-update restart) go through
 * spawnDetachedRestart, which is reachable from the dashboard process whose
 * cwd=PKG_ROOT may have been deleted. `setsid`/`node` read getcwd() at startup,
 * so the restart driver must be launched from a guaranteed-live cwd. This is a
 * separate file from maintenance.test.ts because it module-mocks node:child_process
 * (maintenance.test.ts deliberately uses pure deps injection instead).
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

import { execSync, spawn } from 'node:child_process';
import { spawnDetachedRestart } from '../src/core/maintenance.js';

const mockedSpawn = vi.mocked(spawn);
const mockedExecSync = vi.mocked(execSync);

class FakeChild extends EventEmitter {
  unref = vi.fn();
  kill = vi.fn(() => true);
}

describe('spawnDetachedRestart', () => {
  const made: string[] = [];
  const stubHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-restart-home-'));
    made.push(home);
    mkdirSync(join(home, '.botmux')); // so safeCwd() resolves to <home>/.botmux
    vi.stubEnv('HOME', home);
    return home;
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    mockedSpawn.mockReset();
    mockedExecSync.mockReset();
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('launches the restart driver from a guaranteed-live cwd (not the process cwd, which may be a deleted checkout)', () => {
    const home = stubHome();
    mockedExecSync.mockReturnValue(Buffer.from('')); // setsidAvailable() probe succeeds
    mockedSpawn.mockReturnValue(new FakeChild() as never);

    spawnDetachedRestart('test');

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const opts = mockedSpawn.mock.calls[0][2] as { cwd?: string; detached?: boolean };
    expect(opts.cwd).toBe(join(home, '.botmux'));
    expect(opts.detached).toBe(true);
  });

  it('uses the safe cwd even when setsid is unavailable (probe throws → plain node fallback)', () => {
    const home = stubHome();
    mockedExecSync.mockImplementation(() => { throw new Error('no setsid'); });
    mockedSpawn.mockReturnValue(new FakeChild() as never);

    spawnDetachedRestart('test');

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [cmd, , opts] = mockedSpawn.mock.calls[0];
    expect(cmd).toBe(process.execPath); // fallback: `node <cli> restart`, not setsid
    expect((opts as { cwd?: string }).cwd).toBe(join(home, '.botmux'));
  });

  it('passes an explicit cwd to the `command -v setsid` availability probe too', () => {
    const home = stubHome();
    mockedExecSync.mockReturnValue(Buffer.from(''));
    mockedSpawn.mockReturnValue(new FakeChild() as never);

    spawnDetachedRestart('test');

    const probe = mockedExecSync.mock.calls.find(c => String(c[0]).includes('setsid'));
    expect(probe).toBeTruthy();
    expect((probe![1] as { cwd?: string }).cwd).toBe(join(home, '.botmux'));
  });
});
