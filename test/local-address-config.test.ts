import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { getBotCardPrefs, updateBotCardPrefs } from '../src/services/card-prefs-store.js';
import { applyConfigField, findConfigField } from '../src/services/bot-config-store.js';
import { sanitizeLocalAddressText } from '../src/im/lark/local-address-policy.js';
import { localAddressContextForBot } from '../src/im/lark/local-address-context.js';

const previous = process.env.BOTS_CONFIG;
let dir = '';
afterEach(() => {
  if (previous === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = previous;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  dir = mkdtempSync(join(tmpdir(), 'local-address-config-'));
  const path = join(dir, 'bots.json'); process.env.BOTS_CONFIG = path;
  writeFileSync(path, JSON.stringify([
    { larkAppId: 'cli_local_one', larkAppSecret: 'fixture', cliId: 'claude-code' },
    { larkAppId: 'cli_local_two', larkAppSecret: 'fixture', cliId: 'codex', hideLocalAddresses: true },
  ]));
  loadBotConfigs().forEach(registerBot);
  return { read: () => JSON.parse(readFileSync(path, 'utf8')) };
}

const evidence = '日志在 /opt/app/logs/error.log，服务 http://localhost:3000/health';
const reply = (app: string) => sanitizeLocalAddressText(evidence, localAddressContextForBot(app));

describe('hideLocalAddresses bot preference', () => {
  it('is off unless bots.json says true, per bot', () => {
    fixture();
    expect(getBotCardPrefs('cli_local_one').hideLocalAddresses).toBe(false);
    expect(reply('cli_local_one')).toBe(evidence);
    expect(getBotCardPrefs('cli_local_two').hideLocalAddresses).toBe(true);
    expect(reply('cli_local_two')).not.toContain('/opt/app/logs');
    expect(reply('cli_local_two')).not.toContain('localhost:3000');
  });

  it('round-trips through the Dashboard store without touching other bots, writing only true', async () => {
    const f = fixture();
    expect((await updateBotCardPrefs('cli_local_one', { hideLocalAddresses: true })).ok).toBe(true);
    expect(getBot('cli_local_one').config.hideLocalAddresses).toBe(true);
    expect(f.read()[0]).toMatchObject({ hideLocalAddresses: true });
    expect(reply('cli_local_one')).not.toContain('/opt/app/logs');
    loadBotConfigs().forEach(registerBot);
    expect(getBotCardPrefs('cli_local_one').hideLocalAddresses).toBe(true);
    expect((await updateBotCardPrefs('cli_local_one', { hideLocalAddresses: false })).ok).toBe(true);
    expect(f.read()[0]).not.toHaveProperty('hideLocalAddresses');
    expect(getBot('cli_local_one').config.hideLocalAddresses).toBeUndefined();
    expect(reply('cli_local_one')).toBe(evidence);
    expect(f.read()[1]).toMatchObject({ hideLocalAddresses: true });
  });

  it('round-trips through /config', async () => {
    const f = fixture(); const field = findConfigField('hideLocalAddresses')!;
    expect(field).toBeDefined();
    expect((await applyConfigField('cli_local_one', field, true)).ok).toBe(true);
    expect(f.read()[0]).toMatchObject({ hideLocalAddresses: true });
    expect(reply('cli_local_one')).not.toContain('/opt/app/logs');
    expect((await applyConfigField('cli_local_one', field, false)).ok).toBe(true);
    expect(f.read()[0]).not.toHaveProperty('hideLocalAddresses');
    expect(reply('cli_local_one')).toBe(evidence);
  });
});
