import { describe, expect, it } from 'vitest';
import {
  detectGlobalInstallManager,
  formatGlobalInstallCommand,
  resolveGlobalInstallPlan,
  tryResolveGlobalInstallPlan,
  UnsupportedGlobalInstallError,
} from '../src/utils/global-install.js';

describe('resolveGlobalInstallPlan', () => {
  it('targets the exact POSIX npm prefix', () => {
    const plan = resolveGlobalInstallPlan('/home/bot/.local/lib/node_modules/botmux', 'linux');
    expect(plan).toEqual({
      manager: 'npm',
      command: 'npm',
      args: ['install', '-g', '--prefix', '/home/bot/.local', 'botmux@latest'],
      activePackageRoot: '/home/bot/.local/lib/node_modules/botmux',
    });
  });

  it('targets the exact Windows npm prefix', () => {
    const plan = resolveGlobalInstallPlan(String.raw`D:\tools\npm-global\node_modules\botmux`, 'win32');
    expect(plan.args).toEqual([
      'install', '-g', '--prefix', String.raw`D:\tools\npm-global`, 'botmux@latest',
    ]);
    expect(plan.activePackageRoot).toBe(String.raw`D:\tools\npm-global\node_modules\botmux`);
  });

  it('targets pnpm global-dir and returns the stable package symlink for a runtime realpath', () => {
    const plan = resolveGlobalInstallPlan(
      '/home/bot/.local/share/pnpm/global/5/.pnpm/botmux@3.2.1/node_modules/botmux',
      'linux',
    );
    expect(plan).toEqual({
      manager: 'pnpm',
      command: 'pnpm',
      args: ['add', '-g', '--global-dir', '/home/bot/.local/share/pnpm/global', 'botmux@latest'],
      activePackageRoot: '/home/bot/.local/share/pnpm/global/5/node_modules/botmux',
    });
  });

  it('recognises the real pnpm global virtual-store path shape', () => {
    expect(detectGlobalInstallManager(
      '/home/bot/.local/share/pnpm/global/5/.pnpm/botmux@3.2.1/node_modules/botmux',
      'linux',
    )).toBe('pnpm');
  });

  it('recognises a preserved standard pnpm global symlink', () => {
    const root = '/home/bot/.local/share/pnpm/global/5/node_modules/botmux';
    const plan = resolveGlobalInstallPlan(root, 'linux');
    expect(plan.manager).toBe('pnpm');
    expect(plan.activePackageRoot).toBe(root);
  });

  it('handles a Windows pnpm virtual-store path', () => {
    const plan = resolveGlobalInstallPlan(
      String.raw`D:\pnpm\global\5\.pnpm\botmux@3.2.1\node_modules\botmux`,
      'win32',
    );
    expect(plan.manager).toBe('pnpm');
    expect(plan.args).toEqual([
      'add', '-g', '--global-dir', 'D:/pnpm/global', 'botmux@latest',
    ]);
    expect(plan.activePackageRoot).toBe(String.raw`D:\pnpm\global\5\node_modules\botmux`);
  });

  it.each([
    ['/home/bot/.config/yarn/global/node_modules/botmux', 'yarn'],
    ['/home/bot/.bun/install/global/node_modules/botmux', 'bun'],
    ['/opt/custom/node_modules/botmux', 'unknown'],
    ['/work/botmux', 'unknown'],
  ] as const)('rejects unsupported ownership for %s', (root, manager) => {
    expect(detectGlobalInstallManager(root, 'linux')).toBe(manager);
    expect(() => resolveGlobalInstallPlan(root, 'linux')).toThrow(UnsupportedGlobalInstallError);
    expect(tryResolveGlobalInstallPlan(root, 'linux')).toBeNull();
  });

  it('formats paths with spaces for display', () => {
    const plan = resolveGlobalInstallPlan('/home/bot/My Prefix/lib/node_modules/botmux', 'linux');
    expect(formatGlobalInstallCommand(plan)).toBe(
      'npm install -g --prefix "/home/bot/My Prefix" botmux@latest',
    );
  });
});
