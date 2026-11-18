import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startIpcServer, setIpcAuthSecret, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders, fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { withBotTurnMutation, __testOnly_resetBotTurnMutationGates } from '../src/core/bot-turn-mutation-gate.js';
import * as pool from '../src/core/worker-pool.js';
import * as sessionManager from '../src/core/session-manager.js';
import { registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { resolveDashboardIdentity, resolveDashboardRequestGate } from '../src/dashboard/request-identity.js';
import { parseCookie, signCliAuth } from '../src/dashboard/auth.js';
import { ControlCsrfTokens, guardControlRequest } from '../src/dashboard/control-csrf.js';
import { sessionWriteOriginAllowed } from '../src/dashboard/session-write-origin.js';
import { jsonRes } from '../src/dashboard/http.js';

const APP = 'cli_http_review';
const SID = 'native-http-review';
const PATH = `/api/sessions/${SID}/resume-target`;
const SECRET = 'ephemeral-http-review-ipc-secret';
const TOKEN = 'ephemeral-http-review-dashboard-token';
const input = {
  sourceId: '00000000-0000-4000-8000-000000000001',
  targetId: '00000000-0000-4000-8000-000000000002',
  sourceSha256: 'a'.repeat(64),
  targetSha256: 'b'.repeat(64),
};
const cookie = `botmux_dashboard_token=${TOKEN}`;
const privateText = 'PRIVATE_HTTP_REVIEW_/private/history.jsonl_TOKEN';
let ipc: IpcServerHandle;
let dashboard: Server | undefined;
let base = '';
let ds: any;
let lookup: ReturnType<typeof vi.spyOn>;
let send: ReturnType<typeof vi.fn>;
let releaseGate: (() => void) | undefined;
let heldGate: Promise<unknown> | undefined;
let csrf: ControlCsrfTokens;
let csrfNow: number;
let activeToken: string;
let proxy: ReturnType<typeof vi.fn>;
let owner: string | undefined;
let extraIpc: IpcServerHandle | undefined;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

// 非文本断言：只将目标路由、异常出口和两个小函数作为可执行夹具，不启动 Dashboard 的宿主服务。
// 源码结构护栏(K2)：管理路由尚无导出 seam；内存变异只删除这条路由的 CSRF 调用，不写生产文件。
function dashboardRoute() {
  const source = ts.createSourceFile('dashboard.ts',
    readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  let route: ts.IfStatement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(source).includes('resume-target')) route = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!route) throw new Error('resume-target Dashboard route missing');
  let outer: ts.Node | undefined = route.parent;
  while (outer && !ts.isTryStatement(outer)) outer = outer.parent;
  if (!outer || !ts.isTryStatement(outer) || !outer.catchClause) throw new Error('Dashboard error boundary missing');
  const errorBoundary = outer.catchClause.getText(source);
  let routeNode: ts.Node = route;
  if (process.env.NATIVE_HTTP_REVIEW_MUTATION === 'drop-csrf') {
    routeNode = ts.transform(route, [context => node => {
      const mutate: ts.Visitor = child => {
        if (ts.isIfStatement(child) && child.expression.getText(source).includes('enforceControlCsrf')) {
          return ts.factory.createEmptyStatement();
        }
        return ts.visitEachChild(child, mutate, context);
      };
      return ts.visitNode(node, mutate) as ts.IfStatement;
    }]).transformed[0];
  }
  const helpers = ['readJsonBody', 'enforceControlCsrf'].map(name => {
    const fn = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
    if (!fn) throw new Error(`Dashboard seam missing: ${name}`);
    return fn.getText(source);
  }).join('\n');
  const printed = ts.createPrinter().printNode(ts.EmitHint.Unspecified, routeNode, source);
  const code = ts.transpileModule(`${helpers}
    async function route(req, res, url, authed, requestIdentity) {
      try {
        let m; ${printed}
        if (!res.writableEnded) jsonRes(res, 404, {ok:false});
      } ${errorBoundary}
    }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return (scope: Record<string, unknown>) =>
    new Function(...Object.keys(scope), `${code}; return route;`)(...Object.values(scope));
}
const createRoute = dashboardRoute();

beforeEach(async () => {
  activeToken = TOKEN;
  owner = APP;
  csrfNow = Date.now();
  csrf = new ControlCsrfTokens({ now: () => csrfNow, ttlMs: 1000 });
  registerBot({ larkAppId: APP, larkAppSecret: 'not-live', cliId: 'traex', apiOnly: true });
  registerBot({ larkAppId: 'cli_foreign', larkAppSecret: 'not-live', cliId: 'traex', apiOnly: true });
  send = vi.fn();
  ds = {
    larkAppId: APP, worker: { killed: false, send }, workerGeneration: 1,
    workerReady: true, cliReady: true, lastScreenStatus: 'idle',
    initConfig: { cliId: 'traex', backendType: 'pty', sandbox: false, prompt: privateText, env: { TOKEN: privateText } },
    session: { sessionId: SID, status: 'active', cliId: 'traex', cliSessionId: input.sourceId },
  };
  // Only substitute the active-session lookup and physical IPC sink. Restart
  // admission, readback, HMAC verification and the mutation gate remain real.
  lookup = vi.spyOn(pool, 'findActiveBySessionId').mockImplementation(id => id === SID ? ds : undefined);
  vi.stubEnv('BOTMUX_SANDBOX', '0');
  setIpcAuthSecret(SECRET);
  setLarkAppId(APP);
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
});

afterEach(async () => {
  releaseGate?.();
  await heldGate;
  releaseGate = undefined;
  heldGate = undefined;
  dashboard?.closeAllConnections();
  if (dashboard) await new Promise<void>(r => dashboard!.close(() => r()));
  dashboard = undefined;
  await extraIpc?.close();
  extraIpc = undefined;
  await ipc?.close();
  pool.__testOnly_resetRestartCoordinator();
  __testOnly_resetBotTurnMutationGates();
  __testOnly_resetBotRegistry();
  setIpcAuthSecret(null);
  setLarkAppId('');
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function call(method = 'POST', body: unknown = input, headers?: HeadersInit, path = PATH) {
  const signed = headers ?? daemonIpcAuthHeaders({ secret: SECRET, port: ipc.port, method, path });
  return fetch(`http://127.0.0.1:${ipc.port}${path}`, {
    method, headers: signed, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

async function startDashboard() {
  proxy = vi.fn((appId: string, path: string, init: RequestInit) => {
    if (appId !== APP) return Promise.resolve(new Response('{"ok":false,"error":"daemon_offline"}', { status: 503 }));
    return fetchDaemonIpc(ipc.port, path, init, SECRET);
  });
  const route = createRoute({
    jsonRes, dashboardControlJson: jsonRes, guardControlRequest, controlCsrfTokens: csrf,
    sessionWriteOriginAllowed, aggregator: { ownerOf: () => owner }, proxyToDaemon: proxy,
    DashboardJsonBodyTooLargeError: Error, logger: { error: vi.fn() },
  });
  dashboard = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, base);
      const identity = resolveDashboardIdentity({
        legacyCookie: parseCookie(req.headers.cookie), activeToken,
        roleHeader: req.headers['x-botmux-role'], actorHeader: req.headers['x-botmux-actor'],
        scopesHeader: req.headers['x-botmux-scopes'], platformMachineId: 'fixture-machine',
        platformActorScope: id => id, legacyAuthSessionId: token => `legacy:${token}`,
        h5: req.headers['x-test-h5'] ? { kind: 'feishu-h5', userId: 'ou_fixture',
          authSessionId: 'h5-only', expiresAt: Number.MAX_SAFE_INTEGER } as any : null,
      });
      const gate = resolveDashboardRequestGate({
        method: req.method!, pathname: url.pathname, hasTokenParam: url.searchParams.has('t'), identity,
        tokenFromRequest: url.searchParams.get('t') === activeToken ? activeToken : parseCookie(req.headers.cookie),
        activeToken, publicReadOnly: true,
      });
      if (gate.decision.kind === 'deny401') return jsonRes(res, 401, { ok: false });
      if (gate.decision.kind === 'allow+set-cookie') {
        res.writeHead(302, { location: gate.decision.redirectTo }); res.end(); return;
      }
      if (!sessionWriteOriginAllowed(req, url.pathname)) return jsonRes(res, 403, { ok: false });
      await route(req, res, url, gate.canManageHost, identity);
    } catch {
      // Infrastructure exceptions are not translated into a success response.
      jsonRes(res, 500, { ok: false, error: 'upstream_failed' });
    }
  });
  await new Promise<void>(r => dashboard!.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(dashboard.address() as { port: number }).port}`;
}
function dashboardCall(method = 'POST', headers: Record<string, string> = {}, body: unknown = input) {
  return fetch(`${base}${PATH}`, { method, redirect: 'manual', headers,
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
}
function browserHeaders() {
  return { cookie, origin: base, 'x-botmux-csrf': csrf.mint(`legacy:${activeToken}`) };
}
async function blockGate() {
  const entered = deferred();
  const release = deferred();
  releaseGate = () => release.resolve();
  heldGate = withBotTurnMutation(APP, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
}
async function waitForLookup() {
  await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
}

describe('native HTTP review: IPC management authority', () => {
  it.each(['GET', 'POST'])('%s rejects unsigned, capability-only, wrong secret/method/path/port, bare and expired HMAC', async method => {
    const bind = { secret: SECRET, port: ipc.port, method, path: PATH };
    const bare = signCliAuth(SECRET);
    const expired = daemonIpcAuthHeaders(bind);
    expired.set('X-Botmux-Cli-Ts', '1');
    for (const headers of [
      {}, { authorization: `Bearer ${'ab'.repeat(32)}`, 'x-botmux-origin-capability': 'ab'.repeat(32) },
      daemonIpcAuthHeaders({ ...bind, secret: 'wrong' }),
      daemonIpcAuthHeaders({ ...bind, method: method === 'GET' ? 'POST' : 'GET' }),
      daemonIpcAuthHeaders({ ...bind, path: '/api/sessions/other/resume-target' }),
      daemonIpcAuthHeaders({ ...bind, port: ipc.port + 1 }),
      { 'X-Botmux-Cli-Ts': bare.ts, 'X-Botmux-Cli-Nonce': bare.nonce, 'X-Botmux-Cli-Auth': bare.sig },
      expired,
    ]) {
      const r = await call(method, input, headers);
      expect(r.status).toBe(401);
      expect(await r.text()).not.toContain(input.sourceId);
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('consumes a valid HMAC once; replay and another listener cannot reuse it', async () => {
    const headers = daemonIpcAuthHeaders({ secret: SECRET, port: ipc.port, method: 'POST', path: PATH });
    const first = await call('POST', input, headers);
    expect(first.status).toBe(202);
    const replay = await call('POST', input, headers);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ reason: 'replay' });
    extraIpc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const freshWrongPort = daemonIpcAuthHeaders({ secret: SECRET, port: ipc.port, method: 'POST', path: PATH });
    const foreign = await fetch(`http://127.0.0.1:${extraIpc.port}${PATH}`,
      { method: 'POST', headers: freshWrongPort, body: JSON.stringify(input) });
    expect(foreign.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['GET', 'POST'])('%s refuses another Bot and unknown session without revealing identity', async method => {
    ds.larkAppId = 'cli_foreign';
    for (const path of [PATH, '/api/sessions/not-owned/resume-target']) {
      const r = await call(method, input, undefined, path);
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain(input.sourceId);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('the handler stays management-only even in a lightweight authRequired:false listener', async () => {
    extraIpc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: false });
    for (const method of ['GET', 'POST']) {
      const r = await fetch(`http://127.0.0.1:${extraIpc.port}${PATH}`,
        { method, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) });
      expect(r.status).toBe(403);
    }
    expect(send).not.toHaveBeenCalled();
  });
});

describe('native HTTP review: actual Dashboard route and IPC proxy', () => {
  beforeEach(startDashboard);

  it.each(['GET', 'POST'])('%s denies anonymous, H5, expired cookie, platform guest and owner without manage scope', async method => {
    for (const headers of [
      {}, { 'x-test-h5': '1' }, { cookie: 'botmux_dashboard_token=expired' },
      { cookie, 'x-botmux-role': 'guest', 'x-botmux-scopes': 'dashboard:manage' },
      { cookie, 'x-botmux-role': 'owner' },
      { 'x-botmux-role': 'owner', 'x-botmux-scopes': 'dashboard:manage' },
    ]) {
      const r = await dashboardCall(method, headers);
      expect(r.status).toBe(401);
      expect(await r.text()).not.toContain(input.sourceId);
    }
    expect(proxy).not.toHaveBeenCalled();
  });

  it('CSRF guard rejects same-origin management POST without a ticket', async () => {
    const r = await dashboardCall('POST', { cookie, origin: base });
    expect(r.status).toBe(403);
    expect(proxy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('a management-token bootstrap URL redirects instead of bypassing the POST CSRF check', async () => {
    const r = await fetch(`${base}${PATH}?t=${TOKEN}`, {
      method: 'POST', redirect: 'manual', body: JSON.stringify(input),
    });
    expect(r.status).toBe(302);
    expect(proxy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects foreign/missing origin, wrong-session, expired and revoked CSRF tickets', async () => {
    const valid = browserHeaders();
    for (const headers of [
      { ...valid, origin: 'http://127.0.0.1:1' }, { ...valid, origin: 'null' },
      { cookie, 'x-botmux-csrf': valid['x-botmux-csrf'] },
      { ...valid, 'x-botmux-csrf': csrf.mint('different-login') },
      { ...valid, 'sec-fetch-site': 'cross-site' },
    ]) expect((await dashboardCall('POST', headers)).status).toBe(403);
    csrfNow += 1001;
    expect((await dashboardCall('POST', valid)).status).toBe(403);
    const revoked = browserHeaders();
    csrf.revokeAuthSession(`legacy:${activeToken}`);
    expect((await dashboardCall('POST', revoked)).status).toBe(403);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('management GET and same-origin POST reach real signed IPC but admission never claims completion', async () => {
    const get = await dashboardCall('GET', { cookie });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ nativeSessionId: input.sourceId, transition: null });
    const r = await dashboardCall('POST', browserHeaders());
    expect(r.status).toBe(202);
    const admitted = await r.json();
    expect(admitted).toMatchObject({ state: 'accepted', sourceId: input.sourceId, targetId: input.targetId });
    expect(admitted.attemptId).toBe(send.mock.calls[0][0].attemptId);
    const state = await (await dashboardCall('GET', { cookie })).json();
    expect(state).toMatchObject({ nativeSessionId: input.sourceId, workerReady: false, cliReady: false, busy: true,
      transition: { attemptId: admitted.attemptId, state: 'in_progress' } });
    expect(JSON.stringify(state)).not.toContain(privateText);
  });

  it('explicit platform dashboard:manage is sufficient, but its CSRF is actor-bound', async () => {
    const headers = { cookie, origin: base, 'x-botmux-role': 'owner',
      'x-botmux-actor': 'on_manager', 'x-botmux-scopes': 'dashboard:manage' };
    expect((await dashboardCall('POST', { ...headers, 'x-botmux-csrf': csrf.mint('fixture-machine:on_other:owner') })).status).toBe(403);
    expect((await dashboardCall('POST', { ...headers, 'x-botmux-csrf': csrf.mint('fixture-machine:on_manager:owner') })).status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('missing/foreign owner, malformed body and partial physical send failure preserve non-success status', async () => {
    owner = undefined;
    expect((await dashboardCall('GET', { cookie })).status).toBe(404);
    owner = 'cli_foreign';
    expect((await dashboardCall('POST', browserHeaders())).status).toBe(503);
    owner = APP;
    expect((await dashboardCall('POST', browserHeaders(), { ...input, prompt: privateText })).status).toBe(400);
    send.mockImplementation(() => { throw new Error(privateText); });
    const r = await dashboardCall('POST', browserHeaders());
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain(privateText);
    const state = await (await dashboardCall('GET', { cookie })).json();
    expect(state).toMatchObject({ nativeSessionId: input.sourceId, workerReady: true, cliReady: true,
      transition: { state: 'failed' } });
  });

  it('rotating management credentials rejects a later request with the old cookie and CSRF', async () => {
    const old = browserHeaders();
    activeToken = 'new-management-token';
    expect((await dashboardCall('POST', old)).status).toBe(401);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('oversized and invalid JSON fail before daemon admission', async () => {
    expect((await dashboardCall('POST', browserHeaders(), { ...input, sourceId: 'x'.repeat(5000) })).status).toBe(400);
    const r = await fetch(`${base}${PATH}`, { method: 'POST', headers: browserHeaders(), body: '{"incomplete":' });
    expect(r.status).toBe(400);
    expect(proxy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('native HTTP review: intervention, partial failure and late calls', () => {
  it('session replacement during the Bot gate wait refuses the admitted predecessor', async () => {
    await blockGate();
    const pending = call();
    await waitForLookup();
    ds = { ...ds, workerGeneration: 2, session: { ...ds.session } };
    releaseGate!();
    const r = await pending;
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: 'session_changed' });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['queued', 'raw-input', 'source-change', 'background-task'])('manual %s while waiting is not admitted as a successful replacement', async intervention => {
    await blockGate();
    const pending = call();
    await waitForLookup();
    if (intervention === 'queued') ds.session.queued = true;
    if (intervention === 'raw-input') ds.pendingRawInput = { text: 'human input' };
    if (intervention === 'source-change') ds.session.cliSessionId = input.targetId;
    if (intervention === 'background-task') ds.backgroundTaskCount = 1;
    releaseGate!();
    expect((await pending).status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it('freshly signed concurrent duplicates cause only one physical restart and never join a different target', async () => {
    const responses = await Promise.all([call(), call(), call('POST', {
      ...input, targetId: '00000000-0000-4000-8000-000000000003',
    })]);
    expect(responses.map(r => r.status).sort()).toEqual([202, 409, 409]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('silence after admission times out without changing native identity or allowing a blind retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const r = await call();
    expect(r.status).toBe(202);
    const admitted = await r.json();
    await vi.advanceTimersByTimeAsync(60_000);
    const state = await (await call('GET')).json();
    expect(state).toMatchObject({ nativeSessionId: input.sourceId, workerReady: false, cliReady: false, busy: true,
      transition: { attemptId: admitted.attemptId, state: 'timed_out' } });
    expect((await call()).status).toBe(409);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('readback after replacing the DaemonSession does not inherit the old transition', async () => {
    expect((await call()).status).toBe(202);
    ds = { ...ds, worker: { killed: false, send }, workerGeneration: 2, workerReady: true, cliReady: true,
      session: { ...ds.session, cliSessionId: input.targetId } };
    const state = await (await call('GET')).json();
    expect(state).toMatchObject({ transition: null, workerGeneration: 2, nativeSessionId: input.targetId });
  });

  it.each(['pendingRawInput', 'pendingFollowUpInput'])('pending %s keeps the HTTP completion predicate busy', async field => {
    ds.session.cliSessionId = input.targetId;
    ds[field] = { text: 'manual input awaiting admission' };
    expect(pool.sessionAcceptsDirectCommand(ds)).toBe(false);
    const r = await call('GET');
    expect(r.status).toBe(200);
    const state = await r.json();
    expect(state).toMatchObject({ nativeSessionId: input.targetId, workerReady: true, cliReady: true, busy: true });
  });

  it('an accepted input without its exact terminal keeps readback busy even on an idle screen', async () => {
    ds.session.cliSessionId = input.targetId;
    ds.acceptedInputTurns = new Map([['open-turn', {
      workerGeneration: ds.workerGeneration, turnId: 'open-turn', phase: 'native-submit', at: Date.now(),
    }]]);
    expect(pool.hasUnsettledAcceptedInput(ds)).toBe(true);
    const state = await (await call('GET')).json();
    expect(state).toMatchObject({ nativeSessionId: input.targetId, workerReady: true, cliReady: true, busy: true });
  });

  it('an exception before startFailure normalization is redacted at the HTTP boundary', async () => {
    vi.spyOn(pool, 'requestSessionRestart').mockImplementation(() => { throw new Error(privateText); });
    await startDashboard();
    const r = await dashboardCall('POST', browserHeaders());
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ ok: false, error: 'native_resume_target_start_failed' });
    expect(send).not.toHaveBeenCalled();
  });

  it('readback exceptions do not expose internal paths or tokens', async () => {
    lookup.mockImplementation(() => { throw new Error(privateText); });
    const r = await call('GET');
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ ok: false, error: 'native_resume_target_readback_failed' });
  });

  it('expired mutation acquisition removes the waiter and cannot restart on later release', async () => {
    await blockGate();
    const pending = call();
    void pending.catch(() => {});
    // Exercise the actual HTTP acquisition deadline with real I/O. Bun's fake
    // timer pump does not advance native fetch socket readiness like Node's.
    // Timer-only gate/coordinator tests separately cover fake-clock ordering.
    await waitForLookup();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'native_resume_target_gate_busy' });
    releaseGate!();
    await heldGate;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(send).not.toHaveBeenCalled();
    expect(pool.nativeResumeTargetReadback(ds)).toBeUndefined();
  }, 15_000);

  it('a timed-out Dashboard POST cannot start a late restart after its HTTP failure', async () => {
    await startDashboard();
    await blockGate();
    // The real proxy uses AbortSignal.timeout(15s). Drive that exact signal
    // deterministically rather than waiting 15 wall-clock seconds.
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
    const pending = dashboardCall('POST', browserHeaders());
    await waitForLookup();
    expect(send).not.toHaveBeenCalled();
    deadline.abort(new DOMException('review proxy deadline', 'TimeoutError'));
    const failure = await pending;
    expect(failure.status).toBe(502);
    expect(await failure.json()).toEqual({ ok: false, error: 'native_resume_target_proxy_failed' });
    const before = await (await call('GET')).json();
    expect(before).toMatchObject({ transition: null, nativeSessionId: input.sourceId,
      workerReady: true, cliReady: true, busy: false });
    // Releasing an unrelated mutation after the client has observed failure
    // must not resurrect the disconnected request.
    releaseGate!();
    await heldGate;
    // The bounded waiter and HTTP close event run in following event-loop turns.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(send).not.toHaveBeenCalled();
    const after = await (await call('GET')).json();
    expect(after).toMatchObject({ nativeSessionId: input.sourceId, workerReady: true, cliReady: true,
      transition: null });
  });
});

describe('native resume preparation uses the same management boundary', () => {
  const preparePath = `${PATH}/prepare`;
  it('requires signed management and permits only the recorded active source', async () => {
    ds.worker = null;
    ds.initConfig.backendType = 'tmux';
    const wake = vi.spyOn(sessionManager, 'ensureTerminalWorkerPort').mockResolvedValue(5000);
    expect((await call('POST', { sourceId: input.sourceId }, {}, preparePath)).status).toBe(401);
    expect(wake).not.toHaveBeenCalled();
    const result = await call('POST', { sourceId: input.sourceId }, undefined, preparePath);
    expect(result.status).toBe(202);
    expect(await result.json()).toMatchObject({ state: 'warming', sourceId: input.sourceId });
    expect(wake).toHaveBeenCalledWith(ds);
    expect(send).not.toHaveBeenCalled();
    expect((await call('POST', { sourceId: input.targetId }, undefined, preparePath)).status).toBe(409);
    expect(wake).toHaveBeenCalledTimes(1);
  });
  it.each(['closed', 'queued', 'manual', 'adopt', 'remote', 'pty-cold'])('%s is never revived or bypassed', async kind => {
    ds.worker = null;
    ds.initConfig.backendType = 'tmux';
    if (kind === 'closed') ds.session.status = 'closed';
    if (kind === 'queued') ds.session.queued = true;
    if (kind === 'manual') ds.pendingRawInput = { text: 'manual intervention' };
    if (kind === 'adopt') ds.session.adoptedFrom = 'external';
    if (kind === 'remote') ds.initConfig.backendType = 'remote-runner';
    if (kind === 'pty-cold') ds.initConfig.backendType = 'pty';
    const wake = vi.spyOn(sessionManager, 'ensureTerminalWorkerPort').mockResolvedValue(5000);
    expect((await call('POST', { sourceId: input.sourceId }, undefined, preparePath)).status).toBe(409);
    expect(wake).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('extra fields cannot turn preparation into prompt injection or arbitrary resume', async () => {
    ds.worker = null;
    ds.initConfig.backendType = 'tmux';
    const wake = vi.spyOn(sessionManager, 'ensureTerminalWorkerPort').mockResolvedValue(5000);
    for (const extra of [{ prompt: 'replay' }, { targetId: input.targetId }, { sourcePath: '/outside' }]) {
      expect((await call('POST', { sourceId: input.sourceId, ...extra }, undefined, preparePath)).status).toBe(400);
    }
    expect(wake).not.toHaveBeenCalled();
  });
  it('Dashboard preparation requires CSRF and proxies the prepare endpoint rather than replacement', async () => {
    ds.worker = null;
    ds.initConfig.backendType = 'tmux';
    const wake = vi.spyOn(sessionManager, 'ensureTerminalWorkerPort').mockResolvedValue(5000);
    await startDashboard();
    const denied = await fetch(`${base}${preparePath}`, { method: 'POST', headers: { cookie, origin: base },
      body: JSON.stringify({ sourceId: input.sourceId }) });
    expect(denied.status).toBe(403);
    expect(wake).not.toHaveBeenCalled();
    const result = await fetch(`${base}${preparePath}`, { method: 'POST', headers: browserHeaders(),
      body: JSON.stringify({ sourceId: input.sourceId }) });
    expect(result.status).toBe(202);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
