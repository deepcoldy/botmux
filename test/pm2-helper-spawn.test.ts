import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPm2HelperSpawn,
  PM2_EXISTING_CLIENT_SUBCOMMAND,
  PM2_READONLY_CLIENT_SUBCOMMAND,
} from '../src/cli/pm2-helper-spawn.js';

describe('PM2 helper spawn resolution', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function tmpRoot(): string {
    root = mkdtempSync(join(tmpdir(), 'botmux-pm2-helper-'));
    return root;
  }

  it('re-enters the current executable for readonly helpers in standalone builds', () => {
    const spawn = buildPm2HelperSpawn({
      pkgRoot: '/',
      clientName: 'pm2-readonly-client',
      clientSubcommand: PM2_READONLY_CLIENT_SUBCOMMAND,
      clientArgs: ['jlist'],
      runningFromDist: false,
      standalone: true,
    });

    expect(spawn).toEqual({
      command: process.execPath,
      args: [PM2_READONLY_CLIENT_SUBCOMMAND, 'jlist'],
    });
    expect(spawn.args.join(' ')).not.toContain('/src/cli/pm2-readonly-client.ts');
  });

  it('re-enters the current executable for existing-daemon helpers in standalone builds', () => {
    const spawn = buildPm2HelperSpawn({
      pkgRoot: '/',
      clientName: 'pm2-existing-client',
      clientSubcommand: PM2_EXISTING_CLIENT_SUBCOMMAND,
      clientArgs: ['{"operation":"kill"}'],
      runningFromDist: false,
      standalone: true,
    });

    expect(spawn).toEqual({
      command: process.execPath,
      args: [PM2_EXISTING_CLIENT_SUBCOMMAND, '{"operation":"kill"}'],
    });
    expect(spawn.args.join(' ')).not.toContain('/src/cli/pm2-existing-client.ts');
  });

  it('keeps using the built helper for Node dist installs', () => {
    const pkgRoot = tmpRoot();
    const distCli = join(pkgRoot, 'dist', 'cli');
    mkdirSync(distCli, { recursive: true });
    writeFileSync(join(distCli, 'pm2-readonly-client.js'), '');

    const spawn = buildPm2HelperSpawn({
      pkgRoot,
      nodePath: '/usr/bin/node',
      clientName: 'pm2-readonly-client',
      clientSubcommand: PM2_READONLY_CLIENT_SUBCOMMAND,
      clientArgs: ['status'],
      runningFromDist: true,
      standalone: false,
    });

    expect(spawn).toEqual({
      command: '/usr/bin/node',
      args: [join(distCli, 'pm2-readonly-client.js'), 'status'],
    });
  });

  it('keeps source/test execution on the TypeScript helper', () => {
    const pkgRoot = tmpRoot();
    const spawn = buildPm2HelperSpawn({
      pkgRoot,
      nodePath: '/usr/bin/node',
      clientName: 'pm2-existing-client',
      clientSubcommand: PM2_EXISTING_CLIENT_SUBCOMMAND,
      clientArgs: ['{"operation":"kill"}'],
      runningFromDist: false,
      standalone: false,
      bunRuntime: false,
    });

    expect(spawn).toEqual({
      command: '/usr/bin/node',
      args: [
        '--import',
        'tsx',
        join(pkgRoot, 'src', 'cli', 'pm2-existing-client.ts'),
        '{"operation":"kill"}',
      ],
    });
  });
});
