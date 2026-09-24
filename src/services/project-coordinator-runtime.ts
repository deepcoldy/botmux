import { getBotBrand } from '../bot-registry.js';
import {
  getMessageThreadId,
  pinMessage,
  sendMessage,
  unpinMessage,
  updateMessage,
} from '../im/lark/client.js';
import { ProjectCoordinator } from './project-coordinator.js';

/** One process-wide coordinator keeps projection updates serialized while the
 * durable ProjectStore remains the cross-restart source of truth. */
export const projectCoordinator = new ProjectCoordinator({
  sendCard: (larkAppId, chatId, cardJson) => sendMessage(larkAppId, chatId, cardJson, 'interactive'),
  updateCard: (larkAppId, messageId, cardJson) => updateMessage(larkAppId, messageId, cardJson),
  pinMessage: async (larkAppId, messageId) => !!(await pinMessage(larkAppId, messageId)),
  unpinMessage: async (larkAppId, messageId) => !!(await unpinMessage(larkAppId, messageId)),
  resolveThreadId: (larkAppId, dispatchRoot) => getMessageThreadId(larkAppId, dispatchRoot),
  isMessageWithdrawn: error => error instanceof Error && error.name === 'MessageWithdrawnError',
  brand: larkAppId => getBotBrand(larkAppId),
});
