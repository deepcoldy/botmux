import type { CardActionData } from '../../../im/lark/card-handler.js';
import { getChatMode } from '../../../im/lark/client.js';
import { canOperate, evaluateTalk } from '../../../im/lark/event-dispatcher.js';
import type { PluginHostPrivileges } from '../commands/protocol.js';

export async function resolvePluginCardPrivileges(larkAppId: string, data: CardActionData): Promise<PluginHostPrivileges> {
  const openId = typeof data.operator?.open_id === 'string' && data.operator.open_id ? data.operator.open_id : undefined;
  const unionId = typeof data.operator?.union_id === 'string' && data.operator.union_id ? data.operator.union_id : undefined;
  const rawChatId = data.context?.open_chat_id;
  const chatId = typeof rawChatId === 'string' && rawChatId ? rawChatId : undefined;
  if (!openId || !chatId) return { canOperate: false, canTalk: false };
  const mode = await getChatMode(larkAppId, chatId);
  return {
    canOperate: canOperate(larkAppId, chatId, openId, unionId),
    canTalk: evaluateTalk(larkAppId, chatId, openId, unionId, unionId, mode === 'p2p' ? 'p2p' : 'group').allowed,
  };
}
