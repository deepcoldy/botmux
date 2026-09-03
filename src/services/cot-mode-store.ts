/**
 * CoT-mode bindings — persist the per-chat "no thinking process message"
 * switch into the bot config JSON (`noCotChats`) and keep the in-memory
 * BotConfig in sync so thinking updates pick up the change without a daemon
 * restart. Independent from the streaming-card switch (`noCardChats`): a chat
 * can keep its live card while muting the CoT bubble, and vice versa.
 *
 * Mirrors card-mode-store: every write goes through `rmwBotEntry` (file lock +
 * read-modify-write against the latest on-disk snapshot) so concurrent daemon
 * processes sharing one bots.json don't lose updates.
 *
 * Permission is enforced at the call site (`/cot` is operator-only); this
 * layer only persists.
 */
import { getBot } from '../bot-registry.js';
import { rmwBotEntry } from './config-store.js';
import { logger } from '../utils/logger.js';

/**
 * Toggle the CoT-message switch for a chat. `off=true` suppresses the thinking
 * bubble; `off=false` restores it (subject to the bot-level `thinkingCard`
 * master switch). `changed` reports whether the set actually moved (idempotent
 * re-toggles return false).
 */
export async function setCotMode(
  larkAppId: string,
  chatId: string,
  off: boolean,
): Promise<{ ok: true; changed: boolean } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<{ changed: boolean }>(larkAppId, (entry) => {
    const cur: string[] = Array.isArray(entry.noCotChats) ? entry.noCotChats : [];
    const has = cur.includes(chatId);
    const changed = off ? !has : has;
    entry.noCotChats = off
      ? (has ? cur : [...cur, chatId])
      : cur.filter((c: string) => c !== chatId);
    return { write: changed, result: { changed } };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  // Keep in-memory config in sync.
  const mem = (bot.config.noCotChats ??= []);
  if (off) {
    if (!mem.includes(chatId)) mem.push(chatId);
  } else {
    bot.config.noCotChats = mem.filter(c => c !== chatId);
  }

  logger.info(`[cot-mode:${larkAppId}] chat=${chatId} off=${off} changed=${r.result.changed}`);
  return { ok: true, changed: r.result.changed };
}
