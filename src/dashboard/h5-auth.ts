import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Brand } from '../im/lark/lark-hosts.js';
import { larkHosts } from '../im/lark/lark-hosts.js';
import {
  controlAuditRecord,
  type ControlAuditSink,
} from './control-audit.js';

export const DASHBOARD_SESSION_COOKIE = 'botmux_dashboard_session';
export const DEFAULT_DASHBOARD_SESSION_TTL_MS = 30 * 60_000;
export const DASHBOARD_H5_CLIENT_TIMEOUT_MS = 8_000;
const MAX_AUTH_BODY_BYTES = 4 * 1024;
const DEFAULT_EXCHANGE_TIMEOUT_MS = 8_000;

export interface DashboardH5AuthConfig {
  enabled: boolean;
  brand: Brand;
  appId: string;
  appSecret: string;
  allowedOpenIds: readonly string[];
  entryPath: string;
  sessionTtlMs: number;
  secureCookies: boolean;
}

export interface DashboardAuthIdentity {
  kind: 'feishu-h5';
  userId: string;
  authSessionId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface FeishuH5CodeExchanger {
  exchange(code: string, signal?: AbortSignal): Promise<{ openId: string }>;
}

export type DashboardSessionEndReason = 'expired' | 'logout';

interface StoredDashboardSession extends DashboardAuthIdentity {
  tokenHash: string;
  timer?: ReturnType<typeof setTimeout>;
}

export interface DashboardSessionStoreOptions {
  ttlMs?: number;
  now?: () => number;
  randomToken?: () => string;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

function tokenHash(token: string): string {
  return createHash('sha256').update('botmux-dashboard-h5-session-v1\0').update(token).digest('base64url');
}

function validTtl(ttlMs: number): boolean {
  return Number.isSafeInteger(ttlMs) && ttlMs >= 60_000 && ttlMs <= 24 * 60 * 60_000;
}

/**
 * In-memory fixed-expiry Dashboard sessions. Only SHA-256 token digests are
 * retained; the opaque browser cookie value exists only during Set-Cookie and
 * request parsing. A dashboard restart intentionally signs everyone out.
 */
export class DashboardSessionStore {
  private readonly sessionsByHash = new Map<string, StoredDashboardSession>();
  private readonly hashesById = new Map<string, string>();
  private readonly listeners = new Set<(identity: DashboardAuthIdentity, reason: DashboardSessionEndReason) => void>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;

  constructor(opts: DashboardSessionStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_DASHBOARD_SESSION_TTL_MS;
    if (!validTtl(this.ttlMs)) throw new RangeError('dashboard session TTL must be between 1 minute and 24 hours');
    this.now = opts.now ?? Date.now;
    this.randomToken = opts.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.schedule = opts.setTimer ?? setTimeout;
    this.cancel = opts.clearTimer ?? clearTimeout;
  }

  create(userId: string): { token: string; identity: DashboardAuthIdentity } {
    if (!validOpenId(userId)) throw new Error('invalid dashboard session user');
    const now = this.now();
    const token = this.randomToken();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('invalid dashboard session token source');
    const identity: DashboardAuthIdentity = {
      kind: 'feishu-h5',
      userId,
      authSessionId: randomBytes(18).toString('base64url'),
      issuedAt: now,
      expiresAt: now + this.ttlMs,
    };
    const hash = tokenHash(token);
    const stored: StoredDashboardSession = { ...identity, tokenHash: hash };
    stored.timer = this.schedule(() => { this.expireHash(hash); }, this.ttlMs);
    stored.timer.unref?.();
    this.sessionsByHash.set(hash, stored);
    this.hashesById.set(identity.authSessionId, hash);
    return { token, identity };
  }

  resolveToken(token: string | undefined): DashboardAuthIdentity | null {
    if (!token || token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const hash = tokenHash(token);
    const stored = this.sessionsByHash.get(hash);
    if (!stored) return null;
    if (this.now() >= stored.expiresAt) {
      this.expireHash(hash);
      return null;
    }
    return this.publicIdentity(stored);
  }

  revokeToken(token: string | undefined): boolean {
    if (!token || token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) return false;
    return this.endHash(tokenHash(token), 'logout');
  }

  revokeAuthSession(authSessionId: string, reason: DashboardSessionEndReason = 'logout'): boolean {
    const hash = this.hashesById.get(authSessionId);
    return hash ? this.endHash(hash, reason) : false;
  }

  sweepExpired(): number {
    const before = this.sessionsByHash.size;
    for (const [hash, session] of this.sessionsByHash) {
      if (this.now() >= session.expiresAt) this.expireHash(hash);
    }
    return before - this.sessionsByHash.size;
  }

  onEnd(listener: (identity: DashboardAuthIdentity, reason: DashboardSessionEndReason) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private expireHash(hash: string): boolean {
    return this.endHash(hash, 'expired');
  }

  private endHash(hash: string, reason: DashboardSessionEndReason): boolean {
    const stored = this.sessionsByHash.get(hash);
    if (!stored) return false;
    this.sessionsByHash.delete(hash);
    this.hashesById.delete(stored.authSessionId);
    if (stored.timer) this.cancel(stored.timer);
    const identity = this.publicIdentity(stored);
    for (const listener of this.listeners) {
      try { listener(identity, reason); } catch { /* listeners are isolation boundaries */ }
    }
    return true;
  }

  private publicIdentity(stored: StoredDashboardSession): DashboardAuthIdentity {
    return {
      kind: 'feishu-h5',
      userId: stored.userId,
      authSessionId: stored.authSessionId,
      issuedAt: stored.issuedAt,
      expiresAt: stored.expiresAt,
    };
  }
}

export function validOpenId(value: string): boolean {
  return value.length >= 3 && value.length <= 256 && !/[\s\0]/.test(value);
}

export function parseNamedCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

export function dashboardSessionCookie(token: string, ttlMs: number, secure = false): string {
  const maxAge = Math.max(1, Math.floor(ttlMs / 1000));
  return `${DASHBOARD_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearDashboardSessionCookie(secure = false): string {
  return `${DASHBOARD_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function resolveDashboardH5AuthConfig(env: NodeJS.ProcessEnv = process.env): DashboardH5AuthConfig {
  const entryCandidate = env.BOTMUX_DASHBOARD_FEISHU_H5_ENTRY_PATH?.trim() || '/auth/feishu';
  const entryPath = /^\/[A-Za-z0-9/_-]{1,127}$/.test(entryCandidate) && !entryCandidate.includes('//')
    ? entryCandidate.replace(/\/$/, '')
    : '/auth/feishu';
  const rawTtl = Number(env.BOTMUX_DASHBOARD_FEISHU_H5_SESSION_TTL_MS);
  const sessionTtlMs = validTtl(rawTtl) ? rawTtl : DEFAULT_DASHBOARD_SESSION_TTL_MS;
  const publicUrl = env.BOTMUX_PUBLIC_URL?.trim() ?? '';
  return {
    enabled: (env.BOTMUX_DASHBOARD_FEISHU_H5_ENABLED ?? 'false').toLowerCase() === 'true',
    brand: env.BOTMUX_DASHBOARD_FEISHU_H5_BRAND === 'lark' ? 'lark' : 'feishu',
    appId: env.BOTMUX_DASHBOARD_FEISHU_H5_APP_ID?.trim() || '',
    appSecret: env.BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET?.trim() || '',
    allowedOpenIds: (env.BOTMUX_DASHBOARD_FEISHU_H5_ALLOWED_OPEN_IDS ?? '')
      .split(',').map(value => value.trim()).filter(validOpenId),
    entryPath,
    sessionTtlMs,
    secureCookies: publicUrl.startsWith('https://')
      || (env.BOTMUX_DASHBOARD_FEISHU_H5_SECURE_COOKIE ?? '').toLowerCase() === 'true',
  };
}

export interface FeishuH5CodeExchangerOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface FeishuEnvelope {
  code?: unknown;
  app_access_token?: unknown;
  data?: Record<string, unknown>;
}

/**
 * Feishu H5 `requestAccess` / `requestAuthCode` compatible exchange. Tokens
 * from Feishu stay in local variables long enough to fetch `open_id` and are
 * never cached, logged, returned, or copied into the Dashboard session.
 */
export function createFeishuH5CodeExchanger(
  config: Pick<DashboardH5AuthConfig, 'brand' | 'appId' | 'appSecret'>,
  opts: FeishuH5CodeExchangerOptions = {},
): FeishuH5CodeExchanger {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;
  const base = larkHosts(config.brand).openApi;
  return {
    async exchange(code: string, outerSignal?: AbortSignal): Promise<{ openId: string }> {
      if (!config.appId || !config.appSecret) throw new Error('auth_not_configured');
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      outerSignal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const appResponse = await fetchImpl(`${base}/open-apis/auth/v3/app_access_token/internal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
          signal: controller.signal,
        });
        const appBody = await appResponse.json().catch(() => null) as FeishuEnvelope | null;
        const appAccessToken = appBody?.code === 0 && typeof appBody.app_access_token === 'string'
          ? appBody.app_access_token
          : undefined;
        if (!appResponse.ok || !appAccessToken) throw new Error('provider_rejected');

        const userResponse = await fetchImpl(`${base}/open-apis/authen/v1/access_token`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            authorization: `Bearer ${appAccessToken}`,
          },
          body: JSON.stringify({ grant_type: 'authorization_code', code }),
          signal: controller.signal,
        });
        const userBody = await userResponse.json().catch(() => null) as FeishuEnvelope | null;
        if (!userResponse.ok || userBody?.code !== 0 || !userBody.data) throw new Error('provider_rejected');
        const directOpenId = userBody.data.open_id;
        if (typeof directOpenId === 'string' && validOpenId(directOpenId)) return { openId: directOpenId };

        // Some compatible responses only return user_access_token. Resolve the
        // identity and immediately discard that token as well.
        const userAccessToken = userBody.data.access_token;
        if (typeof userAccessToken !== 'string' || !userAccessToken) throw new Error('provider_identity_missing');
        const infoResponse = await fetchImpl(`${base}/open-apis/authen/v1/user_info`, {
          headers: {
            authorization: `Bearer ${userAccessToken}`,
            'content-type': 'application/json; charset=utf-8',
          },
          signal: controller.signal,
        });
        const infoBody = await infoResponse.json().catch(() => null) as FeishuEnvelope | null;
        const openId = infoBody?.data?.open_id;
        if (!infoResponse.ok || infoBody?.code !== 0 || typeof openId !== 'string' || !validOpenId(openId)) {
          throw new Error('provider_identity_missing');
        }
        return { openId };
      } finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

export interface DashboardH5AuthControllerOptions {
  config: DashboardH5AuthConfig;
  sessions: DashboardSessionStore;
  exchanger?: FeishuH5CodeExchanger;
  audit: ControlAuditSink;
}

export interface DashboardH5AuthController {
  entryPath: string;
  exchangePath: string;
  sessionPath: string;
  logoutPath: string;
  resolve(req: IncomingMessage): DashboardAuthIdentity | null;
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

async function readCode(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAX_AUTH_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
  const code = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { code?: unknown }).code
    : undefined;
  return typeof code === 'string' && code.length >= 4 && code.length <= 2_048 && !/[\s\0]/.test(code)
    ? code
    : null;
}

export function safeDashboardH5ReturnTo(value: string | null | undefined): string {
  if (!value || value.length > 1_024 || !value.startsWith('/#/agent-workbench')) return '/';
  const hash = value.slice(1).split('?')[0].replace(/\/+$/, '');
  const bases = ['#/agent-workbench-dock', '#/agent-workbench'];
  for (const base of bases) {
    if (hash === base) return `/${base}`;
    if (!hash.startsWith(`${base}/`)) continue;
    const encoded = hash.slice(base.length + 1);
    let decoded: string;
    try { decoded = decodeURIComponent(encoded); } catch { return '/'; }
    if (!decoded || decoded.length > 512 || /[\u0000-\u001f\u007f]/.test(decoded)) return '/';
    return `/${base}/${encodeURIComponent(decoded)}`;
  }
  return '/';
}

function h5EntryHtml(appId: string, exchangePath: string, returnTo = '/'): string {
  const safeAppId = JSON.stringify(appId).replace(/</g, '\\u003c');
  const safeExchangePath = JSON.stringify(exchangePath).replace(/</g, '\\u003c');
  const safeReturnTo = JSON.stringify(safeDashboardH5ReturnTo(returnTo)).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Botmux Dashboard 登录</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f6f8;font:15px/1.6 system-ui;color:#1f2329}.card{max-width:420px;margin:24px;padding:28px;border:1px solid #d0d3d8;border-radius:4px;background:#fff}h1{font-size:20px;margin:0 0 8px}p{color:#646a73}button{border:1px solid #3370ff;border-radius:2px;padding:9px 18px;background:#fff;color:#245bdb}#error{color:#d54941}</style>
</head>
<body><main class="card"><h1>正在验证飞书身份</h1><p id="status">请在飞书客户端中打开此入口。</p><p id="error" role="alert"></p><button id="retry" hidden>重试</button></main>
<script>(function(){
var appId=${safeAppId},endpoint=${safeExchangePath},returnTo=${safeReturnTo},status=document.getElementById('status'),error=document.getElementById('error'),retry=document.getElementById('retry'),attempt=0,timer=0,controller=null,sdkScript=null,timeoutMs=${DASHBOARD_H5_CLIENT_TIMEOUT_MS},sdkUrl='https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.44.js';
function fail(id){if(id!==undefined&&id!==attempt)return;if(controller){controller.abort();controller=null}if(sdkScript){sdkScript.onload=sdkScript.onerror=null;sdkScript.remove();sdkScript=null}clearTimeout(timer);timer=0;attempt++;status.textContent='未能完成免登。';error.textContent='请确认正在飞书客户端中打开，或联系管理员检查入口配置。';retry.hidden=false}
function exchange(code,id){if(id!==attempt)return;controller=typeof AbortController==='function'?new AbortController():null;fetch(endpoint,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({code:code}),signal:controller?controller.signal:undefined}).then(function(r){if(!r.ok)throw new Error('denied');return r.json()}).then(function(){if(id!==attempt)return;clearTimeout(timer);timer=0;controller=null;location.replace(returnTo)}).catch(function(){fail(id)})}
function auth(id){if(id!==attempt)return;if(!window.tt){fail(id);return}var fallback=function(){if(id!==attempt)return;try{window.tt.requestAuthCode({appId:appId,success:function(r){exchange(r&&r.code,id)},fail:function(){fail(id)}})}catch(e){fail(id)}};try{if(window.tt.requestAccess){window.tt.requestAccess({appID:appId,scopeList:[],success:function(r){exchange(r&&r.code,id)},fail:function(e){if(e&&e.errno===103)fallback();else fail(id)}})}else fallback()}catch(e){fail(id)}}
function ready(id){if(id!==attempt)return;try{if(window.h5sdk&&window.h5sdk.ready)window.h5sdk.ready(function(){auth(id)});else auth(id)}catch(e){fail(id)}}
function loadSdk(id){if(window.tt||window.h5sdk){ready(id);return}sdkScript=document.createElement('script');sdkScript.src=sdkUrl;sdkScript.async=true;sdkScript.referrerPolicy='no-referrer';sdkScript.onload=function(){sdkScript=null;ready(id)};sdkScript.onerror=function(){sdkScript=null;fail(id)};document.head.appendChild(sdkScript)}
function begin(){var id=++attempt;if(controller){controller.abort();controller=null}if(sdkScript){sdkScript.onload=sdkScript.onerror=null;sdkScript.remove();sdkScript=null}clearTimeout(timer);error.textContent='';retry.hidden=true;status.textContent='正在验证飞书身份…';timer=setTimeout(function(){fail(id)},timeoutMs);loadSdk(id)}
retry.addEventListener('click',begin);begin();
})();</script></body></html>`;
}

export function createDashboardH5AuthController(opts: DashboardH5AuthControllerOptions): DashboardH5AuthController {
  const { config, sessions, audit } = opts;
  const exchanger = opts.exchanger ?? createFeishuH5CodeExchanger(config);
  const allowed = new Set(config.allowedOpenIds);
  const entryPath = config.entryPath;
  const exchangePath = `${entryPath}/exchange`;
  const sessionPath = `${entryPath}/session`;
  const logoutPath = `${entryPath}/logout`;
  const resolve = (req: IncomingMessage) => sessions.resolveToken(
    parseNamedCookie(req.headers.cookie, DASHBOARD_SESSION_COOKIE),
  );

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const relevant = url.pathname === entryPath || url.pathname === exchangePath
      || url.pathname === sessionPath || url.pathname === logoutPath;
    if (!relevant) return false;
    if (!config.enabled) {
      json(res, 404, { ok: false, error: 'h5_auth_disabled' });
      return true;
    }
    if (!config.appId || !config.appSecret || allowed.size === 0) {
      json(res, 503, { ok: false, error: 'h5_auth_not_configured' });
      return true;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === entryPath) {
      const body = h5EntryHtml(config.appId, exchangePath, url.searchParams.get('returnTo') ?? '/');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline' https://lf-scm-cn.feishucdn.com; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'self' https://*.feishu.cn https://*.larksuite.com",
      });
      if (req.method === 'HEAD') res.end(); else res.end(body);
      return true;
    }

    if (req.method === 'POST' && url.pathname === exchangePath) {
      // Requiring JSON makes cross-origin browser submission non-simple: a
      // hostile origin must pass a CORS preflight, and this controller exposes
      // no CORS permission. Plain HTML forms/text bodies therefore cannot turn
      // a one-time code into a login-CSRF cookie.
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        json(res, 415, { ok: false, error: 'unsupported_media_type' });
        return true;
      }
      const code = await readCode(req);
      if (!code) {
        json(res, 400, { ok: false, error: 'invalid_authorization_code' });
        return true;
      }
      let openId: string;
      try {
        ({ openId } = await exchanger.exchange(code));
      } catch {
        audit.append(controlAuditRecord('unknown', 'dashboard', 'auth.login_denied'));
        json(res, 502, { ok: false, error: 'feishu_exchange_failed' });
        return true;
      }
      if (!allowed.has(openId)) {
        audit.append(controlAuditRecord(openId, 'dashboard', 'auth.login_denied'));
        json(res, 403, { ok: false, error: 'open_id_not_allowed' });
        return true;
      }
      const created = sessions.create(openId);
      audit.append(controlAuditRecord(openId, 'dashboard', 'auth.login'));
      json(res, 200, {
        ok: true,
        user: { openId },
        expiresAt: created.identity.expiresAt,
        redirectTo: '/',
      }, { 'set-cookie': dashboardSessionCookie(created.token, config.sessionTtlMs, config.secureCookies) });
      return true;
    }

    if (req.method === 'GET' && url.pathname === sessionPath) {
      const identity = resolve(req);
      if (!identity) {
        json(res, 401, { ok: false, error: 'authentication_required' });
      } else {
        json(res, 200, { ok: true, user: { openId: identity.userId }, expiresAt: identity.expiresAt });
      }
      return true;
    }

    if (req.method === 'POST' && url.pathname === logoutPath) {
      const identity = resolve(req);
      if (!identity) {
        json(res, 401, { ok: false, error: 'authentication_required' });
        return true;
      }
      const token = parseNamedCookie(req.headers.cookie, DASHBOARD_SESSION_COOKIE);
      sessions.revokeToken(token);
      audit.append(controlAuditRecord(identity.userId, 'dashboard', 'auth.logout'));
      json(res, 200, { ok: true }, { 'set-cookie': clearDashboardSessionCookie(config.secureCookies) });
      return true;
    }

    json(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  };

  return { entryPath, exchangePath, sessionPath, logoutPath, resolve, handle };
}
