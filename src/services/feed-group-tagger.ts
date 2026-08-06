/**
 * Session-group tagging (p2pMode='group').
 *
 * Default mode `chat-tag` — tenant chat tags (企业自定义群标签): the tag is a
 * property of the GROUP itself, applied with the bot's own tenant token via
 * `im/v2/tags` + `im/v2/biz_entity_tag_relation`. No user OAuth involved; the
 * app just needs the `im:tag:write` and `im:biz_entity_tag_relation:write`
 * tenant scopes (setup/lark-scopes.json lists both). When a scope is missing
 * the bot DMs the owner a ready-to-click console enable link (throttled).
 *
 * Opt-in mode `feed-group` — the owner's personal sidebar 消息分组 (feed
 * group, ofg_xxx). Feishu only accepts a user_access_token there, so it runs
 * under the owner's OAuth token (utils/user-token) and nudges for
 * authorization when missing. Kept opt-in because it writes to the user's
 * personal sidebar data.
 *
 * Everything is best-effort and fire-and-forget: failures degrade to
 * "group created, not tagged" with a log line — never block a birth.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getBot, getBotClient } from '../bot-registry.js';
import { config } from '../config.js';
import { resolveUserToken, generateAuthUrl, FEED_GROUP_OAUTH_SCOPES } from '../utils/user-token.js';
import { larkHosts, normalizeBrand } from '../im/lark/lark-hosts.js';
import { sendUserMessage } from '../im/lark/client.js';
import { t, localeForBot } from '../i18n/index.js';
import { logger } from '../utils/logger.js';

const DEFAULT_TAG_NAME = 'Botmux群会话';
/** Re-nudge the owner about missing scope/auth at most once per this window. */
const NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface TagCache {
  /** Tenant chat-tag id (chat-tag mode). */
  chatTagId?: string;
  /** The name chatTagId was created/renamed with (rename detection). */
  chatTagName?: string;
  /** ofg_xxx feed-group id (feed-group mode). */
  groupId?: string;
  /** The name groupId was created/renamed with. */
  name?: string;
  /** Epoch ms of the last owner nudge (throttle, shared by both modes). */
  lastAuthNudgeAt?: number;
}

function cachePath(appId: string): string {
  return join(config.session.dataDir, `feed-group-cache-${appId}.json`);
}

function loadCache(appId: string): TagCache {
  try {
    const fp = cachePath(appId);
    if (existsSync(fp)) return JSON.parse(readFileSync(fp, 'utf-8')) as TagCache;
  } catch { /* corrupted cache → start fresh */ }
  return {};
}

function saveCache(appId: string, cache: TagCache): void {
  try {
    const fp = cachePath(appId);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`[session-tag] cache persist failed: ${err}`);
  }
}

function nudgeThrottled(appId: string): boolean {
  const cache = loadCache(appId);
  const now = Date.now();
  if (cache.lastAuthNudgeAt && now - cache.lastAuthNudgeAt < NUDGE_INTERVAL_MS) return true;
  cache.lastAuthNudgeAt = now;
  saveCache(appId, cache);
  return false;
}

// ─── chat-tag mode (tenant token via the bot's SDK client) ───────────────────

interface TenantApiResult {
  ok: boolean;
  code?: number;
  msg?: string;
  data?: any;
  /** The scope named in a 99991672 access-denied error, if any. */
  missingScope?: string;
}

async function tenantApi(
  larkAppId: string,
  method: 'POST' | 'PATCH',
  url: string,
  data: unknown,
): Promise<TenantApiResult> {
  try {
    const client = getBotClient(larkAppId);
    const res: any = await (client as any).request({ method, url, data });
    const code = typeof res?.code === 'number' ? res.code : 0;
    if (code === 0) return { ok: true, code, data: res?.data };
    return { ok: false, code, msg: res?.msg };
  } catch (err: any) {
    // SDK throws on non-2xx; the Lark error body rides on err.response.data.
    const body = err?.response?.data;
    const code = typeof body?.code === 'number' ? body.code : undefined;
    const msg = body?.msg ?? err?.message ?? String(err);
    const missingScope = code === 99991672
      ? /\[([a-z0-9_:.]+)\]/i.exec(String(msg))?.[1]
      : undefined;
    return { ok: false, code, msg, missingScope };
  }
}

/** Console one-click enable link for a missing tenant scope (the same URL
 *  Feishu embeds in its 99991672 error message). */
function scopeEnableLink(host: string, appId: string, scope: string): string {
  const consoleHost = host.replace('open-apis', '').replace(/\/$/, '');
  return `${consoleHost}/app/${appId}/auth?q=${encodeURIComponent(scope)}&op_from=openapi&token_type=tenant`;
}

async function maybeNudgeScope(larkAppId: string, ownerOpenId: string, scope: string): Promise<void> {
  if (nudgeThrottled(larkAppId)) return;
  try {
    const cfg = getBot(larkAppId).config;
    const host = larkHosts(normalizeBrand(cfg.brand)).openApi;
    const loc = localeForBot(larkAppId);
    await sendUserMessage(
      larkAppId,
      ownerOpenId,
      t('sg.tag_scope_nudge', { scope, url: scopeEnableLink(host, cfg.larkAppId, scope) }, loc),
      'text',
    );
    logger.info(`[session-tag] sent scope nudge (${scope}) to owner ${ownerOpenId.substring(0, 12)}`);
  } catch (err) {
    logger.warn(`[session-tag] scope nudge failed: ${err}`);
  }
}

/** Ensure the tenant chat tag exists (create / rename), returning its id. */
async function ensureChatTag(larkAppId: string, name: string, ownerOpenId: string): Promise<string | null> {
  const cache = loadCache(larkAppId);
  if (cache.chatTagId && cache.chatTagName === name) return cache.chatTagId;

  if (cache.chatTagId && cache.chatTagName !== name) {
    const patched = await tenantApi(larkAppId, 'PATCH',
      `/open-apis/im/v2/tags/${encodeURIComponent(cache.chatTagId)}`,
      { patch_tag: { name } });
    if (patched.ok || patched.data?.patch_tag_fail_reason?.duplicate_id) {
      cache.chatTagId = patched.data?.patch_tag_fail_reason?.duplicate_id ?? cache.chatTagId;
      cache.chatTagName = name;
      saveCache(larkAppId, cache);
      return cache.chatTagId!;
    }
    logger.warn(`[session-tag] tag rename failed (keeping old name): code=${patched.code} ${patched.msg}`);
    return cache.chatTagId; // stale name still tags correctly
  }

  const created = await tenantApi(larkAppId, 'POST', '/open-apis/im/v2/tags', {
    create_tag: { tag_type: 'tenant', name },
  });
  const id = created.data?.id ?? created.data?.create_tag_fail_reason?.duplicate_id;
  if (id) {
    cache.chatTagId = id;
    cache.chatTagName = name;
    saveCache(larkAppId, cache);
    logger.info(`[session-tag] chat tag "${name}" → ${id}`);
    return id;
  }
  logger.warn(`[session-tag] create tag "${name}" failed: code=${created.code} ${created.msg}`);
  if (created.missingScope) void maybeNudgeScope(larkAppId, ownerOpenId, created.missingScope);
  return null;
}

async function tagViaChatTag(larkAppId: string, chatId: string, ownerOpenId: string, name: string): Promise<void> {
  const tagId = await ensureChatTag(larkAppId, name, ownerOpenId);
  if (!tagId) return;
  const bound = await tenantApi(larkAppId, 'POST', '/open-apis/im/v2/biz_entity_tag_relation', {
    tag_biz_type: 'chat',
    biz_entity_id: chatId,
    tag_ids: [tagId],
  });
  if (!bound.ok) {
    logger.warn(`[session-tag] bind ${chatId.substring(0, 12)} failed: code=${bound.code} ${bound.msg}`);
    if (bound.missingScope) void maybeNudgeScope(larkAppId, ownerOpenId, bound.missingScope);
    return;
  }
  logger.info(`[session-tag] tagged ${chatId.substring(0, 12)} with chat tag "${name}" (${tagId})`);
}

// ─── feed-group mode (owner user token) — opt-in ─────────────────────────────

interface LarkApiResult {
  ok: boolean;
  code?: number;
  msg?: string;
  data?: any;
  authProblem?: boolean;
}

async function callFeedGroupApi(
  brandHost: string,
  userToken: string,
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
): Promise<LarkApiResult> {
  try {
    const res = await fetch(`${brandHost}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    const code = typeof json.code === 'number' ? json.code : (res.ok ? 0 : res.status);
    if (code === 0) return { ok: true, code, data: json.data };
    const authProblem = [99991672, 99991679, 20027, 20005].includes(code) || res.status === 401 || res.status === 403;
    return { ok: false, code, msg: json.msg ?? res.statusText, authProblem };
  } catch (err: any) {
    return { ok: false, msg: err?.message ?? String(err) };
  }
}

async function maybeNudgeOwnerForAuth(larkAppId: string, ownerOpenId: string, reason: string): Promise<void> {
  if (nudgeThrottled(larkAppId)) return;
  try {
    const cfg = getBot(larkAppId).config;
    const { authUrl } = generateAuthUrl(
      cfg.larkAppId,
      cfg.larkAppSecret,
      normalizeBrand(cfg.brand),
      FEED_GROUP_OAUTH_SCOPES,
    );
    const loc = localeForBot(larkAppId);
    await sendUserMessage(
      larkAppId,
      ownerOpenId,
      t('sg.tag_auth_nudge', { reason, url: authUrl }, loc),
      'text',
    );
    logger.info(`[session-tag] sent auth nudge to owner ${ownerOpenId.substring(0, 12)} (${reason})`);
  } catch (err) {
    logger.warn(`[session-tag] auth nudge failed: ${err}`);
  }
}

/** Find an existing feed group by exact name (paged; capped at 3 pages).
 *  Reuse-before-create keeps multi-bot / reinstall setups from spawning
 *  duplicate same-name sidebar groups — feed groups have no server-side
 *  name-dedup of their own. */
async function findFeedGroupByName(brandHost: string, userToken: string, name: string): Promise<string | null> {
  let pageToken = '';
  for (let page = 0; page < 3; page++) {
    try {
      const qs = new URLSearchParams({ page_size: '50', ...(pageToken ? { page_token: pageToken } : {}) });
      const res = await fetch(`${brandHost}/open-apis/im/v1/groups?${qs}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const json: any = await res.json().catch(() => ({}));
      if (json.code !== 0) return null;
      const hit = (json.data?.groups ?? []).find((g: any) => g?.name === name && g?.group_id);
      if (hit) return hit.group_id as string;
      if (!json.data?.has_more || !json.data?.page_token) return null;
      pageToken = json.data.page_token;
    } catch {
      return null;
    }
  }
  return null;
}

async function tagViaFeedGroup(larkAppId: string, chatId: string, ownerOpenId: string, name: string): Promise<void> {
  const cfg = getBot(larkAppId).config;
  const brand = normalizeBrand(cfg.brand);
  const host = larkHosts(brand).openApi;

  const userToken = await resolveUserToken(cfg.larkAppId, cfg.larkAppSecret, brand);
  if (!userToken) {
    logger.info(`[session-tag] no user token for ${larkAppId}; skip feed-group tagging ${chatId.substring(0, 12)}`);
    void maybeNudgeOwnerForAuth(larkAppId, ownerOpenId, 'no_token');
    return;
  }

  const cache = loadCache(larkAppId);
  if (!cache.groupId) {
    // Reuse an existing same-name group first (multi-bot / reinstall dedup).
    const existing = await findFeedGroupByName(host, userToken, name);
    if (existing) {
      cache.groupId = existing;
      cache.name = name;
      saveCache(larkAppId, cache);
      logger.info(`[session-tag] reusing existing feed group "${name}" → ${existing}`);
    }
  }
  if (!cache.groupId) {
    const created = await callFeedGroupApi(host, userToken, 'POST', '/open-apis/im/v1/groups', {
      feed_group_creator: { type: 'normal', name },
    });
    if (!created.ok) {
      // 230001 + "name already exists"：分组名用户级全局唯一，但操作权限按创建
      // 应用隔离——本 app 的 list 看不到、也建不了同名组（典型：换 app 重装 /
      // 曾用别的应用建过同名分组）。指名道姓提示，而不是留一个含糊的 param 错误。
      if (created.code === 230001 && /already exists/i.test(String(created.msg ?? ''))) {
        logger.warn(
          `[session-tag] feed group name "${name}" is taken by ANOTHER app's group (feed groups are `
          + 'per-user unique by name but per-app operable). Rename sessionGroup.tag.name or delete '
          + 'the old group from the app that created it.',
        );
        return;
      }
      logger.warn(`[session-tag] feed group create "${name}" failed: code=${created.code} ${created.msg}`);
      if (created.authProblem) void maybeNudgeOwnerForAuth(larkAppId, ownerOpenId, `code_${created.code}`);
      return;
    }
    cache.groupId = created.data?.group_id;
    cache.name = name;
    saveCache(larkAppId, cache);
    logger.info(`[session-tag] created feed group "${name}" → ${cache.groupId}`);
  } else if (cache.name !== name) {
    const renamed = await callFeedGroupApi(host, userToken, 'PUT',
      `/open-apis/im/v1/groups/${encodeURIComponent(cache.groupId)}`, {
        feed_group_updater: { name, update_fields: [1] },
      });
    if (renamed.ok) {
      cache.name = name;
      saveCache(larkAppId, cache);
    } else {
      logger.warn(`[session-tag] feed group rename failed (keeping old name): code=${renamed.code} ${renamed.msg}`);
    }
  }
  if (!cache.groupId) return;

  const added = await callFeedGroupApi(host, userToken, 'POST',
    `/open-apis/im/v1/groups/${encodeURIComponent(cache.groupId)}/batch_add_item`, {
      items: [{ feed_id: chatId, feed_type: 'chat' }],
    });
  if (!added.ok) {
    logger.warn(`[session-tag] feed group add ${chatId.substring(0, 12)} failed: code=${added.code} ${added.msg}`);
    if (added.authProblem) void maybeNudgeOwnerForAuth(larkAppId, ownerOpenId, `code_${added.code}`);
    return;
  }
  const failed = added.data?.failed_items;
  if (Array.isArray(failed) && failed.length > 0) {
    logger.warn(`[session-tag] feed group add ${chatId.substring(0, 12)} partially failed: ${JSON.stringify(failed)}`);
    return;
  }
  logger.info(`[session-tag] tagged ${chatId.substring(0, 12)} into feed group "${cache.name}" (${cache.groupId})`);
}

// ─── entry point ─────────────────────────────────────────────────────────────

/**
 * Tag one freshly-born session group per the bot's `sessionGroup.tag` config.
 * Fire-and-forget from the birth flow — never throws.
 */
export async function tagSessionGroup(larkAppId: string, chatId: string, ownerOpenId: string): Promise<void> {
  try {
    const cfg = getBot(larkAppId).config;
    const tag = cfg.sessionGroup?.tag ?? {};
    const mode = tag.mode ?? 'chat-tag';
    if (mode === 'off') return;
    const name = tag.name?.trim() || DEFAULT_TAG_NAME;
    if (mode === 'feed-group') {
      await tagViaFeedGroup(larkAppId, chatId, ownerOpenId, name);
      return;
    }
    await tagViaChatTag(larkAppId, chatId, ownerOpenId, name);
  } catch (err) {
    logger.warn(`[session-tag] tagging ${chatId.substring(0, 12)} threw: ${err}`);
  }
}
