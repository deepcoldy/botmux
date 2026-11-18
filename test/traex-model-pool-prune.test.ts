import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneSavedTraexModelPool, prunedTraexModelPool, traexCatalogConfigKey } from '../src/services/traex-model-pool-prune.js';
import { normalizeTraexAutoModelConfig, TraexAutoModelController, traexAutoModelPolicyKey } from '../src/services/traex-auto-model.js';
import { parseBotConfigsFromText } from '../src/bot-registry.js';
import { rmwBotEntry } from '../src/services/config-store.js';

const pool = { enabled: true as const, models: ['core', 'removed', 'backup'], queueTimeoutMs: 5_000,
  modelSettings: { core: { reasoningEffort: 'high' as const }, removed: { reasoningEffort: 'xhigh' as const },
    backup: { reasoningEffort: 'medium' as const } } };
let dir: string, path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traex-catalog-prune-')); path = join(dir, 'bots.json');
  writeFileSync(path, JSON.stringify([
    { larkAppId: 'cli_fixture', larkAppSecret: 'fixture', cliId: 'traex', model: 'auto', traexAutoModel: pool, apiOnly: true },
    { larkAppId: 'cli_other', larkAppSecret: 'fixture', cliId: 'codex', model: 'other', apiOnly: true },
  ]));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const read = () => JSON.parse(readFileSync(path, 'utf8'));
const request = (notify: (models: string[]) => Promise<void>) => ({
  path, larkAppId: 'cli_fixture', expectedPolicyKey: traexAutoModelPolicyKey(pool),
  availableModels: ['CORE', 'backup'], isCurrent: () => true, notify,
});

describe('permanent TraeX model-pool cleanup', () => {
  it('notifies before mutation, preserves other bots/settings/order, and does not re-add removed models', async () => {
    const other = read()[1];
    const notify = vi.fn(async (models: string[]) => {
      expect(models).toEqual(['removed']);
      expect(read()[0].traexAutoModel.models).toEqual(pool.models);
    });
    expect((await pruneSavedTraexModelPool(request(notify))).status).toBe('applied');
    expect(notify).toHaveBeenCalledOnce();
    expect(read()[0].traexAutoModel.models).toEqual(['core', 'backup']);
    expect(read()[0].traexAutoModel.modelSettings).toEqual({
      core: pool.modelSettings.core, backup: pool.modelSettings.backup,
    });
    expect(read()[1]).toEqual(other);
    const current = read()[0].traexAutoModel;
    expect((await pruneSavedTraexModelPool({
      ...request(notify), expectedPolicyKey: traexAutoModelPolicyKey(current),
      availableModels: ['core', 'removed', 'backup'],
    })).status).toBe('unchanged');
    expect(read()[0].traexAutoModel.models).toEqual(['core', 'backup']);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('does not mutate when notification fails', async () => {
    const before = readFileSync(path, 'utf8');
    await expect(pruneSavedTraexModelPool(request(async () => { throw new Error('notification failed'); })))
      .rejects.toThrow('notification failed');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('does not overwrite a manual pool edit made while notification is in flight', async () => {
    const result = await pruneSavedTraexModelPool(request(async () => {
      await rmwBotEntry('cli_fixture', entry => {
        entry.traexAutoModel.models = ['core', 'manual-choice'];
        entry.traexAutoModel.modelSettings = {};
        return { write: true, result: null };
      }, { path });
    }));
    expect(result.status).toBe('superseded');
    expect(read()[0].traexAutoModel.models).toEqual(['core', 'manual-choice']);
  });

  it('does not mutate a replacement worker or an empty/inconclusive catalog', async () => {
    const before = readFileSync(path, 'utf8');
    const notify = vi.fn(async () => {});
    expect((await pruneSavedTraexModelPool({ ...request(notify), isCurrent: () => false })).status).toBe('superseded');
    expect((await pruneSavedTraexModelPool({ ...request(notify), availableModels: [] })).status).toBe('failed');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not apply an old account/environment catalog after configuration changes', async () => {
    const expectedContextKey = traexCatalogConfigKey(read()[0]);
    const result = await pruneSavedTraexModelPool({
      ...request(async () => {
        await rmwBotEntry('cli_fixture', entry => {
          entry.env = { TRAECLI_HOME: '/synthetic/new-account' };
          return { write: true, result: null };
        }, { path });
      }), expectedContextKey,
    });
    expect(result.status).toBe('superseded');
    expect(read()[0].traexAutoModel.models).toEqual(pool.models);
    expect(read()[0].env.TRAECLI_HOME).toBe('/synthetic/new-account');
  });

  it('rejects a changed environment inheritance policy before committing a notified cleanup', async () => {
    const expectedContextKey = traexCatalogConfigKey(read()[0]);
    const result = await pruneSavedTraexModelPool({
      ...request(async () => {
        await rmwBotEntry('cli_fixture', entry => {
          entry.envPolicy = { mode: 'strict' };
          return { write: true, result: null };
        }, { path });
      }), expectedContextKey,
    });
    expect(result.status).toBe('superseded');
    expect(read()[0].traexAutoModel.models).toEqual(pool.models);
    expect(read()[0].envPolicy).toEqual({ mode: 'strict' });
  });

  it('persists an empty-pool tombstone without forwarding auto or a native default', async () => {
    const result = await pruneSavedTraexModelPool({ ...request(async () => {}), availableModels: ['unrelated'] });
    expect(result.status).toBe('applied');
    expect(result.config).toMatchObject({ models: [], catalogUnavailable: true });
    const parsed = parseBotConfigsFromText(readFileSync(path, 'utf8'))[0]!;
    expect(parsed.model).toBe('auto');
    expect(parsed.traexAutoModel).toMatchObject({ models: [], catalogUnavailable: true });
    expect(() => new TraexAutoModelController(parsed.traexAutoModel!)).toThrow();
    expect(normalizeTraexAutoModelConfig({ ...pool, models: [] }).error).toBeDefined();
  });
});

describe('catalog identity versus load metadata', () => {
  it('uses the same context key for normalized empty maps and reordered environment keys', () => {
    expect(traexCatalogConfigKey({ cliId: 'traex', env: {}, envUnset: [] }))
      .toBe(traexCatalogConfigKey({ cliId: 'traex' }));
    expect(traexCatalogConfigKey({ cliId: 'traex', env: { B: '2', A: '1' } }))
      .toBe(traexCatalogConfigKey({ cliId: 'traex', env: { A: '1', B: '2' } }));
  });
  it('retains advertised public aliases and never fills the user pool from the catalog', () => {
    const result = prunedTraexModelPool(pool, new Set(['core', 'backup', 'not-requested']));
    expect(result.config.models).toEqual(['core', 'backup']);
    expect(result.removedModels).toEqual(['removed']);
  });
});
