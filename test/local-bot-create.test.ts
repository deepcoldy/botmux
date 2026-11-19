/**
 * Local bot creation persists without a Feishu app, round-trips through the
 * registry, and is skipped by the fleet credential preflight. A normal Feishu
 * config is still rejected when its secret is missing and still validated when
 * present. No real Feishu call is made.
 *
 * Run: bunx vitest run test/local-bot-create.test.ts test/dashboard-bot-onboarding-local.test.ts
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { getBotClient, parseBotConfigsFromText, registerBot } from '../src/bot-registry.js';
import { LarkTransportDisabledError } from '../src/bot-registry.js';
import { findInvalidFleetCredentials, isLocalBotId } from '../src/setup/local-bot.js';
import { resolveCliSelection } from '../src/setup/cli-selection.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const execFileAsync = promisify(execFile);
const homes: string[] = [];

async function runCli(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { command, prefixArgs } = tsRunnerPrefix();
  try {
    const { stdout, stderr } = await execFileAsync(command, [...prefixArgs, 'src/cli.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error: any) {
    if (typeof error?.code !== 'number') throw error;
    return {
      code: error.code,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    };
  }
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('fleet credential preflight', () => {
  it('skips a local bot and still checks a Feishu bot', async () => {
    const calls: string[] = [];
    const invalid = await findInvalidFleetCredentials([
      { larkAppId: 'local_lab', apiOnly: true, localIdentity: true },
      { larkAppId: 'cli_missing' },
      { larkAppId: 'cli_ok', larkAppSecret: 'secret-ok' },
      { larkAppId: 'cli_bad', larkAppSecret: 'secret-bad' },
    ], {
      validate: async (appId) => {
        calls.push(appId);
        if (appId === 'cli_bad') return { ok: false, error: 'invalid_credentials', message: 'rejected' };
        return { ok: true };
      },
      brandOf: () => 'feishu',
    });
    expect(calls).toEqual(['cli_ok', 'cli_bad']);
    expect(invalid).toEqual([
      { appId: 'cli_missing', reason: 'larkAppId/larkAppSecret 缺失' },
      { appId: 'cli_bad', reason: 'rejected' },
    ]);
  });

  it('warns instead of blocking when Feishu validation is inconclusive', async () => {
    const warnings: string[] = [];
    const invalid = await findInvalidFleetCredentials([
      { larkAppId: 'cli_net', larkAppSecret: 'secret' },
    ], {
      validate: async () => ({ ok: false, error: 'network', message: 'timeout' }),
      brandOf: () => 'feishu',
      warn: line => warnings.push(line),
    });
    expect(invalid).toEqual([]);
    expect(warnings.join('\n')).toContain('cli_net');
    expect(warnings.join('\n')).toContain('network');
  });
});

describe('supported CLI selection', () => {
  it('maps the documented traecli alias onto the traex adapter id', () => {
    expect(resolveCliSelection('traecli')).toEqual({ cliId: 'traex' });
    expect(resolveCliSelection('traex')).toEqual({ cliId: 'traex' });
    expect(resolveCliSelection('14')).toEqual({ cliId: 'traex' });
  });
});

describe('setup add --local', () => {
  it('writes a startable local bot and leaves Feishu fields unset', async () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-local-home-'));
    homes.push(home);
    const work = mkdtempSync(join(tmpdir(), 'botmux-local-work-'));
    homes.push(work);
    const { stdout, stderr } = await runCli(home, [
      'setup', 'add', '--local',
      '--name', 'Lab Bot',
      '--cli', 'riff',
      '--default-working-dir', work,
      '--json',
    ]);
    expect(stderr).not.toMatch(/扫码|qrlogin|tenant_access_token/i);
    const payload = JSON.parse(stdout);
    expect(payload.ok).toBe(true);
    expect(payload.localIdentity).toBe(true);
    expect(payload.openPlatform).toEqual({ status: 'skipped' });
    expect(isLocalBotId(payload.appId)).toBe(true);
    expect(payload.appId).toBe('local_lab_bot');
    expect(payload.note).toContain('不是飞书');

    const raw = JSON.parse(readFileSync(join(home, '.botmux', 'bots.json'), 'utf8'));
    expect(raw).toHaveLength(1);
    expect(raw[0].larkAppSecret).toBeUndefined();
    expect(raw[0]).toMatchObject({
      larkAppId: 'local_lab_bot',
      apiOnly: true,
      localIdentity: true,
      cliId: 'riff',
      displayName: 'Lab Bot',
      defaultWorkingDir: work,
    });

    const loaded = parseBotConfigsFromText(JSON.stringify(raw));
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      larkAppId: 'local_lab_bot',
      apiOnly: true,
      localIdentity: true,
      larkAppSecret: '',
      cliId: 'riff',
    });
    const registered = registerBot(loaded[0]!);
    expect(registered.client).toBeNull();
    expect(() => getBotClient('local_lab_bot')).toThrow(LarkTransportDisabledError);

    const invalid = await findInvalidFleetCredentials(raw, {
      validate: async () => { throw new Error('Feishu credential check must not run'); },
      brandOf: () => 'feishu',
    });
    expect(invalid).toEqual([]);
  }, 60_000);

  it('accepts --cli traecli and stores cliId traex without launching Trae', async () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-local-trae-'));
    homes.push(home);
    const work = mkdtempSync(join(tmpdir(), 'botmux-local-trae-work-'));
    homes.push(work);
    // /bin/true only satisfies the existing executable check. It is not Trae.
    const { stdout } = await runCli(home, [
      'setup', 'add', '--local',
      '--name', 'Trae Choice',
      '--cli', 'traecli',
      '--cli-path', '/bin/true',
      '--default-working-dir', work,
      '--json',
    ]);
    const payload = JSON.parse(stdout);
    expect(payload.ok).toBe(true);
    expect(payload.bot.cliId).toBe('traex');
    expect(payload.bot.cliPathOverride).toBe('/bin/true');
    expect(payload.bot.larkAppId).toBe('local_trae_choice');
    const raw = JSON.parse(readFileSync(join(home, '.botmux', 'bots.json'), 'utf8'));
    expect(raw[0].cliId).toBe('traex');
    expect(raw[0].apiOnly).toBe(true);
    expect(raw[0].larkAppSecret).toBeUndefined();
  }, 60_000);
  it('persists the runtime path shadow so the saved bot passes registry parsing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-local-runtime-'));
    homes.push(home);
    const { code, stdout } = await runCli(home, [
      'setup', 'add', '--local',
      '--name', 'Custom Runtime',
      '--cli', 'codex',
      '--cli-runtime', JSON.stringify({ id: 'vendor', executable: '/bin/true' }),
      '--default-working-dir', home,
      '--json',
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
    const raw = JSON.parse(readFileSync(join(home, '.botmux', 'bots.json'), 'utf8'));
    expect(raw[0]).toMatchObject({
      cliId: 'codex',
      cliRuntime: { id: 'vendor', executable: '/bin/true' },
      cliPathOverride: '/bin/true',
    });
    expect(() => parseBotConfigsFromText(JSON.stringify(raw))).not.toThrow();
  }, 60_000);

  it('rejects null and conflicting runtime sources without writing a bot', async () => {
    const runtime = JSON.stringify({ id: 'vendor', executable: '/bin/true' });
    for (const testCase of [
      { name: 'json-null', runtime: 'null', cliPath: '/bin/true', expected: '--cli-runtime 必须是 JSON 对象或 -' },
      { name: 'dual-source', runtime, cliPath: '/bin/false', expected: 'cliRuntime conflicts with cliPathOverride' },
    ]) {
      const home = mkdtempSync(join(tmpdir(), `botmux-local-runtime-${testCase.name}-`));
      homes.push(home);
      const result = await runCli(home, [
        'setup', 'add', '--local', '--name', testCase.name, '--cli', 'codex',
        '--cli-runtime', testCase.runtime, '--cli-path', testCase.cliPath,
        '--default-working-dir', home, '--json',
      ]);
      expect(result.code).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(testCase.expected);
      expect(existsSync(join(home, '.botmux', 'bots.json'))).toBe(false);
    }
  }, 60_000);

  it('keeps every record and allocates unique ids for concurrent local additions', async () => {
    const scenarios = [
      { names: ['alpha', 'beta'], expectedIds: ['local_alpha', 'local_beta'] },
      { names: ['研究室', '实验室'], expectedIds: ['local_bot', 'local_bot_2'] },
    ];
    const failures: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      for (const scenario of scenarios) {
        const home = mkdtempSync(join(tmpdir(), `botmux-local-concurrent-${round}-`));
        homes.push(home);
        try {
          const results = await Promise.all(scenario.names.map(name => runCli(home, [
            'setup', 'add', '--local',
            '--name', name,
            '--cli', 'riff',
            '--default-working-dir', home,
            '--json',
          ])));
          expect(results.map(result => result.code)).toEqual([0, 0]);
          const raw = JSON.parse(readFileSync(join(home, '.botmux', 'bots.json'), 'utf8'));
          expect(raw.map((bot: any) => bot.larkAppId).sort()).toEqual([...scenario.expectedIds].sort());
          expect(raw.map((bot: any) => bot.displayName).sort()).toEqual([...scenario.names].sort());
          expect(() => parseBotConfigsFromText(JSON.stringify(raw))).not.toThrow();
        } catch (error) {
          failures.push(`${scenario.names.join('/')} round ${round}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('rejects changing a local id without modifying the saved config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-local-edit-'));
    homes.push(home);
    await runCli(home, [
      'setup', 'add', '--local', '--name', 'Editable', '--cli', 'riff',
      '--default-working-dir', home, '--json',
    ]);
    const botsPath = join(home, '.botmux', 'bots.json');
    const before = readFileSync(botsPath, 'utf8');
    const edited = await runCli(home, [
      'setup', 'edit', 'local_editable', '--app-id', 'cli_changed', '--app-secret', 'invalid-secret', '--json',
    ]);
    expect(edited.code).not.toBe(0);
    expect(JSON.parse(edited.stdout)).toMatchObject({ ok: false });
    expect(`${edited.stdout}${edited.stderr}`).toContain('本地机器人 id 不可修改');
    expect(readFileSync(botsPath, 'utf8')).toBe(before);
    expect(() => parseBotConfigsFromText(before)).not.toThrow();
  }, 60_000);

  it('rejects cloning a local bot before any target app can be created', async () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-local-clone-'));
    homes.push(home);
    await runCli(home, [
      'setup', 'add', '--local', '--name', 'Clone Source', '--cli', 'riff',
      '--default-working-dir', home, '--json',
    ]);
    const botsPath = join(home, '.botmux', 'bots.json');
    const before = readFileSync(botsPath, 'utf8');
    const cloned = await runCli(home, ['clone', 'local_clone_source']);
    expect(cloned.code).not.toBe(0);
    expect(`${cloned.stdout}${cloned.stderr}`).toContain('本地机器人不支持克隆');
    expect(readFileSync(botsPath, 'utf8')).toBe(before);
  }, 60_000);
});

describe('Feishu config compatibility', () => {
  it('still requires a secret and does not mark a cli_ id as a local identity', () => {
    expect(() => parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'cli_feishu', cliId: 'claude-code' },
    ]))).toThrow(/larkAppSecret/);
    expect(() => parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'cli_feishu', larkAppSecret: 'secret', cliId: 'claude-code', localIdentity: true },
    ]))).toThrow(/requires apiOnly: true/);
    const [feishu] = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'cli_feishu', larkAppSecret: 'secret', cliId: 'claude-code' },
    ]));
    expect(feishu?.apiOnly).toBeUndefined();
    expect(feishu?.localIdentity).toBeUndefined();
    expect(feishu?.larkAppSecret).toBe('secret');
  });
});
