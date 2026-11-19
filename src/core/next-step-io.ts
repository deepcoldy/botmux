/** Production wiring for core/next-step-suggestion.ts. */
import { getBot } from '../bot-registry.js';
import { config } from '../config.js';
import { localeForBot } from '../i18n/index.js';
import {
  deleteCardElement,
  getMessageDetail,
  insertCardElements,
  replaceCardElement,
  resolveCardKitId,
} from '../im/lark/client.js';
import { messageCardContent } from '../im/lark/message-card-content.js';
import { NEXT_STEP_ELEMENT_ID } from '../im/lark/next-step-card.js';
import { issueSessionCardClickTurn } from '../services/card-click-turn-secret.js';
import { logger } from '../utils/logger.js';
import type { NextStepIo } from './next-step-suggestion.js';

/** A row normally lives until the next turn starts. The bound only matters for
 * a row left behind (a daemon restart forgets which card carries it): its
 * button then stops working the next day instead of after the 7-day maximum. */
export const NEXT_STEP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export const nextStepIo: NextStepIo = {
  enabled(ds) {
    try { return getBot(ds.larkAppId).config.replyCardNextStep === true; } catch { return false; }
  },
  locale: ds => localeForBot(ds.larkAppId) === 'en' ? 'en' : 'zh',
  issue: (ds, prompt) => issueSessionCardClickTurn({
    dataDir: config.session.dataDir,
    larkAppId: ds.larkAppId,
    sessionId: ds.session.sessionId,
    prompt,
    ttlMs: NEXT_STEP_TOKEN_TTL_MS,
  }),
  async readCard(ds, messageId) {
    return messageCardContent(await getMessageDetail(ds.larkAppId, messageId, { userCardContent: true }), ds.chatId);
  },
  cardId: (ds, messageId) => resolveCardKitId(ds.larkAppId, messageId),
  insert: (ds, cardId, messageId, placement, element, sequence, uuid) =>
    insertCardElements(ds.larkAppId, cardId, placement, [element], sequence, uuid, messageId),
  replace: (ds, cardId, messageId, element, sequence, uuid) =>
    replaceCardElement(ds.larkAppId, cardId, NEXT_STEP_ELEMENT_ID, element, sequence, uuid, messageId),
  remove: (ds, cardId, messageId, sequence, uuid) =>
    deleteCardElement(ds.larkAppId, cardId, NEXT_STEP_ELEMENT_ID, sequence, uuid, messageId),
  now: () => Date.now(),
  warn: message => logger.warn(message),
};
