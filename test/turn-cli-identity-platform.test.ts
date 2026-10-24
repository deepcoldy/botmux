/**
 * Platform-backed credential source at the decision layer.
 *
 * The matrix under test (docs/lark-tool-identity.md, 凭据来源):
 *   local            → platform never consulted
 *   auto + unbound   → today's local path (incl. auto-started local login)
 *   auto + bound     → platform grant; else an EXISTING local HOME; else a
 *                      refusal pointing at the platform (no local login started)
 *   platform         → platform grant or refusal; local never consulted
 *
 * Run:  npx vitest run --project unit test/turn-cli-identity-platform.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: vi.fn(async () => null),
  lookupAuthorizedUserName: vi.fn(() => undefined),
}));
const bytedcliJwts = new Map<string, { cloudJwt: string; codeJwt?: string }>();
const beginBytedcliLogin = vi.fn(async () => ({ authUrl: 'https://cloud.example.test/local-bytedcli', completeToken: 'tok' }));
vi.mock('../src/services/bytedcli-auth.js', () => ({
  mintBytedcliJwts: vi.fn(async (openId: string) => bytedcliJwts.get(openId) ?? null),
  beginBytedcliLogin: (openId: string) => beginBytedcliLogin(openId),
}));
const larkHomes = new Map<string, string>();
const resolveLarkCliHomeForTurn = vi.fn(async (openId: string) => larkHomes.get(openId) ?? null);
const beginLarkCliLogin = vi.fn(async () => ({ authUrl: 'https://example.test/local-lark-device' }));
vi.mock('../src/services/lark-cli-auth.js', () => ({
  resolveLarkCliHomeForTurn: (openId: string) => resolveLarkCliHomeForTurn(openId),
  pendingLarkCliChallenge: vi.fn(() => null),
  beginLarkCliLogin: (openId: string) => beginLarkCliLogin(openId),
}));

const { publishTurnCliIdentity } = await import('../src/core/turn-cli-identity.js');
const { sessionIdentityPath } = await import('../src/core/cli-identity.js');
const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
const { __setPlatformCredentialDepsForTest, noteInboundSenderUnionId, noteSenderUnionId } = await import('../src/core/platform-credential-source.js');

const APP = 'cli_bot';
const ALICE = 'ou_alice';
const SESSION = 'sess-1';
const BINDING = { platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' };

let dir: string;
let grantCalls: any[];
let grantResponse: any;
let bound: boolean;
let unionIds: Map<string, string | null>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-turn-identity-platform-'));
  bytedcliJwts.clear();
  larkHomes.clear();
  resolveLarkCliHomeForTurn.mockClear();
  beginLarkCliLogin.mockClear();
  beginBytedcliLogin.mockClear();
  grantCalls = [];
  bound = true;
  unionIds = new Map([[ALICE, 'on_alice']]);
  grantResponse = { ok: false, reason: 'not_authorized', error: 'credential_not_found', authorizeUrl: 'https://platform.example.test/credentials' };
  __setPlatformCredentialDepsForTest({
    readBinding: () => (bound ? BINDING : null),
    resolveUnionId: async (_app, openId) => unionIds.get(openId) ?? null,
    requestGrant: async (req) => { grantCalls.push(req); return typeof grantResponse === 'function' ? grantResponse(req) : grantResponse; },
  });
});
afterEach(() => {
  __setPlatformCredentialDepsForTest(null);
  rmSync(dir, { recursive: true, force: true });
});

function botConfig(triggerUserAuth: unknown) {
  return {
    larkAppId: APP, larkAppSecret: 'secret', brand: 'feishu' as const,
    triggerUserAuth: parseTriggerUserAuthConfig(triggerUserAuth) ?? undefined,
  } as any;
}
const publish = (config: any, sender: string | undefined, turnId = 'om_t1') =>
  publishTurnCliIdentity({ botConfig: config, sessionDataDir: dir, sessionId: SESSION, senderOpenId: sender, turnId });
const read = (tool: 'lark-cli' | 'bytedcli') => readFileSync(sessionIdentityPath(dir, SESSION, tool), 'utf8');
const granted = (tool: 'lark-cli' | 'bytedcli') => ({
  ok: true,
  value: {
    tool, unionId: 'on_alice', expiresAt: Date.now() + 3_600_000,
    variables: tool === 'lark-cli'
      ? { LARKSUITE_CLI_APP_ID: 'cli_platform', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'platform-user-token' }
      : { BYTEDCLI_USER_CLOUD_JWT: 'cloud-jwt', BYTEDCLI_USER_CODE_JWT: 'code-jwt' },
  },
});

describe('policy off', () => {
  it('a bot without triggerUserAuth never consults the platform and publishes nothing', async () => {
    grantResponse = granted('lark-cli');
    const out = await publish(botConfig({ enabled: false }), ALICE);
    expect(out.every(o => o.state === 'off')).toBe(true);
    expect(grantCalls).toHaveLength(0);
    expect(existsSync(sessionIdentityPath(dir, SESSION, 'lark-cli'))).toBe(false);
    expect(existsSync(sessionIdentityPath(dir, SESSION, 'bytedcli'))).toBe(false);
  });
});

describe('credentialSource = local', () => {
  it('bytedcli in local mode mints from the per-person login on this machine', async () => {
    bytedcliJwts.set(ALICE, { cloudJwt: 'local-cloud', codeJwt: 'local-code' });
    const out = await publish(botConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'local' }), ALICE);
    expect(out.find(o => o.tool === 'bytedcli')?.state).toBe('user');
    expect(grantCalls).toHaveLength(0);
    expect(read('bytedcli')).toContain("BYTEDCLI_USER_CLOUD_JWT='local-cloud'");
  });

  it('never consults the platform even when bound', async () => {
    larkHomes.set(ALICE, '/homes/alice');
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'], credentialSource: 'local' }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('user');
    expect(grantCalls).toHaveLength(0);
    expect(read('lark-cli')).toContain("BOTMUX_IDENTITY_MODE='user-home'");
  });
});

describe('credentialSource = auto, machine unbound', () => {
  beforeEach(() => { bound = false; });

  it('behaves exactly like local, including starting a local login on refusal', async () => {
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    expect(grantCalls).toHaveLength(0);
    expect(beginLarkCliLogin).toHaveBeenCalledTimes(1);
    expect(read('lark-cli')).toContain('https://example.test/local-lark-device');
  });
});

describe('credentialSource = auto, machine bound', () => {
  it('publishes a lark-cli grant as a user token identity stamped with the turn and sender', async () => {
    grantResponse = granted('lark-cli');
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), ALICE, 'om_42');
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('user');
    const body = read('lark-cli');
    expect(body).toContain("BOTMUX_IDENTITY_MODE='user'");
    expect(body).toContain("LARKSUITE_CLI_APP_ID='cli_platform'");
    expect(body).toContain("LARKSUITE_CLI_USER_ACCESS_TOKEN='platform-user-token'");
    expect(body).toContain("BOTMUX_IDENTITY_TURN='om_42'");
    expect(body).toContain(`BOTMUX_IDENTITY_OPEN_ID='${ALICE}'`);
    // The daemon-resolved union id is what went to the platform — never the open_id.
    expect(grantCalls[0]).toMatchObject({ tool: 'lark-cli', unionId: 'on_alice', appId: APP, sessionId: SESSION, turnId: 'om_42' });
    expect(resolveLarkCliHomeForTurn).not.toHaveBeenCalled();
  });

  it('publishes a bytedcli grant with both JWTs', async () => {
    grantResponse = granted('bytedcli');
    const out = await publish(botConfig({ enabled: true, tools: ['bytedcli'] }), ALICE);
    expect(out.find(o => o.tool === 'bytedcli')?.state).toBe('user');
    const body = read('bytedcli');
    expect(body).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-jwt'");
    expect(body).toContain("BYTEDCLI_USER_CODE_JWT='code-jwt'");
  });

  it('honours an existing local HOME when the platform has nothing for the person', async () => {
    larkHomes.set(ALICE, '/homes/alice');
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('user');
    expect(read('lark-cli')).toContain("BOTMUX_IDENTITY_HOME='/homes/alice'");
    expect(beginLarkCliLogin).not.toHaveBeenCalled();
  });

  it('refuses with the platform link — and starts no local login — when neither side has credentials', async () => {
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    const body = read('lark-cli');
    expect(body).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(body).toContain('https://platform.example.test/credentials');
    expect(body).toContain('中心化平台授权一次');
    expect(body).not.toContain('local-lark-device');
    expect(beginLarkCliLogin).not.toHaveBeenCalled();
  });

  it('names the missing team consent when the person authorized but not for this team', async () => {
    grantResponse = { ok: false, reason: 'consent_missing', error: 'consent_missing', authorizeUrl: 'https://platform.example.test/credentials' };
    await publish(botConfig({ enabled: true, tools: ['bytedcli'] }), ALICE);
    const body = read('bytedcli');
    expect(body).toContain('还没允许本机所在的团队使用');
    expect(body).toContain('https://platform.example.test/credentials');
    expect(beginBytedcliLogin).not.toHaveBeenCalled();
  });

  it('reports unavailable (not needs-authorization) when the platform is down and no local HOME exists', async () => {
    grantResponse = { ok: false, reason: 'network', error: 'ECONNREFUSED' };
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('unavailable');
    expect(read('lark-cli')).toContain('中心化平台暂时不可达');
    expect(beginLarkCliLogin).not.toHaveBeenCalled();
  });

  it('still uses an existing local HOME when the platform is down', async () => {
    grantResponse = { ok: false, reason: 'unavailable', status: 503, error: 'store_unavailable' };
    larkHomes.set(ALICE, '/homes/alice');
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('user');
  });

  it('refuses a sender who shares no team with the machine owner, with no local login', async () => {
    grantResponse = { ok: false, reason: 'not_teammate', error: 'not_teammate' };
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    expect(read('lark-cli')).toContain('不在同一个团队');
    expect(beginLarkCliLogin).not.toHaveBeenCalled();
  });

  it('treats an unresolvable union id as unavailable, never as a different person', async () => {
    unionIds.set(ALICE, null);
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('unavailable');
    expect(grantCalls).toHaveLength(0);
    expect(beginLarkCliLogin).not.toHaveBeenCalled();
  });

  it("with an unresolvable union id, the sender's OWN existing local HOME is still honoured (same person, keyed by open_id)", async () => {
    unionIds.set(ALICE, null);
    larkHomes.set(ALICE, '/homes/alice');
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('user');
    expect(read('lark-cli')).toContain("BOTMUX_IDENTITY_HOME='/homes/alice'");
    expect(grantCalls).toHaveLength(0);
  });

  it('withholds for a turn with no human sender without asking the platform', async () => {
    grantResponse = granted('lark-cli');
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), undefined);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    expect(grantCalls).toHaveLength(0);
  });
});

describe('union id learned from the inbound event', () => {
  // The contact API answers only for people inside the bot app's contact range
  // (41050 otherwise); every message event carries the sender's union_id anyway.
  const inbound = (openId: string, unionId: string, senderType = 'user') =>
    ({ sender: { sender_type: senderType, sender_id: { open_id: openId, union_id: unionId } } });
  let contactLookups: string[];
  beforeEach(() => {
    contactLookups = [];
    __setPlatformCredentialDepsForTest({
      readBinding: () => (bound ? BINDING : null),
      resolveUnionId: async (_app, openId) => { contactLookups.push(openId); return null; },
      requestGrant: async (req) => { grantCalls.push(req); return typeof grantResponse === 'function' ? grantResponse(req) : grantResponse; },
    });
  });

  it('a sender outside the contact range still gets their platform grant', async () => {
    grantResponse = granted('lark-cli');
    noteInboundSenderUnionId(APP, inbound(ALICE, 'on_alice'));
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('user');
    expect(grantCalls[0]).toMatchObject({ tool: 'lark-cli', unionId: 'on_alice' });
    expect(contactLookups).toHaveLength(0);
  });

  it('without an event the contact lookup is still the fallback, and its failure stays unavailable', async () => {
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('unavailable');
    expect(contactLookups).toEqual([ALICE]);
    expect(grantCalls).toHaveLength(0);
  });

  it('ignores bot senders and malformed ids', async () => {
    noteInboundSenderUnionId(APP, inbound(ALICE, 'on_alice', 'app'));
    noteInboundSenderUnionId(APP, inbound(ALICE, '../on_alice'));
    noteInboundSenderUnionId(APP, inbound('not-an-open-id', 'on_alice'));
    noteInboundSenderUnionId(APP, inbound(ALICE, ALICE)); // an open_id is never a union_id
    noteSenderUnionId(APP, ALICE, 'ou_someone');
    noteInboundSenderUnionId(APP, null);
    noteInboundSenderUnionId(APP, { sender: { sender_type: 'user' } });
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('unavailable');
    expect(grantCalls).toHaveLength(0);
  });

  it('is scoped to the app that received the event (open_id is app-scoped)', async () => {
    noteInboundSenderUnionId('cli_other_bot', inbound(ALICE, 'on_someone_else'));
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('unavailable');
    expect(grantCalls).toHaveLength(0);
  });

  it('a pair from a trusted host record (scheduled run) seeds the same way', async () => {
    grantResponse = granted('bytedcli');
    noteSenderUnionId(APP, ALICE, 'on_alice');
    const out = await publish(botConfig({ enabled: true, tools: ['bytedcli'] }), ALICE);
    expect(out.find(o => o.tool === 'bytedcli')?.state).toBe('user');
    expect(grantCalls[0]).toMatchObject({ tool: 'bytedcli', unionId: 'on_alice' });
    expect(contactLookups).toHaveLength(0);
  });
});

describe('credentialSource = platform', () => {
  it('refuses when unbound and never looks at local state', async () => {
    bound = false;
    larkHomes.set(ALICE, '/homes/alice');
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'], credentialSource: 'platform' }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    expect(read('lark-cli')).toContain('尚未绑定中心化平台');
    expect(resolveLarkCliHomeForTurn).not.toHaveBeenCalled();
    expect(beginLarkCliLogin).not.toHaveBeenCalled();
  });

  it('ignores a local HOME when the platform has no credential', async () => {
    larkHomes.set(ALICE, '/homes/alice');
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'], credentialSource: 'platform' }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    expect(read('lark-cli')).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(resolveLarkCliHomeForTurn).not.toHaveBeenCalled();
  });

  it('uses the grant when the platform has one', async () => {
    grantResponse = granted('bytedcli');
    const out = await publish(botConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'platform' }), ALICE);
    expect(out.find(o => o.tool === 'bytedcli')?.state).toBe('user');
  });

  it.each([
    ['network', { ok: false, reason: 'network', error: 'ECONNRESET' }],
    ['5xx', { ok: false, reason: 'unavailable', status: 503, error: 'store_unavailable' }],
    ['not deployed', { ok: false, reason: 'not_deployed', status: 404 }],
  ])('platform unreachable (%s): reports unavailable, ignores a local HOME and starts no local login', async (_label, resp) => {
    grantResponse = resp;
    larkHomes.set(ALICE, '/homes/alice');
    const out = await publish(botConfig({ enabled: true, tools: ['lark-cli'], credentialSource: 'platform' }), ALICE);
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('unavailable');
    expect(read('lark-cli')).toContain('中心化平台暂时不可达');
    expect(resolveLarkCliHomeForTurn).not.toHaveBeenCalled();
    expect(beginLarkCliLogin).not.toHaveBeenCalled();
  });
});

describe('delegated identity (signed cross-bot dispatch)', () => {
  // credentialOpenId is the requester as seen by the ISSUING app; targetOpenId is
  // the same human in the receiving app. The platform key must come from the
  // former (that is what the daemon verified), so keep the two distinct here.
  const delegated = (tools: Array<'lark-cli' | 'bytedcli'>) => ({
    credentialOpenId: 'ou_requester', targetOpenId: 'ou_requester_in_target_app', tools, dispatchRoot: 'om_root',
  });

  it('asks the platform for the original requester, not the dispatching bot', async () => {
    unionIds.set('ou_requester', 'on_requester');
    unionIds.set('ou_requester_in_target_app', 'on_wrong_key');
    grantResponse = (req: any) => (req.unionId === 'on_requester' ? granted('lark-cli') : { ok: false, reason: 'not_authorized', error: 'x' });
    const out = await publishTurnCliIdentity({
      botConfig: botConfig({ enabled: true, tools: ['lark-cli'] }), sessionDataDir: dir, sessionId: SESSION,
      senderOpenId: undefined, delegatedIdentity: delegated(['lark-cli']), turnId: 'om_d',
    });
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('user');
    expect(grantCalls[0].unionId).toBe('on_requester');
  });

  it('in platform mode a non-grant denies the delegated turn without local lookup', async () => {
    unionIds.set('ou_requester', 'on_requester');
    larkHomes.set('ou_requester', '/homes/requester');
    const out = await publishTurnCliIdentity({
      botConfig: botConfig({ enabled: true, tools: ['lark-cli'], credentialSource: 'platform' }), sessionDataDir: dir, sessionId: SESSION,
      senderOpenId: undefined, delegatedIdentity: delegated(['lark-cli']), turnId: 'om_d',
    });
    expect(out.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    expect(resolveLarkCliHomeForTurn).not.toHaveBeenCalled();
  });
});
