/** Model IDs safe to pass as a single argument to the interactive /model command. */
export const MODEL_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

/** Bot defaults are launch arguments, so they may also carry a #variant suffix. */
export const DEFAULT_MODEL_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}(?:#[A-Za-z0-9._-]{1,32})?$/;

export function normalizeCustomModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || /[\u0000-\u001f\u007f]/.test(entry)) continue;
    const model = entry.trim();
    // Session pins accept model IDs up to 64 characters.
    if (MODEL_SLUG_PATTERN.test(model)) models.add(model);
  }
  return models.size ? [...models] : undefined;
}

/** Feishu accepts 50 options per dropdown, including any default sentinel. */
export function limitModelOptions(models: readonly string[], current: string | undefined, hasDefault = false): string[] {
  const limit = hasDefault ? 49 : 50;
  const unique = [...new Set(models)];
  const choices = unique.slice(0, limit);
  if (current && !choices.includes(current) && unique.includes(current)) {
    return [...choices.slice(0, limit - 1), current];
  }
  return choices;
}
