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
import * as larkClient from '../src/im/lark/client.js';
import { config } from '../src/config.js';
import { rememberLarkToolDelegation, clearLarkToolDelegations } from '../src/core/lark-tool-delegation.js';
import * as meegoAuth from '../src/services/meego-auth.js';
import * as bytedcliAuth from '../src/services/bytedcli-auth.js';
import * as larkCliAuth from '../src/services/lark-cli-auth.js';
import { __resetUnattendedNoticesForTest } from '../src/core/capability-authorization.js';
import { sessionAuthRequests } from '../src/core/session-auth-requests.js';
import { __resetProviderAuthForTest } from '../src/core/provider-auth-request.js';
import { __setPlatformCredentialDepsForTest } from '../src/core/platform-credential-source.js';

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
    // A 1:1 chat with the requester: the only place auth request hands the
    // link to the agent (groups get it by DM — see the group describe below).
    larkAppId: 'cli_test', chatId: 'oc_test', chatType: 'p2p',
    worker: { killed: false, pid: process.pid }, workerGeneration: 4,
    managedTurnOrigin: { capability: CAP, turnId: 'om_turn', callerOpenId: 'ou_sender' },
    // F3: the worker spawn report is the daemon's only identity-model input.
    reportedIdentityModel: { model: process.platform === 'linux' ? 'proven' : 'single',
      sandboxEngaged: false, loopbackShared: true,
      workerPid: process.pid, workerGeneration: 4, reportedAt: 1 },
  };
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 'auth-session' ? session : undefined);
  vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: { larkAppId: 'cli_test', larkAppSecret: 'test-secret', triggerUserAuth: { enabled: true, tools: ['lark-cli'] } } } as any);
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
  vi.useRealTimers();
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

describe('agent authorization in a group chat', () => {
  beforeEach(() => { session.chatType = 'group'; });

  it('DMs the link to the requester and never returns it to the agent', async () => {
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
    const ephemeral = vi.spyOn(larkClient, 'sendEphemeralCard').mockResolvedValue('om_private');
    const response = await post();
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.delivery).toBe('dm');
    expect(body.authUrl).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(AUTH_URL);
    expect(typeof body.requestId).toBe('string');
    expect(dm).toHaveBeenCalledTimes(1);
    expect(dm.mock.calls[0][0]).toBe('cli_test');
    expect(dm.mock.calls[0][1]).toBe('ou_sender');
    expect(dm.mock.calls[0][2]).toContain(AUTH_URL);
    expect(ephemeral).not.toHaveBeenCalled();

    // Reusing the pending request does not DM again and still hides the link.
    const again = await (await post()).json() as Record<string, unknown>;
    expect(again.delivery).toBe('dm');
    expect(again.requestId).toBe(body.requestId);
    expect(again.authUrl).toBeUndefined();
    expect(dm).toHaveBeenCalledTimes(1);
  });

  it('an unattended turn asking for scopes: one deduped private DM, answered at once, no link and no waiting', async () => {
    __resetUnattendedNoticesForTest();
    session.managedTurnOrigin.identityTurnId = 'schedule:abc12345:11111111-1111-1111-1111-111111111111';
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
    for (let i = 0; i < 2; i++) {
      const response = await post();
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({ ok: false, status: 'refused', error: 'unattended_turn' });
      expect(JSON.stringify(body)).not.toContain(AUTH_URL);
    }
    expect(dm).toHaveBeenCalledTimes(1);
    expect(dm.mock.calls[0].slice(0, 2)).toEqual(['cli_test', 'ou_sender']);
    expect(dm.mock.calls[0][2]).toContain(AUTH_URL);
    expect(poll).not.toHaveBeenCalled();
  });

  it('falls back to a requester-only group card and reuses its actual delivery receipt', async () => {
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockRejectedValue(new Error('230013 user not in scope'));
    const ephemeral = vi.spyOn(larkClient, 'sendEphemeralCard').mockResolvedValue('om_private');
    const publicSend = vi.spyOn(larkClient, 'sendMessage').mockResolvedValue('om_public');
    const publicReply = vi.spyOn(larkClient, 'replyMessage').mockResolvedValue('om_reply');
    const response = await post();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, delivery: 'ephemeral' });
    expect(JSON.stringify(body)).not.toContain(AUTH_URL);
    expect(ephemeral).toHaveBeenCalledExactlyOnceWith('cli_test', 'oc_test', 'ou_sender', expect.stringContaining(AUTH_URL));
    const again = await (await post()).json();
    expect(again).toMatchObject({ requestId: body.requestId, delivery: 'ephemeral' });
    expect(JSON.stringify(again)).not.toContain(AUTH_URL);
    expect(dm).toHaveBeenCalledTimes(1);
    expect(ephemeral).toHaveBeenCalledTimes(1);
    expect(tokens.requestUserAuthorization).toHaveBeenCalledTimes(1);
    expect(publicSend).not.toHaveBeenCalled();
    expect(publicReply).not.toHaveBeenCalled();
    poll.mockResolvedValue({ status: 'ready', token: 'authorized-after-private-card' });
    expect(await (await post('auth-status', { requestId: body.requestId })).json()).toEqual({ ok: true, status: 'ready' });
  });

  it('does not report delivery or resend while a private delivery is in flight', async () => {
    let release!: (value: string) => void;
    let entered!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockImplementation(() => {
      entered();
      return new Promise<string>(resolve => { release = resolve; });
    });
    const first = post();
    await sending;
    try {
      const response = await post();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'auth_link_delivery_pending' });
      expect(dm).toHaveBeenCalledTimes(1);
      expect(tokens.requestUserAuthorization).toHaveBeenCalledTimes(1);
    } finally { release('om_dm'); }
    expect(await (await first).json()).toMatchObject({ ok: true, delivery: 'dm' });
  });

  it.each(['disabled', 'expired', 'closed', 'different_actor'])('does not start fallback after the grant is retired: %s', async reason => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let reject!: (error: Error) => void;
    let entered!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(larkClient, 'sendUserMessage').mockImplementation(() => {
      entered();
      return new Promise<string>((_, fail) => { reject = fail; });
    });
    const ephemeral = vi.spyOn(larkClient, 'sendEphemeralCard').mockResolvedValue('om_private');
    const pending = post();
    await sending;
    if (reason === 'disabled') vi.mocked(botRegistry.getBot).mockReturnValue({ config: {
      larkAppId: 'cli_test', larkAppSecret: 'test-secret', triggerUserAuth: { enabled: false },
    } } as any);
    if (reason === 'closed') session.session.status = 'closed';
    if (reason === 'different_actor') session.managedTurnOrigin.callerOpenId = 'ou_other';
    await vi.advanceTimersByTimeAsync(reason === 'expired' ? 600_001 : 2_001);
    expect([...sessionAuthRequests.values()]).toHaveLength(0);
    reject(new Error('DM failed'));
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: 'auth_request_expired' });
    expect(ephemeral).not.toHaveBeenCalled();
  });

  it('still delivers for the same requester after their turn rotates', async () => {
    vi.spyOn(larkClient, 'sendUserMessage').mockImplementation(async () => {
      session.managedTurnOrigin.turnId = 'om_next_turn';
      throw new Error('DM unavailable');
    });
    const ephemeral = vi.spyOn(larkClient, 'sendEphemeralCard').mockResolvedValue('om_private');
    const response = await post();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, delivery: 'ephemeral' });
    expect(ephemeral).toHaveBeenCalledExactlyOnceWith('cli_test', 'oc_test', 'ou_sender', expect.stringContaining(AUTH_URL));
    expect(await (await post('auth-status', { requestId: body.requestId, originTurnId: 'om_next_turn' })).json())
      .toEqual({ ok: true, status: 'pending' });
  });

  it('does not report a usable request when the grant expires during card delivery', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.spyOn(larkClient, 'sendUserMessage').mockRejectedValue(new Error('DM unavailable'));
    let release!: (id: string) => void;
    let entered!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    const ephemeral = vi.spyOn(larkClient, 'sendEphemeralCard').mockImplementation(() => {
      entered();
      return new Promise<string>(resolve => { release = resolve; });
    });
    const pending = post();
    await sending;
    await vi.advanceTimersByTimeAsync(600_001);
    release('om_private');
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: 'auth_request_expired' });
    expect(ephemeral).toHaveBeenCalledTimes(1);
    expect([...sessionAuthRequests.values()]).toHaveLength(0);
  });

  it('refuses without a link when both private channels fail, and drops the request', async () => {
    vi.spyOn(larkClient, 'sendUserMessage').mockRejectedValue(new Error('230013 user not in scope'));
    vi.spyOn(larkClient, 'sendEphemeralCard').mockRejectedValue(new Error('18053 topic group unsupported'));
    const response = await post();
    expect(response.status).toBe(409);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBe('auth_link_private_delivery_failed');
    expect(JSON.stringify(body)).not.toContain(AUTH_URL);
    // A retry mints a fresh request instead of reusing the undelivered one.
    vi.mocked(larkClient.sendUserMessage).mockResolvedValue('om_dm');
    const retry = await (await post()).json() as Record<string, unknown>;
    expect(retry.delivery).toBe('dm');
    expect(tokens.requestUserAuthorization).toHaveBeenCalledTimes(2);
  });
});

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
    { enabled: false, tools: ['lark-cli'] },
    { enabled: true, tools: ['bytedcli'] },
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
      larkAppId: 'cli_test', chatId: 'oc_test', chatType: 'p2p',
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
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: { larkAppId: 'cli_test', larkAppSecret: 'test-secret', triggerUserAuth: { enabled: true, tools: ['lark-cli'] } } } as any);
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

describe('provider authorization asked for by the bytedcli wrapper', () => {
  const MEEGO_URL = 'https://meego.example/device?code=M1';
  let replies: string[];

  beforeEach(() => {
    __resetProviderAuthForTest();
    session.chatType = 'group';
    session.session.rootMessageId = 'om_root';
    vi.mocked(botRegistry.getBot).mockReturnValue({ config: {
      larkAppId: 'cli_test', larkAppSecret: 'test-secret',
      triggerUserAuth: { enabled: true, tools: ['bytedcli'] },
    } } as any);
    vi.spyOn(meegoAuth, 'requestMeegoLogin').mockResolvedValue({ state: 'link', authUrl: MEEGO_URL });
    replies = [];
    vi.spyOn(larkClient, 'replyMessage').mockImplementation(async (_app, _root, text) => { replies.push(String(text)); return 'om_reply'; });
  });

  const ask = (overrides: Record<string, unknown> = {}) => post('auth-request', { scopes: undefined, provider: 'meego', ...overrides });

  it('group: DMs the link to this turn\'s sender; the agent and the group never see it', async () => {
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
    const response = await ask();
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, provider: 'meego', status: 'delivered', delivery: 'dm' });
    expect(JSON.stringify(body)).not.toContain(MEEGO_URL);
    expect(meegoAuth.requestMeegoLogin).toHaveBeenCalledExactlyOnceWith('ou_sender', undefined);
    expect(dm).toHaveBeenCalledTimes(1);
    expect(dm.mock.calls[0].slice(0, 2)).toEqual(['cli_test', 'ou_sender']);
    expect(dm.mock.calls[0][2]).toContain(MEEGO_URL);
    expect(replies).toHaveLength(1);
    expect(replies.join('')).not.toContain(MEEGO_URL);
  });

  it('DM fails: a card only the sender can see, in this chat; the link is never a group message', async () => {
    vi.spyOn(larkClient, 'sendUserMessage').mockRejectedValue(new Error('230013 user not in scope'));
    const card = vi.spyOn(larkClient, 'sendEphemeralCard').mockResolvedValue('om_card' as any);
    const body = await (await ask()).json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: 'delivered', delivery: 'ephemeral' });
    expect(card).toHaveBeenCalledTimes(1);
    expect(card.mock.calls[0].slice(0, 3)).toEqual(['cli_test', 'oc_test', 'ou_sender']);
    expect(String(card.mock.calls[0][3])).toContain(MEEGO_URL);
    expect(replies.join('')).not.toContain(MEEGO_URL);
  });

  it('DM and private card both fail: undeliverable, the group hears where to get it, never the link', async () => {
    vi.spyOn(larkClient, 'sendUserMessage').mockRejectedValue(new Error('230013 user not in scope'));
    vi.spyOn(larkClient, 'sendEphemeralCard').mockRejectedValue(new Error('18053 topic group'));
    const body = await (await ask()).json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: 'undeliverable', delivery: 'dm_failed' });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('/login meego');
    expect(replies[0]).not.toContain(MEEGO_URL);
    // Retries in the same burst do not repeat the notice.
    await ask();
    expect(replies).toHaveLength(1);
  });

  it('even the notice failing is an answer the wrapper can act on, not an error', async () => {
    vi.spyOn(larkClient, 'sendUserMessage').mockRejectedValue(new Error('230013'));
    vi.spyOn(larkClient, 'sendEphemeralCard').mockRejectedValue(new Error('18053'));
    vi.mocked(larkClient.replyMessage).mockRejectedValue(new Error('network'));
    const response = await ask();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'undeliverable' });
  });

  it('1:1 chat: the link is posted right there, to the person', async () => {
    session.chatType = 'p2p';
    const dm = vi.spyOn(larkClient, 'sendUserMessage');
    const body = await (await ask()).json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'delivered', delivery: 'inline' });
    expect(replies[0]).toContain(MEEGO_URL);
    expect(dm).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(MEEGO_URL);
  });

  it('already logged in: ready, nothing sent', async () => {
    vi.mocked(meegoAuth.requestMeegoLogin).mockResolvedValue({ state: 'ready' });
    const dm = vi.spyOn(larkClient, 'sendUserMessage');
    expect(await (await ask()).json()).toMatchObject({ ok: true, status: 'ready' });
    expect(dm).not.toHaveBeenCalled();
    expect(replies).toEqual([]);
  });

  it('refuses a delegated turn: that person is not here to approve anything', async () => {
    rememberLarkToolDelegation(config.session.dataDir, 'auth-session', 'om_turn', {
      credentialOpenId: 'ou_source_human', targetOpenId: 'ou_target_human',
      tools: ['bytedcli'], dispatchRoot: 'om_dispatch_root',
    });
    const response = await ask();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, status: 'refused', error: 'delegated_turn' });
    expect(meegoAuth.requestMeegoLogin).not.toHaveBeenCalled();
  });

  it('refuses when the bot does not run bytedcli as the person', async () => {
    vi.mocked(botRegistry.getBot).mockReturnValue({ config: {
      larkAppId: 'cli_test', larkAppSecret: 'test-secret',
      triggerUserAuth: { enabled: true, tools: ['lark-cli'] },
    } } as any);
    const response = await ask();
    expect(response.status).toBe(409);
    expect(meegoAuth.requestMeegoLogin).not.toHaveBeenCalled();
  });

  it('platform-supplied ByteCloud identity: no ByteCloud login is started here', async () => {
    vi.mocked(botRegistry.getBot).mockReturnValue({ config: {
      larkAppId: 'cli_test', larkAppSecret: 'test-secret',
      triggerUserAuth: { enabled: true, tools: ['bytedcli'], credentialSource: 'platform' },
    } } as any);
    const dm = vi.spyOn(larkClient, 'sendUserMessage');
    const response = await ask({ provider: 'bytedcli' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, status: 'refused', error: 'platform_credentials' });
    expect(dm).not.toHaveBeenCalled();
    expect(replies).toEqual([]);
  });

  describe('on a host bound to the platform', () => {
    const PAGE = 'https://platform.example.test/credentials';
    const DEVICE = 'https://cloud.example/device?code=B1';
    const botWith = (credentialSource?: string) => vi.mocked(botRegistry.getBot).mockReturnValue({ config: {
      larkAppId: 'cli_test', larkAppSecret: 'test-secret',
      triggerUserAuth: { enabled: true, tools: ['bytedcli'], ...(credentialSource ? { credentialSource } : {}) },
    } } as any);
    const publish = (reason: string) => vi.spyOn(cliIdentity, 'recallProvenIdentityContent')
      .mockReturnValue(`BOTMUX_IDENTITY_MODE='denied'\n[reason=${reason}]`);
    let device: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      __setPlatformCredentialDepsForTest({ readBinding: () => ({ platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' }) as any });
      device = vi.spyOn(bytedcliAuth, 'beginBytedcliLogin').mockResolvedValue({ authUrl: DEVICE } as any);
      vi.spyOn(bytedcliAuth, 'describeBytedcliAuth').mockResolvedValue({ state: 'needs-login' });
    });
    afterEach(() => __setPlatformCredentialDepsForTest(null));

    it('auto: one DM with the platform page and the Meego link, no local device login, no link back to the agent', async () => {
      botWith();
      publish('platform_not_authorized');
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      const body = await (await ask({ provider: 'bytedcli' })).json();
      expect(body).toMatchObject({ ok: true, status: 'delivered', delivery: 'dm' });
      expect(JSON.stringify(body)).not.toMatch(/https?:/);
      expect(dm).toHaveBeenCalledTimes(1);
      expect(dm.mock.calls[0][2]).toContain(PAGE);
      expect(dm.mock.calls[0][2]).toContain(MEEGO_URL);
      expect(device).not.toHaveBeenCalled();
      // Burst of retries: the same page is not sent again.
      expect(await (await ask({ provider: 'bytedcli' })).json()).toMatchObject({ status: 'pending' });
      expect(dm).toHaveBeenCalledTimes(1);
    });

    it('auto: a login asked for by someone this turn already acts as is answered ready, and nothing is sent', async () => {
      botWith();
      vi.spyOn(cliIdentity, 'recallProvenIdentityContent').mockReturnValue("BOTMUX_IDENTITY_MODE='user'\n");
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      const body = await (await ask({ provider: 'bytedcli' })).json();
      expect(body).toMatchObject({ ok: true, status: 'ready' });
      expect(dm).not.toHaveBeenCalled();
      expect(device).not.toHaveBeenCalled();
    });

    it('auto: the DM fails, so the platform page goes in a card only the person sees', async () => {
      botWith();
      publish('platform_not_authorized');
      vi.spyOn(larkClient, 'sendUserMessage').mockRejectedValue(new Error('230013'));
      const ephemeral = vi.spyOn(larkClient, 'sendEphemeralCard').mockResolvedValue('om_private');
      const body = await (await ask({ provider: 'bytedcli' })).json();
      expect(body).toMatchObject({ ok: true, status: 'delivered', delivery: 'ephemeral' });
      expect(JSON.stringify(body)).not.toMatch(/https?:/);
      expect(ephemeral).toHaveBeenCalledExactlyOnceWith('cli_test', 'oc_test', 'ou_sender', expect.stringContaining(PAGE));
    });

    it('auto: the platform will not issue for this person (not a teammate): the local entry is sent instead, and the agent is told so without a link', async () => {
      botWith();
      publish('platform_not_teammate');
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      const body = await (await ask({ provider: 'bytedcli' })).json() as { message: string };
      expect(body).toMatchObject({ ok: true, status: 'delivered' });
      expect(body.message).toContain('不会为这位发起人签发');
      expect(JSON.stringify(body)).not.toMatch(/https?:/);
      expect(dm).toHaveBeenCalledTimes(1);
      expect(dm.mock.calls[0][2]).toContain(DEVICE);
      expect(dm.mock.calls[0][2]).toContain(MEEGO_URL);
      expect(dm.mock.calls[0][2]).not.toContain(PAGE);
    });

    it('platform only: no local fallback; the agent is told the person must be added to the platform team', async () => {
      botWith('platform');
      publish('platform_not_teammate');
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      const response = await ask({ provider: 'bytedcli' });
      expect(response.status).toBe(409);
      const body = await response.json() as { message: string };
      expect(body).toMatchObject({ ok: false, status: 'refused', error: 'platform_denied' });
      expect(body.message).toContain('加入平台上的团队');
      expect(JSON.stringify(body)).not.toMatch(/https?:/);
      expect(dm).not.toHaveBeenCalled();
      expect(device).not.toHaveBeenCalled();
    });

    it('source local ignores the platform and keeps the device login', async () => {
      botWith('local');
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      await ask({ provider: 'bytedcli' });
      expect(dm.mock.calls[0][2]).toContain(DEVICE);
      expect(dm.mock.calls[0][2]).not.toContain(PAGE);
    });

    it('lark-cli asks the same way and gets the platform page', async () => {
      vi.mocked(botRegistry.getBot).mockReturnValue({ config: {
        larkAppId: 'cli_test', larkAppSecret: 'test-secret', triggerUserAuth: { enabled: true, tools: ['lark-cli'], capabilities: ['lark-user'] },
      } } as any);
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      const body = await (await ask({ provider: 'lark-cli' })).json();
      expect(body).toMatchObject({ ok: true, status: 'delivered' });
      expect(JSON.stringify(body)).not.toMatch(/https?:/);
      expect(dm.mock.calls[0][2]).toContain(PAGE);
    });

    it('the one platform page serves both tools: a lark-cli refusal right after a ByteCloud one sends nothing more', async () => {
      vi.mocked(botRegistry.getBot).mockReturnValue({ config: {
        larkAppId: 'cli_test', larkAppSecret: 'test-secret', triggerUserAuth: { enabled: true, capabilities: ['lark-user', 'bytecloud'] },
      } } as any);
      publish('platform_not_authorized');
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      expect(await (await ask({ provider: 'bytedcli' })).json()).toMatchObject({ status: 'delivered' });
      expect(await (await ask({ provider: 'lark-cli' })).json()).toMatchObject({ status: 'pending' });
      expect(dm).toHaveBeenCalledTimes(1);
    });
  });

  it('an attended ByteCloud refusal also carries the Meego link when that login is missing too: one DM', async () => {
    vi.spyOn(bytedcliAuth, 'describeBytedcliAuth').mockResolvedValue({ state: 'needs-login' });
    vi.spyOn(bytedcliAuth, 'beginBytedcliLogin').mockResolvedValue({ authUrl: 'https://cloud.example/device?code=B1' } as any);
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
    const body = await (await ask({ provider: 'bytedcli' })).json();
    expect(body).toMatchObject({ ok: true, status: 'delivered' });
    expect(dm).toHaveBeenCalledTimes(1);
    expect(dm.mock.calls[0][2]).toContain('https://cloud.example/device?code=B1');
    expect(dm.mock.calls[0][2]).toContain(MEEGO_URL);
  });

  describe('unattended turns', () => {
    const SCHEDULED = 'schedule:abc12345:11111111-1111-1111-1111-111111111111';
    beforeEach(() => {
      session.managedTurnOrigin.identityTurnId = SCHEDULED;
      __resetUnattendedNoticesForTest();
      vi.spyOn(bytedcliAuth, 'describeBytedcliAuth').mockResolvedValue({ state: 'needs-login' });
      vi.spyOn(bytedcliAuth, 'beginBytedcliLogin').mockResolvedValue({ authUrl: 'https://cloud.example/device?code=B1' } as any);
      vi.spyOn(larkCliAuth, 'describeLarkCliAuth').mockReturnValue({ state: 'needs-login' });
      vi.spyOn(larkCliAuth, 'beginLarkCliLogin').mockResolvedValue({ authUrl: 'https://lark.example/device?code=L1' } as any);
    });
    afterEach(() => { delete session.managedTurnOrigin.identityTurnId; });

    it('never get an interactive authorization: refused without the flag, nothing sent', async () => {
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      for (const overrides of [{}, { provider: 'bytedcli' }]) {
        const response = await ask(overrides);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ ok: false, status: 'refused', error: 'unattended_turn' });
      }
      expect(meegoAuth.requestMeegoLogin).not.toHaveBeenCalled();
      expect(dm).not.toHaveBeenCalled();
      expect(replies).toEqual([]);
    });

    it('--unattended Meego: one private DM with every missing link, nothing in the group, no link back to the agent, deduped across providers', async () => {
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      const body = await (await ask({ unattended: true })).json() as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, status: 'delivered' });
      expect(JSON.stringify(body)).not.toContain(MEEGO_URL);
      expect(dm).toHaveBeenCalledTimes(1);
      expect(dm.mock.calls[0].slice(0, 2)).toEqual(['cli_test', 'ou_sender']);
      expect(dm.mock.calls[0][2]).toContain(MEEGO_URL);
      expect(dm.mock.calls[0][2]).toContain('https://cloud.example/device?code=B1');
      expect(replies).toEqual([]);
      await ask({ unattended: true });
      await ask({ unattended: true, provider: 'bytedcli' });
      expect(dm).toHaveBeenCalledTimes(1);
    });

    it('--unattended ByteCloud answers at once with one DM and no wait', async () => {
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      const body = await (await ask({ unattended: true, provider: 'bytedcli' })).json();
      expect(body).toMatchObject({ ok: true, status: 'delivered', message: '' });
      expect(dm).toHaveBeenCalledTimes(1);
    });

    it('a turn that is not scheduled or background (trg_, workflow-event:) is unattended too, keyed by its session with a fixed label', async () => {
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      for (const id of ['trg_abc123', 'workflow-event:run-1']) {
        session.managedTurnOrigin.identityTurnId = id;
        expect((await ask({ provider: 'bytedcli' })).status).toBe(409);
      }
      expect(dm).not.toHaveBeenCalled();
      for (const id of ['trg_abc123', 'workflow-event:run-1', 'trg_other']) {
        session.managedTurnOrigin.identityTurnId = id;
        expect(await (await ask({ provider: 'bytedcli', unattended: true })).json()).toMatchObject({ status: 'delivered' });
      }
      expect(dm).toHaveBeenCalledTimes(1);
      expect(dm.mock.calls[0][2]).toContain('无人值守的运行');
      expect(dm.mock.calls[0][2]).not.toContain('trg_');
    });

    it('--provider lark-cli needs --unattended in an unattended turn, and the platform in an attended one', async () => {
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      vi.mocked(botRegistry.getBot).mockReturnValue({ config: {
        larkAppId: 'cli_test', larkAppSecret: 'test-secret',
        triggerUserAuth: { enabled: true, tools: ['lark-cli'], capabilities: ['lark-user'] },
      } } as any);
      expect((await ask({ provider: 'lark-cli' })).status).toBe(409);
      expect(await (await ask({ provider: 'lark-cli', unattended: true })).json()).toMatchObject({ ok: true, status: 'delivered' });
      session.managedTurnOrigin.identityTurnId = undefined;
      expect((await ask({ provider: 'lark-cli', unattended: true })).status).toBe(400);
      expect(dm).toHaveBeenCalledTimes(1);
    });

    it('--unattended Meego whose private notice could not be sent reports undelivered', async () => {
      (await import('../src/core/capability-authorization.js')).__resetUnattendedNoticesForTest();
      vi.spyOn(larkClient, 'sendUserMessage').mockRejectedValue(new Error('down'));
      session.chatType = 'p2p';
      const body = await (await ask({ unattended: true })).json() as { message: string };
      expect(body).toMatchObject({ ok: true, status: 'undelivered' });
      expect(body.message).toContain('可用范围');
      expect(JSON.stringify(body)).not.toMatch(/https?:/);
    });

    it('--unattended: the DM fails, so the notice goes in a card only the person sees in the task chat', async () => {
      vi.spyOn(larkClient, 'sendUserMessage').mockRejectedValue(new Error('230013'));
      const ephemeral = vi.spyOn(larkClient, 'sendEphemeralCard').mockResolvedValue('om_private');
      const body = await (await ask({ unattended: true })).json();
      expect(body).toMatchObject({ ok: true, status: 'delivered', message: '' });
      expect(ephemeral).toHaveBeenCalledExactlyOnceWith('cli_test', 'oc_test', 'ou_sender', expect.stringContaining(MEEGO_URL));
    });

    it('--unattended: DM and card both fail: undelivered, and the agent is told the person cannot be reached privately', async () => {
      vi.spyOn(larkClient, 'sendUserMessage').mockRejectedValue(new Error('230013'));
      vi.spyOn(larkClient, 'sendEphemeralCard').mockRejectedValue(new Error('topic group'));
      const body = await (await ask({ unattended: true })).json() as { message: string };
      expect(body).toMatchObject({ ok: true, status: 'undelivered' });
      expect(body.message).toContain('可用范围');
      expect(JSON.stringify(body)).not.toMatch(/https?:/);
    });

    it('--unattended Meego with the login already there: nothing sent', async () => {
      vi.spyOn(meegoAuth, 'requestMeegoLogin').mockResolvedValue({ state: 'ready' });
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      expect(await (await ask({ unattended: true })).json()).toMatchObject({ ok: true, status: 'ready' });
      expect(dm).not.toHaveBeenCalled();
    });
  });

  it('a native capability answers that this machine\'s own login is used, minting no link', async () => {
    const dm = vi.spyOn(larkClient, 'sendUserMessage');
    for (const [provider, capabilities] of [['meego', ['bytecloud']], ['bytedcli', ['meego']]] as const) {
      vi.mocked(botRegistry.getBot).mockReturnValue({ config: {
        larkAppId: 'cli_test', larkAppSecret: 'test-secret',
        triggerUserAuth: { enabled: true, tools: ['bytedcli'], capabilities },
      } } as any);
      const response = await ask({ provider });
      expect(response.status).toBe(409);
      const body = await response.json() as { status: string; error: string; message: string };
      expect(body).toMatchObject({ ok: false, status: 'refused', error: 'native_capability' });
      expect(body.message).toContain(provider === 'meego' ? 'Meego' : 'ByteCloud');
    }
    expect(meegoAuth.requestMeegoLogin).not.toHaveBeenCalled();
    expect(dm).not.toHaveBeenCalled();
    expect(replies).toEqual([]);
  });

  it('passes the Meego tenant through, and only a tenant bytedcli knows', async () => {
    vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
    expect((await ask({ tenant: 'dcar' })).status).toBe(200);
    expect(meegoAuth.requestMeegoLogin).toHaveBeenCalledExactlyOnceWith('ou_sender', 'dcar');
    expect((await ask({ tenant: 'other' })).status).toBe(400);
    expect((await ask({ provider: 'bytedcli', tenant: 'dcar' })).status).toBe(400);
    expect(meegoAuth.requestMeegoLogin).toHaveBeenCalledTimes(1);
  });

  it('needs a verified current actor and a valid provider', async () => {
    delete session.managedTurnOrigin.callerOpenId;
    expect((await ask()).status).toBe(403);
    session.managedTurnOrigin.callerOpenId = 'ou_sender';
    expect((await ask({ provider: 'lark' })).status).toBe(400);
    expect((await ask({ originCapability: 'cd'.repeat(32) })).status).toBe(403);
    expect(meegoAuth.requestMeegoLogin).not.toHaveBeenCalled();
  });
});
