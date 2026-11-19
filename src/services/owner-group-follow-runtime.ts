import { getBot, getBotClient, getOwnerOpenId } from '../bot-registry.js';
import { platformIncrementalAuthorizeUrl, resolveBoundLarkUserCredential } from '../core/lark-tool-platform-credential.js';
import { platformAuthorizeUrl } from '../core/platform-credential-source.js';
import { askPlatformToAuthorize } from '../core/platform-authorization-request.js';
import { hasReason, NOT_AUTHORIZED_REASONS } from '../core/refusal-reasons.js';
import { larkGet } from '../im/lark/lark-get.js';
import { chatAppLink, larkHosts, normalizeBrand } from '../im/lark/lark-hosts.js';
import { sendUserMessage } from '../im/lark/client.js';
import { resolveUserToken } from '../utils/user-token.js';
import { logger } from '../utils/logger.js';
import { createOwnerGroupFollower, OwnerGroupFollowError } from './owner-group-follow.js';

const AUTH_CODES = new Set([99991661, 99991663, 99991664, 99991668, 99991672, 99991677, 99991679]);
const FOLLOW_SCOPES = ['im:chat:read', 'im:chat.members:write_only', 'offline_access'] as const;

function apiData(json: any, status = 200): any {
  if (status >= 200 && status < 300 && json?.code === 0) return json.data;
  if (status >= 200 && status < 300 && !Number.isFinite(json?.code)) {
    // Valid JSON is not necessarily a valid Feishu envelope. A malformed 2xx
    // response is just as unknown as an unparseable success body, not a
    // permanent business failure.
    throw new Error('owner group follow malformed API response');
  }
  const authorization = status === 401 || status === 403 || AUTH_CODES.has(json?.code);
  throw new OwnerGroupFollowError(authorization || status === 429 || status >= 500
    || json?.code === 99991400 || json?.code === 232019, authorization,
    json?.code === 99991672 ? { authorizationRequired: true } : undefined);
}

function normalizeTransportError(error: unknown): unknown {
  if (error instanceof OwnerGroupFollowError) return error;
  const response = (error as any)?.response;
  if (typeof response?.status === 'number') {
    try { apiData(response.data, response.status); }
    catch (normalized) { return normalized; }
  }
  return error;
}

/** Bound pagination: never return a partial snapshot to the diff engine. */
export async function listOwnerFollowChats(
  page: (cursor?: string) => Promise<any>,
): Promise<string[]> {
  const chats = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const data = apiData(await page(cursor));
    if (!data || !Array.isArray(data.items)) throw new OwnerGroupFollowError(true);
    for (const item of data.items) {
      if (typeof item.chat_id !== 'string' || !/^oc_[A-Za-z0-9_-]+$/.test(item.chat_id)) throw new OwnerGroupFollowError(true);
      // The listing retains dissolved groups for chat history; member APIs
      // reject them, so they must never become invitation candidates.
      if (item.chat_type !== 'p2p' && item.chat_status !== 'dissolved' && item.chat_status !== 'dissolved_save') chats.add(item.chat_id);
    }
    if (data.has_more === false) return [...chats];
    if (data.has_more !== true || typeof data.page_token !== 'string'
        || !data.page_token || cursors.has(data.page_token)) throw new OwnerGroupFollowError(true);
    cursor = data.page_token;
    cursors.add(data.page_token);
  }
  throw new OwnerGroupFollowError(true);
}

export async function callOwnerFollowApi(
  host: string, token: string, path: string, signal: AbortSignal, body?: unknown,
): Promise<any> {
  const response = await fetch(`${host}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await (async () => {
    try { return await response.json(); }
    catch (error) {
      // Preserve HTTP authorization/retry classification for HTML or empty
      // gateway errors. A malformed success body stays an unknown outcome.
      if (response.status < 200 || response.status >= 300) apiData(undefined, response.status);
      throw error;
    }
  })();
  apiData(json, response.status);
  return json;
}

/** A daemon-owned personal feature, independent of any CLI turn or credential env. */
export function startOwnerGroupFollow(appId: string, dataDir: string): { stop(): void } {
  let stopped = false;
  let authorizationSource: 'platform' | 'bot' = 'bot';
  const userApi: typeof callOwnerFollowApi = async (...args) => {
    try { return await callOwnerFollowApi(...args); }
    catch (error) {
      if (authorizationSource === 'platform' && error instanceof OwnerGroupFollowError && error.authorization) {
        throw new OwnerGroupFollowError(true, true, {
          authorizationSource: 'platform', authorizeUrl: platformAuthorizeUrl() ?? undefined,
          authorizationRequired: error.issue?.authorizationRequired,
          guidance: '中心化平台的用户授权或应用权限无法完成群操作，请在平台核对群列表和成员邀请权限。',
        });
      }
      throw error;
    }
  };
  const follower = createOwnerGroupFollower({
    appId, dataDir,
    context: () => {
      const cfg = getBot(appId).config;
      return { ownerOpenId: getOwnerOpenId(appId), brand: normalizeBrand(cfg.brand), config: cfg.apiOnly ? undefined : cfg.ownerGroupFollow };
    },
    token: async (ownerOpenId, signal) => {
      const cfg = getBot(appId).config;
      signal.throwIfAborted();
      const result = await resolveBoundLarkUserCredential({
        bot: cfg, openId: ownerOpenId, delegated: false,
        // An explicit bot setting authorizes this background feature. These
        // identifiers are for platform audit, never a fabricated user turn.
        sessionId: `owner-group-follow:${appId}`,
        botAppToken: id => resolveUserToken(appId, cfg.larkAppSecret, normalizeBrand(cfg.brand), id, signal),
      });
      signal.throwIfAborted();
      if (!result.ok && result.reason === 'platform') {
        throw new OwnerGroupFollowError(true, true, {
          authorizationSource: 'platform', authorizeUrl: result.authorizeUrl, guidance: result.error,
          authorizationRequired: hasReason(result.error, NOT_AUTHORIZED_REASONS),
        });
      }
      if (!result.ok) return null;
      authorizationSource = result.issuer === 'platform' ? 'platform' : 'bot';
      return result.credential;
    },
    listChats: (token, signal) => {
      const host = larkHosts(normalizeBrand(getBot(appId).config.brand)).openApi;
      return listOwnerFollowChats(cursor => {
        const params = new URLSearchParams({ page_size: '100', ...(cursor ? { page_token: cursor } : {}) });
        return userApi(host, token, `/open-apis/im/v1/chats?${params}`, signal);
      });
    },
    listBotChats: async signal => {
      try {
        return await listOwnerFollowChats(cursor => larkGet(getBotClient(appId), '/open-apis/im/v1/chats',
          { page_size: 100, ...(cursor ? { page_token: cursor } : {}) }, { signal, timeoutMs: 15_000 }));
      } catch (error) {
        const normalized = normalizeTransportError(error);
        if (normalized instanceof OwnerGroupFollowError && normalized.authorization) {
          throw new OwnerGroupFollowError(true, true, {
            authorizationSource: 'bot', guidance: '机器人应用无法读取自己所在的群列表，自动跟随暂时暂停。请检查应用的群列表读取权限；重新授权你的用户身份不能修复这项应用权限。',
          });
        }
        throw normalized;
      }
    },
    invite: async (chatId, token, signal) => {
      const host = larkHosts(normalizeBrand(getBot(appId).config.brand)).openApi;
      const json = await userApi(host, token,
        `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?member_id_type=app_id&succeed_type=2`,
        signal, { id_list: [appId] });
      if (json.data?.invalid_id_list?.length || json.data?.not_existed_id_list?.length) throw new OwnerGroupFollowError(false);
      if (json.data?.pending_approval_id_list?.length) throw new OwnerGroupFollowError(false, false, { pendingApproval: true });
    },
    notify: async (ownerOpenId, chatId, issue, current) => {
      const cfg = getBot(appId).config;
      const currentOwner = () => !stopped && current() && getOwnerOpenId(appId) === ownerOpenId
        && getBot(appId).config.ownerGroupFollow?.enabled === true && !getBot(appId).config.apiOnly;
      if (!currentOwner()) return;
      let platformNotice: string | undefined;
      if (issue?.authorizationSource === 'platform' && issue.authorizationRequired) {
        const requested = await askPlatformToAuthorize({ botConfig: cfg, openId: ownerOpenId, scopes: FOLLOW_SCOPES });
        if (!currentOwner()) return;
        switch (requested.kind) {
          case 'sent': platformNotice = '自动跟随需要你的群操作授权。平台已私聊发送授权卡片，请在卡片中完成授权，后台会在下一次检查时继续。'; break;
          case 'ready': platformNotice = '平台确认你的授权已可用，自动跟随会在下一次检查时继续。'; break;
          case 'legacy': {
            const page = issue.authorizeUrl ?? platformAuthorizeUrl();
            platformNotice = page
              ? `当前平台使用旧授权接口，请打开授权入口补齐群操作授权：\n${platformIncrementalAuthorizeUrl(page, FOLLOW_SCOPES)}\n完成后后台会继续检查。`
              : '当前平台使用旧授权接口，但没有可用的授权入口，请联系平台维护者。';
            break;
          }
          case 'undeliverable': platformNotice = '平台未能把授权卡片送达你，自动跟随暂时暂停。请检查平台机器人的可用范围或联系平台维护者。'; break;
          case 'request_cap': platformNotice = '平台今天的授权卡片请求已达上限，本次没有发送卡片。自动跟随暂时暂停，稍后会再检查。'; break;
          case 'unavailable': platformNotice = '平台暂时不可用，本次没有发送授权卡片。自动跟随暂时暂停，稍后会再检查。'; break;
        }
      }
      const content = platformNotice ?? (issue?.pendingApproval && chatId
        ? `自动跟随已向这个群提交机器人入群申请：\n${chatAppLink(chatId, normalizeBrand(cfg.brand))}\n需要群管理员审批。审批通过后会继续跟踪，不会重复申请。`
        : issue?.authorizationSource === 'platform'
        ? `自动跟随暂时无法使用中心化平台的用户授权。${issue.guidance ?? '请稍后再检查或联系平台维护者。'}`
        : issue?.authorizationSource === 'bot' && issue.guidance
        ? issue.guidance
        : chatId
        ? `自动跟随未能把机器人加进这个群：\n${chatAppLink(chatId, normalizeBrand(cfg.brand))}\n请检查你是否有邀请权限，以及该群是否允许此机器人加入。自动重试已停止。`
        : '自动跟随新群已开启，但缺少可用的用户授权或群权限。请为本机器人授权 im:chat:read、im:chat.members:write_only 和 offline_access（也可使用已有 im:chat 授权），完成授权后后台会继续检查。首次成功检查只记录已有群。');
      await sendUserMessage(appId, ownerOpenId, content, 'text', undefined, undefined, {
        // The gate can queue or retry after this notify() was validated.
        // Recheck immediately before every provider write as well.
        beforeWrite: () => {
          if (!currentOwner()) throw new Error('owner group follow notification cancelled');
        },
      });
    },
    log: message => logger.warn(`[owner-group-follow:${appId}] ${message}`),
  });
  const tick = () => { void follower.tick().catch(() => logger.warn(`[owner-group-follow:${appId}] journal or configuration unavailable`)); };
  // A cheap config check allows hot enable/disable; disabled bots make no API calls.
  const timer = setInterval(tick, 5_000);
  timer.unref?.();
  tick();
  return { stop() { stopped = true; clearInterval(timer); follower.stop(); } };
}
