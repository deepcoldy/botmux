/**
 * 群秘书 bot 级开关 groupSecretaryEnabled：默认关，只在开启时写盘，关回去即删掉键（等于默认不写盘）。
 * Dashboard（card-prefs）与 /botconfig 两条写入路径同一套语义。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
    }
  }
  return { Client: FakeClient };
});

async function freshModules() {
  vi.resetModules();
  vi.doUnmock('../src/services/config-store.js');
  const registry = await import('../src/bot-registry.js');
  const botConfigStore = await import('../src/services/bot-config-store.js');
  const store = await import('../src/services/card-prefs-store.js');
  return { registry, botConfigStore, store };
}

describe('card-prefs store — groupSecretaryEnabled', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cardprefs-secretary-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
  });

  afterEach(() => {
    delete process.env.BOTS_CONFIG;
    vi.doUnmock('../src/services/config-store.js');
  });

  function writeConfig(entry: Record<string, unknown> = {}) {
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app_default',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      ...entry,
    }], null, 2), 'utf-8');
  }

  function readConfig(): any {
    return JSON.parse(readFileSync(configPath, 'utf-8'))[0];
  }

  it('defaults to off for a bot that never set it', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    expect(registry.getBot('app_default').config.groupSecretaryEnabled).toBeUndefined();
    expect(store.getBotCardPrefs('app_default').groupSecretaryEnabled).toBe(false);
  });

  it('a hand-edited non-boolean value stays off', async () => {
    writeConfig({ groupSecretaryEnabled: 'yes' });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    expect(registry.getBot('app_default').config.groupSecretaryEnabled).toBeUndefined();
    expect(store.getBotCardPrefs('app_default').groupSecretaryEnabled).toBe(false);
  });

  it('Dashboard: on persists true to disk and memory; off removes the key again', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const on = await store.updateBotCardPrefs('app_default', { groupSecretaryEnabled: true });
    expect(on.ok).toBe(true);
    if (on.ok) expect(on.prefs.groupSecretaryEnabled).toBe(true);
    expect(readConfig().groupSecretaryEnabled).toBe(true);
    expect(registry.getBot('app_default').config.groupSecretaryEnabled).toBe(true);

    const off = await store.updateBotCardPrefs('app_default', { groupSecretaryEnabled: false });
    expect(off.ok).toBe(true);
    expect('groupSecretaryEnabled' in readConfig()).toBe(false);
    expect(registry.getBot('app_default').config.groupSecretaryEnabled).toBeUndefined();
  });

  it('/botconfig field is default-off and writes the same way', async () => {
    writeConfig();
    const { registry, botConfigStore } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const spec = botConfigStore.findConfigField('groupSecretaryEnabled')!;
    expect(spec).toBeDefined();
    expect(spec.kind).toBe('boolean');
    expect(spec.defaultOn).toBeFalsy();
    expect(spec.effect).toBe('immediate');

    expect((await botConfigStore.applyConfigField('app_default', spec, true)).ok).toBe(true);
    expect(readConfig().groupSecretaryEnabled).toBe(true);
    expect(registry.getBot('app_default').config.groupSecretaryEnabled).toBe(true);

    expect((await botConfigStore.applyConfigField('app_default', spec, false)).ok).toBe(true);
    expect('groupSecretaryEnabled' in readConfig()).toBe(false);
    expect(registry.getBot('app_default').config.groupSecretaryEnabled).toBeUndefined();
  });
});
