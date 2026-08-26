export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const CODEX_COMMON_REASONING_EFFORTS = CODEX_REASONING_EFFORTS.slice(0, 4);
export const GROK_REASONING_EFFORTS = CODEX_REASONING_EFFORTS.slice(0, 4);
export const GROK_COMMON_REASONING_EFFORTS = GROK_REASONING_EFFORTS.slice(0, 3);
export const TRAEX_COMMON_REASONING_EFFORTS = CODEX_REASONING_EFFORTS.slice(0, 3);

export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];

const SIX_LEVEL_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra']);
const FIVE_LEVEL_MODELS = new Set(['gpt-5.6-luna']);
const GROK_XHIGH_MODELS = new Set(['grok-4.6']);
const TRAEX_REASONING_EFFORTS_BY_MODEL = new Map<string, readonly CodexReasoningEffort[]>([
  ['openrouter-3o', CODEX_REASONING_EFFORTS.slice(0, 5)],
  ['openrouter-2o', CODEX_REASONING_EFFORTS.slice(0, 5)],
  ['gpt-5.6-sol', ['low', 'medium', 'high', 'xhigh', 'ultra']],
  ['gpt-5.6-terra', CODEX_COMMON_REASONING_EFFORTS],
  ['gpt-5.6-luna', CODEX_COMMON_REASONING_EFFORTS],
  ['gpt-5.5', CODEX_COMMON_REASONING_EFFORTS],
  ['gpt-5.4', CODEX_COMMON_REASONING_EFFORTS],
  ['gpt-5.4-mini', CODEX_COMMON_REASONING_EFFORTS],
  ['gpt-5.3-codex', CODEX_COMMON_REASONING_EFFORTS],
  ['gpt-5.2', CODEX_COMMON_REASONING_EFFORTS],
  ['codex-auto-review', CODEX_COMMON_REASONING_EFFORTS],
  ['deepseek-v4-pro', TRAEX_COMMON_REASONING_EFFORTS],
  ['deepseek-v4-flash', TRAEX_COMMON_REASONING_EFFORTS],
  ['seed-dogfooding-2.0', TRAEX_COMMON_REASONING_EFFORTS],
  ['openrouter-1o', ['low', 'medium', 'high', 'max']],
  ['openrouter-1', ['low', 'medium', 'high', 'max']],
  ['gemini-3.1-pro-preview', TRAEX_COMMON_REASONING_EFFORTS],
  ['gemini-3-flash-preview', TRAEX_COMMON_REASONING_EFFORTS],
]);

export function isCodexReasoningCliId(cliId: string | undefined): boolean {
  return cliId === 'codex' || cliId === 'codex-app';
}

export function isConfigurableReasoningCliId(cliId: string | undefined): boolean {
  return isCodexReasoningCliId(cliId) || cliId === 'grok' || cliId === 'traex';
}

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === 'string' && CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort);
}

/** Unknown models get only the catalog-wide safe intersection. */
export function codexReasoningEffortsForModel(model: string | undefined): readonly CodexReasoningEffort[] {
  const normalized = model?.trim().toLowerCase() ?? '';
  if (SIX_LEVEL_MODELS.has(normalized)) return CODEX_REASONING_EFFORTS;
  if (FIVE_LEVEL_MODELS.has(normalized)) return CODEX_REASONING_EFFORTS.slice(0, 5);
  return CODEX_COMMON_REASONING_EFFORTS;
}

export function codexModelSupportsReasoningEffort(model: string | undefined, effort: CodexReasoningEffort): boolean {
  return codexReasoningEffortsForModel(model).includes(effort);
}

/** Unknown Grok models get the verified catalog-wide safe intersection. */
export function grokReasoningEffortsForModel(model: string | undefined): readonly CodexReasoningEffort[] {
  const normalized = model?.trim().toLowerCase() ?? '';
  if (GROK_XHIGH_MODELS.has(normalized)) return GROK_REASONING_EFFORTS;
  return GROK_COMMON_REASONING_EFFORTS;
}

export function traexReasoningEffortsForModel(model: string | undefined): readonly CodexReasoningEffort[] {
  const normalized = model?.trim().toLowerCase() ?? '';
  if (!normalized) return [];
  return TRAEX_REASONING_EFFORTS_BY_MODEL.get(normalized) ?? [];
}

/** Reasoning choices exposed by a CLI's Botmux control plane. */
export function reasoningEffortsForCliModel(
  cliId: string | undefined,
  model: string | undefined,
): readonly CodexReasoningEffort[] {
  if (cliId === 'grok') return grokReasoningEffortsForModel(model);
  if (cliId === 'traex') return traexReasoningEffortsForModel(model);
  if (isCodexReasoningCliId(cliId)) return codexReasoningEffortsForModel(model);
  return [];
}

export function cliModelSupportsReasoningEffort(
  cliId: string | undefined,
  model: string | undefined,
  effort: CodexReasoningEffort,
): boolean {
  return reasoningEffortsForCliModel(cliId, model).includes(effort);
}
