import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('src/cli.ts'), 'capabilities', '--json'],
      {
        cwd: resolve('.'),
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(botmuxCapabilities());
    expect(readdirSync(home)).toEqual([]);
  });
});
