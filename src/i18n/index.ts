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
 * Translate a key. Falls back to the Chinese dictionary, then to the key
 * itself if neither dictionary has the entry (so missing keys are loud
 * rather than silently producing empty strings).
 */
export function t(key: string, params?: Record<string, string | number>, locale?: Locale): string {
  const loc = locale ?? defaultLocale;
  const tpl = dictionaries[loc]?.[key] ?? dictionaries.zh[key] ?? key;
  return params ? interpolate(tpl, params) : tpl;
}
