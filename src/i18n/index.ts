/**
 * Lightweight i18n: flat key → translated string with `{name}` interpolation.
 *
 * Resolution order for the active locale at a given call site:
 *   1. explicit `locale` argument to `t()`
 *   2. per-bot `lang` config (resolved via `botLocale()`)
 *   3. process default — set by the entrypoint from `~/.botmux/config.json`
 *      (`setDefaultLocale(...)`), falling back to `'zh'` for backward compat.
 *
 * The i18n module itself stays pure — it does not read the filesystem. The
 * CLI and daemon entrypoints load the global config and call
 * `setDefaultLocale(...)` before any user-facing string is emitted.
 */
import { messages as zhMessages } from './zh.js';
import { messages as enMessages } from './en.js';
import { type Locale, isLocale } from './types.js';

export type { Locale } from './types.js';
export { isLocale, SUPPORTED_LOCALES } from './types.js';

const dictionaries: Record<Locale, Record<string, string>> = {
  zh: zhMessages,
  en: enMessages,
};

let defaultLocale: Locale = 'zh';

export function getDefaultLocale(): Locale {
  return defaultLocale;
}

export function setDefaultLocale(loc: Locale): void {
  defaultLocale = loc;
}

/** Resolve the locale for a given bot's config (used by per-bot code paths). */
export function botLocale(botCfg: { lang?: string } | undefined | null): Locale {
  if (botCfg && isLocale(botCfg.lang)) return botCfg.lang;
  return defaultLocale;
}

type BotConfigLike = { lang?: string };
type BotLookup = (larkAppId: string) => { config: BotConfigLike } | undefined;

let botLookup: BotLookup | undefined;

/**
 * Register a bot-config lookup so `localeForBot()` can resolve a per-bot
 * locale without creating an import cycle between `i18n` and `bot-registry`.
 * Called once by `bot-registry.ts` at module load.
 */
export function setBotLookup(lookup: BotLookup): void {
  botLookup = lookup;
}

/**
 * Resolve the locale for a bot by its larkAppId. Falls back to the process
 * default when the bot is not registered (e.g. CLI tools without a daemon).
 */
export function localeForBot(larkAppId: string | undefined | null): Locale {
  if (!larkAppId || !botLookup) return defaultLocale;
  try {
    return botLocale(botLookup(larkAppId)?.config);
  } catch {
    return defaultLocale;
  }
}

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    const v = params[k];
    return v === undefined || v === null ? `{${k}}` : String(v);
  });
}

/**
 * Optional user-override resolver for built-in prompt copy. Registered by the
 * customization store (via a thin adapter) so i18n stays pure — no filesystem
 * import, no dependency cycle (same DI shape as {@link setBotLookup}).
 *
 * Returns the override string for (key, locale) when the user has customized it
 * AND customization is enabled, else `undefined` to fall through to the shipped
 * dictionary. Returning `undefined` for every key when there are no overrides is
 * what keeps the prompt byte-identical to the pre-feature baseline.
 */
export type PromptOverrideResolver = (key: string, locale: Locale) => string | undefined;

let promptOverrideResolver: PromptOverrideResolver | undefined;

export function setPromptOverrideResolver(resolver: PromptOverrideResolver | undefined): void {
  promptOverrideResolver = resolver;
}

/**
 * The SHIPPED (factory) dictionary value for a key, bypassing any registered
 * override resolver. Used by the customization UI/CLI to show "factory vs your
 * override" and to prefill editors — where consulting the override (as `t()`
 * does) would be circular. Same fallback chain as `t()` minus the override step.
 */
export function shippedText(key: string, locale?: Locale): string {
  const loc = locale ?? defaultLocale;
  return dictionaries[loc]?.[key] ?? dictionaries.zh[key] ?? key;
}

/**
 * Translate a key. Resolution order:
 *   1. a user override for (key, resolved-locale), when registered
 *   2. the active-locale dictionary
 *   3. the Chinese dictionary (fallback)
 *   4. the key itself (so missing keys are loud, not empty)
 *
 * The override lookup is wrapped so a faulty resolver can never break prompt
 * building — any throw falls through to the shipped string.
 */
export function t(key: string, params?: Record<string, string | number>, locale?: Locale): string {
  const loc = locale ?? defaultLocale;
  let tpl: string | undefined;
  if (promptOverrideResolver) {
    try { tpl = promptOverrideResolver(key, loc); } catch { tpl = undefined; }
  }
  if (tpl === undefined) tpl = dictionaries[loc]?.[key] ?? dictionaries.zh[key] ?? key;
  return params ? interpolate(tpl, params) : tpl;
}
