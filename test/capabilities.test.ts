import { type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import {
  BOTMUX_CAPABILITIES_SCHEMA_VERSION,
  botmuxCapabilities,
  parseCapabilitiesArgs,
} from '../src/cli/capabilities.js';

describe('botmux capabilities contract', () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it('publishes the fixed machine-readable compatibility schema', () => {
    expect(botmuxCapabilities()).toEqual({
      schemaVersion: BOTMUX_CAPABILITIES_SCHEMA_VERSION,
      capabilities: {
        exact_chat_grant_v1: true,
        stable_app_dispatch_v1: true,
        stable_dispatch_acceptance_v1: true,
        managed_activation_v2: true,
        current_actor_v2: true,
      },
    });
  });

  it('accepts only the side-effect-free JSON form', () => {
    expect(parseCapabilitiesArgs(['--json'])).toEqual({ ok: true });
    expect(parseCapabilitiesArgs([])).toEqual({
      ok: false,
      error: '用法: botmux capabilities --json',
    });
    expect(parseCapabilitiesArgs(['--json', '--unknown'])).toEqual({
      ok: false,
      error: '用法: botmux capabilities --json',
    });
  });

  it('prints only the fixed JSON document and creates no runtime state', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-capabilities-'));
    homes.push(home);
    const result = spawnSyncTsScript(
      resolve('src/cli.ts'),
      ['capabilities', '--json'],
      {
        cwd: resolve('.'),
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      },
    ) as SpawnSyncReturns<string>;

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(botmuxCapabilities());
    // The claim under test is that BOTMUX writes no runtime state. `.bun` is the
    // Bun runtime's own install cache (`.bun/install/cache`), minted by the
    // interpreter that runs the script, not by botmux — under `bun test` the
    // child is spawned with Bun, so it appears here. Filter that one entry
    // rather than relaxing to a subset match, so any botmux-created file still
    // fails this assertion.
    expect(readdirSync(home).filter(entry => entry !== '.bun')).toEqual([]);
  });
});
