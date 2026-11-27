import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as botRegistry from '../src/bot-registry.js';
import { config } from '../src/config.js';
import { dropPublishedIdentitiesForOpenId, forgetProvenIdentityContent, recallProvenIdentityContent } from '../src/core/cli-identity.js';
import * as attestation from '../src/core/current-actor-attestation.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { setIpcAuthSecret, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { __resetPlatformAuthorizationRequestForTest } from '../src/core/platform-authorization-request.js';
import { __setPlatformCredentialDepsForTest } from '../src/core/platform-credential-source.js';
import { publishTurnCliIdentity } from '../src/core/turn-cli-identity.js';
import type { DaemonSession } from '../src/core/types.js';
import * as workerPool from '../src/core/worker-pool.js';
import type { CredentialGrantRequest, CredentialGrantResult } from '../src/platform/credential-grant-client.js';
import * as credentialRequestClient from '../src/platform/credential-request-client.js';
import { parseTriggerUserAuthConfig } from '../src/services/trigger-user-auth.js';

const sessionId = 's-lark-renewal';
const turnId = 'om_lark_renewal';
const botAppId = 'cli_bot_fixture';
const issuerAppId = 'cli_issuer_fixture';
const senderOpenId = 'ou_lark_renewal';
const unionId = 'on_lark_renewal';
const secret = 'lark-renewal-ipc-fixture';
const original = 'opaque-original';
const replacement = 'opaque-renewed';

describe('same-turn platform Lark identity renewal', () => {
  let ipc: IpcServerHandle;
  let oldDataDir: string;
  let dataDir: string;
  let now: number;
  let originalExpiry: number;
  const botConfig = {
    larkAppId: botAppId, larkToolBinding: false,
    triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli'], credentialSource: 'platform' }),
  } as botRegistry.BotConfig;
  const ds = {
    session: { sessionId, status: 'active', backendType: 'pty' },
    larkAppId: botAppId, chatId: 'oc_lark_fixture', chatType: 'p2p',
    worker: { pid: process.pid, killed: false }, workerGeneration: 7,
    managedTurnOrigin: { turnId, callerOpenId: senderOpenId, capability: 'ba'.repeat(32), dispatchAttempt: 3 },
  } as unknown as DaemonSession;
  const requestGrant = vi.fn<(req: CredentialGrantRequest) => Promise<CredentialGrantResult>>();
  const originalGrant = () => grant(original, originalExpiry);
  const renewedGrant = (issuer = issuerAppId) => grant(replacement, now + 3_600_000, issuer);
  const grant = (token: string, expiresAt: number, issuer = issuerAppId): CredentialGrantResult => ({
    ok: true, value: { tool: 'lark-cli', unionId, expiresAt, variables: {
      LARKSUITE_CLI_APP_ID: issuer, LARKSUITE_CLI_USER_ACCESS_TOKEN: token,
    } },
  });
  const published = () => recallProvenIdentityContent(dataDir, sessionId, turnId, 'lark-cli');
  const askIdentity = async () => {
    const response = await fetch(`http://127.0.0.1:${ipc.port}/api/current-execution-identity`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, tool: 'lark-cli' }),
    });
    return { status: response.status, body: await response.json() };
  };

  beforeEach(async () => {
    oldDataDir = config.session.dataDir;
    dataDir = config.session.dataDir = mkdtempSync(join(tmpdir(), 'platform-lark-renewal-'));
    now = Date.now();
    originalExpiry = now + 600_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    botConfig.triggerUserAuth = parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli'], credentialSource: 'platform' });
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: botConfig } as ReturnType<typeof botRegistry.getBot>);
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === sessionId ? ds : undefined);
    vi.spyOn(workerPool, 'identityModelRefusalReason').mockReturnValue(undefined);
    vi.spyOn(workerPool, 'identityStorageModelForDaemonSession').mockReturnValue('proven');
    vi.spyOn(attestation, 'resolveLoopbackPeerProcesses').mockResolvedValue({ ok: true, peer: { pid: process.pid, procStart: '1' } });
    vi.spyOn(attestation, 'attestCurrentExecutionLoopbackPeer').mockImplementation(() => ({
      ds, turnId, generation: ds.workerGeneration, dispatchAttempt: ds.managedTurnOrigin!.dispatchAttempt,
      capability: ds.managedTurnOrigin!.capability, workerPid: process.pid, workerProcStart: '1', processIdentities: [],
    }));
    requestGrant.mockReset().mockResolvedValueOnce(originalGrant());
    __setPlatformCredentialDepsForTest({
      readBinding: () => ({ platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-fixture' }),
      resolveUnionId: async () => unionId,
      requestGrant,
    });
    setIpcAuthSecret(secret);
    ipc = await startIpcServer({ host: '127.0.0.1', port: 0, authRequired: true });
    await publishTurnCliIdentity({ botConfig, sessionDataDir: dataDir, sessionId, senderOpenId, turnId, storageModel: 'proven' });
    expect(published()).toContain(original);
  });

  afterEach(async () => {
    await ipc?.close();
    setIpcAuthSecret(null);
    __resetPlatformAuthorizationRequestForTest();
    __setPlatformCredentialDepsForTest(null);
    vi.restoreAllMocks();
    forgetProvenIdentityContent(dataDir, sessionId);
    config.session.dataDir = oldDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('coalesces proven calls and caches a fresh access token before expiry', async () => {
    expect(await askIdentity()).toMatchObject({ status: 200, body: { env: published() } });
    expect(requestGrant).toHaveBeenCalledTimes(1);
    now = originalExpiry - 120_000;
    let finish!: (result: CredentialGrantResult) => void;
    requestGrant.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = askIdentity();
    await vi.waitFor(() => expect(requestGrant).toHaveBeenCalledTimes(2));
    const second = askIdentity();
    await vi.waitFor(() => expect(attestation.attestCurrentExecutionLoopbackPeer).toHaveBeenCalledTimes(3));
    expect(requestGrant).toHaveBeenLastCalledWith({ tool: 'lark-cli', unionId, appId: botAppId, sessionId, turnId }, expect.anything());
    finish(renewedGrant());
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse).toEqual(secondResponse);
    expect(firstResponse).toMatchObject({ status: 200, body: { env: published() } });
    expect(firstResponse.body.env).toContain(replacement);
    expect(firstResponse.body.env).toContain(issuerAppId);
    expect(firstResponse.body.env).not.toContain(original);
    expect(await askIdentity()).toEqual(firstResponse);
    expect(requestGrant).toHaveBeenCalledTimes(2);
  });

  it('keeps a valid token during a transient outage but blocks once it expires', async () => {
    requestGrant.mockResolvedValue({ ok: false, reason: 'network', error: 'fixture unavailable' });
    now = originalExpiry - 1_000;
    expect(await askIdentity()).toMatchObject({ status: 200, body: { env: published() } });
    now = originalExpiry;
    const blocked = await askIdentity();
    expect(blocked).toMatchObject({ status: 503, body: { reason: 'lark_grant_unavailable' } });
    expect(JSON.stringify(blocked)).not.toContain(original);
    expect(requestGrant).toHaveBeenCalledTimes(2);
    now += 30_000;
    requestGrant.mockResolvedValue(renewedGrant());
    expect((await askIdentity()).body.env).toContain(replacement);
    expect(requestGrant).toHaveBeenCalledTimes(3);
  });

  it('renewal can require consent and authorization-ready resumes the same turn', async () => {
    now = originalExpiry - 30_000;
    requestGrant.mockResolvedValueOnce({ ok: false, reason: 'consent_missing', error: 'fixture consent missing' })
      .mockResolvedValueOnce(renewedGrant());
    const denied = await askIdentity();
    expect(denied).toMatchObject({ status: 200 });
    expect(denied.body.env).toContain('[reason=platform_consent_missing]');
    expect(denied.body.env).not.toContain(original);
    const platformRequest = vi.spyOn(credentialRequestClient, 'requestCredentialAuthorization')
      .mockResolvedValue({ ok: true, status: 'ready' });
    const path = `/api/sessions/${sessionId}/auth-request`;
    const response = await fetch(`http://127.0.0.1:${ipc.port}${path}`, {
      method: 'POST', headers: daemonIpcAuthHeaders({ secret, port: ipc.port, method: 'POST', path, headers: { 'content-type': 'application/json' } }),
      body: JSON.stringify({ provider: 'lark-cli', originTurnId: turnId,
        originCapability: ds.managedTurnOrigin!.capability, originDispatchAttempt: ds.managedTurnOrigin!.dispatchAttempt }),
    });
    expect(await response.json()).toMatchObject({ ok: true, provider: 'lark-cli', status: 'ready' });
    expect(platformRequest).toHaveBeenCalledExactlyOnceWith({ unionId, appId: botAppId, tools: ['lark-cli'] });
    expect(requestGrant).toHaveBeenCalledTimes(3);
    expect((await askIdentity()).body.env).toContain(replacement);
  });

  it.each(['revoked', 'source changed'] as const)('discards an in-flight refresh when the original grant is %s', async reason => {
    now = originalExpiry + 1_000;
    let finish!: (result: CredentialGrantResult) => void;
    requestGrant.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = askIdentity();
    await vi.waitFor(() => expect(requestGrant).toHaveBeenCalledTimes(2));
    if (reason === 'revoked') dropPublishedIdentitiesForOpenId(dataDir, senderOpenId);
    else botConfig.triggerUserAuth = parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli'],
      credentialSource: { 'lark-user': 'local', bytecloud: 'platform' } });
    const beforeRenewal = published();
    finish(renewedGrant());
    expect(await first).toMatchObject({ status: 403, body: { reason: 'lineage_unproven' } });
    expect(published()).toBe(beforeRenewal);
  });

  it.each(['different issuer', 'old token'] as const)('blocks a refresh returning a %s', async reason => {
    now = originalExpiry + 1_000;
    requestGrant.mockResolvedValueOnce(reason === 'different issuer' ? renewedGrant('cli_other_fixture') : originalGrant());
    const blocked = await askIdentity();
    expect(blocked).toMatchObject({ status: 503, body: { reason: 'lark_grant_unavailable' } });
    expect(JSON.stringify(blocked)).not.toContain(original);
    expect(published()).toContain(original);
  });
});
