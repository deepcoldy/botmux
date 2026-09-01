import { describe, expect, it, vi } from 'bun:test';

// The Windows probe behaviour cannot be proven on Linux CI with a fake
// executable: a shebang script named pnpm.cmd runs without a shell, so even
// removing `shell` keeps such tests green. Assert the spawnSync contract
// directly instead. Mocked before importing the module under test.
const spawnSync = vi.fn(() => ({ status: 1, stdout: '' }));
vi.mock('node:child_process', () => ({ spawnSync }));

const { tryResolveGlobalInstallPlan } = await import('../src/utils/global-install.js');

const STORE_REALPATH
  = String.raw`C:\pnpm\store\v11\links\@\botmux\3.11.0\hash\node_modules\botmux`;

describe('pnpm global probe spawn contract', () => {
  it('spawns pnpm.cmd through a shell with a hard SIGKILL timeout on win32', () => {
    expect(tryResolveGlobalInstallPlan(STORE_REALPATH, 'win32')).toBeNull();
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith(
      'pnpm.cmd',
      ['list', '-g', '--depth', '0', '--json'],
      expect.objectContaining({
        shell: true,
        timeout: 5_000,
        killSignal: 'SIGKILL',
      }),
    );
  });

  it('spawns plain pnpm without a shell but with the hard timeout on POSIX', () => {
    spawnSync.mockClear();
    const root = '/home/bot/.local/share/pnpm/store/v11/links/@/botmux/3.11.0/hash/node_modules/botmux';
    expect(tryResolveGlobalInstallPlan(root, 'linux')).toBeNull();
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith(
      'pnpm',
      ['list', '-g', '--depth', '0', '--json'],
      expect.objectContaining({
        shell: false,
        timeout: 5_000,
        killSignal: 'SIGKILL',
      }),
    );
  });
});
