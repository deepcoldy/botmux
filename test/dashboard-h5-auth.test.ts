import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'bun:test';
import {
  createDashboardH5AuthController,
  createFeishuH5CodeExchanger,
  DASHBOARD_H5_CLIENT_TIMEOUT_MS,
  DASHBOARD_H5_EXCHANGE_MAX_CONCURRENT,
  DASHBOARD_H5_EXCHANGE_MAX_PER_IP_PER_WINDOW,
  DASHBOARD_H5_MAX_TRUSTED_PROXY_HOPS,
  DashboardH5ExchangeGate,
  dashboardH5ClientIp,
  DashboardSessionStore,
  DASHBOARD_SESSION_COOKIE,
  resolveDashboardH5AuthConfig,
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
import { logger } from '../src/utils/logger.js';

const config: DashboardH5AuthConfig = {
  enabled: true,
  brand: 'feishu',
  appId: 'cli_test_app',
  appSecret: 'app-secret-never-exposed',
  allowedOpenIds: ['ou_allowed'],
  entryPath: '/auth/feishu',
  sessionTtlMs: 60_000,
  secureCookies: false,
  trustedProxyHops: 0,
};

class MemoryAudit implements ControlAuditSink {
  records: ControlAuditRecord[] = [];
  append(record: ControlAuditRecord): void { this.records.push(record); }
}

/** 审计写不进去（磁盘满 / 审计路径不可写）的模拟。生产环境注入的是同步的
 *  `FileControlAuditSink`，`append()` 失败会原样抛出、没有任何吞咽层，所以这
 *  条失败路径必须被测到。`broken` 可翻回 false，模拟运维把磁盘清干净。 */
class BrokenAudit implements ControlAuditSink {
  attempts: ControlAuditRecord[] = [];
  broken = true;
  constructor(private readonly failOn: (record: ControlAuditRecord) => boolean = () => true) {}
  append(record: ControlAuditRecord): void {
    this.attempts.push(record);
    if (this.broken && this.failOn(record)) {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    }
  }
}

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

async function startController(
  openIdOrError: string | Error,
  nowRef = { value: 1_000 },
  opts: {
    exchanger?: FeishuH5CodeExchanger;
    exchangeGate?: DashboardH5ExchangeGate;
    config?: DashboardH5AuthConfig;
    /** 注入别的 sink（如 {@link BrokenAudit}）时，返回的 `audit` 就是空的，
     *  断言请用调用方自己持有的那个实例。 */
    audit?: ControlAuditSink;
  } = {},
): Promise<{
  base: string;
  audit: MemoryAudit;
  sessions: DashboardSessionStore;
  seen: { exchangePosts: number };
  /** Every session token the store actually minted, in order. Its LENGTH is
   *  the number of dashboard sessions created — the P1-2 contract is that one
   *  one-time code can never grow it by more than 1. */
  minted: string[];
}> {
  const audit = new MemoryAudit();
  const minted: string[] = [];
  const sessions = new DashboardSessionStore({
    ttlMs: config.sessionTtlMs,
    now: () => nowRef.value,
    // Distinct per call: a constant token would collapse N sessions into one
    // map entry and hide exactly the bug these tests are about.
    randomToken: () => {
      const token = `sessiontoken${String(minted.length).padStart(3, '0')}${'A'.repeat(30)}`;
      minted.push(token);
      return token;
    },
  });
  const controller = createDashboardH5AuthController({
    config: opts.config ?? config,
    sessions,
    audit: opts.audit ?? audit,
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
  return { base: `http://127.0.0.1:${port}`, audit, sessions, seen, minted };
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
    const { base, audit, minted } = await startController('ou_allowed', nowRef);
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
    // The minted cookie value leaves through Set-Cookie only, never the body.
    expect(minted).toHaveLength(1);
    expect(bodyText).not.toContain(minted[0]);
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

  // P1-1：以前无条件相信 x-forwarded-for 的第一跳，等于把限流桶的钥匙交给攻击者
  // ——换个伪造的头就是一个新桶，限流形同虚设，跟踪表还被撑大。默认不读这个头。
  it('ignores x-forwarded-for with no trusted proxy configured: forged hops cannot escape the socket bucket', async () => {
    const { base } = await startController('ou_allowed', undefined, {
      exchangeGate: new DashboardH5ExchangeGate({ maxPerIpPerWindow: 1 }),
    });
    expect((await postExchange(base, 'code-a')).status).toBe(200);
    const forgedHeaders = ['203.0.113.7', '198.51.100.3, 10.0.0.1', '9.9.9.9, 8.8.8.8, 7.7.7.7'];
    for (const [index, forged] of forgedHeaders.entries()) {
      const spoofed = await postExchange(base, `code-b${index}`, { 'x-forwarded-for': forged });
      expect(spoofed.status, forged).toBe(429);
      expect(spoofed.headers.get('retry-after'), forged).toBeTruthy();
      expect(spoofed.headers.get('set-cookie'), forged).toBeNull();
    }
  });

  it('with one trusted proxy hop, buckets by the address that proxy wrote — not by what the client prepended', async () => {
    const { base } = await startController('ou_allowed', undefined, {
      config: { ...config, trustedProxyHops: 1 },
      exchangeGate: new DashboardH5ExchangeGate({ maxPerIpPerWindow: 1 }),
    });
    // 一层 nginx：客户端写什么都在左边，nginx 自己追加的对端地址在最右边。
    expect((await postExchange(base, 'code-a', { 'x-forwarded-for': '203.0.113.7' })).status).toBe(200);
    // 同一个真实客户端换着伪造左侧，仍然是同一个桶。
    for (const [index, forged] of ['1.1.1.1, 203.0.113.7', '2.2.2.2, 3.3.3.3, 203.0.113.7'].entries()) {
      const spoofed = await postExchange(base, `code-b${index}`, { 'x-forwarded-for': forged });
      expect(spoofed.status, forged).toBe(429);
    }
    // 真正换了客户端（可信代理写的那一跳变了）才是新桶。
    expect((await postExchange(base, 'code-c', { 'x-forwarded-for': '1.1.1.1, 198.51.100.3' })).status).toBe(200);
    // 完全没有这个头就回落到直连地址，自成一桶。
    expect((await postExchange(base, 'code-d')).status).toBe(200);
  });

  it('429s the endpoint as a whole once the global window is spent, even below the per-IP budget', async () => {
    const { base, minted } = await startController('ou_allowed', undefined, {
      exchangeGate: new DashboardH5ExchangeGate({ maxPerIpPerWindow: 1_000, maxGlobalPerWindow: 2 }),
    });
    expect((await postExchange(base, 'global-code-1')).status).toBe(200);
    expect((await postExchange(base, 'global-code-2')).status).toBe(200);
    const limited = await postExchange(base, 'global-code-3');
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter) && retryAfter >= 1).toBe(true);
    expect(await limited.json()).toEqual({ ok: false, error: 'rate_limited', retryAfterSeconds: retryAfter });
    expect(limited.headers.get('set-cookie')).toBeNull();
    // 拦在签发之前：全局闸吃掉的请求不会留下第三个会话。
    expect(minted).toHaveLength(2);
  });

  // P1-2：共享 provider 结果还不够——每个 waiter 各自 sessions.create()，一张
  // 一次性 code 就被放大成 N 个各自独立、各自要单独吊销的管理会话。新契约是
  // 「一张 code 最多一个会话」，并发重放共享同一个会话。
  it('mints exactly ONE dashboard session for a one-time code replayed concurrently', async () => {
    let release!: () => void;
    const blocked = new Promise<{ openId: string }>(resolve => {
      release = () => resolve({ openId: 'ou_allowed' });
    });
    const exchange = vi.fn(() => blocked);
    const { base, seen, audit, minted } = await startController('ou_allowed', undefined, {
      exchanger: { exchange },
    });
    const replays = [
      postExchange(base, 'duplicate-code'),
      postExchange(base, 'duplicate-code'),
      postExchange(base, 'duplicate-code'),
    ];
    await vi.waitFor(() => {
      expect(seen.exchangePosts).toBe(3);
      expect(exchange).toHaveBeenCalledTimes(1);
    });
    // All three requests are on the server; give the duplicates a beat to join
    // the in-flight map before the shared exchange resolves.
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    const settled = await Promise.all(replays);
    for (const response of settled) expect(response.status).toBe(200);
    expect(exchange).toHaveBeenCalledTimes(1);

    const cookies = settled.map(response => cookiePair(response.headers.get('set-cookie') ?? ''));
    expect(cookies[0]).toContain(`${DASHBOARD_SESSION_COOKIE}=`);
    // 三个 200 拿到的是同一张 cookie，会话表也只多了一条，审计只记一次登录。
    expect(new Set(cookies).size).toBe(1);
    expect(minted).toHaveLength(1);
    expect(audit.records.filter(record => record.action === 'auth.login')).toHaveLength(1);

    // 同一个会话的硬证据：任一份 cookie 登出，另一份立刻失效。三个独立会话不会这样。
    const logout = await fetch(`${base}/auth/feishu/logout`, {
      method: 'POST', headers: { cookie: cookies[2] },
    });
    expect(logout.status).toBe(200);
    const after = await fetch(`${base}/auth/feishu/session`, { headers: { cookie: cookies[0] } });
    expect(after.status).toBe(401);
  });

  it('refuses a one-time code that already minted a session, without a second upstream call', async () => {
    const exchange = vi.fn(async () => ({ openId: 'ou_allowed' }));
    const { base, minted, audit } = await startController('ou_allowed', undefined, {
      exchanger: { exchange },
    });
    expect((await postExchange(base, 'burn-after-reading')).status).toBe(200);
    const replay = await postExchange(base, 'burn-after-reading');
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ ok: false, error: 'authorization_code_already_used' });
    expect(replay.headers.get('set-cookie')).toBeNull();
    // 连开放平台都没再打一次，更没有第二个会话。
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(minted).toHaveLength(1);
    expect(audit.records.filter(record => record.action === 'auth.login')).toHaveLength(1);
    // 只烧掉这一张 code，别的 code 照常。
    expect((await postExchange(base, 'a-different-code')).status).toBe(200);
    expect(minted).toHaveLength(2);
  });

  it('does not burn a code whose exchange failed: the client may retry the same one', async () => {
    const exchange = vi.fn(async () => { throw new Error('provider_rejected'); });
    const { base, minted } = await startController('ou_allowed', undefined, {
      exchanger: { exchange },
    });
    expect((await postExchange(base, 'transient-failure-code')).status).toBe(502);
    // 没签发会话 ⇒ 没烧掉 code：网络抖动不应该把用户锁在门外。
    expect((await postExchange(base, 'transient-failure-code')).status).toBe(502);
    expect(exchange).toHaveBeenCalledTimes(2);
    expect(minted).toHaveLength(0);
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

// P1-5：审计是 fail-closed 的一环（与 terminal-control 的 takeover 同一套顺序），
// 但「写不进去」不能变成半提交——登录不能留下浏览器永远拿不到的孤儿会话、也不能
// 白烧掉一次性 code；登出的撤销已经完成，清 Cookie 的成功响应就必须发出去。
describe('P1-5 audit write failures never half-commit a login or a logout', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('mints no orphan session and burns no code when the login audit cannot be written', async () => {
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const audit = new BrokenAudit();
    const { base, minted } = await startController('ou_allowed', { value: 10_000 }, { audit });

    const failed = await postExchange(base, 'disk-is-full-code');
    expect(failed.status).toBe(503);
    // 本地故障不再冒充飞书上游故障：磁盘满不该让运维去查飞书应用配置。
    expect(await failed.json()).toEqual({ ok: false, error: 'login_unavailable' });
    expect(failed.headers.get('set-cookie')).toBeNull();
    // 审计确实先于会话创建被尝试，且一枚 token 都没签发出去 → 没有孤儿会话。
    expect(audit.attempts.map(record => record.action)).toEqual(['auth.login']);
    expect(minted).toHaveLength(0);
    // 原始错因落进 daemon 日志（这里原来是裸 catch，运维一条线索都拿不到）。
    expect(errors.mock.calls.map(call => String(call[0])).join('\n')).toContain('ENOSPC');

    // code 也没被烧掉：磁盘清干净后，同一个 code 还能换回登录，而不是 409。
    audit.broken = false;
    const retry = await postExchange(base, 'disk-is-full-code');
    expect(retry.status).toBe(200);
    expect(retry.headers.get('set-cookie')).toContain(`${DASHBOARD_SESSION_COOKIE}=`);
    expect(minted).toHaveLength(1);
  });

  it('still clears the cookie and answers 200 when the logout audit cannot be written', async () => {
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const audit = new BrokenAudit(record => record.action === 'auth.logout');
    const { base } = await startController('ou_allowed', { value: 10_000 }, { audit });
    const login = await postExchange(base, 'logout-audit-code');
    expect(login.status).toBe(200);
    const cookie = cookiePair(login.headers.get('set-cookie') ?? '');

    const logout = await fetch(`${base}/auth/feishu/logout`, { method: 'POST', headers: { cookie } });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ ok: true });
    // 撤销已经不可撤回，清 Cookie 的响应就不能被审计失败吞掉，否则浏览器揣着一
    // 枚已死的 cookie，页面还以为自己没登出。
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    // 会话是真撤销了，不只是清了 cookie。
    const after = await fetch(`${base}/auth/feishu/session`, { headers: { cookie } });
    expect(after.status).toBe(401);
    expect(errors.mock.calls.map(call => String(call[0])).join('\n')).toContain('auth.logout');
  });

  it('logs the real upstream cause behind a 502 without putting it or the app secret in the response', async () => {
    const warns = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { base } = await startController(new Error(`provider_rejected ${config.appSecret}`));
    const response = await postExchange(base, 'upstream-broken-code');
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'feishu_exchange_failed' });
    expect(text).not.toContain(config.appSecret);
    const logged = warns.mock.calls.map(call => String(call[0])).join('\n');
    expect(logged).toContain('provider_rejected');   // 运维终于看得到真实错因
    expect(logged).not.toContain(config.appSecret);  // 但凭据不落日志
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
    const gate = new DashboardH5ExchangeGate({
      now: () => now, windowMs: 60_000, pruneIntervalMs: 60_000, maxGlobalPerWindow: 10_000,
    });
    for (let i = 0; i < 500; i++) gate.admit(`10.0.${Math.floor(i / 250)}.${i % 250}`);
    expect(gate.trackedIpCount()).toBe(500);
    now = 120_001;
    // Any admission past the prune interval sweeps every expired bucket.
    expect(gate.admit('203.0.113.99')).toEqual({ ok: true });
    expect(gate.trackedIpCount()).toBe(1);
    gate.prune();
    expect(gate.trackedIpCount()).toBe(1);
  });

  // P1-1：所谓 4096 上限以前只触发 prune、不拒绝也不淘汰，5000 个地址就是 5000 条。
  it('hard-bounds the IP table at maxTrackedIps, evicting the least recently used bucket', () => {
    let now = 0;
    const ipOf = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    const gate = new DashboardH5ExchangeGate({
      now: () => now, windowMs: 60_000, maxPerIpPerWindow: 1,
      maxGlobalPerWindow: 10_000, maxTrackedIps: 4_096,
    });
    for (let i = 0; i < 5_000; i++) expect(gate.admit(ipOf(i)), ipOf(i)).toEqual({ ok: true });
    expect(gate.trackedIpCount()).toBe(4_096);
    // 最早那个桶被淘汰了：它的额度重新可用（淘汰的代价是重置，不是把新客户端锁死）。
    expect(gate.admit(ipOf(0))).toEqual({ ok: true });
    // 最新的桶还在：额度照旧扣着，限流对活跃地址依然有效。
    expect(gate.admit(ipOf(4_999)).ok).toBe(false);
    expect(gate.trackedIpCount()).toBe(4_096);
  });

  it('keeps admission O(1) with a saturated table: the sweep is on a timer, not on size', () => {
    let now = 0;
    const gate = new DashboardH5ExchangeGate({
      now: () => now, windowMs: 60_000, pruneIntervalMs: 60_000,
      maxPerIpPerWindow: 1, maxGlobalPerWindow: 100_000, maxTrackedIps: 128,
    });
    for (let i = 0; i < 128; i++) gate.admit(`10.0.0.${i}`);
    expect(gate.trackedIpCount()).toBe(128);
    // 表满之后再来 2000 次：既没涨，也没有一次全表扫描。
    for (let i = 0; i < 2_000; i++) gate.admit(`198.51.100.${i % 250}`);
    expect(gate.trackedIpCount()).toBe(128);
    expect(gate.sweepCount()).toBe(0);
    // 到点才扫，一次；扫完过期桶清空，只剩这次新登记的。
    now = 60_001;
    expect(gate.admit('203.0.113.99')).toEqual({ ok: true });
    expect(gate.sweepCount()).toBe(1);
    expect(gate.trackedIpCount()).toBe(1);
  });

  it('caps the endpoint as a whole, so many source addresses cannot outrun the per-IP budget', () => {
    let now = 0;
    const gate = new DashboardH5ExchangeGate({
      now: () => now, windowMs: 60_000, maxPerIpPerWindow: 10, maxGlobalPerWindow: 3,
    });
    expect(gate.admit('203.0.113.1')).toEqual({ ok: true });
    now = 10_000;
    expect(gate.admit('203.0.113.2')).toEqual({ ok: true });
    now = 20_000;
    expect(gate.admit('203.0.113.3')).toEqual({ ok: true });
    now = 30_000;
    // 第四个地址在自己的每 IP 额度之内，但端点整体的额度已经用完；Retry-After
    // 指向最早那次全局命中离开窗口的时刻。
    expect(gate.admit('203.0.113.4')).toEqual({ ok: false, retryAfterMs: 30_000 });
    // 被拒的陌生地址连跟踪表都不进，攻击者撑不大这张表。
    expect(gate.trackedIpCount()).toBe(3);
    // 拒绝不消耗额度：最早那次命中一出窗口，配额就正好回来一格。
    now = 60_001;
    expect(gate.admit('203.0.113.4')).toEqual({ ok: true });
    expect(gate.admit('203.0.113.5')).toEqual({ ok: false, retryAfterMs: 9_999 });
  });

  it('a per-IP refusal spends no global budget', () => {
    let now = 0;
    const gate = new DashboardH5ExchangeGate({
      now: () => now, windowMs: 60_000, maxPerIpPerWindow: 1, maxGlobalPerWindow: 3,
    });
    expect(gate.admit('203.0.113.1')).toEqual({ ok: true });
    for (let i = 0; i < 20; i++) expect(gate.admit('203.0.113.1').ok).toBe(false);
    // 吵闹的客户端只花掉了自己的那一格：共享池里剩下的两格照常给别人用。
    expect(gate.admit('203.0.113.2')).toEqual({ ok: true });
    expect(gate.admit('203.0.113.3')).toEqual({ ok: true });
    expect(gate.admit('203.0.113.4').ok).toBe(false);
  });

  it('remembers spent code digests with a TTL and its own bound', () => {
    let now = 0;
    const gate = new DashboardH5ExchangeGate({
      now: () => now, windowMs: 60_000, spentCodeTtlMs: 60_000, maxSpentCodes: 2,
    });
    expect(gate.isSpent('digest-a')).toBe(false);
    gate.markSpent('digest-a');
    expect(gate.isSpent('digest-a')).toBe(true);
    // 有界：第三个把最旧的挤出去，攻击者不能用无限 code 撑爆这张表。
    gate.markSpent('digest-b');
    gate.markSpent('digest-c');
    expect(gate.spentCodeCount()).toBe(2);
    expect(gate.isSpent('digest-a')).toBe(false);
    expect(gate.isSpent('digest-c')).toBe(true);
    // TTL 到点自然失效（code 本身早在开放平台侧过期了）。
    now = 60_001;
    expect(gate.isSpent('digest-c')).toBe(false);
  });
});

describe('dashboardH5ClientIp', () => {
  const fakeReq = (headers: Record<string, string | string[]>, remoteAddress?: string): IncomingMessage =>
    ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

  it('ignores x-forwarded-for entirely without a trusted-proxy configuration', () => {
    // 直连部署下这个头是纯客户端输入，读它就等于让攻击者自选限流桶。
    expect(dashboardH5ClientIp(fakeReq({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, '10.0.0.1'))).toBe('10.0.0.1');
    expect(dashboardH5ClientIp(fakeReq({ 'x-forwarded-for': ['198.51.100.3'] }, '10.0.0.1'), 0)).toBe('10.0.0.1');
    expect(dashboardH5ClientIp(fakeReq({}, '192.168.1.9'))).toBe('192.168.1.9');
    expect(dashboardH5ClientIp(fakeReq({}, '::ffff:192.168.1.9'))).toBe('192.168.1.9');
    expect(dashboardH5ClientIp(fakeReq({}))).toBe('unknown');
  });

  it('reads the client from the trusted end of the chain, so prepended hops never become bucket keys', () => {
    const forged = { 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 203.0.113.7' };
    // 一层可信代理：只认它自己写下的那一跳（最右），客户端伪造的左侧全部无效。
    expect(dashboardH5ClientIp(fakeReq(forged, '10.0.0.1'), 1)).toBe('203.0.113.7');
    // 两层：再往左一跳，仍然在自家基础设施写的范围内。
    expect(dashboardH5ClientIp(fakeReq(forged, '10.0.0.1'), 2)).toBe('8.8.8.8');
    // 同名头出现多次是一条逻辑链，按线序拼接后再取。
    expect(dashboardH5ClientIp(fakeReq({ 'x-forwarded-for': ['9.9.9.9', '198.51.100.3'] }, '10.0.0.1'), 1))
      .toBe('198.51.100.3');
    // 链比配置短就回落到实际存在的最远一跳，最差也就是直连地址。
    expect(dashboardH5ClientIp(fakeReq({}, '10.0.0.1'), 1)).toBe('10.0.0.1');
    expect(dashboardH5ClientIp(fakeReq({ 'x-forwarded-for': '  ' }, '10.0.0.1'), 1)).toBe('10.0.0.1');
    // 转发跳同样做 IPv4-mapped 归一化。
    expect(dashboardH5ClientIp(fakeReq({ 'x-forwarded-for': '::ffff:203.0.113.7' }, '10.0.0.1'), 1))
      .toBe('203.0.113.7');
    // 跳数非法/为负一律当成「没有可信代理」，绝不因为配置写错就去信客户端。
    expect(dashboardH5ClientIp(fakeReq(forged, '10.0.0.1'), Number.NaN)).toBe('10.0.0.1');
    expect(dashboardH5ClientIp(fakeReq(forged, '10.0.0.1'), -3)).toBe('10.0.0.1');
    // 配置得比实际代理层数还多是运维错误，这里只保证有界：最多退到链条最左端。
    expect(dashboardH5ClientIp(fakeReq(forged, '10.0.0.1'), 99)).toBe('9.9.9.9');
  });
});

describe('resolveDashboardH5AuthConfig trusted proxy hops', () => {
  const base = { BOTMUX_DASHBOARD_FEISHU_H5_ENABLED: 'true' };
  it('defaults to zero and only accepts an in-range hop count', () => {
    expect(resolveDashboardH5AuthConfig(base).trustedProxyHops).toBe(0);
    expect(resolveDashboardH5AuthConfig({
      ...base, BOTMUX_DASHBOARD_FEISHU_H5_TRUSTED_PROXY_HOPS: '1',
    }).trustedProxyHops).toBe(1);
    expect(resolveDashboardH5AuthConfig({
      ...base, BOTMUX_DASHBOARD_FEISHU_H5_TRUSTED_PROXY_HOPS: String(DASHBOARD_H5_MAX_TRUSTED_PROXY_HOPS),
    }).trustedProxyHops).toBe(DASHBOARD_H5_MAX_TRUSTED_PROXY_HOPS);
    // 越界/垃圾值一律回落到「不信任何代理」这个安全侧，而不是就近取一个大数。
    for (const raw of ['9', '-1', '1.5', 'yes', '']) {
      expect(resolveDashboardH5AuthConfig({
        ...base, BOTMUX_DASHBOARD_FEISHU_H5_TRUSTED_PROXY_HOPS: raw,
      }).trustedProxyHops, raw).toBe(0);
    }
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
  // 服务端**没有**主动关闭的 SSE 流（例如只做能力过滤、身份始终有效的用例）会一直
  // 挂着，hub.close() 等不到它，afterEach 就超时。统一在这里取消读端放连接。
  const liveReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();

  afterEach(async () => {
    for (const reader of liveReaders) await reader.cancel().catch(() => {});
    liveReaders.clear();
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

    // `kind` 与 dashboard.ts 的 `legacyAuthed` / `workbenchOnlyIdentity` 一一对应：
    // 本机管理 cookie ⇒ management，H5 会话 cookie ⇒ workbench-only。
    const identityOf = (req: IncomingMessage): { authSessionId: string; kind: 'legacy' | 'workbench' } | null => {
      const legacy = parseNamedCookie(req.headers.cookie, 'botmux_dashboard_token');
      if (legacy && legacy === activeToken.value) {
        return { authSessionId: legacyAuthSessionId(legacy), kind: 'legacy' };
      }
      const h5 = sessions.resolveToken(parseNamedCookie(req.headers.cookie, DASHBOARD_SESSION_COOKIE));
      return h5 ? { authSessionId: h5.authSessionId, kind: 'workbench' } : null;
    };

    const listeners = new Set<(type: string, body: unknown) => void>();
    const previewProxy = createSessionPreviewProxy({
      authenticated: req => identityOf(req) !== null,
      resolve: () => ({
        ok: true,
        target: {
          host: '127.0.0.1',
          port: upstreamPort,
          registeredAt: new Date().toISOString(),
          // P1-12：注册时的 listener 归属证明，代理侧按不透明数据透传。
          owner: { pid: 424242, procStart: '918273', inode: '556677' },
          workerGeneration: 7,
        },
      }),
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
        // P1-4：与 dashboard.ts 同款——登记点即最后一次判定点。拨号期间身份结束的
        // 流在这里 fail closed，不补登记到一个已经死掉的认证会话名下。
        if (!authSessionId || !isAuthSessionLive(authSessionId)) return false;
        return registry.register(authSessionId, close);
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
            // 与 dashboard.ts 同一行口径：authed ? management : workbenchOnly ? workbench : anonymous。
            audience: identity?.kind === 'legacy'
              ? 'management'
              : identity ? 'workbench' : 'anonymous',
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

  /** 累积读到出现 `marker` 为止（或流结束/超时），返回这期间收到的全部字节。
   *  多帧是否合并进同一个 TCP chunk 由内核决定，所以断言必须看累积文本。 */
  async function readUntil(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    marker: string,
  ): Promise<string> {
    let text = '';
    for (let i = 0; i < 20 && !text.includes(marker); i += 1) {
      const chunk = await readFrame(reader);
      if (chunk == null) break;
      text += chunk;
    }
    return text;
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

  // ─── P1-14 姊妹项：/events 按身份能力过滤 schedule.* ──────────────────────
  //
  // `GET /api/schedules` 对 Workbench-only 身份是明确的 401（排程行带 prompt =
  // 业务指令、workingDir = 仓库/客户路径，`schedule.fired` 还带 error 原文）。
  // SSE 的门禁只在建流那一刻跑过一次，之后是服务端主动推——REST 拒绝、SSE 放行，
  // 就是同一份数据换了个管子出去。
  it('a Workbench-only /events stream receives zero schedule.* frames while a legacy owner still gets them', async () => {
    const h5 = await startHub();
    const created = h5.sessions.create('ou_allowed');

    const workbench = await fetch(`${h5.base}/events`, {
      headers: { cookie: `${DASHBOARD_SESSION_COOKIE}=${created.token}` },
    });
    expect(workbench.status).toBe(200);
    const workbenchReader = workbench.body!.getReader();
    liveReaders.add(workbenchReader);
    expect(await readFrame(workbenchReader)).toContain('retry: 5000');

    const owner = await fetch(`${h5.base}/events`, {
      headers: { cookie: `botmux_dashboard_token=${h5.activeToken.value}` },
    });
    expect(owner.status).toBe(200);
    const ownerReader = owner.body!.getReader();
    liveReaders.add(ownerReader);
    expect(await readFrame(ownerReader)).toContain('retry: 5000');

    // 排程盘点 + 时区 + 触发失败，最后跟一帧会话事件当水位线：会话帧必须照常
    // 送达，才能证明前面几帧是被**过滤**掉，而不是流卡住/断了。
    h5.emit('schedule.created', {
      schedule: { id: 'sch-1', prompt: '给客户 ACME 发对账单', workingDir: '/srv/acme' },
    });
    h5.emit('schedule.timezone', { timezone: 'Asia/Shanghai' });
    h5.emit('schedule.fired', {
      id: 'sch-1', runAt: 1, status: 'error', error: 'ENOENT /srv/acme/secret.env',
    });
    h5.emit('session.updated', { sessionId: 's-after-schedules' });

    const seenByWorkbench = await readUntil(workbenchReader, 's-after-schedules');
    expect(seenByWorkbench).toContain('s-after-schedules');
    expect(seenByWorkbench).not.toContain('schedule.created');
    expect(seenByWorkbench).not.toContain('schedule.timezone');
    expect(seenByWorkbench).not.toContain('schedule.fired');
    expect(seenByWorkbench).not.toContain('ACME');
    expect(seenByWorkbench).not.toContain('/srv/acme');
    expect(seenByWorkbench).not.toContain('secret.env');

    // 管理身份不受影响：三帧照旧，一个字段都没少。
    const seenByOwner = await readUntil(ownerReader, 's-after-schedules');
    expect(seenByOwner).toContain('schedule.created');
    expect(seenByOwner).toContain('schedule.timezone');
    expect(seenByOwner).toContain('schedule.fired');
    expect(seenByOwner).toContain('secret.env');
    expect(seenByOwner).toContain('s-after-schedules');
  });
});
