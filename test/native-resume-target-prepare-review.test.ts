import { readFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as realSleep } from 'node:timers/promises';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipcModule from '../src/core/dashboard-ipc-server.js';
import * as pool from '../src/core/worker-pool.js';
import * as manager from '../src/core/session-manager.js';
import * as backing from '../src/core/persistent-backend.js';
import { daemonIpcAuthHeaders, fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { loopbackFetch } from '../src/core/loopback-fetch.js';
import { withBotTurnMutation, tryWithBotTurnMutation, __testOnly_resetBotTurnMutationGates } from '../src/core/bot-turn-mutation-gate.js';
import { registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { nativeResumeTargetSupported, sameIdRuntimeRestartSupported } from '../src/utils/native-resume-target-plan.js';
import { sandboxEnabled } from '../src/adapters/backend/sandbox.js';
import { resolveDashboardIdentity, resolveDashboardRequestGate } from '../src/dashboard/request-identity.js';
import { parseCookie } from '../src/dashboard/auth.js';
import { ControlCsrfTokens, guardControlRequest } from '../src/dashboard/control-csrf.js';
import { sessionWriteOriginAllowed } from '../src/dashboard/session-write-origin.js';
import { jsonRes } from '../src/dashboard/http.js';

const APP = 'cli_prepare_review';
const SID = 'prepare-review-only';
const SOURCE = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const ROOT = `/api/sessions/${SID}/resume-target`;
const PREPARE = `${ROOT}/prepare`;
const SECRET = 'prepare-review-ephemeral-secret';
const TOKEN = 'prepare-review-ephemeral-dashboard-token';
const PRIVATE = 'PRIVATE_PREPARE_REVIEW_PROMPT_AND_TOKEN';
const mutation = process.env.NATIVE_PREPARE_REVIEW_MUTATION ?? '';
const mutantPath = `/__prepare_review/${SID}/prepare`;
let ipc: ipcModule.IpcServerHandle;
let extra: ipcModule.IpcServerHandle | undefined;
let dashboard: Server | undefined;
let base = '';
let ds: any;
let lookup: ReturnType<typeof vi.spyOn>;
let fork: ReturnType<typeof vi.spyOn>;
let wake: ReturnType<typeof vi.spyOn>;
let probe: ReturnType<typeof vi.spyOn>;
let send: ReturnType<typeof vi.fn>;
let proxy: ReturnType<typeof vi.fn>;
let releaseGate: (() => void) | undefined;
let gate: Promise<unknown> | undefined;
let csrf: ControlCsrfTokens;
let csrfNow: number;
let wakeTails: Promise<unknown>[];
let dashboardClosed: ReturnType<typeof deferred>;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

// 非文本断言：Dashboard 无导出路由 seam，只把真实目标路由/异常出口作为可执行夹具；不启动宿主服务。
// 源码结构护栏(K2)：变异仅在内存中删除 prepare 守卫，并注册私有测试路径，绝不重写共享生产文件。
function sourceFile(name: string) {
  return ts.createSourceFile(name, readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true);
}
function execute<T>(code: string, scope: Record<string, unknown>, result: string): T {
  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(scope), `${js}; return ${result};`)(...Object.values(scope)) as T;
}
function dropIf(node: ts.Node, source: ts.SourceFile, needle: string) {
  let count = 0;
  const transformed = ts.transform(node, [context => root => {
    const visit: ts.Visitor = child => {
      if (ts.isIfStatement(child) && child.expression.getText(source).includes(needle)) {
        count++;
        return ts.factory.createEmptyStatement();
      }
      return ts.visitEachChild(child, visit, context);
    };
    return ts.visitNode(root, visit)!;
  }]);
  const text = ts.createPrinter().printNode(ts.EmitHint.Unspecified, transformed.transformed[0], source);
  transformed.dispose();
  if (count !== 1) throw new Error(`Mutation did not identify exactly one guard: ${needle}: ${count}`);
  return text;
}

function dashboardRoute() {
  const source = sourceFile('dashboard.ts');
  let route: ts.IfStatement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(source).includes('resume-target')) route = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!route) throw new Error('Dashboard resume-target route missing');
  let parent: ts.Node | undefined = route.parent;
  while (parent && !ts.isTryStatement(parent)) parent = parent.parent;
  if (!parent || !ts.isTryStatement(parent) || !parent.catchClause) throw new Error('Error boundary missing');
  const helpers = ['readJsonBody', 'enforceControlCsrf'].map(name => {
    const fn = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
    if (!fn) throw new Error(`Missing helper ${name}`);
    return fn.getText(source);
  }).join('\n');
  const body = mutation === 'drop-csrf' ? dropIf(route, source, 'enforceControlCsrf') : route.getText(source);
  return execute<any>(`${helpers}
    async function route(req, res, url, authed, requestIdentity) {
      try { let m; ${body}; if (!res.writableEnded) jsonRes(res,404,{ok:false}); }
      ${parent.catchClause.getText(source)}
    }`, {
    jsonRes, dashboardControlJson: jsonRes, guardControlRequest, controlCsrfTokens: csrf,
    sessionWriteOriginAllowed, aggregator: { ownerOf: () => APP },
    proxyToDaemon: (...args: any[]) => proxy(...args),
    DashboardJsonBodyTooLargeError: Error, logger,
  }, 'route');
}

const ipcMutations: Record<string, string> = {
  'drop-hmac': 'ipcHmacAuthorized',
  'drop-identity': 'ds !== initial',
  'drop-busy': 'nativeResumeTargetSupported',
  'drop-disconnect': 'disconnected ||',
  'drop-deadline': '',
};
const mutatesIpc = Object.hasOwn(ipcMutations, mutation);
if (mutatesIpc) {
  const source = sourceFile('core/dashboard-ipc-server.ts');
  let handler: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcRoute'
      && node.arguments[1] && ts.isStringLiteral(node.arguments[1])
      && node.arguments[1].text === '/api/sessions/:sessionId/resume-target/prepare') {
      handler = node.arguments[2];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!handler) throw new Error('prepare IPC handler missing');
  const body = mutation === 'drop-deadline' ? handler.getText(source) : dropIf(handler, source, ipcMutations[mutation]);
  ipcModule.ipcRoute('POST', '/__prepare_review/:sessionId/prepare', execute<any>(
    `const handler = ${body};`, {
      ipcHmacAuthorized: ipcModule.ipcHmacAuthorized, jsonRes: ipcModule.jsonRes,
      readJsonBody: ipcModule.readJsonBody, cachedLarkAppId: APP, logger,
      findActiveBySessionId: (...args: any[]) => (pool.findActiveBySessionId as any)(...args),
      tryWithBotTurnMutation: mutation === 'drop-deadline'
        ? async (app: string, _timeout: number, action: () => unknown) => ({
          acquired: true, result: await withBotTurnMutation(app, action),
        }) : tryWithBotTurnMutation,
      nativeResumeTargetSupported, sameIdRuntimeRestartSupported, sandboxEnabled,
      nativeResumePreparations: new WeakMap(), randomUUID,
      sessionAcceptsDirectCommand: pool.sessionAcceptsDirectCommand,
      isSessionLifecycleInFlight: pool.isSessionLifecycleInFlight,
      hasPendingOrdinaryImDelivery: pool.hasPendingOrdinaryImDelivery,
      ensureTerminalWorkerPort: (...args: any[]) => (manager.ensureTerminalWorkerPort as any)(...args),
    }, 'handler'));
}
const ipcPath = mutatesIpc ? mutantPath : PREPARE;

beforeEach(async () => {
  csrfNow = Date.now();
  csrf = new ControlCsrfTokens({ now: () => csrfNow, ttlMs: 1000 });
  dashboardClosed = deferred();
  registerBot({ larkAppId: APP, larkAppSecret: 'fixture-not-live', cliId: 'traex', apiOnly: true });
  send = vi.fn();
  ds = {
    larkAppId: APP, worker: null, workerPort: null, workerGeneration: 3,
    workerReady: false, cliReady: false, lastScreenStatus: 'idle',
    initConfig: { cliId: 'traex', backendType: 'tmux', sandbox: false, prompt: PRIVATE, env: { TOKEN: PRIVATE } },
    session: { sessionId: SID, status: 'active', cliId: 'traex', cliSessionId: SOURCE, backendType: 'tmux' },
  };
  lookup = vi.spyOn(pool, 'findActiveBySessionId').mockImplementation(id => id === SID ? ds : undefined);
  // Keep backend resolution, wake state machine, eligibility and gate REAL.
  // Only the external pane probe and physical process fork are sinks.
  probe = vi.spyOn(backing, 'probePersistentBackendTarget').mockReturnValue('missing');
  fork = vi.spyOn(pool, 'forkWorker').mockImplementation((target: any) => {
    target.worker = { killed: false, send };
    target.workerGeneration++;
    target.workerReady = false;
    target.cliReady = false;
    return true;
  });
  const realWake = manager.ensureTerminalWorkerPort;
  wakeTails = [];
  wake = vi.spyOn(manager, 'ensureTerminalWorkerPort').mockImplementation(target => {
    const tail = realWake(target);
    wakeTails.push(tail.catch(() => undefined));
    return tail;
  });
  vi.stubEnv('BOTMUX_SANDBOX', '0');
  ipcModule.setIpcAuthSecret(SECRET);
  ipcModule.setLarkAppId(APP);
  ipc = await ipcModule.startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
});

afterEach(async () => {
  releaseGate?.();
  await gate;
  releaseGate = undefined;
  gate = undefined;
  // The real wake tail only polls port. Finish it deterministically, never
  // leave a 40-second timer behind or fake a live worker/message at teardown.
  ds.workerPort = 49999;
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(200);
  await Promise.all(wakeTails);
  dashboard?.closeAllConnections();
  if (dashboard) await new Promise<void>(r => dashboard!.close(() => r()));
  dashboard = undefined;
  await extra?.close();
  extra = undefined;
  await ipc?.close();
  pool.__testOnly_resetRestartCoordinator();
  __testOnly_resetBotTurnMutationGates();
  __testOnly_resetBotRegistry();
  ipcModule.setIpcAuthSecret(null);
  ipcModule.setLarkAppId('');
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function call(options: { method?: string; body?: unknown; headers?: HeadersInit; signal?: AbortSignal } = {}) {
  const method = options.method ?? 'POST';
  const path = method === 'GET' ? ROOT : ipcPath;
  return loopbackFetch(`http://127.0.0.1:${ipc.port}${path}`, {
    method, headers: options.headers ?? daemonIpcAuthHeaders({ secret: SECRET, port: ipc.port, method, path }),
    ...(method === 'POST' ? { body: JSON.stringify(options.body ?? { sourceId: SOURCE }) } : {}),
    signal: options.signal,
  });
}
async function readback() {
  const response = await call({ method: 'GET' });
  expect(response.status).toBe(200);
  return response.json();
}
async function holdGate() {
  const entered = deferred();
  const release = deferred();
  releaseGate = release.resolve;
  gate = withBotTurnMutation(APP, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
}
async function waitUntil(check: () => boolean) {
  // Native HTTP is advanced by real I/O turns, fake timers only control the
  // production deadlines. Do not let vi.waitFor advance those deadlines.
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await realSleep(5);
  }
  throw new Error('HTTP probe failed to reach its deterministic barrier');
}
async function releaseAndDrain() {
  releaseGate!();
  await gate;
  await withBotTurnMutation(APP, () => undefined);
  await realSleep(30);
}
function fakeClock() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
}
async function startDashboard() {
  proxy = vi.fn((_app: string, path: string, init: RequestInit) =>
    fetchDaemonIpc(ipc.port, path === PREPARE ? ipcPath : path, init, SECRET));
  const route = dashboardRoute();
  dashboard = createServer(async (req, res) => {
    res.once('close', dashboardClosed.resolve);
    const url = new URL(req.url!, base);
    const identity = resolveDashboardIdentity({
      legacyCookie: parseCookie(req.headers.cookie), activeToken: TOKEN,
      roleHeader: req.headers['x-botmux-role'], actorHeader: req.headers['x-botmux-actor'],
      scopesHeader: req.headers['x-botmux-scopes'], platformMachineId: 'prepare-machine',
      platformActorScope: id => id, legacyAuthSessionId: token => `legacy:${token}`, h5: null,
    });
    const gate = resolveDashboardRequestGate({
      method: req.method!, pathname: url.pathname, hasTokenParam: false, identity,
      tokenFromRequest: parseCookie(req.headers.cookie), activeToken: TOKEN, publicReadOnly: true,
    });
    if (gate.decision.kind === 'deny401') return jsonRes(res, 401, { ok: false });
    if (!sessionWriteOriginAllowed(req, url.pathname)) return jsonRes(res, 403, { ok: false });
    await route(req, res, url, gate.canManageHost, identity);
  });
  await new Promise<void>(r => dashboard!.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(dashboard.address() as { port: number }).port}`;
}
function headers() {
  return { cookie: `botmux_dashboard_token=${TOKEN}`, origin: base,
    'x-botmux-csrf': csrf.mint(`legacy:${TOKEN}`) };
}
function dashboardCall(custom = headers(), signal?: AbortSignal) {
  return loopbackFetch(`${base}${PREPARE}`, {
    method: 'POST', headers: custom, body: JSON.stringify({ sourceId: SOURCE }), signal,
  });
}

describe('prepare review: authority across retries', () => {
  it('HMAC is one-shot and bound to method/path/port; rejection never queues a wake', async () => {
    await holdGate();
    const bind = { secret: SECRET, port: ipc.port, method: 'POST', path: ipcPath };
    for (const mismatch of [{ method: 'GET' }, { path: ROOT }, { port: ipc.port + 1 }, { secret: 'foreign' }]) {
      expect((await call({ headers: daemonIpcAuthHeaders({ ...bind, ...mismatch }) })).status).toBe(401);
    }
    const signed = daemonIpcAuthHeaders(bind);
    const first = call({ headers: signed });
    await waitUntil(() => lookup.mock.calls.length > 0);
    expect((await call({ headers: signed })).status).toBe(401);
    await releaseAndDrain();
    expect((await first).status).toBe(202);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
  it('lightweight listener still requires management HMAC at the handler', async () => {
    extra = await ipcModule.startIpcServer({ port: 0, host: '127.0.0.1', authRequired: false });
    const response = await loopbackFetch(`http://127.0.0.1:${extra.port}${ipcPath}`,
      { method: 'POST', body: JSON.stringify({ sourceId: SOURCE }) });
    expect(response.status).toBe(403);
    expect(wake).not.toHaveBeenCalled();
  });
  it('revoked/expired/actor-mismatched CSRF cannot be reused for a retry', async () => {
    await startDashboard();
    const valid = headers();
    for (const value of [
      { ...valid, 'x-botmux-csrf': csrf.mint('foreign-login') },
      { ...valid, 'x-botmux-role': 'owner', 'x-botmux-actor': 'other', 'x-botmux-scopes': 'dashboard:manage' },
    ]) expect((await dashboardCall(value)).status).toBe(403);
    csrfNow += 1001;
    expect((await dashboardCall(valid)).status).toBe(403);
    const revoked = headers();
    csrf.revokeAuthSession(`legacy:${TOKEN}`);
    expect((await dashboardCall(revoked)).status).toBe(403);
    expect(proxy).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });
});

describe('prepare review: gate-time interventions', () => {
  it.each(['raw', 'follow-up', 'queued-tail', 'initial-start', 'background', 'closed', 'source', 'replacement', 'removed', 'isolation'])(
    '%s after admission lookup but before mutation never wakes', async intervention => {
      await holdGate();
      const pending = call();
      await waitUntil(() => lookup.mock.calls.length === 1);
      const original = ds;
      if (intervention === 'raw') ds.pendingRawInput = { text: PRIVATE };
      if (intervention === 'follow-up') ds.pendingFollowUpInput = { text: PRIVATE };
      if (intervention === 'queued-tail') ds.session.queuedActivationTail = [{ id: 'human-tail' }];
      if (intervention === 'initial-start') ds.initialStartPending = true;
      if (intervention === 'background') ds.backgroundTaskCount = 1;
      if (intervention === 'closed') ds.session.status = 'closed';
      if (intervention === 'source') ds.session.cliSessionId = OTHER;
      if (intervention === 'replacement') ds = { ...ds, session: { ...ds.session } };
      if (intervention === 'removed') lookup.mockReturnValue(undefined);
      if (intervention === 'isolation') ds.initConfig.readIsolation = true;
      await releaseAndDrain();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain(PRIVATE);
      expect(wake).not.toHaveBeenCalled();
      expect(fork).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(original.session.cliSessionId).toBe(intervention === 'source' ? OTHER : SOURCE);
    });
});

describe('prepare review: deadlines and disconnect', () => {
  it('bounded gate timeout removes its waiter, late release does not wake, fresh retry can proceed', async () => {
    await holdGate();
    const pending = call();
    await waitUntil(() => lookup.mock.calls.length === 1);
    // Native HTTP and timer mocks have different scheduling on Node and Bun.
    // Exercise the real bounded acquisition; never advance a fake deadline
    // underneath a real socket or leave teardown waiting on a frozen timer.
    const response = await Promise.race([pending, realSleep(7000).then(() => undefined)]);
    expect(response).toBeDefined();
    if (!response) return;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'native_resume_target_gate_busy' });
    await releaseAndDrain();
    expect(wake).not.toHaveBeenCalled();
    expect((await call()).status).toBe(202);
    expect(fork).toHaveBeenCalledTimes(1);
  }, 12000);
  it('direct IPC disconnect while waiting cannot wake on late release', async () => {
    await holdGate();
    const abort = new AbortController();
    const pending = call({ signal: abort.signal }).catch(e => e);
    await waitUntil(() => lookup.mock.calls.length === 1);
    abort.abort();
    expect((await pending).name).toBe('AbortError');
    // Prove transport close has propagated before the controlled release.
    await realSleep(50);
    await releaseAndDrain();
    expect(wake).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });
  it('Dashboard proxy deadline returns 502 and cannot leave a late IPC wake', async () => {
    await startDashboard();
    await holdGate();
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
    const pending = dashboardCall();
    await waitUntil(() => lookup.mock.calls.length === 1);
    deadline.abort(new DOMException('controlled deadline', 'TimeoutError'));
    const response = await pending;
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: 'native_resume_target_proxy_failed' });
    await realSleep(50);
    await releaseAndDrain();
    expect(wake).not.toHaveBeenCalled();
    expect(await readback()).toMatchObject({ cold: true, workerReady: false, nativeSessionId: SOURCE });
  });
  it('browser disconnect is propagated to queued Dashboard preparation [R1]', async () => {
    const ipcClosed = deferred();
    const emit = Server.prototype.emit;
    vi.spyOn(Server.prototype, 'emit').mockImplementation(function(this: Server, event: string, ...args: any[]) {
      const address = this.address();
      if (event === 'request' && address && typeof address !== 'string' && address.port === ipc.port
        && args[0]?.url === ipcPath) args[1].once('close', ipcClosed.resolve);
      return emit.call(this, event, ...args);
    });
    await startDashboard();
    await holdGate();
    const abort = new AbortController();
    const pending = dashboardCall(headers(), abort.signal).catch(e => e);
    await waitUntil(() => lookup.mock.calls.length === 1);
    abort.abort();
    expect((await pending).name).toBe('AbortError');
    await dashboardClosed.promise;
    expect(proxy.mock.calls[0][2].signal.aborted).toBe(true);
    // Frontend close is not the daemon transport's cancellation boundary.
    // Prove cancellation arrived at the queued IPC request before releasing
    // admission; do not make same-process microtask ordering the oracle.
    await ipcClosed.promise;
    await releaseAndDrain();
    expect(wake).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });
});

describe('prepare review: concurrent requests and async wake outcomes', () => {
  it('concurrent prepares fork once with empty resume input; 202 and port alone never mean migration complete', async () => {
    await holdGate();
    const first = call();
    const second = call();
    const stale = call({ body: { sourceId: OTHER } });
    await waitUntil(() => lookup.mock.calls.length === 3);
    await releaseAndDrain();
    expect((await Promise.all([first, second, stale])).map(r => r.status).sort()).toEqual([202, 409, 409]);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(fork).toHaveBeenCalledWith(ds, '', true);
    expect(send).not.toHaveBeenCalled();
    expect(await readback()).toMatchObject({ cold: false, workerReady: false, cliReady: false,
      nativeSessionId: SOURCE, transition: null, busy: true });
    ds.workerPort = 47777;
    await Promise.all(wakeTails);
    expect(await readback()).toMatchObject({ workerReady: false, cliReady: false, nativeSessionId: SOURCE, transition: null });
    ds.workerReady = true;
    ds.cliReady = true;
    expect((await call()).status).toBe(200);
    expect(await readback()).toMatchObject({ cold: false, workerReady: true, cliReady: true,
      nativeSessionId: SOURCE, transition: null, busy: false });
    expect(fork).toHaveBeenCalledTimes(1);
  });
  it('worker-port timeout and later closed state do not cause an automatic refork or task replay', async () => {
    fakeClock();
    expect((await call()).status).toBe(202);
    await vi.advanceTimersByTimeAsync(45_000);
    await Promise.all(wakeTails);
    expect(await readback()).toMatchObject({ cold: false, workerReady: false, cliReady: false, nativeSessionId: SOURCE, busy: true });
    expect((await call()).status).toBe(409);
    ds.session.status = 'closed';
    ds.worker = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await call()).status).toBe(409);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['unknown-pane', 'fork-refused', 'fork-throw', 'async-tail-rejection'])(
    'a %s wake failure is observable as non-admission or terminal failure, never perpetual warming [R2]', async failure => {
      fakeClock();
      let rejectPort = false;
      if (failure === 'async-tail-rejection') Object.defineProperty(ds, 'workerPort', {
        configurable: true, get: () => { if (rejectPort) throw new Error(PRIVATE); return null; },
      });
      if (failure === 'unknown-pane') probe.mockReturnValue('unknown');
      if (failure === 'fork-refused') fork.mockReturnValue(false);
      if (failure === 'fork-throw') fork.mockImplementation(() => { throw new Error(PRIVATE); });
      const response = await call();
      const body = await response.json();
      rejectPort = true;
      await vi.advanceTimersByTimeAsync(45_000);
      await Promise.all(wakeTails);
      if (failure === 'async-tail-rejection') Object.defineProperty(ds, 'workerPort', { configurable: true, writable: true, value: null });
      const state = await readback();
      expect(state).toMatchObject({ cold: failure !== 'async-tail-rejection', workerReady: false, nativeSessionId: SOURCE });
      expect(JSON.stringify({ body, state })).not.toContain(PRIVATE);
      expect(send).not.toHaveBeenCalled();
      // Accept either synchronous refusal or an explicit asynchronous outcome.
      // Never require a particular implementation/status spelling.
      const admitted = response.status >= 200 && response.status < 300;
      const failureVisible = body.ok === false || state.ok === false
        || ['failed', 'unavailable', 'timed_out'].includes(state.transition?.state)
        || ['failed', 'unavailable', 'timed_out'].includes(state.preparation?.state);
      expect(!admitted || failureVisible, JSON.stringify({
        failure, status: response.status, body, state, forks: fork.mock.calls.length,
      })).toBe(true);
    });
  it('a killed worker advertised as cold either starts a replacement or explicitly refuses [R3]', async () => {
    fakeClock();
    ds.worker = { killed: true, send };
    ds.workerReady = true;
    ds.cliReady = true;
    expect(await readback()).toMatchObject({ cold: true, workerReady: false });
    const response = await call();
    await vi.advanceTimersByTimeAsync(45_000);
    const state = await readback();
    expect(send).not.toHaveBeenCalled();
    expect(response.status >= 400 || (fork.mock.calls.length === 1 && state.cold === false),
      JSON.stringify({ status: response.status, state, forks: fork.mock.calls.length })).toBe(true);
  });
});
