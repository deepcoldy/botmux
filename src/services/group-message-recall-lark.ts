import { getBotClient } from '../bot-registry.js';
import { assertLarkTransport, getMessageDetail, larkGet } from '../im/lark/client.js';
import { larkApiError, extractLarkBusinessCode, LARK_CODE_MESSAGE_WITHDRAWN } from '../im/lark/lark-errors.js';
import { executeWithLarkGate } from '../im/lark/api-gate.js';
import { isInChat } from './groups-store.js';
import { GroupMessageRecallService, type RecallMessageRecord } from './group-message-recall.js';

export function createGroupMessageRecallService(appId: string): GroupMessageRecallService {
  return new GroupMessageRecallService(appId, {
    isInChat: chatId => isInChat(appId, chatId),
    list: async input => {
      const response = await larkGet(getBotClient(appId), '/open-apis/im/v1/messages', {
        container_id_type: input.containerType, container_id: input.containerId,
        page_size: 50, sort_type: 'ByCreateTimeDesc', with_sender_name: 'true',
        card_msg_content_type: 'user_card_content',
        ...(input.pageToken ? { page_token: input.pageToken } : {}),
      });
      if (response.code !== 0) throw larkApiError('list group messages', response);
      return { items: response.data?.items, hasMore: response.data?.has_more, pageToken: response.data?.page_token };
    },
    read: async messageId => {
      const detail = await getMessageDetail(appId, messageId);
      return detail?.items?.[0] as RecallMessageRecord | undefined;
    },
    recall: async messageId => {
      assertLarkTransport(appId, 'groupMessageRecall');
      await executeWithLarkGate(appId, 'groupMessageRecall', async () => {
        try {
          const response = await getBotClient(appId).im.v1.message.delete({ path: { message_id: messageId } });
          // 回读后可能由另一个面板先撤回；已验证过群与发送者，这种竞争属于幂等成功。
          if (response.code !== 0 && response.code !== LARK_CODE_MESSAGE_WITHDRAWN) {
            throw larkApiError('recall group message', response);
          }
        } catch (error) {
          if (extractLarkBusinessCode(error) !== LARK_CODE_MESSAGE_WITHDRAWN) throw error;
        }
      });
    },
  });
}
