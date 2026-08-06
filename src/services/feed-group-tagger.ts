/**
 * Sidebar feed-group tagging for session groups (p2pMode='group').
 *
 * Feishu "消息分组" (feed groups, ofg_xxx) are PER-USER sidebar tags — the
 * API only accepts a user_access_token, so tagging runs under the bot owner's
 * OAuth token (utils/user-token, the same store /login fills). Everything is
 * best-effort: a missing/expired token or an app without the feed-group
 * scopes degrades to "group created, not tagged" with a log line, plus a
 * throttled DM nudge to the owner containing a ready-to-click auth link.
 *
 * Flow per birth (explicit mode, the default):
 *   1. ensure the configured feed group exists (create type=normal on first
 *      use; rename when the configured name changed) — cached per app+user in
 *      `${dataDir}/feed-group-cache-${appId}.json`
 *   2. batch_add_item the freshly-born chat into it
 *
 * Console prerequisite: the bot app must have the `im:feed_group_v1:write` /
 * `im:feed_group_v1:read` user scopes enabled (开放平台 → 权限管理), same as
 * any other user-scope feature. Both are listed in setup/lark-scopes.json.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getBot } from '../bot-registry.js';
import { config } from '../config.js';
import { resolveUserToken, generateAuthUrl, FEED_GROUP_OAUTH_SCOPES } from '../utils/user-token.js';
import { larkHosts, normalizeBrand } from '../im/lark/lark-hosts.js';
import { sendUserMessage } from '../im/lark/client.js';
import { t, localeForBot } from '../i18n/index.js';
import { logger } from '../utils/logger.js';

const DEFAULT_FEED_GROUP_NAME = 'Botmux群会话';
/** Re-nudge the owner about missing auth at most once per this window. */
const AUTH_NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface FeedGroupCache {
  /** ofg_xxx id of the feed group we manage. */
  groupId?: string;
  /** The name groupId was created/renamed with (rename detection). */
  name?: string;
  /** Epoch ms of the last missing-auth DM nudge (throttle). */
  lastAuthNudgeAt?: number;
}

function cachePath(appId: string): string {
  return join(config.session.dataDir, `feed-group-cache-${appId}.json`);
}

function loadCache(appId: string): FeedGroupCache {
  try {
    const fp = cachePath(appId);
    if (existsSync(fp)) return JSON.parse(readFileSync(fp, 'utf-8')) as FeedGroupCache;
  } catch { /* corrupted cache → start fresh */ }
  return {};
}

function saveCache(appId: string, cache: FeedGroupCache): void {
  try {
    const fp = cachePath(appId);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`[feed-group] cache persist failed: ${err}`);
  }
}

interface LarkApiResult {
  ok: boolean;
  code?: number;
  msg?: string;
  data?: any;
  /** True when the failure is an authorization/scope problem — auth nudge material. */
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
    // 99991672 / 99991679: scope not authorized; 20027: app scope not opened.
    const authProblem = [99991672, 99991679, 20027, 20005].includes(code) || res.status === 401 || res.status === 403;
    return { ok: false, code, msg: json.msg ?? res.statusText, authProblem };
  } catch (err: any) {
    return { ok: false, msg: err?.message ?? String(err) };
  }
}

/** Throttled owner DM: "authorize feed-group tagging" with a click-through link. */
async function maybeNudgeOwnerForAuth(larkAppId: string, ownerOpenId: string, reason: string): Promise<void> {
  const cache = loadCache(larkAppId);
  const now = Date.now();
  if (cache.lastAuthNudgeAt && now - cache.lastAuthNudgeAt < AUTH_NUDGE_INTERVAL_MS) return;
  cache.lastAuthNudgeAt = now;
  saveCache(larkAppId, cache);
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
    logger.info(`[feed-group] sent auth nudge to owner ${ownerOpenId.substring(0, 12)} (${reason})`);
  } catch (err) {
    logger.warn(`[feed-group] auth nudge failed: ${err}`);
  }
}

/**
 * Tag one freshly-born session group into the configured sidebar feed group.
 * Fire-and-forget from the birth flow — never throws.
 */
export async function tagSessionGroup(larkAppId: string, chatId: string, ownerOpenId: string): Promise<void> {
  try {
    const cfg = getBot(larkAppId).config;
    const fg = cfg.sessionGroup?.feedGroup ?? {};
    const mode = fg.mode ?? 'explicit';
    if (mode === 'off') return;
    if (mode === 'rule') {
      // Rule-based groups auto-collect by name prefix — nothing to do per birth.
      return;
    }
    const name = fg.name?.trim() || DEFAULT_FEED_GROUP_NAME;
    const brand = normalizeBrand(cfg.brand);
    const host = larkHosts(brand).openApi;

    const userToken = await resolveUserToken(cfg.larkAppId, cfg.larkAppSecret, brand);
    if (!userToken) {
      logger.info(`[feed-group] no user token for ${larkAppId}; skip tagging ${chatId.substring(0, 12)}`);
      void maybeNudgeOwnerForAuth(larkAppId, ownerOpenId, 'no_token');
      return;
    }

    // 1. Ensure the feed group exists (create once; rename when config changed).
    const cache = loadCache(larkAppId);
    if (!cache.groupId) {
      const created = await callFeedGroupApi(host, userToken, 'POST', '/open-apis/im/v1/groups', {
        feed_group_creator: { type: 'normal', name },
      });
      if (!created.ok) {
        logger.warn(`[feed-group] create "${name}" failed: code=${created.code} ${created.msg}`);
        if (created.authProblem) void maybeNudgeOwnerForAuth(larkAppId, ownerOpenId, `code_${created.code}`);
        return;
      }
      cache.groupId = created.data?.group_id;
      cache.name = name;
      saveCache(larkAppId, cache);
      logger.info(`[feed-group] created "${name}" → ${cache.groupId}`);
    } else if (cache.name !== name) {
      const renamed = await callFeedGroupApi(host, userToken, 'PUT',
        `/open-apis/im/v1/groups/${encodeURIComponent(cache.groupId)}`, {
          feed_group_updater: { name, update_fields: [1] },
        });
      if (renamed.ok) {
        cache.name = name;
        saveCache(larkAppId, cache);
        logger.info(`[feed-group] renamed ${cache.groupId} → "${name}"`);
      } else {
        logger.warn(`[feed-group] rename failed (keeping old name): code=${renamed.code} ${renamed.msg}`);
      }
    }
    if (!cache.groupId) return;

    // 2. Add the chat into the feed group.
    const added = await callFeedGroupApi(host, userToken, 'POST',
      `/open-apis/im/v1/groups/${encodeURIComponent(cache.groupId)}/batch_add_item`, {
        items: [{ feed_id: chatId, feed_type: 'chat' }],
      });
    if (!added.ok) {
      logger.warn(`[feed-group] add ${chatId.substring(0, 12)} failed: code=${added.code} ${added.msg}`);
      if (added.authProblem) void maybeNudgeOwnerForAuth(larkAppId, ownerOpenId, `code_${added.code}`);
      return;
    }
    const failed = added.data?.failed_items;
    if (Array.isArray(failed) && failed.length > 0) {
      logger.warn(`[feed-group] add ${chatId.substring(0, 12)} partially failed: ${JSON.stringify(failed)}`);
      return;
    }
    logger.info(`[feed-group] tagged ${chatId.substring(0, 12)} into "${cache.name}" (${cache.groupId})`);
  } catch (err) {
    logger.warn(`[feed-group] tagging ${chatId.substring(0, 12)} threw: ${err}`);
  }
}
