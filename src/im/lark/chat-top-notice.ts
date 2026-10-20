import { getBotClient } from '../../bot-registry.js';
import { assertLarkTransport, lookupMessageChatId } from './client.js';

/** Replace the chat's top notice with one existing message.
 *
 * The message lookup is an authorization/safety boundary: callers may target a
 * chat explicitly, so do not let a valid message ID from another chat mutate
 * that other chat by accident.
 */
export async function putChatTopNotice(
  larkAppId: string,
  chatId: string,
  messageId: string,
): Promise<void> {
  assertLarkTransport(larkAppId, 'putChatTopNotice');
  const messageChatId = await lookupMessageChatId(larkAppId, messageId);
  if (!messageChatId) throw new Error(`message_chat_unavailable: ${messageId}`);
  if (messageChatId !== chatId) {
    throw new Error(`message_chat_mismatch: expected ${chatId}, got ${messageChatId}`);
  }

  const result = await (getBotClient(larkAppId) as any).im.v1.chatTopNotice.putTopNotice({
    path: { chat_id: chatId },
    data: {
      chat_top_notice: [{ action_type: '1', message_id: messageId }],
    },
  });
  if (result?.code !== 0) {
    throw new Error(`${result?.code ?? 'missing_code'}: ${result?.msg || 'Lark API error'}`);
  }
}
