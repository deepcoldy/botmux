import { isCodexReasoningEffort, reasoningEffortsForCliModel } from '../../services/codex-reasoning-effort.js';
import {
  resolveTraexAutoModelSettings,
  strongestTraexPreflightReasoningEffort,
  type TraexAutoModelConfig,
  type TraexAutoModelSettings,
} from '../../services/traex-auto-model.js';
import type { ModelCapabilities } from './bot-defaults.js';

/** Pick the strongest combination advertised for the largest context variant.
 * Variant reasoning limits outrank the model-wide union (e.g. ultra may be
 * advertised only outside Standard/Max). Missing metadata never invents Max. */
export function strongestTraexModelSettings(model: string, capability?: ModelCapabilities): TraexAutoModelSettings {
  const variant = capability?.contextVariants?.length
    ? capability.contextVariants.reduce((largest, item) => item.contextWindow > largest.contextWindow ? item : largest)
    : undefined;
  const efforts = variant?.reasoningEfforts ?? capability?.reasoningEfforts
    ?? reasoningEffortsForCliModel('traex', model);
  const reasoningEffort = [...['ultra', 'max', 'xhigh', 'high', 'medium', 'low'] as const]
    .find(effort => efforts.includes(effort));
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(variant ? { modelBackendVariant: variant.id } : {}),
  };
}

export function strongestTraexPreflightModelSettings(model: string, capability?: ModelCapabilities): TraexAutoModelSettings {
  const variant = capability?.contextVariants?.length
    ? capability.contextVariants.reduce((largest, item) => item.contextWindow > largest.contextWindow ? item : largest)
    : undefined;
  const efforts = variant?.reasoningEfforts ?? capability?.reasoningEfforts
    ?? reasoningEffortsForCliModel('traex', model);
  const reasoningEffort = strongestTraexPreflightReasoningEffort(model, efforts);
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(variant ? { modelBackendVariant: variant.id } : {}),
  };
}

export interface TraexAutoModelPreferences {
  trigger?: 'capacity' | 'quota';
  preflightLoadCheck?: boolean;
  overloadThresholdPercent?: string;
  preflightTimeoutSeconds?: string;
  unknownLoadPolicy?: 'skip';
  allOverloadedPolicy?: 'lowest_load';
  reselectPerTurn: boolean;
  models: string[];
  modelSettings: Record<string, TraexAutoModelSettings>;
  timeoutSeconds: string;
  cooldownSeconds: string;
}

export interface TraexAutoModelDraft extends TraexAutoModelPreferences {
  enabled: boolean;
}

export function autoModelDraftFromConfig(
  config?: TraexAutoModelConfig,
  legacy: TraexAutoModelSettings = {},
  preferences?: TraexAutoModelPreferences,
  enabled = config?.enabled === true,
): TraexAutoModelDraft {
  return {
    ...(config?.trigger ? { trigger: config.trigger } : {}),
    preflightLoadCheck: config?.preflightLoadCheck === true,
    overloadThresholdPercent: String(config?.overloadThresholdPercent ?? 100),
    preflightTimeoutSeconds: String((config?.preflightTimeoutMs ?? 8_000) / 1_000),
    unknownLoadPolicy: config?.unknownLoadPolicy ?? 'skip',
    allOverloadedPolicy: config?.allOverloadedPolicy ?? 'lowest_load',
    reselectPerTurn: config?.reselectPerTurn === true,
    models: config?.models ?? [],
    modelSettings: Object.fromEntries((config?.models ?? []).map(model => {
      const settings = resolveTraexAutoModelSettings(config!, model, legacy);
      return [model, config?.preflightLoadCheck === true
        ? { ...settings, reasoningEffort: strongestTraexPreflightModelSettings(model).reasoningEffort }
        : settings];
    })),
    timeoutSeconds: String((config?.queueTimeoutMs ?? 30_000) / 1_000),
    cooldownSeconds: String((config?.switchCooldownMs ?? 60_000) / 1_000),
    ...preferences,
    // Reload always reflects the saved switch, even for legacy drafts that
    // carried enabled. Only the pool preferences survive an unfinished edit.
    enabled,
  };
}

export interface AutoModelDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const keyFor = (botId: string) => `botmux:traex-auto-model-draft:v1:${encodeURIComponent(botId)}`;
export function autoModelDraftStorage(): AutoModelDraftStorage | undefined {
  try { return typeof window !== 'undefined' ? window.localStorage : undefined; }
  catch { return undefined; }
}

export function readAutoModelDraft(botId: string, storage = autoModelDraftStorage()): TraexAutoModelPreferences | undefined {
  try {
    const raw = storage?.getItem(keyFor(botId));
    if (!raw) return undefined;
    const value = JSON.parse(raw);
    if (value.version !== 1 || !Array.isArray(value.draft?.models)
      || !value.draft.models.every((model: unknown) => typeof model === 'string')
      || typeof value.draft.timeoutSeconds !== 'string' || typeof value.draft.cooldownSeconds !== 'string'
      || !value.draft.modelSettings || typeof value.draft.modelSettings !== 'object'
      || Array.isArray(value.draft.modelSettings)) return undefined;
    for (const settings of Object.values(value.draft.modelSettings) as any[]) {
      if (!settings || typeof settings !== 'object'
        || (settings.reasoningEffort !== undefined && !isCodexReasoningEffort(settings.reasoningEffort))
        || (settings.modelBackendVariant !== undefined && settings.modelBackendVariant !== 'standard' && settings.modelBackendVariant !== 'max')) {
        return undefined;
      }
    }
    if (value.draft.reselectPerTurn !== undefined && typeof value.draft.reselectPerTurn !== 'boolean') return undefined;
    if (value.draft.preflightLoadCheck !== undefined && typeof value.draft.preflightLoadCheck !== 'boolean') return undefined;
    if (value.draft.overloadThresholdPercent !== undefined && typeof value.draft.overloadThresholdPercent !== 'string') return undefined;
    if (value.draft.preflightTimeoutSeconds !== undefined && typeof value.draft.preflightTimeoutSeconds !== 'string') return undefined;
    if (value.draft.unknownLoadPolicy !== undefined && value.draft.unknownLoadPolicy !== 'skip') return undefined;
    if (value.draft.allOverloadedPolicy !== undefined && value.draft.allOverloadedPolicy !== 'lowest_load') return undefined;
    if (value.draft.trigger !== undefined && !['capacity', 'quota'].includes(value.draft.trigger)) return undefined;
    return {
      ...(value.draft.trigger ? { trigger: value.draft.trigger } : {}),
      preflightLoadCheck: value.draft.preflightLoadCheck === true,
      overloadThresholdPercent: value.draft.overloadThresholdPercent ?? '100',
      preflightTimeoutSeconds: value.draft.preflightTimeoutSeconds ?? '8',
      unknownLoadPolicy: value.draft.unknownLoadPolicy ?? 'skip',
      allOverloadedPolicy: value.draft.allOverloadedPolicy ?? 'lowest_load',
      reselectPerTurn: value.draft.reselectPerTurn === true,
      models: value.draft.models,
      modelSettings: value.draft.modelSettings,
      timeoutSeconds: value.draft.timeoutSeconds,
      cooldownSeconds: value.draft.cooldownSeconds,
    };
  } catch { return undefined; }
}

/** Called synchronously at the edit edge so reload cannot outrun a debounced
 * timer or effect. Only per-bot model preferences are stored, no credentials. */
export function writeAutoModelDraft(botId: string, draft: TraexAutoModelPreferences, storage = autoModelDraftStorage()): boolean {
  try {
    if (!storage) return false;
    const { trigger, preflightLoadCheck, overloadThresholdPercent, preflightTimeoutSeconds,
      unknownLoadPolicy, allOverloadedPolicy, reselectPerTurn, models, modelSettings,
      timeoutSeconds, cooldownSeconds } = draft;
    storage.setItem(keyFor(botId), JSON.stringify({
      version: 1, draft: { trigger, preflightLoadCheck, overloadThresholdPercent,
        preflightTimeoutSeconds, unknownLoadPolicy, allOverloadedPolicy,
        reselectPerTurn, models, modelSettings, timeoutSeconds, cooldownSeconds },
    }));
    return true;
  } catch { return false; }
}

export function clearAutoModelDraft(botId: string, storage = autoModelDraftStorage()): void {
  try { storage?.removeItem(keyFor(botId)); } catch { /* restricted browser storage */ }
}
