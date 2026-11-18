/**
 * Local bot creation persists without a Feishu app, round-trips through the
 * registry, and is skipped by the fleet credential preflight. A normal Feishu
 * config is still rejected when its secret is missing and still validated when
 * present. No real Feishu call is made.
 *
 * Run: pnpm exec vitest run test/local-bot-create.test.ts test/dashboard-bot-onboarding-local.test.ts
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { getBotClient, parseBotConfigsFromText, registerBot } from '../src/bot-registry.js';
import { LarkTransportDisabledError } from '../src/bot-registry.js';
import { findInvalidFleetCredentials, isLocalBotId } from '../src/setup/local-bot.js';
import { resolveCliSelection } from '../src/setup/cli-selection.js';

const execFileAsync = promisify(execFile);
const homes: string[] = [];

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
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--import', 'tsx',
      'src/cli.ts',
      'setup', 'add', '--local',
      '--name', 'Lab Bot',
      '--cli', 'riff',
      '--default-working-dir', work,
      '--json',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 60_000,
    });
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
    const { stdout } = await execFileAsync(process.execPath, [
      '--import', 'tsx',
      'src/cli.ts',
      'setup', 'add', '--local',
      '--name', 'Trae Choice',
      '--cli', 'traecli',
      '--cli-path', '/bin/true',
      '--default-working-dir', work,
      '--json',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 60_000,
    });
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
