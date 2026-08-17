import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  issueTerminalControlGrant,
  verifyTerminalControlGrant,
} from '../src/core/terminal-control-grant.js';
import {
  TerminalControlManager,
  type TerminalDashboardActor,
} from '../src/dashboard/terminal-control.js';
import {
  createTerminalFrontProxy,
  parseTerminalFrontPath,
  terminalForwardHeaders,
  TERMINAL_CONTROL_HEADER,
  TERMINAL_VIEW_FORWARD_HEADER,
} from '../src/dashboard/terminal-front-proxy.js';
import {
  mintTerminalViewCapability,
  terminalViewCapabilityAuthSession,
  terminalViewForwardProof,
} from '../src/dashboard/terminal-view-capability.js';
import { deriveWorkerViewGeneration, verifyTerminalViewForward } from '../src/core/terminal-control-grant.js';

const SECRET = 'front-proxy-test-secret';
const WORKER_GENERATION = deriveWorkerViewGeneration(SECRET, 'front-proxy-boot-token')!;

function boundViewCapability(sessionId: string, authSessionId: string, expiresAt = Date.now() + 60_000): string {
  return mintTerminalViewCapability(
    SECRET,
    sessionId,
    { userId: 'ou_viewer', authSessionId, expiresAt },
    WORKER_GENERATION,
  )!.token;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('missing test port'));
      else resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

describe('central terminal front proxy boundary', () => {
  it('attaches a client error handler synchronously on early failure paths', () => {
    const proxy = createTerminalFrontProxy({
      resolvePort: () => undefined,
      resolveActor: () => null,
      control: {} as any,
    });
    const socket = new PassThrough();
    const req = { url: '/s/s1/', method: 'GET', headers: {} } as IncomingMessage;
    expect(proxy.handleUpgrade(req, socket, Buffer.alloc(0))).toBe(true);
    expect(socket.listenerCount('error')).toBeGreaterThan(0);
    expect(() => socket.emit('error', new Error('browser disconnected'))).not.toThrow();
  });

  it('decodes exactly one session path segment and rejects malformed IDs', () => {
    expect(parseTerminalFrontPath('/s/session%20one/')).toEqual({ sessionId: 'session one' });
    expect(parseTerminalFrontPath('/s/session%2Fescape/')).toBeNull();
    expect(parseTerminalFrontPath('/s/')).toBeNull();
    expect(parseTerminalFrontPath('/preview/s1/')).toBeNull();
  });

  it('strips browser credentials and forged Botmux headers before injecting one internal grant', () => {
    const grant = 'internal-short-lived-grant';
    const headers = terminalForwardHeaders({
      host: 'dashboard.example',
      cookie: 'botmux_dashboard_session=browser-secret',
      authorization: 'Bearer browser-secret',
      'proxy-authorization': 'Basic browser-secret',
      referer: 'https://dashboard.example/?t=legacy-secret',
      forwarded: 'host=attacker',
      'x-forwarded-host': 'attacker',
      'x-botmux-role': 'owner',
      [TERMINAL_CONTROL_HEADER]: 'forged-grant',
      'sec-websocket-protocol': 'terminal',
    }, grant);
    expect(headers).toEqual({
      host: 'dashboard.example',
      'sec-websocket-protocol': 'terminal',
      [TERMINAL_CONTROL_HEADER]: grant,
    });
    const serialized = JSON.stringify(headers);
    expect(serialized).not.toContain('browser-secret');
    expect(serialized).not.toContain('forged-grant');
    expect(serialized).not.toContain('?t=');
  });

  it('preserves legacy view/write capability requests when no Dashboard identity was resolved', () => {
    const original = {
      cookie: 'unrecognized=opaque',
      host: 'localhost',
      'x-test': 'value',
      [TERMINAL_CONTROL_HEADER]: 'client-replay-must-be-dropped',
    };
    expect(terminalForwardHeaders(original, undefined)).toEqual({
      cookie: 'unrecognized=opaque',
      host: 'localhost',
      'x-test': 'value',
    });
  });

  it('strips the legacy owner cookie when a separately minted query capability is used', () => {
    expect(terminalForwardHeaders({
      host: 'dashboard.example',
      cookie: 'botmux_dashboard=owner-secret',
      authorization: 'Bearer owner-secret',
      'x-test': 'kept',
      [TERMINAL_CONTROL_HEADER]: 'forged',
    }, undefined, { stripBrowserCredentials: true })).toEqual({
      host: 'dashboard.example',
      'x-test': 'kept',
    });
  });

  it('keeps default requests on short grants but validates explicit legacy links without cookies', async () => {
    const observed: Array<{ url: string; cookie?: string; grant?: string }> = [];
    const upstream = createServer((req, res) => {
      observed.push({
        url: req.url ?? '',
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
        ...(typeof req.headers[TERMINAL_CONTROL_HEADER] === 'string'
          ? { grant: req.headers[TERMINAL_CONTROL_HEADER] }
          : {}),
      });
      res.end('ok');
    });
    const upstreamPort = await listen(upstream);
    const proxy = createTerminalFrontProxy({
      resolvePort: () => upstreamPort,
      resolveActor: () => ({ userId: 'owner', authSessionId: 'legacy', expiresAt: Number.MAX_SAFE_INTEGER }),
      control: {
        grantForProxy: () => ({ token: 'short-read-grant', scope: 'read' }),
        registerReadSocket: () => () => {},
      } as any,
    });
    const front = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!proxy.handleHttp(req, res, url)) res.writeHead(404).end();
    });
    const frontPort = await listen(front);
    try {
      expect((await fetch(`http://127.0.0.1:${frontPort}/s/s1/`, {
        headers: { cookie: 'botmux_dashboard=owner-cookie' },
      })).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${frontPort}/s/s1/?token=worker-write`, {
        headers: { cookie: 'botmux_dashboard=owner-cookie' },
      })).status).toBe(200);
      expect(observed).toEqual([
        { url: '/s/s1/', grant: 'short-read-grant' },
        { url: '/s/s1/?token=worker-write' },
      ]);
    } finally {
      await close(front);
      await close(upstream);
    }
  });

  // ── P1-6: an explicit query capability is the SOLE authorization basis ─────
  // Regression shape being locked out: a platform teammate/guest opened a
  // correct 「操作链接」(?token=) through the central proxy, the proxy injected
  // its read-scope grant anyway, and the worker let the grant outrank the valid
  // write token — the explicitly issued write link rendered read-only.

  it('P1-6: platform teammate with an explicit write link gets NO injected grant and NO ambient credentials', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const upstream = createServer((req, res) => {
      observed.push({
        url: req.url ?? '',
        cookie: req.headers.cookie,
        role: req.headers['x-botmux-role'],
        grant: req.headers[TERMINAL_CONTROL_HEADER],
      });
      res.end('ok');
    });
    const upstreamPort = await listen(upstream);
    let grantMints = 0;
    const teammate = {
      userId: 'platform:scope:teammate',
      authSessionId: 'scope:teammate',
      expiresAt: Number.MAX_SAFE_INTEGER,
      terminalCapability: 'readonly' as const,
    };
    const proxy = createTerminalFrontProxy({
      resolvePort: () => upstreamPort,
      resolveActor: () => teammate,
      control: {
        grantForProxy: () => { grantMints += 1; return { token: 'read-grant', scope: 'read' }; },
        registerReadSocket: () => () => {},
      } as any,
    });
    const front = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!proxy.handleHttp(req, res, url)) res.writeHead(404).end();
    });
    const frontPort = await listen(front);
    try {
      // Correct or wrong is for the WORKER to decide; the proxy must forward
      // the token alone either way, so a wrong token cannot ride the ambient
      // owner cookie/role into writability, and a correct one is never
      // downgraded by an injected read grant.
      for (const query of ['?token=explicit-write-link', '?viewToken=some-view-capability']) {
        await fetch(`http://127.0.0.1:${frontPort}/s/s1/${query}`, {
          headers: {
            cookie: 'botmux_dashboard_token=platform-injected-machine-cookie',
            'x-botmux-role': 'teammate',
          },
        });
      }
      expect(grantMints).toBe(0);
      expect(observed).toEqual([
        { url: '/s/s1/?token=explicit-write-link', cookie: undefined, role: undefined, grant: undefined },
        { url: '/s/s1/?viewToken=some-view-capability', cookie: undefined, role: undefined, grant: undefined },
      ]);
    } finally {
      await close(front);
      await close(upstream);
    }
  });

  // ── P1-6 回归矩阵：6 身份 × 4 token 态，代理转发面一次钉死 ─────────────────
  // 评审要求的完整矩阵。代理层的职责是「转发什么」：
  //   • 带显式 query capability（正确/错误 write token、viewToken）时——对全部
  //     身份——只转发 query token 本身：不注入 grant、剥掉 ambient Cookie 与
  //     X-Botmux-Role。于是 worker 侧结论完全由 token 决定：正确 write token
  //     可写（独立最高权限，见 worker 集成测试的早返回）；错误 token 一无所有
  //     （借不到 ambient owner 变可写）；viewToken 只可能给读（永不升级）。
  //   • 无 token 时按身份角色注入内部 grant：owner=write，teammate/guest/H5/
  //     legacy（未接管）=read——「无 token 仍按角色和短 lease 判定」。
  it('P1-6 matrix: every identity × token state forwards exactly the decided credential', async () => {
    const observed: Array<{ url: string; cookie?: string; role?: string; grantScope?: 'read' | 'write' }> = [];
    const upstream = createServer((req, res) => {
      const grantHeader = req.headers[TERMINAL_CONTROL_HEADER];
      const verified = typeof grantHeader === 'string'
        ? verifyTerminalControlGrant(SECRET, grantHeader, 's1')
        : null;
      observed.push({
        url: req.url ?? '',
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
        ...(typeof req.headers['x-botmux-role'] === 'string' ? { role: req.headers['x-botmux-role'] as string } : {}),
        ...(verified?.ok ? { grantScope: verified.claims.scope } : {}),
      });
      res.end('ok');
    });
    const upstreamPort = await listen(upstream);

    const identities: Array<{ name: string; actor: TerminalDashboardActor | null; expectGrantScope?: 'read' | 'write' }> = [
      { name: 'legacy', actor: { userId: 'legacy-owner', authSessionId: 'legacy-auth', expiresAt: Number.MAX_SAFE_INTEGER, terminalCapability: 'controlled' }, expectGrantScope: 'read' },
      { name: 'platform-owner', actor: { userId: 'p:owner', authSessionId: 'scope:owner', expiresAt: Number.MAX_SAFE_INTEGER, terminalCapability: 'owner' }, expectGrantScope: 'write' },
      { name: 'platform-teammate', actor: { userId: 'p:teammate', authSessionId: 'scope:teammate', expiresAt: Number.MAX_SAFE_INTEGER, terminalCapability: 'readonly' }, expectGrantScope: 'read' },
      { name: 'platform-guest', actor: { userId: 'p:guest', authSessionId: 'scope:guest', expiresAt: Number.MAX_SAFE_INTEGER, terminalCapability: 'readonly' }, expectGrantScope: 'read' },
      { name: 'h5', actor: { userId: 'ou_h5', authSessionId: 'h5-auth', expiresAt: Date.now() + 30 * 60_000, terminalCapability: 'controlled' }, expectGrantScope: 'read' },
      { name: 'anonymous', actor: null },
    ];
    const tokenStates = [
      { name: 'none', query: '' },
      { name: 'viewToken', query: '?viewToken=opaque-view-capability' },
      { name: 'correct-write-token', query: '?token=stable-write-token' },
      { name: 'wrong-write-token', query: '?token=wrong-write-token' },
    ];

    for (const identity of identities) {
      const control = new TerminalControlManager({ secret: SECRET, audit: { append() {} } });
      const proxy = createTerminalFrontProxy({
        resolvePort: () => upstreamPort,
        resolveActor: () => identity.actor,
        control,
        isAuthSessionLive: () => true,
      });
      const front = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!proxy.handleHttp(req, res, url)) res.writeHead(404).end();
      });
      const frontPort = await listen(front);
      try {
        for (const tokenState of tokenStates) {
          observed.length = 0;
          const response = await fetch(`http://127.0.0.1:${frontPort}/s/s1/${tokenState.query}`, {
            headers: {
              cookie: 'botmux_dashboard_token=ambient-management-cookie',
              'x-botmux-role': 'owner',
            },
          });
          const cell = `${identity.name} × ${tokenState.name}`;
          expect(response.status, cell).toBe(200);
          expect(observed, cell).toHaveLength(1);
          const forwarded = observed[0];
          expect(forwarded.url, cell).toBe(`/s/s1/${tokenState.query}`);
          if (tokenState.name === 'none') {
            if (identity.actor) {
              // 无 token → 身份角色决定注入的内部 grant scope。
              expect(forwarded.grantScope, cell).toBe(identity.expectGrantScope);
              expect(forwarded.cookie, cell).toBeUndefined();
              expect(forwarded.role, cell).toBeUndefined();
            } else {
              // 匿名直连保留历史 query/头透传语义，worker 自行判定（无凭证即 403）。
              expect(forwarded.grantScope, cell).toBeUndefined();
              expect(forwarded.cookie, cell).toBe('botmux_dashboard_token=ambient-management-cookie');
            }
          } else {
            // 显式 query capability（对错皆然）→ 唯一授权依据：无 grant、无 ambient。
            expect(forwarded.grantScope, cell).toBeUndefined();
            expect(forwarded.cookie, cell).toBeUndefined();
            expect(forwarded.role, cell).toBeUndefined();
          }
        }
      } finally {
        await close(front);
      }
    }
    await close(upstream);
  });

  // ── P1-5: bound view capabilities are refused once their auth session died ─

  it('P1-5: a bound view capability of a revoked auth session is refused before the worker', async () => {
    let upstreamHits = 0;
    const upstream = createServer((_req, res) => { upstreamHits += 1; res.end('ok'); });
    const upstreamPort = await listen(upstream);
    const live = new Set(['h5-auth-live']);
    const proxy = createTerminalFrontProxy({
      resolvePort: () => upstreamPort,
      resolveActor: () => null,
      control: { registerReadSocket: () => () => {} } as any,
      viewCapabilityAuthSession: (sessionId, viewToken) =>
        terminalViewCapabilityAuthSession(SECRET, sessionId, viewToken),
      isAuthSessionLive: authSessionId => live.has(authSessionId),
    });
    const front = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!proxy.handleHttp(req, res, url)) res.writeHead(404).end();
    });
    const frontPort = await listen(front);
    try {
      const liveCapability = boundViewCapability('s1', 'h5-auth-live');
      const revokedCapability = boundViewCapability('s1', 'h5-auth-logged-out');
      expect((await fetch(`http://127.0.0.1:${frontPort}/s/s1/?viewToken=${encodeURIComponent(liveCapability)}`)).status).toBe(200);
      expect(upstreamHits).toBe(1);
      const refused = await fetch(`http://127.0.0.1:${frontPort}/s/s1/?viewToken=${encodeURIComponent(revokedCapability)}`);
      expect(refused.status).toBe(403);
      expect(await refused.text()).toBe('view capability revoked');
      // 吊销在代理层拦截，worker 一个字节都不该看到。
      expect(upstreamHits).toBe(1);
      // A capability for ANOTHER session id resolves to no auth session — the
      // worker's session-mismatch check owns that rejection, not liveness.
      const crossSession = boundViewCapability('other-session', 'h5-auth-live');
      expect((await fetch(`http://127.0.0.1:${frontPort}/s/s1/?viewToken=${encodeURIComponent(crossSession)}`)).status).toBe(200);
      expect(upstreamHits).toBe(2);
    } finally {
      await close(front);
      await close(upstream);
    }
  });

  it('P1-5: countersigns ONLY a live bound capability, and the browser can never supply that proof', async () => {
    // 这把签名是「读连接确实经过了持有吊销状态的中央前门」的唯一证据。worker 见不到
    // dashboard 的登出状态，只能认这把章；所以它必须：只对活着的绑定能力盖、只盖当前
    // 这一条、且浏览器自己伪造不出来。
    const seen: Array<{ url: string; proof?: string }> = [];
    const upstream = createServer((req, res) => {
      const raw = req.headers[TERMINAL_VIEW_FORWARD_HEADER];
      seen.push({ url: req.url ?? '', ...(typeof raw === 'string' ? { proof: raw } : {}) });
      res.end('ok');
    });
    const upstreamPort = await listen(upstream);
    const live = new Set(['h5-auth-live']);
    const proxy = createTerminalFrontProxy({
      resolvePort: () => upstreamPort,
      resolveActor: () => null,
      control: { registerReadSocket: () => () => {} } as any,
      viewCapabilityAuthSession: (sessionId, viewToken) =>
        terminalViewCapabilityAuthSession(SECRET, sessionId, viewToken),
      isAuthSessionLive: authSessionId => live.has(authSessionId),
      viewCapabilityForwardProof: viewToken => terminalViewForwardProof(SECRET, viewToken),
    });
    const front = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!proxy.handleHttp(req, res, url)) res.writeHead(404).end();
    });
    const frontPort = await listen(front);
    const get = (query: string, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${frontPort}/s/s1/?${query}`, { headers });
    try {
      // 活着的绑定能力：盖章放行，章对得上这一条能力。
      const capability = boundViewCapability('s1', 'h5-auth-live');
      expect((await get(`viewToken=${encodeURIComponent(capability)}`)).status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(verifyTerminalViewForward(SECRET, capability, seen[0].proof)).toBe(true);

      // 浏览器自带的伪造章在这一跳被整条丢掉，换成前门自己算的那把。
      const forged = 'forged-forward-proof';
      expect((await get(`viewToken=${encodeURIComponent(capability)}`, {
        [TERMINAL_VIEW_FORWARD_HEADER]: forged,
      })).status).toBe(200);
      expect(seen[1].proof).not.toBe(forged);
      expect(verifyTerminalViewForward(SECRET, capability, seen[1].proof)).toBe(true);

      // 已登出的绑定能力：403 在前门就拦下，worker 一个字节都收不到，更不可能拿到章。
      const revoked = boundViewCapability('s1', 'h5-auth-logged-out');
      expect((await get(`viewToken=${encodeURIComponent(revoked)}`)).status).toBe(403);
      expect(seen).toHaveLength(2);

      // 内部环回 read grant（无 audience）不是给浏览器用的能力：前门不认、也不盖章，
      // 于是它到了 worker 一样过不去——内部凭证不会因为塞进 URL 就多出一条浏览器通道。
      const internal = issueTerminalControlGrant(SECRET, {
        scope: 'read', sessionId: 's1', userId: 'ou_viewer', authSessionId: 'h5-auth-live',
        issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000,
      });
      expect((await get(`viewToken=${encodeURIComponent(internal)}`)).status).toBe(200);
      expect(seen[2].proof).toBeUndefined();

      // worker 每 boot 的卡片 token 走的是明文相等那条路，本来就不经过绑定能力，
      // 不该被盖章（飞书卡片链接的语义一个字不动）。
      expect((await get('viewToken=front-proxy-boot-token')).status).toBe(200);
      expect(seen[3].proof).toBeUndefined();
    } finally {
      await close(front);
      await close(upstream);
    }
  });

  it('P1-5: logout closes the bridged read WebSocket registered under its auth session', async () => {
    const control = new TerminalControlManager({ secret: SECRET, audit: { append() {} } });
    const upstream = createServer(() => {});
    upstream.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
      // HTTP server sockets allow half-open; after the bridge is torn down the
      // peer's FIN alone would leave this side open and server.close() waiting.
      socket.on('end', () => socket.destroy());
      socket.on('error', () => socket.destroy());
    });
    const upstreamPort = await listen(upstream);
    const proxy = createTerminalFrontProxy({
      resolvePort: () => upstreamPort,
      resolveActor: () => null,
      control,
      viewCapabilityAuthSession: (sessionId, viewToken) =>
        terminalViewCapabilityAuthSession(SECRET, sessionId, viewToken),
      isAuthSessionLive: () => true,
    });
    const front = createServer((_req, res) => res.writeHead(404).end());
    front.on('upgrade', (req, socket, head) => {
      if (!proxy.handleUpgrade(req, socket, head)) socket.destroy();
    });
    const frontPort = await listen(front);
    try {
      const capability = boundViewCapability('s1', 'h5-auth-9');
      const client = connect(frontPort, '127.0.0.1');
      const upgraded = new Promise<void>((resolve, reject) => {
        let raw = '';
        client.on('data', chunk => {
          raw += chunk.toString();
          if (raw.includes('101')) resolve();
        });
        client.on('error', reject);
        setTimeout(() => reject(new Error(`no 101 upgrade\n${raw}`)), 4_000).unref();
      });
      client.write(
        `GET /s/s1/?viewToken=${encodeURIComponent(capability)} HTTP/1.1\r\nHost: front\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
      await upgraded;
      const closed = new Promise<void>(resolve => client.on('close', () => resolve()));
      // H5 logout / session expiry sweeps this auth session — the bridged
      // read socket must die immediately, not at the token's expiry.
      control.releaseByAuthSession('h5-auth-9');
      await closed;
    } finally {
      await close(front);
      await close(upstream);
    }
  });
});
