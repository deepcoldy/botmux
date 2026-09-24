import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIST = join(process.cwd(), 'dist');
const CLI = join(DIST, 'cli.js');

async function compiledOptions() {
  return await import(pathToFileURL(join(DIST, 'cli', 'companion-startup-options.js')).href) as typeof import('../src/cli/companion-startup-options.js');
}

async function compiledSecretLoader() {
  return await import(pathToFileURL(join(DIST, 'dashboard', 'companion-api.js')).href) as typeof import('../src/dashboard/companion-api.js');
}

describe('compiled lifecycle Companion option dispatch', () => {
  it('rejects a relative secret path before selecting a Bot', async () => {
    const { applyCompanionStartupOptions } = await compiledOptions();
    const { loadCompanionSecret } = await compiledSecretLoader();
    expect(() => applyCompanionStartupOptions({
      argv: ['--companion-secret-file', 'relative-secret', '--companion-bot', 'test'],
      env: {}, bots: [], validateSecret: loadCompanionSecret,
    })).toThrow('companion_secret_invalid');
  });

  it.each([
    ['zero matches', []],
    ['multiple matches', [
      { larkAppId: 'test', sandbox: true, cliId: 'codex' },
      { larkAppId: 'test', sandbox: true, cliId: 'codex' },
    ]],
    ['nonqualifying match', [{ larkAppId: 'test', sandbox: false, cliId: 'codex' }]],
  ] as const)('rejects %s without exposing Bot details', async (_label, bots) => {
    const { applyCompanionStartupOptions } = await compiledOptions();
    expect(() => applyCompanionStartupOptions({
      argv: ['--companion-secret-file', '/run/secrets/companion', '--companion-bot', 'test'],
      env: {}, bots, validateSecret: () => {},
    })).toThrow('companion bot selection must match exactly one isolated codex/traex Bot');
  });

  it('accepts exactly one qualifying selected Bot without starting a daemon', async () => {
    const { applyCompanionStartupOptions } = await compiledOptions();
    const env: NodeJS.ProcessEnv = {};
    const validateSecret = () => {};
    applyCompanionStartupOptions({
      argv: ['--companion-secret-file', '/run/secrets/companion', '--companion-bot', 'test'],
      env,
      bots: [
        { larkAppId: 'test', sandbox: true, cliId: 'codex' },
        { larkAppId: 'unrelated', sandbox: false, cliId: 'claude-code' },
      ],
      validateSecret,
    });
    expect(env.BOTMUX_COMPANION_SECRET_FILE).toBe('/run/secrets/companion');
    expect(env.BOTMUX_COMPANION_BOT_APP_ID).toBe('test');
  });

  it.each(['start', 'restart'])('accepts Companion value flags for %s before execution', command => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-companion-cli-'));
    try {
      const result = spawnSync(process.execPath, [CLI, command,
        '--companion-secret-file', '/definitely/missing/companion-secret',
        '--companion-bot', 'local_test_bot'], {
        env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 15_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).not.toBe(2);
      expect(output).not.toContain('未知参数');
      expect(output).not.toContain('--companion-secret-file');
      expect(output).not.toContain('--companion-bot');
      expect(output).toContain('companion_secret_invalid');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
