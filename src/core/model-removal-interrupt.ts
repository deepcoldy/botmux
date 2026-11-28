/** The watcher provides a fresh, complete catalog from the same provider.
 * Host-only, never derive absence from an empty/error/partial response. */
export type ModelRemovalObservation = {
  fetchedAtMs: number;
  availableModels: string[];
};
export type ModelRemovalTarget = { turnId: string; model: string; launchGeneration: string };

const CATALOG_MAX_AGE_MS = 60_000;

export function modelRemovalObservation(value: unknown, now: number): ModelRemovalObservation | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>;
  const fetchedAtMs = input.fetchedAtMs;
  const availableModels = input.availableModels;
  if (typeof fetchedAtMs !== 'number' || !Number.isSafeInteger(fetchedAtMs)
      || fetchedAtMs > now || now - fetchedAtMs > CATALOG_MAX_AGE_MS
      || input.complete !== true || !Array.isArray(availableModels)
      || availableModels.length === 0 || availableModels.length > 512
      || !availableModels.every(model => typeof model === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(model))) return;
  return { fetchedAtMs, availableModels };
}

export function shouldInterruptRemovedModel(
  expected: ModelRemovalTarget,
  current: ModelRemovalTarget | undefined,
  observation: ModelRemovalObservation,
  now: number,
): boolean {
  return !!current && expected.turnId === current.turnId && expected.model === current.model
    && expected.launchGeneration === current.launchGeneration && observation.fetchedAtMs <= now
    && now - observation.fetchedAtMs <= CATALOG_MAX_AGE_MS
    && !observation.availableModels.includes(current.model);
}

export type ModelRemovalInterruptReceipt = { turnId: string; dispatchAttempt?: number; generation: number };

export function isModelRemovalAbort(
  receipt: ModelRemovalInterruptReceipt | undefined,
  turn: { turnId: string; dispatchAttempt?: number; terminalErrorCode?: string; terminalStatus?: string },
  generation: number,
): boolean {
  return !!receipt && receipt.generation === generation && receipt.turnId === turn.turnId
    && receipt.dispatchAttempt === turn.dispatchAttempt && turn.terminalStatus === 'ambiguous'
    && !!turn.terminalErrorCode?.startsWith('codex_turn_aborted:');
}
