import { getBot } from '../bot-registry.js';
import { normalizeLongTaskReminderConfig, type LongTaskReminderConfig } from './long-task-reminder-policy.js';
import { rmwBotEntry } from './config-store.js';

/** Validate and atomically persist preferences before publishing the hot update. */
export async function updateLongTaskReminderConfig(
  larkAppId: string,
  raw: unknown,
): Promise<{ ok: true; config: LongTaskReminderConfig } | { ok: false; reason: string }> {
  /** One parser protects both hand-edited configuration and console writes. */
  const normalized = normalizeLongTaskReminderConfig(raw);
  if (!normalized) {
    return { ok: false, reason: 'invalid_long_task_reminder' };
  }
  /** Resolve the owning bot before making any persistent change. */
  let bot: ReturnType<typeof getBot>;
  try {
    bot = getBot(larkAppId);
  } catch {
    return { ok: false, reason: 'bot_not_registered' };
  }
  /** Serialized read-modify-write preserves concurrent edits to unrelated fields. */
  const result = await rmwBotEntry(larkAppId, entry => {
    entry.longTaskReminder = normalized;
    return { write: true, result: undefined };
  });
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  bot.config.longTaskReminder = normalized;
  return { ok: true, config: normalized };
}
