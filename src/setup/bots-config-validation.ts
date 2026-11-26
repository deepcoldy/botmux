import { isLocalBotId } from './local-bot.js';

export type BotConfigValidationResult =
  | { ok: true; count: number }
  | { ok: false; message: string };

/**
 * Pure structural validator for parsed `bots.json` content.
 *
 * Mirrors `parseBotConfigsFromText` in `src/bot-registry.ts` (including local
 * `apiOnly: true` bots that omit `larkAppSecret`), without pulling runtime/fs
 * dependencies into the Desktop main bundle.
 */
export function validateBotConfigEntries(parsed: unknown): BotConfigValidationResult {
  if (!Array.isArray(parsed)) {
    return { ok: false, message: 'bots.json must contain a JSON array' };
  }
  if (parsed.length === 0) {
    return { ok: true, count: 0 };
  }
  for (let i = 0; i < parsed.length; i += 1) {
    const bot = parsed[i] as {
      larkAppId?: unknown;
      larkAppSecret?: unknown;
      apiOnly?: unknown;
      localIdentity?: unknown;
    } | null;
    if (!bot || typeof bot !== 'object' || Array.isArray(bot)) {
      return { ok: false, message: `bots.json entry ${i} must be an object` };
    }
    if (typeof bot.larkAppId !== 'string' || bot.larkAppId.trim().length === 0) {
      return { ok: false, message: `bots.json entry ${i} is missing larkAppId` };
    }
    if (bot.localIdentity !== undefined && typeof bot.localIdentity !== 'boolean') {
      return { ok: false, message: `bots.json entry ${i} has invalid localIdentity` };
    }
    if (bot.localIdentity === true) {
      if (bot.apiOnly !== true) {
        return { ok: false, message: `bots.json entry ${i} localIdentity requires apiOnly: true` };
      }
      if (!isLocalBotId(bot.larkAppId)) {
        return { ok: false, message: `bots.json entry ${i} localIdentity requires a local_<slug> larkAppId` };
      }
    }
    if (bot.apiOnly === true) {
      if (bot.larkAppSecret !== undefined && typeof bot.larkAppSecret !== 'string') {
        return { ok: false, message: `bots.json entry ${i} has invalid larkAppSecret` };
      }
    } else if (typeof bot.larkAppSecret !== 'string' || bot.larkAppSecret.trim().length === 0) {
      return { ok: false, message: `bots.json entry ${i} is missing larkAppSecret` };
    }
  }
  return { ok: true, count: parsed.length };
}
