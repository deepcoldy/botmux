import { getBot } from '../bot-registry.js';
import { rmwBotEntry } from './config-store.js';
import { logger } from '../utils/logger.js';
import {
  notifyPinStreamingCardChanged,
  serializePinStreamingCardConfigChange,
} from './pin-streaming-card-change.js';

function normalizeChatList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim()))];
}

export async function setChatStreamingCardPin(
  larkAppId: string,
  chatId: string,
  enabled: boolean,
): Promise<{ ok: true; changed: boolean } | { ok: false; reason: string }> {
  let bot;
  try {
    bot = getBot(larkAppId);
  } catch {
    return { ok: false, reason: 'bot_not_registered' };
  }

  return serializePinStreamingCardConfigChange(larkAppId, async () => {
    const previous = normalizeChatList(bot.config.noPinStreamingCardChats);
    const hadDisabledChat = previous.includes(chatId);
    const masterEnabled = bot.config.pinStreamingCard === true;
    const previousEffectiveEnabled = masterEnabled && !hadDisabledChat;

    const result = await rmwBotEntry<{ changed: boolean; nextDisabledChats: string[] }>(larkAppId, (entry) => {
      const current = normalizeChatList(entry.noPinStreamingCardChats);
      const hasDisabledChat = current.includes(chatId);
      const nextDisabledChats = enabled
        ? current.filter(id => id !== chatId)
        : hasDisabledChat ? current : [...current, chatId];
      const changed = enabled ? hasDisabledChat : !hasDisabledChat;

      if (nextDisabledChats.length > 0) entry.noPinStreamingCardChats = nextDisabledChats;
      else delete entry.noPinStreamingCardChats;

      return { write: changed, result: { changed, nextDisabledChats } };
    });
    if (!result.ok) return result;

    bot.config.noPinStreamingCardChats = result.result.nextDisabledChats.length > 0
      ? result.result.nextDisabledChats
      : undefined;

    const nextDisabledChat = bot.config.noPinStreamingCardChats?.includes(chatId) === true;
    const nextEffectiveEnabled = masterEnabled && !nextDisabledChat;
    if (previousEffectiveEnabled !== nextEffectiveEnabled) {
      notifyPinStreamingCardChanged(larkAppId, masterEnabled, chatId, nextEffectiveEnabled);
    }

    logger.info(
      `[pin-streaming-card-mode:${larkAppId}] chat=${chatId} enabled=${enabled} `
      + `changed=${result.result.changed}`,
    );
    return { ok: true, changed: result.result.changed };
  });
}
