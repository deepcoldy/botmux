import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverExternalRuntimeCandidate, selectExternalRuntimeCandidate } from '../../src/desktop/main/external-runtime.js';

const paths = {
  botmuxHome: '/home/.botmux',
  dataDir: '/home/.botmux/data',
  logsDir: '/home/.botmux/logs',
  pm2Home: '/home/.botmux/pm2',
};

describe('desktop external CLI runtime wiring', () => {
  it('wires external CLI discovery into the runtime service', () => {
    const mainSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/main.ts', import.meta.url)),
      'utf-8',
    );

    expect(mainSource).toContain('discoverExternalRuntimeCandidate');
    expect(mainSource).toContain('discoverExternalRuntime: () => discoverExternalRuntimeCandidate(paths)');
  });

  it('selects an npm-installed botmux runtime outside the bundled app', () => {
    const files = new Map([
      ['/usr/local/lib/node_modules/botmux/package.json', JSON.stringify({ name: 'botmux', version: '2.9.0' })],
      ['/usr/local/lib/node_modules/botmux/dist/cli.js', ''],
    ]);

    const candidate = selectExternalRuntimeCandidate([
      {
        binPath: '/usr/local/bin/botmux',
        root: '/usr/local/lib/node_modules/botmux',
      },
    ], paths, {
      existsSync: path => files.has(path),
      readFileSync: path => files.get(path) ?? '',
      realpathSync: path => path,
    });

    expect(candidate).toEqual({
      kind: 'external',
      root: '/usr/local/lib/node_modules/botmux',
      cliPath: '/usr/local/lib/node_modules/botmux/dist/cli.js',
      binPath: '/usr/local/bin/botmux',
      version: '2.9.0',
      runtimeSource: 'global-cli',
    });
  });

  it('treats linked local wrappers as the global CLI contract', () => {
    const files = new Map([
      ['/Users/me/src/botmux/.git', ''],
      ['/Users/me/src/botmux/package.json', JSON.stringify({ name: 'botmux', version: '2.9.0' })],
      ['/Users/me/src/botmux/dist/cli.js', ''],
    ]);

    const candidate = selectExternalRuntimeCandidate([
      {
        binPath: '/Users/me/bin/botmux',
        root: '/Users/me/src/botmux',
      },
    ], paths, {
      existsSync: path => files.has(path),
      readFileSync: path => files.get(path) ?? '',
      realpathSync: path => path,
    });

    expect(candidate).toMatchObject({
      runtimeSource: 'global-cli',
      binPath: '/Users/me/bin/botmux',
    });
  });

  it('derives linked global CLI version from git tags when package.json is unstamped', () => {
    const files = new Map([
      ['/Users/me/src/botmux/.git', ''],
      ['/Users/me/src/botmux/package.json', JSON.stringify({ name: 'botmux', version: '0.0.0' })],
      ['/Users/me/src/botmux/dist/cli.js', ''],
    ]);

    const candidate = selectExternalRuntimeCandidate([
      {
        binPath: '/Users/me/bin/botmux',
        root: '/Users/me/src/botmux',
      },
    ], paths, {
      existsSync: path => files.has(path),
      readFileSync: path => files.get(path) ?? '',
      realpathSync: path => path,
      execFileSync: (file, args, options) => {
        expect(file).toBe('git');
        expect(args).toEqual(['describe', '--tags', '--abbrev=0']);
        expect(options.cwd).toBe('/Users/me/src/botmux');
        return 'v2.96.0\n';
      },
    });

    expect(candidate).toMatchObject({
      runtimeSource: 'global-cli',
      version: '2.96.0',
    });
  });

  it('prefers the shell-visible npm global CLI over fallback source wrappers', () => {
    const files = new Map([
      ['/Users/me/src/botmux/.git', ''],
      ['/Users/me/src/botmux/package.json', JSON.stringify({ name: 'botmux', version: '0.0.0' })],
      ['/Users/me/src/botmux/dist/cli.js', ''],
      ['/Users/me/.nvm/versions/node/v22.22.2/lib/node_modules/botmux/package.json', JSON.stringify({ name: 'botmux', version: '2.32.0' })],
      ['/Users/me/.nvm/versions/node/v22.22.2/lib/node_modules/botmux/dist/cli.js', ''],
    ]);

    const candidate = selectExternalRuntimeCandidate([
      {
        binPath: '/Users/me/.nvm/versions/node/v22.22.2/bin/botmux',
        root: '/Users/me/.nvm/versions/node/v22.22.2/lib/node_modules/botmux',
      },
      {
        binPath: '/Users/me/.botmux/bin/botmux',
        root: '/Users/me/src/botmux',
      },
    ], paths, {
      existsSync: path => files.has(path),
      readFileSync: path => files.get(path) ?? '',
      realpathSync: path => path,
    });

    expect(candidate).toMatchObject({
      runtimeSource: 'global-cli',
      binPath: '/Users/me/.nvm/versions/node/v22.22.2/bin/botmux',
      root: '/Users/me/.nvm/versions/node/v22.22.2/lib/node_modules/botmux',
      version: '2.32.0',
    });
  });

  it('discovers the shell PATH CLI before the user-owned ~/.botmux/bin wrapper', () => {
    const files = new Map([
      ['/home/.botmux/bin/botmux', '#!/bin/sh\nexec node "/Users/me/src/botmux/dist/cli.js" "$@"\n'],
      ['/Users/me/src/botmux/.git', ''],
      ['/Users/me/src/botmux/package.json', JSON.stringify({ name: 'botmux', version: '0.0.0' })],
      ['/Users/me/src/botmux/dist/cli.js', ''],
      ['/Users/me/.nvm/versions/node/v22.22.2/lib/node_modules/botmux/package.json', JSON.stringify({ name: 'botmux', version: '2.32.0' })],
      ['/Users/me/.nvm/versions/node/v22.22.2/lib/node_modules/botmux/dist/cli.js', ''],
    ]);

    const candidate = discoverExternalRuntimeCandidate(paths, {
      platform: 'darwin',
      execFileSync: file => file === 'which'
        ? '/Users/me/.nvm/versions/node/v22.22.2/bin/botmux\n'
        : '',
      existsSync: path => files.has(path),
      readFileSync: path => files.get(path) ?? '',
      realpathSync: path => path === '/Users/me/.nvm/versions/node/v22.22.2/bin/botmux'
        ? '/Users/me/.nvm/versions/node/v22.22.2/lib/node_modules/botmux/dist/cli.js'
        : path,
      statSync: path => ({ size: files.get(path)?.length ?? 100_000 }),
    });

    expect(candidate).toMatchObject({
      runtimeSource: 'global-cli',
      binPath: '/Users/me/.nvm/versions/node/v22.22.2/bin/botmux',
      root: '/Users/me/.nvm/versions/node/v22.22.2/lib/node_modules/botmux',
      version: '2.32.0',
    });
  });

  it('keeps the login shell PATH for a wrapper discovered through zsh', () => {
    const shellPath = '/Users/me/.nvm/versions/node/v22.22.2/bin:/usr/bin:/bin';
    const files = new Map([
      ['/home/.botmux/bin/botmux', '#!/bin/sh\nexec node "/Users/me/src/botmux/dist/cli.js" "$@"\n'],
      ['/Users/me/src/botmux/.git', ''],
      ['/Users/me/src/botmux/package.json', JSON.stringify({ name: 'botmux', version: '0.0.0' })],
      ['/Users/me/src/botmux/dist/cli.js', ''],
    ]);

    const candidate = discoverExternalRuntimeCandidate(paths, {
      platform: 'darwin',
      execFileSync: file => file === '/bin/zsh'
        ? `__BOTMUX_PATH__${shellPath}\n/home/.botmux/bin/botmux\n`
        : '',
      existsSync: path => files.has(path),
      readFileSync: path => files.get(path) ?? '',
      realpathSync: path => path,
      statSync: path => ({ size: files.get(path)?.length ?? 100_000 }),
    });

    expect(candidate).toMatchObject({
      binPath: '/home/.botmux/bin/botmux',
      root: '/Users/me/src/botmux',
      pathEnv: shellPath,
    });
  });

  it('does not invent an app-private runtime when no global CLI can be resolved', () => {
    const candidate = discoverExternalRuntimeCandidate(paths, {
      binPaths: [],
      existsSync: () => false,
      readFileSync: () => '',
      realpathSync: path => path,
      statSync: () => ({ size: 100_000 }),
    });

    // Desktop is CLI-first: without a shell-visible botmux command, it should
    // enter setup/degraded state instead of falling back to an app-owned runtime.
    expect(candidate).toBeNull();
  });

  it('resolves a botmux bin symlink into an external runtime candidate', () => {
    const files = new Map([
      ['/usr/local/lib/node_modules/botmux/package.json', JSON.stringify({ name: 'botmux', version: '2.9.0' })],
      ['/usr/local/lib/node_modules/botmux/dist/cli.js', ''],
    ]);

    const candidate = discoverExternalRuntimeCandidate(paths, {
      binPaths: ['/usr/local/bin/botmux'],
      existsSync: path => files.has(path),
      readFileSync: path => files.get(path) ?? '',
      realpathSync: path => path === '/usr/local/bin/botmux'
        ? '/usr/local/lib/node_modules/botmux/dist/cli.js'
        : path,
      statSync: () => ({ size: 100_000 }),
    });

    expect(candidate?.root).toBe('/usr/local/lib/node_modules/botmux');
    expect(candidate?.version).toBe('2.9.0');
    expect(candidate?.runtimeSource).toBe('global-cli');
  });
});
