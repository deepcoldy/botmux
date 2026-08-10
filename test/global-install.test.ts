import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  detectGlobalInstallManager,
  formatGlobalInstallCommand,
  resolveGlobalInstallPlan,
  tryResolveGlobalInstallPlan,
  UnsupportedGlobalInstallError,
  withGlobalInstallRegistry,
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

  it('recognises the pnpm 11 isolated global runtime layout', () => {
    const root = '/home/bot/.local/share/pnpm/global/v11/2bd754-19fd4ccaab4-b6f57fa0272de3b8/node_modules/botmux';
    const plan = resolveGlobalInstallPlan(root, 'linux');
    expect(plan).toMatchObject({
      manager: 'pnpm',
      command: 'pnpm',
      args: ['add', '-g', '--global-dir', '/home/bot/.local/share/pnpm/global', 'botmux@latest'],
      activePackageRoot: root,
    });
    expect(detectGlobalInstallManager(root, 'linux')).toBe('pnpm');
  });

  it('uses the stable pnpm 11 symlink for post-update operations', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'botmux-pnpm11-'));
    try {
      const globalDir = join(tempRoot, 'pnpm', 'global');
      const layoutDir = join(globalDir, 'v11');
      const runtimeDir = join(layoutDir, 'runtime-dir');
      const stableDir = join(layoutDir, 'a'.repeat(64));
      const packageRoot = join(runtimeDir, 'node_modules', 'botmux');
      mkdirSync(packageRoot, { recursive: true });
      symlinkSync('runtime-dir', stableDir, 'dir');

      const plan = resolveGlobalInstallPlan(packageRoot, 'linux');

      expect(plan.activePackageRoot).toBe(join(stableDir, 'node_modules', 'botmux'));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('recognises the pnpm 11 store realpath behind a global symlink', () => {
    const root = '/home/bot/.local/share/pnpm/store/v11/links/@/botmux/3.11.0/hash/node_modules/botmux';
    const plan = resolveGlobalInstallPlan(root, 'linux');
    expect(plan).toMatchObject({
      manager: 'pnpm',
      command: 'pnpm',
      args: ['add', '-g', '--global-dir', '/home/bot/.local/share/pnpm/global', 'botmux@latest'],
    });
    expect(detectGlobalInstallManager(root, 'linux')).toBe('pnpm');
  });

  it('uses the stable pnpm 11 global symlink for a store realpath', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'botmux-pnpm11-store-'));
    try {
      const pnpmHome = join(tempRoot, 'pnpm');
      const storeRoot = join(pnpmHome, 'store', 'v11', 'links', '@', 'botmux', '3.11.0', 'hash');
      const packageRoot = join(storeRoot, 'node_modules', 'botmux');
      const globalRoot = join(pnpmHome, 'global', 'v11');
      const stableDir = join(globalRoot, 'stable-hash');
      mkdirSync(packageRoot, { recursive: true });
      mkdirSync(globalRoot, { recursive: true });
      symlinkSync(storeRoot, stableDir, 'dir');

      const plan = resolveGlobalInstallPlan(packageRoot, 'linux');

      expect(plan.activePackageRoot).toBe(join(stableDir, 'node_modules', 'botmux'));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves the Windows pnpm 11 global-dir path', () => {
    const root = String.raw`D:\pnpm\global\v11\2bd754-19fd4ccaab4-b6f57fa0272de3b8\node_modules\botmux`;
    const plan = resolveGlobalInstallPlan(root, 'win32');
    expect(plan.manager).toBe('pnpm');
    expect(plan.args).toEqual([
      'add', '-g', '--global-dir', 'D:/pnpm/global', 'botmux@latest',
    ]);
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

  it('pins Bun updates to the owning POSIX global package and bin directories', () => {
    const root = '/home/bot/.bun/install/global/node_modules/botmux';
    const plan = resolveGlobalInstallPlan(root, 'linux');
    expect(plan).toEqual({
      manager: 'bun',
      command: 'bun',
      args: ['add', '-g', 'botmux@latest'],
      env: {
        BUN_INSTALL_GLOBAL_DIR: '/home/bot/.bun/install/global',
        BUN_INSTALL_BIN: '/home/bot/.bun/bin',
      },
      activePackageRoot: root,
    });
  });

  it('pins Bun updates to the owning Windows global package and bin directories', () => {
    const root = String.raw`D:\Users\bot\.bun\install\global\node_modules\botmux`;
    const plan = resolveGlobalInstallPlan(root, 'win32');
    expect(plan.manager).toBe('bun');
    expect(plan.args).toEqual(['add', '-g', 'botmux@latest']);
    expect(plan.env).toEqual({
      BUN_INSTALL_GLOBAL_DIR: String.raw`D:\Users\bot\.bun\install\global`,
      BUN_INSTALL_BIN: String.raw`D:\Users\bot\.bun\bin`,
    });
    expect(plan.activePackageRoot).toBe(root);
  });

  it.each([
    ['/home/bot/.config/yarn/global/node_modules/botmux', 'yarn'],
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

  it('passes an exact rollback package spec to npm, pnpm, and Bun', () => {
    expect(resolveGlobalInstallPlan(
      '/home/bot/.local/lib/node_modules/botmux',
      'linux',
      'botmux@3.0.0',
    ).args).toEqual(['install', '-g', '--prefix', '/home/bot/.local', 'botmux@3.0.0']);
    expect(resolveGlobalInstallPlan(
      '/home/bot/.local/share/pnpm/global/5/.pnpm/botmux@3.1.0/node_modules/botmux',
      'linux',
      'botmux@3.0.0',
    ).args.at(-1)).toBe('botmux@3.0.0');
    expect(resolveGlobalInstallPlan(
      '/home/bot/.bun/install/global/node_modules/botmux',
      'linux',
      'botmux@3.0.0',
    ).args).toEqual(['add', '-g', 'botmux@3.0.0']);
  });

  it.each([
    ['npm', '/home/bot/.local/lib/node_modules/botmux'],
    ['pnpm', '/home/bot/.local/share/pnpm/global/5/.pnpm/botmux@3.1.0/node_modules/botmux'],
    ['bun', '/home/bot/.bun/install/global/node_modules/botmux'],
  ] as const)('pins a %s rollback plan to the public npm registry', (_manager, root) => {
    const plan = resolveGlobalInstallPlan(root, 'linux', 'botmux@3.0.0');
    const pinned = withGlobalInstallRegistry(plan);

    expect(pinned).not.toBe(plan);
    expect(pinned.args).toEqual(plan.args);
    expect(pinned.env).toMatchObject({
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      npm_config_registry: 'https://registry.npmjs.org/',
      BUN_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    });
    expect(plan.env?.NPM_CONFIG_REGISTRY).toBeUndefined();
  });

  it('preserves Bun install directories while overriding inherited registry config', () => {
    const plan = resolveGlobalInstallPlan(
      '/home/bot/.bun/install/global/node_modules/botmux',
      'linux',
      'botmux@3.0.0',
    );
    plan.env = {
      ...plan.env,
      NPM_CONFIG_REGISTRY: 'https://registry.example/',
      npm_config_registry: 'https://registry.example/',
      BUN_CONFIG_REGISTRY: 'https://registry.example/',
    };

    expect(withGlobalInstallRegistry(plan).env).toEqual({
      BUN_INSTALL_GLOBAL_DIR: '/home/bot/.bun/install/global',
      BUN_INSTALL_BIN: '/home/bot/.bun/bin',
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      npm_config_registry: 'https://registry.npmjs.org/',
      BUN_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    });
  });
});
