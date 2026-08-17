import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDashboardH5AuthController,
  createFeishuH5CodeExchanger,
  DASHBOARD_H5_CLIENT_TIMEOUT_MS,
  DASHBOARD_H5_EXCHANGE_MAX_CONCURRENT,
  DASHBOARD_H5_EXCHANGE_MAX_PER_IP_PER_WINDOW,
  DashboardH5ExchangeGate,
  dashboardH5ClientIp,
  DashboardSessionStore,
  DASHBOARD_SESSION_COOKIE,
  safeDashboardH5ReturnTo,
  type DashboardH5AuthConfig,
  type FeishuH5CodeExchanger,
} from '../src/dashboard/h5-auth.js';
import type { ControlAuditRecord, ControlAuditSink } from '../src/dashboard/control-audit.js';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthSessionConnectionRegistry } from '../src/dashboard/auth-session-connections.js';
import { createDashboardEventsStream } from '../src/dashboard/events-sse.js';
import { createSessionPreviewProxy } from '../src/dashboard/preview-proxy.js';
import {
  mintPreviewContentCapability,
  verifyPreviewContentCapability,
} from '../src/dashboard/preview-content-capability.js';
import { PREVIEW_CONTENT_SEGMENT } from '../src/core/session-preview.js';
import { parseNamedCookie } from '../src/dashboard/h5-auth.js';

const config: DashboardH5AuthConfig = {
  enabled: true,
  brand: 'feishu',
  appId: 'cli_test_app',
  appSecret: 'app-secret-never-exposed',
  allowedOpenIds: ['ou_allowed'],
  entryPath: '/auth/feishu',
  sessionTtlMs: 60_000,
  secureCookies: false,
};

class MemoryAudit implements ControlAuditSink {
  records: ControlAuditRecord[] = [];
  append(record: ControlAuditRecord): void { this.records.push(record); }
}

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

async function startController(
  openIdOrError: string | Error,
  nowRef = { value: 1_000 },
  opts: { exchanger?: FeishuH5CodeExchanger; exchangeGate?: DashboardH5ExchangeGate } = {},
): Promise<{
  base: string;
  audit: MemoryAudit;
  sessions: DashboardSessionStore;
  seen: { exchangePosts: number };
}> {
  const audit = new MemoryAudit();
  const sessions = new DashboardSessionStore({
    ttlMs: config.sessionTtlMs,
    now: () => nowRef.value,
    randomToken: () => 'A'.repeat(43),
  });
  const controller = createDashboardH5AuthController({
    config,
    sessions,
    audit,
    exchangeGate: opts.exchangeGate,
    exchanger: opts.exchanger ?? {
      exchange: vi.fn(async () => {
        if (openIdOrError instanceof Error) throw openIdOrError;
        return { openId: openIdOrError };
      }),
    },
  });
  const seen = { exchangePosts: 0 };
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dashboard.test');
    if (req.method === 'POST' && url.pathname === '/auth/feishu/exchange') seen.exchangePosts += 1;
    void controller.handle(req, res, url).then(handled => {
      if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, audit, sessions, seen };
}

function postExchange(base: string, code: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/auth/feishu/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ code }),
  });
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0];
}

describe('Feishu H5 passwordless dashboard auth', () => {
  it('exchanges a code into a fixed-expiry HttpOnly session without returning or URL-embedding a token', async () => {
    const nowRef = { value: 10_000 };
    const { base, audit } = await startController('ou_allowed', nowRef);
    const entry = await fetch(`${base}/auth/feishu`);
    expect(entry.status).toBe(200);
    const html = await entry.text();
    expect(html).toContain('requestAccess');
    expect(html).toContain('requestAuthCode');
    expect(html).toContain("document.createElement('script')");
    expect(html).toContain('window.h5sdk.ready(function(){auth(id)})');
    expect(html).toContain(`timeoutMs=${DASHBOARD_H5_CLIENT_TIMEOUT_MS}`);
    expect(html).toContain("typeof AbortController==='function'");
    expect(html).not.toContain(config.appSecret);

    const response = await fetch(`${base}/auth/feishu/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'one-time-code-do-not-log' }),
    });
    expect(response.status).toBe(200);
    const bodyText = await response.text();
    const body = JSON.parse(bodyText);
    expect(body).toEqual({
      ok: true,
      user: { openId: 'ou_allowed' },
      expiresAt: 70_000,
      redirectTo: '/',
    });
    expect(bodyText).not.toContain('one-time-code-do-not-log');
    expect(bodyText).not.toContain('A'.repeat(43));
    expect(response.url).not.toContain('code=');
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${DASHBOARD_SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const session = await fetch(`${base}/auth/feishu/session`, {
      headers: { cookie: cookiePair(setCookie) },
    });
    expect(await session.json()).toEqual({
      ok: true,
      user: { openId: 'ou_allowed' },
      expiresAt: 70_000,
    });
    expect(audit.records).toEqual([
      expect.objectContaining({ user: 'ou_allowed', session: 'dashboard', action: 'auth.login' }),
    ]);
    expect(JSON.stringify(audit.records)).not.toContain('one-time-code-do-not-log');
  });

  it('rejects an open_id outside the exact allowlist and mints no cookie', async () => {
    const { base, audit } = await startController('ou_stranger');
    const response = await fetch(`${base}/auth/feishu/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'valid-but-not-authorized' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'open_id_not_allowed' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(audit.records).toEqual([
      expect.objectContaining({ user: 'ou_stranger', session: 'dashboard', action: 'auth.login_denied' }),
    ]);
  });

  it('rejects simple cross-origin form media types before exchanging a code', async () => {
    const { base, audit } = await startController('ou_allowed');
    const response = await fetch(`${base}/auth/feishu/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ code: 'cross-origin-form-code' }),
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ ok: false, error: 'unsupported_media_type' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(audit.records).toHaveLength(0);
  });

  it('returns a bounded provider failure without credentials, provider detail, code, or cookie', async () => {
    const { base, audit } = await startController(new Error('upstream leaked app-secret-never-exposed'));
    const response = await fetch(`${base}/auth/feishu/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'secret-auth-code' }),
    });
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'feishu_exchange_failed' });
    expect(text).not.toContain(config.appSecret);
    expect(text).not.toContain('secret-auth-code');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(audit.records[0]).toEqual(expect.objectContaining({
      user: 'unknown', session: 'dashboard', action: 'auth.login_denied',
    }));
  });

  it('expires the Dashboard session at its fixed deadline', async () => {
    const nowRef = { value: 1_000 };
    const { base, sessions } = await startController('ou_allowed', nowRef);
    const response = await fetch(`${base}/auth/feishu/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'fresh-code' }),
    });
    const cookie = cookiePair(response.headers.get('set-cookie') ?? '');
    nowRef.value = 61_000;
    sessions.sweepExpired();
    const expired = await fetch(`${base}/auth/feishu/session`, { headers: { cookie } });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ ok: false, error: 'authentication_required' });
  });

  it('liveAuthSession answers the read-capability revocation check: logout and expiry both kill it', () => {
    // P1-5：终端只读能力绑定 authSessionId，front-proxy 用这个判定拒绝已注销/
    // 已过期登录还拿着未到期能力 URL 的重连。
    const nowRef = { value: 1_000 };
    const sessions = new DashboardSessionStore({ ttlMs: 60_000, now: () => nowRef.value });
    const a = sessions.create('ou_viewer_a').identity;
    const b = sessions.create('ou_viewer_b').identity;
    expect(sessions.liveAuthSession(a.authSessionId)).toBe(true);
    expect(sessions.liveAuthSession('never-existed')).toBe(false);

    // 注销立即失效，且不串到另一个登录。
    sessions.revokeAuthSession(a.authSessionId);
    expect(sessions.liveAuthSession(a.authSessionId)).toBe(false);
    expect(sessions.liveAuthSession(b.authSessionId)).toBe(true);

    // 到点未清扫的会话也答「死」，顺手当场清掉（onEnd 照常触发）。
    let ended = 0;
    sessions.onEnd(() => { ended += 1; });
    nowRef.value = 61_000;
    expect(sessions.liveAuthSession(b.authSessionId)).toBe(false);
    expect(ended).toBe(1);
  });

  it('supports a fully mocked Feishu exchange and discards provider access tokens', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/auth/v3/app_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, app_access_token: 'app-provider-token' }), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { open_id: 'ou_allowed', access_token: 'user-provider-token' },
      }), { status: 200 });
    });
    const exchanger = createFeishuH5CodeExchanger(config, { fetchImpl: fakeFetch as typeof fetch });
    const result = await exchanger.exchange('mock-code');
    expect(result).toEqual({ openId: 'ou_allowed' });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/auth/v3/app_access_token/internal');
    expect(calls[1].url).toContain('/authen/v1/access_token');
    expect(JSON.stringify(result)).not.toContain('app-provider-token');
    expect(JSON.stringify(result)).not.toContain('user-provider-token');
  });

  it('normalizes only Workbench appCenter/Dock return routes', () => {
    expect(safeDashboardH5ReturnTo('/#/agent-workbench/session%2Fone')).toBe('/#/agent-workbench/session%2Fone');
    expect(safeDashboardH5ReturnTo('/#/agent-workbench-dock/session%2Fone?ignored=1')).toBe('/#/agent-workbench-dock/session%2Fone');
    expect(safeDashboardH5ReturnTo('/#/agent-workbench-other')).toBe('/');
    expect(safeDashboardH5ReturnTo('/#/settings')).toBe('/');
    expect(safeDashboardH5ReturnTo('/#/agent-workbench/%E0%A4%A')).toBe('/');
  });

  it('429s exchange spam from one IP beyond the window budget, with Retry-After', async () => {
    const { base } = await startController('ou_allowed');
    for (let i = 0; i < DASHBOARD_H5_EXCHANGE_MAX_PER_IP_PER_WINDOW; i++) {
      expect((await postExchange(base, `fresh-code-${i}`)).status).toBe(200);
    }
    const limited = await postExchange(base, 'fresh-code-final');
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter) && retryAfter >= 1).toBe(true);
    expect(await limited.json()).toEqual({ ok: false, error: 'rate_limited', retryAfterSeconds: retryAfter });
    expect(limited.headers.get('set-cookie')).toBeNull();
  });

  it('buckets the rate limit by first x-forwarded-for hop, not by later proxy hops', async () => {
    const { base } = await startController('ou_allowed', undefined, {
      exchangeGate: new DashboardH5ExchangeGate({ maxPerIpPerWindow: 1 }),
    });
    expect((await postExchange(base, 'code-a', { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })).status).toBe(200);
    const sameClient = await postExchange(base, 'code-b', { 'x-forwarded-for': '203.0.113.7, 10.9.9.9' });
    expect(sameClient.status).toBe(429);
    expect(sameClient.headers.get('retry-after')).toBeTruthy();
    expect((await postExchange(base, 'code-c', { 'x-forwarded-for': '198.51.100.3' })).status).toBe(200);
    // No header at all falls back to the socket address — its own bucket.
    expect((await postExchange(base, 'code-d')).status).toBe(200);
  });

  it('shares one upstream flight across concurrent duplicates of the same code', async () => {
    let release!: () => void;
    const blocked = new Promise<{ openId: string }>(resolve => {
      release = () => resolve({ openId: 'ou_allowed' });
    });
    const exchange = vi.fn(() => blocked);
    const { base, seen } = await startController('ou_allowed', undefined, { exchanger: { exchange } });
    const first = postExchange(base, 'duplicate-code');
    const second = postExchange(base, 'duplicate-code');
    await vi.waitFor(() => {
      expect(seen.exchangePosts).toBe(2);
      expect(exchange).toHaveBeenCalledTimes(1);
    });
    // Both requests are on the server; give the duplicate a beat to join the
    // in-flight map before the shared exchange resolves.
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(r1.headers.get('set-cookie')).toContain(`${DASHBOARD_SESSION_COOKIE}=`);
    expect(r2.headers.get('set-cookie')).toContain(`${DASHBOARD_SESSION_COOKIE}=`);
  });

  it('fast-rejects distinct codes beyond the global in-flight cap and recovers after settle', async () => {
    const pending: Array<() => void> = [];
    let calls = 0;
    const exchange = vi.fn((): Promise<{ openId: string }> => {
      calls += 1;
      if (calls <= DASHBOARD_H5_EXCHANGE_MAX_CONCURRENT) {
        return new Promise(resolve => pending.push(() => resolve({ openId: 'ou_allowed' })));
      }
      return Promise.resolve({ openId: 'ou_allowed' });
    });
    const { base } = await startController('ou_allowed', undefined, { exchanger: { exchange } });
    const inFlight = Array.from(
      { length: DASHBOARD_H5_EXCHANGE_MAX_CONCURRENT },
      (_, i) => postExchange(base, `slow-code-${i}`),
    );
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledTimes(DASHBOARD_H5_EXCHANGE_MAX_CONCURRENT));
    const rejected = await postExchange(base, 'overflow-code');
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).toBe('1');
    expect(await rejected.json()).toEqual({ ok: false, error: 'exchange_busy', retryAfterSeconds: 1 });
    for (const releaseOne of pending) releaseOne();
    for (const settled of await Promise.all(inFlight)) expect(settled.status).toBe(200);
    // Slots freed on settle: the same total budget now admits a fresh code.
    expect((await postExchange(base, 'after-drain-code')).status).toBe(200);
  });
});

describe('DashboardH5ExchangeGate', () => {
  it('enforces the per-IP sliding window per bucket and recovers once hits expire', () => {
    let now = 0;
    const gate = new DashboardH5ExchangeGate({ now: () => now, windowMs: 60_000, maxPerIpPerWindow: 3 });
    expect(gate.admit('203.0.113.7')).toEqual({ ok: true });
    now = 10_000;
    expect(gate.admit('203.0.113.7')).toEqual({ ok: true });
    now = 20_000;
    expect(gate.admit('203.0.113.7')).toEqual({ ok: true });
    now = 30_000;
    // Oldest hit (t=0) leaves the window at t=60_000 → honest Retry-After.
    expect(gate.admit('203.0.113.7')).toEqual({ ok: false, retryAfterMs: 30_000 });
    expect(gate.admit('198.51.100.9')).toEqual({ ok: true });
    // Refusals must not consume slots: still refused, same deadline.
    expect(gate.admit('203.0.113.7')).toEqual({ ok: false, retryAfterMs: 30_000 });
    now = 60_001;
    expect(gate.admit('203.0.113.7')).toEqual({ ok: true });
  });

  it('dedupes in-flight keys ahead of the cap and frees slots when flights settle', async () => {
    const gate = new DashboardH5ExchangeGate({ maxConcurrent: 2 });
    const resolvers: Array<(v: { openId: string }) => void> = [];
    const start = vi.fn(() => new Promise<{ openId: string }>(resolve => resolvers.push(resolve)));
    const first = gate.share('code-a', start);
    const second = gate.share('code-b', start);
    expect(first.ok && second.ok).toBe(true);
    expect(gate.inFlightCount()).toBe(2);
    // Duplicate key joins the existing flight even with the cap saturated.
    const dup = gate.share('code-a', () => { throw new Error('duplicate must not start a new flight'); });
    if (!first.ok || !dup.ok) throw new Error('expected shared flight');
    expect(dup.result).toBe(first.result);
    expect(start).toHaveBeenCalledTimes(2);
    const overflow = gate.share('code-c', start);
    expect(overflow).toEqual({ ok: false, retryAfterMs: 1_000 });
    resolvers.forEach(resolve => resolve({ openId: 'ou_allowed' }));
    await expect(first.result).resolves.toEqual({ openId: 'ou_allowed' });
    await vi.waitFor(() => expect(gate.inFlightCount()).toBe(0));
    // Settled keys are gone: the same key starts a fresh flight next time.
    const again = gate.share('code-a', start);
    expect(again.ok).toBe(true);
    expect(start).toHaveBeenCalledTimes(3);
    resolvers.at(-1)?.({ openId: 'ou_allowed' });
  });

  it('failed flights clear the in-flight slot and reject every sharer alike', async () => {
    const gate = new DashboardH5ExchangeGate({ maxConcurrent: 1 });
    let reject!: (reason: Error) => void;
    const failing = gate.share('code-x', () => new Promise<never>((_resolve, rej) => { reject = rej; }));
    const joined = gate.share('code-x', () => { throw new Error('must not start'); });
    if (!failing.ok || !joined.ok) throw new Error('expected shared flight');
    reject(new Error('provider_rejected'));
    await expect(failing.result).rejects.toThrow('provider_rejected');
    await expect(joined.result).rejects.toThrow('provider_rejected');
    await vi.waitFor(() => expect(gate.inFlightCount()).toBe(0));
  });

  it('prunes idle IP buckets so the tracking map does not grow without bound', () => {
    let now = 0;
    const gate = new DashboardH5ExchangeGate({ now: () => now, windowMs: 60_000, pruneIntervalMs: 60_000 });
    for (let i = 0; i < 500; i++) gate.admit(`10.0.${Math.floor(i / 250)}.${i % 250}`);
    expect(gate.trackedIpCount()).toBe(500);
    now = 120_001;
    // Any admission past the prune interval sweeps every expired bucket.
    expect(gate.admit('203.0.113.99')).toEqual({ ok: true });
    expect(gate.trackedIpCount()).toBe(1);
    gate.prune();
    expect(gate.trackedIpCount()).toBe(1);
  });
});

describe('dashboardH5ClientIp', () => {
  const fakeReq = (headers: Record<string, string | string[]>, remoteAddress?: string): IncomingMessage =>
    ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

  it('prefers the first x-forwarded-for hop and falls back to the socket address', () => {
    expect(dashboardH5ClientIp(fakeReq({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, '10.0.0.1'))).toBe('203.0.113.7');
    expect(dashboardH5ClientIp(fakeReq({ 'x-forwarded-for': ['198.51.100.3', '10.0.0.1'] }, '10.0.0.1'))).toBe('198.51.100.3');
    expect(dashboardH5ClientIp(fakeReq({}, '192.168.1.9'))).toBe('192.168.1.9');
    expect(dashboardH5ClientIp(fakeReq({ 'x-forwarded-for': '  ' }, '192.168.1.9'))).toBe('192.168.1.9');
    expect(dashboardH5ClientIp(fakeReq({}, '::ffff:192.168.1.9'))).toBe('192.168.1.9');
    expect(dashboardH5ClientIp(fakeReq({}))).toBe('unknown');
  });
});

// ─── P1-8：身份结束（logout / token rotate）关闭全部长连接 ────────────────────
//
// 认证结束只关了前门：短请求立刻 401，但**已经建立**的 `/events` SSE 与 Preview
// WebSocket 是登出前握好的手，握完就一直流。旧的 management SSE 甚至会收到 rotate
// **之后**新产生的 `riffAccessUrl`——那是 Riff 沙箱的写凭据，rotate 的全部意义就是
// 让上一条链接失效。
//
// 这里起真实 HTTP 服务，跑真实的 SSE 与 WebSocket 握手，用真实的 logout 请求 /
// token rotate 触发吊销，断言连接真的断了、吊销后的帧一个字节也没送出去。
describe('P1-8 auth end closes every long-lived connection', () => {
  const PREVIEW_SECRET = 'preview-capability-secret-for-tests';
  let hub: Server | null = null;
  let previewUpstream: Server | null = null;
  let previewWss: WebSocketServer | null = null;
  const liveSockets = new Set<WebSocket>();

  afterEach(async () => {
    for (const ws of liveSockets) ws.terminate();
    liveSockets.clear();
    if (previewWss) await new Promise<void>(resolve => previewWss!.close(() => resolve()));
    previewWss = null;
    if (hub) await new Promise<void>(resolve => hub!.close(() => resolve()));
    hub = null;
    if (previewUpstream) await new Promise<void>(resolve => previewUpstream!.close(() => resolve()));
    previewUpstream = null;
  });

  interface Hub {
    base: string;
    sessions: DashboardSessionStore;
    /** 当前活跃管理 token；rotate 就是换掉它。 */
    activeToken: { value: string };
    legacyAuthSessionId(token: string): string;
    /** dashboard.ts 的 endDashboardAuthSession 等价物。 */
    endAuthSession(authSessionId: string): void;
    emit(type: string, body: unknown): void;
    mintPreviewCapability(sessionId: string, authSessionId: string): string;
  }

  async function startHub(): Promise<Hub> {
    previewUpstream = createServer((_req, res) => { res.writeHead(200); res.end('preview'); });
    previewWss = new WebSocketServer({ server: previewUpstream });
    previewWss.on('connection', ws => ws.send('preview-open'));
    await new Promise<void>(resolve => previewUpstream!.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (previewUpstream.address() as { port: number }).port;

    const sessions = new DashboardSessionStore({ ttlMs: 600_000 });
    const audit = new MemoryAudit();
    const controller = createDashboardH5AuthController({
      config,
      sessions,
      audit,
      exchanger: { exchange: async () => ({ openId: 'ou_allowed' }) },
    });
    const registry = new AuthSessionConnectionRegistry();
    const activeToken = { value: 'management-token-generation-1' };
    const legacyAuthSessionId = (token: string) => `legacy:${token}`;
    const isAuthSessionLive = (authSessionId: string) =>
      sessions.liveAuthSession(authSessionId) || authSessionId === legacyAuthSessionId(activeToken.value);
    const endAuthSession = (authSessionId: string) => { registry.closeAuthSession(authSessionId); };
    sessions.onEnd(identity => endAuthSession(identity.authSessionId));

    const identityOf = (req: IncomingMessage): { authSessionId: string } | null => {
      const legacy = parseNamedCookie(req.headers.cookie, 'botmux_dashboard_token');
      if (legacy && legacy === activeToken.value) return { authSessionId: legacyAuthSessionId(legacy) };
      const h5 = sessions.resolveToken(parseNamedCookie(req.headers.cookie, DASHBOARD_SESSION_COOKIE));
      return h5 ? { authSessionId: h5.authSessionId } : null;
    };

    const listeners = new Set<(type: string, body: unknown) => void>();
    const previewProxy = createSessionPreviewProxy({
      authenticated: req => identityOf(req) !== null,
      resolve: () => ({ ok: true, target: { host: '127.0.0.1', port: upstreamPort, registeredAt: new Date().toISOString() } }),
      verifyContentCapability: (capability, sessionId) => {
        const verified = verifyPreviewContentCapability(PREVIEW_SECRET, capability, sessionId);
        return verified.ok && isAuthSessionLive(verified.claims.authSessionId);
      },
      bindStream: (req, ctx, close) => {
        const authSessionId = ctx.contentCapability
          ? (() => {
            const verified = verifyPreviewContentCapability(PREVIEW_SECRET, ctx.contentCapability, ctx.sessionId);
            return verified.ok ? verified.claims.authSessionId : null;
          })()
          : identityOf(req)?.authSessionId ?? null;
        return authSessionId ? registry.register(authSessionId, close) : null;
      },
    });

    hub = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://dashboard.test');
      void (async () => {
        if (await controller.handle(req, res, url)) return;
        if (await previewProxy.handleHttp(req, res, url)) return;
        if (url.pathname === '/events') {
          const identity = identityOf(req);
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' });
          res.write('retry: 5000\n\n');
          const stream = createDashboardEventsStream({
            res,
            authSessionId: identity?.authSessionId ?? null,
            isAuthSessionLive,
            bind: (authSessionId, close) => registry.register(authSessionId, close),
          });
          const listener = (type: string, body: unknown) => { stream.write(type, body); };
          listeners.add(listener);
          res.on('close', () => { listeners.delete(listener); stream.dispose(); });
          return;
        }
        res.writeHead(404); res.end();
      })();
    });
    hub.on('upgrade', (req, socket, head) => {
      if (!previewProxy.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>(resolve => hub!.listen(0, '127.0.0.1', resolve));
    return {
      base: `http://127.0.0.1:${(hub.address() as { port: number }).port}`,
      sessions,
      activeToken,
      legacyAuthSessionId,
      endAuthSession,
      emit: (type, body) => { for (const listener of [...listeners]) listener(type, body); },
      mintPreviewCapability: (sessionId, authSessionId) => {
        const minted = mintPreviewContentCapability(PREVIEW_SECRET, sessionId, {
          userId: 'ou_allowed', authSessionId, expiresAt: Date.now() + 600_000,
        });
        if (!minted) throw new Error('capability mint failed');
        return minted.token;
      },
    };
  }

  /** 读一条 SSE 帧；`null` 表示流已经结束（服务端主动关闭）。 */
  async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string | null> {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>(resolve =>
        setTimeout(() => resolve({ done: true, value: undefined }), 1_500).unref()),
    ]);
    if (chunk.done) return null;
    return new TextDecoder().decode(chunk.value);
  }

  it('H5 logout tears down both the /events SSE and the sandboxed preview WebSocket', async () => {
    const h5 = await startHub();
    const created = h5.sessions.create('ou_allowed');
    const cookie = `${DASHBOARD_SESSION_COOKIE}=${created.token}`;

    const sse = await fetch(`${h5.base}/events`, { headers: { cookie } });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();
    expect(await readFrame(reader)).toContain('retry: 5000');
    h5.emit('session.updated', { sessionId: 's1' });
    expect(await readFrame(reader)).toContain('session.updated');

    const capability = h5.mintPreviewCapability('s1', created.identity.authSessionId);
    const ws = new WebSocket(
      `${h5.base.replace('http', 'ws')}/preview/s1/${PREVIEW_CONTENT_SEGMENT}/${capability}/socket`,
      { origin: 'null' },
    );
    liveSockets.add(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('message', () => resolve());
      ws.on('error', reject);
      setTimeout(() => reject(new Error('preview WebSocket never opened')), 4_000).unref();
    });
    const wsClosed = new Promise<void>((resolve, reject) => {
      ws.on('close', () => resolve());
      setTimeout(() => reject(new Error('preview WebSocket survived logout')), 4_000).unref();
    });

    // 真实登出请求 → 真实会话吊销 → onEnd → 关闭该身份名下全部长连接。
    const logout = await fetch(`${h5.base}/auth/feishu/logout`, { method: 'POST', headers: { cookie } });
    expect(logout.status).toBe(200);

    await wsClosed;
    liveSockets.delete(ws);
    // SSE 流结束（read 返回 done / 连接错误），登出后的新帧一个都收不到。
    h5.emit('session.updated', { sessionId: 's2', riffAccessUrl: 'https://riff.example/after-logout' });
    const tail = await readFrame(reader).catch(() => null);
    expect(tail == null || !tail.includes('after-logout')).toBe(true);
  });

  it('token rotation stops an old management SSE from receiving newly minted riffAccessUrl frames', async () => {
    const h5 = await startHub();
    const cookie = `botmux_dashboard_token=${h5.activeToken.value}`;
    const previousAuthSession = h5.legacyAuthSessionId(h5.activeToken.value);

    const sse = await fetch(`${h5.base}/events`, { headers: { cookie } });
    const reader = sse.body!.getReader();
    expect(await readFrame(reader)).toContain('retry: 5000');
    h5.emit('session.updated', { sessionId: 's1', riffAccessUrl: 'https://riff.example/before-rotate' });
    expect(await readFrame(reader)).toContain('before-rotate');

    // `botmux dashboard rotate`：换 token，随即吊销旧认证会话。
    h5.activeToken.value = 'management-token-generation-2';
    h5.endAuthSession(previousAuthSession);

    h5.emit('session.updated', { sessionId: 's2', riffAccessUrl: 'https://riff.example/after-rotate' });
    const tail = await readFrame(reader).catch(() => null);
    expect(tail == null || !tail.includes('after-rotate')).toBe(true);
  });

  it('even without the active close, a rotated-away SSE is re-checked before every frame', async () => {
    const h5 = await startHub();
    const cookie = `botmux_dashboard_token=${h5.activeToken.value}`;

    const sse = await fetch(`${h5.base}/events`, { headers: { cookie } });
    const reader = sse.body!.getReader();
    expect(await readFrame(reader)).toContain('retry: 5000');

    // 只 rotate、故意不调用主动关闭：推送前复核必须自己拦住这一帧。
    h5.activeToken.value = 'management-token-generation-3';
    h5.emit('session.updated', { sessionId: 's2', riffAccessUrl: 'https://riff.example/after-rotate' });

    const tail = await readFrame(reader).catch(() => null);
    expect(tail == null || !tail.includes('after-rotate')).toBe(true);
  });
});
