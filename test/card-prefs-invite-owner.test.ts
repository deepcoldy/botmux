/**
 * Unit tests for autoInviteOwnerOnGroupAdd card-prefs persistence:
 * default-true semantics — only an explicit false is persisted, patching true
 * clears the key back to the default (same convention as thinkingCard).
 *
 * Run: bunx vitest run test/card-prefs-invite-owner.test.ts
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
  const pinStreamingCardChange = await import('../src/services/pin-streaming-card-change.js');
  return { registry, botConfigStore, store, pinStreamingCardChange };
}

describe('card-prefs store — autoInviteOwnerOnGroupAdd', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cardprefs-inviteowner-'));
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

  it('defaults to true when unset', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    expect(store.getBotCardPrefs('app_default').autoInviteOwnerOnGroupAdd).toBe(true);
  });

  it('persists explicit false to disk and in-memory config', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotCardPrefs('app_default', { autoInviteOwnerOnGroupAdd: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prefs.autoInviteOwnerOnGroupAdd).toBe(false);
    expect(readConfig().autoInviteOwnerOnGroupAdd).toBe(false);
    expect(registry.getBot('app_default').config.autoInviteOwnerOnGroupAdd).toBe(false);
  });

  it('clears the key when patched back to true (default on)', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    await store.updateBotCardPrefs('app_default', { autoInviteOwnerOnGroupAdd: false });
    const r = await store.updateBotCardPrefs('app_default', { autoInviteOwnerOnGroupAdd: true });
    expect(r.ok).toBe(true);
    expect(readConfig().autoInviteOwnerOnGroupAdd).toBeUndefined();
    expect(store.getBotCardPrefs('app_default').autoInviteOwnerOnGroupAdd).toBe(true);
    expect(registry.getBot('app_default').config.autoInviteOwnerOnGroupAdd).toBeUndefined();
  });

  it('does not clobber the field when patching an unrelated preference', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    await store.updateBotCardPrefs('app_default', { autoInviteOwnerOnGroupAdd: false });
    await store.updateBotCardPrefs('app_default', { autoStartOnNewTopic: true });
    expect(readConfig().autoInviteOwnerOnGroupAdd).toBe(false);
  });

  it('/botconfig field is default-on: set off persists false, set on clears the key', async () => {
    writeConfig();
    const { registry, botConfigStore } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const spec = botConfigStore.findConfigField('AUTOINVITEOWNERONGROUPADD')!;
    expect(spec).toBeDefined();
    expect(spec.kind).toBe('boolean');
    expect(spec.defaultOn).toBe(true);
    expect(spec.effect).toBe('immediate');

    const off = await botConfigStore.applyConfigField('app_default', spec, false);
    expect(off.ok).toBe(true);
    expect(readConfig().autoInviteOwnerOnGroupAdd).toBe(false);
    expect(registry.getBot('app_default').config.autoInviteOwnerOnGroupAdd).toBe(false);

    const on = await botConfigStore.applyConfigField('app_default', spec, true);
    expect(on.ok).toBe(true);
    expect(readConfig().autoInviteOwnerOnGroupAdd).toBeUndefined();
    expect(registry.getBot('app_default').config.autoInviteOwnerOnGroupAdd).toBeUndefined();
  });
});
