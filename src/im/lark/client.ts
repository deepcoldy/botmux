import { readFileSync, writeFileSync, createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { dirname, extname, basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { getBotClient, getAllBots, getBot } from '../../bot-registry.js';
import { loadBotConfigs } from '../../bot-registry.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { resolveUserToken } from '../../utils/user-token.js';
import { listObservedBots } from '../../services/observed-bots-store.js';

type LarkRequestParams = Record<string, string | number | boolean | undefined>;

/**
 * Call a Feishu GET endpoint without a request body.
 *
 * The official SDK currently lets axios attach `{}` as `data` for generated
 * GET calls such as im.v1.message.list/get, im.v1.chat.get/list,
 * im.v1.chatMembers.isInChat and contact.v3.user.get. Some gateway
 * deployments reject GET-with-body and return HTTP 411 before the OpenAPI
 * handler sees the request. The SDK's generic `client.request()` contains an
 * explicit GET empty-body guard (`fix: #153`) while still using the SDK's
 * token/cache/auth plumbing, so route every read-only GET through it.
 *
 * `url` is the API path (e.g. `/open-apis/im/v1/chats/<id>`); path params must
 * already be interpolated by the caller. Returns the parsed JSON body
 * (`{ code, msg, data }`), identical to the generated method's resolved value.
 */
export async function larkGet(c: any, url: string, params: LarkRequestParams = {}): Promise<any> {
  return c.request({ method: 'GET', url, params });
}

// Cached lightweight Lark clients for all configured bots (for isInChat checks)
let allBotClients: Array<{ appId: string; cliId: string; client: InstanceType<typeof Client> }> | null = null;
function getAllBotClients() {
  if (!allBotClients) {
    allBotClients = loadBotConfigs().map((cfg) => ({
      appId: cfg.larkAppId,
      cliId: cfg.cliId,
      client: new Client({ appId: cfg.larkAppId, appSecret: cfg.larkAppSecret, loggerLevel: LoggerLevel.error }),
    }));
  }
  return allBotClients;
}

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

/**
 * Send a message to a chat.
 *
 * `uuid` is an optional opt-in dedupe token (Feishu IM uuid field, ≤ 50
 * chars, 1-hour TTL — see spike report §1.2).  When supplied, the Feishu
 * server returns the original message_id for repeat requests within TTL,
 * making the send idempotent.  Workflow runtime passes the attempt's
 * idempotencyKey here so retries don't re-send.  Existing callers omit
 * the param and get exactly the pre-Step-6 behavior.
 */
export async function sendMessage(larkAppId: string, chatId: string, content: string, msgType: string = 'text', uuid?: string): Promise<string> {
  const c = getBotClient(larkAppId);
  const body = msgType === 'text' ? JSON.stringify({ text: content }) : content;

  let res: any;
  try {
    res = await c.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: msgType as any,
        content: body,
        ...(uuid ? { uuid } : {}),
      },
    });
  } catch (err: any) {
    if (getLarkErrorCode(err) === LARK_CODE_MESSAGE_WITHDRAWN) {
      throw new MessageWithdrawnError(chatId);
    }
    throw err;
  }

  if (res.code !== 0) {
    if (res.code === LARK_CODE_MESSAGE_WITHDRAWN) throw new MessageWithdrawnError(chatId);
    throw new Error(`Failed to send message: ${res.msg} (code: ${res.code})`);
  }

  const messageId = res.data?.message_id;
  if (!messageId) throw new Error('No message_id in response');
  logger.info(`Sent message ${messageId} to chat ${chatId}`);
  return messageId;
}

/**
 * Reply to an existing message.  See {@link sendMessage} for the `uuid`
 * dedupe parameter — same semantics apply to replies (Feishu reply API
 * also accepts `uuid` and yields the same 1-hour idempotent return).  See
 * spike report §1.4 for the reply-specific test results, including the
 * cross-parent dedupe behavior that informs the inputHash design.
 */
export async function replyMessage(larkAppId: string, messageId: string, content: string, msgType: string = 'text', replyInThread: boolean = false, uuid?: string): Promise<string> {
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
        ...(uuid ? { uuid } : {}),
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
  logger.info(`Replied ${replyId} to message ${messageId} [msgType=${msgType}, replyInThread=${replyInThread}]`);
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

export async function getChatInfo(larkAppId: string, chatId: string): Promise<{ userCount: number; botCount: number }> {
  const c = getBotClient(larkAppId);
  const res = await larkGet(c, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`);
  if (res.code !== 0) {
    throw new Error(`Failed to get chat info: ${res.msg} (code: ${res.code})`);
  }
  // user_count excludes bots, only real users; bot_count is the bot member count.
  return {
    userCount: Number(res.data?.user_count ?? 0),
    botCount: Number(res.data?.bot_count ?? 0),
  };
}

/**
 * Resolve a chat's display name (the user-facing group title). Returns `null`
 * on any failure (chatId is unknown to this bot, network error, bot not in
 * chat etc.) — callers should fall back to displaying the raw chatId so the
 * UI degrades gracefully rather than rendering "undefined". For p2p chats the
 * returned name may be an empty string; treat that as "no display name" and
 * also fall back. */
export async function getChatName(larkAppId: string, chatId: string): Promise<string | null> {
  try {
    const c = getBotClient(larkAppId);
    const res = await larkGet(c, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`);
    if (res.code !== 0) return null;
    const name = String(res.data?.name ?? '').trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** Lark chat-mode classification used by botmux to decide session scope:
 *   - 'topic'  → 话题群: every top-level message becomes a new thread, so
 *                botmux always uses thread-scope sessions. Two underlying
 *                Lark shapes collapse into this:
 *                  * chat_mode='topic' (rare; creation-time classification)
 *                  * group_message_type='thread' (the toggle Lark clients
 *                    expose as "话题/聊天" — flips on the fly, chat_mode stays
 *                    'group'). This is the common case for user-converted
 *                    话题群.
 *   - 'group'  → 普通群: top-level messages stay top-level, so botmux uses
 *                chat-scope by default; user-initiated threads still get
 *                their own thread-scope sessions
 *   - 'p2p'    → direct message: equivalent to 普通群 from a routing
 *                perspective (chat-scope by default) */
export type ChatMode = 'group' | 'topic' | 'p2p';

const chatModeCache = new Map<string, { mode: ChatMode; cachedAt: number }>();
const CHAT_MODE_TTL_MS = 5 * 60 * 1000; // 5 min — chat_mode can change when a group is converted to topic mode

/** Resolve the conversational topology of a chat (话题群 vs 普通群 vs p2p).
 *
 *  Cached per (appId, chatId) for 5 minutes. Errors fall back to 'group' so a
 *  flaky Lark API doesn't break message routing — chat-scope is the safer
 *  default than incorrectly forcing a thread, since users can always reply
 *  in-thread to escape it.
 *
 *  Calling this with a chat that's already known to be p2p (from
 *  message.chat_type === 'p2p') is fine but wasteful — prefer skipping the
 *  call in that case. */
export async function getChatMode(
  larkAppId: string,
  chatId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<ChatMode> {
  const cacheKey = `${larkAppId}::${chatId}`;
  const cached = chatModeCache.get(cacheKey);
  if (!options.forceRefresh && cached && Date.now() - cached.cachedAt < CHAT_MODE_TTL_MS) {
    return cached.mode;
  }

  let mode: ChatMode = 'group';
  try {
    const c = getBotClient(larkAppId);
    const res = await larkGet(c, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`);
    if (res.code === 0) {
      const rawMode = String(res.data?.chat_mode ?? '').toLowerCase();
      const rawType = String(res.data?.chat_type ?? '').toLowerCase();
      // group_message_type is the actual "is this a 话题群" signal. The
      // Lark client UI lets users flip a chat between flat mode and topic
      // mode at any time — that toggle writes group_message_type
      // ('chat' ↔ 'thread'), NOT chat_mode. chat_mode is the chat's
      // creation-time topology classification and stays 'group' even for
      // user-converted topic chats; in our tenant we have only ever seen
      // chat_mode='topic' on a small set of legacy/specially-created chats.
      // Treating chat_mode='topic' OR group_message_type='thread' as 'topic'
      // covers both shapes, and matches the behaviour the Lark client
      // displays: every top-level message wraps into a fresh thread, so a
      // bot's sendMessage(chatId) creates a new visible topic each turn.
      const rawGmt = String(res.data?.group_message_type ?? '').toLowerCase();
      if (rawType === 'p2p') mode = 'p2p';
      else if (rawMode === 'topic' || rawGmt === 'thread') mode = 'topic';
      else mode = 'group';
    } else {
      logger.warn(`getChatMode(${chatId}) failed: ${res.msg} (code: ${res.code}); falling back to 'group'`);
    }
  } catch (err: any) {
    logger.warn(`getChatMode(${chatId}) errored: ${err?.message ?? err}; falling back to 'group'`);
  }

  chatModeCache.set(cacheKey, { mode, cachedAt: Date.now() });
  return mode;
}

/**
 * Recall (delete) a message. Returns `true` only when Lark confirms success,
 * `false` on SDK throw or a non-zero response code — so callers that need to
 * know whether the withdraw actually happened (e.g. grant-card withdraw) can
 * fall back instead of assuming success. Fire-and-forget callers can ignore it.
 */
export async function deleteMessage(larkAppId: string, messageId: string): Promise<boolean> {
  const c = getBotClient(larkAppId);
  try {
    const res: any = await c.im.v1.message.delete({ path: { message_id: messageId } });
    if (res && typeof res.code === 'number' && res.code !== 0) {
      logger.debug(`Delete message ${messageId} returned non-zero code: ${res.code} ${res.msg ?? ''}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.debug(`Failed to delete message ${messageId}: ${err}`);
    return false;
  }
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

export async function getMessageDetail(
  larkAppId: string,
  messageId: string,
  options: { userCardContent?: boolean } = {},
): Promise<any> {
  const c = getBotClient(larkAppId);
  // card_msg_content_type=user_card_content returns the original card JSON
  // (including v2 schema/body/elements) instead of Lark's simplified fallback
  // ("请升级至最新版本客户端，以查看内容"). We default to true for single-message
  // fetches, but merge_forward enumeration MUST pass false — Lark returns
  // HTTP 500 when the param is combined with a merge_forward message_id.
  // Without the param, sub-messages still come back in the "Format A"
  // simplified card shape which extractCardContent handles.
  const userCardContent = options.userCardContent ?? true;
  const res = await larkGet(c, `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
    ...(userCardContent ? { card_msg_content_type: 'user_card_content' } : {}),
  });
  if (res.code !== 0) {
    throw new Error(`Failed to get message: ${res.msg} (code: ${res.code})`);
  }
  return res.data;
}

export async function downloadMessageResource(larkAppId: string, messageId: string, fileKey: string, type: 'image' | 'file', savePath: string): Promise<void> {
  const dir = dirname(savePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Try App Token first
  try {
    await downloadWithAppToken(larkAppId, messageId, fileKey, type, savePath);
    logger.info(`Downloaded ${type} ${fileKey} → ${savePath}`);
    return;
  } catch (appErr: any) {
    // AxiosError status can be at various paths depending on SDK version
    const status = appErr?.response?.status ?? appErr?.response?.statusCode
      ?? appErr?.status ?? appErr?.statusCode;
    // Only fall through to User Token for 400/403; other errors (network, etc.) re-throw
    if (status && status !== 400 && status !== 403) throw appErr;
    logger.debug(`App Token download failed (${status ?? 'unknown'}), trying User Token fallback...`);
  }

  // Fallback: User Token from botmux OAuth (/login)
  const bot = getBot(larkAppId);
  const userToken = await resolveUserToken(bot.config.larkAppId, bot.config.larkAppSecret);
  if (!userToken) {
    throw new Error(
      `App Token 无法下载此资源，且未找到可用的 User Token。` +
      `请在话题中发送 /login 完成授权后重试。`
    );
  }

  await downloadWithUserToken(userToken, messageId, fileKey, type, savePath);
  logger.info(`Downloaded ${type} ${fileKey} → ${savePath} (via User Token)`);
}

async function downloadWithAppToken(larkAppId: string, messageId: string, fileKey: string, type: 'image' | 'file', savePath: string): Promise<void> {
  const c = getBotClient(larkAppId);
  // Route through client.request() (empty-GET-body guard) instead of the
  // generated messageResource.get, which sends `{}` as a GET body and trips
  // gateway 411s. responseType:'stream' makes the interceptor resolve to the
  // raw readable stream; writeResourceToDisk drains it chunk-by-chunk.
  const res = await (c as any).request({
    method: 'GET',
    url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
    params: { type },
    responseType: 'stream',
  });
  await writeResourceToDisk(res, savePath);
}

async function downloadWithUserToken(userToken: string, messageId: string, fileKey: string, type: 'image' | 'file', savePath: string): Promise<void> {
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`User Token download failed: HTTP ${res.status} ${body}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(savePath, buf);
}

async function writeResourceToDisk(res: any, savePath: string): Promise<void> {
  if (res instanceof Buffer) {
    writeFileSync(savePath, res);
  } else if (res && typeof res === 'object' && 'writeFile' in res) {
    await res.writeFile(savePath);
  } else {
    // Raw Readable (client.request with responseType:'stream'). Pipe straight
    // to disk instead of buffering — this resource API serves files up to
    // 100MB, so Buffer.concat + writeFileSync would spike memory and block the
    // event loop under concurrent downloads. pipeline handles backpressure and
    // closes/cleans up both streams on error.
    await pipeline(res as NodeJS.ReadableStream, createWriteStream(savePath));
  }
}

const EXT_TO_FILE_TYPE: Record<string, string> = {
  '.opus': 'opus', '.mp4': 'mp4', '.pdf': 'pdf',
  '.doc': 'doc', '.docx': 'doc', '.xls': 'xls', '.xlsx': 'xls',
  '.ppt': 'ppt', '.pptx': 'ppt',
};

export async function uploadImage(larkAppId: string, imagePath: string): Promise<string> {
  const c = getBotClient(larkAppId);
  const buf = readFileSync(imagePath);
  // SDK returns { image_key } directly (not wrapped in { code, data })
  const res = await c.im.v1.image.create({
    data: { image_type: 'message', image: buf },
  });
  const imageKey = res?.image_key;
  if (!imageKey) throw new Error(`Failed to upload image: no image_key in response (${JSON.stringify(res)})`);
  logger.info(`Uploaded image ${imagePath} → ${imageKey}`);
  return imageKey;
}

export async function uploadFile(larkAppId: string, filePath: string): Promise<string> {
  const c = getBotClient(larkAppId);
  const buf = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const fileType = EXT_TO_FILE_TYPE[ext] ?? 'stream';
  const fileName = basename(filePath);
  // SDK returns { file_key } directly (not wrapped in { code, data })
  const res = await c.im.v1.file.create({
    data: { file_type: fileType as any, file_name: fileName, file: buf },
  });
  const fileKey = res?.file_key;
  if (!fileKey) throw new Error(`Failed to upload file: no file_key in response (${JSON.stringify(res)})`);
  logger.info(`Uploaded file ${filePath} → ${fileKey}`);
  return fileKey;
}

/**
 * Resolve emails to Lark open_ids via batch user lookup.
 * Accepts mixed input: items starting with "ou_" are kept as-is; everything else
 * must be a full email address (e.g. "alice@example.com") and is looked up.
 * Returns an array of open_ids (unresolvable entries are dropped with a warning).
 */
/**
 * Resolve a raw allowedUsers list (mix of `ou_*` open_ids and emails) into
 * open_ids, AND return a `raw entry → resolved open_id` map. The map lets
 * `/revoke` delete the correct raw entry (email OR open_id) from bots.json so
 * the revocation survives a restart. open_id entries map to themselves;
 * resolved emails are keyed by the EXACT raw email string from the config
 * (matched case-insensitively against the API's returned email) so the map key
 * always equals what's in `allowedUsers`. Unresolvable emails are dropped.
 */
export async function resolveAllowedUsersWithMap(
  larkAppId: string, raw: string[],
): Promise<{ resolved: string[]; map: Map<string, string> }> {
  const map = new Map<string, string>();
  const openIds: string[] = [];
  const emails: string[] = [];
  for (const v of raw) {
    if (v.startsWith('ou_')) {
      openIds.push(v);
      map.set(v, v);
    } else {
      emails.push(v);
    }
  }
  if (emails.length === 0) return { resolved: openIds, map };

  const c = getBotClient(larkAppId);
  try {
    const res = await (c as any).contact.v3.user.batchGetId({
      params: { user_id_type: 'open_id' },
      data: { emails, include_resigned: false },
    });
    if (res.code !== 0) {
      logger.warn(`Failed to resolve emails to open_ids: ${res.msg} (code: ${res.code})`);
      return { resolved: openIds, map };
    }
    const userList: any[] = res.data?.user_list ?? [];
    // 先按 normalized(email) → user_id 建查找表，再对原始请求的 raw email 逐个回填 map，
    // 保证 map 的 key 与 allowedUsers 里的字面值完全一致（防 API 大小写/规范化错配）。
    const byNorm = new Map<string, string>();
    for (const item of userList) {
      if (item.user_id && item.email) byNorm.set(String(item.email).toLowerCase(), item.user_id);
      else if (!item.user_id) logger.warn(`Could not resolve email: ${item.email}`);
    }
    for (const rawEmail of emails) {
      const uid = byNorm.get(rawEmail.toLowerCase());
      if (uid) {
        openIds.push(uid);
        map.set(rawEmail, uid);
        logger.info(`Resolved ${rawEmail} → ${uid}`);
      }
    }
  } catch (err: any) {
    logger.warn(`resolveAllowedUsers failed: ${err.message}`);
  }
  return { resolved: openIds, map };
}

export async function resolveAllowedUsers(larkAppId: string, raw: string[]): Promise<string[]> {
  return (await resolveAllowedUsersWithMap(larkAppId, raw)).resolved;
}

export async function listThreadMessages(larkAppId: string, chatId: string, rootMessageId: string, pageSize: number = 50): Promise<any[]> {
  const c = getBotClient(larkAppId);

  // Resolve the thread_id (omt_xxx) from a known thread reply.
  // container_id_type="thread" is faster and more reliable than scanning the whole chat.
  const threadId = await resolveThreadId(c, rootMessageId);

  if (threadId) {
    return listByThread(c, threadId, pageSize);
  }
  // Fallback: scan chat messages and filter by root_id
  return listByChatFilter(c, chatId, rootMessageId, pageSize);
}

/** Get the thread_id (omt_xxx) from the root message via message.get. */
async function resolveThreadId(c: any, rootMessageId: string): Promise<string | undefined> {
  try {
    const res = await larkGet(c, `/open-apis/im/v1/messages/${encodeURIComponent(rootMessageId)}`);
    if (res.code === 0) {
      return res.data?.items?.[0]?.thread_id;
    }
  } catch {
    // Ignore — fallback to chat scan
  }
  return undefined;
}

/** Lark message.list rejects page_size > 50 with field_violations (max 50).
 *  Callers can still ask for more via pageSize — we just paginate harder. */
const LARK_MESSAGE_LIST_MAX_PAGE = 50;

/** List thread messages using container_id_type="thread" (fast path). */
async function listByThread(c: any, threadId: string, pageSize: number): Promise<any[]> {
  const allMessages: any[] = [];
  let pageToken: string | undefined;

  do {
    const res = await larkGet(c, '/open-apis/im/v1/messages', {
      container_id_type: 'thread',
      container_id: threadId,
      page_size: Math.min(pageSize, LARK_MESSAGE_LIST_MAX_PAGE),
      sort_type: 'ByCreateTimeAsc',
      ...(pageToken ? { page_token: pageToken } : {}),
    });

    if (res.code !== 0) {
      throw new Error(`Failed to list thread messages: ${res.msg} (code: ${res.code})`);
    }

    if (res.data?.items) {
      allMessages.push(...res.data.items);
    }

    pageToken = res.data?.page_token;
    if (allMessages.length >= pageSize) break;
  } while (pageToken);

  return allMessages.slice(0, pageSize);
}

/** List chat-container messages, most-recent first but returned chronologically
 *  (oldest → newest, capped at `pageSize`). Used by `botmux history` for
 *  chat-scope sessions (普通群整群一会话): no thread to walk, so we walk the
 *  chat itself. We page in Desc order so a long-running chat returns its TAIL,
 *  not its head — that's the context the caller wants. The caller controls
 *  how much history they get via `pageSize`. */
export async function listChatMessages(
  larkAppId: string, chatId: string, pageSize: number = 50,
): Promise<any[]> {
  const c = getBotClient(larkAppId);
  const allMessages: any[] = [];
  let pageToken: string | undefined;

  do {
    const res = await larkGet(c, '/open-apis/im/v1/messages', {
      container_id_type: 'chat',
      container_id: chatId,
      page_size: Math.min(pageSize, LARK_MESSAGE_LIST_MAX_PAGE),
      sort_type: 'ByCreateTimeDesc',
      ...(pageToken ? { page_token: pageToken } : {}),
    });

    if (res.code !== 0) {
      throw new Error(`Failed to list chat messages: ${res.msg} (code: ${res.code})`);
    }

    if (res.data?.items) {
      allMessages.push(...res.data.items);
    }

    pageToken = res.data?.page_token;
    if (allMessages.length >= pageSize) break;
  } while (pageToken);

  // Cap to pageSize newest, then reverse to chronological for the caller.
  return allMessages.slice(0, pageSize).reverse();
}

export interface AmbientChatMessageOptions {
  /**
   * Exclude messages at/after this timestamp (Lark create_time, milliseconds as
   * a string). Used by `/t` thread sessions to fetch the chat tail that existed
   * before the thread was opened, avoiding bot cards/replies from the new
   * thread polluting the context.
   */
  beforeCreateTime?: string;
  /** Exclude the current thread root and its replies from the chat tail. */
  excludeRootMessageId?: string;
  /** How many chat-container messages to scan before filtering. */
  scanLimit?: number;
}

export function filterAmbientChatMessages(
  messages: any[],
  pageSize: number,
  options: Pick<AmbientChatMessageOptions, 'beforeCreateTime' | 'excludeRootMessageId'> = {},
): any[] {
  const beforeMs = options.beforeCreateTime ? Number(options.beforeCreateTime) : undefined;
  const root = options.excludeRootMessageId;

  const filtered = messages.filter((m: any) => {
    if (root && (m.message_id === root || m.root_id === root)) return false;
    if (Number.isFinite(beforeMs)) {
      const createdMs = Number(m.create_time);
      // If create_time is malformed, keep the message rather than silently
      // dropping potentially useful context. Lark normally returns epoch ms.
      if (Number.isFinite(createdMs) && createdMs >= (beforeMs as number)) return false;
    }
    return true;
  });

  return filtered.slice(Math.max(0, filtered.length - pageSize));
}

/**
 * List recent chat-container messages as ambient context for a thread session.
 *
 * This intentionally differs from `listChatMessages`: callers want the newest
 * `pageSize` messages AFTER filtering out the current thread and (optionally)
 * messages created after the thread root. We therefore may scan more than
 * `pageSize` items and cap only after filtering.
 */
export async function listAmbientChatMessages(
  larkAppId: string,
  chatId: string,
  pageSize: number = 50,
  options: AmbientChatMessageOptions = {},
): Promise<any[]> {
  const scanLimit = Math.max(pageSize, options.scanLimit ?? Math.min(Math.max(pageSize * 4, 50), 200));
  const raw = await listChatMessages(larkAppId, chatId, scanLimit);
  return filterAmbientChatMessages(raw, pageSize, options);
}

/** Fallback: scan chat messages and filter by root_id. */
async function listByChatFilter(c: any, chatId: string, rootMessageId: string, pageSize: number): Promise<any[]> {
  const allMessages: any[] = [];
  let pageToken: string | undefined;

  do {
    const res = await larkGet(c, '/open-apis/im/v1/messages', {
      container_id_type: 'chat',
      container_id: chatId,
      page_size: Math.min(pageSize, LARK_MESSAGE_LIST_MAX_PAGE),
      sort_type: 'ByCreateTimeDesc',
      ...(pageToken ? { page_token: pageToken } : {}),
    });

    if (res.code !== 0) {
      throw new Error(`Failed to list messages: ${res.msg} (code: ${res.code})`);
    }

    if (res.data?.items) {
      for (const item of res.data.items) {
        if (item.message_id === rootMessageId || item.root_id === rootMessageId) {
          allMessages.push(item);
        }
      }
    }

    pageToken = res.data?.page_token;
    if (allMessages.length >= pageSize) break;
  } while (pageToken);

  allMessages.sort((a, b) => (a.create_time ?? '').localeCompare(b.create_time ?? ''));
  return allMessages;
}

/**
 * Check which bots are in a chat.
 *
 * Two-source merge:
 * 1. **configured** — bots in `bots.json` (this daemon and sibling daemons on
 *    the same host). Probed via `isInChat` per bot; only those actually in
 *    the chat are returned. open_id is corrected via the per-app cross-ref.
 * 2. **introduce** — bots discovered passively from the `/introduce`
 *    collaboration handshake, persisted per observer × chat in
 *    `observed-bots-<larkAppId>-<chatId>.json`. Critical for external bots
 *    run by other botmux daemons (or even non-botmux bots) that aren't in
 *    our bots.json but the user wants this daemon to know about. Read with
 *    the caller's `larkAppId` so open_ids match this app's perspective.
 *
 * Configured wins on open_id collision (`source: 'configured'`); observed
 * entries fill in everyone else (`source: 'introduce'`). Observed entries
 * carry `larkAppId=""` since they don't map to any local-daemon-managed bot.
 */
export type ChatBotMember = {
  larkAppId: string;
  openId: string;
  name: string;
  displayName: string;
  source: 'configured' | 'introduce';
};

export async function listChatBotMembers(larkAppId: string, chatId: string): Promise<ChatBotMember[]> {
  // Read per-bot cross-reference: other bots' open_ids as seen by larkAppId's app.
  // This is populated from @mention data in Lark events (the only reliable source,
  // since Lark open_id is per-app scoped — a bot's self-reported open_id is
  // different from how other apps see it).
  const crossRef = new Map<string, string>();
  try {
    const crossRefPath = join(config.session.dataDir, `bot-openids-${larkAppId}.json`);
    if (existsSync(crossRefPath)) {
      const data: Record<string, string> = JSON.parse(readFileSync(crossRefPath, 'utf-8'));
      for (const [name, openId] of Object.entries(data)) {
        crossRef.set(name.toLowerCase(), openId);
      }
    }
  } catch { /* ignore */ }

  // Also read bots-info.json for bot display names and as fallback
  const appIdToInfo = new Map<string, { botOpenId: string | null; botName: string | null }>();
  try {
    const infoPath = join(config.session.dataDir, 'bots-info.json');
    if (existsSync(infoPath)) {
      const entries: Array<{ larkAppId: string; botOpenId: string | null; botName: string | null }> = JSON.parse(readFileSync(infoPath, 'utf-8'));
      for (const e of entries) {
        appIdToInfo.set(e.larkAppId, { botOpenId: e.botOpenId, botName: e.botName });
      }
    }
  } catch { /* ignore corrupt file */ }

  const clients = getAllBotClients();
  const configuredResults = await Promise.all(
    clients.map(async ({ appId, cliId, client }): Promise<ChatBotMember | null> => {
      try {
        const res = await larkGet(client, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/is_in_chat`);
        if (res.code === 0 && res.data?.is_in_chat) {
          const info = appIdToInfo.get(appId);
          // Prefer cross-reference (correct per-app open_id), fall back to self-seen
          const openId = (info?.botName && crossRef.get(info.botName.toLowerCase()))
            ?? info?.botOpenId
            ?? appId;
          return {
            larkAppId: appId,
            openId,
            name: cliId,
            displayName: info?.botName ?? cliId,
            source: 'configured',
          };
        }
      } catch (err) {
        logger.debug(`isInChat check failed for ${appId}: ${err}`);
      }
      return null;
    }),
  );
  const configured: ChatBotMember[] = configuredResults.filter((r): r is ChatBotMember => r !== null);

  // Merge in observed entries (from /introduce) — scoped to the caller's
  // observer app so the open_ids match how THIS daemon should @-mention them
  // (Lark open_id is per-app scoped). Dedup by openId (configured wins).
  const seenOpenIds = new Set(configured.map(b => b.openId));
  let observed: ChatBotMember[] = [];
  try {
    const observedList = listObservedBots(config.session.dataDir, larkAppId, chatId);
    observed = observedList
      .filter(o => !seenOpenIds.has(o.openId))
      .map(o => ({
        larkAppId: '',
        openId: o.openId,
        name: o.name,
        displayName: o.name,
        source: 'introduce' as const,
      }));
  } catch (err) {
    logger.debug(`Failed to load observed bots for ${chatId}: ${err}`);
  }

  return [...configured, ...observed];
}
