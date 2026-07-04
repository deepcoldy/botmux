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
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { atomicWriteFileSync } from './atomic-write.js';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { logger } from './logger.js';
import { type Brand, larkHosts } from '../im/lark/lark-hosts.js';

// ─── Token paths ──────────────────────────────────────────────────────────────

const TOKEN_DIR = join(homedir(), '.botmux', 'data');
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
  createdAt: number;
}

const pendingLogins = new Map<string, PendingLogin>(); // keyed by state

// ─── Token I/O ────────────────────────────────────────────────────────────────

function loadTokenFromPath(path: string): TokenStore | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function saveTokenForApp(token: TokenStore, appId: string): void {
  const path = tokenPathForApp(appId);
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
function loadTokenForApp(appId: string, brand: Brand): { token: TokenStore; source: string } | null {
  const perApp = loadTokenFromPath(tokenPathForApp(appId));
  if (perApp && tokenMatches(perApp, appId, brand)) return { token: perApp, source: 'botmux' };
  const legacy = loadTokenFromPath(LEGACY_TOKEN_PATH);
  if (legacy && tokenMatches(legacy, appId, brand)) return { token: legacy, source: 'botmux(legacy)' };
  return null;
}

// ─── Token refresh ────────────────────────────────────────────────────────────

async function refreshToken(token: TokenStore, appId: string, appSecret: string, brand: Brand = 'feishu'): Promise<TokenStore | null> {
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
    };

    // Write to this app's own token file (per-app, brand-stamped)
    try { saveTokenForApp(updated, appId); } catch { /* best-effort */ }
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
export async function resolveUserToken(appId: string, appSecret: string, brand: Brand = 'feishu'): Promise<string | null> {
  // 1. Environment variable (explicit global override)
  const envToken = process.env.FEISHU_USER_ACCESS_TOKEN;
  if (envToken) return envToken;

  // 2. Per-app token file (mismatched / 别的 bot 的 token → null，调用方提示 /login)
  const loaded = loadTokenForApp(appId, brand);
  if (!loaded) return null;

  const { token } = loaded;

  if (isValid(token.expires_at)) {
    return token.access_token;
  }

  // access_token expired — try refresh
  if (isValid(token.refresh_expires_at) || (!token.refresh_expires_at && token.refresh_token)) {
    const refreshed = await refreshToken(token, appId, appSecret, brand);
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
 * Generate an OAuth authorization URL. Returns the URL and stores pending state.
 * Called by /login command handler.
 */
export function generateAuthUrl(appId: string, appSecret: string, brand: Brand = 'feishu', extraScopes: string[] = []): { authUrl: string; state: string } {
  const state = randomBytes(32).toString('hex');
  const redirectUri = `http://127.0.0.1:${DEFAULT_PORT}/callback`;

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
    createdAt: Date.now(),
  });

  // Clean up stale pending logins
  for (const [s, p] of pendingLogins) {
    if (Date.now() - p.createdAt > 5 * 60_000) pendingLogins.delete(s);
  }

  return { authUrl, state };
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

  const pending = pendingLogins.get(state);
  if (!pending) {
    return '❌ 授权失败：state 不匹配或已过期，请重新执行 /login';
  }

  pendingLogins.delete(state);

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
    };

    saveTokenForApp(token, pending.appId);
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
