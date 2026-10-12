import { getBot } from '../bot-registry.js';
import { normalizeGroupIdleClose, parseGroupIdleClose } from '../core/group-idle-close.js';
import { AsyncSerialQueue } from '../utils/async-serial-queue.js';
import { rmwBotEntry } from './config-store.js';

const configWrites = new AsyncSerialQueue();

export async function setGroupIdleClose(appId: string, chatId: string, raw: unknown) {
  if (!/^oc_[a-zA-Z0-9_-]+$/.test(chatId)) throw new Error('invalid_chat_id');
  const settings = parseGroupIdleClose(raw);
  return configWrites.run(async () => {
    const bot = getBot(appId);
    const result = await rmwBotEntry(appId, entry => {
      const groups = normalizeGroupIdleClose(entry.groupIdleClose);
      groups[chatId] = settings;
      entry.groupIdleClose = groups;
      return { write: true, result: groups };
    });
    if (result.ok) bot.config.groupIdleClose = result.result;
    return result.ok ? { ok: true as const, settings } : result;
  });
}
