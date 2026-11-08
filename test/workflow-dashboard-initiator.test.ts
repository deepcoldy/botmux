/**
 * Dashboard workflow initiator (design 2026-11-03
 * workflow-dashboard-orchestration §7.1, I1–I5).
 *
 * Driven end to end against production code: a real Dashboard-side handler on
 * a real HTTP server (real sockets, so the platform tunnel test is the real
 * `isPlatformTunnelPeer` on the client's port), forwarding over the real
 * signed host channel to a real daemon IPC server, which resolves the person
 * on its own bot and applies canOperate. Only the Lark contact lookup is
 * stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerPlatformTunnelBridge } from '../src/platform/tunnel-peers.js';
import { handleWorkflowInitiatorApi, workflowInitiatorPreGateDenial } from '../src/dashboard/workflow-initiator-api.js';
import {
  DASHBOARD_INITIATOR_SOURCE_HEADER,
  DASHBOARD_INITIATOR_UNION_HEADER,
  WORKFLOW_INITIATOR_PATH,
  classifyDashboardInitiator,
  resolveDashboardWorkflowInitiator,
  type WorkflowInitiatorDaemonDeps,
} from '../src/core/workflow-initiator.js';
import { startIpcServer, setIpcAuthSecret, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders, fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import * as larkClient from '../src/im/lark/client.js';
import { registerBot } from '../src/bot-registry.js';
import { invalidateGlobalConfigCache } from '../src/global-config.js';
import { config } from '../src/config.js';
import type { DashboardRequestIdentity } from '../src/dashboard/request-identity.js';

const APP = 'cli_wf_orchestrator';
const SECRET = 'wf-initiator-host-key';
const OWNER = 'ou_bot_owner';
const ALICE = { open: 'ou_alice_in_orchestrator', union: 'on_alice' };

const identity = (kind: DashboardRequestIdentity['kind']) => ({ kind }) as DashboardRequestIdentity;

describe('Dashboard → daemon workflow initiator', () => {
  let dir: string;
  let previousDataDir: string;
  let ipc: IpcServerHandle | undefined;
  let dashboard: Server | undefined;
  let dashboardPort = 0;
  let allowed: string[];
  let resolveOpenId: ReturnType<typeof vi.spyOn>;
  let proxied: Array<{ path: string; headers: Record<string, string> }>;
  let deps: {
    identity: DashboardRequestIdentity | null;
    canManageHost: boolean;
    platformBound: boolean;
    featureEnabled: boolean;
  };
  const forgetBridges: Array<() => void> = [];

  function writeWorkflowConfig(workflow: Record<string, unknown>): void {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ workflow }));
    invalidateGlobalConfigCache();
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wf-dash-initiator-'));
    previousDataDir = config.session.dataDir;
    config.session.dataDir = join(dir, 'data');
    mkdirSync(config.session.dataDir, { recursive: true });
    vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', join(dir, 'config.json'));
    vi.stubEnv('BOTMUX_WORKFLOW_ENABLED', '');
    writeWorkflowConfig({ enabled: true, nodeExecutor: 'bot' });
    allowed = [OWNER, ALICE.open];
    const bot = registerBot({ larkAppId: APP, larkAppSecret: '', cliId: 'claude-code', apiOnly: true, allowedUsers: [...allowed] });
    Object.defineProperty(bot, 'resolvedAllowedUsers', { get: () => allowed, configurable: true });
    setLarkAppId(APP);
    resolveOpenId = vi.spyOn(larkClient, 'resolveTargetAppOpenId')
      .mockImplementation(async (_app, union) => union === ALICE.union
        ? { status: 'resolved', openId: ALICE.open }
        : { status: 'definitive' });
    setIpcAuthSecret(SECRET);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });

    proxied = [];
    deps = { identity: identity('legacy-dashboard'), canManageHost: true, platformBound: true, featureEnabled: true };
    dashboard = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dashboard.local');
      const handled = await handleWorkflowInitiatorApi(req, res, url, {
        identity: deps.identity,
        canManageHost: deps.canManageHost,
        platformBound: deps.platformBound,
        featureEnabled: () => deps.featureEnabled,
        proxyToDaemon: async (larkAppId, path, init) => {
          proxied.push({ path, headers: { ...(init.headers as Record<string, string>) } });
          expect(larkAppId).toBe(APP);
          return fetchDaemonIpc(ipc!.port, path, init, SECRET);
        },
      });
      if (!handled) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(resolve => dashboard!.listen(0, '127.0.0.1', () => resolve()));
    dashboardPort = (dashboard.address() as { port: number }).port;
  });

  afterEach(async () => {
    for (const forget of forgetBridges.splice(0)) forget();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    await ipc?.close(); ipc = undefined;
    await new Promise<void>(resolve => (dashboard ? dashboard.close(() => resolve()) : resolve()));
    dashboard = undefined;
    setIpcAuthSecret(null);
    config.session.dataDir = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  /** POST the Dashboard route from a real socket; `viaTunnel` registers that
   *  socket's local port as a platform tunnel bridge first. */
  async function ask(opts: { viaTunnel?: boolean; actor?: string | string[]; body?: string } = {}): Promise<{ status: number; body: any }> {
    // Connect first (the OS picks the client port), register that port as a
    // tunnel bridge, then speak HTTP over the same socket: no port race.
    const socket = connect(dashboardPort, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject); });
    if (opts.viaTunnel) forgetBridges.push(registerPlatformTunnelBridge(socket.localPort));
    const payload = opts.body ?? JSON.stringify({ larkAppId: APP });
    return new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: dashboardPort, createConnection: () => socket, method: 'POST',
        path: WORKFLOW_INITIATOR_PATH,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(opts.actor !== undefined ? { 'x-botmux-actor': opts.actor } : {}),
        },
      }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  it('local token login initiates as the bot owner, without any lookup (I2)', async () => {
    expect(await ask()).toEqual({ status: 200, body: { ok: true, initiator: { openId: OWNER, source: 'dashboard-local' } } });
    expect(resolveOpenId).not.toHaveBeenCalled();
    expect(proxied[0]!.headers).toMatchObject({ [DASHBOARD_INITIATOR_SOURCE_HEADER]: 'dashboard-local' });
    expect(proxied[0]!.headers).not.toHaveProperty(DASHBOARD_INITIATOR_UNION_HEADER);
  });

  it('local login uses the first admin once the configured owner is no longer one', async () => {
    allowed = ['ou_second_admin', ALICE.open];
    expect((await ask()).body.initiator).toEqual({ openId: 'ou_second_admin', source: 'dashboard-local' });
  });

  it.each([
    ['a well-formed union_id', ALICE.union],
    ['a malformed value', 'not-a-union-id'],
    ['an empty value', ''],
    ['a repeated header', [ALICE.union, 'on_bob']],
  ])('the platform direct path (non-tunnel, X-Botmux-Actor: %s) is refused, never recorded as the owner', async (_label, actor) => {
    expect(await ask({ actor })).toEqual({ status: 403, body: { ok: false, error: 'platform_direct_unsupported', retryable: false } });
    expect(proxied).toEqual([]);
    expect(resolveOpenId).not.toHaveBeenCalled();
  });

  it('the route takes no GET: a body-less request would ride the platform direct path', async () => {
    const response = await fetch(`http://127.0.0.1:${dashboardPort}${WORKFLOW_INITIATOR_PATH}`, { method: 'GET' });
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ ok: false, error: 'method_not_allowed', retryable: false });
    expect(proxied).toEqual([]);
  });

  it('a request without the body the route requires is refused', async () => {
    expect(await ask({ body: '' })).toEqual({ status: 400, body: { ok: false, error: 'larkAppId_required', retryable: false } });
    expect(await ask({ body: '{' })).toEqual({ status: 400, body: { ok: false, error: 'bad_json', retryable: false } });
  });

  it('platform tunnel login initiates as that person, resolved through the orchestrating bot only', async () => {
    const answer = await ask({ viaTunnel: true, actor: ALICE.union });
    expect(answer).toEqual({
      status: 200,
      body: { ok: true, initiator: { openId: ALICE.open, unionId: ALICE.union, source: 'dashboard-platform' } },
    });
    expect(resolveOpenId).toHaveBeenCalledTimes(1);
    expect(resolveOpenId).toHaveBeenCalledWith(APP, ALICE.union);
  });

  it('a person who cannot operate the bot is refused, never recorded as the owner (I1)', async () => {
    allowed = [OWNER];
    expect(await ask({ viaTunnel: true, actor: ALICE.union }))
      .toEqual({ status: 403, body: { ok: false, error: 'cannot_operate', retryable: false } });
  });

  it('a person the bot app definitively cannot see is refused, not replaced by the owner (I3)', async () => {
    resolveOpenId.mockResolvedValue({ status: 'definitive' });
    expect(await ask({ viaTunnel: true, actor: ALICE.union }))
      .toEqual({ status: 403, body: { ok: false, error: 'initiator_not_visible', retryable: false } });
  });

  it('a transient lookup failure is a retryable error', async () => {
    resolveOpenId.mockResolvedValue({ status: 'transient' });
    expect(await ask({ viaTunnel: true, actor: ALICE.union }))
      .toEqual({ status: 503, body: { ok: false, error: 'identity_lookup_failed', retryable: true } });
  });

  it('a tunnel request that names nobody is refused before reaching the daemon', async () => {
    expect(await ask({ viaTunnel: true }))
      .toEqual({ status: 403, body: { ok: false, error: 'platform_actor_missing', retryable: false } });
    expect(proxied).toEqual([]);
  });

  it('the local token login on a platform-bound machine (no actor header) still initiates as the owner', async () => {
    deps.platformBound = true;
    expect(await ask()).toEqual({ status: 200, body: { ok: true, initiator: { openId: OWNER, source: 'dashboard-local' } } });
  });

  it('a machine not bound to the platform treats every login as local', async () => {
    deps.platformBound = false;
    expect((await ask({ viaTunnel: true, actor: ALICE.union })).body.initiator).toEqual({ openId: OWNER, source: 'dashboard-local' });
    expect(resolveOpenId).not.toHaveBeenCalled();
  });

  it.each([
    ['Feishu H5 免登', () => { deps.identity = identity('feishu-h5'); deps.canManageHost = false; }, 403, 'h5_login_unsupported'],
    ['no login', () => { deps.identity = null; deps.canManageHost = false; }, 401, 'login_required'],
    ['a platform role login outside the tunnel', () => { deps.identity = identity('platform-dashboard'); }, 403, 'platform_actor_missing'],
    ['a platform viewer without the management scope', () => { deps.identity = identity('platform-dashboard'); deps.canManageHost = false; }, 403, 'admin_required'],
  ])('%s cannot initiate', async (_label, arrange, status, error) => {
    arrange();
    expect(await ask()).toEqual({ status, body: { ok: false, error, retryable: false } });
    expect(proxied).toEqual([]);
  });

  it('feature off on the Dashboard: feature_disabled, the daemon is not asked', async () => {
    deps.featureEnabled = false;
    expect(await ask()).toEqual({ status: 409, body: { ok: false, error: 'feature_disabled', retryable: false } });
    expect(proxied).toEqual([]);
  });

  it.each([
    ['workflow off', { enabled: false, nodeExecutor: 'bot' }],
    ['node executor off', { enabled: true }],
  ])('%s on the daemon: feature_disabled even for a signed request', async (_label, workflow) => {
    writeWorkflowConfig(workflow);
    expect(await ask()).toEqual({ status: 409, body: { ok: false, error: 'feature_disabled', retryable: false } });
  });

  function signed(path: string, headers: Record<string, string>, body: unknown = { larkAppId: APP }) {
    return fetch(`http://127.0.0.1:${ipc!.port}${path}`, {
      method: 'POST',
      headers: daemonIpcAuthHeaders({ secret: SECRET, port: ipc!.port, method: 'POST', path, headers: { 'content-type': 'application/json', ...headers } }),
      body: JSON.stringify(body),
    });
  }

  it('the daemon answers only for its own bot', async () => {
    for (const body of [{ larkAppId: 'cli_other' }, {}]) {
      const response = await signed(WORKFLOW_INITIATOR_PATH, { [DASHBOARD_INITIATOR_SOURCE_HEADER]: 'dashboard-local' }, body);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ ok: false, error: 'bot_mismatch', retryable: false });
    }
  });

  it('the daemon rejects a missing or unknown source instead of assuming the owner', async () => {
    for (const headers of [{}, { [DASHBOARD_INITIATOR_SOURCE_HEADER]: 'feishu' }, { [DASHBOARD_INITIATOR_SOURCE_HEADER]: 'dashboard-platform' }]) {
      const response = await signed(WORKFLOW_INITIATOR_PATH, headers);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: 'initiator_missing', retryable: false });
    }
  });

  it('the daemon ignores the headers on a request that did not pass the host signature', async () => {
    const lightweight = await startIpcServer({ port: 0, host: '127.0.0.1' });
    try {
      const response = await fetch(`http://127.0.0.1:${lightweight.port}${WORKFLOW_INITIATOR_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [DASHBOARD_INITIATOR_SOURCE_HEADER]: 'dashboard-platform', [DASHBOARD_INITIATOR_UNION_HEADER]: ALICE.union },
        body: JSON.stringify({ larkAppId: APP }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ ok: false, error: 'untrusted_caller', retryable: false });
      expect(resolveOpenId).not.toHaveBeenCalled();
    } finally {
      await lightweight.close();
    }
  });
});

describe('workflowInitiatorPreGateDenial', () => {
  function capture() {
    const out: { status?: number; body?: string } = {};
    const res = {
      writeHead: (status: number) => { out.status = status; return res; },
      end: (body: string) => { out.body = body; },
    } as any;
    return { res, out };
  }

  it('answers a Feishu H5 identity on the initiator route with its explicit code', () => {
    const { res, out } = capture();
    expect(workflowInitiatorPreGateDenial(res, WORKFLOW_INITIATOR_PATH, identity('feishu-h5'), false)).toBe(true);
    expect(out.status).toBe(403);
    expect(JSON.parse(out.body!)).toEqual({ ok: false, error: 'h5_login_unsupported', retryable: false });
  });

  it('leaves every other request to the normal gate', () => {
    const { res, out } = capture();
    expect(workflowInitiatorPreGateDenial(res, '/api/v3/runs', identity('feishu-h5'), false)).toBe(false);
    expect(workflowInitiatorPreGateDenial(res, WORKFLOW_INITIATOR_PATH, identity('legacy-dashboard'), true)).toBe(false);
    expect(workflowInitiatorPreGateDenial(res, WORKFLOW_INITIATOR_PATH, null, false)).toBe(false);
    expect(out.status).toBeUndefined();
  });
});

describe('resolveDashboardWorkflowInitiator', () => {
  const base = (over: Partial<WorkflowInitiatorDaemonDeps> = {}): WorkflowInitiatorDaemonDeps => ({
    appId: APP,
    featureEnabled: true,
    trustedHost: true,
    ownerOpenId: () => OWNER,
    resolveOpenId: async () => ({ status: 'resolved', openId: ALICE.open }),
    canOperate: () => true,
    ...over,
  });
  const platform = { source: 'dashboard-platform', unionId: ALICE.union };

  it('a throwing lookup is a retryable failure', async () => {
    const result = await resolveDashboardWorkflowInitiator(platform, base({ resolveOpenId: async () => { throw new Error('socket hang up'); } }));
    expect(result).toMatchObject({ ok: false, error: 'identity_lookup_failed', retryable: true });
  });

  it('never accepts an open_id that is not this app\'s', async () => {
    const result = await resolveDashboardWorkflowInitiator(platform, base({ resolveOpenId: async () => ({ status: 'resolved', openId: 'on_not_an_open_id' }) }));
    expect(result).toMatchObject({ ok: false, error: 'initiator_not_visible' });
  });

  it('checks canOperate on the resolved person with their union_id', async () => {
    const canOperate = vi.fn(() => true);
    await resolveDashboardWorkflowInitiator(platform, base({ canOperate }));
    expect(canOperate).toHaveBeenCalledWith(APP, ALICE.open, ALICE.union);
  });

  it('local login with no resolvable owner is refused', async () => {
    const result = await resolveDashboardWorkflowInitiator({ source: 'dashboard-local', unionId: undefined }, base({ ownerOpenId: () => undefined }));
    expect(result).toMatchObject({ ok: false, error: 'owner_unavailable', retryable: false });
  });

  it('local login carrying a union_id is malformed, not silently local', async () => {
    const result = await resolveDashboardWorkflowInitiator({ source: 'dashboard-local', unionId: ALICE.union }, base());
    expect(result).toMatchObject({ ok: false, error: 'initiator_missing' });
  });

  it('a local owner who fails canOperate is refused too', async () => {
    const result = await resolveDashboardWorkflowInitiator({ source: 'dashboard-local', unionId: undefined }, base({ canOperate: () => false }));
    expect(result).toMatchObject({ ok: false, error: 'cannot_operate' });
  });
});

describe('classifyDashboardInitiator', () => {
  it('a tunnel request is a platform login even on the injected management cookie', () => {
    expect(classifyDashboardInitiator({
      identity: identity('legacy-dashboard'), canManageHost: true, viaPlatformTunnel: true, platformUnionId: ALICE.union, directActorHeader: false,
    })).toEqual({ ok: true, source: 'dashboard-platform', unionId: ALICE.union });
  });

  it('a platform co-manager on the tunnel is that person', () => {
    expect(classifyDashboardInitiator({
      identity: identity('platform-dashboard'), canManageHost: true, viaPlatformTunnel: true, platformUnionId: ALICE.union, directActorHeader: false,
    })).toEqual({ ok: true, source: 'dashboard-platform', unionId: ALICE.union });
  });
});
