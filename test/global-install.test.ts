import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    expect(detectGlobalInstallManager(root, 'linux')).toBe('pnpm');
  });

  it('uses pnpm root -g for a custom global-dir and fails closed without its stable link', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'botmux-pnpm11-custom-global-'));
    const previousPath = process.env.PATH;
    try {
      const pnpmHome = join(tempRoot, 'pnpm');
      const storeRoot = join(pnpmHome, 'store', 'v11', 'links', '@', 'botmux', '3.11.0', 'hash');
      const packageRoot = join(storeRoot, 'node_modules', 'botmux');
      const customGlobal = join(tempRoot, 'custom-global');
      const globalRoot = join(customGlobal, 'v11');
      const fakePnpm = join(tempRoot, 'bin', 'pnpm');
      mkdirSync(packageRoot, { recursive: true });
      mkdirSync(join(tempRoot, 'bin'), { recursive: true });
      writeFileSync(fakePnpm, `#!/bin/sh\nprintf '%s\\n' '[{"path":"${globalRoot}"}]'\n`);
      chmodSync(fakePnpm, 0o755);
      process.env.PATH = `${join(tempRoot, 'bin')}:${previousPath ?? ''}`;

      expect(tryResolveGlobalInstallPlan(packageRoot, 'linux')).toBeNull();

      const runtimeRoot = join(globalRoot, 'runtime');
      const stableDir = join(globalRoot, 'stable-hash');
      mkdirSync(join(runtimeRoot, 'node_modules'), { recursive: true });
      symlinkSync(packageRoot, join(runtimeRoot, 'node_modules', 'botmux'), 'dir');
      symlinkSync(runtimeRoot, stableDir, 'dir');

      const plan = resolveGlobalInstallPlan(packageRoot, 'linux');
      expect(plan.args).toEqual([
        'add', '-g', '--global-dir', customGlobal, 'botmux@latest',
      ]);
      expect(plan.activePackageRoot).toBe(join(stableDir, 'node_modules', 'botmux'));
    } finally {
      process.env.PATH = previousPath;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when the pnpm global probe hangs', { timeout: 20_000 }, () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'botmux-pnpm11-hang-'));
    const previousPath = process.env.PATH;
    try {
      const storeRoot = join(tempRoot, 'pnpm', 'store', 'v11', 'links', '@', 'botmux', '3.11.0', 'hash');
      const packageRoot = join(storeRoot, 'node_modules', 'botmux');
      const fakePnpm = join(tempRoot, 'bin', 'pnpm');
      mkdirSync(packageRoot, { recursive: true });
      mkdirSync(join(tempRoot, 'bin'), { recursive: true });
      writeFileSync(fakePnpm, '#!/bin/sh\nsleep 60\n');
      chmodSync(fakePnpm, 0o755);
      process.env.PATH = `${join(tempRoot, 'bin')}:${previousPath ?? ''}`;

      const startedAt = Date.now();
      expect(tryResolveGlobalInstallPlan(packageRoot, 'linux')).toBeNull();
      const elapsed = Date.now() - startedAt;
      // The probe must have been killed by its 5s hard timeout, not waited
      // out (sleep 60) and not failed instantly for an unrelated reason
      // (e.g. ENOENT would return in ~0s and pass the upper bound vacuously).
      expect(elapsed).toBeGreaterThanOrEqual(4_000);
      expect(elapsed).toBeLessThan(15_000);
    } finally {
      process.env.PATH = previousPath;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('runs the pnpm global probe through the shell for a Windows store realpath', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'botmux-pnpm11-win32-'));
    const previousPath = process.env.PATH;
    try {
      const pnpmHome = join(tempRoot, 'pnpm');
      const storeRoot = join(pnpmHome, 'store', 'v11', 'links', '@', 'botmux', '3.11.0', 'hash');
      const packageRoot = join(storeRoot, 'node_modules', 'botmux');
      const customGlobal = join(tempRoot, 'custom-global');
      const globalRoot = join(customGlobal, 'v11');
      // On win32 the probe spawns `pnpm.cmd` via the shell; a shebang script
      // named pnpm.cmd is executable by sh, so the same spawn path is covered.
      // The marker records the exact argv the probe passed, proving it ran
      // AND with the expected arguments (a spawn failure or wrong args would
      // leave the marker absent and fail closed for the wrong reason).
      const probeMarker = join(tempRoot, 'probe-argv');
      const fakePnpm = join(tempRoot, 'bin', 'pnpm.cmd');
      mkdirSync(packageRoot, { recursive: true });
      mkdirSync(join(tempRoot, 'bin'), { recursive: true });
      writeFileSync(
        fakePnpm,
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${probeMarker}'\nprintf '%s\\n' '[{"path":"${globalRoot}"}]'\n`,
      );
      chmodSync(fakePnpm, 0o755);
      process.env.PATH = `${join(tempRoot, 'bin')}:${previousPath ?? ''}`;

      // Probe runs but no stable link resolves: must fail closed, not throw.
      expect(tryResolveGlobalInstallPlan(packageRoot, 'win32')).toBeNull();
      expect(readFileSync(probeMarker, 'utf8').split('\n').filter(Boolean)).toEqual([
        'list', '-g', '--depth', '0', '--json',
      ]);
    } finally {
      process.env.PATH = previousPath;
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
