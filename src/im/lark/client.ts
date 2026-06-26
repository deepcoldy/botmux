import { readFileSync, writeFileSync, createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { dirname, extname, basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Client, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { getBotClient, getAllBots, getBot } from '../../bot-registry.js';
import { loadBotConfigs } from '../../bot-registry.js';
import { config } from '../../config.js';
import { emitHookEvent } from '../../services/hook-runner.js';
import { logger } from '../../utils/logger.js';
import { BoundedMap } from '../../utils/bounded-map.js';
import { resolveUserToken } from '../../utils/user-token.js';
import { listObservedBots } from '../../services/observed-bots-store.js';
import { getBotCapability } from '../../services/bot-profile-store.js';
import { resolveTeamRoleFile } from '../../core/role-resolver.js';
import { type Brand, larkHosts, normalizeBrand, sdkDomain } from './lark-hosts.js';

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
      client: new Client({ appId: cfg.larkAppId, appSecret: cfg.larkAppSecret, domain: sdkDomain(normalizeBrand(cfg.brand)), loggerLevel: LoggerLevel.error }),
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

/**
 * Thrown ONLY when a resource download genuinely needs (re-)authorization: no
 * usable User Token on disk, or the User Token was rejected as unauthorized
 * (HTTP 401). Callers gate the "/login" prompt on `instanceof` this — NOT on a
 * substring of the message — so an ordinary download failure (4xx/5xx for a
 * cross-tenant / card-image / withdrawn resource) is no longer misreported as
 * "missing User Token, please /login" even though a valid token was used.
 */
export class UserTokenMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserTokenMissingError';
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
export async function sendMessage(larkAppId: string, chatId: string, content: string, msgType: string = 'text', uuid?: string, hookContext?: Record<string, unknown>): Promise<string> {
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
  emitHookEvent('outbound.send', {
    ...hookContext,
    larkAppId,
    chatId,
    messageId,
    msgType,
    uuid,
    content,
  });
  return messageId;
}

/**
 * Reply to an existing message.  See {@link sendMessage} for the `uuid`
 * dedupe parameter — same semantics apply to replies (Feishu reply API
 * also accepts `uuid` and yields the same 1-hour idempotent return).  See
 * spike report §1.4 for the reply-specific test results, including the
 * cross-parent dedupe behavior that informs the inputHash design.
 */
export async function replyMessage(larkAppId: string, messageId: string, content: string, msgType: string = 'text', replyInThread: boolean = false, uuid?: string, hookContext?: Record<string, unknown>): Promise<string> {
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
  emitHookEvent('outbound.reply', {
    ...hookContext,
    larkAppId,
    messageId,
    replyId,
    msgType,
    replyInThread,
    uuid,
    content,
  });
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

/**
 * Resolve a user's tenant-stable `union_id` from their app-scoped `open_id`.
 * Used by cross-daemon owner checks (e.g. /relay --create peer migrate)
 * to compare identities across bot namespaces — open_id alone is
 * app-scoped, so two daemons looking at the same physical user see
 * different open_ids.
 *
 * Best-effort: returns null on API failure / missing scope / empty
 * response, so callers can fall back to other identity strategies
 * instead of failing the whole flow.
 */
export async function resolveUnionIdFromOpenId(
  larkAppId: string,
  openId: string,
): Promise<string | null> {
  const c = getBotClient(larkAppId);
  try {
    const res = await larkGet(c, `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`, {
      user_id_type: 'open_id',
    });
    if (res?.code !== 0) {
      logger.debug(`[union_id] resolve failed for ${openId.substring(0, 12)}: code=${res?.code} msg=${res?.msg ?? ''}`);
      return null;
    }
    const unionId: string | undefined = res?.data?.user?.union_id;
    return unionId ?? null;
  } catch (err) {
    logger.debug(`[union_id] resolve threw for ${openId.substring(0, 12)}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** 用户资料（名字+头像）查询缓存：key = appId:idType:id。负结果也缓存——
 *  不在通讯录可见范围（41050）的用户每次查都会失败，别反复打 API。 */
const userProfileCache = new Map<string, { name: string; avatarUrl?: string } | null>();
const USER_PROFILE_CACHE_MAX = 1000;

/**
 * Best-effort 拉用户资料（名字 + 头像 URL）。拿不到（缺 scope / 不在可见
 * 范围 / 网络错误）返回 null，调用方自行回退占位。
 */
export async function getUserProfile(
  larkAppId: string,
  userId: string,
  idType: 'open_id' | 'union_id' = 'open_id',
): Promise<{ name: string; avatarUrl?: string } | null> {
  const key = `${larkAppId}:${idType}:${userId}`;
  const hit = userProfileCache.get(key);
  if (hit !== undefined) return hit;
  let out: { name: string; avatarUrl?: string } | null = null;
  try {
    const c = getBotClient(larkAppId);
    const res = await larkGet(c, `/open-apis/contact/v3/users/${encodeURIComponent(userId)}`, {
      user_id_type: idType,
    });
    const u = res?.code === 0 ? res?.data?.user : null;
    if (u?.name) {
      out = { name: String(u.name), avatarUrl: u.avatar?.avatar_72 ?? u.avatar?.avatar_240 ?? undefined };
    }
  } catch (err) {
    logger.debug(`[user-profile] lookup threw for ${userId.substring(0, 12)}: ${err instanceof Error ? err.message : err}`);
  }
  if (userProfileCache.size >= USER_PROFILE_CACHE_MAX) userProfileCache.clear();
  userProfileCache.set(key, out);
  return out;
}

/**
 * Best-effort 判断一个 open_id 是否为「真人」（通讯录里查得到 user）。
 *
 * - code 0 且返回 user 对象 → 确定是真人 → true
 * - 查不到 / 报错 → false。这一类同时覆盖两种情况：①bot（应用不在通讯录，必然查不到）；
 *   ②本 app 缺 `contact:user.base:readonly` 读权限（这时真人也会查不到）。
 *
 * 用途：花名册（observed-bots-store）只应收 bot，不收真人——真人混进去会污染
 * `<available_bots>` 误导模型。调用方语义统一为「只在 NOT-confirmed-human 时登记」：
 *   - 有 contact 读权限（常态）→ 真人被准确剔除，登记得干净；
 *   - 缺权限 / 查询瞬时失败（降级）→ 一律按非真人放行登记。对 /introduce 这本就「全部登记」，
 *     无回退损失；但对 /grant 自动登记这条**新增**路径，降级时真人会被误登记——这是个新增
 *     的（窄）污染面，靠 `contact:user.base:readonly` 已是 critical scope、启动自检缺失即 DM
 *     管理员来收敛，不是「与现状等价」。若要彻底消除需区分 permission/network 与 user-not-found
 *     错误码（user-not-found 才判 bot），属后续增强。
 */
export async function isHumanOpenId(larkAppId: string, openId: string): Promise<boolean> {
  const c = getBotClient(larkAppId);
  try {
    const res = await larkGet(c, `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`, {
      user_id_type: 'open_id',
    });
    return res?.code === 0 && !!res?.data?.user;
  } catch (err) {
    logger.debug(`[isHuman] lookup threw for ${openId.substring(0, 12)}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
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
 * List the open_ids of a chat's (user) members, paginating until exhausted.
 * Used by the 主动开工 场景① gate to check whether any of the bot's allowedUsers
 * is a member of a chat the bot was just added to. Open_ids are app-scoped, so
 * the result is only comparable against the SAME bot's resolvedAllowedUsers.
 *
 * Throws on API failure (e.g. missing `im:chat`/member-read scope) so the
 * caller can decide how to degrade — it does NOT swallow errors, because a
 * silent empty list would look like "no allowedUser present" and wrongly
 * suppress auto-start.
 */
export async function listChatMemberOpenIds(larkAppId: string, chatId: string): Promise<string[]> {
  const c = getBotClient(larkAppId);
  const openIds: string[] = [];
  let pageToken: string | undefined;
  // Hard page cap as a runaway guard (100 members/page × 20 = 2000 members).
  for (let page = 0; page < 20; page++) {
    const params: Record<string, string> = { member_id_type: 'open_id', page_size: '100' };
    if (pageToken) params.page_token = pageToken;
    const res = await larkGet(c, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`, params);
    if (res.code !== 0) {
      throw new Error(`Failed to list chat members: ${res.msg} (code: ${res.code})`);
    }
    for (const it of (res.data?.items ?? [])) {
      const id = it?.member_id;
      if (typeof id === 'string' && id) openIds.push(id);
    }
    if (!res.data?.has_more || !res.data?.page_token) break;
    pageToken = res.data.page_token;
  }
  return openIds;
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

/**
 * One-shot fetch of both the chat's display name AND its mode (普通群 /
 * 话题群 / p2p) — saves a duplicate API call when the caller wants both
 * (the /relay picker needs name for display and mode for the type tag).
 * Falls back to `{ name: null, mode: 'group' }` on any error, mirroring
 * getChatMode's safer-default behaviour.
 *
 * Cached per (appId, chatId) for 5 minutes — the /relay picker re-renders
 * on every select / paginate / search click, and without the cache each
 * click would fire N parallel chat.get API calls (one per unique source
 * chat) which the user perceives as a loading spinner. Mirrors the TTL
 * cache `getChatMode` already has. */
interface ChatInfoCacheEntry { name: string | null; mode: ChatMode; cachedAt: number }
// Bounded: keyed per (appId, chatId); TTL handles freshness on read, the cap
// stops the entry count growing with every distinct chat the bot ever touches.
const chatInfoCache = new BoundedMap<string, ChatInfoCacheEntry>(1000);
const CHAT_INFO_TTL_MS = 5 * 60 * 1000;

export async function getChatNameAndMode(
  larkAppId: string,
  chatId: string,
): Promise<{ name: string | null; mode: ChatMode }> {
  const cacheKey = `${larkAppId}::${chatId}`;
  const cached = chatInfoCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CHAT_INFO_TTL_MS) {
    return { name: cached.name, mode: cached.mode };
  }

  let name: string | null = null;
  let mode: ChatMode = 'group';
  try {
    const c = getBotClient(larkAppId);
    const res = await larkGet(c, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`);
    if (res.code === 0) {
      const raw = String(res.data?.name ?? '').trim();
      name = raw.length > 0 ? raw : null;
      const rawMode = String(res.data?.chat_mode ?? '').toLowerCase();
      const rawType = String(res.data?.chat_type ?? '').toLowerCase();
      const rawGmt = String(res.data?.group_message_type ?? '').toLowerCase();
      // Same classification as getChatMode — keep in sync.
      if (rawType === 'p2p') mode = 'p2p';
      else if (rawMode === 'topic' || rawGmt === 'thread') mode = 'topic';
      else mode = 'group';
    }
  } catch {
    /* keep safe defaults */
  }
  chatInfoCache.set(cacheKey, { name, mode, cachedAt: Date.now() });
  return { name, mode };
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

const chatModeCache = new BoundedMap<string, { mode: ChatMode; cachedAt: number }>(1000);
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
/**
 * Resolve a chat's mode by hitting the API directly. Returns `'unknown'` when
 * the chat type can't be confirmed (non-zero code or thrown) — it does NOT guess
 * `'group'`. Use this for privacy-critical gates that must fail closed (private
 * `/card`). Always queries the API (no cache read), but populates the shared
 * cache on success so a following {@link getChatMode} hits it.
 */
export async function getChatModeStrict(larkAppId: string, chatId: string): Promise<ChatMode | 'unknown'> {
  try {
    const c = getBotClient(larkAppId);
    const res = await larkGet(c, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`);
    if (res.code !== 0) {
      logger.warn(`getChatModeStrict(${chatId}) failed: ${res.msg} (code: ${res.code})`);
      return 'unknown';
    }
    // 'p2p' (single chat) lives in chat_mode, NOT chat_type. chat_type is the
    // group's visibility (public/private) and is undefined for p2p — checking it
    // for 'p2p' never matches, so a DM would fall through to 'group'.
    const rawMode = String(res.data?.chat_mode ?? '').toLowerCase();
    // group_message_type is the actual "is this a 话题群" signal. The Lark
    // client UI lets users flip a chat between flat mode and topic mode at any
    // time — that toggle writes group_message_type ('chat' ↔ 'thread'), NOT
    // chat_mode. chat_mode is the creation-time topology classification and
    // stays 'group' even for user-converted topic chats; in our tenant we have
    // only ever seen chat_mode='topic' on a small set of legacy chats. Treating
    // chat_mode='topic' OR group_message_type='thread' as 'topic' covers both.
    const rawGmt = String(res.data?.group_message_type ?? '').toLowerCase();
    let mode: ChatMode;
    if (rawMode === 'p2p') mode = 'p2p';
    else if (rawMode === 'topic' || rawGmt === 'thread') mode = 'topic';
    else if (rawMode === 'group') mode = 'group';
    else {
      // Empty / unrecognized chat_mode (e.g. data={}, or a future enum value):
      // we genuinely can't confirm the type, so fail closed with 'unknown'
      // rather than guessing 'group' — honours this function's contract for
      // privacy-critical callers. (getChatMode still maps 'unknown'→'group' for
      // lenient routing, so non-strict consumers are unaffected.)
      logger.warn(`getChatModeStrict(${chatId}) unrecognized chat_mode='${rawMode}' — returning 'unknown'`);
      return 'unknown';
    }
    chatModeCache.set(`${larkAppId}::${chatId}`, { mode, cachedAt: Date.now() });
    return mode;
  } catch (err: any) {
    logger.warn(`getChatModeStrict(${chatId}) errored: ${err?.message ?? err}`);
    return 'unknown';
  }
}

export function getCachedChatMode(larkAppId: string, chatId: string): ChatMode | undefined {
  const cached = chatModeCache.get(`${larkAppId}::${chatId}`);
  if (cached && Date.now() - cached.cachedAt < CHAT_MODE_TTL_MS) return cached.mode;
  return undefined;
}

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
  // Lenient default: an unconfirmed chat is treated as 'group' (a flat group is
  // the safer routing default than wrongly forcing threads). getChatModeStrict
  // already cached the result on success; cache the fallback on 'unknown' too.
  const strict = await getChatModeStrict(larkAppId, chatId);
  if (strict !== 'unknown') return strict;
  const mode: ChatMode = 'group';
  logger.warn(`getChatMode(${chatId}) unconfirmed; falling back to 'group'`);
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

/** Error code Feishu returns from `ephemeral/v1/send` when the target chat is a
 *  topic / thread chat. Ephemeral cards only work in plain `group` chats (see
 *  /tmp design notes: empirically code 18053 `chat can not be thread`). */
export const LARK_CODE_EPHEMERAL_NOT_GROUP = 18053;

/**
 * Send a "visible-to-one-user" ephemeral card (`ephemeral/v1/send`). The card is
 * only shown to `openId`, sends no notification, and — unlike normal messages —
 * **cannot be PATCH-updated** (legacy interface). Multiple recipients require one
 * call each. Only works in plain `group` chats; topic/thread/p2p chats reject
 * with {@link LARK_CODE_EPHEMERAL_NOT_GROUP}. Returns the ephemeral message_id.
 */
export async function sendEphemeralCard(
  larkAppId: string, chatId: string, openId: string, cardJson: string,
): Promise<string> {
  const c = getBotClient(larkAppId);
  let card: unknown;
  try {
    card = JSON.parse(cardJson);
  } catch (err) {
    throw new Error(`Invalid ephemeral card JSON: ${err}`);
  }
  const res: any = await (c as any).request({
    method: 'POST',
    url: '/open-apis/ephemeral/v1/send',
    data: { chat_id: chatId, open_id: openId, msg_type: 'interactive', card },
  });
  if (res.code !== 0) {
    throw new Error(`Failed to send ephemeral card: ${res.msg} (code: ${res.code})`);
  }
  const messageId = res.data?.message_id;
  logger.info(`Sent ephemeral card ${messageId ?? '(no id)'} to ${openId} in chat ${chatId}`);
  return messageId ?? '';
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
  const brand = normalizeBrand(bot.config.brand);
  const userToken = await resolveUserToken(bot.config.larkAppId, bot.config.larkAppSecret, brand);
  if (!userToken) {
    throw new UserTokenMissingError(
      `App Token 无法下载此资源，且未找到可用的 User Token。` +
      `请在话题中发送 /login 完成授权后重试。`
    );
  }

  await downloadWithUserToken(userToken, messageId, fileKey, type, savePath, brand);
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

async function downloadWithUserToken(userToken: string, messageId: string, fileKey: string, type: 'image' | 'file', savePath: string, brand: Brand = 'feishu'): Promise<void> {
  const url = `${larkHosts(brand).openApi}/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 401 = the token itself was rejected (expired / wrong scope) → genuinely
    // needs re-login. Any other status (403/404/4xx/5xx) means the token is
    // fine but THIS resource can't be fetched (cross-tenant, card image,
    // withdrawn) — surface as a plain failure so it does NOT trigger /login.
    if (res.status === 401) {
      throw new UserTokenMissingError(`User Token 已失效（HTTP 401）。请在话题中发送 /login 重新授权后重试。`);
    }
    throw new Error(`Resource download failed: HTTP ${res.status} ${body}`);
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

export async function uploadFile(larkAppId: string, filePath: string, opts?: { duration?: number }): Promise<string> {
  const c = getBotClient(larkAppId);
  const buf = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const fileType = EXT_TO_FILE_TYPE[ext] ?? 'stream';
  const fileName = basename(filePath);
  // `duration` (ms) only applies to opus voice uploads — it sets the length
  // shown on the Feishu voice bubble. Lark wants ≥1000ms; clamp up.
  const duration = fileType === 'opus' && opts?.duration
    ? Math.max(1000, Math.round(opts.duration))
    : undefined;
  // SDK returns { file_key } directly (not wrapped in { code, data })
  const res = await c.im.v1.file.create({
    data: { file_type: fileType as any, file_name: fileName, file: buf, ...(duration ? { duration } : {}) },
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
  const unionIds: string[] = [];
  for (const v of raw) {
    if (v.startsWith('ou_')) {
      map.set(v, v);
      openIds.push(v);
    } else if (v.startsWith('on_')) {
      // union_id (跨应用稳定)：运行时权限/私信/卡片全是 open_id 原生的，
      // 启动时用本 app 凭证把 on_ 翻成本 app 的 ou_，下游一律照旧用 open_id。
      unionIds.push(v);
    } else {
      emails.push(v);
    }
  }

  if (emails.length > 0 || unionIds.length > 0 || openIds.length > 0) {
    const c = getBotClient(larkAppId);

    // Literal open_id is app-scoped. Keep it as-is for compatibility, but
    // diagnose the common misconfiguration where a different app's ou_ is copied
    // into this bot's allowedUsers and owner checks silently lock everyone out.
    for (const oid of openIds) {
      try {
        const res = await larkGet(c, `/open-apis/contact/v3/users/${encodeURIComponent(oid)}`, { user_id_type: 'open_id' });
        if (res?.code === 99992361) {
          logger.warn(`allowedUsers open_id ${oid} belongs to another app for ${larkAppId}; use email or union_id (on_) instead.`);
        } else if (res?.code && res.code !== 0) {
          logger.debug(`verify allowedUsers open_id ${oid} non-zero code: ${res.code} ${res.msg ?? ''}`);
        }
      } catch (err: any) {
        logger.debug(`verify allowedUsers open_id ${oid} failed: ${err?.message ?? err}`);
      }
    }

    // union_id → 本 app open_id（单条查询；失败则丢弃该条，与 email 解析失败同口径）。
    for (const uid of unionIds) {
      try {
        const res = await larkGet(c, `/open-apis/contact/v3/users/${encodeURIComponent(uid)}`, { user_id_type: 'union_id' });
        const oid = res?.data?.user?.open_id as string | undefined;
        if (res.code === 0 && oid) {
          map.set(uid, oid);
          logger.info(`Resolved ${uid} → ${oid}`);
        } else {
          logger.warn(`Failed to resolve union_id ${uid} to open_id: ${res?.msg} (code: ${res?.code})`);
        }
      } catch (err: any) {
        logger.warn(`resolve union_id ${uid} failed: ${err?.message ?? err}`);
      }
    }

    if (emails.length > 0) {
      try {
        const res = await (c as any).contact.v3.user.batchGetId({
          params: { user_id_type: 'open_id' },
          data: { emails, include_resigned: false },
        });
        if (res.code !== 0) {
          logger.warn(`Failed to resolve emails to open_ids: ${res.msg} (code: ${res.code})`);
        } else {
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
              map.set(rawEmail, uid);
              logger.info(`Resolved ${rawEmail} → ${uid}`);
            }
          }
        }
      } catch (err: any) {
        logger.warn(`resolveAllowedUsers failed: ${err.message}`);
      }
    }
  }

  // 解析不改变顺序：按 allowedUsers 的「原始配置顺序」回填 open_id，使
  // 「owner = 第一个 ou_」忠实反映配置里的排位（union/邮箱条目不再被甩到 ou_ 之后）。
  // 不可解析的条目丢弃；同一 open_id 去重并保留首次出现位置（同一人可能同时以
  // union/邮箱和字面 ou_ 两种形式登记）。
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const v of raw) {
    const oid = map.get(v);
    if (oid && !seen.has(oid)) {
      seen.add(oid);
      resolved.push(oid);
    }
  }
  return { resolved, map };
}

/**
 * Best-effort resolve a user's open_id → canonical union_id (+ display name)
 * for pairing-login. Requires `contact:user.base:readonly` scope; on failure
 * (no scope / API error) returns {} so callers degrade to open_id-only identity.
 */
export async function resolveUserUnionId(larkAppId: string, openId: string): Promise<{ unionId?: string; name?: string }> {
  if (!openId) return {};
  try {
    const c = getBotClient(larkAppId);
    const res = await larkGet(c, `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`, { user_id_type: 'open_id' });
    if (res.code === 0 && res.data?.user) {
      return { unionId: res.data.user.union_id ?? undefined, name: res.data.user.name ?? undefined };
    }
    if (res.code === 99992361) {
      logger.warn(`resolveUserUnionId [${larkAppId}]: open_id ${openId} 属于其他应用（cross app）。` +
        `请在 allowedUsers 中改用邮箱或 union_id（on_ 前缀）代替 open_id。`);
    } else {
      logger.debug(`resolveUserUnionId non-zero code: ${res.code} ${res.msg}`);
    }
  } catch (err: any) {
    logger.debug(`resolveUserUnionId failed: ${err?.message ?? err}`);
  }
  return {};
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
  /** Short capability label (team-level), for roster discovery. Configured bots only. */
  capability?: string;
  /** Whether this bot has a team-level role registered. Configured bots only. */
  hasTeamRole: boolean;
  /**
   * Whether the observing app (the `larkAppId` arg) can RELIABLY @-mention this
   * member. Lark open_id is per-app scoped, so a bot's self-reported open_id is
   * not usable by another app. Reliable only when learned via cross-ref (from
   * @mention events) or via /introduce (observed, already observer-scoped).
   */
  mentionable: boolean;
  mentionSource: 'cross-ref' | 'self' | 'observed' | 'fallback';
};

export async function listChatBotMembers(larkAppId: string, chatId: string): Promise<ChatBotMember[]> {
  // Single name-key normalizer used for EVERY cross-source name match below
  // (cross-ref ⇄ bots-info ⇄ observed). Trim-only: strips incidental leading/
  // trailing whitespace but stays case-sensitive, so two genuinely distinct bots
  // whose names differ only in case ("Claude" vs "claude") never collide.
  const norm = (s: string) => s.trim();

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
        crossRef.set(norm(name), openId);
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
          const crossHit = info?.botName ? crossRef.get(norm(info.botName)) : undefined;
          const openId = crossHit ?? info?.botOpenId ?? appId;
          const isSelf = appId === larkAppId;
          // Reliable @-mention only when the per-app open_id was learned via
          // cross-ref; self-view open_id (info.botOpenId) is wrong for OTHER
          // apps, and the appId fallback is no handle at all. Self is always fine.
          const mentionSource: ChatBotMember['mentionSource'] = crossHit
            ? 'cross-ref'
            : (info?.botOpenId ? 'self' : 'fallback');
          const mentionable = isSelf || mentionSource === 'cross-ref';
          return {
            larkAppId: appId,
            openId,
            name: cliId,
            displayName: info?.botName ?? cliId,
            source: 'configured',
            capability: getBotCapability(config.session.dataDir, appId) ?? undefined,
            hasTeamRole: resolveTeamRoleFile(appId) !== null,
            mentionable,
            mentionSource,
          };
        }
      } catch (err) {
        logger.debug(`isInChat check failed for ${appId}: ${err}`);
      }
      return null;
    }),
  );
  const configured: ChatBotMember[] = configuredResults.filter((r): r is ChatBotMember => r !== null);

  // Merge observed entries (from /introduce), scoped to the caller's observer
  // app so open_ids match how THIS daemon should @-mention them (open_id is
  // per-app scoped). Two cases:
  //   1) An observed entry uniquely matches a configured row by display name AND
  //      that row isn't already a reliable cross-ref handle → UPGRADE it in
  //      place: adopt the observed (observer-scoped) open_id and mark it
  //      reliably mentionable, while keeping larkAppId/capability/hasTeamRole.
  //      (A configured peer's own open_id is its self-view — wrong for us to @.)
  //   2) Otherwise (no/ambiguous match) → append as an external bot.
  try {
    const observedList = listObservedBots(config.session.dataDir, larkAppId, chatId);
    const latestObservedByName = new Map<string, (typeof observedList)[number]>();
    for (const o of observedList) {
      const k = norm(o.name);
      const existing = latestObservedByName.get(k);
      if (!existing || o.lastSeenAt > existing.lastSeenAt) {
        latestObservedByName.set(k, o);
      }
    }
    const seenOpenIds = new Set(configured.map(b => b.openId));
    const byName = new Map<string, number[]>();
    configured.forEach((b, i) => {
      const k = norm(b.displayName);
      const arr = byName.get(k);
      if (arr) arr.push(i); else byName.set(k, [i]);
    });

    for (const o of latestObservedByName.values()) {
      const crossHit = crossRef.get(norm(o.name));
      const openId = crossHit ?? o.openId;
      const mentionSource: ChatBotMember['mentionSource'] = crossHit ? 'cross-ref' : 'observed';
      if (seenOpenIds.has(openId)) continue;
      const matches = byName.get(norm(o.name)) ?? [];
      if (matches.length === 1) {
        const row = configured[matches[0]];
        // Upgrade only if not already a reliable cross-ref handle.
        if (row.mentionSource !== 'cross-ref') {
          configured[matches[0]] = { ...row, openId, mentionable: true, mentionSource };
          seenOpenIds.add(openId);
        }
        continue; // matched → never also append as an external duplicate
      }
      configured.push({
        larkAppId: '',
        openId,
        name: o.name,
        displayName: o.name,
        source: 'introduce',
        hasTeamRole: false,
        mentionable: true,
        mentionSource,
      });
      seenOpenIds.add(openId);
    }
  } catch (err) {
    logger.debug(`Failed to load observed bots for ${chatId}: ${err}`);
  }

  return configured;
}
