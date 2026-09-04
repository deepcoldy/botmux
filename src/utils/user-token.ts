/**
 * User Access Token — self-contained OAuth token management for botmux.
 *
 * Token storage is keyed by (app, authorizing user):
 *   - `~/.botmux/data/user-token-<appId>-<openId>.json` — one file per person
 *   - `~/.botmux/data/user-token-<appId>.json` — LEGACY, pre-openId
 *   - `~/.botmux/data/user-token.json` — LEGACY, pre-multi-bot
 *
 * The openId dimension exists because a token identifies a PERSON, not a bot:
 * without it a second `/login` in the same bot silently overwrites the first,
 * and every later call runs as whoever authorized last (no error, wrong name in
 * the audit trail). Callers that must act as a specific human pass `openId` and
 * get that person's token or nothing — a legacy unstamped file is NEVER accepted
 * for a named person, because we cannot prove whose it is.
 *
 * There is deliberately NO env-var override: a global
 * `FEISHU_USER_ACCESS_TOKEN` would be an invisible bypass around the whole
 * per-user boundary.
 *
 * OAuth login via /login command writes to botmux's own token file.
 * Auto-refreshes expired access_token using refresh_token.
 */
import { readFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { atomicWriteFileSync } from './atomic-write.js';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { logger } from './logger.js';
import { type Brand, larkHosts } from '../im/lark/lark-hosts.js';
import { readGlobalConfig } from '../global-config.js';

// ─── Token paths ──────────────────────────────────────────────────────────────

const TOKEN_DIR = join(homedir(), '.botmux', 'data');
const PENDING_DIR = join(TOKEN_DIR, 'oauth-pending');
/** 旧版单文件（升级前都是单 feishu bot）。仅作向后兼容读取，不再写入。 */
const LEGACY_TOKEN_PATH = join(TOKEN_DIR, 'user-token.json');
const BUFFER_MS = 60_000; // 60s safety margin before expiry

/** open_id 形状校验。用于文件名拼接，必须先过滤掉路径分隔符等字符 —— 一个
 *  `../` 的 openId 会让 token 写到 TOKEN_DIR 之外。 */
const OPEN_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

export function isUsableOpenId(openId: string | undefined): openId is string {
  return typeof openId === 'string' && OPEN_ID_RE.test(openId);
}

/**
 * Token 文件路径。
 *
 * - 传 `openId` → `user-token-<appId>-<openId>.json`，每个授权人各存一份。
 * - 不传 → `user-token-<appId>.json`，升级前的 per-app 文件；只读不写。
 *
 * 一台机器混挂 Feishu + Lark 多 bot 时，各自的 User Token 互不覆盖、互不串用。
 */
function tokenPathForApp(appId: string, openId?: string): string {
  return isUsableOpenId(openId)
    ? join(TOKEN_DIR, `user-token-${appId}-${openId}.json`)
    : join(TOKEN_DIR, `user-token-${appId}.json`);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenStore {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: string;           // ISO 8601
  refresh_expires_at: string;   // ISO 8601
  scope: string;
  /**
   * token 所属应用 / 品牌。旧的单文件没有这两个字段（undefined）——按"属于升级前
   * 唯一的那个 feishu bot"兼容处理（见 {@link loadTokenForApp}）。
   */
  appId?: string;
  brand?: Brand;
  /**
   * 完成这次授权的人的 open_id（app-scoped）。旧文件没有这个字段，因此**无法证明
   * 属于谁** —— 按人取 token 时一律不认领这类文件（见 {@link loadTokenForApp}）。
   */
  openId?: string;
  /** 授权人姓名，仅用于 /status、/login status 等展示，非身份依据。 */
  userName?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  refresh_token_expires_in: number;
  scope: string;
  error?: string;
  error_description?: string;
}

// ─── Pending login state ──────────────────────────────────────────────────────

interface PendingLogin {
  state: string;
  redirectUri: string;
  appId: string;
  appSecret: string;
  /** 租户品牌——决定回调换 token 时打哪个域名。缺省 feishu。 */
  brand: Brand;
  /**
   * 发起这次 /login 的人的 open_id。回调落盘时用它决定文件名，使 token 归属到
   * 具体的人而不是整个 bot。缺省（旧链路 / 无 sender 的入口）→ 写 per-app 文件。
   */
  openId?: string;
  createdAt: number;
}

const pendingLogins = new Map<string, PendingLogin>(); // keyed by state

function pendingPath(state: string): string | null {
  return /^[a-f0-9]{64}$/.test(state) ? join(PENDING_DIR, `${state}.json`) : null;
}

/** Persist pending OAuth state so Dashboard and daemon processes can finish
 * each other's authorization flow. Files contain app credentials and are
 * therefore always mode 0600 and removed immediately after consumption. */
function savePendingLogin(pending: PendingLogin): void {
  const path = pendingPath(pending.state);
  if (!path) return;
  mkdirSync(PENDING_DIR, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, JSON.stringify(pending), { mode: 0o600 });
}

function loadPendingLogin(state: string): PendingLogin | null {
  const path = pendingPath(state);
  if (!path) return null;
  try {
    const pending = JSON.parse(readFileSync(path, 'utf8')) as PendingLogin;
    if (pending.state !== state || Date.now() - pending.createdAt > 5 * 60_000) return null;
    return pending;
  } catch {
    return null;
  }
}

function removePendingLogin(state: string): void {
  const path = pendingPath(state);
  if (!path) return;
  try { unlinkSync(path); } catch { /* already absent */ }
}

function cleanupPendingLogins(): void {
  try {
    for (const name of readdirSync(PENDING_DIR)) {
      const state = name.endsWith('.json') ? name.slice(0, -5) : '';
      const pending = loadPendingLogin(state);
      if (!pending) removePendingLogin(state);
    }
  } catch { /* directory absent */ }
}

// ─── Token I/O ────────────────────────────────────────────────────────────────

function loadTokenFromPath(path: string): TokenStore | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function saveTokenForApp(token: TokenStore, appId: string, openId?: string): void {
  const path = tokenPathForApp(appId, openId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // 0600：OAuth token 是密钥，且原子写每次重建文件，不传 mode 会把用户
  // 手动收紧过的权限在自动刷新时悄悄改回 0644。
  atomicWriteFileSync(path, JSON.stringify(token, null, 2), { mode: 0o600 });
}

function isValid(isoDate: string): boolean {
  if (!isoDate) return false;
  return Date.now() + BUFFER_MS < new Date(isoDate).getTime();
}

/**
 * 一个落盘 token 是否真的属于本次请求的 (appId, brand)。除文件名外，**再校验文件
 * 内容里的 appId/brand**（Codex review hardening）——防止 per-app 文件被改名 / 手动
 * 误编辑 / 旧迁移残留导致拿错域的 token：
 *   - 未标 appId（升级前的旧单文件）→ 仅当请求 feishu 时认领（彼时只有 feishu 单 bot）
 *   - 标了 appId → 必须同 appId；若也标了 brand，则必须同 brand
 */
function tokenMatches(t: TokenStore, appId: string, brand: Brand): boolean {
  if (t.appId === undefined) return brand === 'feishu';
  if (t.appId !== appId) return false;
  if (t.brand !== undefined && t.brand !== brand) return false;
  return true;
}

/**
 * 取指定 app 的 token。
 *
 * 传 `openId`（按人取，trigger-user 鉴权的主路径）：**只认属于那个人的文件**。
 * per-person 文件的内容 `openId` 也要复核；per-app / 单文件这类未标注归属的旧
 * 文件一律不认领 —— 无法证明它属于谁，拿来当某人的凭证就是静默的身份错配。
 *
 * 不传 `openId`（bot 级取，旧行为）：per-app 文件 → 旧单文件，都过
 * {@link tokenMatches} 校验（文件名 + 内容双重把关）。
 *
 * `allowUnattributed` 是给「owner 个人功能」开的一道窄口子（见
 * {@link resolveOwnerUserToken}），普通按人取绝不能打开。
 */
function loadTokenForApp(
  appId: string,
  brand: Brand,
  openId?: string,
  allowUnattributed = false,
): { token: TokenStore; source: string } | null {
  if (isUsableOpenId(openId)) {
    const perPerson = loadTokenFromPath(tokenPathForApp(appId, openId));
    if (perPerson && tokenMatches(perPerson, appId, brand) && perPerson.openId === openId) {
      return { token: perPerson, source: 'botmux' };
    }
    if (!allowUnattributed) return null;
    // 落到下面的 per-app / legacy 查找。
  }
  const perApp = loadTokenFromPath(tokenPathForApp(appId));
  if (perApp && tokenMatches(perApp, appId, brand)) return { token: perApp, source: 'botmux' };
  const legacy = loadTokenFromPath(LEGACY_TOKEN_PATH);
  if (legacy && tokenMatches(legacy, appId, brand)) return { token: legacy, source: 'botmux(legacy)' };
  return null;
}

/**
 * 这个 app 下所有已授权的人。用于 Dashboard 的「已授权 N 人」与 /login status。
 * 只读文件名与内容里的归属字段，**不返回任何 token 内容**。
 */
export function listAuthorizedUsers(
  appId: string,
  brand: Brand = 'feishu',
): Array<{ openId: string; userName?: string; expiresAt: string; refreshExpiresAt: string }> {
  const out: Array<{ openId: string; userName?: string; expiresAt: string; refreshExpiresAt: string }> = [];
  let names: string[];
  try { names = readdirSync(TOKEN_DIR); } catch { return out; }
  const prefix = `user-token-${appId}-`;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const token = loadTokenFromPath(join(TOKEN_DIR, name));
    if (!token || !isUsableOpenId(token.openId) || !tokenMatches(token, appId, brand)) continue;
    out.push({
      openId: token.openId,
      ...(token.userName ? { userName: token.userName } : {}),
      expiresAt: token.expires_at ?? '',
      refreshExpiresAt: token.refresh_expires_at ?? '',
    });
  }
  return out;
}

// ─── Token refresh ────────────────────────────────────────────────────────────

async function refreshToken(
  token: TokenStore,
  appId: string,
  appSecret: string,
  brand: Brand = 'feishu',
): Promise<TokenStore | null> {
  try {
    const res = await fetch(`${larkHosts(brand).openApi}/open-apis/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
        client_id: appId,
        client_secret: appSecret,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as TokenResponse;
    if (data.error || !data.access_token) return null;

    const now = new Date();
    const updated: TokenStore = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_type: data.token_type,
      expires_at: new Date(now.getTime() + data.expires_in * 1000).toISOString(),
      refresh_expires_at: data.refresh_token_expires_in > 0
        ? new Date(now.getTime() + data.refresh_token_expires_in * 1000).toISOString()
        : token.refresh_expires_at,
      scope: data.scope || token.scope,
      appId,
      brand,
      // 归属不因刷新而改变——刷新的是同一个人的 token。旧文件没有 openId 时保持
      // 没有，绝不在这里凭空归属给某个人。
      ...(token.openId ? { openId: token.openId } : {}),
      ...(token.userName ? { userName: token.userName } : {}),
    };

    // 写回原来那个文件：per-person token 刷新后仍是 per-person，不能落到
    // per-app 路径去覆盖别的东西。
    try { saveTokenForApp(updated, appId, token.openId); } catch { /* best-effort */ }
    logger.info('[user-token] Refreshed User Access Token');
    return updated;
  } catch (err: any) {
    logger.debug(`[user-token] Refresh failed: ${err.message}`);
    return null;
  }
}

// ─── Public API: resolve token ────────────────────────────────────────────────

/**
 * Owner 个人功能专用的 token 解析（目前只有飞书「消息分组」标签）。
 *
 * 这类功能操作的是 owner 自己的收件箱侧边栏，bot 没有收件箱，所以它天然只能用
 * owner 本人的 token。与 {@link resolveUserToken} 的严格按人取相比，这里额外接受
 * **未标注归属的旧 per-app 文件**：升级前这些文件事实上就是 owner 自己 /login 写
 * 的，拒绝它们会让存量安装的标签功能在升级后静默失效。
 *
 * 这道口子只对 owner 开：ownerOpenId 由 bot 配置决定，不来自消息，所以不存在
 * 「借用别人凭证」的路径。任何按消息发送者取凭证的地方都必须用
 * {@link resolveUserToken}。
 */
export async function resolveOwnerUserToken(
  appId: string,
  appSecret: string,
  brand: Brand = 'feishu',
  ownerOpenId?: string,
): Promise<string | null> {
  return resolveTokenFrom(loadTokenForApp(appId, brand, ownerOpenId, true), appId, appSecret, brand);
}

/** {@link resolveUserToken} / {@link resolveOwnerUserToken} 共用的过期与刷新处理。 */
async function resolveTokenFrom(
  loaded: { token: TokenStore; source: string } | null,
  appId: string,
  appSecret: string,
  brand: Brand,
): Promise<string | null> {
  if (!loaded) return null;
  const { token } = loaded;

  if (isValid(token.expires_at)) return token.access_token;

  // access_token expired — try refresh
  if (isValid(token.refresh_expires_at) || (!token.refresh_expires_at && token.refresh_token)) {
    const refreshed = await refreshToken(token, appId, appSecret, brand);
    if (refreshed) return refreshed.access_token;
  }

  logger.debug('[user-token] Token expired and refresh_token also expired');
  return null;
}

/**
 * Resolve a valid User Access Token.
 *
 * `openId` 给定时按人取：只接受属于那个人的 token，取不到就返回 null（调用方负责
 * 降级到 bot 身份或提示 /login）。不给时按 bot 取（旧行为），拿这个 app 下任何
 * 已授权的 per-app / 旧单文件 token。
 *
 * Returns access_token string, or null if unavailable.
 */
export async function resolveUserToken(
  appId: string,
  appSecret: string,
  brand: Brand = 'feishu',
  openId?: string,
): Promise<string | null> {
  // 按 (app, 人) 取盘上的 token。不匹配 / 别人的 → null，调用方提示 /login。
  // 这里刻意没有 env 覆盖：一个全局 FEISHU_USER_ACCESS_TOKEN 会绕过整个按人隔离
  // 边界，而且绕过时没有任何痕迹。
  return resolveTokenFrom(loadTokenForApp(appId, brand, openId), appId, appSecret, brand);
}

// ─── Public API: OAuth login flow ─────────────────────────────────────────────

const DEFAULT_PORT = 9768;
const DEFAULT_SCOPES = [
  'im:message:readonly',
  'im:resource',
  'offline_access',
].join(' ');

/**
 * 飞书文档订阅入口（/subscribe-lark-doc）专用的额外 OAuth scope。**不进**全局
 * DEFAULT_SCOPES —— 否则所有 bot 的通用 /login（图片下载用）都会请求这些 scope，
 * 没在开发者后台启用它们的 app 会一起 20043 失败。改由 /subscribe-lark-doc 在
 * 需要时通过 generateAuthUrl 的 extraScopes 单独带上。
 *
 * 每个 scope 都对着 src/setup/lark-scopes.json 校验过（错名会触发 authorize 报
 * 错 20043）。使用前仍需在开发者后台为该 app 启用这些 scope 并订阅评论事件。
 */
export const DOC_COMMENT_OAUTH_SCOPES = [
  'docs:document.subscription',  // 订阅文档事件（评论新增等）
  'docs:event:subscribe',        // 事件订阅
  'docs:document.comment:read',  // 读评论
  'docs:document.comment:create',// 回复 / 新建评论
  'wiki:wiki:readonly',          // 解析 wiki 节点 → obj_token
];

/**
 * 会话群标签（p2pMode=group + feedGroup）专用的额外 OAuth scope。飞书「消息分组」
 * 是用户个人侧边栏数据，只认 user_access_token —— 与 DOC_COMMENT_OAUTH_SCOPES
 * 同理**不进**通用 /login 的 DEFAULT_SCOPES。使用前需在开发者后台为该 app 启用
 * 这两个用户 scope（见 setup/lark-scopes.json）。
 */
export const FEED_GROUP_OAUTH_SCOPES = [
  'im:feed_group_v1:write',  // 创建/改名标签、把会话群挂进标签
  'im:feed_group_v1:read',   // 查询标签与成员（校验/去重）
];

/**
 * Resolve the OAuth redirect_uri. With global-config `oauthRedirectBase` set
 * (typically the host's dashboard origin), auth flows redirect to the
 * dashboard's `/oauth/callback` receiver and complete automatically; without
 * it, the legacy localhost paste-back address is used. The chosen URI must be
 * registered in the app's console redirect-URL whitelist either way.
 */
export function resolveOAuthRedirectUri(): string {
  try {
    const base = readGlobalConfig().oauthRedirectBase?.trim().replace(/\/+$/, '');
    if (base && /^https?:\/\//.test(base)) return `${base}/oauth/callback`;
  } catch { /* fall through to legacy */ }
  return `http://127.0.0.1:${DEFAULT_PORT}/callback`;
}

/**
 * Generate an OAuth authorization URL. Returns the URL and stores pending state.
 * Called by /login command handler.
 *
 * `openId` 是发起这次授权的人。传了它，回调拿到的 token 就归属到那个人名下
 * （`user-token-<appId>-<openId>.json`），第二个人 /login 不会覆盖第一个人。
 */
export function generateAuthUrl(
  appId: string,
  appSecret: string,
  brand: Brand = 'feishu',
  extraScopes: string[] = [],
  openId?: string,
): { authUrl: string; state: string } {
  const state = randomBytes(32).toString('hex');
  const redirectUri = resolveOAuthRedirectUri();

  // 基础 scope + 调用方按需追加（去重）。文档订阅入口会带 DOC_COMMENT_OAUTH_SCOPES。
  const scope = [...new Set([...DEFAULT_SCOPES.split(' '), ...extraScopes])].join(' ');
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    scope,
  });

  // authorize 走 accounts host（feishu: accounts.feishu.cn / lark: accounts.larksuite.com）
  const authUrl = `${larkHosts(brand).accounts}/open-apis/authen/v1/authorize?${params.toString()}`;

  // Store pending state for verification (expires in 5 minutes)
  pendingLogins.set(state, {
    state,
    redirectUri,
    appId,
    appSecret,
    brand,
    ...(isUsableOpenId(openId) ? { openId } : {}),
    createdAt: Date.now(),
  });
  savePendingLogin(pendingLogins.get(state)!);

  // Clean up stale pending logins
  for (const [s, p] of pendingLogins) {
    if (Date.now() - p.createdAt > 5 * 60_000) pendingLogins.delete(s);
  }
  cleanupPendingLogins();

  return { authUrl, state };
}

/** Structured callback outcome for programmatic receivers (dashboard IPC).
 *  `matched=false` means the state belongs to another daemon process — the
 *  caller should try the next one rather than reporting failure. */
export interface CallbackHandleResult {
  matched: boolean;
  ok: boolean;
  message: string;
}

/**
 * Structured variant of handleCallbackUrl. Returns null when the URL is not a
 * callback at all; `{matched:false}` when the state is not pending in THIS
 * process (another daemon may own it).
 */
export async function tryHandleCallbackUrl(url: string): Promise<CallbackHandleResult | null> {
  const hasCode = /[?&]code=([^&]+)/.test(url);
  const hasState = /[?&]state=([^&]+)/.test(url);
  if (!hasCode || !hasState) return null;
  const state = decodeURIComponent(/[?&]state=([^&]+)/.exec(url)![1]);
  // Match-check from the SAME sources handleCallbackUrl consumes: in-memory
  // pending map OR the persisted pending-login file. The auth link may have
  // been generated by another process / module instance (dashboard broadcast
  // fans the callback out to every daemon), so a memory-only precheck would
  // reject perfectly valid disk-backed states (PR review).
  if (!(pendingLogins.get(state) ?? loadPendingLogin(state))) {
    return { matched: false, ok: false, message: 'state not pending for this app' };
  }
  const message = await handleCallbackUrl(url);
  if (message === null) return null;
  return { matched: true, ok: message.startsWith('✅'), message };
}

/**
 * Feed-group authorization status for the dashboard's session-group tag UI:
 * authorized = a stored token for this app carries the feed-group write scope
 * and is still usable (valid or refreshable).
 *
 * 飞书「消息分组」是某个人的收件箱侧边栏，bot 没有收件箱 —— 所以这里问的始终是
 * 「某个具体的人授权了没」。`openId` 给定时按人查，不给时沿用旧的 per-app 行为。
 */
export function getFeedGroupAuthStatus(
  appId: string,
  brand: Brand = 'feishu',
  ownerOpenId?: string,
): { authorized: boolean; expiresAt?: string } {
  try {
    // 与 resolveOwnerUserToken 同一条口径：优先 owner 自己的文件，回落到未标注归属
    // 的旧 per-app 文件，否则存量安装升级后徽标会莫名变成「未授权」。
    const loaded = loadTokenForApp(appId, brand, ownerOpenId, true);
    if (!loaded) return { authorized: false };
    const token = loaded.token;
    const scopes = (token.scope ?? '').split(/\s+/);
    if (!scopes.includes('im:feed_group_v1:write')) return { authorized: false };
    const refreshable = token.refresh_expires_at && new Date(token.refresh_expires_at) > new Date();
    const valid = token.expires_at && new Date(token.expires_at) > new Date();
    if (!valid && !refreshable) return { authorized: false };
    return { authorized: true, expiresAt: token.refresh_expires_at || token.expires_at };
  } catch {
    return { authorized: false };
  }
}

/**
 * 用刚拿到的 access_token 回读授权人是谁。
 *
 * OAuth token 响应本身不带 open_id，所以归属只能靠这一步确认。它同时是一道防线：
 * /login 链接可能被转给别人点，如果不核对，B 点了 A 的链接就会把 B 的 token 存到
 * A 名下 —— 之后 A 的每次操作都在用 B 的权限，且无声无息。
 */
async function fetchAuthorizedUser(
  accessToken: string,
  brand: Brand,
): Promise<{ openId?: string; userName?: string }> {
  try {
    const res = await fetch(`${larkHosts(brand).openApi}/open-apis/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return {};
    const body = await res.json() as { code?: number; data?: { open_id?: string; name?: string } };
    if (body.code !== 0 || !body.data) return {};
    return {
      ...(isUsableOpenId(body.data.open_id) ? { openId: body.data.open_id } : {}),
      ...(body.data.name ? { userName: body.data.name } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Try to parse a callback URL and exchange the code for a token.
 * Returns a success message or null if the URL is not a valid callback.
 */
export async function handleCallbackUrl(url: string): Promise<string | null> {
  // Match callback URL pattern
  const match = url.match(/[?&]code=([^&]+)/);
  const stateMatch = url.match(/[?&]state=([^&]+)/);
  if (!match || !stateMatch) return null;

  const code = decodeURIComponent(match[1]);
  const state = decodeURIComponent(stateMatch[1]);

  const pending = pendingLogins.get(state) ?? loadPendingLogin(state);
  if (!pending) {
    return '❌ 授权失败：state 不匹配或已过期，请重新发起授权';
  }

  pendingLogins.delete(state);
  removePendingLogin(state);

  // Exchange code for token
  try {
    const res = await fetch(`${larkHosts(pending.brand).openApi}/open-apis/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: pending.appId,
        client_secret: pending.appSecret,
        redirect_uri: pending.redirectUri,
      }),
    });

    if (!res.ok) {
      return `❌ 授权失败：Token 端点返回 HTTP ${res.status}`;
    }

    const data = await res.json() as TokenResponse;
    if (data.error || !data.access_token) {
      return `❌ 授权失败：${data.error_description || data.error || 'unknown error'}`;
    }

    const now = new Date();
    // 归属以「实际完成授权的那个人」为准，回读 user_info 得到。发起人 open_id 只作
    // 校验对照：不一致说明链接被转给了别人点，此时按真实授权人落盘并明确告知，绝不
    // 把 B 的凭证存到 A 名下。
    const authorized = await fetchAuthorizedUser(data.access_token, pending.brand);
    const ownerOpenId = authorized.openId ?? pending.openId;
    const mismatched = isUsableOpenId(pending.openId)
      && isUsableOpenId(authorized.openId)
      && pending.openId !== authorized.openId;

    const token: TokenStore = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_type: data.token_type,
      expires_at: new Date(now.getTime() + data.expires_in * 1000).toISOString(),
      refresh_expires_at: data.refresh_token_expires_in > 0
        ? new Date(now.getTime() + data.refresh_token_expires_in * 1000).toISOString()
        : '',
      scope: data.scope,
      appId: pending.appId,
      brand: pending.brand,
      ...(isUsableOpenId(ownerOpenId) ? { openId: ownerOpenId } : {}),
      ...(authorized.userName ? { userName: authorized.userName } : {}),
    };

    saveTokenForApp(token, pending.appId, ownerOpenId);
    logger.info(
      `[user-token] OAuth login successful, token saved for ${pending.appId}`
      + (isUsableOpenId(ownerOpenId) ? ` (per-user)` : ` (per-app, no owner resolved)`),
    );

    const expiresAt = new Date(token.expires_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const who = authorized.userName ? `${authorized.userName} ` : '';
    return mismatched
      ? `✅ 授权成功，Token 已保存给实际完成授权的账号${who ? `（${authorized.userName}）` : ''}。\n`
        + `注意：这与发起 /login 的账号不是同一个人 —— 如果不是你本人操作，请让本人重新 /login。\n`
        + `有效期至 ${expiresAt}，过期后自动刷新。`
      : `✅ ${who}授权成功！Token 已保存。\n有效期至 ${expiresAt}，过期后自动刷新。`;
  } catch (err: any) {
    return `❌ 授权失败：${err.message}`;
  }
}

/**
 * Check if a message looks like an OAuth callback URL.
 */
export function isCallbackUrl(text: string): boolean {
  return /^https?:\/\/127\.0\.0\.1[:/].*[?&]code=/.test(text.trim());
}

/**
 * Get current token status for /login status display.
 *
 * 传 `openId` → 报「你自己」授权了没（trigger-user 场景，别人的状态与你无关）。
 * 不传 → 报这个 bot 有没有任何可用的 per-app / 旧单文件 token（旧行为）。
 */
export function getTokenStatus(appId: string, brand: Brand = 'feishu', openId?: string): string {
  const loaded = loadTokenForApp(appId, brand, openId);
  if (!loaded) return '未登录（无 User Token）';

  const { token, source } = loaded;
  const accessValid = isValid(token.expires_at);
  const refreshValid = isValid(token.refresh_expires_at) || (!token.refresh_expires_at && !!token.refresh_token);
  const who = token.userName ? `${token.userName}，` : '';

  if (accessValid) {
    const expiresAt = new Date(token.expires_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return `已登录（${who}来源: ${source}）\nToken 有效至 ${expiresAt}`;
  }
  if (refreshValid) {
    return `已登录但 Token 已过期，将在下次使用时自动刷新（${who}来源: ${source}）`;
  }
  return `Token 已过期且无法刷新，请重新 /login（${who}来源: ${source}）`;
}
