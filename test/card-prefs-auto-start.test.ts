/**
 * Unit tests for the 主动开工 (proactive auto-start) card-prefs persistence:
 * the two toggles + the 场景① prompt round-trip through bots.json and the
 * in-memory registry (FR-9 / FR-10).
 *
 * Run: pnpm vitest run test/card-prefs-auto-start.test.ts
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
  const store = await import('../src/services/card-prefs-store.js');
  return { registry, store };
}

describe('card-prefs store — 主动开工 fields', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cardprefs-autostart-'));
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

  it('defaults to false/empty when unset (FR-10)', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const prefs = store.getBotCardPrefs('app_default');
    expect(prefs.autoStartOnGroupJoin).toBe(false);
    expect(prefs.autoStartOnNewTopic).toBe(false);
    expect(prefs.autoStartOnGroupJoinPrompt).toBe('');
    expect(prefs.regularGroupReplyMode).toBe('chat');
    expect(prefs.regularGroupMentionMode).toBe('always');
  });

  it('persists toggles + prompt to bots.json and syncs in-memory config (FR-9)', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotCardPrefs('app_default', {
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '  先做代码审查再回答 ',
      autoStartOnNewTopic: true,
      regularGroupReplyMode: 'shared',
      regularGroupMentionMode: 'never',
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.prefs.autoStartOnGroupJoin).toBe(true);
      expect(r.prefs.autoStartOnNewTopic).toBe(true);
      expect(r.prefs.autoStartOnGroupJoinPrompt).toBe('  先做代码审查再回答 ');
      expect(r.prefs.regularGroupReplyMode).toBe('shared');
      expect(r.prefs.regularGroupMentionMode).toBe('never');
    }

    // On disk
    const disk = readConfig();
    expect(disk.autoStartOnGroupJoin).toBe(true);
    expect(disk.autoStartOnNewTopic).toBe(true);
    expect(disk.autoStartOnGroupJoinPrompt).toBe('  先做代码审查再回答 ');
    expect(disk.regularGroupReplyMode).toBe('shared');
    expect(disk.regularGroupMentionMode).toBe('never');

    // In-memory registry synced (routing reads bot.config directly, no restart)
    const cfg = registry.getBot('app_default').config;
    expect(cfg.autoStartOnGroupJoin).toBe(true);
    expect(cfg.autoStartOnNewTopic).toBe(true);
    expect(cfg.autoStartOnGroupJoinPrompt).toBe('  先做代码审查再回答 ');
    expect(cfg.regularGroupReplyMode).toBe('shared');
    expect(cfg.regularGroupMentionMode).toBe('never');
  });

  it('silentTurnReactions round-trips through the dashboard card-prefs store', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    expect(store.getBotCardPrefs('app_default').silentTurnReactions).toBe(false);

    const on = await store.updateBotCardPrefs('app_default', { silentTurnReactions: true });
    expect(on.ok && on.prefs.silentTurnReactions).toBe(true);
    expect(readConfig().silentTurnReactions).toBe(true);
    expect(registry.getBot('app_default').config.silentTurnReactions).toBe(true);

    // Off removes the key (keeps bots.json tidy) and clears in-memory config.
    const off = await store.updateBotCardPrefs('app_default', { silentTurnReactions: false });
    expect(off.ok && off.prefs.silentTurnReactions).toBe(false);
    expect(readConfig().silentTurnReactions).toBeUndefined();
    expect(registry.getBot('app_default').config.silentTurnReactions).toBeUndefined();
  });

  it('removes keys when toggled off / prompt blanked (keeps bots.json tidy)', async () => {
    writeConfig({
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '旧的 prompt',
      autoStartOnNewTopic: true,
      regularGroupReplyMode: 'new-topic',
    });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    await store.updateBotCardPrefs('app_default', {
      autoStartOnGroupJoin: false,
      autoStartOnGroupJoinPrompt: '   ',
      autoStartOnNewTopic: false,
      regularGroupReplyMode: 'chat',
    });

    const disk = readConfig();
    expect(disk.autoStartOnGroupJoin).toBeUndefined();
    expect(disk.autoStartOnNewTopic).toBeUndefined();
    expect(disk.autoStartOnGroupJoinPrompt).toBeUndefined();
    expect(disk.regularGroupReplyMode).toBeUndefined();

    const cfg = registry.getBot('app_default').config;
    expect(cfg.autoStartOnGroupJoin).toBeUndefined();
    expect(cfg.autoStartOnNewTopic).toBeUndefined();
    expect(cfg.autoStartOnGroupJoinPrompt).toBeUndefined();
    expect(cfg.regularGroupReplyMode).toBeUndefined();
  });

  it('partial patch leaves untouched fields intact', async () => {
    writeConfig({ autoStartOnNewTopic: true, regularGroupReplyMode: 'new-topic' });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    // Only toggle the join flag; new-topic flag must survive.
    await store.updateBotCardPrefs('app_default', { autoStartOnGroupJoin: true });

    const disk = readConfig();
    expect(disk.autoStartOnGroupJoin).toBe(true);
    expect(disk.autoStartOnNewTopic).toBe(true);
    expect(disk.regularGroupReplyMode).toBe('new-topic');
  });
});
