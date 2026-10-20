/**
 * Unit tests for reply-footer preferences:
 * default-true semantics — only an explicit false is persisted, patching true
 * clears the key back to the default (same convention as thinkingCard).
 *
 * Run: bunx vitest run test/reply-footer-prefs.test.ts
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

describe('reply footer preference persistence', () => {
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

  it('preserves footer blocks and signature through master off, edits, and on', async () => {
    writeConfig({ brandLabel: 'KEEP THIS SIGNATURE', replyFooterModel: false, usageDisplay: 'footer' });
    const { registry, store, botConfigStore } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));
    expect(registry.resolveReplyFooterPreferences('app_default').replyFooterModel).toBe(false);
    await store.updateBotCardPrefs('app_default', { replyFooterEnabled: false });
    await store.updateBotCardPrefs('app_default', { replyFooterUsage: false, showReplyTiming: true });
    expect(readConfig()).toMatchObject({ replyFooterEnabled: false, replyFooterModel: false, replyFooterUsage: false, brandLabel: 'KEEP THIS SIGNATURE', usageDisplay: 'footer', showReplyTiming: true });
    await store.updateBotCardPrefs('app_default', { replyFooterEnabled: true });
    expect(registry.resolveReplyFooterPreferences('app_default')).toMatchObject({ replyFooterModel: false, replyFooterUsage: false });
    expect(readConfig().replyFooterEnabled).toBeUndefined();
    expect(store.getBotCardPrefs('app_default').showReplyTiming).toBe(true);
    expect(store.getBotCardPrefs('app_default').replyFooterModel).toBe(false);
    const spec = botConfigStore.findConfigField('replyFooterEnabled')!;
    expect(spec.defaultOn).toBe(true);
    await botConfigStore.applyConfigField('app_default', spec, false);
    expect(readConfig().replyFooterEnabled).toBe(false);
    await botConfigStore.applyConfigField('app_default', spec, true);
    expect(readConfig().replyFooterModel).toBe(false);
  });

  it('uses own-bot env only when config is unavailable and ignores other bot identities', async () => {
    const { registry } = await freshModules();
    process.env.BOTMUX_LARK_APP_ID = 'own-app';
    process.env.BOTMUX_REPLY_FOOTER = JSON.stringify({ replyFooterEnabled: false, replyFooterModel: false, unexpected: false });
    try {
      expect(registry.resolveReplyFooterPreferences('own-app')).toEqual({ replyFooterEnabled: false, replyFooterModel: false });
      expect(registry.resolveReplyFooterPreferences('other-app')).toEqual({});
      process.env.BOTMUX_REPLY_FOOTER = '{invalid';
      expect(registry.resolveReplyFooterPreferences('own-app')).toEqual({});
    } finally {
      delete process.env.BOTMUX_LARK_APP_ID;
      delete process.env.BOTMUX_REPLY_FOOTER;
    }
  });
});
