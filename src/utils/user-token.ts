/**
 * User Access Token — self-contained OAuth token management for botmux.
 *
 * Token storage:
 *   1. FEISHU_USER_ACCESS_TOKEN env var
 *   2. ~/.botmux/data/user-token.json
 *
 * OAuth login via /login command writes to botmux's own token file.
 * Auto-refreshes expired access_token using refresh_token.
 */
import { readFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { atomicWriteFileSync } from './atomic-write.js';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { logger } from './logger.js';
import { type Brand, larkHosts } from '../im/lark/lark-hosts.js';
import { readGlobalConfig } from '../global-config.js';

// ─── Token paths ──────────────────────────────────────────────────────────────

const TOKEN_DIR = join(homedir(), '.botmux', 'data');
const PENDING_DIR = join(TOKEN_DIR, 'oauth-pending');
/** 旧版单文件（升级前都是单 feishu bot）。仅作向后兼容读取，不再写入。 */
const LEGACY_TOKEN_PATH = join(TOKEN_DIR, 'user-token.json');
const BUFFER_MS = 60_000; // 60s safety margin before expiry

/**
 * Per-app token 文件：`~/.botmux/data/user-token-<appId>.json`。
 * 一台机器混挂 Feishu + Lark 多 bot 时，各自的 User Token 互不覆盖、互不串用。
 */
function tokenPathForApp(appId: string): string {
  return join(TOKEN_DIR, `user-token-${appId}.json`);
}

function tokenPathForOwner(appId: string, ownerOpenId: string): string {
  const ownerKey = createHash('sha256').update(ownerOpenId).digest('hex').slice(0, 20);
  return join(TOKEN_DIR, `user-token-${appId}-${ownerKey}.json`);
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
  /** OAuth token subject. Required for owner-scoped personal-data operations. */
  ownerOpenId?: string;
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
  open_id?: string;
}

// ─── Pending login state ──────────────────────────────────────────────────────

interface PendingLogin {
  state: string;
  redirectUri: string;
  appId: string;
  appSecret: string;
  /** 租户品牌——决定回调换 token 时打哪个域名。缺省 feishu。 */
  brand: Brand;
  /** Expected OAuth subject for owner-scoped flows. */
  ownerOpenId?: string;
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

function saveTokenForApp(token: TokenStore, appId: string, ownerOpenId?: string): void {
  const path = ownerOpenId ? tokenPathForOwner(appId, ownerOpenId) : tokenPathForApp(appId);
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
 * 取指定 app 的 token。优先 per-app 文件，其次回退旧的单文件；两者都过
 * {@link tokenMatches} 校验（文件名 + 内容双重把关），不匹配一律视为无 token。
 */
function loadTokenForApp(appId: string, brand: Brand, ownerOpenId?: string): { token: TokenStore; source: string } | null {
  if (ownerOpenId) {
    const token = loadTokenFromPath(tokenPathForOwner(appId, ownerOpenId));
    if (token && tokenMatches(token, appId, brand) && token.ownerOpenId === ownerOpenId) {
      return { token, source: 'botmux(owner)' };
    }
    return null;
  }
  const perApp = loadTokenFromPath(tokenPathForApp(appId));
  if (perApp && tokenMatches(perApp, appId, brand)) return { token: perApp, source: 'botmux' };
  const legacy = loadTokenFromPath(LEGACY_TOKEN_PATH);
  if (legacy && tokenMatches(legacy, appId, brand)) return { token: legacy, source: 'botmux(legacy)' };
  return null;
}

// ─── Token refresh ────────────────────────────────────────────────────────────

async function refreshToken(token: TokenStore, appId: string, appSecret: string, brand: Brand = 'feishu', ownerOpenId?: string): Promise<TokenStore | null> {
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
      ...(ownerOpenId ? { ownerOpenId } : {}),
    };

    // Write to this app's own token file (per-app, brand-stamped)
    try { saveTokenForApp(updated, appId, ownerOpenId); } catch { /* best-effort */ }
    logger.info('[user-token] Refreshed User Access Token');
    return updated;
  } catch (err: any) {
    logger.debug(`[user-token] Refresh failed: ${err.message}`);
    return null;
  }
}

// ─── Public API: resolve token ────────────────────────────────────────────────

/**
 * Resolve a valid User Access Token.
 * Returns access_token string, or null if unavailable.
 */
export async function resolveUserToken(appId: string, appSecret: string, brand: Brand = 'feishu', ownerOpenId?: string): Promise<string | null> {
  // 1. Environment variable (explicit global override)
  const envToken = process.env.FEISHU_USER_ACCESS_TOKEN;
  if (envToken && !ownerOpenId) return envToken;

  // 2. Per-app token file (mismatched / 别的 bot 的 token → null，调用方提示 /login)
  const loaded = loadTokenForApp(appId, brand, ownerOpenId);
  if (!loaded) return null;

  const { token } = loaded;

  if (isValid(token.expires_at)) {
    return token.access_token;
  }

  // access_token expired — try refresh
  if (isValid(token.refresh_expires_at) || (!token.refresh_expires_at && token.refresh_token)) {
    const refreshed = await refreshToken(token, appId, appSecret, brand, ownerOpenId);
    if (refreshed) return refreshed.access_token;
  }

  logger.debug('[user-token] Token expired and refresh_token also expired');
  return null;
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
 */
export function generateAuthUrl(appId: string, appSecret: string, brand: Brand = 'feishu', extraScopes: string[] = [], ownerOpenId?: string): { authUrl: string; state: string } {
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
    ...(ownerOpenId ? { ownerOpenId } : {}),
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
 */
export function getFeedGroupAuthStatus(appId: string, brand: Brand = 'feishu', ownerOpenId?: string): { authorized: boolean; expiresAt?: string } {
  try {
    if (!ownerOpenId) return { authorized: false };
    const loaded = loadTokenForApp(appId, brand, ownerOpenId);
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
    if (pending.ownerOpenId && data.open_id !== pending.ownerOpenId) {
      logger.warn(`[user-token] OAuth subject mismatch for ${pending.appId}`);
      return '❌ 授权失败：授权账号与发起授权的用户不一致，请使用正确账号重试';
    }

    const now = new Date();
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
      ...(pending.ownerOpenId ? { ownerOpenId: pending.ownerOpenId } : {}),
    };

    saveTokenForApp(token, pending.appId, pending.ownerOpenId);
    logger.info(`[user-token] OAuth login successful, token saved for ${pending.appId}`);

    const expiresAt = new Date(token.expires_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return `✅ 授权成功！Token 已保存。\n有效期至 ${expiresAt}，过期后自动刷新。`;
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
 * Get current token status for /login status display. Per-app: reports the
 * token belonging to this bot (appId/brand), not whatever was last written.
 */
export function getTokenStatus(appId: string, brand: Brand = 'feishu'): string {
  const loaded = loadTokenForApp(appId, brand);
  if (!loaded) return '未登录（无 User Token）';

  const { token, source } = loaded;
  const accessValid = isValid(token.expires_at);
  const refreshValid = isValid(token.refresh_expires_at) || (!token.refresh_expires_at && !!token.refresh_token);

  if (accessValid) {
    const expiresAt = new Date(token.expires_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return `已登录（来源: ${source}）\nToken 有效至 ${expiresAt}`;
  }
  if (refreshValid) {
    return `已登录但 Token 已过期，将在下次使用时自动刷新（来源: ${source}）`;
  }
  return `Token 已过期且无法刷新，请重新 /login（来源: ${source}）`;
}
