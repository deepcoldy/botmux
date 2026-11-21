/** Production wiring for core/turn-recap-state.ts. */
import { getBot } from '../bot-registry.js';
import { localeForBot } from '../i18n/index.js';
import {
  getMessageDetail,
  insertCardElements,
  replaceCardElement,
  resolveCardKitId,
} from '../im/lark/client.js';
import { messageCardContent } from '../im/lark/message-card-content.js';
import { TURN_RECAP_ELEMENT_ID } from '../im/lark/turn-recap-card.js';
import { logger } from '../utils/logger.js';
import type { RecapIo } from './turn-recap-state.js';

function botConfig(ds: Parameters<RecapIo['enabled']>[0]) {
  try { return getBot(ds.larkAppId).config; } catch { return undefined; }
}

export const turnRecapIo: RecapIo = {
  enabled: ds => botConfig(ds)?.replyCardRecap === true,
  locale: ds => localeForBot(ds.larkAppId) === 'en' ? 'en' : 'zh',
  async readCard(ds, messageId) {
    return messageCardContent(await getMessageDetail(ds.larkAppId, messageId, { userCardContent: true }), ds.chatId);
  },
  cardId: (ds, messageId) => resolveCardKitId(ds.larkAppId, messageId),
  insert: (ds, cardId, messageId, placement, element, sequence, uuid) =>
    insertCardElements(ds.larkAppId, cardId, placement, [element], sequence, uuid, messageId),
  replace: (ds, cardId, messageId, element, sequence, uuid) =>
    replaceCardElement(ds.larkAppId, cardId, TURN_RECAP_ELEMENT_ID, element, sequence, uuid, messageId),
  now: () => Date.now(),
  warn: message => logger.warn(message),
  info: message => logger.info(message),
};
