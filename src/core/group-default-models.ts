import { isCodexReasoningEffort, type CodexReasoningEffort } from '../services/codex-reasoning-effort.js';

export interface GroupModelSettings { model?: string; reasoningEffort?: CodexReasoningEffort }
export function groupModelSettings(value: string | GroupModelSettings | undefined): GroupModelSettings {
  return typeof value === 'string' ? { model: value } : value ?? {};
}

/** New-topic defaults, keyed by CLI so model names never cross providers. */
export type GroupDefaultModels = Partial<Record<'codex' | 'claude-code', string | GroupModelSettings>>;

export function parseGroupDefaultModels(raw: unknown): GroupDefaultModels {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('default_models_must_be_object');
  }
  const models: GroupDefaultModels = {};
  for (const [cli, value] of Object.entries(raw)) {
    if (cli !== 'codex' && cli !== 'claude-code') throw new Error('unsupported_model_cli');
    const settings = typeof value === 'string' ? { model: value } : value;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
        || Object.keys(settings).some(key => key !== 'model' && key !== 'reasoningEffort')) throw new Error('invalid_model');
    const { model, reasoningEffort } = settings as Record<string, unknown>;
    if (model !== undefined && (typeof model !== 'string' || model.length > 200 || /[\x00-\x1f\x7f]/.test(model))) throw new Error('invalid_model');
    if (reasoningEffort !== undefined && reasoningEffort !== '' && !isCodexReasoningEffort(reasoningEffort)) throw new Error('invalid_reasoning_effort');
    const next: GroupModelSettings = {};
    if (typeof model === 'string' && model.trim()) next.model = model.trim();
    if (isCodexReasoningEffort(reasoningEffort)) next.reasoningEffort = reasoningEffort;
    if (Object.keys(next).length) models[cli] = typeof value === 'string' ? next.model! : next;
  }
  return models;
}

/** Ignore invalid hand-edited entries without dropping other groups. */
export function normalizeGroupDefaultModels(raw: unknown): Record<string, GroupDefaultModels> {
  const groups: Record<string, GroupDefaultModels> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return groups;
  for (const [chatId, value] of Object.entries(raw)) {
    if (!/^oc_[a-zA-Z0-9_-]+$/.test(chatId)) continue;
    try {
      const models = parseGroupDefaultModels(value);
      if (Object.keys(models).length) groups[chatId] = models;
    } catch { /* Invalid config is not a launch argument. */ }
  }
  return groups;
}
