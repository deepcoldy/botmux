import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as botRegistry from '../src/bot-registry.js';
import * as identities from '../src/im/lark/identity-cache.js';
import * as tokens from '../src/utils/user-token.js';
import * as cliIdentity from '../src/core/cli-identity.js';

const CAP = 'ab'.repeat(32);
const SECRET = 'auth-request-test-secret';
const AUTH_URL = 'https://accounts.feishu.cn/oauth/device?user_code=test';
let poll: ReturnType<typeof vi.fn>;
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
  poll = vi.fn().mockResolvedValue({ status: 'pending' });
  vi.spyOn(tokens, 'requestUserAuthorization').mockResolvedValue({
    authUrl: AUTH_URL, scopes: ['offline_access', 'im:chat:read'], expiresIn: 600, poll,
  });
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
      ok: true, authUrl: AUTH_URL, requestId: expect.any(String), scopes: ['offline_access', 'im:chat:read'], expiresIn: 600, autoCallback: true,
    });
    expect(tokens.requestUserAuthorization).toHaveBeenCalledWith(
      'cli_test', 'test-secret', 'feishu', ['im:chat:read'], 'ou_sender', expect.any(Function),
    );
  });

  it.each([
    { originCapability: undefined }, { originTurnId: undefined },
    { originTurnId: 'om_earlier' }, { originDispatchAttempt: 2 },
  ])('rejects incomplete or stale turn claims even with host authorization: %j', async fields => {
    const response = await post('auth-request', fields, true);
    expect(response.status).toBe(403);
    expect(tokens.requestUserAuthorization).not.toHaveBeenCalled();
  });

  it('rejects identity overrides and misspelled permissions', async () => {
    expect((await post('auth-request', { callerOpenId: 'ou_other' })).status).toBe(400);
    expect((await post('auth-request', { scopes: ['im:chat:raed'] })).status).toBe(400);
    expect(tokens.requestUserAuthorization).not.toHaveBeenCalled();
  });

  it('accepts the legacy chat permissions reported by the API', async () => {
    const scopes = ['im:chat', 'im:chat:readonly', 'im:chat:read'];
    expect((await post('auth-request', { scopes })).status).toBe(200);
    expect(tokens.requestUserAuthorization).toHaveBeenCalledWith(
      'cli_test', 'test-secret', 'feishu', scopes, 'ou_sender', expect.any(Function),
    );
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
    expect(tokens.requestUserAuthorization).not.toHaveBeenCalled();
  });

  it('returns default scopes and waits for the device grant when no extra scope is requested', async () => {
    const request = await (await post('auth-request', { scopes: [] })).json();
    expect(request.scopes).toEqual(['offline_access', 'im:chat:read']);
    const response = await post('auth-status', { requestId: request.requestId });
    expect(await response.json()).toEqual({ ok: true, status: 'pending' });
    expect(poll).toHaveBeenCalledOnce();
    expect(cliIdentity.refreshSessionIdentity).not.toHaveBeenCalled();
  });

  it('returns a safe error when creating the device grant fails', async () => {
    vi.mocked(tokens.requestUserAuthorization).mockRejectedValue(new Error('secret-bearing upstream error'));
    const response = await post();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: 'authorization_request_failed' });
  });

  it('rejects a turn change while creating the device grant', async () => {
    vi.mocked(tokens.requestUserAuthorization).mockImplementation(async () => {
      session.managedTurnOrigin.turnId = 'om_next';
      return { authUrl: AUTH_URL, scopes: [], expiresIn: 600, poll };
    });
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'auth_turn_changed' });
  });

  it('reports a failed grant without refreshing credentials', async () => {
    requestId = (await (await post()).json()).requestId;
    poll.mockResolvedValue({ status: 'failed', error: 'authorization_user_mismatch' });
    const response = await post('auth-status', { requestId });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, status: 'failed', error: 'authorization_user_mismatch' });
    expect(cliIdentity.refreshSessionIdentity).not.toHaveBeenCalled();
  });

  it('refuses to publish credentials when the turn changes during token resolution', async () => {
    requestId = (await (await post()).json()).requestId;
    poll.mockImplementation(async () => {
      session.managedTurnOrigin.turnId = 'om_next';
      return { status: 'ready', token: 'test-user-token' };
    });
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
    expect(tokens.requestUserAuthorization).not.toHaveBeenCalled();
  });

  it('reports pending, then refreshes only the requesting turn after authorization', async () => {
    requestId = (await (await post()).json()).requestId;
    const pending = await post('auth-status', { requestId });
    expect(await pending.json()).toEqual({ ok: true, status: 'pending' });
    expect(cliIdentity.refreshSessionIdentity).not.toHaveBeenCalled();
    poll.mockResolvedValue({ status: 'ready', token: 'test-user-token' });
    const ready = await post('auth-status', { requestId });
    expect(await ready.json()).toEqual({ ok: true, status: 'ready' });
    expect(cliIdentity.refreshSessionIdentity).toHaveBeenCalledWith(expect.any(String), 'auth-session', {
      tool: 'lark-cli', appId: 'cli_test', userAccessToken: 'test-user-token', turnId: 'om_turn',
    });
  });

  it('preserves newer queued credentials and refuses a rotated worker', async () => {
    requestId = (await (await post()).json()).requestId;
    poll.mockResolvedValue({ status: 'ready', token: 'test-user-token' });
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
  let poll: ReturnType<typeof vi.fn>;
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
    poll = vi.fn().mockResolvedValue({ status: 'pending' });
    vi.spyOn(tokens, 'requestUserAuthorization').mockResolvedValue({
      authUrl: AUTH_URL, scopes: ['offline_access', 'im:chat:read'], expiresIn: 600, poll,
    });
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
    expect(tokens.requestUserAuthorization).toHaveBeenCalledWith(
      'cli_test', 'test-secret', 'feishu', ['im:chat:read'], 'ou_host', expect.any(Function),
    );
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
    expect(tokens.requestUserAuthorization).not.toHaveBeenCalled();
  });

  it('refuses when the live turn lineage no longer contains the calling process', async () => {
    session.managedTurnOrigin.preexistingProcessIdentities = ['1:1'];
    session.localProcessAttestation.cliPid = 1;
    const response = await hostPost('auth-request');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(tokens.requestUserAuthorization).not.toHaveBeenCalled();
  });

  it('refreshes the current turn identity after the host device grant completes', async () => {
    const requestId = (await (await hostPost('auth-request')).json()).requestId;
    poll.mockResolvedValue({ status: 'ready', token: 'host-user-token' });
    const ready = await hostPost('auth-status', { requestId });
    expect(await ready.json()).toEqual({ ok: true, status: 'ready' });
    expect(cliIdentity.refreshSessionIdentity).toHaveBeenCalledWith(expect.any(String), 'host-session', {
      tool: 'lark-cli', appId: 'cli_test', userAccessToken: 'host-user-token', turnId: 'om_host',
    });
  });
});
