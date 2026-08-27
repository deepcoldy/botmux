/**
 * Unit tests for trusted bot-added talk authorization persistence.
 *
 * Run: pnpm vitest run --project unit test/auto-oncall-store.test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

let configPath: string;

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/auto-oncall-store.js');
  registry.loadBotConfigs().forEach(config => registry.registerBot(config));
  return { registry, store };
}

function writeConfig(entry: Record<string, unknown> = {}) {
  writeFileSync(configPath, JSON.stringify([{
    larkAppId: 'app_auto_oncall',
    larkAppSecret: 'secret',
    cliId: 'claude-code',
    ...entry,
  }], null, 2), 'utf-8');
}

function readConfig(): any {
  return JSON.parse(readFileSync(configPath, 'utf-8'))[0];
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-auto-oncall-store-'));
  configPath = join(dir, 'bots.json');
  process.env.BOTS_CONFIG = configPath;
});

afterEach(() => {
  delete process.env.BOTS_CONFIG;
  vi.restoreAllMocks();
});

describe('auto-oncall-store', () => {
  it('normalizes config arrays and matches only the exact trusted operator', async () => {
    writeConfig({
      autoOncallOperatorOpenIds: [' ou_byte_oncall ', '', 'ou_byte_oncall', 'ou_other'],
      autoOncallChats: [' oc_existing ', 'oc_existing', ''],
    });
    const { registry, store } = await freshModules();

    expect(registry.getBot('app_auto_oncall').config.autoOncallOperatorOpenIds)
      .toEqual(['ou_byte_oncall', 'ou_other']);
    expect(registry.getBot('app_auto_oncall').config.autoOncallChats).toEqual(['oc_existing']);
    expect(store.isAutoOncallOperator('app_auto_oncall', 'ou_byte_oncall')).toBe(true);
    expect(store.isAutoOncallOperator('app_auto_oncall', 'OU_BYTE_ONCALL')).toBe(false);
    expect(store.isAutoOncallOperator('app_auto_oncall', 'ou_byte_oncall_suffix')).toBe(false);
    expect(store.isAutoOncallOperator('app_auto_oncall', undefined)).toBe(false);
  });

  it('persists and hot-updates an add, with duplicate adds remaining idempotent', async () => {
    writeConfig({ autoOncallOperatorOpenIds: ['ou_byte_oncall'] });
    const { registry, store } = await freshModules();

    expect(await store.addAutoOncallChat('app_auto_oncall', 'oc_new'))
      .toEqual({ ok: true, created: true });
    expect(readConfig().autoOncallChats).toEqual(['oc_new']);
    expect(registry.getBot('app_auto_oncall').config.autoOncallChats).toEqual(['oc_new']);

    expect(await store.addAutoOncallChat('app_auto_oncall', 'oc_new'))
      .toEqual({ ok: true, created: false });
    expect(readConfig().autoOncallChats).toEqual(['oc_new']);
  });

  it('keeps an automatic authorization after reloading bots.json', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    await store.addAutoOncallChat('app_auto_oncall', 'oc_persisted');

    registry.__testOnly_resetBotRegistry();
    registry.loadBotConfigs().forEach(config => registry.registerBot(config));

    expect(registry.getBot('app_auto_oncall').config.autoOncallChats).toEqual(['oc_persisted']);
  });

  it('removes only automatic authorization and preserves manual allowedChatGroups', async () => {
    writeConfig({
      allowedChatGroups: ['oc_shared', 'oc_manual'],
      autoOncallChats: ['oc_shared'],
    });
    const { registry, store } = await freshModules();

    expect(await store.removeAutoOncallChat('app_auto_oncall', 'oc_shared'))
      .toEqual({ ok: true, removed: true });
    expect(readConfig().autoOncallChats).toBeUndefined();
    expect(readConfig().allowedChatGroups).toEqual(['oc_shared', 'oc_manual']);
    expect(registry.getBot('app_auto_oncall').config.autoOncallChats).toBeUndefined();
    expect(registry.getBot('app_auto_oncall').config.allowedChatGroups)
      .toEqual(['oc_shared', 'oc_manual']);
  });

  it('returns bot_not_registered for writes to an unknown bot', async () => {
    writeConfig();
    const { store } = await freshModules();

    expect(await store.addAutoOncallChat('missing', 'oc_x'))
      .toEqual({ ok: false, reason: 'bot_not_registered' });
    expect(await store.removeAutoOncallChat('missing', 'oc_x'))
      .toEqual({ ok: false, reason: 'bot_not_registered' });
  });
});
