/**
 * User Access Token — self-contained OAuth token management for botmux.
 *
 * Token storage priority (read):
 *   1. FEISHU_USER_ACCESS_TOKEN env var
 *   2. ~/.botmux/data/user-token.json  (botmux's own)
 *   3. ~/.feishu-cli/token.json         (feishu-cli compatibility)
 *
 * OAuth login via /login command writes to botmux's own token file.
 * Auto-refreshes expired access_token using refresh_token.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { logger } from './logger.js';

// ─── Token paths ──────────────────────────────────────────────────────────────

const BOTMUX_TOKEN_PATH = join(homedir(), '.botmux', 'data', 'user-token.json');
const FEISHU_CLI_TOKEN_PATH = join(homedir(), '.feishu-cli', 'token.json');
const BUFFER_MS = 60_000; // 60s safety margin before expiry

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenStore {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: string;           // ISO 8601
  refresh_expires_at: string;   // ISO 8601
  scope: string;
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

function saveToken(token: TokenStore, path: string = BOTMUX_TOKEN_PATH): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(token, null, 2));
}

function isValid(isoDate: string): boolean {
  if (!isoDate) return false;
  return Date.now() + BUFFER_MS < new Date(isoDate).getTime();
}

/** Load token from botmux's own file, then feishu-cli as fallback. */
function loadToken(): { token: TokenStore; source: string } | null {
  const own = loadTokenFromPath(BOTMUX_TOKEN_PATH);
  if (own) return { token: own, source: 'botmux' };

  const cli = loadTokenFromPath(FEISHU_CLI_TOKEN_PATH);
  if (cli) return { token: cli, source: 'feishu-cli' };

  return null;
}

// ─── Token refresh ────────────────────────────────────────────────────────────

async function refreshToken(token: TokenStore, appId: string, appSecret: string): Promise<TokenStore | null> {
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
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
    };

    // Always write to botmux's own file
    try { saveToken(updated); } catch { /* best-effort */ }
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
export async function resolveUserToken(appId: string, appSecret: string): Promise<string | null> {
  // 1. Environment variable
  const envToken = process.env.FEISHU_USER_ACCESS_TOKEN;
  if (envToken) return envToken;

  // 2. Token files (botmux own → feishu-cli fallback)
  const loaded = loadToken();
  if (!loaded) return null;

  const { token } = loaded;

  if (isValid(token.expires_at)) {
    return token.access_token;
  }

  // access_token expired — try refresh
  if (isValid(token.refresh_expires_at) || (!token.refresh_expires_at && token.refresh_token)) {
    const refreshed = await refreshToken(token, appId, appSecret);
    if (refreshed) return refreshed.access_token;
  }

  logger.debug('[user-token] Token expired and refresh_token also expired');
  return null;
}

// ─── Public API: OAuth login flow ─────────────────────────────────────────────

const FEISHU_AUTH_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const DEFAULT_PORT = 9768;
const DEFAULT_SCOPES = [
  'im:message:readonly',
  'im:resource',
].join(' ');

/**
 * Generate an OAuth authorization URL. Returns the URL and stores pending state.
 * Called by /login command handler.
 */
export function generateAuthUrl(appId: string, appSecret: string): { authUrl: string; state: string } {
  const state = randomBytes(32).toString('hex');
  const redirectUri = `http://127.0.0.1:${DEFAULT_PORT}/callback`;

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    scope: DEFAULT_SCOPES,
  });

  const authUrl = `${FEISHU_AUTH_URL}?${params.toString()}`;

  // Store pending state for verification (expires in 5 minutes)
  pendingLogins.set(state, {
    state,
    redirectUri,
    appId,
    appSecret,
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
    const res = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
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
    };

    saveToken(token);
    logger.info('[user-token] OAuth login successful, token saved');

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
 * Get current token status for /login status display.
 */
export function getTokenStatus(): string {
  const loaded = loadToken();
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
