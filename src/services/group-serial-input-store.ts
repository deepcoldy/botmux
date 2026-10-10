import { getBot } from '../bot-registry.js';
import { normalizeGroupSerialInput } from '../core/group-serial-input.js';
import { AsyncSerialQueue } from '../utils/async-serial-queue.js';
import { rmwBotEntry } from './config-store.js';

const configWrites = new AsyncSerialQueue();

export async function setGroupSerialInput(appId: string, chatId: string, enabled: boolean) {
  if (!/^oc_[a-zA-Z0-9_-]+$/.test(chatId)) throw new Error('invalid_chat_id');
  if (typeof enabled !== 'boolean') throw new Error('enabled_must_be_boolean');
  return configWrites.run(async () => {
    const bot = getBot(appId);
    const result = await rmwBotEntry(appId, entry => {
      const groups = normalizeGroupSerialInput(entry.groupSerialInput);
      groups[chatId] = enabled;
      entry.groupSerialInput = groups;
      return { write: true, result: groups };
    });
    if (result.ok) bot.config.groupSerialInput = result.result;
    return result.ok ? { ok: true as const, enabled } : result;
  });
}
