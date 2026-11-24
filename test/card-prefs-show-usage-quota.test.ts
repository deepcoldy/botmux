import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { getBotCardPrefs, updateBotCardPrefs } from '../src/services/card-prefs-store.js';
import { applyConfigField, findConfigField } from '../src/services/bot-config-store.js';
import { botDefaultsPayload } from '../src/dashboard/bot-payload.js';

const previous = process.env.BOTS_CONFIG;
let dir = '';
afterEach(() => {
  if (previous === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = previous;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  dir = mkdtempSync(join(tmpdir(), 'show-usage-quota-store-'));
  const path = join(dir, 'bots.json');
  process.env.BOTS_CONFIG = path;
  writeFileSync(path, JSON.stringify([
    { larkAppId: 'cli_quota_on', larkAppSecret: 'fixture', cliId: 'antigravity' },
    { larkAppId: 'cli_quota_off', larkAppSecret: 'fixture', cliId: 'claude-code', showUsageQuota: false },
  ]));
  loadBotConfigs().forEach(registerBot);
  return { read: () => JSON.parse(readFileSync(path, 'utf8')) };
}

describe('showUsageQuota card preference', () => {
  it('defaults to on, persists only explicit false, updates live config, and stays per bot', async () => {
    const f = fixture();
    expect(getBotCardPrefs('cli_quota_on').showUsageQuota).toBe(true);
    expect(getBotCardPrefs('cli_quota_off').showUsageQuota).toBe(false);
    expect(botDefaultsPayload({ larkAppId: 'cli_quota_on' }, getBotCardPrefs('cli_quota_on')).showUsageQuota).toBe(true);
    expect(botDefaultsPayload({ larkAppId: 'cli_quota_off' }, getBotCardPrefs('cli_quota_off')).showUsageQuota).toBe(false);

    expect((await updateBotCardPrefs('cli_quota_on', { showUsageQuota: false })).ok).toBe(true);
    expect(getBot('cli_quota_on').config.showUsageQuota).toBe(false);
    expect(f.read()[0].showUsageQuota).toBe(false);

    loadBotConfigs().forEach(registerBot);
    expect(getBotCardPrefs('cli_quota_on').showUsageQuota).toBe(false);
    expect(botDefaultsPayload({ larkAppId: 'cli_quota_on' }, getBotCardPrefs('cli_quota_on')).showUsageQuota).toBe(false);

    expect((await updateBotCardPrefs('cli_quota_off', { showUsageQuota: true })).ok).toBe(true);
    expect(f.read()[1]).not.toHaveProperty('showUsageQuota');
    expect(getBot('cli_quota_off').config.showUsageQuota).toBeUndefined();
    expect(f.read()[0].showUsageQuota).toBe(false);
  });

  it('agrees with /botconfig set and unset on the same field', async () => {
    const f = fixture();
    const field = findConfigField('showUsageQuota')!;
    expect(field).toBeTruthy();
    expect(field.effect).toBe('immediate');
    expect(field.defaultOn).toBe(true);

    expect((await applyConfigField('cli_quota_on', field, false)).ok).toBe(true);
    expect(getBotCardPrefs('cli_quota_on').showUsageQuota).toBe(false);
    expect(f.read()[0].showUsageQuota).toBe(false);

    expect((await applyConfigField('cli_quota_on', field, true)).ok).toBe(true);
    expect(getBotCardPrefs('cli_quota_on').showUsageQuota).toBe(true);
    expect(f.read()[0]).not.toHaveProperty('showUsageQuota');

    expect((await applyConfigField('cli_quota_on', field, false)).ok).toBe(true);
    expect((await applyConfigField('cli_quota_on', field, undefined)).ok).toBe(true);
    expect(getBotCardPrefs('cli_quota_on').showUsageQuota).toBe(true);
    expect(f.read()[0]).not.toHaveProperty('showUsageQuota');
  });
});
