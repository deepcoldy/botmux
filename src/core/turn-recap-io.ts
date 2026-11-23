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
import type { DaemonToWorker } from '../types.js';
import { logger } from '../utils/logger.js';
import type { RecapIo } from './turn-recap-state.js';

function botConfig(ds: Parameters<RecapIo['enabled']>[0]) {
  try { return getBot(ds.larkAppId).config; } catch { return undefined; }
}

export const turnRecapIo: RecapIo = {
  enabled: ds => botConfig(ds)?.replyCardRecap === true,
  // The panel switch also gets the recap written, in Claude Code sessions
  // only (the worker checks the rest: version, backend, adopt).
  awaySummaryWanted: ds => ds.initConfig?.cliId === 'claude-code',
  requestAwaySummary(ds, turnId) {
    const worker = ds.worker;
    if (!worker?.connected || worker.killed) return;
    try { worker.send({ type: 'away_summary_focus', turnId } satisfies DaemonToWorker); }
    catch (error) { logger.warn(`[recap] ${ds.session.sessionId.slice(0, 8)}: away-summary request not sent: ${error instanceof Error ? error.message : String(error)}`); }
  },
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
