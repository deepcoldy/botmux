import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  const store = await import('../src/services/substitute-mode-store.js');
  return { registry, store };
}

describe('substitute-mode store', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-substitute-mode-'));
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

  it('persists substituteMode and syncs in-memory config', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotSubstituteMode('app_default', {
      enabled: true,
      disclosure: 'none',
      targets: [
        { userId: 'u_alice', name: 'Alice' },
        { openId: 'ou_bob', email: 'bob@example.com' },
      ],
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.substituteMode).toEqual({
        enabled: true,
        disclosure: 'none',
        targets: [
          { userId: 'u_alice', name: 'Alice' },
          { openId: 'ou_bob', email: 'bob@example.com' },
        ],
      });
    }
    expect(readConfig().substituteMode).toEqual(registry.getBot('app_default').config.substituteMode);
  });

  it('persists a disabled config with its targets and reloads it', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotSubstituteMode('app_default', {
      enabled: false,
      targets: [{ openId: 'ou_bob', name: 'Bob' }],
    });
    expect(r).toEqual({
      ok: true,
      substituteMode: { enabled: false, disclosure: 'prefix', targets: [{ openId: 'ou_bob', name: 'Bob' }] },
    });
    expect(readConfig().substituteMode.enabled).toBe(false);

    // Loader keeps the disabled config (so the dashboard toggle can flip on
    // without re-entering the list) instead of dropping it.
    const reloaded = await freshModules();
    reloaded.registry.loadBotConfigs().forEach(c => reloaded.registry.registerBot(c));
    expect(reloaded.registry.getBot('app_default').config.substituteMode).toEqual({
      enabled: false,
      disclosure: 'prefix',
      targets: [{ openId: 'ou_bob', name: 'Bob' }],
    });
  });

  it('turns substituteMode off by deleting the key', async () => {
    writeConfig({
      substituteMode: {
        enabled: true,
        targets: [{ userId: 'u_alice', name: 'Alice' }],
      },
    });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.updateBotSubstituteMode('app_default', { enabled: false, targets: [] });

    expect(r).toEqual({ ok: true, substituteMode: null });
    expect(readConfig().substituteMode).toBeUndefined();
    expect(registry.getBot('app_default').config.substituteMode).toBeUndefined();
  });

  it('rejects enabled mode without a matchable target', async () => {
    writeConfig();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    // name-only → not even stored → rejected.
    expect(await store.updateBotSubstituteMode('app_default', {
      enabled: true,
      targets: [{ name: 'No id' }],
    })).toEqual({ ok: false, reason: 'targets_required' });

    // email-only target set → rejected (targets_required), nothing persisted.
    // email is preserved only when it rides alongside a matchable id
    // (openId/userId/unionId); on its own it never matches at runtime, so it
    // must not be able to enable a silently-dead mode.
    expect(await store.updateBotSubstituteMode('app_default', {
      enabled: true,
      targets: [{ email: 'ghost@example.com', name: 'Email only' }],
    })).toEqual({ ok: false, reason: 'targets_required' });

    expect(readConfig().substituteMode).toBeUndefined();
  });
});
