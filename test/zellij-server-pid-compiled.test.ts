/**
 * findServerPid runs zellij-socket-probe as a child process. A compiled
 * single-file binary IS the CLI, so the Node form `<binary> <probe.js> <sock>
 * <pids>` printed the help banner and exited 0: Number(help) is NaN, every
 * lookup returned null, and a live adopted zellij session read as gone and was
 * closed. The compiled form must re-enter the binary through its hidden entry.
 *
 * `isStandaloneBinary()` runs for real (it keys off `process.argv[1]` starting
 * with `/$bunfs/`), as in cli-subcommand-spawn-form.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findServerPid } from '../src/adapters/backend/zellij-backend.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(), spawnSync: vi.fn() };
});

const REAL_ARGV1 = process.argv[1];

describe.runIf(process.platform === 'linux')('findServerPid socket probe launch', () => {
  let dir: string;
  let sock: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zellij-probe-launch-'));
    sock = join(dir, 'renamed');
    writeFileSync(sock, '');
    vi.mocked(execFileSync).mockReturnValue(` 4242 zellij --server ${join(dir, 'spawn-name')}\n` as never);
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '4242' } as never);
  });

  afterEach(() => {
    process.argv[1] = REAL_ARGV1;
    vi.mocked(spawnSync).mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  it('compiled binary runs the probe through its hidden entry, not a script path', () => {
    process.argv[1] = '/$bunfs/root/cli.js';
    expect(findServerPid('renamed')).toBe(4242);
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath, ['__zellij-socket-probe', sock, '4242'], expect.anything());
  });

  it('Node form still runs the probe script next to the backend module', () => {
    expect(findServerPid('renamed')).toBe(4242);
    expect(spawnSync).toHaveBeenCalledWith(process.execPath, [
      fileURLToPath(new URL('../src/adapters/backend/zellij-socket-probe.js', import.meta.url)), sock, '4242',
    ], expect.anything());
  });
});
