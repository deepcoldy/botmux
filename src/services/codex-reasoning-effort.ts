export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const CODEX_COMMON_REASONING_EFFORTS = CODEX_REASONING_EFFORTS.slice(0, 4);

export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];

const SIX_LEVEL_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra']);
const FIVE_LEVEL_MODELS = new Set(['gpt-5.6-luna']);

export function isCodexReasoningCliId(cliId: string | undefined): boolean {
  return cliId === 'codex' || cliId === 'codex-app';
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
