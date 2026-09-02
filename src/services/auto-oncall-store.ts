/**
 * Trusted bot-added events grant talk-only access to the current bot × chat.
 * The automatic source is stored separately from manual allowedChatGroups so
 * removing the bot can revoke only the access created by that event.
 */
import { getBot } from '../bot-registry.js';
import { logger } from '../utils/logger.js';
import { rmwBotEntry } from './config-store.js';

type Fail = { ok: false; reason: string };

export function isAutoOncallOperator(larkAppId: string, operatorOpenId: string | undefined): boolean {
  if (!operatorOpenId) return false;
  try {
    return getBot(larkAppId).config.autoOncallOperatorOpenIds?.includes(operatorOpenId) === true;
  } catch {
    return false;
  }
}

export async function addAutoOncallChat(
  larkAppId: string,
  chatId: string,
): Promise<{ ok: true; created: boolean } | Fail> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<{ created: boolean }>(larkAppId, (entry) => {
    const current: string[] = Array.isArray(entry.autoOncallChats) ? entry.autoOncallChats : [];
    const created = !current.includes(chatId);
    if (created) entry.autoOncallChats = [...current, chatId];
    return { write: created, result: { created } };
  });
  if (!r.ok) return r;

  const inMemory = bot.config.autoOncallChats ?? [];
  if (!inMemory.includes(chatId)) bot.config.autoOncallChats = [...inMemory, chatId];
  if (r.result.created) logger.info(`[auto-oncall:${larkAppId}] +chat ${chatId}`);
  return { ok: true, created: r.result.created };
}

export async function removeAutoOncallChat(
  larkAppId: string,
  chatId: string,
): Promise<{ ok: true; removed: boolean } | Fail> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<{ removed: boolean }>(larkAppId, (entry) => {
    const current: string[] = Array.isArray(entry.autoOncallChats) ? entry.autoOncallChats : [];
    const removed = current.includes(chatId);
    const next = current.filter(id => id !== chatId);
    if (next.length > 0) entry.autoOncallChats = next;
    else delete entry.autoOncallChats;
    return { write: removed, result: { removed } };
  });
  if (!r.ok) return r;

  const next = (bot.config.autoOncallChats ?? []).filter(id => id !== chatId);
  if (next.length > 0) bot.config.autoOncallChats = next;
  else delete bot.config.autoOncallChats;
  if (r.result.removed) logger.info(`[auto-oncall:${larkAppId}] -chat ${chatId}`);
  return { ok: true, removed: r.result.removed };
}
