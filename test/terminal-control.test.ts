import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  issueTerminalControlGrant,
  verifyTerminalControlGrant,
} from '../src/core/terminal-control-grant.js';
import {
  ControlCsrfTokens,
  controlRequestOriginState,
  guardControlRequest,
  injectControlCsrfMeta,
  managementUpgradeOrigin,
} from '../src/dashboard/control-csrf.js';
import type { ControlAuditRecord, ControlAuditSink } from '../src/dashboard/control-audit.js';
import {
  TerminalControlManager,
  type TerminalDashboardActor,
} from '../src/dashboard/terminal-control.js';
import { logger } from '../src/utils/logger.js';

const SECRET = 'host-only-dashboard-secret-for-tests';

class MemoryAudit implements ControlAuditSink {
  records: ControlAuditRecord[] = [];
  append(record: ControlAuditRecord): void { this.records.push(record); }
}

function actor(userId: string, authSessionId = `auth-${userId}`): TerminalDashboardActor {
  return { userId, authSessionId, expiresAt: 1_000_000 };
}

describe('signed terminal control grants', () => {
  it('binds scope, identity, session and expiry and rejects tamper/cross-session replay', () => {
    const grant = issueTerminalControlGrant(SECRET, {
      scope: 'write',
      sessionId: 'session-a',
      userId: 'ou_owner',
      authSessionId: 'auth-1',
      grantId: 'grant_identifier_1234',
      issuedAt: 1_000,
      expiresAt: 11_000,
    });
    expect(verifyTerminalControlGrant(SECRET, grant, 'session-a', 2_000)).toEqual({
      ok: true,
      claims: {
        version: 1,
        scope: 'write',
        sessionId: 'session-a',
        userId: 'ou_owner',
        authSessionId: 'auth-1',
        grantId: 'grant_identifier_1234',
        issuedAt: 1_000,
        expiresAt: 11_000,
      },
    });
    expect(verifyTerminalControlGrant(SECRET, grant, 'session-b', 2_000)).toEqual({
      ok: false, reason: 'session_mismatch',
    });
    expect(verifyTerminalControlGrant(SECRET, grant, 'session-a', 11_000)).toEqual({
      ok: false, reason: 'expired',
    });
    const tampered = `${grant.slice(0, -1)}${grant.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyTerminalControlGrant(SECRET, tampered, 'session-a', 2_000)).toEqual({
      ok: false, reason: 'invalid',
    });
  });
});

describe('terminal server-side takeover lifecycle', () => {
  it('preserves trusted platform owner write while guests stay read-only and cannot take over', () => {
    const manager = new TerminalControlManager({
      secret: SECRET, audit: new MemoryAudit(), ttlMs: 10_000, now: () => 1_000,
    });
    const owner = { ...actor('platform-owner'), terminalCapability: 'owner' as const };
    const guest = { ...actor('platform-guest'), terminalCapability: 'readonly' as const };
    expect(manager.state(owner, 's1')).toEqual({ mode: 'controlled', owned: true, fixed: true });
    expect(manager.grantForProxy(owner, 's1').scope).toBe('write');
    expect(manager.state(guest, 's1')).toEqual({ mode: 'readonly', owned: false });
    expect(manager.grantForProxy(guest, 's1').scope).toBe('read');
    expect(manager.takeover(guest, 's1')).toEqual({ ok: false, error: 'terminal_operation_forbidden' });
    expect(manager.release(owner, 's1')).toEqual({ ok: false, error: 'terminal_operation_forbidden' });
  });

  it('starts read-only, reuses one short write grant, and excludes another auth session', () => {
    let now = 1_000;
    const audit = new MemoryAudit();
    const manager = new TerminalControlManager({
      secret: SECRET,
      audit,
      ttlMs: 10_000,
      now: () => now,
      grantId: () => 'lease_identifier_1234',
    });
    const owner = actor('ou_owner');
    expect(manager.state(owner, 's1')).toEqual({ mode: 'readonly', owned: false });

    expect(manager.takeover(owner, 's1')).toEqual({
      ok: true, mode: 'controlled', expiresAt: 11_000, reused: false,
    });
    const firstGrant = manager.grantFor(owner, 's1');
    now = 2_000;
    expect(manager.takeover(owner, 's1')).toEqual({
      ok: true, mode: 'controlled', expiresAt: 11_000, reused: true,
    });
    expect(manager.grantFor(owner, 's1')).toBe(firstGrant);
    expect(manager.takeover(actor('ou_other'), 's1')).toEqual({ ok: false, error: 'control_busy' });
    expect(verifyTerminalControlGrant(SECRET, firstGrant, 's1', now)).toEqual(expect.objectContaining({ ok: true }));
    expect(audit.records.map(record => record.action)).toEqual([
      'terminal.takeover', 'terminal.takeover_reused',
    ]);
    expect(JSON.stringify(audit.records)).not.toContain(firstGrant);
  });

  it('explicit release destroys writable sockets and returns the next connection to read-only', () => {
    const audit = new MemoryAudit();
    const manager = new TerminalControlManager({ secret: SECRET, audit, ttlMs: 10_000, now: () => 1_000 });
    const owner = actor('ou_owner');
    manager.takeover(owner, 's1');
    const socket = { destroyed: false, destroy() { this.destroyed = true; } };
    expect(manager.registerWritableSocket(owner, 's1', socket).registered).toBe(true);
    expect(manager.release(owner, 's1')).toEqual({ ok: true, mode: 'readonly', released: true });
    expect(socket.destroyed).toBe(true);
    expect(manager.state(owner, 's1')).toEqual({ mode: 'readonly', owned: false });
    const readGrant = manager.grantFor(owner, 's1');
    const verified = verifyTerminalControlGrant(SECRET, readGrant, 's1', 1_000);
    expect(verified.ok && verified.claims.scope).toBe('read');
    expect(audit.records.at(-1)).toEqual(expect.objectContaining({
      user: 'ou_owner', session: 's1', action: 'terminal.release',
    }));
  });

  it('binds a proxy WebSocket to the exact lease generation across an async handshake', () => {
    const audit = new MemoryAudit();
    const manager = new TerminalControlManager({ secret: SECRET, audit, ttlMs: 10_000, now: () => 1_000 });
    const owner = actor('ou_owner');
    manager.takeover(owner, 's1');
    const stale = manager.grantForProxy(owner, 's1');
    expect(stale).toMatchObject({ scope: 'write', leaseMarker: expect.any(String) });

    manager.release(owner, 's1');
    manager.takeover(owner, 's1');
    const current = manager.grantForProxy(owner, 's1');
    expect(current.leaseMarker).not.toBe(stale.leaseMarker);

    const staleSocket = { destroyed: false, destroy() { this.destroyed = true; } };
    expect(manager.registerWritableSocket(owner, 's1', staleSocket, stale.leaseMarker)).toEqual({ registered: false });
    expect(manager.state(owner, 's1')).toEqual({ mode: 'controlled', owned: true, expiresAt: 11_000 });

    const currentSocket = { destroyed: false, destroy() { this.destroyed = true; } };
    expect(manager.registerWritableSocket(owner, 's1', currentSocket, current.leaseMarker).registered).toBe(true);
  });

  it('prioritizes revocation and socket teardown when teardown audit storage fails', () => {
    let fail = false;
    const audit: ControlAuditSink = {
      append() { if (fail) throw new Error('disk unavailable'); },
    };
    const manager = new TerminalControlManager({ secret: SECRET, audit, ttlMs: 10_000, now: () => 1_000 });
    const owner = actor('ou_owner');
    manager.takeover(owner, 's1');
    const socket = { destroyed: false, destroy() { this.destroyed = true; } };
    manager.registerWritableSocket(owner, 's1', socket);

    fail = true;
    expect(() => manager.release(owner, 's1')).not.toThrow();
    expect(socket.destroyed).toBe(true);
    expect(manager.state(owner, 's1')).toEqual({ mode: 'readonly', owned: false });
  });

  it('expires at the fixed deadline and tears down every writable socket', () => {
    let now = 1_000;
    const audit = new MemoryAudit();
    const manager = new TerminalControlManager({ secret: SECRET, audit, ttlMs: 10_000, now: () => now });
    const owner = actor('ou_owner');
    manager.takeover(owner, 's1');
    const sockets = [0, 1].map(() => ({ destroyed: false, destroy() { this.destroyed = true; } }));
    for (const socket of sockets) manager.registerWritableSocket(owner, 's1', socket);
    now = 11_000;
    expect(manager.expireDue()).toBe(1);
    expect(sockets.every(socket => socket.destroyed)).toBe(true);
    expect(manager.state(owner, 's1')).toEqual({ mode: 'readonly', owned: false });
    expect(audit.records.at(-1)).toEqual(expect.objectContaining({ action: 'terminal.expired' }));
  });

  it('releases the lease when the controlling WebSocket disconnects', () => {
    const audit = new MemoryAudit();
    const manager = new TerminalControlManager({ secret: SECRET, audit, ttlMs: 10_000, now: () => 1_000 });
    const owner = actor('ou_owner');
    manager.takeover(owner, 's1');
    const socket = { destroyed: false, destroy() { this.destroyed = true; } };
    const registered = manager.registerWritableSocket(owner, 's1', socket);
    socket.destroyed = true;
    expect(manager.disconnect(owner, 's1', registered.leaseMarker)).toBe(true);
    expect(manager.state(owner, 's1')).toEqual({ mode: 'readonly', owned: false });
    expect(audit.records.at(-1)).toEqual(expect.objectContaining({ action: 'terminal.disconnected' }));
  });

  // ── P1-5: read-socket revocation index ────────────────────────────────────
  // logout / auth-session expiry must close every READ stream the session
  // opened — not only the write leases — and must never touch a different auth
  // session's sockets.

  it('logout closes exactly the ending auth session read sockets (write leases included)', () => {
    const manager = new TerminalControlManager({ secret: SECRET, audit: new MemoryAudit(), ttlMs: 10_000, now: () => 1_000 });
    const ending = actor('ou_viewer', 'auth-ending');
    const surviving = actor('ou_other', 'auth-surviving');
    const endingRead = { destroyed: false, destroy() { this.destroyed = true; } };
    const endingRead2 = { destroyed: false, destroy() { this.destroyed = true; } };
    const survivingRead = { destroyed: false, destroy() { this.destroyed = true; } };
    manager.registerReadSocket(ending.authSessionId, endingRead);
    manager.registerReadSocket(ending.authSessionId, endingRead2);
    manager.registerReadSocket(surviving.authSessionId, survivingRead);
    manager.takeover(ending, 's1');
    const writable = { destroyed: false, destroy() { this.destroyed = true; } };
    manager.registerWritableSocket(ending, 's1', writable);

    expect(manager.releaseByAuthSession(ending.authSessionId)).toBe(1);
    expect(endingRead.destroyed).toBe(true);
    expect(endingRead2.destroyed).toBe(true);
    expect(writable.destroyed).toBe(true);
    // 不同 authSession 不串：另一个登录的只读流原样活着。
    expect(survivingRead.destroyed).toBe(false);
  });

  it('a naturally closed read socket deregisters itself and is not re-destroyed on logout', () => {
    const manager = new TerminalControlManager({ secret: SECRET, audit: new MemoryAudit(), ttlMs: 10_000, now: () => 1_000 });
    let destroys = 0;
    const socket = { destroyed: false, destroy() { this.destroyed = true; destroys += 1; } };
    const deregister = manager.registerReadSocket('auth-1', socket);
    deregister();
    deregister(); // idempotent
    expect(manager.releaseByAuthSession('auth-1')).toBe(0);
    expect(destroys).toBe(0);
  });

  it('never puts terminal content or a grant in the required audit tuple', () => {
    const record: ControlAuditRecord = {
      timestamp: '2026-08-11T12:00:00.000Z',
      user: 'ou_owner',
      session: 's1',
      action: 'terminal.input',
      bytes: 17,
    };
    expect(record).toEqual({
      timestamp: expect.any(String),
      user: 'ou_owner',
      session: 's1',
      action: 'terminal.input',
      bytes: 17,
    });
    expect(Object.keys(record).sort()).toEqual(['action', 'bytes', 'session', 'timestamp', 'user']);
  });
});

// ─── P1-11：控制类 POST 的 CSRF / Origin 门禁（真实 HTTP 请求） ───────────────
//
// `SameSite=Lax` 只挡跨「站」：同站兄弟子域（中心化平台把每台机器放在
// `m-<id>.<host>` 下）和 localhost 的其它端口都算 same-site，cookie 照送。而
// takeover / release / preview 解锁全是**无 body** 的 POST，一个 `<form
// method=post>` 就能从任意页面触发，受害者甚至看不到响应——但终端写租约已经被
// 抢走、预览蒙层已经被解开。
//
// 这里起真实 HTTP 服务，跑与 dashboard.ts 同一套门禁（guardControlRequest +
// ControlCsrfTokens + injectControlCsrfMeta），断言真实请求的状态码与
// TerminalControlManager 的真实租约状态。
describe('P1-11 control POST CSRF/Origin gate (real requests)', () => {
  const SHELL = '<!doctype html><html><head><title>Botmux</title></head><body></body></html>';
  const OWNER_COOKIE = 'botmux_dashboard_token=active-management-token';
  let controlServer: Server | null = null;

  afterEach(async () => {
    if (controlServer) await new Promise<void>(resolve => controlServer!.close(() => resolve()));
    controlServer = null;
  });

  async function startControl(): Promise<{
    base: string;
    host: string;
    manager: TerminalControlManager;
    tokens: ControlCsrfTokens;
  }> {
    const manager = new TerminalControlManager({
      secret: SECRET, audit: new MemoryAudit(), ttlMs: 600_000, now: () => 1_000,
    });
    const tokens = new ControlCsrfTokens();
    const identityOf = (req: IncomingMessage) => (
      req.headers.cookie?.split(';').some(part => part.trim() === OWNER_COOKIE)
        ? { userId: 'legacy-owner', authSessionId: 'legacy-auth-session', expiresAt: 2_000_000 }
        : null
    );
    controlServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://dashboard.test');
      const identity = identityOf(req);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      if (!identity) return json(401, { ok: false, error: 'authentication_required' });
      // 页面加载：现签一枚票据注入壳（dashboard.ts 的 serveStatic 同款）。
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(injectControlCsrfMeta(SHELL, tokens.mint(identity.authSessionId)));
        return;
      }
      const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/control(?:\/(takeover|release))?$/);
      if (!match) return json(404, { ok: false, error: 'not_found' });
      if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
        const verdict = guardControlRequest({
          headers: req.headers,
          authSessionId: identity.authSessionId,
          tokens,
        });
        if (!verdict.ok) return json(verdict.status, { ok: false, error: verdict.error });
      }
      const sessionId = match[1];
      if (req.method === 'GET') return json(200, { ok: true, ...manager.state(identity, sessionId) });
      if (req.method === 'POST' && match[2] === 'takeover') {
        const result = manager.takeover(identity, sessionId);
        return json(result.ok ? 200 : 409, result.ok ? { ...result, owned: true } : { ok: false, error: result.error });
      }
      return json(405, { ok: false, error: 'method_not_allowed' });
    });
    await new Promise<void>(resolve => controlServer!.listen(0, '127.0.0.1', resolve));
    const port = (controlServer.address() as { port: number }).port;
    return { base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, manager, tokens };
  }

  async function pageToken(base: string): Promise<string> {
    const shell = await (await fetch(base, { headers: { cookie: OWNER_COOKIE } })).text();
    const match = shell.match(/<meta name="botmux-csrf" content="([^"]+)">/);
    expect(match, 'shell must carry an injected CSRF ticket').toBeTruthy();
    return match![1];
  }

  it('accepts a same-origin takeover carrying the page-injected ticket', async () => {
    const { base, host, manager } = await startControl();
    const csrf = await pageToken(base);
    const response = await fetch(`${base}/api/sessions/s1/control/takeover`, {
      method: 'POST',
      headers: {
        cookie: OWNER_COOKIE,
        origin: `http://${host}`,
        'sec-fetch-site': 'same-origin',
        'x-botmux-csrf': csrf,
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, owned: true });
    expect(manager.state({ userId: 'legacy-owner', authSessionId: 'legacy-auth-session', expiresAt: 2_000_000 }, 's1'))
      .toMatchObject({ mode: 'controlled', owned: true });
  });

  it('refuses a cross-site form-style takeover and leaves the terminal read-only', async () => {
    const { base, host, manager } = await startControl();
    const csrf = await pageToken(base);
    const actor = { userId: 'legacy-owner', authSessionId: 'legacy-auth-session', expiresAt: 2_000_000 };
    const cases: Array<{ name: string; headers: Record<string, string>; error: string }> = [
      {
        // 攻击页 `<form action=…/takeover method=post>`：浏览器带 cookie，
        // 也带一个对不上的 Origin，且无论如何设不了自定义头。
        name: 'cross-site form post',
        headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
        error: 'control_origin_forbidden',
      },
      {
        // 同站兄弟子域 / localhost 其它端口——SameSite=Lax 完全挡不住这一类。
        name: 'sibling subdomain (same-site, different host)',
        headers: { origin: `https://evil.${host}`, 'sec-fetch-site': 'same-site', 'x-botmux-csrf': csrf },
        error: 'control_origin_forbidden',
      },
      {
        name: 'localhost, other port',
        headers: { origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-site', 'x-botmux-csrf': csrf },
        error: 'control_origin_forbidden',
      },
      {
        // 完全剥掉来源信号：fail closed，不给「删头即绕过」的口子。
        name: 'no Origin / no Fetch-Metadata',
        headers: {},
        error: 'control_origin_forbidden',
      },
      {
        // 沙箱化预览（不透明来源）也不能反过来驱动管理端点。
        name: 'opaque origin',
        headers: { origin: 'null', 'sec-fetch-site': 'cross-site' },
        error: 'control_origin_forbidden',
      },
      {
        name: 'same-origin without the ticket',
        headers: { origin: `http://${host}`, 'sec-fetch-site': 'same-origin' },
        error: 'control_csrf_invalid',
      },
      {
        name: 'same-origin with a forged ticket',
        headers: { origin: `http://${host}`, 'sec-fetch-site': 'same-origin', 'x-botmux-csrf': 'not-a-real-ticket' },
        error: 'control_csrf_invalid',
      },
    ];
    for (const testCase of cases) {
      const response = await fetch(`${base}/api/sessions/s1/control/takeover`, {
        method: 'POST',
        headers: { cookie: OWNER_COOKIE, ...testCase.headers },
      });
      expect(response.status, testCase.name).toBe(403);
      expect(await response.json(), testCase.name).toEqual({ ok: false, error: testCase.error });
      expect(manager.state(actor, 's1'), testCase.name).toMatchObject({ mode: 'readonly', owned: false });
    }
  });

  it('binds the ticket to its own auth session and drops it when that session ends', async () => {
    const { base, host, tokens } = await startControl();
    const csrf = await pageToken(base);
    // 另一个认证会话签出的票据换不到本会话的操作。
    const foreign = tokens.mint('another-auth-session');
    const crossSession = await fetch(`${base}/api/sessions/s1/control/takeover`, {
      method: 'POST',
      headers: { cookie: OWNER_COOKIE, origin: `http://${host}`, 'x-botmux-csrf': foreign },
    });
    expect(crossSession.status).toBe(403);
    expect(await crossSession.json()).toEqual({ ok: false, error: 'control_csrf_invalid' });
    // 认证结束 → 该会话签出的票据全部作废（dashboard.ts 在 onEnd/rotate/解绑
    // 时调用同一个方法）。
    expect(tokens.revokeAuthSession('legacy-auth-session')).toBeGreaterThan(0);
    const afterLogout = await fetch(`${base}/api/sessions/s1/control/takeover`, {
      method: 'POST',
      headers: { cookie: OWNER_COOKIE, origin: `http://${host}`, 'x-botmux-csrf': csrf },
    });
    expect(afterLogout.status).toBe(403);
    expect(await afterLogout.json()).toEqual({ ok: false, error: 'control_csrf_invalid' });
  });

  it('leaves read-only state polling ungated (the shell polls it on a timer)', async () => {
    const { base } = await startControl();
    const response = await fetch(`${base}/api/sessions/s1/control`, { headers: { cookie: OWNER_COOKIE } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, mode: 'readonly' });
  });
});

// 反代 / 平台隧道：浏览器看到的域名在 X-Forwarded-Host 里，Host 可能已被改写成
// 回环地址。同源判定必须认这一条，否则平台上的工作台会被自己的门禁全部挡掉。
// 这不削弱防线：跨站页面既设不了 Origin，也设不了自定义的 X-Forwarded-Host。
describe('P1-11 same-origin behind a reverse proxy / platform tunnel', () => {
  const SHELL_ORIGIN = 'https://m-abc.platform.example';
  it('accepts the browser-visible origin when Host was rewritten by the hop', () => {
    expect(controlRequestOriginState({
      host: '127.0.0.1:8787',
      'x-forwarded-host': 'm-abc.platform.example',
      origin: SHELL_ORIGIN,
      'sec-fetch-site': 'same-origin',
    })).toBe('same-origin');
    expect(managementUpgradeOrigin({
      host: '127.0.0.1:8787',
      'x-forwarded-host': 'm-abc.platform.example',
      origin: SHELL_ORIGIN,
    })).toEqual({ ok: true });
  });

  it('still refuses a sibling machine subdomain on the same platform host', () => {
    expect(controlRequestOriginState({
      host: '127.0.0.1:8787',
      'x-forwarded-host': 'm-abc.platform.example',
      origin: 'https://m-victim.platform.example',
      'sec-fetch-site': 'same-site',
    })).toBe('foreign');
    expect(managementUpgradeOrigin({
      host: '127.0.0.1:8787',
      'x-forwarded-host': 'm-abc.platform.example',
      origin: 'https://m-victim.platform.example',
    })).toEqual({ ok: false, error: 'upgrade_origin_forbidden' });
  });
});

// 端口归一化：`new URL('https://dash.example').host` 会被 URL 规范剥成
// `dash.example`，而 `Host` 头是反代原样写进来的字符串，常见配置会写成
// `dash.example:443`。两边不对称归一化，自建反代的控制请求与终端 WS 就会被自己
// 的门禁全判成跨站——页面能开、只读能看，一操作就 403、终端连不上。
describe('P1-11 origin matching normalizes ports on both sides', () => {
  beforeEach(() => { vi.spyOn(logger, 'warn').mockImplementation(() => undefined); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('accepts an explicit default port on either side (proxy_set_header Host $host:$server_port)', () => {
    // https + :443
    expect(controlRequestOriginState({
      host: 'dash.example:443', origin: 'https://dash.example', 'sec-fetch-site': 'same-origin',
    })).toBe('same-origin');
    expect(managementUpgradeOrigin({ host: 'dash.example:443', origin: 'https://dash.example' }))
      .toEqual({ ok: true });
    // http + :80
    expect(controlRequestOriginState({ host: 'dash.example:80', origin: 'http://dash.example' }))
      .toBe('same-origin');
    // Origin 侧写显式端口、Host 侧不写，方向反过来也要认。
    expect(controlRequestOriginState({ host: 'dash.example', origin: 'https://dash.example:443' }))
      .toBe('same-origin');
  });

  it('accepts nginx 开箱默认：Host 被改写成上游回环地址，X-Forwarded-Host 带 :443', () => {
    expect(controlRequestOriginState({
      host: '127.0.0.1:8787',
      'x-forwarded-host': 'dash.example:443',
      origin: 'https://dash.example',
    })).toBe('same-origin');
    expect(managementUpgradeOrigin({
      host: '127.0.0.1:8787',
      'x-forwarded-host': 'dash.example:443',
      origin: 'https://dash.example',
    })).toEqual({ ok: true });
  });

  it('accepts the operator-declared BOTMUX_PUBLIC_URL when every proxy header lost the port', () => {
    // 对外走非默认端口 + `proxy_set_header Host $host;`（$host 不含端口）：两个
    // 请求头都推不出 :8443，只有运维显式声明的对外基址能救。
    const stripped = { host: 'box.example', origin: 'https://box.example:8443' } as const;
    expect(controlRequestOriginState({ ...stripped })).toBe('foreign');
    vi.stubEnv('BOTMUX_PUBLIC_URL', 'https://box.example:8443');
    expect(controlRequestOriginState({ ...stripped })).toBe('same-origin');
    expect(managementUpgradeOrigin({ ...stripped })).toEqual({ ok: true });
    // 它只为自己那一个 authority 背书，别的站点照旧拒。
    expect(controlRequestOriginState({ host: 'box.example', origin: 'https://evil.example:8443' }))
      .toBe('foreign');
  });

  it('keeps refusing真跨站与同域别的端口', () => {
    expect(controlRequestOriginState({ host: 'dash.example:443', origin: 'https://evil.example' }))
      .toBe('foreign');
    // 本地开发机上另一个 localhost 服务：端口不同就是不同源，不能因为归一化被放行。
    expect(controlRequestOriginState({ host: '127.0.0.1:8787', origin: 'http://127.0.0.1:9999' }))
      .toBe('foreign');
    // 候选不带端口时也不能通配放行非默认端口的 Origin。
    expect(controlRequestOriginState({ host: '127.0.0.1', origin: 'http://127.0.0.1:9999' }))
      .toBe('foreign');
    expect(managementUpgradeOrigin({ host: 'dash.example:443', origin: 'https://evil.example' }))
      .toEqual({ ok: false, error: 'upgrade_origin_forbidden' });
  });

  it('logs the origin and every candidate authority behind the 403 (运维唯一的线索)', () => {
    const warn = vi.mocked(logger.warn);
    expect(managementUpgradeOrigin({
      host: '127.0.0.1:8787',
      'x-forwarded-host': 'dash.example',
      origin: 'https://box.example:8443',
    })).toEqual({ ok: false, error: 'upgrade_origin_forbidden' });
    const logged = warn.mock.calls.map(call => String(call[0])).join('\n');
    expect(logged).toContain('https://box.example:8443');
    expect(logged).toContain('127.0.0.1:8787');
    expect(logged).toContain('dash.example');
    // 请求方可控字符串不能把换行带进日志。
    warn.mockClear();
    controlRequestOriginState({ host: 'dash.example', origin: 'https://evil.example' });
    expect(String(vi.mocked(logger.warn).mock.calls[0]?.[0] ?? '')).not.toContain('\n');
  });
});

// 票据的闲置寿命：还在用的页面续期，没人再用的自动回收。工作台常年挂在手机上
// 不刷新，固定寿命会让一个用了几天的页面突然「解锁交互」失败。
describe('P1-11 control ticket idle lifetime', () => {
  it('renews on use and expires only after an idle window', () => {
    let now = 1_000;
    const tokens = new ControlCsrfTokens({ ttlMs: 10_000, now: () => now });
    const ticket = tokens.mint('auth-1');
    now = 9_000;
    expect(tokens.verify(ticket, 'auth-1')).toBe(true);   // 续期到 19_000
    now = 18_000;
    expect(tokens.verify(ticket, 'auth-1')).toBe(true);   // 续期到 28_000
    now = 38_001;
    expect(tokens.verify(ticket, 'auth-1')).toBe(false);  // 闲置超窗 → 作废
    expect(tokens.size()).toBe(0);
  });

  it('bounds memory with FIFO eviction so page reloads cannot grow it without limit', () => {
    const tokens = new ControlCsrfTokens({ maxTokens: 3 });
    const first = tokens.mint('auth-1');
    tokens.mint('auth-1');
    tokens.mint('auth-1');
    tokens.mint('auth-1');
    expect(tokens.size()).toBe(3);
    expect(tokens.verify(first, 'auth-1')).toBe(false);
  });
});
