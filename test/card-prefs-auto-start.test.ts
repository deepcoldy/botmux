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
  });

  it('persists toggles + prompt to bots.json and syncs in-memory config (FR-9)', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotCardPrefs('app_default', {
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '  先做代码审查再回答 ',
      autoStartOnNewTopic: true,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.prefs.autoStartOnGroupJoin).toBe(true);
      expect(r.prefs.autoStartOnNewTopic).toBe(true);
      expect(r.prefs.autoStartOnGroupJoinPrompt).toBe('  先做代码审查再回答 ');
    }

    // On disk
    const disk = readConfig();
    expect(disk.autoStartOnGroupJoin).toBe(true);
    expect(disk.autoStartOnNewTopic).toBe(true);
    expect(disk.autoStartOnGroupJoinPrompt).toBe('  先做代码审查再回答 ');

    // In-memory registry synced (routing reads bot.config directly, no restart)
    const cfg = registry.getBot('app_default').config;
    expect(cfg.autoStartOnGroupJoin).toBe(true);
    expect(cfg.autoStartOnNewTopic).toBe(true);
    expect(cfg.autoStartOnGroupJoinPrompt).toBe('  先做代码审查再回答 ');
  });

  it('removes keys when toggled off / prompt blanked (keeps bots.json tidy)', async () => {
    writeConfig({
      autoStartOnGroupJoin: true,
      autoStartOnGroupJoinPrompt: '旧的 prompt',
      autoStartOnNewTopic: true,
    });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    await store.updateBotCardPrefs('app_default', {
      autoStartOnGroupJoin: false,
      autoStartOnGroupJoinPrompt: '   ',
      autoStartOnNewTopic: false,
    });

    const disk = readConfig();
    expect(disk.autoStartOnGroupJoin).toBeUndefined();
    expect(disk.autoStartOnNewTopic).toBeUndefined();
    expect(disk.autoStartOnGroupJoinPrompt).toBeUndefined();

    const cfg = registry.getBot('app_default').config;
    expect(cfg.autoStartOnGroupJoin).toBeUndefined();
    expect(cfg.autoStartOnNewTopic).toBeUndefined();
    expect(cfg.autoStartOnGroupJoinPrompt).toBeUndefined();
  });

  it('partial patch leaves untouched fields intact', async () => {
    writeConfig({ autoStartOnNewTopic: true });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    // Only toggle the join flag; new-topic flag must survive.
    await store.updateBotCardPrefs('app_default', { autoStartOnGroupJoin: true });

    const disk = readConfig();
    expect(disk.autoStartOnGroupJoin).toBe(true);
    expect(disk.autoStartOnNewTopic).toBe(true);
  });
});
