/**
 * A turn whose platform grant failed transiently (no answer, reset, timeout)
 * must not stay refused for the whole turn: in the proven model the daemon
 * re-asks the platform when the wrapper next fetches the refusal. The same
 * holds for "not authorized yet": the person can authorize mid-turn (#3312).
 *
 * Run:  npx vitest run --project unit test/turn-cli-identity-transient-retry.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/user-token.js', () => ({
  // im/lark/client.ts imports this (attachment download); bun rejects a mock
  // missing an imported export at link time.
  resolveUserTokenWithScopes: vi.fn(async () => null),
  resolveUserToken: vi.fn(async () => null),
  lookupAuthorizedUserName: vi.fn(() => undefined),
  isUsableOpenId: (openId: unknown) => typeof openId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(openId),
}));
const localTrackRenewal = vi.fn();
vi.mock('../src/core/bytedcli-identity-renewal.js', () => ({
  trackBytedcliIdentityRenewal: (...args: unknown[]) => localTrackRenewal(...args),
}));
vi.mock('../src/services/bytedcli-auth.js', () => ({
  renewBytedcliJwts: vi.fn(async () => null),
  mintBytedcliJwts: vi.fn(async () => null),
  beginBytedcliLogin: vi.fn(async () => ({ authUrl: 'https://cloud.example.test/local', completeToken: 'tok' })),
}));
let authEpoch = 0;
vi.mock('../src/services/cli-auth-epoch.js', () => ({
  readCliAuthEpoch: () => authEpoch,
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
  TRANSIENT_REFUSAL_WAIT_CAP_MS,
  NOT_AUTHORIZED_RETRY_INTERVAL_MS,
  NOT_AUTHORIZED_MAX_RETRIES,
} = await import('../src/core/turn-cli-identity.js');
const { recallProvenIdentityContent, forgetProvenIdentityContent, writeSessionIdentity } = await import('../src/core/cli-identity.js');
const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
const { __setPlatformCredentialDepsForTest } = await import('../src/core/platform-credential-source.js');
const { TOTAL_BUDGET_MS } = await import('../src/platform/credential-grant-budget.js');

const ALICE = 'ou_alice';
const SESSION = 'sess-1';
const TURN = 'om_t1';
const BINDING = { platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' };
const NETWORK_DOWN = { ok: false, reason: 'network', error: '连接超时（5000ms）' };
const NOT_AUTHORIZED = { ok: false, reason: 'not_authorized', error: 'credential_not_found', authorizeUrl: 'https://platform.example.test/credentials' };
const CONSENT_MISSING = { ok: false, reason: 'consent_missing', error: 'consent_missing', authorizeUrl: 'https://platform.example.test/credentials?consent=1' };
const NOT_TEAMMATE = { ok: false, reason: 'not_teammate', error: 'not_teammate' };
const FORBIDDEN = { ok: false, reason: 'forbidden', status: 403, error: 'machine_forbidden' };
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
  authEpoch = 0;
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
const retry = (botConfig: any = config, currentPolicy?: () => any) =>
  retryTransientTurnIdentity({
    sessionDataDir: dir, sessionId: SESSION, turnId: TURN, tool: 'bytedcli', botConfig,
    ...(currentPolicy ? { currentPolicy } : {}),
  });
const hangingGrants = () => {
  let release!: (v: unknown) => void;
  __setPlatformCredentialDepsForTest({
    readBinding: () => BINDING,
    resolveUnionId: async () => 'on_alice',
    requestGrant: () => { grantCalls++; return new Promise(r => { release = r; }) as any; },
  });
  return (v: unknown) => release(v);
};
const later = (ms = TRANSIENT_REFUSAL_RETRY_INTERVAL_MS) => vi.setSystemTime(Date.now() + ms);

describe('unattended turns', () => {
  const SCHEDULED = 'schedule:abc12345:11111111-1111-1111-1111-111111111111';
  const prepareUnattended = () => publishTurnCliIdentity({
    botConfig: config, sessionDataDir: dir, sessionId: SESSION, senderOpenId: ALICE, turnId: SCHEDULED, storageModel: 'proven',
  });
  const retryUnattended = () => retryTransientTurnIdentity({
    sessionDataDir: dir, sessionId: SESSION, turnId: SCHEDULED, tool: 'bytedcli', botConfig: config,
  });
  const now = () => recallProvenIdentityContent(dir, SESSION, SCHEDULED, 'bytedcli') ?? '';

  it('a definite not_authorized is published as the unattended refusal and never re-armed', async () => {
    responses = [NOT_AUTHORIZED];
    await prepareUnattended();
    expect(now()).toContain('[reason=unattended]');
    await retryUnattended();
    expect(grantCalls).toBe(1);
  });

  it('an outage is re-asked; when the answer is not_authorized it becomes the unattended refusal and stays', async () => {
    responses = [NETWORK_DOWN, NOT_AUTHORIZED];
    await prepareUnattended();
    expect(now()).toContain("BOTMUX_IDENTITY_MODE='denied'");
    await retryUnattended();
    expect(grantCalls).toBe(2);
    expect(now()).toContain('[reason=unattended]');
    expect(now()).not.toContain('https://');
    later(NOT_AUTHORIZED_RETRY_INTERVAL_MS + 1);
    await retryUnattended();
    expect(grantCalls).toBe(2);
  });
});

describe('transient platform refusal within a turn', () => {
  it('a later call in the same turn re-asks the platform and gets the grant', async () => {
    responses = [NETWORK_DOWN, GRANTED];
    const out = await prepare();
    expect(out.find(o => o.tool === 'bytedcli')?.state).toBe('unavailable');
    expect(current()).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(grantCalls).toBe(1);

    // The turn's first call re-asks right away (preparing already waited a full budget).
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

  it('after the first re-ask, further ones are spaced out', async () => {
    responses = [NETWORK_DOWN];
    await prepare();
    await retry();
    expect(grantCalls).toBe(2);
    later(TRANSIENT_REFUSAL_RETRY_INTERVAL_MS - 1);
    await retry();
    expect(grantCalls).toBe(2);
    later(1);
    await retry();
    expect(grantCalls).toBe(3);
  });

  it.each([['not a teammate', NOT_TEAMMATE], ['forbidden', FORBIDDEN]] as const)(
    'an answer about the person that cannot change mid-turn (%s) is final and is never re-asked', async (_label, answer) => {
      responses = [answer];
      const out = await prepare();
      expect(out.find(o => o.tool === 'bytedcli')?.state).toBe('needs-authorization');
      later(NOT_AUTHORIZED_RETRY_INTERVAL_MS);
      await retry();
      expect(grantCalls).toBe(1);
    });

  it('a retry that now gets a final answer about the person publishes it and stops retrying', async () => {
    responses = [NETWORK_DOWN, NOT_TEAMMATE];
    await prepare();
    const transient = current();
    later();
    await retry();
    expect(grantCalls).toBe(2);
    expect(current()).not.toBe(transient);
    later(NOT_AUTHORIZED_RETRY_INTERVAL_MS);
    await retry();
    expect(grantCalls).toBe(2);
  });

  it('a retry that now gets "not authorized" publishes it and keeps asking on the not-authorized pace', async () => {
    responses = [NETWORK_DOWN, NOT_AUTHORIZED, GRANTED];
    await prepare();
    later();
    await retry();
    expect(grantCalls).toBe(2);
    expect(current()).toContain('[reason=platform_not_authorized]');
    later(); // the outage pace no longer applies
    await retry();
    expect(grantCalls).toBe(2);
    later(NOT_AUTHORIZED_RETRY_INTERVAL_MS);
    await retry();
    expect(grantCalls).toBe(3);
    expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
  });

});

describe('not authorized yet within a turn (#3312)', () => {
  it('the person authorizes mid-turn and a later call in the same turn gets the grant', async () => {
    responses = [NOT_AUTHORIZED, GRANTED];
    const out = await prepare();
    expect(out.find(o => o.tool === 'bytedcli')?.state).toBe('needs-authorization');
    expect(current()).toContain('[reason=platform_not_authorized]');
    expect(current()).not.toContain('https://');
    // The refusal was itself just asked: no re-ask before the spacing has passed.
    await retry();
    later(NOT_AUTHORIZED_RETRY_INTERVAL_MS - 1);
    await retry();
    expect(grantCalls).toBe(1);
    later(1);
    await retry();
    expect(grantCalls).toBe(2);
    expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
    expect(current('codebase')).not.toContain("BOTMUX_IDENTITY_MODE='denied'");
    later(NOT_AUTHORIZED_RETRY_INTERVAL_MS);
    await retry();
    expect(grantCalls).toBe(2); // recovered: nothing more to ask
  });

  it('a forced re-ask skips the spacing once: the platform just said nothing is missing', async () => {
    responses = [CONSENT_MISSING, GRANTED];
    await prepare();
    await retryTransientTurnIdentity({
      sessionDataDir: dir, sessionId: SESSION, turnId: TURN, tool: 'bytedcli', botConfig: config, force: true,
    });
    expect(grantCalls).toBe(2);
    expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
  });

  it('a forced re-ask that still finds the same refusal keeps pacing the following ones', async () => {
    responses = [NOT_AUTHORIZED];
    await prepare();
    await retryTransientTurnIdentity({
      sessionDataDir: dir, sessionId: SESSION, turnId: TURN, tool: 'bytedcli', botConfig: config, force: true,
    });
    await retry();
    expect(grantCalls).toBe(2);
  });

  it('keeps the same refusal while they have not authorized, and stops after a bounded number of re-asks', async () => {
    responses = [NOT_AUTHORIZED];
    await prepare();
    const refusal = current();
    for (let i = 1; i <= NOT_AUTHORIZED_MAX_RETRIES + 2; i++) {
      later(NOT_AUTHORIZED_RETRY_INTERVAL_MS);
      await retry();
      expect(current()).toBe(refusal);
    }
    expect(grantCalls).toBe(1 + NOT_AUTHORIZED_MAX_RETRIES);
  });

  it('switches the refusal to the consent step when that is what is missing now, and still recovers', async () => {
    responses = [NOT_AUTHORIZED, CONSENT_MISSING, GRANTED];
    await prepare();
    const notAuthorized = current();
    later(NOT_AUTHORIZED_RETRY_INTERVAL_MS);
    await retry();
    expect(current()).not.toBe(notAuthorized);
    expect(current()).toContain('[reason=platform_consent_missing]');
    later(NOT_AUTHORIZED_RETRY_INTERVAL_MS);
    await retry();
    expect(grantCalls).toBe(3);
    expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
  });

  it('a revocation of the person\'s credentials during the turn ends the re-asks', async () => {
    responses = [NOT_AUTHORIZED, GRANTED];
    await prepare();
    authEpoch++;
    later(NOT_AUTHORIZED_RETRY_INTERVAL_MS);
    await retry();
    expect(grantCalls).toBe(1);
    expect(current()).toContain("BOTMUX_IDENTITY_MODE='denied'");
  });

  it('the single-file model publishes the refusal as before and registers nothing', async () => {
    responses = [NOT_AUTHORIZED, GRANTED];
    await publishTurnCliIdentity({
      botConfig: config, sessionDataDir: dir, sessionId: SESSION, senderOpenId: ALICE, turnId: TURN, storageModel: 'single',
    });
    later(NOT_AUTHORIZED_RETRY_INTERVAL_MS);
    await retry();
    expect(grantCalls).toBe(1);
  });
});

describe('transient platform refusal within a turn: concurrency and policy', () => {
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

  it('a wrapper never waits on a slow re-ask past the cap; the late answer serves the next call', async () => {
    responses = [NETWORK_DOWN];
    await prepare();
    const release = hangingGrants();
    const now = Date.now();
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let settled = false;
    const first = retry().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(TRANSIENT_REFUSAL_WAIT_CAP_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(current()).toContain("BOTMUX_IDENTITY_MODE='denied'");
    release(GRANTED);
    await vi.waitFor(() => expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'"));
    expect(grantCalls).toBe(2);
  });

  it('a re-ask that takes a whole platform grant budget still answers the wrapper waiting on it', async () => {
    responses = [NETWORK_DOWN];
    await prepare();
    const release = hangingGrants();
    const now = Date.now();
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let served: string | undefined;
    const waiting = retry().then(() => { served = current(); });
    await vi.waitFor(() => expect(grantCalls).toBe(2));
    // The platform answers on the grant client's last millisecond.
    setTimeout(() => release(GRANTED), TOTAL_BUDGET_MS);
    await vi.advanceTimersByTimeAsync(TOTAL_BUDGET_MS);
    await waiting;
    expect(served).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
    expect(TRANSIENT_REFUSAL_WAIT_CAP_MS).toBeGreaterThan(TOTAL_BUDGET_MS);
  });

  it('a policy changed mid-turn ends the re-asks instead of fetching under the old one', async () => {
    responses = [NETWORK_DOWN, GRANTED];
    await prepare();
    const nowLocal = { ...config, triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'local' }) };
    await retry(nowLocal);
    expect(grantCalls).toBe(1);
    await retry();
    expect(grantCalls).toBe(1);
    const off = { ...config, triggerUserAuth: undefined };
    responses = [NETWORK_DOWN, GRANTED];
    await prepare();
    await retry(off);
    expect(grantCalls).toBe(2);
    expect(current()).toContain("BOTMUX_IDENTITY_MODE='denied'");
  });

  it('a revocation of the person\'s credentials during the turn ends the re-asks', async () => {
    responses = [NETWORK_DOWN, GRANTED];
    await prepare();
    authEpoch++;
    await retry();
    expect(grantCalls).toBe(1);
    expect(current()).not.toContain('cloud-jwt');
  });

  it('a revocation while the re-ask is in flight is not overwritten', async () => {
    responses = [NETWORK_DOWN];
    await prepare();
    const release = hangingGrants();
    const pending = retry();
    await vi.waitFor(() => expect(grantCalls).toBe(2));
    authEpoch++;
    release(GRANTED);
    await pending;
    expect(current()).not.toContain('cloud-jwt');
  });

  // ─── The in-flight window: the policy is re-read AFTER the platform answers ───
  //
  // Dashboard replaces the whole bot config object, so a snapshot cannot observe
  // an edit made while an attempt is waiting on the platform. These cases hold
  // the platform request open, change the policy, then release it.

  /** Prepare a turn, start a re-ask and hold it in flight; returns the release. */
  const startHeldRetry = async (opts: { botConfig?: any; currentPolicy: () => any }) => {
    responses = [NETWORK_DOWN];
    await prepare();
    const release = hangingGrants();
    const pending = retry(opts.botConfig ?? config, opts.currentPolicy);
    await vi.waitFor(() => expect(grantCalls).toBe(2));
    return { release, pending };
  };
  const localPolicy = () => parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'local' });
  const autoPolicy = () => parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'auto' });
  const platformPolicy = () => parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'platform' });
  const toolOffPolicy = () => parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli'], credentialSource: 'platform' });

  it('does not write a grant acquired while the bot was switched to local credentials', async () => {
    let policy = platformPolicy();
    const { release, pending } = await startHeldRetry({ currentPolicy: () => policy });
    policy = localPolicy();     // operator switches the bot mid-flight
    const before = current();
    release(GRANTED);
    await pending;
    expect(current()).not.toContain('cloud-jwt');
    expect(current()).toBe(before);   // the turn keeps the refusal it had
  });

  it('does not write a grant acquired while the tool was taken out of the policy', async () => {
    let policy = platformPolicy();
    const { release, pending } = await startHeldRetry({ currentPolicy: () => policy });
    policy = toolOffPolicy();   // bytedcli no longer governed
    const before = current();
    release(GRANTED);
    await pending;
    expect(current()).not.toContain('cloud-jwt');
    expect(current()).toBe(before);
  });

  it('does not write a grant acquired while the whole policy was switched off', async () => {
    let policy: any = platformPolicy();
    const { release, pending } = await startHeldRetry({ currentPolicy: () => policy });
    policy = undefined;         // triggerUserAuth.enabled = false
    const before = current();
    release(GRANTED);
    await pending;
    expect(current()).not.toContain('cloud-jwt');
    expect(current()).toBe(before);
  });

  it('stops asking (and drops the entry) when the bot no longer governs the tool', async () => {
    let policy: any = platformPolicy();
    const { release, pending } = await startHeldRetry({ currentPolicy: () => policy });
    policy = localPolicy();
    release(GRANTED);
    await pending;
    // The entry is gone: a later call must not re-ask at all.
    const callsBefore = grantCalls;
    later();
    await retry(config, () => policy);
    expect(grantCalls).toBe(callsBefore);
  });

  it('a bot config reader that throws (bot removed) is treated as no longer governed', async () => {
    // Both windows refuse. Before an attempt: no platform call is made at all.
    responses = [NETWORK_DOWN, GRANTED];
    await prepare();
    const before = current();
    const throwing = () => { throw new Error('Bot not registered: cli_bot'); };
    await retry(config, throwing);
    expect(grantCalls).toBe(1);
    expect(current()).toBe(before);
    // And a later call cannot revive it: the entry was dropped.
    await retry(config, () => platformPolicy());
    expect(grantCalls).toBe(1);
    expect(current()).toBe(before);
  });

  it('still writes the grant when the source was switched to auto mid-flight', async () => {
    // auto still takes credentials from the platform, so this is NOT a change of
    // intent: blocking it would be the opposite bug (a needless refusal).
    let policy = platformPolicy();
    const { release, pending } = await startHeldRetry({ currentPolicy: () => policy });
    policy = autoPolicy();
    release(GRANTED);
    await pending;
    expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
  });

  it('an older attempt finishing does not erase the entry of a republished refusal', async () => {
    responses = [NETWORK_DOWN];
    await prepare();
    const release = hangingGrants();
    const old = retry();
    await vi.waitFor(() => expect(grantCalls).toBe(2));
    // The same turn is prepared again (e.g. replay after a storage-model switch); still down.
    __setPlatformCredentialDepsForTest({
      readBinding: () => BINDING, resolveUnionId: async () => 'on_alice',
      requestGrant: async () => { grantCalls++; return NETWORK_DOWN as any; },
    });
    await prepare();
    expect(grantCalls).toBe(3);
    release(NETWORK_DOWN);
    await old;
    __setPlatformCredentialDepsForTest({
      readBinding: () => BINDING, resolveUnionId: async () => 'on_alice',
      requestGrant: async () => { grantCalls++; return GRANTED as any; },
    });
    await retry();
    expect(grantCalls).toBe(4);
    expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
  });

  it('a machine unbound mid-turn keeps the refusal and stops asking', async () => {
    responses = [NETWORK_DOWN];
    await prepare();
    const before = current();
    let readBindingCalls = 0;
    __setPlatformCredentialDepsForTest({
      readBinding: () => { readBindingCalls++; return null; },
      resolveUnionId: async () => 'on_alice',
      requestGrant: async () => { grantCalls++; return GRANTED as any; },
    });
    await retry();
    expect(readBindingCalls).toBe(1);
    expect(current()).toBe(before);
    later();
    await retry();
    expect(readBindingCalls).toBe(1);
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

describe('the Meego switch on the retry path', () => {
  const recovered = async (capabilities: string[]) => {
    responses = [NETWORK_DOWN, GRANTED];
    const botConfig = {
      ...config,
      triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, capabilities, credentialSource: 'platform' }),
    };
    await publishTurnCliIdentity({
      botConfig, sessionDataDir: dir, sessionId: SESSION, senderOpenId: ALICE, turnId: TURN, storageModel: 'proven',
    });
    await retry(botConfig);
    return current();
  };

  it('meego off: the recovered platform grant carries no Meego store', async () => {
    const body = await recovered(['bytecloud']);
    expect(body).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
    expect(body).not.toContain('BOTMUX_MEEGO_HOME');
  });

  it('the live policy decides: Meego switched off during the wait leaves no Meego store', async () => {
    responses = [NETWORK_DOWN, GRANTED];
    const on = { ...config, triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, capabilities: ['bytecloud', 'meego'], credentialSource: 'platform' }) };
    await publishTurnCliIdentity({
      botConfig: on, sessionDataDir: dir, sessionId: SESSION, senderOpenId: ALICE, turnId: TURN, storageModel: 'proven',
    });
    await retry(on, () => parseTriggerUserAuthConfig({ enabled: true, capabilities: ['bytecloud'], credentialSource: 'platform' }));
    expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
    expect(current()).not.toContain('BOTMUX_MEEGO_HOME');
  });

  it('meego on: the recovered platform grant carries the person\'s Meego store', async () => {
    expect(await recovered(['bytecloud', 'meego'])).toContain('BOTMUX_MEEGO_HOME=');
  });
});

describe('person turns: the publication fence also guards the retry write', () => {
  const PERSON_TURN = 'trg_runas_retry';
  const publishWithFence = (validateBeforeWrite: () => boolean) => publishTurnCliIdentity({
    botConfig: config, sessionDataDir: dir, sessionId: SESSION, senderOpenId: ALICE, turnId: PERSON_TURN,
    storageModel: 'proven', validateBeforeWrite,
  });
  const body = () => recallProvenIdentityContent(dir, SESSION, PERSON_TURN, 'bytedcli') ?? '';
  const retryPerson = () => retryTransientTurnIdentity({
    sessionDataDir: dir, sessionId: SESSION, turnId: PERSON_TURN, tool: 'bytedcli', botConfig: config,
  });

  it('does not write the recovered credential once the fence turns false', async () => {
    responses = [NETWORK_DOWN, GRANTED];
    let admitted = true;
    await publishWithFence(() => admitted);
    expect(body()).toContain("BOTMUX_IDENTITY_MODE='denied'");
    admitted = false;
    await retryPerson();
    expect(grantCalls).toBe(2);
    expect(body()).not.toContain('cloud-jwt');
    expect(body()).toContain("BOTMUX_IDENTITY_MODE='denied'");
  });

  it('still writes the recovered credential while the fence holds', async () => {
    responses = [NETWORK_DOWN, GRANTED];
    await publishWithFence(() => true);
    await retryPerson();
    expect(body()).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
  });
});

describe('transient local bytedcli refusal within a turn', () => {
  const localConfig = {
    larkAppId: 'cli_bot', larkAppSecret: 'secret', brand: 'feishu' as const,
    triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'local' }) ?? undefined,
  } as any;
  const autoConfig = {
    larkAppId: 'cli_bot', larkAppSecret: 'secret', brand: 'feishu' as const,
    triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'auto' }) ?? undefined,
  } as any;

  let mintBytedcliJwts: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const provider = await import('../src/services/bytedcli-auth.js');
    mintBytedcliJwts = vi.mocked(provider.mintBytedcliJwts);
    mintBytedcliJwts.mockReset();
    localTrackRenewal.mockClear();
    __setPlatformCredentialDepsForTest({ readBinding: () => null });
  });

  const prepareLocal = (overrides: Record<string, unknown> = {}) => publishTurnCliIdentity({
    botConfig: localConfig, sessionDataDir: dir, sessionId: SESSION, senderOpenId: ALICE,
    turnId: TURN, storageModel: 'proven', ...overrides,
  } as any);

  it('recovers a local provider_unavailable turn after cooldown and registers renewal', async () => {
    mintBytedcliJwts
      .mockRejectedValueOnce(new Error('bytedcli authorization service unavailable (status)'))
      .mockResolvedValueOnce({ cloudJwt: 'local-recovered-jwt', codeJwt: 'local-code-jwt' });

    const validateBeforeWrite = vi.fn(() => true);
    const outcomes = await prepareLocal({ validateBeforeWrite });
    expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('unavailable');
    expect(current()).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(current()).toContain('[reason=provider_unavailable]');
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(1);

    // Cooldown prevents hammering a local CLI immediately after a 30s timeout.
    await retry(localConfig);
    later(TRANSIENT_REFUSAL_RETRY_INTERVAL_MS - 1);
    await retry(localConfig);
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(1);

    // Once cooldown elapses, the next call in the same turn recovers transparently.
    later(1);
    await retry(localConfig);
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(2);
    expect(current()).toContain("BOTMUX_IDENTITY_MODE='user'");
    expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='local-recovered-jwt'");
    expect(current('codebase')).not.toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(localTrackRenewal).toHaveBeenCalledTimes(1);
    expect(localTrackRenewal).toHaveBeenCalledWith(expect.objectContaining({ validateBeforeWrite }));

    // Recovered: no further mints on later calls.
    later();
    await retry(localConfig);
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(2);
  });

  it('passes the publication fence to renewal after an initial local mint', async () => {
    mintBytedcliJwts.mockResolvedValueOnce({ cloudJwt: 'initial-local-jwt' });
    const validateBeforeWrite = vi.fn(() => true);
    await prepareLocal({ validateBeforeWrite });
    expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='initial-local-jwt'");
    expect(localTrackRenewal).toHaveBeenCalledWith(expect.objectContaining({ validateBeforeWrite }));
  });

  it('stops retrying after TRANSIENT_REFUSAL_MAX_RETRIES while the local provider stays unavailable', async () => {
    mintBytedcliJwts.mockRejectedValue(new Error('bytedcli authorization service unavailable (status)'));
    await prepareLocal();
    for (let i = 0; i < TRANSIENT_REFUSAL_MAX_RETRIES + 3; i++) {
      later();
      await retry(localConfig);
    }
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(1 + TRANSIENT_REFUSAL_MAX_RETRIES);
    expect(current()).toContain('[reason=provider_unavailable]');
  });

  it('paces the next local retry from when a slow failing mint finishes, not when it started', async () => {
    mintBytedcliJwts.mockRejectedValueOnce(new Error('initial timeout'));
    await prepareLocal();
    later();
    mintBytedcliJwts.mockImplementationOnce(async () => {
      later(TOTAL_BUDGET_MS);
      throw new Error('second 30s timeout');
    });
    await retry(localConfig);
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(2);

    // Immediately after the 30s failure finishes, cooldown still holds.
    mintBytedcliJwts.mockResolvedValueOnce({ cloudJwt: 'recovered-after-cooldown' });
    later(TRANSIENT_REFUSAL_RETRY_INTERVAL_MS - 1);
    await retry(localConfig);
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(2);

    later(1);
    await retry(localConfig);
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(3);
    expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='recovered-after-cooldown'");
  });

  it('replaces provider_unavailable with not_authorized (or unattended) and stops when the recovered provider reports no login', async () => {
    mintBytedcliJwts
      .mockRejectedValueOnce(new Error('bytedcli authorization service unavailable (status)'))
      .mockResolvedValueOnce(null);
    await prepareLocal();
    later();
    await retry(localConfig);
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(2);
    expect(current()).toContain('[reason=not_authorized]');
    later();
    await retry(localConfig);
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(2);

    // Unattended turn transitions to [reason=unattended] and stops.
    const scheduled = 'schedule:job2:22222222-2222-2222-2222-222222222222';
    mintBytedcliJwts
      .mockRejectedValueOnce(new Error('bytedcli authorization service unavailable (status)'))
      .mockResolvedValueOnce(null);
    await prepareLocal({ turnId: scheduled });
    later();
    await retryTransientTurnIdentity({
      sessionDataDir: dir, sessionId: SESSION, turnId: scheduled, tool: 'bytedcli', botConfig: localConfig,
    });
    expect(recallProvenIdentityContent(dir, SESSION, scheduled, 'bytedcli')).toContain('[reason=unattended]');
    later();
    await retryTransientTurnIdentity({
      sessionDataDir: dir, sessionId: SESSION, turnId: scheduled, tool: 'bytedcli', botConfig: localConfig,
    });
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(4);
  });

  it('drops the retry entry when authEpoch changes, validateBeforeWrite fails, or policy switches away from local', async () => {
    // 1. authEpoch bump (logout / revoke) ends retries.
    mintBytedcliJwts
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue({ cloudJwt: 'should-not-write' });
    await prepareLocal();
    authEpoch = 1;
    later();
    await retry(localConfig);
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(1);
    expect(current()).toContain('[reason=provider_unavailable]');

    // 2. Policy switched to platform mid-turn drops retries.
    authEpoch = 0;
    mintBytedcliJwts.mockReset();
    mintBytedcliJwts
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue({ cloudJwt: 'should-not-write' });
    await prepareLocal();
    const platformOnly = parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'platform' });
    later();
    await retry(localConfig, () => platformOnly);
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(1);

    // 3. Auto host bound to platform mid-turn drops local retries.
    mintBytedcliJwts.mockReset();
    mintBytedcliJwts
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue({ cloudJwt: 'should-not-write' });
    await prepareLocal({ botConfig: autoConfig });
    __setPlatformCredentialDepsForTest({ readBinding: () => BINDING });
    later();
    await retry(autoConfig);
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(1);

    // 4. validateBeforeWrite turning false prevents writing the recovered credential.
    __setPlatformCredentialDepsForTest({ readBinding: () => null });
    mintBytedcliJwts.mockReset();
    mintBytedcliJwts
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce({ cloudJwt: 'fenced-jwt' });
    let admitted = true;
    await prepareLocal({ validateBeforeWrite: () => admitted });
    admitted = false;
    later();
    await retry(localConfig);
    expect(current()).toContain('[reason=provider_unavailable]');
    expect(current()).not.toContain('fenced-jwt');
  });

  it('does not register local retries for single-file storage or delegated turns', async () => {
    mintBytedcliJwts.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({ cloudJwt: 'x' });
    await prepareLocal({ storageModel: 'single' });
    later();
    await retry(localConfig);
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(1);

    mintBytedcliJwts.mockReset();
    mintBytedcliJwts.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({ cloudJwt: 'x' });
    await prepareLocal({
      delegatedIdentity: {
        credentialOpenId: ALICE, targetOpenId: 'ou_bob', unionId: 'on_alice',
        tools: ['bytedcli'], dispatchRoot: 'om_root',
      },
    });
    later();
    await retry(localConfig);
    expect(mintBytedcliJwts).toHaveBeenCalledTimes(1);
  });
});
