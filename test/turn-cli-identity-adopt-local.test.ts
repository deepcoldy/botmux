/**
 * Local ByteCloud login finished mid-turn: the refusal the turn started with is
 * replaced, so the agent's retry of the refused command runs in the same turn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let minted: { cloudJwt: string } | null = null;
let mintImpl: (() => Promise<{ cloudJwt: string } | null>) | null = null;
let authEpoch = 0;
const trackRenewal = vi.fn();
vi.mock('../src/utils/user-token.js', () => ({
  // im/lark/client.ts imports this (attachment download); bun rejects a mock
  // missing an imported export at link time.
  resolveUserTokenWithScopes: vi.fn(async () => null),
  resolveUserToken: vi.fn(async () => null),
  lookupAuthorizedUserName: vi.fn(() => undefined),
  isUsableOpenId: (openId: unknown) => typeof openId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(openId),
}));
vi.mock('../src/services/bytedcli-auth.js', () => ({
  renewBytedcliJwts: vi.fn(async () => null),
  mintBytedcliJwts: vi.fn(async () => (mintImpl ? mintImpl() : minted)),
  beginBytedcliLogin: vi.fn(async () => ({ authUrl: 'https://cloud.example.test/local', completeToken: 'tok' })),
}));
vi.mock('../src/services/cli-auth-epoch.js', () => ({ readCliAuthEpoch: () => authEpoch }));
vi.mock('../src/core/bytedcli-identity-renewal.js', () => ({
  trackBytedcliIdentityRenewal: (...args: unknown[]) => trackRenewal(...args),
}));
vi.mock('../src/services/lark-cli-auth.js', () => ({
  resolveLarkCliHomeForTurn: vi.fn(async () => null),
  pendingLarkCliChallenge: vi.fn(() => null),
  beginLarkCliLogin: vi.fn(async () => null),
}));

const {
  publishTurnCliIdentity,
  adoptLocalBytedcliAuthorization,
  retryTransientTurnIdentity,
  __resetTransientRefusalsForTest,
  TRANSIENT_REFUSAL_RETRY_INTERVAL_MS,
} = await import('../src/core/turn-cli-identity.js');
const { recallProvenIdentityContent, forgetProvenIdentityContent, writeSessionIdentity } = await import('../src/core/cli-identity.js');
const { rememberLarkToolDelegation, clearLarkToolDelegations } = await import('../src/core/lark-tool-delegation.js');
const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
const { __setPlatformCredentialDepsForTest } = await import('../src/core/platform-credential-source.js');
const bytedcliAuth = await import('../src/services/bytedcli-auth.js');

const ALICE = 'ou_alice';
const BOB = 'ou_bob';
const SESSION = 'sess-1';
const TURN = 'om_t1';
let dir: string;
const config = {
  larkAppId: 'cli_bot', larkAppSecret: 'secret', brand: 'feishu' as const,
  triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'local' }) ?? undefined,
} as any;
const current = (turnId = TURN) => recallProvenIdentityContent(dir, SESSION, turnId, 'bytedcli') ?? '';
const adopt = (overrides: Partial<Parameters<typeof adoptLocalBytedcliAuthorization>[0]> = {}) => adoptLocalBytedcliAuthorization({
  sessionDataDir: dir, sessionId: SESSION, turnId: TURN, botConfig: config, senderOpenId: ALICE, ...overrides,
});

beforeEach(() => {
  minted = null;
  mintImpl = null;
  authEpoch = 0;
  trackRenewal.mockClear();
  vi.mocked(bytedcliAuth.mintBytedcliJwts).mockClear();
  __resetTransientRefusalsForTest();
  __setPlatformCredentialDepsForTest({ readBinding: () => null });
  dir = mkdtempSync(join(tmpdir(), 'botmux-adopt-'));
});
afterEach(() => {
  __setPlatformCredentialDepsForTest(null);
  __resetTransientRefusalsForTest();
  clearLarkToolDelegations(dir, SESSION);
  forgetProvenIdentityContent(dir, SESSION);
  rmSync(dir, { recursive: true, force: true });
});

describe('adoptLocalBytedcliAuthorization', () => {
  const refuse = () => publishTurnCliIdentity({
    botConfig: config, sessionDataDir: dir, sessionId: SESSION, senderOpenId: ALICE, turnId: TURN,
    storageModel: 'proven', privateChat: false,
  } as any);

  it('group turn refused for lack of a login picks the login up once it is finished', async () => {
    await refuse();
    expect(current()).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(current()).toContain('[reason=not_authorized]');

    expect(await adopt()).toBe('none');
    expect(current()).toContain("BOTMUX_IDENTITY_MODE='denied'");

    minted = { cloudJwt: 'cloud-jwt' };
    expect(await adopt()).toBe('adopted');
    expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
    expect(current()).not.toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(trackRenewal).toHaveBeenCalledTimes(1);
    expect(await adopt()).toBe('already');
  });

  it('adopts a recovered local bytedcli identity when the turn started with [reason=provider_unavailable]', async () => {
    mintImpl = async () => { throw new Error('bytedcli authorization service unavailable (status)'); };
    const outcomes = await refuse();
    expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('unavailable');
    expect(current()).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(current()).toContain('[reason=provider_unavailable]');

    mintImpl = null;
    minted = { cloudJwt: 'recovered-jwt' };
    expect(await adopt()).toBe('adopted');
    expect(current()).toContain("BOTMUX_IDENTITY_MODE='user'");
    expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='recovered-jwt'");
    expect(current()).not.toContain('[reason=provider_unavailable]');
    expect(trackRenewal).toHaveBeenCalledTimes(1);

    // Adoption clears any queued local transient retry so later calls do not re-mint.
    const callsAfterAdopt = vi.mocked(bytedcliAuth.mintBytedcliJwts).mock.calls.length;
    await retryTransientTurnIdentity({
      sessionDataDir: dir, sessionId: SESSION, turnId: TURN, tool: 'bytedcli', botConfig: config, force: true,
    });
    expect(vi.mocked(bytedcliAuth.mintBytedcliJwts).mock.calls.length).toBe(callsAfterAdopt);
    expect(TRANSIENT_REFUSAL_RETRY_INTERVAL_MS).toBeGreaterThan(0);
  });

  it.each([
    'unattended',
    'no_sender',
    'platform_not_teammate',
    'platform_forbidden',
    'platform_not_authorized',
    'platform_consent_missing',
    'platform_unavailable',
    'platform_unbound',
  ])('does not replace a [reason=%s] refusal with a local login', async reason => {
    writeSessionIdentity(dir, SESSION, {
      tool: 'bytedcli', mode: 'denied', turnId: TURN, openId: ALICE, message: `botmux: refused\n[reason=${reason}]`,
    } as any, 'proven');
    minted = { cloudJwt: 'cloud-jwt' };
    expect(await adopt()).toBe('none');
    expect(current()).toContain(`[reason=${reason}]`);
    expect(current()).not.toContain('cloud-jwt');
    expect(trackRenewal).not.toHaveBeenCalled();
  });

  it('refuses unattended turns, delegated turns, and cross-principal snapshots', async () => {
    minted = { cloudJwt: 'cloud-jwt' };
    const scheduledTurn = 'schedule:job1:11111111-1111-1111-1111-111111111111';
    writeSessionIdentity(dir, SESSION, {
      tool: 'bytedcli', mode: 'denied', turnId: scheduledTurn, openId: ALICE,
      message: 'botmux: unavailable\n[reason=provider_unavailable]',
    } as any, 'proven');
    expect(await adopt({ turnId: scheduledTurn })).toBe('none');
    expect(current(scheduledTurn)).toContain('[reason=provider_unavailable]');

    writeSessionIdentity(dir, SESSION, {
      tool: 'bytedcli', mode: 'denied', turnId: TURN, openId: ALICE,
      message: 'botmux: unavailable\n[reason=provider_unavailable]',
    } as any, 'proven');
    rememberLarkToolDelegation(dir, SESSION, TURN, {
      credentialOpenId: ALICE, targetOpenId: BOB, unionId: 'on_alice',
      tools: ['bytedcli'], dispatchRoot: 'om_root',
    });
    expect(await adopt()).toBe('none');
    expect(current()).toContain('[reason=provider_unavailable]');
    clearLarkToolDelegations(dir, SESSION);

    // Another person's snapshot (denied or already user) is never adopted or reported ready.
    expect(await adopt({ senderOpenId: BOB })).toBe('none');
    writeSessionIdentity(dir, SESSION, {
      tool: 'bytedcli', cloudJwt: 'alice-jwt', turnId: TURN, openId: ALICE,
    } as any, 'proven');
    expect(await adopt({ senderOpenId: BOB })).toBe('none');
  });

  it('leaves a turn that holds no adoptable refusal alone', async () => {
    minted = { cloudJwt: 'cloud-jwt' };
    expect(await adopt()).toBe('none');
    expect(current()).toBe('');
  });

  it('returns unavailable without throwing when re-minting hits a second transient failure', async () => {
    writeSessionIdentity(dir, SESSION, {
      tool: 'bytedcli', mode: 'denied', turnId: TURN, openId: ALICE,
      message: 'botmux: unavailable\n[reason=provider_unavailable]',
    } as any, 'proven');
    mintImpl = async () => { throw new Error('bytedcli authorization service unavailable (mint personal JWT)'); };
    expect(await adopt()).toBe('unavailable');
    expect(current()).toContain('[reason=provider_unavailable]');
    expect(trackRenewal).not.toHaveBeenCalled();
  });

  it('aborts on CAS mismatch when the turn identity changes or the user revokes auth mid-mint', async () => {
    writeSessionIdentity(dir, SESSION, {
      tool: 'bytedcli', mode: 'denied', turnId: TURN, openId: ALICE,
      message: 'botmux: unavailable\n[reason=provider_unavailable]',
    } as any, 'proven');

    // Concurrent rewrite to another refusal prevents writing the stale mint.
    let release!: (value: { cloudJwt: string } | null) => void;
    mintImpl = () => new Promise(resolve => { release = resolve; });
    const pending = adopt();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    writeSessionIdentity(dir, SESSION, {
      tool: 'bytedcli', mode: 'denied', turnId: TURN, openId: ALICE,
      message: 'botmux: revoked\n[reason=platform_forbidden]',
    } as any, 'proven');
    release({ cloudJwt: 'stale-jwt' });
    expect(await pending).toBe('superseded');
    expect(current()).toContain('[reason=platform_forbidden]');
    expect(current()).not.toContain('stale-jwt');

    // Logout / revocation bumping authEpoch during mint also prevents writing.
    writeSessionIdentity(dir, SESSION, {
      tool: 'bytedcli', mode: 'denied', turnId: TURN, openId: ALICE,
      message: 'botmux: unavailable\n[reason=provider_unavailable]',
    } as any, 'proven');
    let releaseRevoke!: (value: { cloudJwt: string } | null) => void;
    mintImpl = () => new Promise(resolve => { releaseRevoke = resolve; });
    const pendingRevoke = adopt();
    await vi.waitFor(() => expect(releaseRevoke).toBeTypeOf('function'));
    authEpoch = 1;
    releaseRevoke({ cloudJwt: 'post-logout-jwt' });
    expect(await pendingRevoke).toBe('superseded');
    expect(current()).toContain('[reason=provider_unavailable]');
    expect(current()).not.toContain('post-logout-jwt');
  });

  it('returns already if another concurrent recovery installed the same sender identity mid-mint', async () => {
    writeSessionIdentity(dir, SESSION, {
      tool: 'bytedcli', mode: 'denied', turnId: TURN, openId: ALICE,
      message: 'botmux: unavailable\n[reason=provider_unavailable]',
    } as any, 'proven');
    let release!: (value: { cloudJwt: string } | null) => void;
    mintImpl = () => new Promise(resolve => { release = resolve; });
    const pending = adopt();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    writeSessionIdentity(dir, SESSION, {
      tool: 'bytedcli', cloudJwt: 'concurrent-winner-jwt', turnId: TURN, openId: ALICE,
    } as any, 'proven');
    release({ cloudJwt: 'second-jwt' });
    expect(await pending).toBe('already');
    expect(current()).toContain("BYTEDCLI_USER_CLOUD_JWT='concurrent-winner-jwt'");
  });

  it('reports superseded when the live policy no longer allows local adoption', async () => {
    writeSessionIdentity(dir, SESSION, {
      tool: 'bytedcli', mode: 'denied', turnId: TURN, openId: ALICE,
      message: 'botmux: unavailable\n[reason=provider_unavailable]',
    } as any, 'proven');
    minted = { cloudJwt: 'must-not-mint' };
    expect(await adopt({
      currentPolicy: () => parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'platform' }),
    })).toBe('superseded');
    expect(current()).toContain('[reason=provider_unavailable]');
    expect(bytedcliAuth.mintBytedcliJwts).not.toHaveBeenCalled();
  });

  it('refuses adoption if live policy disables bytecloud or switches to platform mid-mint', async () => {
    writeSessionIdentity(dir, SESSION, {
      tool: 'bytedcli', mode: 'denied', turnId: TURN, openId: ALICE,
      message: 'botmux: unavailable\n[reason=provider_unavailable]',
    } as any, 'proven');
    let livePolicy = parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'local' }) ?? undefined;
    let release!: (value: { cloudJwt: string } | null) => void;
    mintImpl = () => new Promise(resolve => { release = resolve; });
    const pending = adopt({ currentPolicy: () => livePolicy });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    livePolicy = parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'platform' }) ?? undefined;
    release({ cloudJwt: 'should-not-write' });
    expect(await pending).toBe('superseded');
    expect(current()).toContain('[reason=provider_unavailable]');
    expect(current()).not.toContain('should-not-write');
  });
});
