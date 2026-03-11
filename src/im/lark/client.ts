import * as Lark from '@larksuiteoapi/node-sdk';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

let client: Lark.Client;

export function getLarkClient(): Lark.Client {
  if (!client) {
    // Provide a custom logger that writes to stderr.
    // The default Lark SDK logger uses console.log (stdout), which corrupts
    // MCP stdio protocol when the server is spawned as an MCP child process.
    const stderrLogger = {
      error: (...msg: any[]) => { process.stderr.write(`[lark:error] ${msg.map(m => JSON.stringify(m)).join(' ')}\n`); },
      warn:  (...msg: any[]) => { process.stderr.write(`[lark:warn] ${msg.map(m => JSON.stringify(m)).join(' ')}\n`); },
      info:  (...msg: any[]) => { process.stderr.write(`[lark:info] ${msg.map(m => JSON.stringify(m)).join(' ')}\n`); },
      debug: (...msg: any[]) => { process.stderr.write(`[lark:debug] ${msg.map(m => JSON.stringify(m)).join(' ')}\n`); },
      trace: (...msg: any[]) => { process.stderr.write(`[lark:trace] ${msg.map(m => JSON.stringify(m)).join(' ')}\n`); },
    };
    client = new Lark.Client({
      appId: config.lark.appId,
      appSecret: config.lark.appSecret,
      logger: stderrLogger,
    });
  }
  return client;
}

export async function sendMessage(chatId: string, content: string, msgType: string = 'text'): Promise<string> {
  const c = getLarkClient();
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

export async function replyMessage(messageId: string, content: string, msgType: string = 'text', replyInThread: boolean = false): Promise<string> {
  const c = getLarkClient();
  const body = msgType === 'text' ? JSON.stringify({ text: content }) : content;

  const res = await c.im.v1.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: msgType as any,
      content: body,
      ...(replyInThread ? { reply_in_thread: true } : {}),
    },
  });

  if (res.code !== 0) {
    throw new Error(`Failed to reply message: ${res.msg} (code: ${res.code})`);
  }

  const replyId = res.data?.message_id;
  if (!replyId) throw new Error('No message_id in reply response');
  logger.info(`Replied ${replyId} to message ${messageId}${replyInThread ? ' (in thread)' : ''}`);
  return replyId;
}

export async function addReaction(messageId: string, emojiType: string): Promise<string> {
  const c = getLarkClient();
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

export async function removeReaction(messageId: string, reactionId: string): Promise<void> {
  const c = getLarkClient();
  const res = await (c as any).im.v1.messageReaction.delete({
    path: { message_id: messageId, reaction_id: reactionId },
  });
  if (res.code !== 0) {
    throw new Error(`Failed to remove reaction: ${res.msg} (code: ${res.code})`);
  }
  logger.info(`Removed reaction ${reactionId} from message ${messageId}`);
}

export async function sendUserMessage(openId: string, content: string, msgType: string = 'text'): Promise<string> {
  const c = getLarkClient();
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

export async function getChatInfo(chatId: string): Promise<{ userCount: number }> {
  const c = getLarkClient();
  const res = await (c as any).im.v1.chat.get({
    path: { chat_id: chatId },
  });
  if (res.code !== 0) {
    throw new Error(`Failed to get chat info: ${res.msg} (code: ${res.code})`);
  }
  // user_count excludes bots, only real users
  return { userCount: Number(res.data?.user_count ?? 0) };
}

export async function updateMessage(messageId: string, cardJson: string): Promise<void> {
  const c = getLarkClient();
  const res = await c.im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: cardJson },
  });
  if (res.code !== 0) {
    throw new Error(`Failed to update message: ${res.msg} (code: ${res.code})`);
  }
}

export async function getMessageDetail(messageId: string): Promise<any> {
  const c = getLarkClient();
  const res = await c.im.v1.message.get({
    path: { message_id: messageId },
  });
  if (res.code !== 0) {
    throw new Error(`Failed to get message: ${res.msg} (code: ${res.code})`);
  }
  return res.data;
}

export async function downloadMessageResource(messageId: string, fileKey: string, type: 'image' | 'file', savePath: string): Promise<void> {
  const c = getLarkClient();

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
export async function resolveAllowedUsers(raw: string[]): Promise<string[]> {
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

  const c = getLarkClient();
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

export async function listThreadMessages(chatId: string, rootMessageId: string, pageSize: number = 50): Promise<any[]> {
  const c = getLarkClient();
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
