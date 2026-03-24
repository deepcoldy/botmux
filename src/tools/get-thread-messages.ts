import { z } from 'zod';
import * as sessionStore from '../services/session-store.js';
import { listThreadMessages } from '../im/lark/client.js';
import { parseApiMessage } from '../im/lark/message-parser.js';
import { config } from '../config.js';
import { getBot } from '../bot-registry.js';
import { logger } from '../utils/logger.js';

export const schema = z.object({
  session_id: z.string().describe('Session ID for the active session'),
  limit: z.number().optional().default(50).describe('Max number of messages to return (default 50)'),
});

export const description = 'Get message history from the Lark thread associated with a session.';

export async function execute(args: z.infer<typeof schema>) {
  const session = sessionStore.getSession(args.session_id);
  if (!session) {
    return { error: `Session ${args.session_id} not found` };
  }

  try {
    const appId = session.imBotId || config.lark.appId;

    // Non-Lark IM: no message history API
    const bot = (() => { try { return getBot(appId); } catch { return undefined; } })();
    if (bot?.adapter && !bot.adapter.capabilities.threads) {
      return { sessionId: args.session_id, threadId: session.rootMessageId, messages: [], total: 0, hint: 'Message history not available for this IM type.' };
    }
    const rawMessages = await listThreadMessages(appId, session.chatId, session.rootMessageId, args.limit);
    const messages = rawMessages.map(parseApiMessage);

    logger.info(`Retrieved ${messages.length} messages for session ${args.session_id}`);
    return {
      sessionId: args.session_id,
      threadId: session.rootMessageId,
      messages,
      total: messages.length,
    };
  } catch (err: any) {
    logger.error(`Failed to get thread messages: ${err.message}`);
    return { error: `Failed to get messages: ${err.message}` };
  }
}
