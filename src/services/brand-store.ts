/**
 * Per-bot brandLabel persistence (the custom card-footer label). Mirrors the
 * oncall-store update pattern: cross-process file lock + atomic write of
 * bots.json, plus an in-memory registry sync so the daemon's own card builders
 * pick up the change without a restart. Pure cosmetic — never touches routing
 * or permissions.
 */
import { rmwBotEntry } from './config-store.js';
import { getBot } from '../bot-registry.js';
import { logger } from '../utils/logger.js';

/** Current configured brandLabel for a bot (undefined when unset). */
export function getBotBrandLabel(larkAppId: string): string | undefined {
  try { return getBot(larkAppId).config.brandLabel; } catch { return undefined; }
}

/**
 * Persist a brandLabel change. `null` removes the key entirely (revert to the
 * default botmux brand); a string is stored verbatim — including `''`, which
 * means "brand off" and is deliberately preserved distinct from unset.
 */
export async function updateBotBrandLabel(
  larkAppId: string,
  brandLabel: string | null,
): Promise<{ ok: true; brandLabel: string | null } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<string | null>(larkAppId, (entry) => {
    if (brandLabel === null) delete entry.brandLabel;
    else entry.brandLabel = brandLabel;
    return { write: true, result: brandLabel };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  bot.config.brandLabel = brandLabel === null ? undefined : brandLabel;
  const shown = brandLabel === null ? '∅(default)' : brandLabel === '' ? "''(off)" : JSON.stringify(brandLabel);
  logger.info(`[brand:${larkAppId}] brandLabel → ${shown}`);
  return { ok: true, brandLabel };
}
