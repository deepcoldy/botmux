import { parseApiMessage } from '../im/lark/message-parser.js';
import { extractLarkBusinessCode, LARK_CODE_MESSAGE_WITHDRAWN } from '../im/lark/lark-errors.js';

export interface RecallMessageRecord {
  message_id?: string;
  chat_id?: string;
  msg_type?: string;
  create_time?: string;
  thread_id?: string;
  deleted?: boolean;
  sender?: { id?: string; sender_type?: string; sender_name?: string; id_type?: string; sender_id_type?: string };
  body?: { content?: string };
}
export interface GroupRecallTransport {
  isInChat(chatId: string): Promise<boolean>;
  list(input: { containerId: string; containerType: 'chat' | 'thread'; pageToken?: string }): Promise<{
    items?: RecallMessageRecord[]; hasMore?: boolean; pageToken?: string;
  }>;
  read(messageId: string): Promise<RecallMessageRecord | undefined>;
  recall(messageId: string): Promise<void>;
}
export interface GroupRecallMessage {
  messageId: string;
  senderName: string;
  msgType: string;
  createTime: string;
  preview: string;
  canRecall: boolean;
  deleted: boolean;
  hasThread: boolean;
}
export interface GroupRecallResult { messageId: string; ok: boolean; error?: string; alreadyRecalled?: boolean }
export class GroupRecallError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
const messageIdPattern = /^om_[a-zA-Z0-9_-]+$/;
function validChat(chatId: string): void {
  if (!/^oc_[a-zA-Z0-9_-]+$/.test(chatId)) throw new GroupRecallError(400, 'invalid_chat_id');
}

/** 群管理员身份不等于代替任意成员撤回；此入口只操作所选应用自己发出的消息。 */
export class GroupMessageRecallService {
  constructor(private readonly appId: string, private readonly transport: GroupRecallTransport) {}
  private own(message: RecallMessageRecord): boolean {
    const sender = message.sender;
    const idType = sender?.id_type ?? sender?.sender_id_type;
    // 列表与详情可能分别标为 app、bot，或仅标 app_id；始终校验所选应用的 ID。
    return sender?.id === this.appId
      && (sender.sender_type === 'app' || sender.sender_type === 'bot' || idType === 'app_id');
  }
  private async membership(chatId: string): Promise<void> {
    validChat(chatId);
    if (!await this.transport.isInChat(chatId)) throw new GroupRecallError(403, 'bot_not_in_chat');
  }
  async list(chatId: string, query: { pageToken?: string; threadRootId?: string } = {}) {
    validChat(chatId);
    if (query.pageToken !== undefined && (query.pageToken.length > 2048 || /[\x00-\x1f\x7f]/.test(query.pageToken))) {
      throw new GroupRecallError(400, 'invalid_page_token');
    }
    if (query.threadRootId !== undefined && !messageIdPattern.test(query.threadRootId)) {
      throw new GroupRecallError(400, 'invalid_thread_root_id');
    }
    await this.membership(chatId);
    let containerId = chatId;
    if (query.threadRootId) {
      const root = await this.transport.read(query.threadRootId);
      // thread_id 本身不携带群归属，必须先回读起点消息，不能把别群话题带进当前群。
      if (!root || root.chat_id !== chatId) throw new GroupRecallError(403, 'thread_chat_mismatch');
      if (!root.thread_id) throw new GroupRecallError(400, 'thread_unavailable');
      containerId = root.thread_id;
    }
    const page = await this.transport.list({ containerId, containerType: query.threadRootId ? 'thread' : 'chat', pageToken: query.pageToken });
    const messages = (page.items ?? []).filter(message => message.message_id && (!message.chat_id || message.chat_id === chatId)).map(message => {
      let preview: string;
      try { preview = parseApiMessage(message).content.slice(0, 2000); }
      catch { preview = `[${message.msg_type ?? 'unknown'}]`; }
      return {
        messageId: message.message_id!, senderName: message.sender?.sender_name ?? '',
        msgType: message.msg_type ?? 'unknown', createTime: message.create_time ?? '', preview,
        canRecall: this.own(message) && message.deleted !== true, deleted: message.deleted === true,
        hasThread: !!message.thread_id,
      } satisfies GroupRecallMessage;
    });
    return { ok: true as const, messages, hasMore: page.hasMore === true && !!page.pageToken, pageToken: page.pageToken };
  }
  async recall(chatId: string, input: unknown): Promise<{ ok: boolean; results: GroupRecallResult[] }> {
    validChat(chatId);
    const ids = (input as { messageIds?: unknown } | null)?.messageIds;
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => key !== 'messageIds')
      || !Array.isArray(ids) || ids.length === 0 || ids.length > 50
      || ids.some(id => typeof id !== 'string' || !messageIdPattern.test(id))) {
      throw new GroupRecallError(400, 'invalid_message_ids');
    }
    await this.membership(chatId);
    const results: GroupRecallResult[] = [];
    // 小批顺序执行：一条失败不能遮掉其它条的真实结果，也不能整批重试已撤回的消息。
    for (const messageId of new Set(ids as string[])) {
      try {
        const message = await this.transport.read(messageId);
        if (!message || message.message_id !== messageId || message.chat_id !== chatId) {
          results.push({ messageId, ok: false, error: 'message_chat_mismatch' });
        } else if (!this.own(message)) {
          results.push({ messageId, ok: false, error: 'not_bot_message' });
        } else if (message.deleted) {
          results.push({ messageId, ok: true, alreadyRecalled: true });
        } else {
          await this.transport.recall(messageId);
          results.push({ messageId, ok: true });
        }
      } catch (error) {
        // 已撤回消息的回读可能直接报 230011；此时不再执行删除，重试也应收敛为成功。
        if (extractLarkBusinessCode(error) === LARK_CODE_MESSAGE_WITHDRAWN) {
          results.push({ messageId, ok: true, alreadyRecalled: true });
        } else {
          results.push({ messageId, ok: false, error: error instanceof Error ? error.message : 'recall_failed' });
        }
      }
    }
    return { ok: results.every(result => result.ok), results };
  }
}
