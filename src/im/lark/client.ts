import { readFileSync, writeFileSync, createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { dirname, extname, basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Client } from '@larksuiteoapi/node-sdk';
import { getBotClient, getBotUploadClient, getAllBots, getBot, formatLarkError, LarkTransportDisabledError } from '../../bot-registry.js';
import { loadBotConfigs } from '../../bot-registry.js';
import { config } from '../../config.js';
import { emitHookEvent, type ManagedHookOrigin } from '../../services/hook-runner.js';
import { logger } from '../../utils/logger.js';
import { BoundedMap } from '../../utils/bounded-map.js';
import { resolveUserToken } from '../../utils/user-token.js';
import { listObservedBots } from '../../services/observed-bots-store.js';
import { getBotCapability } from '../../services/bot-profile-store.js';
import { resolveTeamRoleFile } from '../../core/role-resolver.js';
import { type Brand, larkHosts, normalizeBrand, sdkDomain } from './lark-hosts.js';
import { canonicalMobileKey, isMobileEntry, normalizeMobileEntry } from '../../setup/bot-config-editor.js';
import { stampBotmuxCallbackMarkers } from './callback-button-marker.js';
import { executeWithLarkGate } from './api-gate.js';
import type { ChatContext } from '../../types.js';

type LarkRequestParams = Record<string, string | number | boolean | undefined>;

export interface LarkRequestOptions {
  /** Axios 层的真实请求超时；不设置时保持 SDK 原有行为。 */
  timeoutMs?: number;
  /** 透传给 Axios，用于在上层截止时间到达时主动取消网络请求。 */
  signal?: AbortSignal;
}

function larkRequestDeadline(options?: LarkRequestOptions): {
  timeout?: number;
  signal?: AbortSignal;
} {
  const timeout = options?.timeoutMs;
  return {
    ...(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
      ? { timeout: Math.max(1, Math.floor(timeout)) }
      : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  };
}

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
export async function larkGet(
  c: any,
  url: string,
  params: LarkRequestParams = {},
  options?: LarkRequestOptions,
): Promise<any> {
  return c.request({
    method: 'GET',
    url,
    params,
    ...larkRequestDeadline(options),
  });
}

// Cached lightweight Lark clients for all configured bots (for isInChat checks).
//
// These clients exist solely for the is_in_chat probe below, where failures are
// EXPECTED for configured bots that can't be checked against this chat
// (other-tenant bot → 232010, app missing im:chat scopes → 99991672). The SDK's
// generic request() dumps the full AxiosError through its logger before
// rethrowing, so with the default console logger every probe miss splashed a
// ~100-line stack/config blob into `botmux bots list` stdout / daemon logs.
// Silencing via loggerLevel is impossible — the SDK's LoggerProxy does
// `params.loggerLevel || LoggerLevel.info` and `LoggerLevel.fatal` is 0/falsy —
// so route the SDK's own logging to a condensed debug line instead. The probe's
// catch below stays the primary reporter (also one debug line per miss).
const fmtProbe = (msg: any[]) => msg.map((m) => formatLarkError(m) ?? (typeof m === 'string' ? m : String(m))).join(' ');
const probeLarkLogger = {
  fatal: (...msg: any[]) => logger.debug(`[lark:isInChat] ${fmtProbe(msg)}`),
  error: (...msg: any[]) => logger.debug(`[lark:isInChat] ${fmtProbe(msg)}`),
  warn:  (...msg: any[]) => logger.debug(`[lark:isInChat] ${fmtProbe(msg)}`),
  info:  (..._msg: any[]) => { /* 'client ready' × every configured bot — noise */ },
  debug: (..._msg: any[]) => { /* dropped */ },
  trace: (..._msg: any[]) => { /* dropped */ },
};
let allBotClients: Array<{ appId: string; cliId: string; client: InstanceType<typeof Client> }> | null = null;
let allBotClientsFingerprint: string | null = null;

function loadAllBotClientConfigs(): Array<{ larkAppId: string; larkAppSecret: string; cliId: string; brand?: string }> {
  // Exclude apiOnly (core-only) bots from every Lark-client consumer: they have
  // a synthetic appId + (possibly empty) secret and never connect to Feishu, so
  // instantiating a Client for them is useless AND actively harmful — a NORMAL
  // bot's roster probe (getAvailableBots → is_in_chat over getAllBotClients)
  // would otherwise auth-fail against the synthetic app, adding latency+noise to
  // the healthy bot path. Filtering here covers both discovery and the strict
  // stable-App resolver from one place.
  const notApiOnly = (c: { apiOnly?: boolean }) => c.apiOnly !== true;
  try {
    return loadBotConfigs().filter(notApiOnly);
  } catch {
    // riff sandbox：没有 bots.json，只有经 env 合成注册进 registry 的 bot——
    // 降级用注册表里的配置，`botmux bots list` 等只读探测照常可用。
    return getAllBots().map((b) => b.config).filter(notApiOnly);
  }
}

function getAllBotClients(opts: { refresh?: boolean } = {}) {
  if (!allBotClients || opts.refresh) {
    const cfgs = loadAllBotClientConfigs();
    // The strict stable-App resolver is an authorization boundary and must see
    // bots appended after this process started. Reload the controlled config on
    // every strict resolution, while retaining Client instances when the exact
    // credential/domain tuple is unchanged. Discovery callers keep the cheap
    // process cache.
    const fingerprint = JSON.stringify(cfgs.map(cfg => [
      cfg.larkAppId,
      cfg.cliId,
      cfg.larkAppSecret,
      normalizeBrand(cfg.brand as any),
    ]));
    if (!allBotClients || allBotClientsFingerprint !== fingerprint) {
      allBotClients = cfgs.map((cfg) => ({
        appId: cfg.larkAppId,
        cliId: cfg.cliId,
        client: new Client({ appId: cfg.larkAppId, appSecret: cfg.larkAppSecret, domain: sdkDomain(normalizeBrand(cfg.brand as any)), logger: probeLarkLogger }),
      }));
      allBotClientsFingerprint = fingerprint;
    }
  }
  return allBotClients;
}

/** Test seam for suites that replace the configured bot set at runtime. */
export function __testOnly_resetAllBotClients(): void {
  allBotClients = null;
  allBotClientsFingerprint = null;
}

/**
 * Find the first locally-configured (non-apiOnly) bot that is a member of
 * `chatId`, using the QUIET probe clients (probeLarkLogger) — so misses for
 * bots not in the chat don't splash AxiosError blobs to stdout/logs the way a
 * plain getBotClient()+isInChat loop does.
 *
 * Used by `bots invite`'s auto-add flow to pick a proxy bot already in the
 * target group (Feishu requires the adding app to be a member). Returns the
 * matching bot's appId+cliId, or null if none of our bots are in that chat.
 * `preferAppId` (e.g. the current session bot) is checked first.
 */
export async function findLocalBotInChat(
  chatId: string,
  preferAppId?: string,
): Promise<{ larkAppId: string; cliId: string } | null> {
  const clients = getAllBotClients();
  const ordered = [
    ...clients.filter((c) => c.appId === preferAppId),
    ...clients.filter((c) => c.appId !== preferAppId),
  ];
  for (const { appId, cliId, client } of ordered) {
    try {
      const res: any = await larkGet(client, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/is_in_chat`);
      if ((res.code === 0 || res.code === undefined) && res.data?.is_in_chat) {
        return { larkAppId: appId, cliId };
      }
    } catch {
      /* probe miss (other-tenant / no scope / not in chat) — quiet, try next */
    }
  }
  return null;
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
 * Re-exported from bot-registry (defined there to avoid an import cycle with
 * getBotClient). apiOnly bots throw this on any Feishu client request.
 */
export { LarkTransportDisabledError };

/** Bot-level transport gate: an apiOnly bot must never make an outbound Feishu
 * call. Called at the top of every write primitive. `op` names the primitive
 * for diagnostics. Read-only lookups (message detail, chat members) intentionally
 * do NOT call this — they are inert reads used by discovery, already filtered
 * elsewhere; only side-effecting writes are hard-gated here. Exported so other
 * modules with their OWN direct-Feishu implementations (e.g. doc-comment's
 * drive API) can enforce the same bot-level boundary from one definition. */
export function assertLarkTransport(larkAppId: string, op: string): void {
  let apiOnly = false;
  try {
    apiOnly = getBot(larkAppId).config.apiOnly === true;
  } catch {
    // Bot not registered (e.g. a synthetic id from a cross-daemon fallback):
    // leave the existing getBotClient error path to handle it, don't mask it.
    return;
  }
  if (apiOnly) throw new LarkTransportDisabledError(larkAppId, op);
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
// Capability cache for the undocumented `/members/bots` endpoint. It prevents
// repeated hits while the tenant/gateway cannot serve the API, but per-request
// business errors (bad chat id, permission denial) must not poison other chats.
const LIST_BOTS_API_FAILURE_TTL_MS = 3 * 60 * 1000;
const listBotsApiFailures = new Map<string, { reason: string; expiresAt: number }>();

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
export interface OutboundMessageOptions {
  /** The provider request is reconciling an already-attempted stable UUID.
   * Lark deduplicates the message, but the local outbound hook is a separate
   * side effect and must not be fired twice. */
  suppressHook?: boolean;
  /** Fence the distinct post-provider hook effect. A failure drops only the
   * hook because the Lark message has already been accepted and must not be
   * reported as failed (which would invite a duplicate retry). */
  beforeHook?: () => void | Promise<void>;
  /** Frozen protected origin used by read-isolated hook forwarding. */
  hookOrigin?: ManagedHookOrigin;
}

async function emitOutboundHookIfAllowed(
  options: OutboundMessageOptions | undefined,
  event: 'outbound.send' | 'outbound.reply',
  payload: Record<string, unknown>,
): Promise<void> {
  if (options?.suppressHook) return;
  try {
    await options?.beforeHook?.();
  } catch (err) {
    logger.warn(`Dropped ${event} hook after authority changed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (options?.hookOrigin) {
    emitHookEvent(event, payload, { managedOrigin: options.hookOrigin });
  } else {
    emitHookEvent(event, payload);
  }
}

export async function sendMessage(
  larkAppId: string,
  chatId: string,
  content: string,
  msgType: string = 'text',
  uuid?: string,
  hookContext?: Record<string, unknown>,
  options?: OutboundMessageOptions,
): Promise<string> {
  assertLarkTransport(larkAppId, 'sendMessage');
  return executeWithLarkGate(larkAppId, 'sendMessage', async () => {
    const c = getBotClient(larkAppId);
    const body = msgType === 'text'
      ? JSON.stringify({ text: content })
      : msgType === 'interactive' ? stampBotmuxCallbackMarkers(content) : content;

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
    await emitOutboundHookIfAllowed(options, 'outbound.send', {
        ...hookContext,
        larkAppId,
        chatId,
        messageId,
        msgType,
        uuid,
        content,
      });
    return messageId;
  });
}

/**
 * Reply to an existing message.  See {@link sendMessage} for the `uuid`
 * dedupe parameter — same semantics apply to replies (Feishu reply API
 * also accepts `uuid` and yields the same 1-hour idempotent return).  See
 * spike report §1.4 for the reply-specific test results, including the
 * cross-parent dedupe behavior that informs the inputHash design.
 */
export async function replyMessage(
  larkAppId: string,
  messageId: string,
  content: string,
  msgType: string = 'text',
  replyInThread: boolean = false,
  uuid?: string,
  hookContext?: Record<string, unknown>,
  options?: OutboundMessageOptions,
): Promise<string> {
  assertLarkTransport(larkAppId, 'replyMessage');
  return executeWithLarkGate(larkAppId, 'replyMessage', async () => {
    const c = getBotClient(larkAppId);
    const body = msgType === 'text'
      ? JSON.stringify({ text: content })
      : msgType === 'interactive' ? stampBotmuxCallbackMarkers(content) : content;

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
    await emitOutboundHookIfAllowed(options, 'outbound.reply', {
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
  });
}

export async function addReaction(larkAppId: string, messageId: string, emojiType: string): Promise<string> {
  assertLarkTransport(larkAppId, 'addReaction');
  return executeWithLarkGate(larkAppId, 'addReaction', async () => {
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
  });
}

export async function removeReaction(larkAppId: string, messageId: string, reactionId: string): Promise<void> {
  assertLarkTransport(larkAppId, 'removeReaction');
  return executeWithLarkGate(larkAppId, 'removeReaction', async () => {
    const c = getBotClient(larkAppId);
    const res = await (c as any).im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    if (res.code !== 0) {
      throw new Error(`Failed to remove reaction: ${res.msg} (code: ${res.code})`);
    }
    logger.info(`Removed reaction ${reactionId} from message ${messageId}`);
  });
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

/** 用户资料（名字+头像）查询缓存：key = appId:idType:id。字符串值 = 确定性
 *  负结果的类别（跨应用/不可见/无效 id），每次查都会失败，别反复打 API。
 *  瞬时失败（网络/频控/服务端 40003）不缓存——下次调用应当重试，负缓存瞬时
 *  错误会把合法用户长期钉成「查不到」。 */
type DefinitiveProfileMiss = 'cross_app' | 'not_visible' | 'invalid_id';
const userProfileCache = new Map<string, { name: string; avatarUrl?: string } | DefinitiveProfileMiss>();
const USER_PROFILE_CACHE_MAX = 1000;

/** Contact API 确定性失败码 → 类别（重试也不会变）：99992361 open_id 属其他
 *  应用；41050 无权限看该用户（不在通讯录可见范围）；41012 user id 无效 /
 *  40001 参数无效。其余非零码（如 40003 internal error）与网络异常视为瞬时。
 *  SDK 基于 Axios，非 2xx 以异常抛出、业务码在 response.data.code——调用方
 *  的 catch 也要走这里（getLarkErrorCode 提取）。 */
function classifyContactErrorCode(code: number | undefined): DefinitiveProfileMiss | undefined {
  if (code === 99992361) return 'cross_app';
  if (code === 41050) return 'not_visible';
  if (code === 41012 || code === 40001) return 'invalid_id';
  return undefined;
}

export type UserProfileLookup =
  | { status: 'ok'; profile: { name: string; avatarUrl?: string } }
  /** Definitive: the open_id belongs to another app (99992361). */
  | { status: 'cross_app' }
  /** Definitive: outside this app's contact visibility scope (41050). */
  | { status: 'not_visible' }
  /** Definitive: no such user / malformed id (41012 / 40001). */
  | { status: 'invalid_id' }
  /** Transient: network / rate limit / server error — retry may succeed. */
  | { status: 'error' };

/**
 * 严格版用户资料查询：按原因区分确定性失败（跨应用/不可见/无效 id）与瞬时
 * 失败。需要据此做决策的调用方（如替身对象解析——误把瞬时失败当跨应用会引导
 * 用户删掉合法配置）用这个；只要 best-effort 名字的调用方用 {@link getUserProfile}。
 */
export async function getUserProfileStrict(
  larkAppId: string,
  userId: string,
  idType: 'open_id' | 'union_id' = 'open_id',
): Promise<UserProfileLookup> {
  const key = `${larkAppId}:${idType}:${userId}`;
  const hit = userProfileCache.get(key);
  if (hit !== undefined) return typeof hit === 'string' ? { status: hit } : { status: 'ok', profile: hit };
  let out: UserProfileLookup;
  try {
    const c = getBotClient(larkAppId);
    const res = await larkGet(c, `/open-apis/contact/v3/users/${encodeURIComponent(userId)}`, {
      user_id_type: idType,
    });
    const u = res?.code === 0 ? res?.data?.user : null;
    if (u?.name) {
      out = { status: 'ok', profile: { name: String(u.name), avatarUrl: u.avatar?.avatar_72 ?? u.avatar?.avatar_240 ?? undefined } };
    } else {
      const miss = res?.code === 0 ? 'not_visible' : classifyContactErrorCode(res?.code);
      if (miss) out = { status: miss };
      else {
        logger.debug(`[user-profile] lookup transient code for ${userId.substring(0, 12)}: ${res?.code} ${res?.msg ?? ''}`);
        out = { status: 'error' };
      }
    }
  } catch (err) {
    // 非 2xx 走这里（Axios throw）——先提业务码再定性，别把跨应用当瞬时错误。
    const miss = classifyContactErrorCode(getLarkErrorCode(err));
    if (miss) out = { status: miss };
    else {
      logger.debug(`[user-profile] lookup threw for ${userId.substring(0, 12)}: ${err instanceof Error ? err.message : err}`);
      out = { status: 'error' };
    }
  }
  if (out.status !== 'error') {
    if (userProfileCache.size >= USER_PROFILE_CACHE_MAX) userProfileCache.clear();
    userProfileCache.set(key, out.status === 'ok' ? out.profile : out.status);
  }
  return out;
}

/**
 * Best-effort 拉用户资料（名字 + 头像 URL）。拿不到（缺 scope / 不在可见
 * 范围 / 网络错误）返回 null，调用方自行回退占位。
 */
export async function getUserProfile(
  larkAppId: string,
  userId: string,
  idType: 'open_id' | 'union_id' = 'open_id',
): Promise<{ name: string; avatarUrl?: string } | null> {
  const r = await getUserProfileStrict(larkAppId, userId, idType);
  return r.status === 'ok' ? r.profile : null;
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

export async function sendUserMessage(
  larkAppId: string,
  openId: string,
  content: string,
  msgType: string = 'text',
  uuid?: string,
  requestOptions?: LarkRequestOptions,
): Promise<string> {
  assertLarkTransport(larkAppId, 'sendUserMessage');
  return executeWithLarkGate(
    larkAppId,
    'sendUserMessage',
    async () => {
      const c = getBotClient(larkAppId);
      // Stamp callback-button ownership markers on interactive DMs too: this is the
      // FIFTH card egress surface (config / write-link / substitute / overload / …
      // cards all DM their callback buttons through here). Without it a peer bot
      // reading such a DM via history flattens the buttons into its prompt, and —
      // worse — a future botmux DM button with a new action would leak past the
      // parser's legacy wordlist. Shared `body` feeds BOTH branches below (plain
      // create + deadline request), so one stamp covers both. Same total-function
      // contract as send/reply/ephemeral/update: any JSON anomaly returns unchanged.
      const body = msgType === 'text'
        ? JSON.stringify({ text: content })
        : msgType === 'interactive' ? stampBotmuxCallbackMarkers(content) : content;
      const data = {
        receive_id: openId,
        msg_type: msgType as any,
        content: body,
        ...(uuid ? { uuid } : {}),
      };

      const res = requestOptions
        ? await c.request({
          method: 'POST',
          url: '/open-apis/im/v1/messages',
          params: { receive_id_type: 'open_id' },
          data,
          ...larkRequestDeadline(requestOptions),
        })
        : await c.im.v1.message.create({
          params: { receive_id_type: 'open_id' },
          data,
        });

      if (res.code !== 0) {
        throw new Error(`Failed to send user message: ${res.msg} (code: ${res.code})`);
      }

      const messageId = res.data?.message_id;
      if (!messageId) throw new Error('No message_id in response');
      logger.info(`Sent DM ${messageId} to user ${openId}`);
      return messageId;
    },
    requestOptions?.signal ? { signal: requestOptions.signal } : undefined,
  );
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
 * suppress auto-start. For the same reason it also throws when the member list
 * exceeds the page cap (>2000 members) and is still `has_more`: a silently
 * truncated list would make members past the cap look like "not in the chat"
 * (wrong-answer fail-open), so a truncation is surfaced as an error instead.
 */
export async function listChatMemberOpenIds(larkAppId: string, chatId: string): Promise<string[]> {
  const c = getBotClient(larkAppId);
  const openIds: string[] = [];
  let pageToken: string | undefined;
  let truncated = false;
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
    // Hit the cap with more pages remaining → the list is incomplete. Fail
    // closed rather than return a truncated list (see docstring).
    if (page === 19) truncated = true;
  }
  if (truncated) {
    throw new Error(
      `Chat ${chatId} has more than 2000 members; member list truncated at the page cap. ` +
      `Refusing to return an incomplete list (would misjudge members past the cap as "not in chat").`,
    );
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
 * 获取入群自动开工所需的群上下文。群模式、群名和群描述来自同一次
 * chat.get，失败时保留 unavailable，避免把读取失败误判成字段为空。
 */
export async function getChatContext(larkAppId: string, chatId: string): Promise<ChatContext> {
  const unavailable: ChatContext = {
    chatId,
    name: null,
    description: null,
    mode: 'unknown',
    fetchStatus: 'unavailable',
  };
  try {
    const c = getBotClient(larkAppId);
    const res = await larkGet(c, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`);
    if (res.code !== 0) {
      logger.warn(`getChatContext(${chatId}) failed: ${res.msg} (code: ${res.code})`);
      return unavailable;
    }

    const rawMode = String(res.data?.chat_mode ?? '').toLowerCase();
    const rawGmt = String(res.data?.group_message_type ?? '').toLowerCase();
    let mode: ChatMode | 'unknown';
    if (rawMode === 'p2p') mode = 'p2p';
    else if (rawMode === 'topic' || rawGmt === 'thread') mode = 'topic';
    else if (rawMode === 'group') mode = 'group';
    else mode = 'unknown';

    if (mode !== 'unknown') {
      chatModeCache.set(`${larkAppId}::${chatId}`, { mode, cachedAt: Date.now() });
    } else {
      logger.warn(`getChatContext(${chatId}) unrecognized chat_mode='${rawMode}'`);
    }

    const name = String(res.data?.name ?? '').trim();
    const description = String(res.data?.description ?? '').trim();
    return {
      chatId,
      name: name || null,
      description: description || null,
      mode,
      fetchStatus: 'ok',
    };
  } catch (err: any) {
    logger.warn(`getChatContext(${chatId}) errored: ${err?.message ?? err}`);
    return unavailable;
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
  assertLarkTransport(larkAppId, 'deleteMessage');
  return executeWithLarkGate(larkAppId, 'deleteMessage', async () => {
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
  });
}

/**
 * Pin a message in a chat (best-effort QoL). Returns `true` only when Lark
 * explicitly confirms success (`code === 0`); any other outcome returns `false`
 * and must not affect session behavior.
 */
export async function pinMessage(larkAppId: string, messageId: string): Promise<boolean> {
  assertLarkTransport(larkAppId, 'pinMessage');
  const c = getBotClient(larkAppId);
  try {
    const res: any = await c.im.v1.pin.create({ data: { message_id: messageId } });
    if (res?.code !== 0) {
      logger.debug(`[pin:${larkAppId}] failed message=${messageId} code=${res?.code ?? 'missing'}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.debug(`[pin:${larkAppId}] failed message=${messageId}: ${formatLarkError(err) ?? (err instanceof Error ? err.message : 'unknown error')}`);
    return false;
  }
}

/**
 * Unpin a message in a chat (best-effort QoL). Returns `true` only when Lark
 * explicitly confirms success (`code === 0`); any other outcome returns `false`
 * and must not affect session behavior.
 */
export async function unpinMessage(larkAppId: string, messageId: string): Promise<boolean> {
  assertLarkTransport(larkAppId, 'unpinMessage');
  const c = getBotClient(larkAppId);
  try {
    const res: any = await c.im.v1.pin.delete({ path: { message_id: messageId } });
    if (res?.code !== 0) {
      logger.debug(`[unpin:${larkAppId}] failed message=${messageId} code=${res?.code ?? 'missing'}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.debug(`[unpin:${larkAppId}] failed message=${messageId}: ${formatLarkError(err) ?? (err instanceof Error ? err.message : 'unknown error')}`);
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
  assertLarkTransport(larkAppId, 'sendEphemeralCard');
  return executeWithLarkGate(larkAppId, 'sendEphemeralCard', async () => {
    const c = getBotClient(larkAppId);
    let card: unknown;
    try {
      card = JSON.parse(stampBotmuxCallbackMarkers(cardJson));
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
  });
}

/**
 * Delete a previously-sent ephemeral card (`ephemeral/v1/delete`). Ephemeral
 * cards CANNOT be PATCH-updated (see {@link sendEphemeralCard}), so the picker's
 * "in-place refresh" (page / search / select) is implemented as delete-then-
 * resend; this is the delete half. Best-effort: returns false on any failure
 * (already gone, network) rather than throwing — a stale ephemeral card lingering
 * is a cosmetic issue, not a correctness one, and the caller has already sent the
 * replacement by the time cleanup runs.
 */
export async function deleteEphemeralCard(larkAppId: string, messageId: string): Promise<boolean> {
  assertLarkTransport(larkAppId, 'deleteEphemeralCard');
  return executeWithLarkGate(larkAppId, 'deleteEphemeralCard', async () => {
    const c = getBotClient(larkAppId);
    try {
      const res: any = await (c as any).request({
        method: 'POST',
        url: '/open-apis/ephemeral/v1/delete',
        data: { message_id: messageId },
      });
      if (res && typeof res.code === 'number' && res.code !== 0) {
        logger.debug(`Delete ephemeral card ${messageId} returned non-zero code: ${res.code} ${res.msg ?? ''}`);
        return false;
      }
      return true;
    } catch (err) {
      logger.debug(`Failed to delete ephemeral card ${messageId}: ${err}`);
      return false;
    }
  });
}

export async function updateMessage(larkAppId: string, messageId: string, cardJson: string): Promise<void> {
  assertLarkTransport(larkAppId, 'updateMessage');
  return executeWithLarkGate(larkAppId, 'updateMessage', async () => {
    const c = getBotClient(larkAppId);
    let res: any;
    try {
      res = await c.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: stampBotmuxCallbackMarkers(cardJson) },
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
  });
}

export async function getMessageDetail(
  larkAppId: string,
  messageId: string,
  options: { userCardContent?: boolean } & LarkRequestOptions = {},
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
    // Opt into server-side sender names (sender_name / sender_i18n_names, for
    // user AND bot senders); without it the server omits them. Matters here for
    // merge_forward sub-messages, whose senders appear nowhere else.
    with_sender_name: 'true',
  }, options);
  if (res.code !== 0) {
    throw new Error(`Failed to get message: ${res.msg} (code: ${res.code})`);
  }
  return res.data;
}

export async function getMessageChatId(
  larkAppId: string,
  messageId: string,
  options?: LarkRequestOptions,
): Promise<string | null> {
  try {
    const detail = await getMessageDetail(larkAppId, messageId, {
      userCardContent: false,
      ...options,
    });
    const candidates = [
      detail?.items?.[0]?.chat_id,
      detail?.chat_id,
      detail?.message?.chat_id,
    ];
    for (const v of candidates) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  } catch (err) {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : err;
    }
    logger.debug(`[message] failed to resolve chat_id for ${messageId.substring(0, 12)}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Resolve the `omt_...` topic id for an `om_...` topic-root message. Topic
 *  routing itself keeps using the root message id; this helper is only for
 *  client AppLinks. */
export async function getMessageThreadId(
  larkAppId: string,
  messageId: string,
  options?: LarkRequestOptions,
): Promise<string | null> {
  try {
    const detail = await getMessageDetail(larkAppId, messageId, {
      userCardContent: false,
      ...options,
    });
    const candidates = [
      detail?.items?.[0]?.thread_id,
      detail?.thread_id,
      detail?.message?.thread_id,
    ];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  } catch (err) {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : err;
    }
    logger.debug(`[message] failed to resolve thread_id for ${messageId.substring(0, 12)}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export async function downloadMessageResource(larkAppId: string, messageId: string, fileKey: string, type: 'image' | 'file', savePath: string): Promise<void> {
  // apiOnly hard-gate BEFORE the app→user token fallback. Without this, the
  // App Token attempt (getBotClient) throws LarkTransportDisabledError, gets
  // caught below as a "failed app download", and silently falls through to the
  // raw user-token fetch — bypassing the boundary. A core-only bot has no
  // Feishu resource to download; refuse up front.
  assertLarkTransport(larkAppId, 'downloadMessageResource');
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
  assertLarkTransport(larkAppId, 'uploadImage');
  return executeWithLarkGate(larkAppId, 'uploadImage', async () => {
    const c = getBotUploadClient(larkAppId);
    const buf = readFileSync(imagePath);
    // SDK returns { image_key } directly (not wrapped in { code, data })
    const res = await c.im.v1.image.create({
      data: { image_type: 'message', image: buf },
    });
    const imageKey = res?.image_key;
    if (!imageKey) throw new Error(`Failed to upload image: no image_key in response (${JSON.stringify(res)})`);
    logger.info(`Uploaded image ${imagePath} → ${imageKey}`);
    return imageKey;
  });
}

export async function uploadFile(larkAppId: string, filePath: string, opts?: { duration?: number }): Promise<string> {
  assertLarkTransport(larkAppId, 'uploadFile');
  return executeWithLarkGate(larkAppId, 'uploadFile', async () => {
    const c = getBotUploadClient(larkAppId);
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
  });
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
/**
 * Per-raw-entry outcome of an allowedUsers resolve:
 *  - `resolved`   — turned into an ou_ this pass (or a literal ou_ kept as-is).
 *  - `transient`  — contact API transiently failed (throw / rate limit / 5xx);
 *                   a last-known-good cache MAY be reused for this entry.
 *  - `definitive` — id invalid / not visible / not found (DEFINITIVE codes) or
 *                   a code-0 batch that simply didn't return this email; the
 *                   entry is genuinely gone and MUST NOT be revived from cache.
 */
export type EntryResolveStatus = 'resolved' | 'transient' | 'definitive';

export async function resolveAllowedUsersWithMap(
  larkAppId: string, raw: string[],
): Promise<{ resolved: string[]; map: Map<string, string>; errored?: boolean; entryStatus: Map<string, EntryResolveStatus> }> {
  const map = new Map<string, string>();
  // True when a TRANSIENT failure (throw / rate limit / server error) hit any
  // requested item — the caller can then say "resolution failed, retry" instead
  // of the misleading "this identifier does not exist". Definitive failures
  // (id invalid / not visible: DEFINITIVE_CONTACT_ERROR_CODES) don't set it.
  let errored = false;
  // Per-raw-entry outcome so callers can fall back to a last-known-good cache
  // ONLY for entries that transient-failed AND are still configured — never for
  // definitively-removed users (revives ex-owners) or entries no longer in
  // config (revives a swapped-out owner). See allowed-users-apply.ts. Any entry
  // not explicitly set below stays absent → treated as 'definitive' (drop).
  const entryStatus = new Map<string, EntryResolveStatus>();
  const openIds: string[] = [];
  const emails: string[] = [];
  const unionIds: string[] = [];
  // Mobile entries: keep the raw config string as the map key (exact-match with
  // allowedUsers), but remember the normalized (spaces/dashes stripped) form to
  // send to the API. batch_get_id accepts `mobiles` under the same
  // contact:user.id:readonly scope as emails. Lets phone-registered users with
  // no corporate email be an owner.
  const mobiles: string[] = [];
  const mobileRawByNorm = new Map<string, string>();
  for (const v of raw) {
    if (v.startsWith('ou_')) {
      map.set(v, v);
      // Literal ou_ is app-scoped and kept as-is (never dropped, mirrors
      // pre-existing behavior); the diagnostic GET below does not change this.
      entryStatus.set(v, 'resolved');
      openIds.push(v);
    } else if (v.startsWith('on_')) {
      // union_id (跨应用稳定)：运行时权限/私信/卡片全是 open_id 原生的，
      // 启动时用本 app 凭证把 on_ 翻成本 app 的 ou_，下游一律照旧用 open_id。
      unionIds.push(v);
    } else if (isMobileEntry(v)) {
      const norm = normalizeMobileEntry(v);
      mobiles.push(norm);
      mobileRawByNorm.set(norm, v);
    } else {
      emails.push(v);
    }
  }

  if (emails.length > 0 || unionIds.length > 0 || openIds.length > 0 || mobiles.length > 0) {
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
          entryStatus.set(uid, 'resolved');
          logger.info(`Resolved ${uid} → ${oid}`);
        } else {
          // code-0 with no open_id is a DEFINITIVE miss (union user outside this
          // app's contact visibility → tenant returns an empty code-0 shell
          // rather than 41050), mirroring the email-batch not-in-list case above
          // and getUserProfileStrict's `code===0 ? 'not_visible'` rule. Bucketing
          // it 'transient' would (a) spin the never-converging retry/DM chain and
          // (b) revive a now-invisible owner from a stale cache. Only a non-zero
          // non-definitive code (network/5xx/rate-limit) is transient.
          const definitive = res?.code === 0 ? true : !!classifyContactErrorCode(res?.code);
          if (!definitive) errored = true;
          entryStatus.set(uid, definitive ? 'definitive' : 'transient');
          logger.warn(`Failed to resolve union_id ${uid} to open_id: ${res?.msg} (code: ${res?.code})`);
        }
      } catch (err: any) {
        const definitive = !!classifyContactErrorCode(getLarkErrorCode(err));
        if (!definitive) errored = true;
        entryStatus.set(uid, definitive ? 'definitive' : 'transient');
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
          // A non-zero batchGetId code is a WHOLE-REQUEST failure, not a
          // per-email identity verdict — even a permanent 4xx like 40001
          // (invalid argument) tells us nothing about whether any individual
          // owner still exists. Treating it as per-email definitive would
          // silently prune an email-only owner's last-known-good cache and
          // fail-closed lock them out. So mark every requested email TRANSIENT
          // (retry-eligible, cache-fallback-eligible). Only a code-0 response
          // that omits a specific email (below) is a per-entry definitive miss.
          errored = true;
          for (const rawEmail of emails) entryStatus.set(rawEmail, 'transient');
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
              entryStatus.set(rawEmail, 'resolved');
              logger.info(`Resolved ${rawEmail} → ${uid}`);
            } else {
              // Batch call itself succeeded (code 0) but this email is not in
              // the returned user_list → definitive miss (no such user / not
              // visible), NOT a transient failure. Do not fall back to cache.
              entryStatus.set(rawEmail, 'definitive');
            }
          }
        }
      } catch (err: any) {
        // A throw is a whole-request failure (network / timeout / 5xx / even a
        // thrown 4xx) — same reasoning as the non-zero-code branch above: it is
        // NOT a per-email identity verdict, so every requested email is
        // transient (retry + cache-fallback eligible), never definitive.
        errored = true;
        for (const rawEmail of emails) entryStatus.set(rawEmail, 'transient');
        logger.warn(`resolveAllowedUsers failed: ${err.message}`);
      }
    }

    if (mobiles.length > 0) {
      // Mirror the email branch exactly (same transient/definitive contract),
      // but over the `mobiles` field. Map keys are the RAW config entries (via
      // mobileRawByNorm) so exact-match with allowedUsers holds even though the
      // API is queried with the normalized number.
      try {
        const res = await (c as any).contact.v3.user.batchGetId({
          params: { user_id_type: 'open_id' },
          data: { mobiles, include_resigned: false },
        });
        if (res.code !== 0) {
          // Whole-request failure — not a per-mobile verdict. Mark every
          // requested mobile TRANSIENT so a real owner isn't fail-closed out.
          errored = true;
          for (const norm of mobiles) {
            const rawEntry = mobileRawByNorm.get(norm) ?? norm;
            entryStatus.set(rawEntry, 'transient');
          }
          logger.warn(`Failed to resolve mobiles to open_ids: ${res.msg} (code: ${res.code})`);
        } else {
          const userList: any[] = res.data?.user_list ?? [];
          // Index the API echo by a SINGLE canonical E.164 key. The API may echo
          // a mobile with or without the leading `+`, and Feishu does NOT promise
          // a byte-identical echo — canonicalMobileKey folds each number to one
          // stable key (trusting `+` as the country code; only a genuinely-bare
          // CN 11-digit number gets an 86 prefix). A single key per number, NOT a
          // key SET: a set that stripped `+` and then treated every leading-1
          // number as CN would collide a US `+1 3XX…` with a CN bare `13X…` and
          // bind the owner to the wrong person / evict a co-owner on overwrite.
          const byKey = new Map<string, string>();
          for (const item of userList) {
            if (item.user_id && item.mobile) {
              byKey.set(canonicalMobileKey(normalizeMobileEntry(String(item.mobile))), item.user_id);
            } else if (!item.user_id) {
              logger.warn(`Could not resolve mobile: ${item.mobile}`);
            }
          }
          for (const norm of mobiles) {
            const rawEntry = mobileRawByNorm.get(norm) ?? norm;
            // Match the requested number by its canonical key. Covers CN bare-11
            // ↔ +86 in both directions. If Feishu echoed an overseas number with
            // the `+` dropped it becomes a safe MISS (definitive → owner falls
            // back to email/union_id), never a cross-number mis-bind.
            const uid = byKey.get(canonicalMobileKey(norm));
            if (uid) {
              map.set(rawEntry, uid);
              entryStatus.set(rawEntry, 'resolved');
              logger.info(`Resolved ${rawEntry} → ${uid}`);
            } else {
              // code-0 but this mobile absent from user_list → definitive miss
              // (no such user / not visible), same as the email case.
              entryStatus.set(rawEntry, 'definitive');
            }
          }
        }
      } catch (err: any) {
        errored = true;
        for (const norm of mobiles) {
          const rawEntry = mobileRawByNorm.get(norm) ?? norm;
          entryStatus.set(rawEntry, 'transient');
        }
        logger.warn(`resolveAllowedUsers (mobiles) failed: ${err.message}`);
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
  return { resolved, map, errored, entryStatus };
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

function wantsUnlimitedMessages(pageSize: number): boolean {
  return pageSize <= 0 || !Number.isFinite(pageSize);
}

/** List thread-container messages, most-recent first but returned chronologically
 *  (oldest → newest, capped at `pageSize`). Fast path for `botmux history` in a
 *  topic session — same contract as `listChatMessages` below, and for the same
 *  reason: the caller asked for `pageSize` messages of *context*, which is the
 *  tail of the thread, not its head. A thread that has outgrown `pageSize` used
 *  to come back as its oldest N here while the chat-scope sibling returned its
 *  newest N — and the two ends are indistinguishable downstream, because both
 *  are N real messages in chronological order. */
async function listByThread(c: any, threadId: string, pageSize: number): Promise<any[]> {
  const allMessages: any[] = [];
  let pageToken: string | undefined;
  const unlimited = wantsUnlimitedMessages(pageSize);

  do {
    const res = await larkGet(c, '/open-apis/im/v1/messages', {
      container_id_type: 'thread',
      container_id: threadId,
      page_size: unlimited ? LARK_MESSAGE_LIST_MAX_PAGE : Math.min(pageSize, LARK_MESSAGE_LIST_MAX_PAGE),
      // Page in Desc order so a long thread yields its TAIL; reversed below.
      sort_type: 'ByCreateTimeDesc',
      with_sender_name: 'true',
      ...(pageToken ? { page_token: pageToken } : {}),
    });

    if (res.code !== 0) {
      throw new Error(`Failed to list thread messages: ${res.msg} (code: ${res.code})`);
    }

    if (res.data?.items) {
      allMessages.push(...res.data.items);
    }

    pageToken = res.data?.page_token;
    if (!unlimited && allMessages.length >= pageSize) break;
  } while (pageToken);

  // Cap to pageSize newest, then reverse to chronological for the caller.
  return (unlimited ? allMessages : allMessages.slice(0, pageSize)).reverse();
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
  const unlimited = wantsUnlimitedMessages(pageSize);

  do {
    const res = await larkGet(c, '/open-apis/im/v1/messages', {
      container_id_type: 'chat',
      container_id: chatId,
      page_size: unlimited ? LARK_MESSAGE_LIST_MAX_PAGE : Math.min(pageSize, LARK_MESSAGE_LIST_MAX_PAGE),
      sort_type: 'ByCreateTimeDesc',
      with_sender_name: 'true',
      ...(pageToken ? { page_token: pageToken } : {}),
    });

    if (res.code !== 0) {
      throw new Error(`Failed to list chat messages: ${res.msg} (code: ${res.code})`);
    }

    if (res.data?.items) {
      allMessages.push(...res.data.items);
    }

    pageToken = res.data?.page_token;
    if (!unlimited && allMessages.length >= pageSize) break;
  } while (pageToken);

  // Cap to pageSize newest, then reverse to chronological for the caller.
  return (unlimited ? allMessages : allMessages.slice(0, pageSize)).reverse();
}

export interface ChatMessageScanOptions {
  /** Lark page size per request. Clamped to the API max of 50. */
  pageSize?: number;
  /**
   * Called while scanning newest -> oldest. Returning true stops after the
   * current message has been included in the returned chronological list.
   */
  stopAfter?: (message: any, seenCount: number) => boolean;
}

/** Scan chat-container messages newest -> oldest until the caller's stop
 * condition is met, then return the scanned window chronologically. */
export async function listChatMessagesUntil(
  larkAppId: string,
  chatId: string,
  options: ChatMessageScanOptions = {},
): Promise<any[]> {
  const c = getBotClient(larkAppId);
  const allMessages: any[] = [];
  let pageToken: string | undefined;
  const rawPageSize = Number.isFinite(options.pageSize) ? Math.floor(options.pageSize as number) : LARK_MESSAGE_LIST_MAX_PAGE;
  const pageSize = Math.min(Math.max(rawPageSize, 1), LARK_MESSAGE_LIST_MAX_PAGE);

  do {
    const res = await larkGet(c, '/open-apis/im/v1/messages', {
      container_id_type: 'chat',
      container_id: chatId,
      page_size: pageSize,
      sort_type: 'ByCreateTimeDesc',
      with_sender_name: 'true',
      ...(pageToken ? { page_token: pageToken } : {}),
    });

    if (res.code !== 0) {
      throw new Error(`Failed to list chat messages: ${res.msg} (code: ${res.code})`);
    }

    const items = res.data?.items ?? [];
    for (const item of items) {
      allMessages.push(item);
      if (options.stopAfter?.(item, allMessages.length)) {
        return allMessages.reverse();
      }
    }

    pageToken = res.data?.page_token;
  } while (pageToken);

  return allMessages.reverse();
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
  const unlimited = wantsUnlimitedMessages(pageSize);

  do {
    const res = await larkGet(c, '/open-apis/im/v1/messages', {
      container_id_type: 'chat',
      container_id: chatId,
      page_size: unlimited ? LARK_MESSAGE_LIST_MAX_PAGE : Math.min(pageSize, LARK_MESSAGE_LIST_MAX_PAGE),
      sort_type: 'ByCreateTimeDesc',
      with_sender_name: 'true',
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
    if (!unlimited && allMessages.length >= pageSize) break;
  } while (pageToken);

  allMessages.sort((a, b) => (a.create_time ?? '').localeCompare(b.create_time ?? ''));
  // Take the TAIL, matching `listByThread` above and the chat-scope sibling.
  // The loop above pages in Desc order and breaks on `>= pageSize`, so a single
  // 50-item page can overshoot: what we hold is the newest N+k. After the
  // ascending sort, `slice(0, pageSize)` would hand back the OLDEST N of those
  // — i.e. silently drop the newest k, which is exactly the end the caller
  // asked for. `limit > 50` always pages, and the dashboard history popover
  // defaults to 80 (`src/core/dashboard-ipc-server.ts`), so this is the common
  // path, not a corner.
  //
  // ⚠️ `Math.max(0, …)` is load-bearing, not defensive dressing: when fewer
  // than `pageSize` messages were collected — a thread shorter than the limit,
  // which is the NORMAL case — `allMessages.length - pageSize` is negative and
  // `slice(negative)` counts from the end, dropping the OLDEST messages
  // instead. Without the guard this trades a rare bug for a common one.
  // Same idiom as `filterAmbientChatMessages` above.
  return unlimited ? allMessages : allMessages.slice(Math.max(0, allMessages.length - pageSize));
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

type ChatBotListApiItem = { botId: string; botName: string };
type ChatBotListApiResult =
  | { ok: true; items: ChatBotListApiItem[] }
  | { ok: false; reason: string; cacheable: boolean };

/**
 * A bot row returned directly by Feishu's live `/members/bots` endpoint.
 * Unlike {@link ChatBotMember}, this type deliberately carries no botmux-local
 * identity/provenance: `openId` is exactly the observer-scoped handle returned
 * to `larkAppId` for the current chat.
 */
export type CurrentChatBotMember = {
  openId: string;
  displayName: string;
};

/**
 * A stable configured app identity bound to the receiver-scoped open_id that
 * Feishu returned for that bot in the current chat.
 */
export type CurrentChatBotAppMapping = {
  larkAppId: string;
  subjectOpenId: string;
};

export type CurrentChatBotAppResolution =
  | { ok: true; mappings: CurrentChatBotAppMapping[] }
  | {
      ok: false;
      error:
        | 'live_membership_unavailable'
        | 'subject_lark_app_not_configured'
        | 'subject_lark_app_name_unavailable'
        | 'subject_lark_app_not_in_chat'
        | 'subject_lark_app_ambiguous';
      message: string;
      invalidSubjectLarkAppIds?: string[];
    };
export type ChatBotMembershipSnapshot =
  | { known: true; members: Array<{ openId: string; name: string }> }
  | { known: false; members: []; reason: string };

function promiseWithTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return p;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function listChatBotsViaMembersBots(
  larkAppId: string,
  chatId: string,
  timeoutMs: number,
): Promise<ChatBotListApiResult> {
  try {
    const c = getBotClient(larkAppId);
    const items: ChatBotListApiItem[] = [];
    let pageToken = '';
    for (let page = 0; page < 100; page++) {
      const res = await promiseWithTimeout(
        larkGet(c, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/bots`, {
          page_size: 100,
          page_token: pageToken || undefined,
        }),
        timeoutMs,
        'list chat bot members',
      );
      if (res?.code !== 0) return { ok: false, reason: `code=${res?.code ?? 'unknown'} msg=${res?.msg ?? ''}`, cacheable: false };
      const rawItems = res?.data?.items;
      if (!Array.isArray(rawItems)) return { ok: false, reason: 'invalid_items', cacheable: true };
      items.push(...rawItems
        .map((it: any) => ({
          botId: String(it?.bot_id ?? '').trim(),
          botName: String(it?.bot_name ?? '').trim(),
        }))
        // bot_id is the membership fact. A temporarily missing display name must
        // not turn a real member into a hard "not in chat" false negative.
        .filter((it: ChatBotListApiItem) => !!it.botId));

      if (!res?.data?.has_more) return { ok: true, items };
      const nextToken = String(res?.data?.page_token ?? '').trim();
      if (!nextToken || nextToken === pageToken) {
        return { ok: false, reason: 'invalid_pagination', cacheable: true };
      }
      pageToken = nextToken;
    }
    return { ok: false, reason: 'pagination_limit', cacheable: true };
  } catch (err: any) {
    return { ok: false, reason: err?.message ?? String(err), cacheable: true };
  }
}

/**
 * Read the current chat's bot members from Feishu and fail closed on any API
 * error. This is the authorization-grade counterpart to
 * {@link listChatBotMembers}: it NEVER consults the 30-day observed/cross-ref
 * fallback and NEVER treats a cached capability failure as membership truth.
 *
 * Keep this separate from the user-facing discovery helper. `/members/bots`
 * is still an undocumented endpoint, so discovery may degrade gracefully; a
 * permission mutation must not.
 */
export async function listCurrentChatBotMembers(
  larkAppId: string,
  chatId: string,
): Promise<CurrentChatBotMember[]> {
  const timeoutMs = config.chatBotDiscovery?.listBotsApiTimeoutMs ?? 3_000;
  const result = await listChatBotsViaMembersBots(larkAppId, chatId, timeoutMs);
  if (!result.ok) {
    throw new Error(`live_chat_bot_members_unavailable: ${result.reason}`);
  }
  return result.items.map(item => ({ openId: item.botId, displayName: item.botName }));
}

/**
 * Resolve stable configured Lark app ids to the receiver-scoped open_ids that
 * may be written to the receiver's exact chatGrant.
 *
 * This is deliberately stricter than bot discovery. Identity is accepted only
 * when all three current signals agree: the receiver's live `/members/bots`
 * row, the subject app's own `is_in_chat` result, and one exact, unique
 * `bot_name` binding from bots-info.json. Cross-reference and observed-bot
 * stores are never consulted, because either can be stale or scoped to another
 * app.
 */
export async function resolveCurrentChatBotOpenIdsByLarkAppIds(
  receiverLarkAppId: string,
  chatId: string,
  subjectLarkAppIds: string[],
): Promise<CurrentChatBotAppResolution> {
  const timeoutMs = config.chatBotDiscovery?.listBotsApiTimeoutMs ?? 3_000;
  const live = await listChatBotsViaMembersBots(receiverLarkAppId, chatId, timeoutMs);
  if (!live.ok) {
    return {
      ok: false,
      error: 'live_membership_unavailable',
      message: `live_chat_bot_members_unavailable: ${live.reason}`,
    };
  }

  const configured = getAllBotClients({ refresh: true });
  const configuredByAppId = new Map(configured.map(entry => [entry.appId, entry]));
  const namesByAppId = new Map<string, string[]>();
  try {
    const raw = JSON.parse(readFileSync(join(config.session.dataDir, 'bots-info.json'), 'utf-8'));
    if (!Array.isArray(raw)) throw new Error('bots-info.json must contain an array');
    for (const entry of raw) {
      const appId = typeof entry?.larkAppId === 'string' ? entry.larkAppId.trim() : '';
      const botName = typeof entry?.botName === 'string' ? entry.botName.trim() : '';
      if (!appId || !botName) continue;
      const names = namesByAppId.get(appId);
      if (names) names.push(botName);
      else namesByAppId.set(appId, [botName]);
    }
  } catch (err: any) {
    return {
      ok: false,
      error: 'subject_lark_app_name_unavailable',
      message: `Unable to read a strict bot_name binding: ${err?.message ?? String(err)}`,
      invalidSubjectLarkAppIds: subjectLarkAppIds,
    };
  }

  const subjectNames = new Map<string, string>();
  for (const subjectLarkAppId of subjectLarkAppIds) {
    if (!configuredByAppId.has(subjectLarkAppId)) {
      return {
        ok: false,
        error: 'subject_lark_app_not_configured',
        message: 'Every subject app must be configured in this botmux runtime',
        invalidSubjectLarkAppIds: [subjectLarkAppId],
      };
    }
    const names = namesByAppId.get(subjectLarkAppId) ?? [];
    if (names.length !== 1) {
      return {
        ok: false,
        error: names.length === 0 ? 'subject_lark_app_name_unavailable' : 'subject_lark_app_ambiguous',
        message: names.length === 0
          ? 'Every subject app must have one non-empty bot_name in bots-info.json'
          : 'A subject app has multiple bot_name bindings in bots-info.json',
        invalidSubjectLarkAppIds: [subjectLarkAppId],
      };
    }
    subjectNames.set(subjectLarkAppId, names[0]);
  }

  // If multiple configured apps claim the requested name, probe every claimant.
  // A strict name is safe only when exactly one claimant is currently in chat
  // and it is the requested subject app.
  const candidateAppIds = new Set<string>();
  const requestedNames = new Set(subjectNames.values());
  for (const entry of configured) {
    const names = namesByAppId.get(entry.appId) ?? [];
    if (names.length === 1 && requestedNames.has(names[0])) candidateAppIds.add(entry.appId);
  }

  const inChatByAppId = new Map<string, boolean>();
  for (const appId of candidateAppIds) {
    const entry = configuredByAppId.get(appId)!;
    try {
      const res = await promiseWithTimeout(
        larkGet(entry.client, `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/is_in_chat`),
        timeoutMs,
        `is_in_chat for ${appId}`,
      );
      if (res?.code !== 0 || typeof res?.data?.is_in_chat !== 'boolean') {
        return {
          ok: false,
          error: 'live_membership_unavailable',
          message: `is_in_chat failed for ${appId}: code=${res?.code ?? 'unknown'} msg=${res?.msg ?? ''}`,
          invalidSubjectLarkAppIds: subjectLarkAppIds.includes(appId) ? [appId] : undefined,
        };
      }
      inChatByAppId.set(appId, res.data.is_in_chat);
    } catch (err: any) {
      return {
        ok: false,
        error: 'live_membership_unavailable',
        message: `is_in_chat failed for ${appId}: ${err?.message ?? String(err)}`,
        invalidSubjectLarkAppIds: subjectLarkAppIds.includes(appId) ? [appId] : undefined,
      };
    }
  }

  const mappings: CurrentChatBotAppMapping[] = [];
  const mappedOpenIds = new Set<string>();
  for (const subjectLarkAppId of subjectLarkAppIds) {
    const botName = subjectNames.get(subjectLarkAppId)!;
    if (inChatByAppId.get(subjectLarkAppId) !== true) {
      return {
        ok: false,
        error: 'subject_lark_app_not_in_chat',
        message: 'Every subject app must independently confirm it is in the current chat',
        invalidSubjectLarkAppIds: [subjectLarkAppId],
      };
    }
    const configuredInChatWithName = configured.filter(entry => {
      const names = namesByAppId.get(entry.appId) ?? [];
      return names.length === 1 && names[0] === botName && inChatByAppId.get(entry.appId) === true;
    });
    const liveRows = live.items.filter(item => item.botName === botName);
    if (
      configuredInChatWithName.length !== 1
      || configuredInChatWithName[0].appId !== subjectLarkAppId
      || liveRows.length !== 1
      || mappedOpenIds.has(liveRows[0]?.botId)
    ) {
      return {
        ok: false,
        error: 'subject_lark_app_ambiguous',
        message: 'Stable app identity did not bind to exactly one live bot_name row',
        invalidSubjectLarkAppIds: [subjectLarkAppId],
      };
    }
    mappings.push({ larkAppId: subjectLarkAppId, subjectOpenId: liveRows[0].botId });
    mappedOpenIds.add(liveRows[0].botId);
  }

  return { ok: true, mappings };
}

/**
 * A resolved same-deployment sibling identity: the receiver-scoped open_id
 * `senderOpenId`, proven to belong to a locally-configured bot whose stable
 * `larkAppId` and unique `botName` are returned so the caller can persist the
 * receiver's cross-ref (botName → receiver-scoped open_id).
 */
export type SiblingBotResolution =
  | { ok: true; larkAppId: string; botName: string; senderOpenId: string }
  | { ok: false; reason: string };

/**
 * Resolve a foreign-bot SENDER open_id (receiver-scoped) to a same-deployment
 * sibling, using only live authorization-grade signals — never the possibly
 * stale/uninitialized cross-ref or observed stores. This closes the cold-start
 * window where a same-machine sibling @s a receiver whose cross-ref has not yet
 * learned that sibling's receiver-scoped open_id (Lark open_id is per-app).
 *
 * Identity is accepted only when all signals agree, mirroring
 * {@link resolveCurrentChatBotOpenIdsByLarkAppIds}:
 *  1. the receiver's live `/members/bots` row carries `bot_id === senderOpenId`;
 *  2. exactly one locally-configured bot (other than the receiver) has that
 *     exact `bot_name` in bots-info.json — a unique name binding;
 *  3. that candidate app independently confirms `is_in_chat` and binds to
 *     exactly one live row for its name (the strict resolver's own re-check).
 *
 * Fails closed (returns `{ ok: false }`) on any API error, ambiguity, or name
 * collision, so the caller falls back to the `/grant` request card. Never
 * authorizes a genuine external bot: an external sender's open_id has no
 * locally-configured app of the same unique name, so step 2 fails.
 */
export async function resolveSiblingBotBySenderOpenId(
  receiverLarkAppId: string,
  chatId: string,
  senderOpenId: string | undefined,
): Promise<SiblingBotResolution> {
  if (!senderOpenId) return { ok: false, reason: 'no_sender_open_id' };

  const timeoutMs = config.chatBotDiscovery?.listBotsApiTimeoutMs ?? 3_000;
  const live = await listChatBotsViaMembersBots(receiverLarkAppId, chatId, timeoutMs);
  if (!live.ok) return { ok: false, reason: `live_membership_unavailable: ${live.reason}` };

  // 1. The sender must appear in the receiver's live bot roster by open_id.
  const liveRow = live.items.find(item => item.botId === senderOpenId);
  if (!liveRow) return { ok: false, reason: 'sender_not_in_live_roster' };
  const botName = liveRow.botName;

  // 2. Exactly one locally-configured sibling (≠ receiver) must claim that
  //    exact name. Read the controlled config fresh — a sibling appended after
  //    this process started must still be recognized (auth boundary).
  let candidateAppIds: string[] = [];
  try {
    const raw = JSON.parse(readFileSync(join(config.session.dataDir, 'bots-info.json'), 'utf-8'));
    if (!Array.isArray(raw)) throw new Error('bots-info.json must contain an array');
    const namesByAppId = new Map<string, string[]>();
    for (const entry of raw) {
      const appId = typeof entry?.larkAppId === 'string' ? entry.larkAppId.trim() : '';
      const name = typeof entry?.botName === 'string' ? entry.botName.trim() : '';
      if (!appId || !name) continue;
      const names = namesByAppId.get(appId);
      if (names) names.push(name);
      else namesByAppId.set(appId, [name]);
    }
    for (const [appId, names] of namesByAppId) {
      if (appId === receiverLarkAppId) continue;
      // Require a unique name binding for the app — an app with multiple names
      // is ambiguous and must not shortcut vetting.
      if (names.length === 1 && names[0] === botName) candidateAppIds.push(appId);
    }
  } catch (err: any) {
    return { ok: false, reason: `bots_info_unavailable: ${err?.message ?? String(err)}` };
  }
  if (candidateAppIds.length !== 1) {
    return { ok: false, reason: candidateAppIds.length === 0 ? 'no_sibling_with_name' : 'ambiguous_sibling_name' };
  }
  const candidateAppId = candidateAppIds[0];

  // 3. Delegate the strict re-check (is_in_chat + unique name + unique live
  //    row) to the auth-grade resolver, then require it to bind back to exactly
  //    the sender's open_id.
  const resolved = await resolveCurrentChatBotOpenIdsByLarkAppIds(receiverLarkAppId, chatId, [candidateAppId]);
  if (!resolved.ok) return { ok: false, reason: `strict_resolve_failed: ${resolved.error}` };
  const mapping = resolved.mappings.find(m => m.larkAppId === candidateAppId);
  if (!mapping || mapping.subjectOpenId !== senderOpenId) {
    return { ok: false, reason: 'strict_resolve_open_id_mismatch' };
  }

  return { ok: true, larkAppId: candidateAppId, botName, senderOpenId };
}

/**
 * Authoritative, observer-scoped membership probe for dispatch readiness.
 * Unlike listChatBotMembers(), this does not silently fall back to learned or
 * configured rows: callers must know whether absence is a real fact or merely
 * an unavailable OpenAPI. Unknown is therefore explicit and must not block.
 */
export async function probeChatBotMembership(
  larkAppId: string,
  chatId: string,
  timeoutMs: number = config.chatBotDiscovery.listBotsApiTimeoutMs,
): Promise<ChatBotMembershipSnapshot> {
  const result = await listChatBotsViaMembersBots(larkAppId, chatId, timeoutMs);
  if (!result.ok) return { known: false, members: [], reason: result.reason };
  return {
    known: true,
    members: result.items.map((item) => ({ openId: item.botId, name: item.botName })),
  };
}

// `/members/bots` returns the observer-scoped mention handle (`bot_id`) and
// display name only. Bind botmux identity only when a configured bot has already
// been proven to be in this chat and the name match is unique, OR the item's
// observer-scoped `bot_id` equals a configured row's already-reliable open_id —
// notably the observer's own bot, whose `/members/bots` `bot_id` IS its self-view
// open_id. The open_id key guards against display-name drift between
// `/members/bots` and bots-info.json (e.g. self leaking into <available_bots> as
// a mentionable peer when its name no longer matches).
function buildChatBotsFromMembersBotsApi(
  items: ChatBotListApiItem[],
  currentLarkAppId: string,
  configured: ChatBotMember[],
  crossRef: Map<string, string>,
  norm: (s: string) => string,
): ChatBotMember[] {
  const configuredByName = new Map<string, ChatBotMember[]>();
  const configuredByOpenId = new Map<string, ChatBotMember>();
  for (const row of configured) {
    const key = norm(row.displayName);
    const arr = configuredByName.get(key);
    if (arr) arr.push(row);
    else configuredByName.set(key, [row]);
    if (row.openId) configuredByOpenId.set(row.openId, row);
  }

  const out: ChatBotMember[] = [];
  const seenOpenIds = new Set<string>();
  for (const item of items) {
    if (seenOpenIds.has(item.botId)) continue;
    const key = norm(item.botName);
    const matches = configuredByName.get(key) ?? [];
    const bound = (matches.length === 1 ? matches[0] : undefined) ?? configuredByOpenId.get(item.botId);
    const crossHit = crossRef.get(key);
    const isSelf = bound?.larkAppId === currentLarkAppId;
    const mentionSource: ChatBotMember['mentionSource'] = crossHit === item.botId
      ? 'cross-ref'
      : (isSelf ? 'self' : 'observed');

    out.push({
      larkAppId: bound?.larkAppId ?? '',
      openId: item.botId,
      name: bound?.name ?? item.botName,
      displayName: item.botName,
      source: bound ? 'configured' : 'introduce',
      capability: bound?.capability,
      hasTeamRole: bound?.hasTeamRole ?? false,
      mentionable: true,
      mentionSource,
    });
    seenOpenIds.add(item.botId);
  }
  return out;
}

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
        logger.debug(`isInChat check failed for ${appId}: ${formatLarkError(err) ?? err}`);
      }
      return null;
    }),
  );
  const configured: ChatBotMember[] = configuredResults.filter((r): r is ChatBotMember => r !== null);

  const discovery = config.chatBotDiscovery;
  if (discovery?.listBotsApiEnabled) {
    const failureKey = larkAppId;
    const cachedFailure = listBotsApiFailures.get(failureKey);
    const now = Date.now();
    if (cachedFailure && cachedFailure.expiresAt > now) {
      logger.debug(`members/bots disabled by recent failure for ${larkAppId}: ${cachedFailure.reason}`);
    } else {
      if (cachedFailure) listBotsApiFailures.delete(failureKey);
      const apiResult = await listChatBotsViaMembersBots(larkAppId, chatId, discovery.listBotsApiTimeoutMs);
      if (apiResult.ok) {
        listBotsApiFailures.delete(failureKey);
        return buildChatBotsFromMembersBotsApi(apiResult.items, larkAppId, configured, crossRef, norm);
      }
      if (apiResult.cacheable) {
        listBotsApiFailures.set(failureKey, { reason: apiResult.reason, expiresAt: now + LIST_BOTS_API_FAILURE_TTL_MS });
      }
      logger.warn(`members/bots failed for ${larkAppId} in ${chatId}; falling back to legacy bot discovery: ${apiResult.reason}`);
    }
  }

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
