import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { identityRefusalLines } from '../src/cli/identity-refusal-guidance.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as bots from '../src/bot-registry.js';
import * as identities from '../src/im/lark/identity-cache.js';
import * as tokens from '../src/utils/user-token.js';
import * as larkClient from '../src/im/lark/client.js';
import { parseTriggerUserAuthConfig } from '../src/services/trigger-user-auth.js';
import * as bytedcliAuth from '../src/services/bytedcli-auth.js';
import { __resetUnattendedNoticesForTest } from '../src/core/capability-authorization.js';
import { config } from '../src/config.js';
import { prepareLarkToolEnv, larkToolBindingPath, type LarkToolBinding } from '../src/core/lark-tool-binding.js';
import { fakeLarkHelpScript } from './helpers/lark-tool-help.js';
import { spawnTsEvalWithRepoImports, spawnTsScript } from './helpers/ts-runner.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { publishTurnCliIdentity } from '../src/core/turn-cli-identity.js';
import { currentGatewayCallerOpenId } from '../src/core/gateway-turn-caller.js';
import { buildDocCommentTurnInput } from '../src/core/doc-comment-prompt.js';
import { clearLarkToolDelegations } from '../src/core/lark-tool-delegation.js';
import { Client } from '@larksuiteoapi/node-sdk';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { __setPlatformCredentialDepsForTest } from '../src/core/platform-credential-source.js';
import { __resetPlatformAuthorizationRequestForTest } from '../src/core/platform-authorization-request.js';
import * as credentialRequestClient from '../src/platform/credential-request-client.js';
import { t } from '../src/i18n/index.js';
import * as schedulerModule from '../src/core/scheduler.js';
import * as eventDispatcher from '../src/im/lark/event-dispatcher.js';
import * as dispatchUserDelegation from '../src/core/dispatch-user-delegation.js';
import * as dispatchReportBinding from '../src/core/dispatch-report-binding.js';
import { logger } from '../src/utils/logger.js';
import { rememberExternalTriggerTurn } from '../src/core/turn-origin.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import type { TrustedCaller } from '../src/types.js';
import {
  createProtectedLoopbackProxyAttestation,
  PROTECTED_LOOPBACK_ATTESTATION_HEADER,
} from '../src/core/protected-loopback-attestation.js';

let dir: string, previousDataDir: string, ipc: IpcServerHandle | undefined, session: any, binding: LarkToolBinding;
const botToken = vi.fn<() => Promise<unknown>>();
const headlessId = 'hl_11111111-1111-4111-8111-111111111111';
function markHeadless() {
  session.chatId = `headless_${headlessId}`;
  session.session.chatId = session.chatId;
  session.session.headless = { id: headlessId, source: 'cli' };
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ipc-lark-tool-')); previousDataDir = config.session.dataDir; config.session.dataDir = dir;
  binding = prepareLarkToolEnv({ env: { PATH: '/usr/bin:/bin' }, dataDir: dir, sessionId: 'tool-session', appId: 'cli_bound' });
  session = {
    session: { sessionId: 'tool-session', status: 'active', replyTargets: { om_turn: { senderOpenId: 'ou_sender' } } },
    larkAppId: 'cli_bound', chatId: 'oc_chat', chatType: 'p2p', worker: { pid: process.pid, killed: false }, workerGeneration: 1,
    localProcessAttestation: { backendType: 'pty', workerGeneration: 1,
      cliPid: process.pid, cliProcStart: readProcessStartIdentity(process.pid) },
    managedTurnOrigin: { turnId: 'om_turn', capability: 'cap', callerOpenId: 'ou_sender',
      preexistingProcessIdentities: [`${process.pid}:${readProcessStartIdentity(process.pid)}`] },
  };
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 'tool-session' ? session : undefined);
  vi.spyOn(bots, 'getBot').mockReturnValue({ config: { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret' } } as any);
  botToken.mockReset().mockResolvedValue('bound-bot-token');
  vi.spyOn(bots, 'getBotClient').mockReturnValue({ tokenManager: { getTenantAccessToken: botToken } } as unknown as Client);
  vi.spyOn(identities, 'resolveVerifiedUserIdentity').mockResolvedValue({ openId: 'ou_sender', type: 'user' } as any);
  vi.spyOn(tokens, 'resolveUserToken').mockResolvedValue('bound-user-token');
  setIpcAuthSecret('host-test-key');
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});
afterEach(async () => {
  clearLarkToolDelegations(dir, 'tool-session');
  await ipc?.close(); ipc = undefined; config.session.dataDir = previousDataDir;
  setIpcAuthSecret(null); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true });
});
async function request(mode: string, accessKey = binding.accessKey) {
  return fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/lark-tool-identity`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': accessKey },
    body: JSON.stringify({ mode }),
  });
}
function useRunAsTurn(allowedUsers: string[]) {
  const botConfig = {
    larkAppId: 'cli_bound', larkAppSecret: 'bound-secret', ownerOpenId: 'ou_owner',
    // Deliberately omit larkToolBinding: undefined enables the bound route by default.
    triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli'] }),
  };
  vi.mocked(bots.getBot).mockImplementation(() => ({
    config: botConfig, resolvedAllowedUsers: allowedUsers, resolvedBlockedUsers: [],
  }) as any);
  session.managedTurnOrigin.turnId = 'trg_runas_bound_test';
  vi.spyOn(larkClient, 'resolveUnionIdFromOpenId').mockResolvedValue('on_sender');
  return botConfig;
}
describe('session application identity route', () => {
  it.each(['bot', 'user'])('revokes credential export if protection is enabled during %s resolution', async mode => {
    const resolve = async () => {
      session.session.protectedResults = true;
      return 'late-protected-token';
    };
    if (mode === 'bot') botToken.mockImplementation(resolve);
    else vi.mocked(tokens.resolveUserToken).mockImplementation(resolve);
    const response = await request(mode);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'protected_result_credential_export_denied' });
  });

  it.skipIf(process.platform !== 'linux')('accepts a signed original peer through the trusted loopback proxy and binds it to the live turn', async () => {
    const cliRoot: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    try {
      if (!cliRoot.pid) throw new Error('fixture cli root did not start');
      const cliProcStart = readProcessStartIdentity(cliRoot.pid);
      session.localProcessAttestation = {
        backendType: 'pty', workerGeneration: 1, cliPid: cliRoot.pid, cliProcStart,
      };
      session.managedTurnOrigin.preexistingProcessIdentities = [`${cliRoot.pid}:${cliProcStart}`];
      session.protectedLoopbackProxyAttestation = {
        secret: 'ab'.repeat(32), workerGeneration: 1,
      };
      const path = '/api/sessions/tool-session/lark-tool-identity';
      const body = Buffer.from(JSON.stringify({ mode: 'user' }));
      const headers = {
        'content-type': 'application/json',
        'x-botmux-lark-session': binding.accessKey,
      };
      const attestation = createProtectedLoopbackProxyAttestation(
        session.protectedLoopbackProxyAttestation.secret,
        {
          sessionId: 'tool-session', serviceId: 'lark-tool-identity', workerGeneration: 1,
          turnId: 'om_turn', peer: { pid: cliRoot.pid, procStart: cliProcStart },
          method: 'POST', path, headers, body,
        },
      );

      const direct = await request('user');
      expect(direct.status).toBe(403);
      const proxied = await fetch(`http://127.0.0.1:${ipc!.port}${path}`, {
        method: 'POST',
        headers: { ...headers, [PROTECTED_LOOPBACK_ATTESTATION_HEADER]: attestation },
        body,
      });
      expect(proxied.status).toBe(200);
      expect(await proxied.json()).toMatchObject({ mode: 'user', credential: 'bound-user-token' });

      session.managedTurnOrigin.turnId = 'om_later';
      const stale = await fetch(`http://127.0.0.1:${ipc!.port}${path}`, {
        method: 'POST',
        headers: { ...headers, [PROTECTED_LOOPBACK_ATTESTATION_HEADER]: attestation },
        body,
      });
      expect(stale.status).toBe(403);
      expect(await stale.json()).toMatchObject({ error: 'current_execution_unverified' });
    } finally {
      cliRoot.kill('SIGKILL');
    }
  });

  async function delegate(options: { tools?: ('lark-cli' | 'bytedcli')[]; denialReason?: 'target_access_denied' | 'target_validation_unavailable'; targetOpenId?: string; turnId?: string; recheck?: () => string | undefined } = {}) {
    session.managedTurnOrigin.callerOpenId = 'ou_dispatch_bot';
    const botConfig = { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret',
      larkToolBinding: true,
      triggerUserAuth: { enabled: true, tools: ['lark-cli'] } } as any;
    vi.mocked(bots.getBot).mockReturnValue({ config: botConfig } as any);
    await publishTurnCliIdentity({ botConfig, sessionDataDir: dir, sessionId: 'tool-session',
      senderOpenId: 'ou_dispatch_bot', turnId: options.turnId ?? 'om_turn', delegatedIdentity: {
        credentialOpenId: 'ou_source_human', targetOpenId: options.targetOpenId ?? 'ou_target_human', unionId: 'on_source_human',
        tools: options.tools ?? ['lark-cli'], dispatchRoot: 'om_dispatch_root', denialReason: options.denialReason,
        ...(options.recheck ? { workflowHandoff: true as const, recheck: options.recheck } : {}),
      } });
  }
  it('re-checks a workflow handoff delegation on every use; once it stops holding it is refused for good', async () => {
    let refusal: string | undefined;
    await delegate({ recheck: () => refusal });
    vi.mocked(tokens.resolveUserToken).mockResolvedValue('target-grant');
    expect(await (await request('user')).json()).toMatchObject({ ok: true, credential: 'target-grant' });
    refusal = 'attempt_inactive'; // e.g. the run was cancelled and the stop never arrived
    const refused = await request('user');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ ok: false, error: expect.stringMatching(/delegation_inactive.*--dispatch-root om_dispatch_root/) });
    expect(tokens.resolveUserToken).toHaveBeenCalledTimes(1);
    refusal = undefined;
    expect((await request('user')).status).toBe(403);
  });
  it('an inactive workflow delegation cannot start an authorization for its human either', async () => {
    await delegate({ recheck: () => 'handoff_revoked' });
    const requestAuth = vi.spyOn(tokens, 'requestUserAuthorization');
    const response = await fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/auth-request`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: JSON.stringify({ scopes: ['im:chat:read'] }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: 'current_actor_unverified' });
    expect(requestAuth).not.toHaveBeenCalled();
  });
  it('serves a refusal instead of the published bytedcli identity once a workflow delegation stops holding', async () => {
    const { writeSessionIdentity } = await import('../src/core/cli-identity.js');
    const { rememberLarkToolDelegation } = await import('../src/core/lark-tool-delegation.js');
    vi.spyOn(workerPool, 'identityStorageModelForDaemonSession').mockReturnValue('proven');
    session.reportedIdentityModel = { model: 'proven' };
    writeSessionIdentity(dir, 'tool-session', { tool: 'bytedcli', cloudJwt: 'alice-cloud', turnId: 'om_turn' } as any, 'proven');
    let refusal: string | undefined;
    rememberLarkToolDelegation(dir, 'tool-session', 'om_turn', {
      credentialOpenId: 'ou_source_human', targetOpenId: 'ou_target_human', unionId: 'on_source_human',
      tools: ['bytedcli'], dispatchRoot: 'om_handoff', workflowHandoff: true, recheck: () => refusal,
    });
    const identity = async () => (await fetch(`http://127.0.0.1:${ipc!.port}/api/current-execution-identity`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'tool-session', tool: 'bytedcli' }),
    })).json();
    expect(await identity()).toMatchObject({ status: 'verified', env: expect.stringContaining('alice-cloud') });
    refusal = 'handoff_revoked';
    const after = await identity();
    // Capture the primitive BEFORE the asymmetric-matcher assertion: Bun's
    // toMatchObject replaces the matched nested field on the RECEIVED object
    // with the matcher instance (measured on Bun 1.4), so reading after.env
    // after the expectation hands back an ExpectStringContaining, not a string.
    const afterEnv: string = after.env;
    expect(after).toMatchObject({ status: 'verified', env: expect.stringContaining('no longer active') });
    expect(afterEnv).not.toContain('alice-cloud');
    expect(afterEnv).toContain('--dispatch-root om_handoff');
  });
  it('uses the verified delegated human’s target-app authorization, never the dispatch bot or source token', async () => {
    await delegate();
    vi.mocked(tokens.resolveUserToken).mockImplementation(async (app, _secret, _brand, person) =>
      app === 'cli_bound' && person === 'ou_target_human' ? 'target-grant' : 'WRONG_GRANT');
    const response = await request('user');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ appId: 'cli_bound', mode: 'user', credential: 'target-grant' });
    expect(tokens.resolveUserToken).toHaveBeenCalledExactlyOnceWith('cli_bound', 'bound-secret', 'feishu', 'ou_target_human');
    expect(identities.resolveVerifiedUserIdentity).not.toHaveBeenCalled();
  });
  it.each([
    { tools: ['bytedcli'] as ('lark-cli' | 'bytedcli')[] },
    { denialReason: 'target_access_denied' as const },
    { denialReason: 'target_validation_unavailable' as const },
  ])('does not widen a denied delegation: %j', async options => {
    await delegate(options);
    expect(await (await request('user')).json()).toMatchObject({ ok: false, error: expect.stringContaining('report --dispatch-root om_dispatch_root') });
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
  });
  it('rechecks the delegated user token and reports missing authorization to the source task', async () => {
    await delegate();
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    const response = await request('user');
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining('original user') });
    expect(response.status).toBe(403);
  });
  it('refuses BOTMUX_AS in a delegated run, on the identity route and on the authorization requests', async () => {
    await delegate();
    const post = (path: string, body: object) => fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey }, body: JSON.stringify(body),
    });
    for (const [path, body] of [['lark-tool-identity', { mode: 'user', as: 'ou_x' }], ['auth-request', { scopes: ['im:chat:read'], as: 'ou_x' }], ['auth-status', { requestId: 'r', as: 'ou_x' }]] as const) {
      const response = await post(path, body);
      expect(response.status, path).toBe(403);
      const answer = await response.json() as { error: string };
      if (path === 'lark-tool-identity') expect(answer.error).toContain('BOTMUX_AS cannot name anyone in this turn');
      else expect(answer).toEqual({ ok: false, error: 'as_unavailable' });
    }
  });
  it('authorizes the delegated human through the bound tool and retries with the target app token', async () => {
    await delegate();
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    expect(await (await request('user')).json()).toMatchObject({
      ok: false, error: expect.stringContaining('botmux auth request'),
    });
    const poll = vi.fn().mockImplementation(async () => {
      vi.mocked(tokens.resolveUserToken).mockResolvedValue('target-app-grant');
      return { status: 'ready', token: 'target-app-grant' };
    });
    vi.spyOn(tokens, 'requestUserAuthorization').mockResolvedValue({
      authUrl: 'https://accounts.feishu.cn/oauth/device?user_code=delegated',
      scopes: ['offline_access', 'im:chat:read'], expiresIn: 600, poll,
    });
    const auth = (action: string, body: object) => fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: JSON.stringify(body),
    });
    const grant = await (await auth('auth-request', { scopes: ['im:chat:read'] })).json();
    expect(grant).toMatchObject({ ok: true, authUrl: expect.stringContaining('accounts.feishu.cn') });
    expect(tokens.requestUserAuthorization).toHaveBeenCalledExactlyOnceWith(
      'cli_bound', 'bound-secret', 'feishu', ['im:chat:read'], 'ou_target_human', expect.any(Function),
    );
    expect(await (await auth('auth-status', { requestId: grant.requestId })).json()).toEqual({ ok: true, status: 'ready' });
    expect(await (await request('user')).json()).toMatchObject({ appId: 'cli_bound', mode: 'user', credential: 'target-app-grant' });
    expect(tokens.resolveUserToken).toHaveBeenLastCalledWith('cli_bound', 'bound-secret', 'feishu', 'ou_target_human');
  });
  it('refuses when target permission is withdrawn while resolving the delegated token', async () => {
    await delegate();
    vi.mocked(tokens.resolveUserToken).mockImplementation(async () => {
      await delegate({ denialReason: 'target_access_denied' });
      return 'late-token';
    });
    const response = await request('user');
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('late-token');
  });
  it('publishes delegation before a new worker creates its application binding', async () => {
    rmSync(larkToolBindingPath(dir, 'tool-session'));
    await delegate();
    binding = prepareLarkToolEnv({ env: { PATH: '/usr/bin:/bin' }, dataDir: dir, sessionId: 'tool-session', appId: 'cli_bound' });
    expect((await request('user')).status).toBe(200);
    expect(tokens.resolveUserToken).toHaveBeenLastCalledWith('cli_bound', 'bound-secret', 'feishu', 'ou_target_human');
  });
  it('keeps queued turns separate and never inherits delegation in a later direct turn', async () => {
    await delegate();
    await delegate({ targetOpenId: 'ou_later', turnId: 'om_queued' });
    await request('user');
    expect(tokens.resolveUserToken).toHaveBeenLastCalledWith('cli_bound', 'bound-secret', 'feishu', 'ou_target_human');
    session.managedTurnOrigin = { ...session.managedTurnOrigin, turnId: 'om_direct', capability: 'cap', callerOpenId: 'ou_sender' };
    await request('user');
    expect(tokens.resolveUserToken).toHaveBeenLastCalledWith('cli_bound', 'bound-secret', 'feishu', 'ou_sender');
  });
  it('withholds the bot token from a session frozen with sandboxWithholdBotSecret, keeping user mode', async () => {
    session.session.sandboxWithholdBotSecret = true;
    try {
      const bot = await request('bot');
      expect(bot.status).toBe(403);
      expect(await bot.json()).toEqual({ ok: false, error: 'lark_tool_bot_identity_withheld' });
      expect(bots.getBotClient).not.toHaveBeenCalled();
      const user = await request('user');
      expect(await user.json()).toMatchObject({ ok: true, mode: 'user', credentialType: 'user_access_token' });
    } finally { delete session.session.sandboxWithholdBotSecret; }
  });
  it('withholds the bot token from a session that predates assistant mode once the live bot enables it', async () => {
    vi.mocked(bots.getBot).mockReturnValue({ config: { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret', assistantMode: true } } as any);
    try {
      const bot = await request('bot');
      expect(bot.status).toBe(403);
      expect(await bot.json()).toEqual({ ok: false, error: 'lark_tool_bot_identity_withheld' });
      expect(bots.getBotClient).not.toHaveBeenCalled();
    } finally {
      vi.mocked(bots.getBot).mockReturnValue({ config: { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret' } } as any);
    }
  });
  it('rechecks live assistant withholding after a slow tenant-token lookup', async () => {
    const liveConfig: any = { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret' };
    vi.mocked(bots.getBot).mockImplementation(() => ({ config: liveConfig }) as any);
    let releaseToken!: (value: string) => void;
    botToken.mockImplementation(() => new Promise<string>(resolve => { releaseToken = resolve; }));
    const pending = request('bot');
    await vi.waitFor(() => expect(botToken).toHaveBeenCalledOnce());
    liveConfig.assistantMode = true;
    // Even a legacy session whose worker has already stopped must not receive a
    // late credential while its active row is still retiring.
    session.worker = null;
    releaseToken('late-bot-token');
    const response = await pending;
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'lark_tool_bot_identity_withheld' });
  });
  it('binds bot and current user without requiring triggerUserAuth configuration', async () => {
    const bot = await request('bot'); const raw = await bot.text();
    expect(bot.status).toBe(200);
    expect(JSON.parse(raw)).toEqual({ ok: true, appId: 'cli_bound', mode: 'bot', credentialType: 'tenant_access_token', credential: 'bound-bot-token' });
    expect(bots.getBotClient).toHaveBeenCalledExactlyOnceWith('cli_bound');
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
    const user = await request('user');
    expect(await user.json()).toEqual({ ok: true, appId: 'cli_bound', mode: 'user', credentialType: 'user_access_token', credential: 'bound-user-token' });
    expect(tokens.resolveUserToken).toHaveBeenCalledWith('cli_bound', 'bound-secret', 'feishu', 'ou_sender');
  });
  it.each(['linux', 'darwin'] as const)(
    'serves an ownerless schedule child through its exact-turn tool actor only on %s', async platform => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const turnId = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
    session.managedTurnOrigin = {
      ...session.managedTurnOrigin,
      turnId,
      preexistingProcessIdentities: [`${process.pid}:${readProcessStartIdentity(process.pid)}`],
    };
    delete session.managedTurnOrigin.callerOpenId;
    session.scheduledTurnCallers = undefined;
    session.scheduledToolActors = new Map([[turnId, {
      openId: 'ou_sender', unionId: 'on_sender',
    }]]);

    const response = await request('user');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      appId: 'cli_bound', mode: 'user', credential: 'bound-user-token',
    });
    expect(session.managedTurnOrigin.callerOpenId).toBeUndefined();
    expect(session.scheduledTurnCallers).toBeUndefined();
  });
  it.each(['linux', 'darwin'] as const)(
    'rejects when an ownerless child tool actor changes during credential resolution on %s', async platform => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const turnId = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
    session.managedTurnOrigin = {
      ...session.managedTurnOrigin,
      turnId,
      preexistingProcessIdentities: [`${process.pid}:${readProcessStartIdentity(process.pid)}`],
    };
    delete session.managedTurnOrigin.callerOpenId;
    session.scheduledToolActors = new Map([[turnId, {
      openId: 'ou_sender', unionId: 'on_sender',
    }]]);
    vi.mocked(tokens.resolveUserToken).mockImplementation(async () => {
      session.scheduledToolActors = undefined;
      return 'late-token';
    });

    const response = await request('user');

    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('late-token');
  });
  it('uses each document turn author’s own grant without a normal message reply target', async () => {
    session.session = {
      sessionId: 'tool-session', status: 'active', ownerOpenId: 'ou_owner',
      docCommentTargets: {
        comment_a: { fileToken: 'file', fileType: 'docx', commentId: 'thread', turnId: 'comment_a', replyToOpenId: 'ou_author_a' },
        comment_b: { fileToken: 'file', fileType: 'docx', commentId: 'thread', turnId: 'comment_b', replyToOpenId: 'ou_author_b' },
      },
    };
    vi.mocked(identities.resolveVerifiedUserIdentity).mockImplementation(async (_app, person) => ({ openId: person, type: 'user' } as any));
    vi.mocked(tokens.resolveUserToken).mockImplementation(async (_app, _secret, _brand, person) => `grant:${person}`);
    for (const [turnId, author] of [['comment_a', 'ou_author_a'], ['comment_b', 'ou_author_b'], ['comment_a', 'ou_author_a']]) {
      const { cliInput } = buildDocCommentTurnInput({ ds: session,
        promptInput: { fileToken: 'file', fileType: 'docx', question: 'Read the author profile', author },
        botCliId: 'codex', sender: { openId: author, type: 'user' }, mode: 'live', turnId });
      session.managedTurnOrigin = { ...session.managedTurnOrigin, turnId, capability: 'cap',
        identityTurnId: turnId, trustedCaller: cliInput.trustedCaller ?? null,
        callerOpenId: cliInput.trustedCaller?.requestUserOpenId };
      expect(currentGatewayCallerOpenId(session, turnId)).toBe(author);
      const response = await request('user');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ appId: 'cli_bound', credential: `grant:${author}` });
      expect(tokens.resolveUserToken).toHaveBeenLastCalledWith('cli_bound', 'bound-secret', 'feishu', author);
    }
  });
  it('does not resolve a comment author’s grant when the identity is not a verified user', async () => {
    session.session.replyTargets = undefined;
    session.session.docCommentTargets = {
      comment_a: { fileToken: 'file', fileType: 'docx', commentId: 'thread', turnId: 'comment_a', replyToOpenId: 'ou_bot' },
    };
    session.managedTurnOrigin = { ...session.managedTurnOrigin, turnId: 'comment_a', capability: 'cap', callerOpenId: currentGatewayCallerOpenId(session, 'comment_a') };
    vi.spyOn(identities, 'getIdentity').mockReturnValue(undefined);
    vi.mocked(identities.resolveVerifiedUserIdentity).mockResolvedValue({ openId: 'ou_bot', type: 'bot' } as any);
    expect((await request('user')).status).toBe(403);
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
  });
  it('never substitutes the document session owner for an unknown comment author', async () => {
    session.session.replyTargets = undefined;
    session.session.ownerOpenId = 'ou_owner';
    session.session.docCommentTargets = {
      comment_a: { fileToken: 'file', fileType: 'docx', commentId: 'thread', turnId: 'comment_a' },
    };
    session.managedTurnOrigin = { ...session.managedTurnOrigin, turnId: 'comment_a', capability: 'cap', callerOpenId: currentGatewayCallerOpenId(session, 'comment_a') };
    expect((await request('user')).status).toBe(403);
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
  });
  it('rejects another session key and an application mismatch', async () => {
    expect((await request('bot', '00'.repeat(32))).status).toBe(403);
    session.larkAppId = 'cli_other';
    expect((await request('bot')).status).toBe(403);
    expect(botToken).not.toHaveBeenCalled();
  });
  it('gives a bound headless runner only its own bot token', async () => {
    markHeadless();
    session.managedTurnOrigin = undefined;
    const response = await request('bot');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ appId: 'cli_bound', mode: 'bot',
      credentialType: 'tenant_access_token', credential: 'bound-bot-token' });
    expect((await request('user')).status).toBe(403);
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
    // Even a stale human origin cannot turn a headless runner into a user session.
    session.managedTurnOrigin = { turnId: 'om_turn', capability: 'cap', callerOpenId: 'ou_sender' };
    expect((await request('user')).status).toBe(403);
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
  });
  it.each(['http_async_runner', 'http_wait_runner'])('keeps other virtual chats without tool credentials (%s)', async chatId => {
    session.chatId = chatId;
    expect((await request('bot')).status).toBe(403);
    expect(botToken).not.toHaveBeenCalled();
  });
  it('keeps API-only bots without Lark credentials even in a headless chat', async () => {
    markHeadless();
    vi.mocked(bots.getBot).mockReturnValue({ config: { larkAppId: 'cli_bound', apiOnly: true } } as any);
    expect((await request('bot')).status).toBe(403);
    expect(botToken).not.toHaveBeenCalled();
  });
  it.each(['headless_forged-http-chat', `headless_${headlessId}`])('refuses forged webhook headless addresses without durable provenance (%s)', async chatId => {
    session.chatId = chatId;
    expect((await request('bot')).status).toBe(403);
    expect(botToken).not.toHaveBeenCalled();
  });
  it('refuses mismatched headless provenance', async () => {
    markHeadless();
    session.session.headless.id = 'hl_22222222-2222-4222-8222-222222222222';
    expect((await request('bot')).status).toBe(403);
    expect(botToken).not.toHaveBeenCalled();
  });
  it('refuses a headless token if the bot configuration cannot be verified', async () => {
    markHeadless();
    vi.mocked(bots.getBot).mockImplementation(() => { throw new Error('unknown bot'); });
    expect((await request('bot')).status).toBe(403);
    expect(botToken).not.toHaveBeenCalled();
  });
  it('rejects unbound headless callers and rechecks the app during token resolution', async () => {
    markHeadless();
    expect((await request('bot', '00'.repeat(32))).status).toBe(403);
    expect(botToken).not.toHaveBeenCalled();
    botToken.mockImplementation(async () => { session.chatId = 'http_async_runner'; return 'late-token'; });
    const response = await request('bot');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('late-token');
  });
  it.each(['reject', 'empty'] as const)('refuses unavailable bot tokens without returning the app secret (%s)', async failure => {
    if (failure === 'reject') botToken.mockRejectedValue(new Error('private provider details'));
    else botToken.mockResolvedValue('');
    const response = await request('bot');
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: 'lark_tool_bot_token_unavailable' });
  });
  it('refuses a bot token if the session closes during resolution', async () => {
    botToken.mockImplementation(async () => { session.session.status = 'closed'; return 'late-token'; });
    const response = await request('bot');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('late-token');
  });
  it('uses the app SDK cache until expiry and then returns a refreshed token', async () => {
    let clock = Date.now();
    const cache = new Map<string, { value: string; expires: number }>();
    const post = vi.fn().mockResolvedValueOnce({ tenant_access_token: 'first-token', expire: 7200 })
      .mockResolvedValueOnce({ tenant_access_token: 'refreshed-token', expire: 7200 });
    const client = new Client({ appId: 'cli_bound', appSecret: 'bound-secret', domain: 'https://open.larksuite.com',
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
      httpInstance: { post } as unknown as Client['httpInstance'],
      cache: {
        get: (key, options) => {
          const item = cache.get(`${options?.namespace}:${String(key)}`);
          return item && item.expires > clock ? item.value : undefined;
        },
        set: (key, value, expires, options) => { cache.set(`${options?.namespace}:${String(key)}`, { value, expires }); return true; },
      },
    });
    vi.mocked(bots.getBotClient).mockReturnValue(client);
    expect(await (await request('bot')).json()).toMatchObject({ credential: 'first-token' });
    expect(await (await request('bot')).json()).toMatchObject({ credential: 'first-token' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: 'cli_bound', app_secret: 'bound-secret' });
    clock += 7200 * 1000;
    expect(await (await request('bot')).json()).toMatchObject({ credential: 'refreshed-token' });
    expect(post).toHaveBeenCalledTimes(2);
  });
  it('uses the same user path on macOS without process attestation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const response = await request('user');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ appId: 'cli_bound', mode: 'user', credential: 'bound-user-token' });
  });
  it('authorizes the same app on macOS through the installed session entry', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(identities, 'getIdentity').mockReturnValue({ openId: 'ou_sender', type: 'user', source: 'sender' } as any);
    const poll = vi.fn(async () => ({ status: 'ready' as const, token: 'authorized-token' }));
    vi.spyOn(tokens, 'requestUserAuthorization').mockResolvedValue({ authUrl: 'https://example.com/app-authorization',
      scopes: ['sheets:spreadsheet:read'], expiresIn: 300, poll });
    const post = (action: string, body: object) => fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey }, body: JSON.stringify(body),
    });
    const response = await post('auth-request', { scopes: ['sheets:spreadsheet:read'] });
    expect(response.status).toBe(200);
    const request = await response.json() as { requestId: string };
    expect(tokens.requestUserAuthorization).toHaveBeenCalledWith('cli_bound', 'bound-secret', 'feishu',
      ['sheets:spreadsheet:read'], 'ou_sender', expect.any(Function));
    const ready = await post('auth-status', { requestId: request.requestId });
    expect(await ready.json()).toEqual({ ok: true, status: 'ready' });
  });
  it('requires the current user’s grant and never uses the machine account', async () => {
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    expect(await (await request('user')).json()).toMatchObject({ ok: false, error: expect.stringContaining('cli_bound') });
    session.managedTurnOrigin.callerOpenId = undefined;
    vi.mocked(tokens.resolveUserToken).mockClear();
    expect((await request('user')).status).toBe(403);
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
    expect((await request('bot')).status).toBe(200);
  });
  it('serves an allowed runAs person through the default-enabled bound route', async () => {
    useRunAsTurn(['ou_sender']);
    const response = await request('user');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'user', credential: 'bound-user-token' });
    expect(larkClient.resolveUnionIdFromOpenId).toHaveBeenCalledExactlyOnceWith('cli_bound', 'ou_sender');
  });
  it.each(['om_original', 'trg_runas_original'])('refuses an adopted runAs envelope carrying inherited identity %s', async identityTurnId => {
    useRunAsTurn(['ou_sender']);
    session.managedTurnOrigin.identityTurnId = identityTurnId;
    vi.mocked(tokens.resolveUserToken).mockClear();
    const response = await request('user');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('bound-user-token');
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
  });
  it('refuses a runAs person whose operate access was revoked before the credential lookup', async () => {
    useRunAsTurn([]);
    vi.mocked(tokens.resolveUserToken).mockClear();
    const response = await request('user');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('bound-user-token');
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
  });
  it('refuses a runAs person whose operate access is revoked during the credential lookup', async () => {
    const allowed = ['ou_sender'];
    useRunAsTurn(allowed);
    vi.mocked(tokens.resolveUserToken).mockImplementation(async () => {
      allowed.splice(0);
      return 'late-runas-token';
    });
    const response = await request('user');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('late-runas-token');
  });
  it('refuses a runAs credential when lark-cli capability is disabled during the lookup', async () => {
    const botConfig = useRunAsTurn(['ou_sender']);
    vi.mocked(tokens.resolveUserToken).mockImplementation(async () => {
      botConfig.triggerUserAuth = parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'] });
      return 'late-lark-token';
    });
    const response = await request('user');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('late-lark-token');
  });
  it('does not add the runAs contact/allowlist fence to owner actors', async () => {
    const botConfig = useRunAsTurn([]);
    botConfig.triggerUserAuth.allowOwnerActor = true;
    session.managedTurnOrigin.turnId = 'trg_owner_bound_test';
    vi.mocked(larkClient.resolveUnionIdFromOpenId).mockClear();
    const response = await request('user');
    expect(response.status).toBe(200);
    expect(larkClient.resolveUnionIdFromOpenId).not.toHaveBeenCalled();
  });

  it('does not return a credential when the user resolver crosses a turn boundary', async () => {
    vi.mocked(tokens.resolveUserToken).mockImplementation(async () => { session.managedTurnOrigin.turnId = 'om_later'; return 'wrong-turn-token'; });
    const response = await request('user');
    expect(response.status).toBe(409); expect(await response.text()).not.toContain('wrong-turn-token');
  });
  it('does not return a user credential when the session loses chat transport during resolution', async () => {
    vi.mocked(tokens.resolveUserToken).mockImplementation(async () => {
      markHeadless();
      return 'late-user-token';
    });
    const response = await request('user');
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('late-user-token');
  });
  it.each([
    ['application', () => { session.larkAppId = 'cli_other'; }],
    ['chat', () => { session.chatId = 'oc_other'; }],
    ['stored chat', () => { session.session.chatId = 'oc_other'; }],
    ['session', () => { session.session.sessionId = 'other-session'; }],
    ['headless metadata', () => { session.session.headless = { id: headlessId, source: 'cli' }; }],
    ['disabled transport', () => {
      vi.mocked(bots.getBot).mockReturnValue({ config: {
        larkAppId: 'cli_bound', larkAppSecret: 'bound-secret', apiOnly: true,
      } } as any);
    }],
    ['disabled binding', () => {
      vi.mocked(bots.getBot).mockReturnValue({ config: {
        larkAppId: 'cli_bound', larkAppSecret: 'bound-secret', larkToolBinding: false,
      } } as any);
    }],
    ['missing configuration', () => {
      vi.mocked(bots.getBot).mockImplementation(() => { throw new Error('bot removed'); });
    }],
  ] as const)('does not export a user credential after the request target changes: %s', async (_name, change) => {
    vi.mocked(tokens.resolveUserToken).mockImplementation(async () => {
      change();
      return 'late-user-token';
    });
    const response = await request('user');
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).not.toHaveProperty('credential');
    expect(JSON.stringify(body)).not.toContain('late-user-token');
  });
  it.skipIf(process.platform !== 'linux')('allows a callerless scheduled execution with a scoped delegated user', async () => {
    await delegate();
    delete session.managedTurnOrigin.callerOpenId;
    const response = await request('user');
    expect(response.status).toBe(200);
    expect(tokens.resolveUserToken).toHaveBeenLastCalledWith('cli_bound', 'bound-secret', 'feishu', 'ou_target_human');
  });
  it.skipIf(process.platform !== 'linux').each(['generation', 'attempt', 'capability', 'identity'])(
    'withholds a token when the execution changes during resolution (%s)', async change => {
      vi.mocked(tokens.resolveUserToken).mockImplementation(async () => {
        if (change === 'generation') session.workerGeneration++;
        if (change === 'attempt') session.managedTurnOrigin.dispatchAttempt = 2;
        if (change === 'capability') session.managedTurnOrigin.capability = 'next-capability';
        if (change === 'identity') session.managedTurnOrigin.identityTurnId = 'other-identity';
        return 'late-token';
      });
      const response = await request('user');
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain('late-token');
    },
  );
  it.skipIf(process.platform !== 'linux')('rejects a new tool child of an old shell after another user takes over', async () => {
    const url = `http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/lark-tool-identity`;
    const source = `const response = await fetch(${JSON.stringify(url)}, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': ${JSON.stringify(binding.accessKey)} },
      body: JSON.stringify({ mode: 'user' }) });
      console.log(JSON.stringify({ status: response.status, body: await response.json() }));`;
    const shell = spawnTsEvalWithRepoImports(`
      import { spawnTsEval } from './test/helpers/ts-runner.js';
      process.once('message', () => {
        const tool = spawnTsEval(${JSON.stringify(source)}, { stdio: ['ignore', 'inherit', 'inherit'] });
        tool.once('close', code => process.exit(code ?? 1));
      });
      process.send('ready');
    `, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    shell.stdout!.on('data', data => { output += data; });
    try {
      await new Promise<void>((resolve, reject) => { shell.once('message', () => resolve()); shell.once('error', reject); });
      session.managedTurnOrigin = { ...session.managedTurnOrigin, turnId: 'om_new', callerOpenId: 'ou_new',
        capability: 'new-capability', preexistingProcessIdentities: [
          ...session.managedTurnOrigin.preexistingProcessIdentities,
          `${shell.pid}:${readProcessStartIdentity(shell.pid!)}`,
        ] };
      const finished = new Promise<number | null>(resolve => shell.once('close', resolve));
      shell.send('run');
      expect(await finished).toBe(0);
      expect(JSON.parse(output)).toEqual({ status: 403, body: { ok: false, error: 'current_execution_unverified' } });
      expect(tokens.resolveUserToken).not.toHaveBeenCalled();
    } finally { shell.kill(); }
  });
  it.each([false, true])('runs the real tool process with only the selected application credentials (headless=%s)', async headless => {
    if (headless) {
      markHeadless();
      session.managedTurnOrigin = undefined;
    }
    const real = join(dir, 'real-lark');
    writeFileSync(real, '#!/usr/bin/env node\n' + fakeLarkHelpScript() + 'process.stdout.write([process.env.LARKSUITE_CLI_APP_ID,process.env.LARKSUITE_CLI_APP_SECRET,process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN,process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN,process.argv.slice(2).join(" ")].map(x=>x||"").join("|"));\n'); chmodSync(real, 0o755);
    binding.realBinary = real; writeFileSync(larkToolBindingPath(dir, 'tool-session'), JSON.stringify(binding), { mode: 0o600 });
    const run = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawnTsScript(join(process.cwd(), 'src/lark-tool-runner.ts'), ['--binding', larkToolBindingPath(dir, 'tool-session'), '--', ...args], {
        env: { ...process.env, BOTMUX_DAEMON_IPC_PORT: String(ipc!.port), LARKSUITE_CLI_APP_ID: 'cli_wrong', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'wrong-user' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = ''; child.stdout!.on('data', b => out += b); child.stderr!.on('data', b => err += b);
      child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
    });
    const bot = await run(['docs', '+fetch']); expect(bot.code, bot.err).toBe(0);
    expect(bot.out).toBe('cli_bound||bound-bot-token||docs +fetch --as bot');
    const user = await run(['docs', '+fetch', '--as=user']);
    if (headless) {
      expect(user.code).toBe(77);
      expect(user.out).toBe('');
      expect(user.err).toContain('lark_tool_user_transport_required');
      expect(tokens.resolveUserToken).not.toHaveBeenCalled();
    } else {
      expect(user.code, user.err).toBe(0);
      expect(user.out).toBe('cli_bound|||bound-user-token|docs +fetch --as user');
    }
    const passthrough = await run(['docs', '+fetch', '--profile=cli_other']); expect(passthrough.code, passthrough.err).toBe(0);
    expect(passthrough.out).toBe('cli_wrong|||wrong-user|docs +fetch --profile=cli_other');
    // A protected session cannot export either managed or profile credentials.
    session.session.protectedResults = true;
    const grants = botToken.mock.calls.length;
    const userGrants = vi.mocked(tokens.resolveUserToken).mock.calls.length;
    for (const args of [['docs', '+fetch'], ['docs', '+fetch', '--as=user'], ['docs', '+fetch', '--profile=cli_other']]) {
      const denied = await run(args);
      expect(denied.code, denied.err).toBe(77);
      expect(denied.out).toBe('');
      expect(denied.err).toContain('protected_result_credential_export_denied');
    }
    expect(botToken.mock.calls.length).toBe(grants);
    expect(vi.mocked(tokens.resolveUserToken).mock.calls.length).toBe(userGrants);
  });
  it('BOTMUX_AS picks one speaker of a multi-speaker turn; the default stays the turn principal after a merge', async () => {
    session.managedTurnOrigin.speakers = [{ openId: 'ou_sender', turnId: 'om_a' }, { openId: 'ou_other', turnId: 'om_turn' }];
    vi.mocked(bots.getBot).mockReturnValue({ config: { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret',
      triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, capabilities: ['lark-user'], allowSpeakerSwitch: true }) } } as any);
    vi.mocked(identities.resolveVerifiedUserIdentity).mockImplementation(async (_app, openId) => ({ openId, type: 'user' }) as any);
    const call = (as?: string) => fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/lark-tool-identity`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: JSON.stringify({ mode: 'user', ...(as ? { as } : {}) }),
    });
    // ou_sender started the turn; ou_other merged in later. Only a named call runs as ou_other.
    expect((await call()).status).toBe(200);
    expect(tokens.resolveUserToken).toHaveBeenLastCalledWith('cli_bound', 'bound-secret', expect.anything(), 'ou_sender');
    expect((await call('ou_other')).status).toBe(200);
    expect(tokens.resolveUserToken).toHaveBeenLastCalledWith('cli_bound', 'bound-secret', expect.anything(), 'ou_other');
    const requestAuth = vi.spyOn(tokens, 'requestUserAuthorization').mockResolvedValue({
      authUrl: 'https://accounts.example/device', scopes: ['im:chat:read'], expiresIn: 600, poll: vi.fn(),
    } as any);
    const scopeRequest = (as?: string) => fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/auth-request`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: JSON.stringify({ scopes: ['im:chat:read'], ...(as ? { as } : {}) }),
    });
    expect((await scopeRequest()).status).toBe(200);
    expect(requestAuth.mock.calls.at(-1)![4]).toBe('ou_sender');
    expect((await scopeRequest('ou_other')).status).toBe(200);
    expect(requestAuth.mock.calls.at(-1)![4]).toBe('ou_other');
    const stranger = await call('ou_stranger');
    expect(stranger.status).toBe(403);
    // Off means upstream: without a per-person policy the principal of the turn stays, and a named speaker is refused.
    for (const triggerUserAuth of [undefined, parseTriggerUserAuthConfig({ enabled: true, capabilities: ['bytecloud'] })]) {
      vi.mocked(bots.getBot).mockReturnValue({ config: { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret', triggerUserAuth } } as any);
      expect((await call()).status).toBe(200);
      expect(tokens.resolveUserToken).toHaveBeenLastCalledWith('cli_bound', 'bound-secret', expect.anything(), 'ou_sender');
      expect((await call('ou_other')).status).toBe(403);
    }
  });
  it('BOTMUX_AS is refused where lark-cli --as user runs natively, and the refusal after a named call keeps the prefix', async () => {
    const call = (as?: string) => fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/lark-tool-identity`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: JSON.stringify({ mode: 'user', ...(as ? { as } : {}) }),
    });
    vi.mocked(bots.getBot).mockReturnValue({ config: { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret',
      triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, capabilities: ['bytecloud'] }) } } as any);
    expect((await call()).status).toBe(200);
    expect((await call('ou_sender')).status).toBe(403);
    session.managedTurnOrigin.speakers = [{ openId: 'ou_sender', turnId: 'om_turn' }];
    vi.mocked(bots.getBot).mockReturnValue({ config: { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret',
      triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, capabilities: ['lark-user'], allowSpeakerSwitch: true }) } } as any);
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    const refused = await call('ou_sender');
    expect(((await refused.json()) as { error: string }).error).toContain('BOTMUX_AS=ou_sender botmux auth request');
  });
  it('with the speaker switch off the lark route, the scope request and the wait say so and never ask to name a speaker', async () => {
    vi.mocked(bots.getBot).mockReturnValue({ config: { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret',
      triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, capabilities: ['lark-user'] }) } } as any);
    const post = (path: string, body: object) => fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey }, body: JSON.stringify(body),
    });
    const identity = await post('lark-tool-identity', { mode: 'user', as: 'ou_other' });
    expect(identity.status).toBe(403);
    expect(((await identity.json()) as { error: string }).error).toContain('BOTMUX_AS cannot name anyone in this turn');
    for (const [path, body] of [['auth-request', { scopes: ['im:chat:read'], as: 'ou_other' }], ['auth-status', { requestId: 'r', as: 'ou_other' }]] as const) {
      const response = await post(path, body);
      expect(response.status, path).toBe(403);
      expect(await response.json()).toEqual({ ok: false, error: 'as_unavailable' });
    }
    expect(identityRefusalLines('bytedcli', 'current_execution_unverified', 'as_unavailable').join('\n')).not.toMatch(/open_id|发言人的 open_id/);
  });
  it('rejects identity request when larkToolBinding is explicitly disabled on the bot', async () => {
    vi.mocked(bots.getBot).mockReturnValue({ config: { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret', larkToolBinding: false } } as any);
    const res = await request('bot');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'lark_tool_session_unavailable' });
  });
  it('allows identity request when larkToolBinding is unconfigured on the bot (default on)', async () => {
    vi.mocked(bots.getBot).mockReturnValue({ config: { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret' } } as any);
    const res = await request('bot');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, appId: 'cli_bound', mode: 'bot', credential: 'bound-bot-token' });
  });
});

describe('platform-issued user credentials in a bound session', () => {
  // Nobody but the bot owner can grant the bot's own application (its
  // availability range excludes them), so their --as user comes from the platform.
  const PLATFORM = { platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' };
  const platformBot = (credentialSource?: string) => ({ larkAppId: 'cli_bound', larkAppSecret: 'bound-secret',
    triggerUserAuth: { enabled: true, tools: ['lark-cli'], ...(credentialSource ? { credentialSource } : {}) } });
  let grants: any[];
  let platformRequest: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    grants = [];
    __resetPlatformAuthorizationRequestForTest();
    platformRequest = vi.spyOn(credentialRequestClient, 'requestCredentialAuthorization')
      .mockResolvedValue({ ok: true, status: 'sent', requestId: 'cr_1', deduped: false });
    __setPlatformCredentialDepsForTest({
      readBinding: () => PLATFORM,
      resolveUnionId: async () => 'on_sender',
      requestGrant: async req => {
        grants.push(req);
        return { ok: true, value: { tool: 'lark-cli', unionId: 'on_sender', expiresAt: Date.now() + 3_600_000,
          variables: { LARKSUITE_CLI_APP_ID: 'cli_platform', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'platform-user-token' } } } as any;
      },
    });
    vi.mocked(bots.getBot).mockReturnValue({ config: platformBot() } as any);
  });
  afterEach(() => __setPlatformCredentialDepsForTest(null));
  const runTool = (args: string[], port: number, extraEnv: Record<string, string> = {}) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawnTsScript(join(process.cwd(), 'src/lark-tool-runner.ts'), ['--binding', larkToolBindingPath(dir, 'tool-session'), '--', ...args], {
      env: { ...process.env, BOTMUX_DAEMON_IPC_PORT: String(port), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = ''; child.stdout!.on('data', b => out += b); child.stderr!.on('data', b => err += b);
    child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
  });
  const installFakeTool = () => {
    const real = join(dir, 'real-lark');
    writeFileSync(real, '#!/usr/bin/env node\n' + fakeLarkHelpScript() + 'process.stdout.write([process.env.LARKSUITE_CLI_APP_ID,process.env.LARKSUITE_CLI_APP_SECRET,process.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN,process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN,process.argv.slice(2).join(" ")].map(x=>x||"").join("|"));\n'); chmodSync(real, 0o755);
    binding.realBinary = real; delete (binding as any).ipcPort;
    writeFileSync(larkToolBindingPath(dir, 'tool-session'), JSON.stringify(binding), { mode: 0o600 });
  };

  it('serves a person without a bot-app grant from the platform, under the platform application', async () => {
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    const response = await request('user');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, appId: 'cli_platform', mode: 'user', credentialType: 'user_access_token',
      credential: 'platform-user-token', issuer: 'platform' });
    expect(grants[0]).toMatchObject({ tool: 'lark-cli', unionId: 'on_sender', appId: 'cli_bound', sessionId: 'tool-session', turnId: 'om_turn' });
  });
  it('keeps the bot-app grant for a person who has one, without asking the platform', async () => {
    const response = await request('user');
    expect(await response.json()).toEqual({ ok: true, appId: 'cli_bound', mode: 'user', credentialType: 'user_access_token', credential: 'bound-user-token' });
    expect(grants).toHaveLength(0);
  });
  it('serves a delegated human from the platform by the union_id in the dispatch, with the contact API down', async () => {
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    __setPlatformCredentialDepsForTest({
      readBinding: () => PLATFORM,
      resolveUnionId: async () => { throw new Error('contact API unavailable'); },
      requestGrant: async req => {
        grants.push(req);
        return { ok: true, value: { tool: 'lark-cli', unionId: 'on_source_human', expiresAt: Date.now() + 3_600_000,
          variables: { LARKSUITE_CLI_APP_ID: 'cli_platform', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'delegated-platform-token' } } } as any;
      },
    });
    session.managedTurnOrigin.callerOpenId = 'ou_dispatch_bot';
    const botConfig = { ...platformBot('platform'), larkToolBinding: true } as any;
    vi.mocked(bots.getBot).mockReturnValue({ config: botConfig } as any);
    await publishTurnCliIdentity({ botConfig, sessionDataDir: dir, sessionId: 'tool-session',
      senderOpenId: 'ou_dispatch_bot', turnId: 'om_turn', storageModel: 'proven', delegatedIdentity: {
        credentialOpenId: 'ou_source_human', targetOpenId: 'ou_target_human', unionId: 'on_source_human',
        tools: ['lark-cli'], dispatchRoot: 'om_dispatch_root',
      } });
    const response = await request('user');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ appId: 'cli_platform', credential: 'delegated-platform-token', issuer: 'platform' });
    expect(grants.map(grant => grant.unionId)).toEqual(['on_source_human']);
  });
  it('platform mode ignores the bot-app grant', async () => {
    vi.mocked(bots.getBot).mockReturnValue({ config: platformBot('platform') } as any);
    expect(await (await request('user')).json()).toMatchObject({ appId: 'cli_platform', issuer: 'platform' });
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
  });
  it('a refused --as user asks the platform for a card: no link reaches the agent, a DM or the group', async () => {
    session.chatType = 'group';
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
    const reply = vi.spyOn(larkClient, 'replyMessage').mockResolvedValue('om_reply');
    __setPlatformCredentialDepsForTest({
      readBinding: () => PLATFORM, resolveUnionId: async () => 'on_sender',
      requestGrant: async () => ({ ok: false, reason: 'not_authorized', error: 'credential_not_found', authorizeUrl: 'https://platform.example.test/credentials' }) as any,
    });
    const response = await request('user');
    expect(response.status).toBe(403);
    const body = await response.json() as { error: string };
    expect(body).toMatchObject({ ok: false });
    expect(JSON.stringify(body)).not.toContain('https://');
    expect(body.error).toContain('[reason=platform_not_authorized]');
    expect(platformRequest).toHaveBeenCalledTimes(1);
    expect(platformRequest.mock.calls[0][0]).toEqual({ unionId: 'on_sender', appId: 'cli_bound', tools: ['lark-cli'] });
    expect(dm).not.toHaveBeenCalled();
    expect(reply.mock.calls.map(c => String(c[2])).join('')).not.toContain('https://');
  });
  it('a platform without the credential-request endpoint keeps the plain credentials page DM', async () => {
    session.chatType = 'group';
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    platformRequest.mockResolvedValue({ ok: false, reason: 'not_deployed' });
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
    vi.spyOn(larkClient, 'replyMessage').mockResolvedValue('om_reply');
    __setPlatformCredentialDepsForTest({
      readBinding: () => PLATFORM, resolveUnionId: async () => 'on_sender',
      requestGrant: async () => ({ ok: false, reason: 'not_authorized', error: 'credential_not_found', authorizeUrl: 'https://platform.example.test/credentials' }) as any,
    });
    const response = await request('user');
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain('https://');
    expect(dm).toHaveBeenCalledTimes(1);
    expect(dm.mock.calls[0][1]).toBe('ou_sender');
    expect(dm.mock.calls[0][2]).toContain('https://platform.example.test/credentials');
  });
  it('does not hand out a platform credential when the turn changes while it is being fetched', async () => {
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    __setPlatformCredentialDepsForTest({
      readBinding: () => PLATFORM, resolveUnionId: async () => 'on_sender',
      requestGrant: async () => {
        session.managedTurnOrigin.turnId = 'om_later';
        return { ok: true, value: { tool: 'lark-cli', unionId: 'on_sender', expiresAt: Date.now() + 3_600_000,
          variables: { LARKSUITE_CLI_APP_ID: 'cli_platform', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'wrong-turn-token' } } } as any;
      },
    });
    const response = await request('user');
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('wrong-turn-token');
  });
  it('bot calls stay on the bound application', async () => {
    expect(await (await request('bot')).json()).toMatchObject({ appId: 'cli_bound', mode: 'bot' });
    expect(grants).toHaveLength(0);
  });
  it('auth request asks the platform for a card carrying the missing scopes, instead of a bot-app device link', async () => {
    session.chatType = 'group';
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
    vi.spyOn(larkClient, 'replyMessage').mockResolvedValue('om_reply');
    const deviceFlow = vi.spyOn(tokens, 'requestUserAuthorization');
    const response = await fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/auth-request`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: JSON.stringify({ scopes: ['search:docs:read'] }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error: 'platform_authorization_required' });
    expect(JSON.stringify(body)).not.toContain('https://');
    expect(platformRequest).toHaveBeenCalledTimes(1);
    expect(platformRequest.mock.calls[0][0]).toMatchObject({ tools: ['lark-cli'], scopes: ['search:docs:read'] });
    expect(dm).not.toHaveBeenCalled();
    expect(deviceFlow).not.toHaveBeenCalled();
  });
  it('auth request on a platform without the endpoint DMs the incremental credentials page', async () => {
    session.chatType = 'group';
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    platformRequest.mockResolvedValue({ ok: false, reason: 'not_deployed' });
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
    vi.spyOn(larkClient, 'replyMessage').mockResolvedValue('om_reply');
    const response = await fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/auth-request`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: JSON.stringify({ scopes: ['search:docs:read'] }),
    });
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain('https://');
    expect(dm.mock.calls[0][2]).toContain('https://platform.example.test/credentials?scope=search%3Adocs%3Aread');
  });
  it('auth request does not start a bot-app device flow for a turn that moved on during the platform check', async () => {
    vi.mocked(tokens.resolveUserToken).mockImplementation(async () => { session.managedTurnOrigin.turnId = 'om_later'; return 'bot-app-token'; });
    const deviceFlow = vi.spyOn(tokens, 'requestUserAuthorization');
    const response = await fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/auth-request`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: JSON.stringify({ scopes: ['search:docs:read'] }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(deviceFlow).not.toHaveBeenCalled();
  });
  it('runs the real tool with the platform application for user calls and the bound one for bot calls', async () => {
    installFakeTool();
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    const user = await runTool(['docs', '+fetch', '--as=user'], ipc!.port); expect(user.code, user.err).toBe(0);
    expect(user.out).toBe('cli_platform|||platform-user-token|docs +fetch --as user');
    const bot = await runTool(['docs', '+fetch'], ipc!.port); expect(bot.code, bot.err).toBe(0);
    expect(bot.out).toBe('cli_bound||bound-bot-token||docs +fetch --as bot');
  });
  describe('per-person auth on without lark-user: --as user is native to the machine', () => {
    const withBot = (triggerUserAuth?: unknown) => vi.mocked(bots.getBot).mockReturnValue({ config: {
      larkAppId: 'cli_bound', larkAppSecret: 'bound-secret', larkToolBinding: true,
      ...(triggerUserAuth ? { triggerUserAuth: parseTriggerUserAuthConfig(triggerUserAuth) } : {}),
    } } as any);
    const installHomeTool = () => {
      installFakeTool();
      writeFileSync(binding.realBinary, '#!/usr/bin/env node\nif (process.argv[2] === "auth" && process.argv[3] === "status") { require("fs").appendFileSync(__filename + ".status", process.env.HOME + "\\n"); process.stdout.write(JSON.stringify({ userName: "机器\\u001b[0m用户" })); process.exit(0); }\n' + fakeLarkHelpScript() + 'process.stdout.write([process.env.HOME,process.env.LARKSUITE_CLI_CONFIG_DIR,process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN,process.argv.slice(2).join(" ")].map(x=>x||"").join("|"));\n');
    };
    it('bytecloud only: the real lark-cli runs with the machine HOME and config, no credential and no authorization request', async () => {
      withBot({ enabled: true, capabilities: ['bytecloud'] });
      installHomeTool();
      const requestAuth = vi.spyOn(tokens, 'requestUserAuthorization');
      const run = await runTool(['docs', '+fetch', '--as', 'user'], ipc!.port);
      expect(run.code, run.err).toBe(0);
      expect(run.out).toBe(`${process.env.HOME}|||docs +fetch --as user`);
      expect(run.err).toContain('botmux: --as user 使用本机 lark-cli 登录（机器[0m用户）');
      expect(run.err).not.toContain('\u001b');
      // Only the runner asks the machine's lark-cli who is logged in (with the caller's HOME); the daemon spawns nothing.
      expect(readFileSync(`${binding.realBinary}.status`, 'utf8')).toBe(`${process.env.HOME}\n`);
      expect(tokens.resolveUserToken).not.toHaveBeenCalled();
      expect(grants).toEqual([]);
      const scope = await fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/auth-request`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
        body: JSON.stringify({ scopes: ['im:chat:read'] }),
      });
      expect(scope.status).toBe(409);
      expect(requestAuth).not.toHaveBeenCalled();
    });
    it('BOTMUX_AS is refused where the call would run with a profile\'s own login', async () => {
      withBot({ enabled: true, capabilities: ['lark-user'] });
      installFakeTool();
      const run = await runTool(['docs', '+fetch', '--profile=cli_other'], ipc!.port, { BOTMUX_AS: 'ou_other' });
      expect(run.code).toBe(77);
      expect(run.err).toContain('BOTMUX_AS');
      expect(run.out).toBe('');
    });
    it('--as bot keeps the bound application and its tenant token', async () => {
      withBot({ enabled: true, capabilities: ['bytecloud'] });
      installFakeTool();
      const bot = await runTool(['docs', '+fetch', '--as', 'bot'], ipc!.port);
      expect(bot.out).toBe('cli_bound||bound-bot-token||docs +fetch --as bot');
    });
    it.each([
      ['lark-user on', { enabled: true, capabilities: ['lark-user'] }],
      ['no triggerUserAuth', undefined],
      ['enabled false', { enabled: false, capabilities: ['bytecloud'] }],
      ['a legacy config naming only tools', { enabled: true, tools: ['bytedcli'] }],
    ])('%s: --as user keeps the person\'s own credential', async (_label, policy) => {
      withBot(policy);
      installFakeTool();
      const user = await runTool(['docs', '+fetch', '--as', 'user'], ipc!.port);
      expect(user.code, user.err).toBe(0);
      expect(user.out).toBe('cli_bound|||bound-user-token|docs +fetch --as user');
    });
  });
  describe('the runner trusts a different application only for an explicit platform user grant', () => {
    let fake: Server; let reply: Record<string, unknown>;
    beforeEach(async () => {
      fake = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply)); });
      await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
      installFakeTool();
    });
    afterEach(() => new Promise<void>(r => fake.close(() => r())));
    const port = () => (fake.address() as { port: number }).port;
    it.each([
      ['another application without the platform marker', { ok: true, appId: 'cli_other', mode: 'user', credentialType: 'user_access_token', credential: 'x' }, ['--as=user']],
      ['a platform marker with a malformed application id', { ok: true, appId: 'not an app', mode: 'user', credentialType: 'user_access_token', credential: 'x', issuer: 'platform' }, ['--as=user']],
      ['a platform marker on a bot call', { ok: true, appId: 'cli_other', mode: 'bot', credentialType: 'tenant_access_token', credential: 'x', issuer: 'platform' }, []],
    ])('refuses %s', async (_label, body, extra) => {
      reply = body;
      const run = await runTool(['docs', '+fetch', ...extra as string[]], port());
      expect(run.code).not.toBe(0);
      expect(run.out).toBe('');
    });
  });

  describe('an unattended turn that cannot get the person\'s credential', () => {
    const SCHEDULED = 'trg_abc12345';
    beforeEach(() => {
      session.managedTurnOrigin.turnId = SCHEDULED;
      session.managedTurnOrigin.identityTurnId = SCHEDULED;
      __resetUnattendedNoticesForTest();
      __setPlatformCredentialDepsForTest({ readBinding: () => null });
      vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
      vi.spyOn(bytedcliAuth, 'describeBytedcliAuth').mockResolvedValue({ state: 'needs-login' });
      vi.spyOn(bytedcliAuth, 'beginBytedcliLogin').mockResolvedValue({ authUrl: 'https://cloud.example/device?code=B1' } as any);
    });
    const withPolicy = (triggerUserAuth: unknown) => vi.mocked(bots.getBot).mockReturnValue({ config: {
      larkAppId: 'cli_bound', larkAppSecret: 'bound-secret', larkToolBinding: true,
      triggerUserAuth: triggerUserAuth && parseTriggerUserAuthConfig(triggerUserAuth),
    } } as any);

    it('lark-user on: a link-free refusal for the agent, one private notice that also lists the other missing capability', async () => {
      withPolicy({ enabled: true, capabilities: ['lark-user', 'bytecloud'], credentialSource: 'local' });
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      for (let i = 0; i < 2; i++) {
        const response = await request('user');
        expect(response.status).toBe(403);
        const { error } = await response.json() as { error: string };
        expect(error).toContain('[reason=unattended]');
        expect(error).not.toMatch(/platform page|auth request|https?:/);
      }
      expect(dm).toHaveBeenCalledTimes(1);
      expect(dm.mock.calls[0].slice(0, 2)).toEqual(['cli_bound', 'ou_sender']);
      expect(dm.mock.calls[0][2]).toContain('https://cloud.example/device?code=B1');
    });

    it('a credential that resolves again ends the lapse: a later lapse sends a new notice, and bot_app_missing carries the /login text', async () => {
      withPolicy({ enabled: true, capabilities: ['lark-user'], credentialSource: 'local' });
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      await request('user'); await request('user');
      expect(dm).toHaveBeenCalledTimes(1);
      expect(dm.mock.calls[0][2]).toContain('/login');
      vi.mocked(tokens.resolveUserToken).mockResolvedValue('bound-user-token');
      expect((await request('user')).status).toBe(200);
      vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
      await request('user');
      expect(dm).toHaveBeenCalledTimes(2);
    });

    it('the scope request of an unattended turn keeps upstream behaviour when per-person auth is off or there is no policy', async () => {
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      vi.spyOn(tokens, 'requestUserAuthorization').mockResolvedValue({
        authUrl: 'https://accounts.example/device?code=X', scopes: ['im:chat:read'], expiresIn: 600, poll: vi.fn(),
      } as any);
      for (const policy of [undefined, { enabled: false, capabilities: ['bytecloud'] }]) {
        withPolicy(policy);
        const response = await fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/auth-request`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
          body: JSON.stringify({ scopes: ['im:chat:read'] }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ ok: true, authUrl: 'https://accounts.example/device?code=X' });
      }
      expect(dm).not.toHaveBeenCalled();
    });

    it('per-person auth off or no policy: upstream behaviour, nothing sent', async () => {
      const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
      for (const policy of [undefined, { enabled: false, capabilities: ['bytecloud'] }]) {
        withPolicy(policy);
        const response = await request('user');
        expect(response.status).toBe(403);
        expect(((await response.json()) as { error: string }).error).toContain('needs this user\'s authorization');
      }
      expect(dm).not.toHaveBeenCalled();
    });
  });
});

describe('unattended lark-cli turn on a platform-bound host', () => {
  const PLATFORM = { platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' };
  const TRIGGERED = 'trg_abc12345';
  let platformRequest: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    session.managedTurnOrigin.turnId = TRIGGERED;
    session.managedTurnOrigin.identityTurnId = TRIGGERED;
    __resetUnattendedNoticesForTest();
    __resetPlatformAuthorizationRequestForTest();
    platformRequest = vi.spyOn(credentialRequestClient, 'requestCredentialAuthorization')
      .mockResolvedValue({ ok: true, status: 'sent', requestId: 'cr_1', deduped: false });
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    vi.mocked(bots.getBot).mockReturnValue({ config: { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret', larkToolBinding: true,
      triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, capabilities: ['lark-user'], credentialSource: 'auto' }) } } as any);
  });
  afterEach(() => __setPlatformCredentialDepsForTest(null));
  const bind = (requestGrant: () => Promise<unknown>) => __setPlatformCredentialDepsForTest({
    readBinding: () => PLATFORM, resolveUnionId: async () => 'on_sender', requestGrant: requestGrant as any,
  });

  it('a platform outage is passed through as the platform\'s own refusal, not as a missing authorization', async () => {
    bind(async () => ({ ok: false, reason: 'unavailable', status: 503, error: 'store_unavailable' }));
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
    const response = await request('user');
    const body = await response.json() as { error: string };
    expect(response.status).toBe(403);
    expect(body.error).toContain('temporarily unavailable');
    expect(body.error).not.toContain('授权缺失');
    expect(platformRequest).not.toHaveBeenCalled();
    expect(dm).not.toHaveBeenCalled();
  });

  it.each([
    ['its daily card cap', { ok: false, reason: 'request_cap' }],
    ['a failure', { ok: false, reason: 'failed', detail: 'http 503' }],
    ['an undeliverable card', { ok: true, status: 'undeliverable', detail: 'x' }],
  ])('a platform answering with %s is reported as the platform not sending its card, with the credentials page', async (_name, answer) => {
    platformRequest.mockResolvedValue(answer as any);
    bind(async () => ({ ok: false, reason: 'not_authorized', error: 'credential_not_found' }));
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
    const body = await (await request('user')).json() as { error: string };
    expect(body.error).toContain(t('trigger_user_auth.denied_unattended_platform', {
      capability: 'lark-user', url: 'https://platform.example.test/credentials',
    }, 'zh'));
    expect(body.error).not.toContain('可用范围');
    expect(dm).not.toHaveBeenCalled();
  });

  it('auth request --scope asks the platform for those scopes, and a ready answer does not count as notified', async () => {
    bind(async () => ({ ok: true, value: { tool: 'lark-cli', unionId: 'on_sender', expiresAt: Date.now() + 3_600_000,
      variables: { LARKSUITE_CLI_APP_ID: 'cli_platform', LARKSUITE_CLI_USER_ACCESS_TOKEN: 't' } } }));
    platformRequest.mockResolvedValueOnce({ ok: true, status: 'ready' });
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
    vi.spyOn(tokens, 'requestUserAuthorization').mockRejectedValue(new Error('must not be used'));
    const ask = () => fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/auth-request`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: JSON.stringify({ scopes: ['im:chat:read'] }),
    });
    const first = await ask();
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ ok: false, status: 'refused', error: 'unattended_turn' });
    expect(await (await ask()).json()).toMatchObject({ error: 'unattended_turn' });
    expect(platformRequest).toHaveBeenCalledTimes(2);
    for (const [req] of platformRequest.mock.calls) {
      expect(req).toEqual({ unionId: 'on_sender', appId: 'cli_bound', tools: ['lark-cli'], scopes: ['im:chat:read'] });
    }
    expect(dm).not.toHaveBeenCalled();
  });
});


describe('lark-cli --as user in a turn nobody started uses the bot owner (larkUserOwnerFallback)', () => {
  const OWNER = 'ou_owner';
  const TRIGGER = 'trg_abc12345';
  const SCHEDULE = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
  let botConfig: Record<string, unknown>;
  const useBot = (patch: Record<string, unknown> = {}) => {
    botConfig = { larkAppId: 'cli_bound', larkAppSecret: 'bound-secret', ...patch };
    vi.mocked(bots.getBot).mockImplementation(() => ({ config: botConfig }) as any);
  };
  /** A live turn with no person of its own (a script, webhook or platform request). */
  const callerless = (turnId: string, trustedCaller?: unknown) => {
    // A script, webhook or platform request admitted through the public trigger entry.
    if (turnId.startsWith('trg_')) rememberExternalTriggerTurn(turnId);
    session.managedTurnOrigin.turnId = turnId;
    session.managedTurnOrigin.identityTurnId = turnId;
    delete session.managedTurnOrigin.callerOpenId;
    if (trustedCaller === undefined) delete session.managedTurnOrigin.trustedCaller;
    else session.managedTurnOrigin.trustedCaller = trustedCaller;
  };
  const adoptIntoTrigger = (caller: TrustedCaller, envelopeTurnId: string) => {
    callerless(TRIGGER);
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId: TRIGGER });
    authority.markStarted({ turnId: TRIGGER });
    expect(authority.adoptEnvelopePreservingPrincipal({ turnId: envelopeTurnId, caller })).toBe(true);
    const identity = authority.identity();
    const speakers = authority.speakers();
    session.managedTurnOrigin = {
      ...session.managedTurnOrigin,
      turnId: identity.turnId, identityTurnId: identity.identityTurnId ?? identity.turnId,
      trustedCaller: identity.caller ?? null,
      ...(speakers.length ? { speakers } : {}),
      ...(identity.provenanceIncomplete ? { provenanceIncomplete: true } : {}),
    };
  };
  const tokenCallsFor = (person: string) => vi.mocked(tokens.resolveUserToken).mock.calls.filter(call => call[3] === person);
  const auditLines = () => vi.mocked(logger.info).mock.calls.map(call => String(call[0]))
    .filter(line => line.startsWith('[lark-tool:owner-fallback:audit]'));
  const authRequest = (body: object = { scopes: ['docx:document:readonly'] }) => fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/auth-request`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey }, body: JSON.stringify(body),
  });

  beforeEach(() => {
    useBot();
    session.chatType = 'group';
    vi.spyOn(bots, 'getOwnerOpenId').mockImplementation(app => app === 'cli_bound' ? OWNER : undefined);
    vi.mocked(identities.resolveVerifiedUserIdentity).mockImplementation(async (_app, openId) => ({ openId, type: 'user' }) as any);
    vi.mocked(tokens.resolveUserToken).mockImplementation(async (_app, _secret, _brand, person) =>
      person === OWNER ? 'owner-token' : person === 'ou_sender' ? 'sender-token' : null);
    vi.spyOn(logger, 'info');
  });

  it('a script, webhook or platform trigger uses the owner\'s grant, says so, and is audited', async () => {
    callerless(TRIGGER);
    const response = await request('user');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ appId: 'cli_bound', mode: 'user', credential: 'owner-token', actingAs: 'owner' });
    expect(tokens.resolveUserToken).toHaveBeenCalledExactlyOnceWith('cli_bound', 'bound-secret', 'feishu', OWNER);
    const [line] = auditLines();
    for (const part of ['bot=cli_bound', 'session=tool-session', `turn=${TRIGGER}`, 'reason=external_trigger', 'result=granted']) {
      expect(line).toContain(part);
    }
    // --as bot is untouched.
    expect(await (await request('bot')).json()).toMatchObject({ mode: 'bot', credential: 'bound-bot-token' });
  });

  it('the real lark-cli wrapper runs the tool with the owner\'s token in a trigger turn and tells the agent so', async () => {
    callerless(TRIGGER);
    const real = join(dir, 'real-lark');
    writeFileSync(real, '#!/usr/bin/env node\n' + fakeLarkHelpScript() + 'process.stdout.write([process.env.LARKSUITE_CLI_APP_ID,process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN,process.argv.slice(2).join(" ")].map(x=>x||"").join("|"));\n');
    chmodSync(real, 0o755);
    binding.realBinary = real; delete (binding as any).ipcPort;
    writeFileSync(larkToolBindingPath(dir, 'tool-session'), JSON.stringify(binding), { mode: 0o600 });
    const run = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawnTsScript(join(process.cwd(), 'src/lark-tool-runner.ts'), ['--binding', larkToolBindingPath(dir, 'tool-session'), '--', 'docs', '+fetch', '--as=user'], {
        env: { ...process.env, BOTMUX_DAEMON_IPC_PORT: String(ipc!.port) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = ''; child.stdout!.on('data', b => out += b); child.stderr!.on('data', b => err += b);
      child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
    });
    expect(run.code, run.err).toBe(0);
    expect(run.out).toBe('cli_bound|owner-token|docs +fetch --as user');
    expect(run.err).toContain('bot 主人');
  });

  it('a relay the daemon minted for someone else\'s content (botmux report, meeting, answer) never uses the owner', async () => {
    callerless(TRIGGER);
    expect(await (await request('user')).json()).toMatchObject({ credential: 'owner-token' });
    vi.mocked(tokens.resolveUserToken).mockClear();
    // Same trigger machinery, but not submitted through the public entry.
    session.managedTurnOrigin.turnId = 'trg_internal_relay';
    session.managedTurnOrigin.identityTurnId = 'trg_internal_relay';
    const relay = await request('user');
    expect(relay.status).toBe(403);
    expect(await relay.json()).toEqual({ ok: false, error: 'No current requesting user; --as user requires their authorization' });
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
  });

  it('the owner\'s own turns use the owner\'s grant: a message, and a Dashboard owner-actor trigger without allowOwnerActor', async () => {
    session.managedTurnOrigin.callerOpenId = OWNER;
    const message = await request('user');
    expect(await message.json()).toMatchObject({ credential: 'owner-token' });
    session.managedTurnOrigin.turnId = 'trg_owner_abc';
    session.managedTurnOrigin.identityTurnId = 'trg_owner_abc';
    session.managedTurnOrigin.trustedCaller = { requestLarkAppId: 'cli_bound', requestUserOpenId: OWNER, senderType: 'user' };
    const ownerActor = await request('user');
    expect(ownerActor.status).toBe(200);
    expect(await ownerActor.json()).toMatchObject({ credential: 'owner-token', actingAs: 'owner' });
    expect(auditLines().at(-1)).toContain('reason=owner_actor');
    // A per-person policy still gates owner-actor credentials behind allowOwnerActor.
    useBot({ triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, capabilities: ['lark-user'] }) });
    const gated = await request('user');
    expect(gated.status).toBe(403);
    expect(await gated.json()).toMatchObject({ error: 'unattended_turn' });
  });

  it('a marker-restored owner-actor turn cannot regain owner fallback', async () => {
    session.managedTurnOrigin.turnId = 'trg_owner_abc';
    session.managedTurnOrigin.identityTurnId = 'trg_owner_abc';
    session.managedTurnOrigin.callerOpenId = OWNER;
    session.managedTurnOrigin.trustedCaller = { requestLarkAppId: 'cli_bound', requestUserOpenId: OWNER, senderType: 'user' };
    session.managedTurnOrigin.provenanceIncomplete = true;
    const response = await request('user');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'unattended_turn' });
    expect(tokenCallsFor(OWNER)).toHaveLength(0);
    expect((await authRequest()).status).toBe(403);
  });

  it('a schedule without a creator uses the owner; one created by someone else never does', async () => {
    const authority = vi.spyOn(schedulerModule, 'getScheduleAuthorityRecord').mockReturnValue({ kind: 'direct', state: 'active', task: { id: 'a1b2c3d4' } } as any);
    callerless(SCHEDULE);
    expect(await (await request('user')).json()).toMatchObject({ credential: 'owner-token', actingAs: 'owner' });
    expect(auditLines().at(-1)).toContain('reason=schedule_without_creator');
    authority.mockReturnValue({ kind: 'legacy', state: 'active', task: { id: 'a1b2c3d4' } } as any);
    expect(await (await request('user')).json()).toMatchObject({ credential: 'owner-token', actingAs: 'owner' });
    vi.mocked(tokens.resolveUserToken).mockClear();
    for (const record of [
      { kind: 'direct', state: 'active', task: { id: 'a1b2c3d4', ownerOpenId: 'ou_sender', ownerUnionId: 'on_sender' } },
      { kind: 'delegated', state: 'active', task: { id: 'a1b2c3d4' } },
      { kind: 'direct', state: 'revoked', task: { id: 'a1b2c3d4' } },
      undefined,
    ]) {
      authority.mockReturnValue(record as any);
      const refused = await request('user');
      expect(refused.status).toBe(403);
      expect(await refused.text()).not.toContain('owner-token');
    }
    expect(tokenCallsFor(OWNER)).toHaveLength(0);
    // The creator present as the turn's caller keeps their own grant.
    session.managedTurnOrigin.callerOpenId = 'ou_sender';
    session.managedTurnOrigin.trustedCaller = { requestLarkAppId: 'cli_bound', requestUserOpenId: 'ou_sender', requestUserUnionId: 'on_sender', senderType: 'user', source: 'schedule_creator', taskId: 'a1b2c3d4' };
    expect(await (await request('user')).json()).toMatchObject({ credential: 'sender-token' });
    expect(tokenCallsFor(OWNER)).toHaveLength(0);
  });

  it('someone else\'s turn keeps their own grant, and their message merged into a trigger ends the owner fallback', async () => {
    callerless(TRIGGER);
    expect(await (await request('user')).json()).toMatchObject({ credential: 'owner-token' });
    vi.mocked(tokens.resolveUserToken).mockClear();
    // Another person started the turn: their own grant, or a refusal — never the owner's.
    session.managedTurnOrigin.callerOpenId = 'ou_sender';
    expect(await (await request('user')).json()).toMatchObject({ credential: 'sender-token' });
    vi.mocked(tokens.resolveUserToken).mockImplementation(async (_a, _s, _b, person) => person === OWNER ? 'owner-token' : null);
    const ungranted = await request('user');
    expect(ungranted.status).toBe(403);
    expect(tokenCallsFor(OWNER)).toHaveLength(0);
    // A trigger that someone else has spoken into since.
    callerless(TRIGGER);
    session.managedTurnOrigin.speakers = [{ openId: 'ou_sender', turnId: 'om_merged' }];
    const merged = await request('user');
    expect(merged.status).toBe(403);
    expect(await merged.text()).not.toContain('owner-token');
    expect(tokenCallsFor(OWNER)).toHaveLength(0);
    // ...including one who speaks while the owner's grant is being fetched.
    session.managedTurnOrigin.speakers = [{ openId: OWNER, turnId: 'om_owner' }];
    vi.mocked(tokens.resolveUserToken).mockImplementation(async () => {
      session.managedTurnOrigin.speakers = [{ openId: OWNER, turnId: 'om_owner' }, { openId: 'ou_sender', turnId: 'om_late' }];
      return 'late-owner-token';
    });
    const late = await request('user');
    expect(late.status).toBe(409);
    expect(await late.text()).not.toContain('late-owner-token');
  });

  it.each([
    ['an unsigned bot', {
      requestLarkAppId: 'cli_bound', requestUserOpenId: 'ou_unsigned_bot', requestUserUnionId: 'on_unsigned_bot', senderType: 'bot',
    } as TrustedCaller, 'om_unsigned_bot'],
    ['another person\'s failed-turn recovery', {
      requestLarkAppId: 'cli_bound', requestUserOpenId: 'ou_sender', requestUserUnionId: 'on_sender',
      senderType: 'user', source: 'failed_turn_recovery',
    } as TrustedCaller, 'bmx-recovery-other'],
  ])('never uses the owner after %s joins the external turn', async (_label, caller, envelopeTurnId) => {
    adoptIntoTrigger(caller, envelopeTurnId);
    const response = await request('user');
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('owner-token');
    expect(tokenCallsFor(OWNER)).toHaveLength(0);
    expect(auditLines().at(-1)).toContain('result=declined refusal=origin_unknown');
    // The authorization entry is governed by the same incomplete provenance.
    const scope = await authRequest();
    expect(scope.status).toBe(403);
    expect(await scope.json()).toMatchObject({ error: 'current_actor_unverified' });
  });

  it('switched off, the strict refusal comes back unchanged and takes effect without a restart', async () => {
    callerless(TRIGGER);
    expect(await (await request('user')).json()).toMatchObject({ credential: 'owner-token' });
    vi.mocked(tokens.resolveUserToken).mockClear();
    vi.mocked(logger.info).mockClear();
    useBot({ larkUserOwnerFallback: false });
    const off = await request('user');
    expect(off.status).toBe(403);
    expect(await off.json()).toEqual({ ok: false, error: 'No current requesting user; --as user requires their authorization' });
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
    const scope = await authRequest();
    expect(scope.status).toBe(403);
    expect(await scope.json()).toMatchObject({ error: 'current_actor_unverified' });    // Byte-identical to before even where the fallback would have explained itself.
    vi.spyOn(schedulerModule, 'getScheduleAuthorityRecord').mockReturnValue({ kind: 'direct', state: 'active',
      task: { id: 'a1b2c3d4', ownerOpenId: 'ou_sender', ownerUnionId: 'on_sender' } } as any);
    callerless(SCHEDULE);
    for (const strict of [{ larkUserOwnerFallback: false },
      { triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, capabilities: ['lark-user'] }) }]) {
      useBot(strict);
      expect(await (await request('user')).json()).toEqual({ ok: false, error: 'No current requesting user; --as user requires their authorization' });
    }
    expect(auditLines()).toEqual([]);
  });

  it('per-person authorization covering the Feishu user identity keeps the strict behaviour', async () => {
    callerless(TRIGGER);
    for (const triggerUserAuth of [{ enabled: true, capabilities: ['lark-user'] }, { enabled: true, tools: ['lark-cli'] }]) {
      useBot({ triggerUserAuth: parseTriggerUserAuthConfig(triggerUserAuth) });
      expect((await request('user')).status).toBe(403);
    }
    expect(tokenCallsFor(OWNER)).toHaveLength(0);
    // Per-person auth for other tools only (legacy tools list) does not.
    useBot({ triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'] }) });
    expect(await (await request('user')).json()).toMatchObject({ credential: 'owner-token' });
  });

  it('an owner who has not authorized gets the link privately through auth request, never in the conversation', async () => {
    callerless(TRIGGER);
    session.chatType = 'p2p';
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    const refused = await request('user');
    expect(refused.status).toBe(403);
    const { error } = await refused.json() as { error: string };
    expect(error).toContain('botmux auth request');
    expect(error).not.toContain('/login');
    expect(auditLines().at(-1)).toContain('result=owner_not_authorized');
    const dm = vi.spyOn(larkClient, 'sendUserMessage').mockResolvedValue('om_dm');
    const poll = vi.fn(async () => ({ status: 'ready' as const, token: 'owner-fresh-token' }));
    const requestAuth = vi.spyOn(tokens, 'requestUserAuthorization').mockResolvedValue({
      authUrl: 'https://accounts.example/device?code=OWNER', scopes: ['docx:document:readonly'], expiresIn: 300, poll,
    });
    const asked = await authRequest();
    expect(asked.status).toBe(200);
    const body = await asked.json() as { requestId: string; delivery?: string; authUrl?: string };
    expect(body).toMatchObject({ ok: true, delivery: 'dm' });
    expect(body.authUrl).toBeUndefined();
    expect(requestAuth.mock.calls[0]?.[4]).toBe(OWNER);
    expect(dm).toHaveBeenCalledOnce();
    expect(dm.mock.calls[0].slice(0, 2)).toEqual(['cli_bound', OWNER]);
    expect(dm.mock.calls[0][2]).toContain('https://accounts.example/device?code=OWNER');
    // botmux auth wait in the same turn completes for the owner.
    const waited = await fetch(`http://127.0.0.1:${ipc!.port}/api/sessions/tool-session/auth-status`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: JSON.stringify({ requestId: body.requestId }),
    });
    expect(await waited.json()).toEqual({ ok: true, status: 'ready' });
  });

  describe('a message from a bot', () => {
    const peerBot = { requestLarkAppId: 'cli_bound', requestUserOpenId: 'ou_peer_bot', requestUserUnionId: 'on_peer_bot', senderType: 'bot' };
    beforeEach(() => {
      session.managedTurnOrigin.callerOpenId = 'ou_peer_bot';
      session.managedTurnOrigin.trustedCaller = peerBot;
      vi.spyOn(dispatchReportBinding, 'loadOrCreateDispatchReportBindingSecret').mockReturnValue('secret');
    });

    it('uses the owner only when its signed dispatch names the owner', async () => {
      const record = vi.spyOn(dispatchUserDelegation, 'resolveDispatchUser').mockResolvedValue({ authority: { unionId: 'on_owner' } } as any);
      const target = vi.spyOn(larkClient, 'resolveTargetAppOpenId').mockResolvedValue({ status: 'resolved', openId: OWNER } as any);
      expect(await (await request('user')).json()).toMatchObject({ credential: 'owner-token', actingAs: 'owner' });
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ appId: 'cli_bound', chatId: 'oc_chat', turnId: 'om_turn' }));
      expect(target).toHaveBeenCalledWith('cli_bound', 'on_owner');
      expect(auditLines().at(-1)).toContain('reason=owner_dispatch');
      vi.mocked(tokens.resolveUserToken).mockClear();
      // Signed for someone else: that person's turn, never the owner's.
      target.mockResolvedValue({ status: 'resolved', openId: 'ou_x' } as any);
      expect((await request('user')).status).toBe(403);
      // The requester cannot be resolved here: unknown, refused.
      target.mockResolvedValue({ status: 'transient' } as any);
      expect((await request('user')).status).toBe(403);
      expect(tokenCallsFor(OWNER)).toHaveLength(0);
    });

    it('without a record (unsigned, unbound, or still pending) never uses the owner, even from a same-administrator bot', async () => {
      vi.spyOn(eventDispatcher, 'isTrustedSameOwnerSiblingBot').mockReturnValue(true);
      vi.spyOn(dispatchUserDelegation, 'resolveDispatchUser').mockResolvedValue(undefined);
      const response = await request('user');
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('owner-token');
      expect(tokenCallsFor(OWNER)).toHaveLength(0);
      expect(auditLines().at(-1)).toContain('result=declined refusal=origin_unknown');
    });
  });

  it('an incomplete-provenance transition during the owner credential fetch returns no credential', async () => {
    callerless(TRIGGER);
    vi.mocked(tokens.resolveUserToken).mockImplementation(async () => {
      session.managedTurnOrigin.provenanceIncomplete = true;
      return 'late-owner-token';
    });
    const late = await request('user');
    expect(late.status).toBe(409);
    expect(await late.text()).not.toContain('late-owner-token');
  });

  it('a schedule that gains a person while the owner\'s grant is fetched gets nothing', async () => {
    const authority = vi.spyOn(schedulerModule, 'getScheduleAuthorityRecord').mockReturnValue({ kind: 'direct', state: 'active', task: { id: 'a1b2c3d4' } } as any);
    callerless(SCHEDULE);
    vi.mocked(tokens.resolveUserToken).mockImplementation(async () => {
      authority.mockReturnValue({ kind: 'direct', state: 'active', task: { id: 'a1b2c3d4', runAsClaim: { openId: 'ou_sender' } } } as any);
      return 'late-owner-token';
    });
    const late = await request('user');
    expect(late.status).toBe(409);
    expect(await late.text()).not.toContain('late-owner-token');
  });

  it('sessions that withhold the bot identity, or belong to another person in assistant mode, never use the owner', async () => {
    callerless(TRIGGER);
    session.session.sandboxWithholdBotSecret = true;
    expect((await request('user')).status).toBe(403);
    delete session.session.sandboxWithholdBotSecret;
    useBot({ assistantMode: true });
    session.session.assistantOwnerOpenId = 'ou_sender';
    expect((await request('user')).status).toBe(403);
    expect(tokenCallsFor(OWNER)).toHaveLength(0);
    session.session.assistantOwnerOpenId = OWNER;
    expect(await (await request('user')).json()).toMatchObject({ credential: 'owner-token' });
  });
});
