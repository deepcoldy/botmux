/**
 * Session-group tagging (p2pMode='group').
 *
 * Default mode `feed-group` — the owner's personal sidebar 消息分组 (feed
 * group, ofg_xxx): per-user message grouping that works on ANY tenant, since
 * no tenant scope catalog is involved. Feishu only accepts a user_access_token
 * there, so it runs under the owner's OAuth token (utils/user-token) — a
 * one-time authorization (nudged when missing, throttled), auto-refreshed
 * afterwards.
 *
 * Opt-in mode `chat-tag` — tenant chat tags (企业自定义群标签): the tag is a
 * property of the GROUP itself, applied with the bot's own tenant token via
 * `im/v2/tags` + `im/v2/biz_entity_tag_relation`. No user OAuth involved; the
 * app needs the `im:tag:write` and `im:biz_entity_tag_relation:write` tenant
 * scopes (setup/lark-scopes.json lists both) — which some tenants' scope
 * catalogs don't offer at all, hence not the default. When a scope is missing
 * the bot DMs the owner a ready-to-click console enable link (throttled).
 *
 * Everything is best-effort and fire-and-forget: failures degrade to
 * "group created, not tagged" with a log line — never block a birth.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getBot, getBotClient, effectiveBotDisplayName, type BotState } from '../bot-registry.js';
import { config } from '../config.js';
import { resolveUserToken, generateAuthUrl, FEED_GROUP_OAUTH_SCOPES } from '../utils/user-token.js';
import { larkHosts, normalizeBrand } from '../im/lark/lark-hosts.js';
import { sendUserMessage } from '../im/lark/client.js';
import { t, localeForBot } from '../i18n/index.js';
import { logger } from '../utils/logger.js';

/** 连 bot 显示名都拿不到时的最后兜底（多 bot 下毫无区分度，仅作保底）。 */
const DEFAULT_TAG_NAME = 'Botmux群会话';
/** 自定义标签名的保守长度上限（按码点算，中文/emoji 各算 1）。飞书未公开分组名
 *  的精确上限，取 60 足够放下正常命名，又不至于被服务端以超长拒绝。 */
export const MAX_SESSION_TAG_NAME_CODEPOINTS = 60;
/** 默认名里 bot 名的最长码点数：侧边栏宽度只显示前几个字，超出部分看不见。 */
const MAX_BOT_LABEL_CODEPOINTS = 12;
/** Re-nudge the owner about missing scope/auth at most once per this window. */
const NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function truncateCodepoints(value: string, limit: number): string {
  return Array.from(value).slice(0, Math.max(0, limit)).join('');
}

/** 归一化一个用户自定义标签名：trim + 保守截断。全空白 → 空串（= 清除配置）。 */
export function clampSessionTagName(raw: string): string {
  return truncateCodepoints(raw.trim(), MAX_SESSION_TAG_NAME_CODEPOINTS);
}

/** 「<bot 名>会话」/「<bot name> chats」——默认名与建群冲突退避名共用这一套构词，
 *  两条路径必须产出同一个字符串，否则默认名一变就会触发一次无意义的改名。 */
function botScopedTagName(botLabel: string, locale: 'zh' | 'en'): string {
  const label = truncateCodepoints(botLabel.trim(), MAX_BOT_LABEL_CODEPOINTS);
  return locale === 'en' ? `${label} chats` : `${label}会话`;
}

/**
 * 标签 / 分组名的回落链（feed-group 与 chat-tag 两种模式共用，保证默认名一致）：
 *   1. 用户在 bots.json / Dashboard 配的 `sessionGroup.tag.name`（trim 后非空）
 *   2. 「<bot 显示名>会话」——多 bot / 多设备下靠 bot 名区分
 *   3. DEFAULT_TAG_NAME——bot 显示名也拿不到时的保底
 */
export function resolveSessionTagName(input: {
  configuredName?: string;
  botDisplayName?: string;
  locale?: 'zh' | 'en';
}): string {
  const configured = clampSessionTagName(input.configuredName ?? '');
  if (configured) return configured;
  const label = input.botDisplayName?.trim();
  if (!label) return DEFAULT_TAG_NAME;
  return botScopedTagName(label, input.locale === 'en' ? 'en' : 'zh');
}

/**
 * bot 的「真名」：自定义 displayName > 飞书探测名 botName（复用 bot-registry 的
 * `effectiveBotDisplayName`，与 dashboard 展示同源）。两者都没有时返回 undefined
 * ——该 helper 的最后一档兜底是 larkAppId，拿它拼「cli_xxx会话」毫无意义。
 *
 * 取舍：只读内存注册表，同步、零 IO。`botName` 由 daemon 启动时的
 * `probeBotOpenId`（/bot/v3/info）异步回填，理论上极早期的一次建群可能还没探测到，
 * 此时默认名先落到 DEFAULT_TAG_NAME；等下一次打标（探测早已完成）由下方
 * configuredName 改名机制自动纠正成「<bot 名>会话」，不必在打标链路里等 IO。
 */
function botDisplayLabel(state: BotState): string | undefined {
  const name = effectiveBotDisplayName(state).trim();
  return name && name !== state.config.larkAppId ? name : undefined;
}

/**
 * 建群名冲突退避专用的 bot 标签：比 `botDisplayLabel` 多兜几档（bots.json 的 name、
 * cliId、appId 尾号），因为这条路径必须产出**某个**能区分本 app 的字符串，退无可退
 * 时宁可难看也不能返回空。
 */
function fallbackBotLabel(larkAppId: string): string {
  const state = getBot(larkAppId);
  const cfg = state.config;
  return (
    botDisplayLabel(state)
    || cfg.name?.trim()
    || cfg.cliId?.trim()
    || larkAppId.slice(-6)
  );
}

/**
 * 该 bot 在「没配自定义标签名」时会用的默认名。Dashboard 用它做输入框 placeholder，
 * 让用户看到留空到底等于什么名字。bot 不在本进程注册表时退回旧默认名。
 */
export function defaultSessionTagName(larkAppId: string): string {
  try {
    const state = getBot(larkAppId);
    return resolveSessionTagName({
      botDisplayName: botDisplayLabel(state),
      locale: localeForBot(larkAppId),
    });
  } catch {
    return DEFAULT_TAG_NAME;
  }
}

interface TagCache {
  /** Tenant chat-tag id (chat-tag mode). */
  chatTagId?: string;
  /** The name chatTagId was created/renamed with (rename detection). */
  chatTagName?: string;
  /** ofg_xxx feed-group id (feed-group mode). */
  groupId?: string;
  /** The ACTUAL name groupId carries (may be the conflict-fallback name). */
  name?: string;
  /** The configured name `name` was derived from — rename detection compares
   *  against THIS, so a conflict fallback (`name·bot`) doesn't ping-pong. */
  configuredName?: string;
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
    const detail = typeof body?.error?.message === 'string' ? body.error.message : '';
    const msg = [body?.msg ?? err?.message ?? String(err), detail].filter(Boolean).join(' | ');
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
    // Feishu puts the actionable detail in error.message (e.g. 230001 is just
    // "param is invalid" while error.message says "name already exists") —
    // merge both so callers can branch on the real reason.
    const detail = typeof json.error?.message === 'string' ? json.error.message : '';
    const msg = [json.msg ?? res.statusText, detail].filter(Boolean).join(' | ');
    return { ok: false, code, msg, authProblem };
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
    const createGroup = (groupName: string) => callFeedGroupApi(host, userToken, 'POST', '/open-apis/im/v1/groups', {
      feed_group_creator: { type: 'normal', name: groupName },
    });
    const isNameTaken = (r: LarkApiResult) =>
      !r.ok && r.code === 230001 && /already exists/i.test(String(r.msg ?? ''));

    let actualName = name;
    let created = await createGroup(name);
    if (isNameTaken(created)) {
      // 分组名用户级全局唯一，但操作权限按创建应用隔离——本 app 的 list 看不到、
      // 也建不了同名组（典型：多个 bot 应用都配了同一个名字 / 换 app 重装）。自动
      // 退避为「<bot 显示名>会话」：关键区分信息前置——侧边栏宽度只显示前几个字，
      // 「配置名·bot名」的后缀式命名会把 bot 名截没（实测反馈）。
      const scoped = botScopedTagName(fallbackBotLabel(larkAppId), localeForBot(larkAppId));
      // 第二档带 app 尾号消歧：默认名本来就是「<bot 名>会话」时第一档是同名空转，
      // 只有「两个应用的 bot 显示名也撞了」才会走到这里——难看总好过建不出分组。
      const candidates = [scoped, `${scoped}·${cfg.larkAppId.slice(-4)}`].filter(c => c !== name);
      for (const candidate of candidates) {
        logger.warn(
          `[session-tag] feed group name "${actualName}" is taken by another app's group (per-user unique, `
          + `per-app operable); falling back to "${candidate}"`,
        );
        actualName = candidate;
        // 退避名也可能已由本 app 早先建过（cache 丢失场景）——先查再建。
        const existingFallback = await findFeedGroupByName(host, userToken, candidate);
        created = existingFallback
          ? { ok: true, code: 0, data: { group_id: existingFallback } }
          : await createGroup(candidate);
        if (!isNameTaken(created)) break;
      }
    }
    if (!created.ok) {
      logger.warn(`[session-tag] feed group create "${actualName}" failed: code=${created.code} ${created.msg}`);
      if (created.authProblem) void maybeNudgeOwnerForAuth(larkAppId, ownerOpenId, `code_${created.code}`);
      return;
    }
    cache.groupId = created.data?.group_id;
    cache.name = actualName;
    cache.configuredName = name;
    saveCache(larkAppId, cache);
    logger.info(`[session-tag] feed group "${actualName}" → ${cache.groupId}`);
  } else if ((cache.configuredName ?? cache.name) !== name) {
    // 配置名变更才触发改名；对比 configuredName 而非实际名，避免退避名（name·bot）
    // 与配置名的固有差异导致每次建群都空转一次 rename。
    if (cache.name === name) {
      // 分组当前实际名已经就是目标名（典型：旧默认名下退避成「<bot 名>会话」，而新
      // 默认名恰好等于它）。同名 rename 会被飞书判 230001 already exists → 失败分支
      // 不写 configuredName → 每次打标都白跑一次。这里只把 configuredName 对齐。
      cache.configuredName = name;
      saveCache(larkAppId, cache);
      logger.info(`[session-tag] feed group already named "${name}"; aligned configuredName without rename`);
    } else {
      const renamed = await callFeedGroupApi(host, userToken, 'PUT',
        `/open-apis/im/v1/groups/${encodeURIComponent(cache.groupId)}`, {
          feed_group_updater: { name, update_fields: [1] },
        });
      if (renamed.ok) {
        cache.name = name;
        cache.configuredName = name;
        saveCache(larkAppId, cache);
        logger.info(`[session-tag] feed group renamed → "${name}"`);
      } else {
        logger.warn(`[session-tag] feed group rename failed (keeping old name): code=${renamed.code} ${renamed.msg}`);
      }
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
 * Effective tag mode for a `sessionGroup.tag` config block. Default
 * `feed-group`: per-user message grouping usable on any tenant with a
 * one-time OAuth — unlike `chat-tag`, whose tenant scopes some tenants'
 * scope catalogs don't offer at all.
 */
export function resolveTagMode(
  tag: { mode?: 'chat-tag' | 'feed-group' | 'off' } | undefined,
): 'chat-tag' | 'feed-group' | 'off' {
  return tag?.mode ?? 'feed-group';
}

/**
 * Tag one freshly-born session group per the bot's `sessionGroup.tag` config.
 * Fire-and-forget from the birth flow — never throws.
 */
export async function tagSessionGroup(larkAppId: string, chatId: string, ownerOpenId: string): Promise<void> {
  try {
    const state = getBot(larkAppId);
    const tag = state.config.sessionGroup?.tag ?? {};
    const mode = resolveTagMode(tag);
    if (mode === 'off') return;
    // 两种模式共用同一条回落链：配置名 → 「<bot 显示名>会话」→ 旧默认名。
    const name = resolveSessionTagName({
      configuredName: tag.name,
      botDisplayName: botDisplayLabel(state),
      locale: localeForBot(larkAppId),
    });
    if (mode === 'feed-group') {
      await tagViaFeedGroup(larkAppId, chatId, ownerOpenId, name);
      return;
    }
    await tagViaChatTag(larkAppId, chatId, ownerOpenId, name);
  } catch (err) {
    logger.warn(`[session-tag] tagging ${chatId.substring(0, 12)} threw: ${err}`);
  }
}
