/**
 * Per-bot file-sandbox toggle persistence. Mirrors brand-store: cross-process
 * file lock + atomic bots.json write + in-memory registry sync, so the daemon
 * picks up the change without a restart (the next session spawn reads
 * `botCfg.sandbox` in forkWorker). Pure opt-in; absent = off (legacy behaviour).
 */
import { rmwBotEntry } from './config-store.js';
import { getBot } from '../bot-registry.js';
import { logger } from '../utils/logger.js';

/** Current configured file-sandbox flag for a bot. */
export function getBotSandbox(larkAppId: string): boolean {
  try { return getBot(larkAppId).config.sandbox === true; } catch { return false; }
}

export async function updateBotSandbox(
  larkAppId: string,
  enabled: boolean,
): Promise<{ ok: true; sandbox: boolean } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<boolean>(larkAppId, (entry) => {
    if (enabled) entry.sandbox = true;
    else delete entry.sandbox;  // omit key when off → preserves "absent = off"
    return { write: true, result: enabled };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  bot.config.sandbox = enabled;
  logger.info(`[sandbox:${larkAppId}] sandbox → ${enabled}`);
  return { ok: true, sandbox: enabled };
}
