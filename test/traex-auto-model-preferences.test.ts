import { describe, expect, it } from 'vitest';
import {
  strongestTraexModelSettings, readAutoModelDraft, writeAutoModelDraft, clearAutoModelDraft,
  autoModelDraftFromConfig,
  type AutoModelDraftStorage,
} from '../src/dashboard/web/traex-auto-model-preferences.js';

const catalog = {
  slug: 'GPT-5.6-Sol', serviceTiers: [], reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'ultra'],
  contextWindow: 272000,
  contextVariants: [
    { id: 'standard' as const, contextWindow: 272000, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'max' as const, contextWindow: 800000, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
  ],
};

describe('Auto model defaults and reload persistence', () => {
  it('defaults to the maximum supported combination rather than an incompatible model-wide effort', () => {
    expect(strongestTraexModelSettings('GPT-5.6-Sol', catalog))
      .toEqual({ reasoningEffort: 'xhigh', modelBackendVariant: 'max' });
    expect(strongestTraexModelSettings('unknown', { slug: 'unknown', serviceTiers: [], contextVariants: [] }).modelBackendVariant)
      .toBeUndefined();
  });

  it('stores unfinished selections synchronously and isolates bots; clearing one after save preserves another', () => {
    const entries = new Map<string, string>();
    const storage: AutoModelDraftStorage = {
      getItem: key => entries.get(key) ?? null,
      setItem: (key, value) => { entries.set(key, value); },
      removeItem: key => { entries.delete(key); },
    };
    const draft = { enabled: true, reselectPerTurn: true, models: ['GPT-5.6-Sol', ''], modelSettings: {
      'GPT-5.6-Sol': { reasoningEffort: 'xhigh' as const, modelBackendVariant: 'standard' as const },
    }, timeoutSeconds: '30', cooldownSeconds: '60' };
    const { enabled: _enabled, ...preferences } = draft;
    expect(writeAutoModelDraft('bot1', draft, storage)).toBe(true);
    expect(JSON.parse([...entries.values()][0]).draft).not.toHaveProperty('enabled');
    expect(readAutoModelDraft('bot1', storage)).toEqual(preferences);
    expect(readAutoModelDraft('bot2', storage)).toBeUndefined();
    writeAutoModelDraft('bot2', draft, storage);
    clearAutoModelDraft('bot1', storage);
    expect(readAutoModelDraft('bot1', storage)).toBeUndefined();
    expect(readAutoModelDraft('bot2', storage)).toEqual(preferences);
    expect(autoModelDraftFromConfig().reselectPerTurn).toBe(false);
  });

  it('ignores the switch carried by old drafts and restores only saved activation', () => {
    const legacy = { enabled: true, reselectPerTurn: true, models: ['draft-model'],
      modelSettings: { 'draft-model': { reasoningEffort: 'high' as const } },
      timeoutSeconds: '25', cooldownSeconds: '50' };
    let raw = JSON.stringify({ version: 1, draft: legacy });
    const storage = { getItem: () => raw, setItem: () => {}, removeItem: () => {} };
    const preferences = readAutoModelDraft('old-draft', storage);
    expect(preferences).not.toHaveProperty('enabled');
    expect(autoModelDraftFromConfig(undefined, {}, preferences)).toMatchObject({
      enabled: false, models: legacy.models, modelSettings: legacy.modelSettings,
    });
    raw = JSON.stringify({ version: 1, draft: { ...legacy, enabled: false } });
    const configured = { enabled: true as const, models: ['saved-model'], queueTimeoutMs: 30_000 };
    expect(autoModelDraftFromConfig(configured, {}, readAutoModelDraft('old-draft', storage)))
      .toMatchObject({ enabled: true, models: legacy.models, timeoutSeconds: legacy.timeoutSeconds });
  });
});
