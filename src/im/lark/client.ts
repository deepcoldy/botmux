import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { getBotClient } from '../../bot-registry.js';
import { logger } from '../../utils/logger.js';

// ─── Error types ──────────────────────────────────────────────────────────────

/** Thrown when the target message has been withdrawn (Lark code 230011). */
export class MessageWithdrawnError extends Error {
  constructor(messageId: string) {
    super(`Message ${messageId} has been withdrawn`);
    this.name = 'MessageWithdrawnError';
  }
}

/** Extract Lark error code from AxiosError or SDK error. */
function getLarkErrorCode(err: any): number | undefined {
  return err?.response?.data?.code ?? err?.code;
}

const LARK_CODE_MESSAGE_WITHDRAWN = 230011;

export async function sendMessage(larkAppId: string, chatId: string, content: string, msgType: string = 'text'): Promise<string> {
  const c = getBotClient(larkAppId);
  const body = msgType === 'text' ? JSON.stringify({ text: content }) : content;

  const res = await c.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: msgType as any,
      content: body,
    },
  });

  if (res.code !== 0) {
    throw new Error(`Failed to send message: ${res.msg} (code: ${res.code})`);
  }

  const messageId = res.data?.message_id;
  if (!messageId) throw new Error('No message_id in response');
  logger.info(`Sent message ${messageId} to chat ${chatId}`);
  return messageId;
}

export async function replyMessage(larkAppId: string, messageId: string, content: string, msgType: string = 'text', replyInThread: boolean = false): Promise<string> {
  const c = getBotClient(larkAppId);
  const body = msgType === 'text' ? JSON.stringify({ text: content }) : content;

  let res: any;
  try {
    res = await c.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: msgType as any,
        content: body,
        ...(replyInThread ? { reply_in_thread: true } : {}),
      },
    });
  } catch (err: any) {
    if (getLarkErrorCode(err) === LARK_CODE_MESSAGE_WITHDRAWN) {
      throw new MessageWithdrawnError(messageId);
    }
    throw err;
  }

  if (res.code !== 0) {
    if (res.code === LARK_CODE_MESSAGE_WITHDRAWN) throw new MessageWithdrawnError(messageId);
    throw new Error(`Failed to reply message: ${res.msg} (code: ${res.code})`);
  }

  const replyId = res.data?.message_id;
  if (!replyId) throw new Error('No message_id in reply response');
  logger.info(`Replied ${replyId} to message ${messageId}${replyInThread ? ' (in thread)' : ''}`);
  return replyId;
}

export async function addReaction(larkAppId: string, messageId: string, emojiType: string): Promise<string> {
  const c = getBotClient(larkAppId);
  const res = await (c as any).im.v1.messageReaction.create({
    path: { message_id: messageId },
    data: { reaction_type: { emoji_type: emojiType } },
  });
  if (res.code !== 0) {
    throw new Error(`Failed to add reaction: ${res.msg} (code: ${res.code})`);
  }
  const reactionId = res.data?.reaction_id;
  logger.info(`Added reaction ${emojiType} (${reactionId}) to message ${messageId}`);
  return reactionId ?? '';
}

export async function removeReaction(larkAppId: string, messageId: string, reactionId: string): Promise<void> {
  const c = getBotClient(larkAppId);
  const res = await (c as any).im.v1.messageReaction.delete({
    path: { message_id: messageId, reaction_id: reactionId },
  });
  if (res.code !== 0) {
    throw new Error(`Failed to remove reaction: ${res.msg} (code: ${res.code})`);
  }
  logger.info(`Removed reaction ${reactionId} from message ${messageId}`);
}

export async function sendUserMessage(larkAppId: string, openId: string, content: string, msgType: string = 'text'): Promise<string> {
  const c = getBotClient(larkAppId);
  const body = msgType === 'text' ? JSON.stringify({ text: content }) : content;

  const res = await c.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: openId,
      msg_type: msgType as any,
      content: body,
    },
  });

  if (res.code !== 0) {
    throw new Error(`Failed to send user message: ${res.msg} (code: ${res.code})`);
  }

  const messageId = res.data?.message_id;
  if (!messageId) throw new Error('No message_id in response');
  logger.info(`Sent DM ${messageId} to user ${openId}`);
  return messageId;
}

export async function getChatInfo(larkAppId: string, chatId: string): Promise<{ userCount: number }> {
  const c = getBotClient(larkAppId);
  const res = await (c as any).im.v1.chat.get({
    path: { chat_id: chatId },
  });
  if (res.code !== 0) {
    throw new Error(`Failed to get chat info: ${res.msg} (code: ${res.code})`);
  }
  // user_count excludes bots, only real users
  return { userCount: Number(res.data?.user_count ?? 0) };
}

export async function updateMessage(larkAppId: string, messageId: string, cardJson: string): Promise<void> {
  const c = getBotClient(larkAppId);
  let res: any;
  try {
    res = await c.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: cardJson },
    });
  } catch (err: any) {
    if (getLarkErrorCode(err) === LARK_CODE_MESSAGE_WITHDRAWN) {
      throw new MessageWithdrawnError(messageId);
    }
    throw err;
  }
  if (res.code !== 0) {
    if (res.code === LARK_CODE_MESSAGE_WITHDRAWN) throw new MessageWithdrawnError(messageId);
    throw new Error(`Failed to update message: ${res.msg} (code: ${res.code})`);
  }
}

export async function getMessageDetail(larkAppId: string, messageId: string): Promise<any> {
  const c = getBotClient(larkAppId);
  const res = await c.im.v1.message.get({
    path: { message_id: messageId },
  });
  if (res.code !== 0) {
    throw new Error(`Failed to get message: ${res.msg} (code: ${res.code})`);
  }
  return res.data;
}

export async function downloadMessageResource(larkAppId: string, messageId: string, fileKey: string, type: 'image' | 'file', savePath: string): Promise<void> {
  const c = getBotClient(larkAppId);

  const dir = dirname(savePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const res = await (c as any).im.v1.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });

  if (res instanceof Buffer) {
    writeFileSync(savePath, res);
  } else if (res && typeof res === 'object' && 'writeFile' in res) {
    await res.writeFile(savePath);
  } else {
    // Response is likely a readable stream or buffer-like
    const chunks: Buffer[] = [];
    for await (const chunk of res as AsyncIterable<Buffer>) {
      chunks.push(Buffer.from(chunk));
    }
    writeFileSync(savePath, Buffer.concat(chunks));
  }

  logger.info(`Downloaded ${type} ${fileKey} → ${savePath}`);
}

/**
 * Resolve emails to Lark open_ids via batch user lookup.
 * Accepts mixed input: items starting with "ou_" are kept as-is; everything else
 * must be a full email address (e.g. "alice@example.com") and is looked up.
 * Returns an array of open_ids (unresolvable entries are dropped with a warning).
 */
export async function resolveAllowedUsers(larkAppId: string, raw: string[]): Promise<string[]> {
  const openIds: string[] = [];
  const emails: string[] = [];
  for (const v of raw) {
    if (v.startsWith('ou_')) {
      openIds.push(v);
    } else {
      emails.push(v);
    }
  }
  if (emails.length === 0) return openIds;

  const c = getBotClient(larkAppId);
  try {
    const res = await (c as any).contact.v3.user.batchGetId({
      params: { user_id_type: 'open_id' },
      data: { emails, include_resigned: false },
    });
    if (res.code !== 0) {
      logger.warn(`Failed to resolve emails to open_ids: ${res.msg} (code: ${res.code})`);
      return openIds;
    }
    const userList: any[] = res.data?.user_list ?? [];
    for (const item of userList) {
      if (item.user_id) {
        openIds.push(item.user_id);
        logger.info(`Resolved ${item.email} → ${item.user_id}`);
      } else {
        logger.warn(`Could not resolve email: ${item.email}`);
      }
    }
  } catch (err: any) {
    logger.warn(`resolveAllowedUsers failed: ${err.message}`);
  }
  return openIds;
}

export async function listThreadMessages(larkAppId: string, chatId: string, rootMessageId: string, pageSize: number = 50): Promise<any[]> {
  const c = getBotClient(larkAppId);
  const allMessages: any[] = [];
  let pageToken: string | undefined;

  // Lark API only supports container_id_type="chat", so we list chat messages
  // and filter by root_id to get thread messages
  do {
    const res = await c.im.v1.message.list({
      params: {
        container_id_type: 'chat' as any,
        container_id: chatId,
        page_size: pageSize,
        sort_type: 'ByCreateTimeDesc' as any,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });

    if (res.code !== 0) {
      throw new Error(`Failed to list messages: ${res.msg} (code: ${res.code})`);
    }

    if (res.data?.items) {
      for (const item of res.data.items) {
        // Include the root message itself and all its thread replies
        if (item.message_id === rootMessageId || item.root_id === rootMessageId) {
          allMessages.push(item);
        }
      }
    }

    pageToken = res.data?.page_token;
    // Stop early if we've collected enough or gone past the root message timestamp
    if (allMessages.length >= pageSize) break;
  } while (pageToken);

  // Sort by create_time ascending
  allMessages.sort((a, b) => (a.create_time ?? '').localeCompare(b.create_time ?? ''));
  return allMessages;
}

/**
 * List bot members of a chat. Returns array of { openId, name }.
 */
export async function listChatBotMembers(larkAppId: string, chatId: string): Promise<Array<{ openId: string; name: string }>> {
  const c = getBotClient(larkAppId);
  const bots: Array<{ openId: string; name: string }> = [];
  let pageToken: string | undefined;

  do {
    const res = await (c as any).im.v1.chatMembers.list({
      path: { chat_id: chatId },
      params: {
        member_id_type: 'open_id',
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });

    if (res.code !== 0) {
      throw new Error(`Failed to list chat members: ${res.msg} (code: ${res.code})`);
    }

    for (const member of res.data?.items ?? []) {
      if (member.member_type === 'bot') {
        bots.push({
          openId: member.member_id ?? '',
          name: member.name ?? '',
        });
      }
    }

    pageToken = res.data?.page_token;
  } while (pageToken);

  return bots;
}
