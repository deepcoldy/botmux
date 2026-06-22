/**
 * Unit tests for the grant-prefs store (dashboard Bot Defaults「授权与额度」section):
 * restrictGrantCommands toggle + messageQuota.defaultLimit round-trip through
 * bots.json and the in-memory registry.
 *
 * Run: pnpm vitest run test/grant-prefs-store.test.ts
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
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/grant-prefs-store.js');
  return { registry, store };
}

describe('grant-prefs store', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-grantprefs-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
  });

  afterEach(() => {
    delete process.env.BOTS_CONFIG;
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

  it('defaults to restrict=false / quota=null when unset', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const prefs = store.getBotGrantPrefs('app_default');
    expect(prefs.restrictGrantCommands).toBe(false);
    expect(prefs.messageQuotaDefaultLimit).toBeNull();
  });

  it('persists restrictGrantCommands + defaultLimit and syncs in-memory config', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotGrantPrefs('app_default', {
      restrictGrantCommands: true,
      messageQuotaDefaultLimit: 20,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.prefs.restrictGrantCommands).toBe(true);
      expect(r.prefs.messageQuotaDefaultLimit).toBe(20);
    }

    const disk = readConfig();
    expect(disk.restrictGrantCommands).toBe(true);
    expect(disk.messageQuota).toEqual({ defaultLimit: 20 });

    const cfg = registry.getBot('app_default').config;
    expect(cfg.restrictGrantCommands).toBe(true);
    expect(cfg.messageQuota).toEqual({ defaultLimit: 20 });
  });

  it('removes restrictGrantCommands key when toggled off (keeps bots.json tidy)', async () => {
    writeConfig({ restrictGrantCommands: true });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    await store.updateBotGrantPrefs('app_default', { restrictGrantCommands: false });

    expect(readConfig().restrictGrantCommands).toBeUndefined();
    expect(registry.getBot('app_default').config.restrictGrantCommands).toBeUndefined();
  });

  it('defaults autoGrantRequestCards to true when unset', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    expect(store.getBotGrantPrefs('app_default').autoGrantRequestCards).toBe(true);
  });

  it('persists autoGrantRequestCards=false and syncs in-memory config', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotGrantPrefs('app_default', { autoGrantRequestCards: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prefs.autoGrantRequestCards).toBe(false);

    expect(readConfig().autoGrantRequestCards).toBe(false);
    expect(registry.getBot('app_default').config.autoGrantRequestCards).toBe(false);
  });

  it('removes autoGrantRequestCards key when toggled back on (default stays tidy)', async () => {
    writeConfig({ autoGrantRequestCards: false });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));
    // Sanity: explicit false is parsed and surfaced before we flip it back.
    expect(store.getBotGrantPrefs('app_default').autoGrantRequestCards).toBe(false);

    const r = await store.updateBotGrantPrefs('app_default', { autoGrantRequestCards: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prefs.autoGrantRequestCards).toBe(true);

    // Default-on → key deleted from disk and in-memory config (undefined === on).
    expect(readConfig().autoGrantRequestCards).toBeUndefined();
    expect(registry.getBot('app_default').config.autoGrantRequestCards).toBeUndefined();
  });

  it('partial patch preserves an explicit autoGrantRequestCards=false', async () => {
    writeConfig({ autoGrantRequestCards: false });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    // Flip only restrict; the auto-card opt-out must survive the read-modify-write.
    await store.updateBotGrantPrefs('app_default', { restrictGrantCommands: true });

    const disk = readConfig();
    expect(disk.restrictGrantCommands).toBe(true);
    expect(disk.autoGrantRequestCards).toBe(false);
  });

  it('getBotGrantPrefs catch-fallback returns autoGrantRequestCards=true for an unknown bot', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    // Unregistered bot → getBot throws → safe defaults (auto-card on).
    expect(store.getBotGrantPrefs('app_missing')).toEqual({
      restrictGrantCommands: false,
      autoGrantRequestCards: true,
      messageQuotaDefaultLimit: null,
    });
  });

  it('null defaultLimit deletes messageQuota but preserves quotaState counters', async () => {
    writeConfig({
      messageQuota: { defaultLimit: 5 },
      quotaState: { 'chat:oc_1:ou_a': { limit: 5, used: 2 } },
    });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    await store.updateBotGrantPrefs('app_default', { messageQuotaDefaultLimit: null });

    const disk = readConfig();
    expect(disk.messageQuota).toBeUndefined();
    // Turning the default limit off must NOT wipe existing per-grant counters.
    expect(disk.quotaState).toEqual({ 'chat:oc_1:ou_a': { limit: 5, used: 2 } });
    expect(registry.getBot('app_default').config.messageQuota).toBeUndefined();
  });

  it('rejects non-positive / non-integer quota without writing', async () => {
    writeConfig({ messageQuota: { defaultLimit: 7 } });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    for (const bad of [0, -3, 2.5]) {
      const r = await store.updateBotGrantPrefs('app_default', { messageQuotaDefaultLimit: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('bad_quota');
    }
    // Original value untouched.
    expect(readConfig().messageQuota).toEqual({ defaultLimit: 7 });
  });

  it('partial patch leaves the untouched field intact', async () => {
    writeConfig({ messageQuota: { defaultLimit: 9 } });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    // Only flip restrict; the quota must survive.
    await store.updateBotGrantPrefs('app_default', { restrictGrantCommands: true });

    const disk = readConfig();
    expect(disk.restrictGrantCommands).toBe(true);
    expect(disk.messageQuota).toEqual({ defaultLimit: 9 });
  });

  it('returns bot_not_registered for an unknown bot', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotGrantPrefs('app_missing', { restrictGrantCommands: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bot_not_registered');
  });
});
