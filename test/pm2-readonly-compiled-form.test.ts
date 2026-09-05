/**
 * The PM2 observer is intentionally a separate process, but a Bun standalone
 * binary has no dist/src helper file that process.execPath can execute. Keep the
 * Node launcher byte-compatible and route only the compiled form through the
 * binary's hidden-entry dispatcher.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveReadonlyPm2Spawn } from '../src/cli/pm2-readonly.js';
import { ENTRY_SUBCOMMANDS, entryForSubcommand } from '../src/core/self-spawn.js';

const REAL_ARGV1 = process.argv[1];

function asCompiledBinary(): void {
  process.argv[1] = '/$bunfs/root/cli.js';
}

afterEach(() => { process.argv[1] = REAL_ARGV1; });

describe('PM2 read-only helper launch form', () => {
  it('keeps the existing source helper command under Node', () => {
    const resolved = resolveReadonlyPm2Spawn({
      pkgRoot: '/opt/botmux',
      nodePath: '/custom/node',
      modeArgs: ['jlist'],
    });
    expect(resolved).toEqual({
      command: '/custom/node',
      args: [
        '--import',
        'tsx',
        join('/opt/botmux', 'src', 'cli', 'pm2-readonly-client.ts'),
        'jlist',
      ],
    });
  });

  it('re-enters the standalone binary with a hidden token and no disk path', () => {
    asCompiledBinary();
    const resolved = resolveReadonlyPm2Spawn({
      pkgRoot: '/$bunfs/root',
      nodePath: '/custom/node-must-not-win',
      modeArgs: ['logs', 'all', '50'],
    });
    expect(resolved).toEqual({
      command: process.execPath,
      args: ['__pm2-readonly-client', 'logs', 'all', '50'],
    });
    for (const value of [resolved.command, ...resolved.args]) {
      expect(value).not.toContain('$bunfs');
      expect(value).not.toContain('pm2-readonly-client.js');
      expect(value).not.toContain('pm2-readonly-client.ts');
    }
  });

  it('registers the hidden token with the shared self-spawn dispatcher', () => {
    expect(ENTRY_SUBCOMMANDS.has('__pm2-readonly-client')).toBe(true);
    expect(entryForSubcommand('__pm2-readonly-client')).toBe('pm2-readonly-client');
  });
});
