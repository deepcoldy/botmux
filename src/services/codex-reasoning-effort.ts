export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const CODEX_COMMON_REASONING_EFFORTS = CODEX_REASONING_EFFORTS.slice(0, 4);
export const GROK_REASONING_EFFORTS = CODEX_REASONING_EFFORTS.slice(0, 4);
export const GROK_COMMON_REASONING_EFFORTS = GROK_REASONING_EFFORTS.slice(0, 3);

export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];

const SIX_LEVEL_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra']);
const FIVE_LEVEL_MODELS = new Set(['gpt-5.6-luna']);
const GROK_XHIGH_MODELS = new Set(['grok-4.6']);

export function isCodexReasoningCliId(cliId: string | undefined): boolean {
  return cliId === 'codex' || cliId === 'codex-app';
}

export function isConfigurableReasoningCliId(cliId: string | undefined): boolean {
  return isCodexReasoningCliId(cliId) || cliId === 'grok';
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

/** Reasoning choices exposed by a CLI's Botmux control plane. */
export function reasoningEffortsForCliModel(
  cliId: string | undefined,
  model: string | undefined,
): readonly CodexReasoningEffort[] {
  if (cliId === 'grok') return grokReasoningEffortsForModel(model);
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
