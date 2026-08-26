export const BOT_DESCRIPTION_MAX_CHARS = 120;
export const BOT_DESCRIPTION_MAX_LANGUAGES = 20;

export type BotDescriptionValidationFailure = {
  ok: false;
  reason: 'invalid_descriptions' | 'description_required' | 'description_too_long';
  lang?: string;
};

export type BotDescriptionValidationResult =
  | { ok: true; descriptions: Record<string, string> }
  | BotDescriptionValidationFailure;

const LANG = /^[a-z]{2}_[a-z]{2}$/;

export function normalizeBotDescriptions(value: unknown): BotDescriptionValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_descriptions' };
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, reason: 'invalid_descriptions' };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > BOT_DESCRIPTION_MAX_LANGUAGES) {
    return { ok: false, reason: 'invalid_descriptions' };
  }
  const descriptions: Record<string, string> = {};
  for (const [lang, raw] of entries) {
    if (!LANG.test(lang) || typeof raw !== 'string') {
      return { ok: false, reason: 'invalid_descriptions', lang };
    }
    const description = raw.trim();
    if (!description) return { ok: false, reason: 'description_required', lang };
    if (Array.from(description).length > BOT_DESCRIPTION_MAX_CHARS) {
      return { ok: false, reason: 'description_too_long', lang };
    }
    descriptions[lang] = description;
  }
  return { ok: true, descriptions };
}
