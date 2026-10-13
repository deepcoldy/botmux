import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as botRegistry from '../src/bot-registry.js';
import * as identities from '../src/im/lark/identity-cache.js';
import * as larkCliAuth from '../src/services/lark-cli-auth.js';
import * as cliIdentity from '../src/core/cli-identity.js';

const CAP = 'ab'.repeat(32);
const SECRET = 'auth-request-test-secret';
const AUTH_URL = 'https://accounts.feishu.cn/oauth/device?user_code=test';
let completeLogin: ReturnType<typeof vi.fn>;
let requestId: string;
let ipc: IpcServerHandle;
let session: any;

beforeEach(async () => {
  session = {
    session: { sessionId: 'auth-session', status: 'active' },
    larkAppId: 'cli_test', chatId: 'oc_test',
    worker: { killed: false }, workerGeneration: 4,
    managedTurnOrigin: { capability: CAP, turnId: 'om_turn', callerOpenId: 'ou_sender' },
  };
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 'auth-session' ? session : undefined);
  vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: { larkAppId: 'cli_test', larkAppSecret: 'test-secret', triggerUserAuth: { enabled: true, tools: ['lark-cli'], fallback: 'none' } } } as any);
  vi.spyOn(identities, 'getIdentity').mockReturnValue({ openId: 'ou_sender', type: 'user', source: 'sender', updatedAt: 0 });
  vi.spyOn(identities, 'resolveVerifiedUserIdentity').mockResolvedValue(undefined);
  completeLogin = vi.fn().mockResolvedValue({ state: 'pending' });
  vi.spyOn(larkCliAuth, 'beginLarkCliLogin').mockImplementation(async (_openId, scopes) => ({
    authUrl: AUTH_URL, stage: 'user-login', scopes: larkCliAuth.larkCliLoginScopes(scopes),
  }));
  vi.spyOn(larkCliAuth, 'completeLarkCliLogin').mockImplementation((...args) => completeLogin(...args));
  vi.spyOn(larkCliAuth, 'larkCliHomeForTurn').mockReturnValue(null);
  vi.spyOn(larkCliAuth, 'materializeLarkCliHomeForSession').mockResolvedValue(null);
  vi.spyOn(cliIdentity, 'refreshSessionIdentity').mockReturnValue(true);
  setIpcAuthSecret(SECRET);
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});

afterEach(async () => {
  await ipc.close();
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

function post(action = 'auth-request', overrides: Record<string, unknown> = {}, signed = false) {
  const path = `/api/sessions/auth-session/${action}`;
  const headers = signed
    ? daemonIpcAuthHeaders({ secret: SECRET, port: ipc.port, method: 'POST', path, headers: { 'content-type': 'application/json' } })
    : { 'content-type': 'application/json' };
  return fetch(`http://127.0.0.1:${ipc.port}${path}`, {
    method: 'POST', headers,
    body: JSON.stringify({ scopes: ['im:chat:read'], originCapability: CAP, originTurnId: 'om_turn', ...overrides }),
  });
}

describe('agent authorization', () => {
  it.each([false, true])('binds the link to the daemon sender (signed=%s)', async signed => {
    const response = await post('auth-request', {}, signed);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true, authUrl: AUTH_URL, requestId: expect.any(String),
      scopes: larkCliAuth.larkCliLoginScopes(['im:chat:read']), expiresIn: 540, autoCallback: true,
    });
    expect(larkCliAuth.beginLarkCliLogin).toHaveBeenCalledWith('ou_sender', ['im:chat:read']);
  });

  it.each([
    { originCapability: undefined }, { originTurnId: undefined },
    { originTurnId: 'om_earlier' }, { originDispatchAttempt: 2 },
  ])('rejects incomplete or stale turn claims even with host authorization: %j', async fields => {
    const response = await post('auth-request', fields, true);
    expect(response.status).toBe(403);
    expect(larkCliAuth.beginLarkCliLogin).not.toHaveBeenCalled();
  });

  it('rejects identity overrides and misspelled permissions', async () => {
    expect((await post('auth-request', { callerOpenId: 'ou_other' })).status).toBe(400);
    expect((await post('auth-request', { scopes: ['im:chat:raed'] })).status).toBe(400);
    expect(larkCliAuth.beginLarkCliLogin).not.toHaveBeenCalled();
  });

  it('accepts the legacy chat permissions reported by the API', async () => {
    const scopes = ['im:chat', 'im:chat:readonly', 'im:chat:read'];
    expect((await post('auth-request', { scopes })).status).toBe(200);
    expect(larkCliAuth.beginLarkCliLogin).toHaveBeenCalledWith('ou_sender', scopes);
  });

  it.each([
    undefined,
    { enabled: false, tools: ['lark-cli'], fallback: 'none' },
    { enabled: true, tools: ['bytedcli'], fallback: 'none' },
  ])('rejects authorization when Lark identity injection is unavailable: %j', async policy => {
    vi.mocked(botRegistry.getBot).mockReturnValue({ config: {
      larkAppId: 'cli_test', larkAppSecret: 'test-secret', triggerUserAuth: policy,
    } } as any);
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'lark_user_auth_disabled' });
    expect(larkCliAuth.beginLarkCliLogin).not.toHaveBeenCalled();
  });

  it('returns default scopes and waits for the device grant when no extra scope is requested', async () => {
    const request = await (await post('auth-request', { scopes: [] })).json();
    expect(request.scopes).toEqual(larkCliAuth.larkCliLoginScopes([]));
    const response = await post('auth-status', { requestId: request.requestId });
    expect(await response.json()).toEqual({ ok: true, status: 'pending' });
    expect(completeLogin).toHaveBeenCalledWith('ou_sender');
    expect(cliIdentity.refreshSessionIdentity).not.toHaveBeenCalled();
  });

  it('returns the personal-app setup link without creating a shared-app auth request', async () => {
    vi.mocked(larkCliAuth.beginLarkCliLogin).mockResolvedValueOnce({
      authUrl: 'https://open.feishu.cn/page/cli?user_code=PERSONAL', stage: 'app-setup',
    });
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'personal_lark_app_required',
      authUrl: 'https://open.feishu.cn/page/cli?user_code=PERSONAL',
    });
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it('returns a safe error when creating the device grant fails', async () => {
    vi.mocked(larkCliAuth.beginLarkCliLogin).mockRejectedValue(new Error('secret-bearing upstream error'));
    const response = await post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: 'authorization_request_failed' });
  });

  it('rejects a turn change while creating the device grant', async () => {
    vi.mocked(larkCliAuth.beginLarkCliLogin).mockImplementation(async () => {
      session.managedTurnOrigin.turnId = 'om_next';
      return { authUrl: AUTH_URL, stage: 'user-login', scopes: [] };
    });
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'auth_turn_changed' });
  });

  it('reports a failed grant without refreshing credentials', async () => {
    requestId = (await (await post()).json()).requestId;
    completeLogin.mockResolvedValue({ state: 'failed', detail: 'authorization_user_mismatch' });
    const response = await post('auth-status', { requestId });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, status: 'failed', error: 'authorization_user_mismatch' });
    expect(cliIdentity.refreshSessionIdentity).not.toHaveBeenCalled();
  });

  it('refuses to publish credentials when the turn changes during token resolution', async () => {
    requestId = (await (await post()).json()).requestId;
    completeLogin.mockImplementation(async () => {
      session.managedTurnOrigin.turnId = 'om_next';
      return { state: 'authorized' };
    });
    vi.mocked(larkCliAuth.larkCliHomeForTurn).mockReturnValue('/homes/ou_sender');
    const response = await post('auth-status', { requestId });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'auth_turn_changed' });
    expect(cliIdentity.refreshSessionIdentity).not.toHaveBeenCalled();
  });

  it('rejects a caller change during identity resolution', async () => {
    vi.mocked(identities.getIdentity).mockReturnValue(undefined);
    vi.mocked(identities.resolveVerifiedUserIdentity).mockImplementation(async () => {
      session.managedTurnOrigin.callerOpenId = 'ou_next';
      return { openId: 'ou_sender', type: 'user' };
    });
    expect((await post()).status).toBe(403);
    expect(larkCliAuth.beginLarkCliLogin).not.toHaveBeenCalled();
  });

  it('reports pending, then refreshes only the requesting turn after authorization', async () => {
    requestId = (await (await post()).json()).requestId;
    const pending = await post('auth-status', { requestId });
    expect(await pending.json()).toEqual({ ok: true, status: 'pending' });
    expect(cliIdentity.refreshSessionIdentity).not.toHaveBeenCalled();
    completeLogin.mockResolvedValue({ state: 'authorized' });
    vi.mocked(larkCliAuth.larkCliHomeForTurn).mockReturnValue('/homes/ou_sender-personal-app');
    const ready = await post('auth-status', { requestId });
    expect(await ready.json()).toEqual({ ok: true, status: 'ready' });
    expect(cliIdentity.refreshSessionIdentity).toHaveBeenCalledWith(expect.any(String), 'auth-session', {
      tool: 'lark-cli', mode: 'user-home', home: '/homes/ou_sender-personal-app', turnId: 'om_turn',
    });
  });

  it('publishes a session-local HOME after authorization in a frozen sandbox session', async () => {
    session.session.sandbox = 'oncall';
    requestId = (await (await post()).json()).requestId;
    completeLogin.mockResolvedValue({ state: 'authorized' });
    vi.mocked(larkCliAuth.materializeLarkCliHomeForSession)
      .mockResolvedValue('/session-tmp/auth-session/lark-cli-home');
    const ready = await post('auth-status', { requestId });
    expect(await ready.json()).toEqual({ ok: true, status: 'ready' });
    expect(larkCliAuth.materializeLarkCliHomeForSession).toHaveBeenCalledWith(
      'ou_sender', expect.any(String), 'auth-session',
    );
    expect(larkCliAuth.larkCliHomeForTurn).not.toHaveBeenCalled();
    expect(cliIdentity.refreshSessionIdentity).toHaveBeenCalledWith(expect.any(String), 'auth-session', {
      tool: 'lark-cli', mode: 'user-home',
      home: '/session-tmp/auth-session/lark-cli-home', turnId: 'om_turn',
    });
  });

  it('preserves newer queued credentials and refuses a rotated worker', async () => {
    requestId = (await (await post()).json()).requestId;
    completeLogin.mockResolvedValue({ state: 'authorized' });
    vi.mocked(larkCliAuth.larkCliHomeForTurn).mockReturnValue('/homes/ou_sender-personal-app');
    vi.mocked(cliIdentity.refreshSessionIdentity).mockReturnValue(false);
    expect((await post('auth-status', { requestId })).status).toBe(409);
    vi.mocked(cliIdentity.refreshSessionIdentity).mockClear();
    session.workerGeneration++;
    expect((await post('auth-status', { requestId })).status).toBe(409);
    expect(cliIdentity.refreshSessionIdentity).not.toHaveBeenCalled();
  });
});

// A managed host session has no relay/channel injected, so it presents no
// origin tuple. The daemon proves the turn the same way `/api/current-actor`
// does: it maps the loopback socket to the client pid and walks it to the live
// CLI. The test process IS that loopback client, so seeding the live turn's
// lineage with this pid makes the attestation resolve; without it the peer walk
// fails closed. Linux-only, since the peer resolver reads /proc/net + /proc/fd.
describe.skipIf(process.platform !== 'linux')('agent authorization over a managed host session', () => {
  const SECRET = 'auth-request-host-secret';
  let ipc: IpcServerHandle;
  let session: any;
  let completeLogin: ReturnType<typeof vi.fn>;
  let unrelatedProcess: ChildProcess | undefined;

  function hostSession(): any {
    const start = readProcessStartIdentity(process.pid);
    return {
      session: { sessionId: 'host-session', status: 'active' },
      larkAppId: 'cli_test', chatId: 'oc_test',
      worker: { pid: process.pid, killed: false }, workerGeneration: 9,
      localProcessAttestation: {
        backendType: 'pty', credentialIsolated: false,
        cliPid: process.pid, cliProcStart: start, workerGeneration: 9,
      },
      managedTurnOrigin: {
        capability: 'cd'.repeat(32), turnId: 'om_host', callerOpenId: 'ou_host',
        preexistingProcessIdentities: [`${process.pid}:${start}`],
      },
      initConfig: { apiOnly: false },
    };
  }

  beforeEach(async () => {
    session = hostSession();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 'host-session' ? session : undefined);
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: { larkAppId: 'cli_test', larkAppSecret: 'test-secret', triggerUserAuth: { enabled: true, tools: ['lark-cli'], fallback: 'none' } } } as any);
    vi.spyOn(identities, 'getIdentity').mockReturnValue({ openId: 'ou_host', type: 'user', source: 'sender', updatedAt: 0 });
    vi.spyOn(identities, 'resolveVerifiedUserIdentity').mockResolvedValue(undefined);
    completeLogin = vi.fn().mockResolvedValue({ state: 'pending' });
    vi.spyOn(larkCliAuth, 'beginLarkCliLogin').mockImplementation(async (_openId, scopes) => ({
      authUrl: AUTH_URL, stage: 'user-login', scopes: larkCliAuth.larkCliLoginScopes(scopes),
    }));
    vi.spyOn(larkCliAuth, 'completeLarkCliLogin').mockImplementation((...args) => completeLogin(...args));
    vi.spyOn(larkCliAuth, 'larkCliHomeForTurn').mockReturnValue(null);
    vi.spyOn(cliIdentity, 'refreshSessionIdentity').mockReturnValue(true);
    setIpcAuthSecret(SECRET);
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  });

  afterEach(async () => {
    unrelatedProcess?.kill();
    unrelatedProcess = undefined;
    await ipc.close();
    setIpcAuthSecret(null);
    vi.restoreAllMocks();
  });

  function hostPost(action: string, overrides: Record<string, unknown> = {}) {
    const path = `/api/sessions/host-session/${action}`;
    return fetch(`http://127.0.0.1:${ipc.port}${path}`, {
      method: 'POST',
      headers: daemonIpcAuthHeaders({ secret: SECRET, port: ipc.port, method: 'POST', path, headers: { 'content-type': 'application/json' } }),
      body: JSON.stringify({ scopes: ['im:chat:read'], ...overrides }),
    });
  }

  it('authorizes without an origin tuple when the loopback peer proves the turn', async () => {
    const response = await hostPost('auth-request');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, authUrl: AUTH_URL, autoCallback: true });
    expect(larkCliAuth.beginLarkCliLogin).toHaveBeenCalledWith('ou_host', ['im:chat:read']);
  });

  it('authorizes an RPC client through the independently attested engine root', async () => {
    const enginePid = process.ppid;
    const engineProcStart = readProcessStartIdentity(enginePid);
    delete session.localProcessAttestation.cliPid;
    delete session.localProcessAttestation.cliProcStart;
    session.localProcessAttestation.enginePid = enginePid;
    session.localProcessAttestation.engineProcStart = engineProcStart;
    session.managedTurnOrigin.preexistingProcessIdentities = [`${enginePid}:${engineProcStart}`];

    const response = await hostPost('auth-request');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, authUrl: AUTH_URL });
  });

  it('refuses a live engine identity outside the calling process lineage', async () => {
    unrelatedProcess = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    const enginePid = unrelatedProcess.pid;
    expect(enginePid).toBeTypeOf('number');
    const engineProcStart = readProcessStartIdentity(enginePid!);
    delete session.localProcessAttestation.cliPid;
    delete session.localProcessAttestation.cliProcStart;
    session.localProcessAttestation.enginePid = enginePid;
    session.localProcessAttestation.engineProcStart = engineProcStart;
    session.managedTurnOrigin.preexistingProcessIdentities = [`${enginePid}:${engineProcStart}`];

    const response = await hostPost('auth-request');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(larkCliAuth.beginLarkCliLogin).not.toHaveBeenCalled();
  });

  it('refuses when the live turn lineage no longer contains the calling process', async () => {
    session.managedTurnOrigin.preexistingProcessIdentities = ['1:1'];
    session.localProcessAttestation.cliPid = 1;
    const response = await hostPost('auth-request');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(larkCliAuth.beginLarkCliLogin).not.toHaveBeenCalled();
  });

  it('refreshes the current turn identity after the host device grant completes', async () => {
    const requestId = (await (await hostPost('auth-request')).json()).requestId;
    completeLogin.mockResolvedValue({ state: 'authorized' });
    vi.mocked(larkCliAuth.larkCliHomeForTurn).mockReturnValue('/homes/ou_host-personal-app');
    const ready = await hostPost('auth-status', { requestId });
    expect(await ready.json()).toEqual({ ok: true, status: 'ready' });
    expect(cliIdentity.refreshSessionIdentity).toHaveBeenCalledWith(expect.any(String), 'host-session', {
      tool: 'lark-cli', mode: 'user-home', home: '/homes/ou_host-personal-app', turnId: 'om_host',
    });
  });
});
