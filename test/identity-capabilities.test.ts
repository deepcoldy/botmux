/**
 * Per-capability publication: which identities the daemon publishes for a turn
 * under each capability switch table.
 *
 * Run:  npx vitest run --project unit test/identity-capabilities.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: vi.fn(async () => null),
  userTokenAuthState: vi.fn((): { state: string } => ({ state: 'needs-login' })),
  lookupAuthorizedUserName: vi.fn(() => undefined),
  isUsableOpenId: (openId: unknown) => typeof openId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(openId),
}));
let renewed: { cloudJwt: string; codeJwt?: string } | null = null;
const bytedcliJwts = new Map<string, { cloudJwt: string; codeJwt?: string }>();
vi.mock('../src/services/bytedcli-auth.js', () => ({
  renewBytedcliJwts: vi.fn(async () => renewed),
  mintBytedcliJwts: vi.fn(async (openId: string) => bytedcliJwts.get(openId) ?? null),
  beginBytedcliLogin: vi.fn(async () => ({ authUrl: 'https://cloud.example.test/auth', completeToken: 'tok' })),
  describeBytedcliAuth: vi.fn(async (openId: string) => ({ state: bytedcliJwts.has(openId) ? 'authorized' : 'needs-login' })),
}));
const meegoLoggedIn = new Set<string>();
vi.mock('../src/services/meego-auth.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestMeegoLogin: vi.fn(async (openId: string) => meegoLoggedIn.has(openId)
    ? { state: 'ready' } : { state: 'link', authUrl: 'https://meego.example.test/device' }),
}));
vi.mock('../src/services/lark-cli-auth.js', () => ({
  resolveLarkCliHomeForTurn: vi.fn(async () => null),
  pendingLarkCliChallenge: vi.fn(() => null),
  beginLarkCliLogin: vi.fn(async () => ({ authUrl: 'https://lark.example.test/device', completeToken: 'lt' })),
  describeLarkCliAuth: vi.fn(() => ({ state: 'needs-login' })),
}));

const { publishTurnCliIdentity } = await import('../src/core/turn-cli-identity.js');
const { recallProvenIdentityContent, forgetProvenIdentityContent } = await import('../src/core/cli-identity.js');
const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
const { beginBytedcliLogin } = await import('../src/services/bytedcli-auth.js');
const { requestUnattendedAuthorization, clearRestoredLapses, offerAuthorizationAtCreation, __resetUnattendedNoticesForTest } = await import('../src/core/capability-authorization.js');
const { __setPlatformCredentialDepsForTest } = await import('../src/core/platform-credential-source.js');
const { renewExpiringBytedcliIdentities, forgetBytedcliIdentityRenewals } = await import('../src/core/bytedcli-identity-renewal.js');

const SESSION = 'sess-cap';
const TURN = 'om_t1';
const ALICE = 'ou_alice';
let dir: string;

beforeEach(() => {
  renewed = null;
  __resetUnattendedNoticesForTest();
  vi.mocked(beginBytedcliLogin).mockClear();
  meegoLoggedIn.clear();
  bytedcliJwts.clear();
  bytedcliJwts.set(ALICE, { cloudJwt: 'cloud-jwt', codeJwt: 'code-jwt' });
  dir = mkdtempSync(join(tmpdir(), 'botmux-capabilities-'));
});
afterEach(() => {
  forgetProvenIdentityContent(dir, SESSION);
  rmSync(dir, { recursive: true, force: true });
});

const publish = (triggerUserAuth: unknown, senderOpenId: string | null = ALICE, delegatedIdentity?: object) => publishTurnCliIdentity({
  botConfig: {
    larkAppId: 'cli_bot', larkAppSecret: 'secret', brand: 'feishu',
    triggerUserAuth: parseTriggerUserAuthConfig({ credentialSource: 'local', ...(triggerUserAuth as object) }) ?? undefined,
  } as any,
  sessionDataDir: dir, sessionId: SESSION, senderOpenId: senderOpenId ?? undefined, turnId: TURN, ...(delegatedIdentity ? { delegatedIdentity: delegatedIdentity as any } : {}), storageModel: 'proven', privateChat: false,
});
const body = (tool: 'bytedcli' | 'codebase' | 'bitscli' | 'lark-cli') =>
  recallProvenIdentityContent(dir, SESSION, TURN, tool);

describe('capability switch table decides what is published', () => {
  it('bytecloud on, meego off: ByteCloud identity with companions, no Meego store', async () => {
    const outcomes = await publish({ enabled: true, capabilities: ['bytecloud'] });
    expect(outcomes).toEqual([{ tool: 'lark-cli', state: 'off' }, { tool: 'bytedcli', state: 'user' }]);
    expect(body('bytedcli')).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
    expect(body('bytedcli')).not.toContain('BOTMUX_MEEGO_HOME');
    expect(body('codebase')).toContain("CODEBASE_CLI_USER_JWT='code-jwt'");
    expect(body('bitscli')).toContain("AIME_USER_CLOUD_JWT='cloud-jwt'");
    expect(body('bitscli')).toContain(`BOTMUX_IDENTITY_OPEN_ID='${ALICE}'`);
  });

  it('bytecloud and meego on: the person\'s Meego store is published too', async () => {
    await publish({ enabled: true, capabilities: ['bytecloud', 'meego'] });
    expect(body('bytedcli')).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
    expect(body('bytedcli')).toContain('BOTMUX_MEEGO_HOME=');
  });

  it('tools-only config behaves as bytecloud + meego', async () => {
    await publish({ enabled: true, tools: ['bytedcli'] });
    expect(body('bytedcli')).toContain('BOTMUX_MEEGO_HOME=');
    expect(body('bitscli')).toContain('AIME_USER_CLOUD_JWT');
  });

  it('meego on, bytecloud off: Meego-only identity, no ByteCloud JWT and no companions', async () => {
    const outcomes = await publish({ enabled: true, capabilities: ['meego'] });
    expect(outcomes).toEqual([{ tool: 'lark-cli', state: 'off' }, { tool: 'bytedcli', state: 'user' }]);
    expect(body('bytedcli')).toContain('BOTMUX_MEEGO_HOME=');
    expect(body('bytedcli')).not.toContain('CLOUD_JWT');
    expect(body('codebase')).toBeUndefined();
    expect(body('bitscli')).toBeUndefined();
  });

  it('lark-user only: bytedcli is native, nothing published for it', async () => {
    const outcomes = await publish({ enabled: true, capabilities: ['lark-user'] });
    expect(outcomes.find(o => o.tool === 'bytedcli')).toEqual({ tool: 'bytedcli', state: 'off' });
    expect(body('bytedcli')).toBeUndefined();
    expect(body('bitscli')).toBeUndefined();
  });

  it('no capability on: every tool is native', async () => {
    const outcomes = await publish({ enabled: true, capabilities: [] });
    expect(outcomes.every(o => o.state === 'off')).toBe(true);
  });

  it('bytecloud on without a local login refuses with the authorization entry', async () => {
    bytedcliJwts.clear();
    const outcomes = await publish({ enabled: true, capabilities: ['bytecloud'] });
    expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('needs-authorization');
    expect(body('bytedcli')).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(body('bytedcli')).toContain('[reason=not_authorized]');
    expect(body('bitscli')).toContain("BOTMUX_IDENTITY_MODE='denied'");
  });

  it('no human sender withholds a switched-on capability, ByteCloud and Meego alike', async () => {
    for (const capabilities of [['bytecloud'], ['meego']]) {
      const outcomes = await publish({ enabled: true, capabilities }, null);
      expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('needs-authorization');
      expect(body('bytedcli')).toContain("BOTMUX_IDENTITY_MODE='denied'");
      expect(body('bytedcli')).toContain('[reason=no_sender]');
      if (capabilities[0] === 'meego') expect(body('bytedcli')).not.toContain('ByteCloud');
      forgetProvenIdentityContent(dir, SESSION);
    }
  });

  describe('delegated turn (Meego-only bot)', () => {
    const delegation = (tools: string[], targetOpenId?: string) => ({
      credentialOpenId: ALICE, unionId: 'on_alice', tools, dispatchRoot: 'root', ...(targetOpenId ? { targetOpenId } : {}),
    });

    it('publishes the target person\'s Meego store when the delegation grants bytedcli', async () => {
      const outcomes = await publish({ enabled: true, capabilities: ['meego'] }, null, delegation(['bytedcli'], 'ou_target'));
      expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('user');
      expect(body('bytedcli')).toContain("BOTMUX_IDENTITY_OPEN_ID='ou_target'");
      expect(body('bytedcli')).toContain('BOTMUX_MEEGO_HOME=');
    });

    it.each([
      ['the delegation does not grant bytedcli', ['lark-cli'], 'ou_target'],
      ['the target person is unknown', ['bytedcli'], undefined],
    ])('denies when %s', async (_label, tools, target) => {
      const outcomes = await publish({ enabled: true, capabilities: ['meego'] }, null, delegation(tools, target));
      expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('needs-authorization');
      expect(body('bytedcli')).toContain("BOTMUX_IDENTITY_MODE='denied'");
    });
  });
});

describe('unattended turns (scheduled and background)', () => {
  const SCHEDULED = 'schedule:abc12345:11111111-1111-1111-1111-111111111111';
  const BACKGROUND = 'background:22222222-2222-2222-2222-222222222222';
  const run = (turnId: string, triggerUserAuth: unknown, privateChat = false) => publishTurnCliIdentity({
    botConfig: {
      larkAppId: 'cli_bot', larkAppSecret: 'secret', brand: 'feishu',
      triggerUserAuth: parseTriggerUserAuthConfig({ credentialSource: 'local', ...(triggerUserAuth as object) }) ?? undefined,
    } as any,
    sessionDataDir: dir, sessionId: SESSION, senderOpenId: ALICE, turnId, storageModel: 'proven', privateChat,
  });
  const at = (turnId: string, tool: 'bytedcli' | 'bitscli' | 'codebase') => recallProvenIdentityContent(dir, SESSION, turnId, tool);

  it.each([SCHEDULED, BACKGROUND, 'trg_abc123', 'workflow-event:run-1'])('%s with the creator\'s credentials: runs as the creator and is marked unattended, bitscli included', async turnId => {
    await run(turnId, { enabled: true, capabilities: ['bytecloud'] });
    for (const tool of ['bytedcli', 'bitscli'] as const) {
      expect(at(turnId, tool)).toContain("BOTMUX_IDENTITY_MODE='user'");
      expect(at(turnId, tool)).toContain("BOTMUX_IDENTITY_UNATTENDED='1'");
    }
    expect(at(turnId, 'bitscli')).toContain("AIME_USER_CLOUD_JWT='cloud-jwt'");
  });

  it.each([SCHEDULED, BACKGROUND, 'trg_abc123', 'workflow-event:run-1'])('%s without credentials: a refusal with no link and no login started, even in a private chat', async turnId => {
    bytedcliJwts.clear();
    const outcomes = await run(turnId, { enabled: true, capabilities: ['bytecloud'] }, true);
    expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('needs-authorization');
    for (const tool of ['bytedcli', 'bitscli', 'codebase'] as const) {
      expect(at(turnId, tool)).toContain("BOTMUX_IDENTITY_MODE='denied'");
      expect(at(turnId, tool)).toContain('[reason=unattended]');
      expect(at(turnId, tool)).not.toContain('https://');
      expect(at(turnId, tool)).not.toContain('not_authorized');
    }
    expect(beginBytedcliLogin).not.toHaveBeenCalled();
  });

  it('a human turn is unchanged: not marked, and a refusal still offers the authorization', async () => {
    bytedcliJwts.clear();
    await run(TURN, { enabled: true, capabilities: ['bytecloud'] }, true);
    expect(at(TURN, 'bytedcli')).not.toContain('UNATTENDED');
    expect(at(TURN, 'bytedcli')).toContain('https://cloud.example.test/auth');
  });

  it('capabilities are read at fire time: ByteCloud off publishes nothing for it', async () => {
    const outcomes = await run(SCHEDULED, { enabled: true, capabilities: ['meego'] });
    expect(at(SCHEDULED, 'bitscli')).toBeUndefined();
    expect(at(SCHEDULED, 'bytedcli')).not.toContain('CLOUD_JWT');
    expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('user');
  });

  describe('the one private notice, with every missing authorization in it', () => {
    const send = vi.fn(async (_to: string, _text: string) => undefined);
    beforeEach(() => { send.mockReset(); send.mockResolvedValue(undefined); __setPlatformCredentialDepsForTest(null); vi.mocked(beginBytedcliLogin).mockClear(); });
    afterEach(() => __setPlatformCredentialDepsForTest(null));
    const asked = (provider: 'bytedcli' | 'meego' | 'lark-cli', opts: { caps?: string[]; source?: 'local' | 'auto'; task?: string } = {}) => requestUnattendedAuthorization({
      appId: 'cli_bot', taskId: opts.task ?? 't1', taskName: 'nightly', openId: ALICE, locale: 'zh', provider, sendDirect: send,
      botConfig: { larkAppId: 'cli_bot', larkToolBinding: true, triggerUserAuth: parseTriggerUserAuthConfig({
        enabled: true, capabilities: opts.caps ?? ['bytecloud'], credentialSource: opts.source ?? 'local' }) } as any,
    });

    it('is one DM to the person with a device login link, however often the refusal is seen', async () => {
      bytedcliJwts.clear();
      expect(await asked('bytedcli')).toBe('delivered');
      await asked('bytedcli'); await asked('bytedcli');
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toBe(ALICE);
      expect(send.mock.calls[0][1]).toContain('nightly');
      expect(send.mock.calls[0][1]).toContain('https://cloud.example.test/auth');
      expect(send.mock.calls[0][1]).toContain('该命令未执行');
      await asked('bytedcli', { task: 't2' });
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('an expired challenge means a fresh link: the next refusal sends it', async () => {
      bytedcliJwts.clear();
      await asked('bytedcli');
      vi.mocked(beginBytedcliLogin).mockResolvedValueOnce({ authUrl: 'https://cloud.example.test/auth-fresh', completeToken: 'tok2' } as any);
      await asked('bytedcli');
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][1]).toContain('auth-fresh');
    });

    it('a person who has credentials again gets nothing, and the next lapse is a new one', async () => {
      bytedcliJwts.clear();
      await asked('bytedcli');
      bytedcliJwts.set(ALICE, { cloudJwt: 'c' });
      expect(await asked('bytedcli')).toBe('ready');
      expect(send).toHaveBeenCalledTimes(1);
      bytedcliJwts.clear();
      await asked('bytedcli');
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('concurrent refusals of one task give exactly one DM', async () => {
      bytedcliJwts.clear();
      send.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 20)));
      const results = await Promise.all([asked('bytedcli'), asked('bytedcli'), asked('bytedcli')]);
      expect(results).toEqual(['delivered', 'delivered', 'delivered']);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('a failed send is retried at the next refusal', async () => {
      bytedcliJwts.clear();
      send.mockRejectedValueOnce(new Error('down'));
      expect(await asked('bytedcli')).toBe('undelivered');
      expect(await asked('bytedcli')).toBe('delivered');
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('on a platform-bound host the link is the non-expiring platform credentials page, no device login is started', async () => {
      bytedcliJwts.clear();
      __setPlatformCredentialDepsForTest({
        readBinding: () => ({ platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' }),
        resolveUnionId: async () => 'on_alice', requestGrant: async () => ({ ok: false, reason: 'network', error: 'x' }) as any,
      });
      await asked('bytedcli', { source: 'auto' }); await asked('bytedcli', { source: 'auto' });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toContain('https://platform.example.test');
      expect(beginBytedcliLogin).not.toHaveBeenCalled();
    });

    it('a revoked person with ByteCloud and Meego on: the first refusal sends one DM with both links; after authorizing both the next run executes and sends nothing', async () => {
      bytedcliJwts.clear();
      expect(await asked('bytedcli', { caps: ['bytecloud', 'meego'] })).toBe('delivered');
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toContain('https://cloud.example.test/auth');
      expect(send.mock.calls[0][1]).toContain('https://meego.example.test/device');
      // The Meego refusal that would follow carries nothing new.
      await asked('meego', { caps: ['bytecloud', 'meego'] });
      expect(send).toHaveBeenCalledTimes(1);
      bytedcliJwts.set(ALICE, { cloudJwt: 'cloud-jwt', codeJwt: 'code-jwt' });
      meegoLoggedIn.add(ALICE);
      const outcomes = await run(SCHEDULED, { enabled: true, capabilities: ['bytecloud', 'meego'] });
      expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('user');
      expect(at(SCHEDULED, 'bytedcli')).toContain("BOTMUX_IDENTITY_MODE='user'");
      clearRestoredLapses({ appId: 'cli_bot', taskId: 't1', openId: ALICE, outcomes });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('Meego alone: one DM with its link, deduped; a person already logged in gets nothing', async () => {
      await asked('meego', { caps: ['meego'] }); await asked('meego', { caps: ['meego'] });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toContain('https://meego.example.test/device');
      meegoLoggedIn.add(ALICE);
      expect(await asked('meego', { caps: ['meego'] })).toBe('ready');
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('lark-user lapses use the same notice', async () => {
      await asked('lark-cli', { caps: ['lark-user'] });
      expect(send.mock.calls[0][1]).toContain('https://lark.example.test/device');
    });
  });

  it('a long scheduled run outlives the JWT: renewal rewrites the bytedcli identity and its bitscli companion', async () => {
    const future = (secs: number) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secs })).toString('base64url')}.s`;
    bytedcliJwts.set(ALICE, { cloudJwt: future(600), codeJwt: 'code-jwt' });
    await run(SCHEDULED, { enabled: true, capabilities: ['bytecloud'] });
    renewed = { cloudJwt: future(7200), codeJwt: 'code-jwt' };
    expect(await renewExpiringBytedcliIdentities()).toBe(1);
    expect(at(SCHEDULED, 'bytedcli')).toContain(renewed.cloudJwt);
    expect(at(SCHEDULED, 'bitscli')).toContain(`AIME_USER_CLOUD_JWT='${renewed.cloudJwt}'`);
    expect(at(SCHEDULED, 'bitscli')).toContain('UNATTENDED');
    forgetBytedcliIdentityRenewals();
  });

  describe('at creation, for the sender of the turn that creates the task', () => {
    const send = vi.fn(async () => undefined);
    const requestGrant = vi.fn(async () => ({ ok: false, reason: 'network', error: 'x' }) as any);
    beforeEach(() => {
      send.mockClear(); requestGrant.mockClear(); meegoLoggedIn.add(ALICE);
      __setPlatformCredentialDepsForTest({
        readBinding: () => ({ platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' }),
        resolveUnionId: async () => 'on_alice', requestGrant,
      });
    });
    afterEach(() => __setPlatformCredentialDepsForTest(null));
    const offer = (published: (tool: string) => string | undefined) => offerAuthorizationAtCreation({
      botConfig: { larkAppId: 'cli_bot', larkAppSecret: 's', brand: 'feishu', larkToolBinding: true,
        triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, credentialSource: 'auto', capabilities: ['bytecloud'] }) } as any,
      openId: ALICE, locale: 'zh', sendDirect: send, published,
    });

    it('a sender whose turn was refused for want of the platform grant gets one private entry with the platform page', async () => {
      await offer(() => "BOTMUX_IDENTITY_MODE='denied'\n[reason=platform_not_authorized]");
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]).toEqual([ALICE, expect.stringContaining('https://platform.example.test')]);
      expect(requestGrant).not.toHaveBeenCalled();
      expect(beginBytedcliLogin).not.toHaveBeenCalled();
    });

    it('an authorized sender gets nothing', async () => {
      await offer(() => "BOTMUX_IDENTITY_MODE='user'");
      expect(send).not.toHaveBeenCalled();
    });

    it.each(['[reason=platform_timeout]', '[reason=platform_unreachable]', '[reason=platform_unavailable]', undefined])(
      'an outage or nothing published (%s) gets nothing', async reason => {
        await offer(() => reason && `BOTMUX_IDENTITY_MODE='denied'\n${reason}`);
        expect(send).not.toHaveBeenCalled();
      });
  });

  describe('at creation', () => {
    const send = vi.fn(async () => undefined);
    beforeEach(() => { send.mockClear(); __setPlatformCredentialDepsForTest(null); });
    afterEach(() => __setPlatformCredentialDepsForTest(null));
    const offer = (caps: string[], source: 'local' | 'auto' = 'local') => offerAuthorizationAtCreation({
      botConfig: { larkAppId: 'cli_bot', larkAppSecret: 's', brand: 'feishu', larkToolBinding: true,
        triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, credentialSource: source, capabilities: caps }) } as any,
      openId: ALICE, locale: 'zh', sendDirect: send,
    });

    it('missing credentials: exactly one private message with an entry for each, saying the task runs as the recipient', async () => {
      bytedcliJwts.clear();
      await offer(['bytecloud', 'meego']);
      expect(send).toHaveBeenCalledTimes(1);
      const text = (send.mock.calls[0] as unknown as [string, string])[1];
      expect(send.mock.calls[0][0]).toBe(ALICE);
      expect(text).toContain('https://cloud.example.test/auth');
      expect(text).toContain('https://meego.example.test/device');
      expect(text).toContain('你本人的身份');
      expect(text).not.toContain('你创建');
      // One lead sentence, then one line per capability link.
      expect(text.split('\n')).toEqual([expect.stringContaining('下列能力'), expect.stringContaining('https://cloud.example.test/auth'), expect.stringContaining('https://meego.example.test/device')]);
    });

    it('lark-user without the tool binding: a stored bot-app user token counts as a login, an unreadable store is not a lapse, its absence is, and no token is ever refreshed', async () => {
      const { userTokenAuthState, resolveUserToken } = await import('../src/utils/user-token.js');
      const lark = (binding: boolean) => offerAuthorizationAtCreation({
        botConfig: { larkAppId: 'cli_bot', larkAppSecret: 's', brand: 'feishu', larkToolBinding: binding,
          triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, credentialSource: 'local', capabilities: ['lark-user'] }) } as any,
        openId: ALICE, locale: 'zh', sendDirect: send,
      });
      vi.mocked(resolveUserToken).mockClear();
      vi.mocked(userTokenAuthState).mockReturnValueOnce({ state: 'authorized' });
      await lark(false);
      vi.mocked(userTokenAuthState).mockReturnValueOnce({ state: 'unknown' });
      await lark(false);
      expect(send).not.toHaveBeenCalled();
      await lark(false);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toContain('https://lark.example.test/device');
      expect(resolveUserToken).not.toHaveBeenCalled();
    });

    it('credentials present: nothing is sent', async () => {
      meegoLoggedIn.add(ALICE);
      await offer(['bytecloud', 'meego']);
      expect(send).not.toHaveBeenCalled();
    });

    it('a capability that is off is not asked for', async () => {
      bytedcliJwts.clear();
      await offer(['lark-user']);
      expect(send).not.toHaveBeenCalled();
      expect(beginBytedcliLogin).not.toHaveBeenCalled();
    });

    it('is read-only: no platform grant is requested, and a platform-sourced credential is not judged', async () => {
      bytedcliJwts.clear();
      const requestGrant = vi.fn(async () => ({ ok: false, reason: 'network', error: 'x' }) as any);
      __setPlatformCredentialDepsForTest({
        readBinding: () => ({ platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' }),
        resolveUnionId: async () => 'on_alice', requestGrant,
      });
      await offer(['bytecloud'], 'auto');
      expect(requestGrant).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });
  });
});
