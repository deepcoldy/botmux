/**
 * Regression test for the dashboard manual-update failing with
 * `npm exited 7 ... { errno: -2, code: 'ENOENT', syscall: 'uv_cwd' }`.
 *
 * Root cause: the dashboard process runs with cwd=PKG_ROOT (its checkout dir);
 * when that dir is deleted, the npm child inherited the dead cwd and crashed at
 * startup. The fix pins an explicit, guaranteed-live cwd (safeCwd()) on the
 * spawn, so this asserts the npm install is launched FROM that dir.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { runNpmInstallLatest } from '../src/dashboard/npm-install.js';

const mockedSpawn = vi.mocked(spawn);

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  unref = vi.fn();
  kill = vi.fn(() => true);
}

describe('runNpmInstallLatest', () => {
  const made: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    mockedSpawn.mockReset();
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('spawns `npm install -g botmux@latest` from a guaranteed-live cwd (not the possibly-dead process cwd)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-npm-home-'));
    made.push(home);
    mkdirSync(join(home, '.botmux'));
    vi.stubEnv('HOME', home);

    const child = new FakeChild();
    mockedSpawn.mockReturnValue(child as never);

    const p = runNpmInstallLatest();
    child.emit('exit', 0);
    await expect(p).resolves.toBeUndefined();

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockedSpawn.mock.calls[0];
    expect(cmd).toBe('npm');
    expect(args).toEqual(['install', '-g', 'botmux@latest']);
    expect((opts as { cwd?: string }).cwd).toBe(join(home, '.botmux'));
  });

  it('rejects with the npm exit code + stderr tail on a non-zero exit, still launched from the safe cwd', async () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-npm-home-'));
    made.push(home);
    mkdirSync(join(home, '.botmux'));
    vi.stubEnv('HOME', home);

    const child = new FakeChild();
    mockedSpawn.mockReturnValue(child as never);

    const p = runNpmInstallLatest();
    child.stderr.emit('data', Buffer.from('uv_cwd ENOENT'));
    child.emit('exit', 7);
    await expect(p).rejects.toThrow(/npm exited 7/);
    expect((mockedSpawn.mock.calls[0][2] as { cwd?: string }).cwd).toBe(join(home, '.botmux'));
  });
});
