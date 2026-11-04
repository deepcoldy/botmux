/**
 * A turn whose platform grant failed transiently (no answer, reset, timeout)
 * must not stay refused for the whole turn: in the proven model the daemon
 * re-asks the platform when the wrapper next fetches the refusal.
 *
 * Run:  npx vitest run --project unit test/turn-cli-identity-transient-retry.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: vi.fn(async () => null),
  lookupAuthorizedUserName: vi.fn(() => undefined),
  isUsableOpenId: (openId: unknown) => typeof openId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(openId),
}));
vi.mock('../src/services/bytedcli-auth.js', () => ({
  renewBytedcliJwts: vi.fn(async () => null),
  mintBytedcliJwts: vi.fn(async () => null),
  beginBytedcliLogin: vi.fn(async () => ({ authUrl: 'https://cloud.example.test/local', completeToken: 'tok' })),
}));
vi.mock('../src/services/lark-cli-auth.js', () => ({
  resolveLarkCliHomeForTurn: vi.fn(async () => null),
  pendingLarkCliChallenge: vi.fn(() => null),
  beginLarkCliLogin: vi.fn(async () => ({ authUrl: 'https://example.test/local-lark-device' })),
}));

const {
  publishTurnCliIdentity,
  retryTransientTurnIdentity,
  __resetTransientRefusalsForTest,
  TRANSIENT_REFUSAL_RETRY_INTERVAL_MS,
  TRANSIENT_REFUSAL_MAX_RETRIES,
} = await import('../src/core/turn-cli-identity.js');
const { recallProvenIdentityContent, forgetProvenIdentityContent, writeSessionIdentity } = await import('../src/core/cli-identity.js');
const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
const { __setPlatformCredentialDepsForTest } = await import('../src/core/platform-credential-source.js');

const ALICE = 'ou_alice';
const SESSION = 'sess-1';
const TURN = 'om_t1';
const BINDING = { platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' };
const NETWORK_DOWN = { ok: false, reason: 'network', error: '连接超时（5000ms）' };
const GRANTED = {
  ok: true,
  value: {
    tool: 'bytedcli', unionId: 'on_alice', expiresAt: Date.now() + 3_600_000,
    variables: { BYTEDCLI_USER_CLOUD_JWT: 'cloud-jwt', BYTEDCLI_USER_CODE_JWT: 'code-jwt' },
  },
};

let dir: string;
let grantCalls: number;
let responses: any[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-04T10:00:00Z'));
  dir = mkdtempSync(join(tmpdir(), 'botmux-transient-retry-'));
  grantCalls = 0;
  responses = [];
  __resetTransientRefusalsForTest();
  __setPlatformCredentialDepsForTest({
    readBinding: () => BINDING,
    resolveUnionId: async () => 'on_alice',
    requestGrant: async () => { grantCalls++; return responses.length > 1 ? responses.shift() : responses[0]; },
  });
});
afterEach(() => {
  __setPlatformCredentialDepsForTest(null);
  __resetTransientRefusalsForTest();
  forgetProvenIdentityContent(dir, SESSION);
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const config = {
  larkAppId: 'cli_bot', larkAppSecret: 'secret', brand: 'feishu' as const,
  triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'platform' }) ?? undefined,
} as any;
const prepare = () => publishTurnCliIdentity({
  botConfig: config, sessionDataDir: dir, sessionId: SESSION, senderOpenId: ALICE, turnId: TURN, storageModel: 'proven',
});
const current = (tool: 'bytedcli' | 'codebase' = 'bytedcli') => recallProvenIdentityContent(dir, SESSION, TURN, tool) ?? '';
const retry = () => retryTransientTurnIdentity({ sessionDataDir: dir, sessionId: SESSION, turnId: TURN, tool: 'bytedcli' });
const later = (ms = TRANSIENT_REFUSAL_RETRY_INTERVAL_MS) => vi.setSystemTime(Date.now() + ms);

describe('transient platform refusal within a turn', () => {
  it('a later call in the same turn re-asks the platform and gets the grant', async () => {
    responses = [NETWORK_DOWN, GRANTED];
    const out = await prepare();
    expect(out.find(o => o.tool === 'bytedcli')?.state).toBe('unavailable');
    expect(current()).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(grantCalls).toBe(1);

    // Immediately after the failure: rate-limited, nothing asked.
    await retry();
    expect(grantCalls).toBe(1);

    later();
    await retry();
    expect(grantCalls).toBe(2);
    expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
    expect(current()).not.toContain("BOTMUX_IDENTITY_MODE='denied'");
    // The Codebase companion follows bytedcli.
    expect(current('codebase')).not.toContain("BOTMUX_IDENTITY_MODE='denied'");

    // Recovered: no further platform calls for this turn.
    later();
    await retry();
    expect(grantCalls).toBe(2);
  });

  it('an answer about the person (not authorized) is final and is never re-asked', async () => {
    responses = [{ ok: false, reason: 'not_authorized', error: 'credential_not_found' }];
    const out = await prepare();
    expect(out.find(o => o.tool === 'bytedcli')?.state).toBe('needs-authorization');
    later();
    await retry();
    expect(grantCalls).toBe(1);
  });

  it('a retry that now gets a definite answer publishes it and stops retrying', async () => {
    responses = [NETWORK_DOWN, { ok: false, reason: 'not_authorized', error: 'credential_not_found', authorizeUrl: 'https://platform.example.test/credentials' }];
    await prepare();
    const transient = current();
    later();
    await retry();
    expect(grantCalls).toBe(2);
    expect(current()).not.toBe(transient);
    expect(current()).toContain('https://platform.example.test/credentials');
    later();
    await retry();
    expect(grantCalls).toBe(2);
  });

  it('never overwrites a publication that replaced the refusal while the retry was in flight', async () => {
    responses = [NETWORK_DOWN];
    await prepare();
    later();
    let release!: (v: unknown) => void;
    __setPlatformCredentialDepsForTest({
      readBinding: () => BINDING,
      resolveUnionId: async () => 'on_alice',
      requestGrant: () => { grantCalls++; return new Promise(r => { release = r; }) as any; },
    });
    const pending = retry();
    await vi.waitFor(() => expect(grantCalls).toBe(2));
    // Meanwhile the turn's identity is withdrawn (e.g. revocation) and something else published.
    writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', mode: 'denied', turnId: TURN, message: 'revoked' }, 'proven');
    release(GRANTED);
    await pending;
    expect(current()).toContain('revoked');
    expect(current()).not.toContain('cloud-jwt');
  });

  it('does nothing once the turn material is gone', async () => {
    responses = [NETWORK_DOWN, GRANTED];
    await prepare();
    forgetProvenIdentityContent(dir, SESSION, TURN);
    later();
    await retry();
    expect(grantCalls).toBe(1);
    expect(current()).toBe('');
  });

  it('concurrent wrapper calls share one platform request and each one sees its answer', async () => {
    responses = [NETWORK_DOWN];
    await prepare();
    later();
    let release!: (v: unknown) => void;
    __setPlatformCredentialDepsForTest({
      readBinding: () => BINDING,
      resolveUnionId: async () => 'on_alice',
      requestGrant: () => { grantCalls++; return new Promise(r => { release = r; }) as any; },
    });
    // What each caller would serve the wrapper the moment its retry settles.
    const seen = [retry(), retry(), retry()].map(p => p.then(() => current()));
    await vi.waitFor(() => expect(grantCalls).toBe(2));
    release(GRANTED);
    const bodies = await Promise.all(seen);
    expect(grantCalls).toBe(2);
    for (const body of bodies) expect(body).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
  });

  it('stops after a bounded number of re-asks while the platform stays down', async () => {
    responses = [NETWORK_DOWN];
    await prepare();
    for (let i = 0; i < TRANSIENT_REFUSAL_MAX_RETRIES + 3; i++) {
      later();
      await retry();
    }
    expect(grantCalls).toBe(1 + TRANSIENT_REFUSAL_MAX_RETRIES);
    expect(current()).toContain("BOTMUX_IDENTITY_MODE='denied'");
  });

  it('the single-file model publishes the refusal as before and registers nothing', async () => {
    responses = [NETWORK_DOWN, GRANTED];
    await publishTurnCliIdentity({
      botConfig: config, sessionDataDir: dir, sessionId: SESSION, senderOpenId: ALICE, turnId: TURN, storageModel: 'single',
    });
    later();
    await retry();
    expect(grantCalls).toBe(1);
  });
});
