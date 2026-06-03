/**
 * Card-mode bindings — persist the per-chat "no streaming card" switch into the
 * bot config JSON (`noCardChats`) and keep the in-memory BotConfig in sync so
 * events pick up the change without a daemon restart.
 *
 * Mirrors oncall-store: every write goes through `rmwBotEntry` (file lock +
 * read-modify-write against the latest on-disk snapshot) so concurrent daemon
 * processes sharing one bots.json don't lose updates.
 *
 * Permission is enforced at the call site (`/card` is owner-only); this layer
 * only persists.
 */
import { getBot } from '../bot-registry.js';
import { rmwBotEntry } from './config-store.js';
import { logger } from '../utils/logger.js';

/**
 * Toggle the streaming-card switch for a chat. `off=true` suppresses cards
 * (emoji-reaction mode); `off=false` restores them. `changed` reports whether
 * the set actually moved (idempotent re-toggles return false).
 */
export async function setCardMode(
  larkAppId: string,
  chatId: string,
  off: boolean,
): Promise<{ ok: true; changed: boolean } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<{ changed: boolean }>(larkAppId, (entry) => {
    const cur: string[] = Array.isArray(entry.noCardChats) ? entry.noCardChats : [];
    const has = cur.includes(chatId);
    const changed = off ? !has : has;
    entry.noCardChats = off
      ? (has ? cur : [...cur, chatId])
      : cur.filter((c: string) => c !== chatId);
    return { write: changed, result: { changed } };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  // Keep in-memory config in sync.
  const mem = (bot.config.noCardChats ??= []);
  if (off) {
    if (!mem.includes(chatId)) mem.push(chatId);
  } else {
    bot.config.noCardChats = mem.filter(c => c !== chatId);
  }

  logger.info(`[card-mode:${larkAppId}] chat=${chatId} off=${off} changed=${r.result.changed}`);
  return { ok: true, changed: r.result.changed };
}
