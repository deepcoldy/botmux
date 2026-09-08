import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/pin-streaming-card-mode-store.js');
  const change = await import('../src/services/pin-streaming-card-change.js');
  return { registry, store, change };
}

describe('pin-streaming-card mode store', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-pin-chat-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
  });

  afterEach(() => {
    delete process.env.BOTS_CONFIG;
  });

  function writeConfig(entries: Array<Record<string, unknown>>) {
    writeFileSync(configPath, JSON.stringify(entries, null, 2), 'utf-8');
  }

  function readConfig(): any[] {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  }

  async function loaded(entries: Array<Record<string, unknown>>) {
    writeConfig(entries);
    const { registry, store, change } = await freshModules();
    registry.loadBotConfigs().forEach((cfg: any) => registry.registerBot(cfg));
    return { registry, store, change };
  }

  it('normalizes existing noPinStreamingCardChats from disk and keeps the list trimmed/deduplicated in memory', async () => {
    const { registry } = await loaded([
      {
        larkAppId: 'app-one',
        larkAppSecret: 'secret',
        cliId: 'claude-code',
        pinStreamingCard: true,
        noPinStreamingCardChats: [' oc_chat_a ', 'oc_chat_b', 'oc_chat_a', '', '   '],
      },
    ]);

    expect(registry.getBot('app-one').config.noPinStreamingCardChats).toEqual(['oc_chat_a', 'oc_chat_b']);
  });

  it('adds a chat opt-out, syncs disk and live memory before notifying, and reports changed=true', async () => {
    const { registry, store, change } = await loaded([
      {
        larkAppId: 'app-one',
        larkAppSecret: 'secret',
        cliId: 'claude-code',
        pinStreamingCard: true,
      },
    ]);
    const seen: Array<{ appId: string; chatIdList: string[] | undefined; memory: string[] | undefined; enabled: boolean }> = [];
    const dispose = change.registerPinStreamingCardChangeHandler((appId, _enabled, chatId, enabled) => {
      seen.push({
        appId,
        chatIdList: readConfig().find(entry => entry.larkAppId === appId)?.noPinStreamingCardChats,
        memory: registry.getBot(appId).config.noPinStreamingCardChats,
        enabled,
      });
      expect(chatId).toBe('oc_chat_a');
    });

    await expect(store.setChatStreamingCardPin('app-one', 'oc_chat_a', false)).resolves.toEqual({ ok: true, changed: true });

    expect(readConfig()[0].noPinStreamingCardChats).toEqual(['oc_chat_a']);
    expect(registry.getBot('app-one').config.noPinStreamingCardChats).toEqual(['oc_chat_a']);
    expect(seen).toEqual([{
      appId: 'app-one',
      chatIdList: ['oc_chat_a'],
      memory: ['oc_chat_a'],
      enabled: false,
    }]);
    dispose();
  });

  it('removes a chat opt-out, deletes the empty top-level key, and reports changed=true', async () => {
    const { registry, store } = await loaded([
      {
        larkAppId: 'app-one',
        larkAppSecret: 'secret',
        cliId: 'claude-code',
        pinStreamingCard: true,
        noPinStreamingCardChats: ['oc_chat_a'],
      },
    ]);

    await expect(store.setChatStreamingCardPin('app-one', 'oc_chat_a', true)).resolves.toEqual({ ok: true, changed: true });

    expect('noPinStreamingCardChats' in readConfig()[0]).toBe(false);
    expect(registry.getBot('app-one').config.noPinStreamingCardChats).toBeUndefined();
  });

  it('is idempotent for repeated off/on writes and only notifies on effective policy changes', async () => {
    const { registry, store, change } = await loaded([
      {
        larkAppId: 'app-one',
        larkAppSecret: 'secret',
        cliId: 'claude-code',
        pinStreamingCard: true,
        noPinStreamingCardChats: ['oc_chat_a'],
      },
    ]);
    const calls: Array<[string, string, boolean]> = [];
    const dispose = change.registerPinStreamingCardChangeHandler((appId, _masterEnabled, chatId, enabled) => {
      calls.push([appId, chatId, enabled]);
    });

    await expect(store.setChatStreamingCardPin('app-one', 'oc_chat_a', false)).resolves.toEqual({ ok: true, changed: false });
    await expect(store.setChatStreamingCardPin('app-one', 'oc_chat_b', true)).resolves.toEqual({ ok: true, changed: false });

    expect(readConfig()[0].noPinStreamingCardChats).toEqual(['oc_chat_a']);
    expect(registry.getBot('app-one').config.noPinStreamingCardChats).toEqual(['oc_chat_a']);
    expect(calls).toEqual([]);
    dispose();
  });

  it('persists and syncs per-chat off/on mutations under master-off without notifying reconciliation', async () => {
    const { registry, store, change } = await loaded([
      {
        larkAppId: 'app-one',
        larkAppSecret: 'secret',
        cliId: 'claude-code',
        pinStreamingCard: false,
      },
    ]);
    const calls: Array<[string, boolean, string | undefined, boolean | undefined]> = [];
    const dispose = change.registerPinStreamingCardChangeHandler((appId, masterEnabled, chatId, enabled) => {
      calls.push([appId, masterEnabled, chatId, enabled]);
    });

    await expect(store.setChatStreamingCardPin('app-one', 'oc_chat_a', false)).resolves.toEqual({ ok: true, changed: true });
    expect(readConfig()[0].noPinStreamingCardChats).toEqual(['oc_chat_a']);
    expect(registry.getBot('app-one').config.noPinStreamingCardChats).toEqual(['oc_chat_a']);
    expect(calls).toEqual([]);

    await expect(store.setChatStreamingCardPin('app-one', 'oc_chat_a', true)).resolves.toEqual({ ok: true, changed: true });
    expect('noPinStreamingCardChats' in readConfig()[0]).toBe(false);
    expect(registry.getBot('app-one').config.noPinStreamingCardChats).toBeUndefined();
    expect(calls).toEqual([]);

    dispose();
  });

  it('keeps apps isolated so one bot write does not touch another bot', async () => {
    const { registry, store } = await loaded([
      {
        larkAppId: 'app-one',
        larkAppSecret: 'secret',
        cliId: 'claude-code',
        pinStreamingCard: true,
      },
      {
        larkAppId: 'app-two',
        larkAppSecret: 'secret-2',
        cliId: 'codex',
        pinStreamingCard: true,
        noPinStreamingCardChats: ['oc_chat_existing'],
      },
    ]);

    await expect(store.setChatStreamingCardPin('app-one', 'oc_chat_a', false)).resolves.toEqual({ ok: true, changed: true });

    const [first, second] = readConfig();
    expect(first.noPinStreamingCardChats).toEqual(['oc_chat_a']);
    expect(second.noPinStreamingCardChats).toEqual(['oc_chat_existing']);
    expect(registry.getBot('app-two').config.noPinStreamingCardChats).toEqual(['oc_chat_existing']);
  });

  it('returns bot_not_registered for unknown bots', async () => {
    const { store } = await loaded([
      {
        larkAppId: 'app-one',
        larkAppSecret: 'secret',
        cliId: 'claude-code',
      },
    ]);

    await expect(store.setChatStreamingCardPin('missing-app', 'oc_chat_a', false)).resolves.toEqual({
      ok: false,
      reason: 'bot_not_registered',
    });
  });
});
