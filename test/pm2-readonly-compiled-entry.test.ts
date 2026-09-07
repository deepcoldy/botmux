/**
 * The read-only PM2 observer must be launchable from both Botmux shapes.
 *
 * Under Node, the child receives the existing on-disk helper path. A Bun
 * standalone binary has no usable dist/ path outside /$bunfs/, so it must
 * re-exec itself with a hidden token that cli.ts dispatches via static import.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { helperArgs } from '../src/cli/pm2-readonly.js';
import {
  ENTRY_SUBCOMMANDS,
  INTERNAL_HELPER_ENTRIES,
  RUNNER_ENTRIES,
  entryForSubcommand,
  resolveEntrySpawn,
  subcommandForEntry,
} from '../src/core/self-spawn.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REAL_ARGV1 = process.argv[1];

function asCompiledBinary(): void {
  process.argv[1] = '/$bunfs/root/cli.js';
}

afterEach(() => {
  process.argv[1] = REAL_ARGV1;
});

describe('PM2 read-only helper entry', () => {
  it('uses the mapped hidden token in the compiled form and emits no file path', () => {
    asCompiledBinary();
    const modeArgs = ['logs', 'data-mcp', '50'];
    const args = helperArgs('/ignored/pkg-root', modeArgs);

    // This assertion pins the call site to the mapping as its source of truth;
    // the mapping's literal token value is pinned separately below.
    expect(args).toEqual([subcommandForEntry('pm2-readonly-client'), ...modeArgs]);
    expect(args.every(arg => !String(arg).includes('/'))).toBe(true);
  });

  it('preserves the existing Node tsx fallback argv, including the helper path', () => {
    const pkgRoot = '/opt/botmux checkout';
    const modeArgs = ['status'];
    const args = helperArgs(pkgRoot, modeArgs);

    // Vitest imports the source module, so import.meta.url cannot select the
    // built-dist branch. That branch remains for build/artifact-level validation.
    expect(args).toEqual([
      '--import',
      'tsx',
      join(pkgRoot, 'src', 'cli', 'pm2-readonly-client.ts'),
      ...modeArgs,
    ]);
    expect(args[2]).toContain('/src/cli/pm2-readonly-client.ts');
  });

  it('resolves the helper under the cli subdirectory in the Node dist form', () => {
    const distDir = '/opt/botmux/dist';

    expect(resolveEntrySpawn('pm2-readonly-client', distDir)).toEqual({
      command: process.execPath,
      args: [join(distDir, 'cli', 'pm2-readonly-client.js')],
    });
  });

  it('wires the helper token through the inverse map and a static CLI import', () => {
    const entry = INTERNAL_HELPER_ENTRIES[0];
    const token = subcommandForEntry(entry);
    const cliSource = readFileSync(resolve(REPO_ROOT, 'src', 'cli.ts'), 'utf8');

    expect([...INTERNAL_HELPER_ENTRIES]).toEqual(['pm2-readonly-client']);
    expect(token).toBe('__pm2-readonly-client');
    expect(ENTRY_SUBCOMMANDS.has(token)).toBe(true);
    expect(entryForSubcommand(token)).toBe(entry);
    expect(cliSource).toContain("__entrySubcommand === 'pm2-readonly-client'");
    expect(cliSource).toContain("await import('./cli/pm2-readonly-client.js')");
  });

  it('does not expand the session-runner collection', () => {
    expect(RUNNER_ENTRIES.length).toBe(4);
    expect([...RUNNER_ENTRIES]).toEqual([
      'codex-app-runner',
      'dsh-runner',
      'mira-runner',
      'mir-runner',
    ]);
  });
});
