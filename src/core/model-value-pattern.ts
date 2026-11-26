/** Model IDs safe to pass as a single argument to the interactive /model command. */
export const MODEL_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Bot defaults are launch arguments, so they may also carry a #variant suffix. */
export const DEFAULT_MODEL_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}(?:#[A-Za-z0-9._-]{1,32})?$/;

const MAX_CUSTOM_MODELS = 50;

/** A session selection also has to fit the persisted model pin. */
export function isSessionModelPickerValue(model: string): boolean {
  return model.length <= 64 && MODEL_SLUG_PATTERN.test(model);
}

export function normalizeCustomModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || /[\u0000-\u001f\u007f]/.test(entry)) continue;
    const model = entry.trim();
    if (!isSessionModelPickerValue(model)) continue;
    models.add(model);
    if (models.size === MAX_CUSTOM_MODELS) break;
  }
  return models.size ? [...models] : undefined;
}

/** Feishu accepts 50 options per dropdown, including any default sentinel. */
export function limitModelOptions(
  models: readonly string[], selected: string | undefined, hasDefault = false, active?: string,
): string[] {
  const limit = hasDefault ? 49 : 50;
  const unique = [...new Set(models)];
  const retained = new Set([selected, active]);
  let remaining = limit - unique.filter(model => retained.has(model)).length;
  return unique.filter(model => {
    if (retained.has(model)) return true;
    if (remaining <= 0) return false;
    remaining -= 1;
    return true;
  });
}
