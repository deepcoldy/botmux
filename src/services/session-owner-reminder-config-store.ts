import { getBot } from '../bot-registry.js';
import {
  normalizeSessionOwnerReminderConfig,
  type SessionOwnerReminderConfig,
} from '../core/session-owner-reminder.js';
import { rmwBotEntry } from './config-store.js';

export async function updateSessionOwnerReminderConfig(
  larkAppId: string,
  raw: unknown,
): Promise<{ ok: true; config: SessionOwnerReminderConfig } | { ok: false; reason: string }> {
  const normalized = normalizeSessionOwnerReminderConfig(raw);
  if (!normalized) return { ok: false, reason: 'invalid_session_owner_reminder' };
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const result = await rmwBotEntry(larkAppId, (entry) => {
    entry.sessionOwnerReminder = normalized;
    return { write: true, result: undefined };
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  bot.config.sessionOwnerReminder = normalized;
  return { ok: true, config: normalized };
}
