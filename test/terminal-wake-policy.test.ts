import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  issueTerminalControlGrant,
  signTerminalWakeProof,
  TERMINAL_WAKE_HEADER,
  TERMINAL_WAKE_PROOF_TTL_MS,
  verifyTerminalWakeProof,
} from '../src/core/terminal-control-grant.js';
import { startTerminalProxy, type TerminalProxyHandle } from '../src/core/terminal-proxy.js';
import {
  classifyTerminalWakeCredential,
  decideTerminalWake,
  terminalSessionSuspended,
  type TerminalWakeCredentialInput,
} from '../src/core/terminal-wake-policy.js';
import {
  deriveTerminalCardViewToken,
  deriveTerminalWriteToken,
} from '../src/core/terminal-write-auth.js';
import { createTerminalFrontProxy } from '../src/dashboard/terminal-front-proxy.js';
import {
  TerminalControlManager,
  type TerminalDashboardActor,
} from '../src/dashboard/terminal-control.js';

const SECRET = 'terminal-wake-policy-secret';
const SID = 'sess-wake';
const EPOCH = 'card-epoch-1';
const DASHBOARD_TOKEN = 'live-dashboard-token';
const NOW = 1_800_000_000_000;

function classify(overrides: Partial<TerminalWakeCredentialInput> = {}) {
  return classifyTerminalWakeCredential({
    secret: SECRET,
    sessionId: SID,
    session: { terminalCardEpoch: EPOCH },
    live: undefined,
    capability: {},
    headers: {},
    getDashboardToken: () => DASHBOARD_TOKEN,
    now: NOW,
    ...overrides,
  });
}

function grant(scope: 'read' | 'write', sessionId = SID, expiresAt = NOW + 60_000): string {
  return issueTerminalControlGrant(SECRET, {
    scope,
    sessionId,
    userId: 'platform:scope:guest',
    authSessionId: 'scope:guest',
    issuedAt: NOW - 1_000,
    expiresAt,
  });
}

describe('terminal wake proof', () => {
  it('verifies only for the session, secret and time window it was signed for', () => {
    const proof = signTerminalWakeProof(SECRET, SID, NOW)!;
    expect(verifyTerminalWakeProof(SECRET, SID, proof, NOW)).toBe(true);
    expect(verifyTerminalWakeProof(SECRET, SID, proof, NOW + TERMINAL_WAKE_PROOF_TTL_MS)).toBe(true);
    expect(verifyTerminalWakeProof(SECRET, SID, proof, NOW + TERMINAL_WAKE_PROOF_TTL_MS + 1)).toBe(false);
    expect(verifyTerminalWakeProof(SECRET, 'other-session', proof, NOW)).toBe(false);
    expect(verifyTerminalWakeProof('another-secret', SID, proof, NOW)).toBe(false);
  });

  it('rejects a re-timestamped, malformed or repeated value', () => {
    const proof = signTerminalWakeProof(SECRET, SID, NOW)!;
    const mac = proof.split('.')[1];
    expect(verifyTerminalWakeProof(SECRET, SID, `${NOW + 1}.${mac}`, NOW)).toBe(false);
    expect(verifyTerminalWakeProof(SECRET, SID, mac, NOW)).toBe(false);
    expect(verifyTerminalWakeProof(SECRET, SID, '', NOW)).toBe(false);
    expect(verifyTerminalWakeProof(SECRET, SID, undefined, NOW)).toBe(false);
    expect(verifyTerminalWakeProof(SECRET, SID, [proof, proof], NOW)).toBe(false);
  });

  it('is not a terminal control grant', () => {
    // A wake proof only lets the daemon wake; it must never read as access.
    const proof = signTerminalWakeProof(SECRET, SID, NOW)!;
    expect(classify({ headers: { 'x-botmux-terminal-control': proof } })).toBe('none');
  });
});

describe('classifyTerminalWakeCredential', () => {
  it('treats a write link as authenticated and a wrong one as nothing', () => {
    expect(classify({ capability: { token: deriveTerminalWriteToken(SECRET, SID) } })).toBe('authenticated');
    expect(classify({ capability: { token: deriveTerminalWriteToken(SECRET, 'other') } })).toBe('none');
  });

  it('treats the front proxy wake proof as authenticated even next to a bare read link', () => {
    const viewToken = deriveTerminalCardViewToken(SECRET, SID, EPOCH);
    expect(classify({
      capability: { viewToken },
      headers: { [TERMINAL_WAKE_HEADER]: signTerminalWakeProof(SECRET, SID, NOW)! },
    })).toBe('authenticated');
    expect(classify({
      capability: { viewToken },
      headers: { [TERMINAL_WAKE_HEADER]: signTerminalWakeProof(SECRET, 'other', NOW)! },
    })).toBe('read-link');
  });

  it('treats this host\'s Dashboard login cookie as authenticated, reading the token only when needed', () => {
    let reads = 0;
    const getDashboardToken = () => { reads++; return DASHBOARD_TOKEN; };
    expect(classify({
      headers: { cookie: `a=b; botmux_dashboard_token=${DASHBOARD_TOKEN}` },
      getDashboardToken,
    })).toBe('authenticated');
    expect(classify({ headers: { cookie: 'botmux_dashboard_token=stale' }, getDashboardToken })).toBe('none');
    expect(reads).toBe(2);
    expect(classify({ headers: {}, getDashboardToken })).toBe('none');
    expect(reads).toBe(2);
  });

  it('fails closed when the dashboard token cannot be read', () => {
    expect(classify({
      headers: { cookie: `botmux_dashboard_token=${DASHBOARD_TOKEN}` },
      getDashboardToken: () => { throw new Error('rotating'); },
    })).toBe('none');
  });

  it('splits signed terminal grants by scope', () => {
    expect(classify({ headers: { 'x-botmux-terminal-control': grant('write') } })).toBe('authenticated');
    // Read grant without the wake proof = the platform's anonymous read-only visitor.
    expect(classify({ headers: { 'x-botmux-terminal-control': grant('read') } })).toBe('read-link');
    expect(classify({ headers: { 'x-botmux-terminal-control': grant('write', 'other') } })).toBe('none');
    expect(classify({ headers: { 'x-botmux-terminal-control': grant('write', SID, NOW - 1) } })).toBe('none');
  });

  it('treats a card or live worker read capability as a bare read link', () => {
    expect(classify({
      capability: { viewToken: deriveTerminalCardViewToken(SECRET, SID, EPOCH) },
    })).toBe('read-link');
    expect(classify({
      live: { workerViewToken: 'boot-view', workerCardViewToken: null },
      capability: { viewToken: 'boot-view' },
    })).toBe('read-link');
    expect(classify({
      capability: { viewToken: deriveTerminalCardViewToken(SECRET, SID, 'rotated-away') },
    })).toBe('none');
  });

  it('gives nothing to a request without credentials or for an unknown session', () => {
    expect(classify()).toBe('none');
    expect(classify({
      session: undefined,
      capability: { token: deriveTerminalWriteToken(SECRET, SID) },
    })).toBe('none');
  });
});

describe('terminalSessionSuspended / decideTerminalWake', () => {
  it('counts only a deliberately parked session with no worker coming up', () => {
    expect(terminalSessionSuspended({ worker: null, session: { suspendedColdResume: true } })).toBe(true);
    expect(terminalSessionSuspended({ worker: { killed: true }, session: { suspendedColdResume: true } })).toBe(true);
    expect(terminalSessionSuspended({ worker: { killed: false }, session: { suspendedColdResume: true } })).toBe(false);
    expect(terminalSessionSuspended({ worker: null, session: {} })).toBe(false);
    expect(terminalSessionSuspended(undefined)).toBe(false);
  });

  it('wakes for authenticated requests, spares suspended sessions from read links, never wakes for nothing', () => {
    expect(decideTerminalWake('authenticated', true)).toBe('wake');
    expect(decideTerminalWake('authenticated', false)).toBe('wake');
    expect(decideTerminalWake('read-link', true)).toBe('suspended');
    expect(decideTerminalWake('read-link', false)).toBe('wake');
    expect(decideTerminalWake('none', true)).toBe('deny');
    expect(decideTerminalWake('none', false)).toBe('deny');
  });
});

// ── #2004 现场：daemon 代理 + 前门 + 真实判定串起来 ─────────────────────────────
//
// 会话被 idle_ttl 挂起（suspendedColdResume、无 worker）。只读卡片链接的 WS 自动
// 重连不得唤醒；同一条卡片链接由登录过的人经 Dashboard 前门打开则照常唤醒。

const servers: Server[] = [];
const proxies: TerminalProxyHandle[] = [];

afterEach(async () => {
  for (const proxy of proxies.splice(0)) await proxy.close();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

function rawUpgrade(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let raw = '';
    socket.on('data', chunk => { raw += chunk.toString(); });
    socket.on('close', () => resolve(raw));
    socket.on('error', reject);
  });
}

async function suspendedSessionProxy() {
  const worker = createServer((_req, res) => res.end('worker'));
  const workerPort = await listen(worker);
  const session = { session: { terminalCardEpoch: EPOCH, suspendedColdResume: true }, worker: null };
  let wakes = 0;
  const proxy = await startTerminalProxy({
    port: 0,
    host: '127.0.0.1',
    resolvePort: () => undefined,
    ensureWorkerPort: async () => { wakes++; return workerPort; },
    resolveSessionState: () => 'starting',
    resolveStatusPageLocale: () => 'zh',
    authorizeStatusPage: () => false,
    authorizeWake: (sessionId, request) => decideTerminalWake(classifyTerminalWakeCredential({
      ...request,
      secret: SECRET,
      sessionId,
      session: session.session,
      live: undefined,
      getDashboardToken: () => DASHBOARD_TOKEN,
    }), terminalSessionSuspended(session)),
  });
  proxies.push(proxy);
  return { proxy, wakes: () => wakes };
}

describe('#2004: a suspended session behind the terminal proxy', () => {
  const cardLink = `/s/${SID}/?viewToken=${encodeURIComponent(deriveTerminalCardViewToken(SECRET, SID, EPOCH))}`;

  it('answers a read-only reconnect with the suspended page and does not wake', async () => {
    const { proxy, wakes } = await suspendedSessionProxy();
    const page = await fetch(`http://127.0.0.1:${proxy.port}${cardLink}`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('会话已挂起');
    for (let i = 0; i < 3; i++) {
      expect(await rawUpgrade(proxy.port, cardLink)).toMatch(/^HTTP\/1\.1 503 [\s\S]*会话已挂起/);
    }
    expect(wakes()).toBe(0);
  });

  it('does not wake for a missing or stale credential', async () => {
    const { proxy, wakes } = await suspendedSessionProxy();
    expect((await fetch(`http://127.0.0.1:${proxy.port}/s/${SID}/`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${proxy.port}/s/${SID}/?token=stale`)).status).toBe(403);
    expect(await rawUpgrade(proxy.port, `/s/${SID}/`)).toMatch(/^HTTP\/1\.1 403 /);
    expect(wakes()).toBe(0);
  });

  it('wakes for a write link', async () => {
    const { proxy, wakes } = await suspendedSessionProxy();
    const res = await fetch(`http://127.0.0.1:${proxy.port}/s/${SID}/?token=${deriveTerminalWriteToken(SECRET, SID)}`);
    expect(await res.text()).toBe('worker');
    expect(wakes()).toBe(1);
  });

  it('wakes when a signed-in viewer opens the same card link through the Dashboard front door', async () => {
    const { proxy, wakes } = await suspendedSessionProxy();
    const openThroughFrontDoor = async (actor: TerminalDashboardActor) => {
      const front = createTerminalFrontProxy({
        resolvePort: () => proxy.port,
        resolveActor: () => actor,
        control: new TerminalControlManager({ secret: SECRET, audit: { append() {} } }),
        wakeProof: sessionId => signTerminalWakeProof(SECRET, sessionId),
      });
      const frontServer = createServer((req, res) => {
        if (!front.handleHttp(req, res, new URL(req.url ?? '/', 'http://front'))) res.writeHead(404).end();
      });
      const frontPort = await listen(frontServer);
      return fetch(`http://127.0.0.1:${frontPort}${cardLink}`);
    };

    // 平台免登录只读访客：能看，但不算鉴权 → 挂起页，不唤醒。
    const anonymous = await openThroughFrontDoor({
      userId: 'platform:scope:guest',
      authSessionId: 'scope:guest',
      expiresAt: Number.MAX_SAFE_INTEGER,
      terminalCapability: 'readonly',
      anonymous: true,
    });
    expect(anonymous.status).toBe(503);
    expect(await anonymous.text()).toContain('会话已挂起');
    expect(wakes()).toBe(0);

    // SSO 登录过的只读访客：照常唤醒（worker 仍按 viewToken 只给只读）。
    const signedIn = await openThroughFrontDoor({
      userId: 'platform:scope:on_viewer:guest',
      authSessionId: 'scope:on_viewer:guest',
      expiresAt: Number.MAX_SAFE_INTEGER,
      terminalCapability: 'readonly',
    });
    expect(await signedIn.text()).toBe('worker');
    expect(wakes()).toBe(1);
  });
});
