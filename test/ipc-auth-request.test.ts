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
import { config } from '../src/config.js';
import { rememberLarkToolDelegation, clearLarkToolDelegations } from '../src/core/lark-tool-delegation.js';

const CAP = 'ab'.repeat(32);
const SECRET = 'auth-request-test-secret';
const AUTH_URL = 'https://accounts.feishu.cn/oauth/device?user_code=test';
let poll: ReturnType<typeof vi.fn>;
let requestId: string;
let ipc: IpcServerHandle;
let session: any;

beforeEach(async () => {
  session = {
    session: { sessionId: 'auth-session', status: 'active', backendType: 'pty' },
    larkAppId: 'cli_test', chatId: 'oc_test',
    worker: { killed: false, pid: process.pid }, workerGeneration: 4,
    managedTurnOrigin: { capability: CAP, turnId: 'om_turn', callerOpenId: 'ou_sender' },
    // F3: the worker spawn report is the daemon's only identity-model input.
    reportedIdentityModel: { model: process.platform === 'linux' ? 'proven' : 'single',
      sandboxEngaged: false, loopbackShared: true,
      workerPid: process.pid, workerGeneration: 4, reportedAt: 1 },
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
  vi.spyOn(cliIdentity, 'sessionIdentityMaterialPresent').mockReturnValue(true);
  setIpcAuthSecret(SECRET);
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});

afterEach(async () => {
  clearLarkToolDelegations(config.session.dataDir, 'auth-session');
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
  function delegate(targetOpenId = 'ou_target_human', turnId = 'om_turn', overrides = {}) {
    session.managedTurnOrigin.callerOpenId = 'ou_dispatch_bot';
    rememberLarkToolDelegation(config.session.dataDir, 'auth-session', turnId, {
      credentialOpenId: 'ou_source_human', targetOpenId,
      tools: ['lark-cli'], dispatchRoot: 'om_dispatch_root', ...overrides,
    });
  }

  it('requests and completes target-app authorization for the verified delegated human', async () => {
    delegate();
    const request = await (await post()).json();
    expect(request).toMatchObject({ ok: true, authUrl: AUTH_URL });
    expect(tokens.requestUserAuthorization).toHaveBeenCalledExactlyOnceWith(
      'cli_test', 'test-secret', 'feishu', ['im:chat:read'], 'ou_target_human', expect.any(Function),
    );
    expect(identities.resolveVerifiedUserIdentity).not.toHaveBeenCalled();
    poll.mockResolvedValue({ status: 'ready', token: 'target-app-grant' });
    expect(await (await post('auth-status', { requestId: request.requestId })).json()).toEqual({ ok: true, status: 'ready' });
    expect(cliIdentity.refreshSessionIdentity).toHaveBeenCalledWith(expect.any(String), 'auth-session', {
      tool: 'lark-cli', appId: 'cli_test', userAccessToken: 'target-app-grant', turnId: 'om_turn', openId: 'ou_target_human',
    },
    process.platform === 'linux' ? 'proven' : 'single',
  );
  });

  it('authorizes an actorless scheduled delegation through its execution identity', async () => {
    delegate();
    delete session.managedTurnOrigin.callerOpenId;
    session.managedTurnOrigin.identityTurnId = 'om_turn';
    session.managedTurnOrigin.turnId = 'om_envelope';
    const request = await (await post('auth-request', { originTurnId: 'om_envelope' })).json();
    expect(request).toMatchObject({ ok: true, authUrl: AUTH_URL });
    poll.mockResolvedValue({ status: 'ready', token: 'target-app-grant' });
    expect(await (await post('auth-status', { requestId: request.requestId, originTurnId: 'om_envelope' })).json())
      .toEqual({ ok: true, status: 'ready' });
    expect(cliIdentity.refreshSessionIdentity).toHaveBeenCalledWith(expect.any(String), 'auth-session', {
      tool: 'lark-cli', appId: 'cli_test', userAccessToken: 'target-app-grant', turnId: 'om_turn', openId: 'ou_target_human',
    },
    process.platform === 'linux' ? 'proven' : 'single',
  );
  });

  it.each([
    { tools: ['bytedcli'] }, { denialReason: 'target_access_denied' },
    { denialReason: 'target_validation_unavailable' }, { targetOpenId: undefined },
  ])('does not request authorization for a denied delegation: %j', async overrides => {
    delegate('ou_target_human', 'om_turn', overrides);
    expect((await post()).status).toBe(403);
    expect(tokens.requestUserAuthorization).not.toHaveBeenCalled();
  });

  it('does not turn an ordinary bot message into an authorization request', async () => {
    session.managedTurnOrigin.callerOpenId = 'ou_dispatch_bot';
    expect((await post()).status).toBe(403);
    expect(tokens.requestUserAuthorization).not.toHaveBeenCalled();
  });

  it('refuses a delegated grant when target policy is withdrawn', async () => {
    delegate();
    vi.mocked(botRegistry.getBot).mockReturnValue({ config: {
      larkAppId: 'cli_test', larkAppSecret: 'test-secret', triggerUserAuth: { enabled: false, tools: ['lark-cli'] },
    } } as any);
    expect((await post()).status).toBe(403);
    expect(tokens.requestUserAuthorization).not.toHaveBeenCalled();
  });

  it('rejects a delegation replaced while the authorization link is being created', async () => {
    delegate();
    vi.mocked(tokens.requestUserAuthorization).mockImplementation(async () => {
      delegate('ou_other_human');
      return { authUrl: AUTH_URL, scopes: [], expiresIn: 600, poll };
    });
    expect((await post()).status).toBe(409);
  });

  it('lets the same delegated human finish authorization in a later turn', async () => {
    delegate();
    const request = await (await post()).json();
    const stillAuthorized = vi.mocked(tokens.requestUserAuthorization).mock.calls[0][5];
    session.managedTurnOrigin.turnId = 'om_next';
    delegate('ou_target_human', 'om_next');
    expect(stillAuthorized()).toBe(true);
    poll.mockResolvedValue({ status: 'ready', token: 'target-app-grant' });
    expect((await post('auth-status', { requestId: request.requestId, originTurnId: 'om_next' })).status).toBe(200);
    expect(cliIdentity.refreshSessionIdentity).toHaveBeenCalledWith(expect.any(String), 'auth-session', {
      tool: 'lark-cli', appId: 'cli_test', userAccessToken: 'target-app-grant', turnId: 'om_next', openId: 'ou_target_human',
    },
    process.platform === 'linux' ? 'proven' : 'single',
  );
  });

  it('rejects another human behind the same dispatch bot before polling', async () => {
    delegate();
    const request = await (await post()).json();
    const stillAuthorized = vi.mocked(tokens.requestUserAuthorization).mock.calls[0][5];
    session.managedTurnOrigin.turnId = 'om_next';
    delegate('ou_other_human', 'om_next');
    expect(stillAuthorized()).toBe(false);
    expect((await post('auth-status', { requestId: request.requestId, originTurnId: 'om_next' })).status).toBe(409);
    expect(poll).not.toHaveBeenCalled();
    expect(cliIdentity.refreshSessionIdentity).not.toHaveBeenCalled();
  });

  it('stops a pending authorization when the delegation is revoked', async () => {
    delegate();
    await post();
    const stillAuthorized = vi.mocked(tokens.requestUserAuthorization).mock.calls[0][5];
    clearLarkToolDelegations(config.session.dataDir, 'auth-session');
    expect(stillAuthorized()).toBe(false);
  });

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

  it('hands the granted token to the same human’s live follow-up turn', async () => {
    requestId = (await (await post()).json()).requestId;
    // The follow-up turn is live BEFORE the waiting CLI polls again, and that
    // CLI presents the new turn tuple — same human, newer turn.
    session.managedTurnOrigin.turnId = 'om_next';
    poll.mockResolvedValue({ status: 'ready', token: 'test-user-token' });
    const response = await post('auth-status', { requestId, originTurnId: 'om_next' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: 'ready' });
    expect(cliIdentity.refreshSessionIdentity).toHaveBeenCalledWith(expect.any(String), 'auth-session', {
      tool: 'lark-cli', appId: 'cli_test', userAccessToken: 'test-user-token',
      turnId: 'om_next', openId: 'ou_sender',
    },
    process.platform === 'linux' ? 'proven' : 'single',
  );
  });

  it('refuses to hand the token to a different human’s live turn', async () => {
    requestId = (await (await post()).json()).requestId;
    session.managedTurnOrigin.turnId = 'om_next';
    session.managedTurnOrigin.callerOpenId = 'ou_other';
    poll.mockResolvedValue({ status: 'ready', token: 'test-user-token' });
    const response = await post('auth-status', { requestId, originTurnId: 'om_next' });
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
      openId: 'ou_sender',
    },
    process.platform === 'linux' ? 'proven' : 'single',
  );
  });

  it('waits for the matching identity marker and completes after a same-person worker restart', async () => {
    requestId = (await (await post()).json()).requestId;
    poll.mockResolvedValue({ status: 'ready', token: 'test-user-token' });
    vi.mocked(cliIdentity.refreshSessionIdentity).mockReturnValue(false);
    expect(await (await post('auth-status', { requestId })).json()).toEqual({ ok: true, status: 'pending' });
    vi.mocked(cliIdentity.refreshSessionIdentity).mockClear();
    session.workerGeneration++;
    const response = await post('auth-status', { requestId });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: 'pending' });
    vi.mocked(cliIdentity.refreshSessionIdentity).mockReturnValue(true);
    expect(await (await post('auth-status', { requestId })).json()).toEqual({ ok: true, status: 'ready' });
  });

  it('terminates the wait with 409 when the current turn material is gone for good', async () => {
    // Branch 1: originating turn still live. A failed refresh means the
    // material vanished (GC / never prepared / daemon restart) — polling until
    // the deadline could never succeed, so the CLI must stop waiting.
    requestId = (await (await post()).json()).requestId;
    poll.mockResolvedValue({ status: 'ready', token: 'test-user-token' });
    vi.mocked(cliIdentity.refreshSessionIdentity).mockReturnValue(false);
    vi.mocked(cliIdentity.sessionIdentityMaterialPresent).mockReturnValue(false);
    const response = await post('auth-status', { requestId });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: 'auth_identity_snapshot_missing' });
  });

  it('terminates the wait with 409 when a rotated same-person turn has no material', async () => {
    // Branch 2: the turn rotated to a same-principal follow-up while the human
    // was authorizing; the live turn's material is missing, so neither a
    // perpetual pending poll nor publication into a dead turn is acceptable.
    requestId = (await (await post()).json()).requestId;
    poll.mockResolvedValue({ status: 'ready', token: 'test-user-token' });
    vi.mocked(cliIdentity.refreshSessionIdentity).mockReturnValue(false);
    vi.mocked(cliIdentity.sessionIdentityMaterialPresent).mockReturnValue(false);
    session.managedTurnOrigin = { capability: CAP, turnId: 'om_next', callerOpenId: 'ou_sender' };
    const response = await post('auth-status', { requestId, originTurnId: 'om_next' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: 'auth_identity_snapshot_missing' });
  });

  it('daemon-side polling completes the grant after the Agent turn ends without a wait call', async () => {
    requestId = (await (await post()).json()).requestId;
    // The originating turn is gone; the daemon keeps polling but must not
    // publish credentials into any stale turn.
    session.managedTurnOrigin = undefined;
    expect(tokens.requestUserAuthorization.mock.calls[0][5]()).toBe(true);
    poll.mockResolvedValue({ status: 'ready', token: 'test-user-token' });
    await vi.waitFor(() => expect(poll).toHaveBeenCalled(), { timeout: 3_000 });
    expect(cliIdentity.refreshSessionIdentity).not.toHaveBeenCalled();
    // The same human's follow-up turn claims the already-completed grant.
    session.managedTurnOrigin = { capability: CAP, turnId: 'om_next', callerOpenId: 'ou_sender' };
    const response = await post('auth-status', { requestId, originTurnId: 'om_next' });
    expect(await response.json()).toEqual({ ok: true, status: 'ready' });
    expect(cliIdentity.refreshSessionIdentity).toHaveBeenCalledWith(expect.any(String), 'auth-session', {
      tool: 'lark-cli', appId: 'cli_test', userAccessToken: 'test-user-token', turnId: 'om_next', openId: 'ou_sender',
    },
    process.platform === 'linux' ? 'proven' : 'single',
  );
  });

  it('reuses a pending link across turns without extending its deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const first = await (await post()).json();
      vi.setSystemTime(Date.now() + 30_000);
      session.managedTurnOrigin.turnId = 'om_next';
      const next = await (await post('auth-request', { originTurnId: 'om_next' })).json();
      expect(next).toMatchObject({ requestId: first.requestId, authUrl: first.authUrl, expiresIn: 570 });
      expect(tokens.requestUserAuthorization).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('does not expose another speaker or application grant to the current turn', async () => {
    requestId = (await (await post()).json()).requestId;
    // A different human is a turn change; a different application means the
    // tracked grant itself no longer applies — the two refusals must stay
    // distinguishable so each guard call point is pinned.
    session.managedTurnOrigin.callerOpenId = 'ou_other';
    let response = await post('auth-status', { requestId });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'auth_turn_changed' });
    session.managedTurnOrigin.callerOpenId = 'ou_sender';
    session.larkAppId = 'cli_other';
    response = await post('auth-status', { requestId });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'auth_request_expired' });
    expect(poll).not.toHaveBeenCalled();
    expect(cliIdentity.refreshSessionIdentity).not.toHaveBeenCalled();
  });

  it.each(['closed', 'replaced', 'secret_changed'])('invalidates an issued grant when the session is %s', async change => {
    await post();
    const isGrantValid = vi.mocked(tokens.requestUserAuthorization).mock.calls[0][5];
    if (change === 'closed') session.session.status = 'closed';
    if (change === 'replaced') session = { ...session };
    if (change === 'secret_changed') vi.mocked(botRegistry.getBot).mockReturnValue({ config: {
      larkAppId: 'cli_test', larkAppSecret: 'new-secret',
    } } as any);
    expect(isGrantValid()).toBe(false);
  });

  it('stops grant completion when the IPC server closes', async () => {
    await post();
    const isGrantValid = vi.mocked(tokens.requestUserAuthorization).mock.calls[0][5];
    await ipc.close();
    expect(isGrantValid()).toBe(false);
    expect(poll).not.toHaveBeenCalled();
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
      session: { sessionId: 'host-session', status: 'active', backendType: 'pty' },
      larkAppId: 'cli_test', chatId: 'oc_test',
      worker: { pid: process.pid, killed: false }, workerGeneration: 9,
      // F3: identity model comes from the worker spawn report.
      reportedIdentityModel: { model: 'proven', sandboxEngaged: false, loopbackShared: true,
        workerPid: process.pid, workerGeneration: 9, reportedAt: 1 },
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
    clearLarkToolDelegations(config.session.dataDir, 'host-session');
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

  it('authorizes a delegated human through the managed host process proof', async () => {
    session.managedTurnOrigin.callerOpenId = 'ou_dispatch_bot';
    rememberLarkToolDelegation(config.session.dataDir, 'host-session', 'om_host', {
      credentialOpenId: 'ou_source_human', targetOpenId: 'ou_target_human',
      tools: ['lark-cli'], dispatchRoot: 'om_dispatch_root',
    });
    const request = await (await hostPost('auth-request')).json();
    expect(request).toMatchObject({ ok: true, authUrl: AUTH_URL });
    expect(tokens.requestUserAuthorization).toHaveBeenCalledWith(
      'cli_test', 'test-secret', 'feishu', ['im:chat:read'], 'ou_target_human', expect.any(Function),
    );
    poll.mockResolvedValue({ status: 'ready', token: 'target-app-grant' });
    expect(await (await hostPost('auth-status', { requestId: request.requestId })).json()).toEqual({ ok: true, status: 'ready' });
    expect(cliIdentity.refreshSessionIdentity).toHaveBeenCalledWith(expect.any(String), 'host-session', {
      tool: 'lark-cli', appId: 'cli_test', userAccessToken: 'target-app-grant', turnId: 'om_host', openId: 'ou_target_human',
    },
    process.platform === 'linux' ? 'proven' : 'single',
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
      openId: 'ou_host',
    },
    process.platform === 'linux' ? 'proven' : 'single',
  );
  });
});
