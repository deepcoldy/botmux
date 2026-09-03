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
  vi.doUnmock('../src/services/config-store.js');
  const registry = await import('../src/bot-registry.js');
  const botConfigStore = await import('../src/services/bot-config-store.js');
  const store = await import('../src/services/card-prefs-store.js');
  const pinStreamingCardChange = await import('../src/services/pin-streaming-card-change.js');
  return { registry, botConfigStore, store, pinStreamingCardChange };
}

async function freshModulesWithConfigStoreMock(
  mockFactory: (
    actual: typeof import('../src/services/config-store.js'),
  ) => Promise<typeof import('../src/services/config-store.js')> | typeof import('../src/services/config-store.js'),
) {
  vi.resetModules();
  vi.doMock('../src/services/config-store.js', async () => {
    const actual = await vi.importActual<typeof import('../src/services/config-store.js')>('../src/services/config-store.js');
    return mockFactory(actual);
  });
  const registry = await import('../src/bot-registry.js');
  const botConfigStore = await import('../src/services/bot-config-store.js');
  const store = await import('../src/services/card-prefs-store.js');
  const pinStreamingCardChange = await import('../src/services/pin-streaming-card-change.js');
  return { registry, botConfigStore, store, pinStreamingCardChange };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

  it('defaults to false/empty when unset (FR-10)', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const prefs = store.getBotCardPrefs('app_default');
    expect(prefs.pinStreamingCard).toBe(false);
    expect(prefs.autoStartOnGroupJoin).toBe(false);
    expect(prefs.autoStartOnNewTopic).toBe(false);
    expect(prefs.codexAppCleanInput).toBe(false);
    expect(prefs.autoStartOnGroupJoinPrompt).toBe('');
    expect(prefs.autoStartOnGroupJoinSeed).toBe('');
    expect(prefs.regularGroupReplyMode).toBe('chat-topic');
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

  it('autoStartOnGroupJoinSeed round-trips; blank clears back to the built-in i18n fallback', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    expect(store.getBotCardPrefs('app_default').autoStartOnGroupJoinSeed).toBe('');

    const set = await store.updateBotCardPrefs('app_default', { autoStartOnGroupJoinSeed: '👋 已到岗，待命中' });
    expect(set.ok && set.prefs.autoStartOnGroupJoinSeed).toBe('👋 已到岗，待命中');
    expect(readConfig().autoStartOnGroupJoinSeed).toBe('👋 已到岗，待命中');
    expect(registry.getBot('app_default').config.autoStartOnGroupJoinSeed).toBe('👋 已到岗，待命中');

    // 清空（空白串）→ 删键 + 内存回 undefined，daemon 侧回退内置 i18n 文案。
    const clear = await store.updateBotCardPrefs('app_default', { autoStartOnGroupJoinSeed: '   ' });
    expect(clear.ok && clear.prefs.autoStartOnGroupJoinSeed).toBe('');
    expect(readConfig().autoStartOnGroupJoinSeed).toBeUndefined();
    expect(registry.getBot('app_default').config.autoStartOnGroupJoinSeed).toBeUndefined();
  });

  it('codexAppCleanInput is default-off and round-trips without a restart', async () => {
    writeConfig({ cliId: 'codex-app' });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    expect(store.getBotCardPrefs('app_default').codexAppCleanInput).toBe(false);

    const on = await store.updateBotCardPrefs('app_default', { codexAppCleanInput: true });
    expect(on.ok && on.prefs.codexAppCleanInput).toBe(true);
    expect(readConfig().codexAppCleanInput).toBe(true);
    expect(registry.getBot('app_default').config.codexAppCleanInput).toBe(true);

    // Turning it back off restores the legacy default and removes the key.
    const off = await store.updateBotCardPrefs('app_default', { codexAppCleanInput: false });
    expect(off.ok && off.prefs.codexAppCleanInput).toBe(false);
    expect(readConfig().codexAppCleanInput).toBeUndefined();
    expect(registry.getBot('app_default').config.codexAppCleanInput).toBeUndefined();
  });

  it('pinStreamingCard is default-off and round-trips without a restart', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    expect(store.getBotCardPrefs('app_default').pinStreamingCard).toBe(false);

    const on = await store.updateBotCardPrefs('app_default', { pinStreamingCard: true });
    expect(on.ok && on.prefs.pinStreamingCard).toBe(true);
    expect(readConfig().pinStreamingCard).toBe(true);
    expect(registry.getBot('app_default').config.pinStreamingCard).toBe(true);

    const off = await store.updateBotCardPrefs('app_default', { pinStreamingCard: false });
    expect(off.ok && off.prefs.pinStreamingCard).toBe(false);
    expect(readConfig().pinStreamingCard).toBeUndefined();
    expect(registry.getBot('app_default').config.pinStreamingCard).toBeUndefined();
  });

  it('notifies pinStreamingCard patches only after disk and live memory are synchronized', async () => {
    writeConfig();
    const { registry, store, pinStreamingCardChange } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));
    const observed: Array<{ enabled: boolean; disk: unknown; memory: unknown }> = [];
    const dispose = pinStreamingCardChange.registerPinStreamingCardChangeHandler((appId, enabled) => {
      observed.push({
        enabled,
        disk: readConfig().pinStreamingCard,
        memory: registry.getBot(appId).config.pinStreamingCard,
      });
    });

    try {
      const on = await store.updateBotCardPrefs('app_default', { pinStreamingCard: true });
      expect(on.ok).toBe(true);

      const off = await store.updateBotCardPrefs('app_default', { pinStreamingCard: false });
      expect(off.ok).toBe(true);

      const unrelated = await store.updateBotCardPrefs('app_default', { autoStartOnNewTopic: true });
      expect(unrelated.ok).toBe(true);
    } finally {
      dispose();
    }

    expect(observed).toEqual([
      { enabled: true, disk: true, memory: true },
      { enabled: false, disk: undefined, memory: undefined },
    ]);
  });

  it('does not notify pinStreamingCard no-op writes when the effective boolean is unchanged', async () => {
    writeConfig();
    const { registry, store, pinStreamingCardChange } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));
    const observed: Array<{ enabled: boolean; disk: unknown; memory: unknown }> = [];
    const dispose = pinStreamingCardChange.registerPinStreamingCardChangeHandler((appId, enabled) => {
      observed.push({
        enabled,
        disk: readConfig().pinStreamingCard,
        memory: registry.getBot(appId).config.pinStreamingCard,
      });
    });

    try {
      const offNoop = await store.updateBotCardPrefs('app_default', { pinStreamingCard: false });
      expect(offNoop.ok).toBe(true);

      const on = await store.updateBotCardPrefs('app_default', { pinStreamingCard: true });
      expect(on.ok).toBe(true);

      const onNoop = await store.updateBotCardPrefs('app_default', { pinStreamingCard: true });
      expect(onNoop.ok).toBe(true);

      const off = await store.updateBotCardPrefs('app_default', { pinStreamingCard: false });
      expect(off.ok).toBe(true);

      const offNoopAgain = await store.updateBotCardPrefs('app_default', { pinStreamingCard: false });
      expect(offNoopAgain.ok).toBe(true);
    } finally {
      dispose();
    }

    expect(observed).toEqual([
      { enabled: true, disk: true, memory: true },
      { enabled: false, disk: undefined, memory: undefined },
    ]);
  });

  it('does not notify pinStreamingCard changes when the write fails', async () => {
    writeConfig();
    const { store, pinStreamingCardChange } = await freshModules();
    const seen = vi.fn();
    const dispose = pinStreamingCardChange.registerPinStreamingCardChangeHandler(seen);

    try {
      const result = await store.updateBotCardPrefs('app_missing', { pinStreamingCard: true });
      expect(result).toMatchObject({ ok: false, reason: 'bot_not_registered' });
    } finally {
      dispose();
    }

    expect(seen).not.toHaveBeenCalled();
  });

  it('botToBotSameDir is default-TRUE: persists only explicit false, clears on true', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    // Default ON when unset.
    expect(store.getBotCardPrefs('app_default').botToBotSameDir).toBe(true);

    // Turning OFF persists an explicit `false` to disk + syncs in-memory config.
    const off = await store.updateBotCardPrefs('app_default', { botToBotSameDir: false });
    expect(off.ok && off.prefs.botToBotSameDir).toBe(false);
    expect(readConfig().botToBotSameDir).toBe(false);
    expect(registry.getBot('app_default').config.botToBotSameDir).toBe(false);

    // Turning back ON drops the key (absent === default on) + clears in-memory.
    const on = await store.updateBotCardPrefs('app_default', { botToBotSameDir: true });
    expect(on.ok && on.prefs.botToBotSameDir).toBe(true);
    expect(readConfig().botToBotSameDir).toBeUndefined();
    expect(registry.getBot('app_default').config.botToBotSameDir).toBeUndefined();
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
      regularGroupReplyMode: 'chat-topic',
    });

    const disk = readConfig();
    expect(disk.autoStartOnGroupJoin).toBeUndefined();
    expect(disk.autoStartOnNewTopic).toBeUndefined();
    expect(disk.autoStartOnGroupJoinPrompt).toBeUndefined();
    // 'chat-topic' is now the default → cleared to undefined so bots.json stays tidy.
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

  it('partial patch preserves existing pinStreamingCard on disk, in memory, and in returned prefs', async () => {
    writeConfig({ pinStreamingCard: true, autoStartOnNewTopic: true });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const result = await store.updateBotCardPrefs('app_default', { autoStartOnGroupJoin: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prefs.pinStreamingCard).toBe(true);
      expect(result.prefs.autoStartOnGroupJoin).toBe(true);
    }
    expect(readConfig().pinStreamingCard).toBe(true);
    expect(registry.getBot('app_default').config.pinStreamingCard).toBe(true);
  });

  it('serializes pinStreamingCard writes across dashboard and /botconfig by invocation order', async () => {
    writeConfig();
    const firstAfterDisk = deferred();
    const releaseFirst = deferred();
    let rmwCalls = 0;
    const { registry, botConfigStore, store, pinStreamingCardChange } = await freshModulesWithConfigStoreMock(async (actual) => ({
      ...actual,
      async rmwBotEntry<T>(larkAppId: string, mutate: Parameters<typeof actual.rmwBotEntry<T>>[1]) {
        rmwCalls++;
        const result = await actual.rmwBotEntry<T>(larkAppId, mutate);
        if (rmwCalls === 1) {
          firstAfterDisk.resolve();
          await releaseFirst.promise;
        }
        return result;
      },
    }));
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));
    const spec = botConfigStore.findConfigField('PINSTREAMINGCARD')!;
    const observed: Array<{ enabled: boolean; disk: unknown; memory: unknown }> = [];
    const dispose = pinStreamingCardChange.registerPinStreamingCardChangeHandler((appId, enabled) => {
      observed.push({
        enabled,
        disk: readConfig().pinStreamingCard,
        memory: registry.getBot(appId).config.pinStreamingCard,
      });
    });

    try {
      const dashboardWrite = store.updateBotCardPrefs('app_default', { pinStreamingCard: true });
      await firstAfterDisk.promise;
      expect(readConfig().pinStreamingCard).toBe(true);
      expect(registry.getBot('app_default').config.pinStreamingCard).toBeUndefined();

      const commandWrite = botConfigStore.applyConfigField('app_default', spec, false);
      expect(rmwCalls).toBe(1);

      releaseFirst.resolve();
      const [firstResult, secondResult] = await Promise.all([dashboardWrite, commandWrite]);
      expect(firstResult.ok).toBe(true);
      expect(secondResult.ok).toBe(true);
    } finally {
      dispose();
    }

    expect(readConfig().pinStreamingCard).toBeUndefined();
    expect(registry.getBot('app_default').config.pinStreamingCard).toBeUndefined();
    expect(observed).toEqual([
      { enabled: true, disk: true, memory: true },
      { enabled: false, disk: undefined, memory: undefined },
    ]);
  });
});
