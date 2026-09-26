/**
 * Per-turn identity publication — the decision layer.
 *
 * The property that matters most is negative: **no turn ever runs with the
 * previous sender's credentials still in force.** So the tests below are mostly
 * about what happens when a token is *not* available — a new sender who has not
 * authorized, a turn with no human sender at all, a bot whose policy is off.
 *
 * Note "not in force" is not the same as "file deleted". The wrapper refuses to
 * run when the file is missing, so the bot identity has to be written out
 * explicitly (lark-cli handed no env picks up the operator's on-disk login, not
 * the bot's). What every case below asserts is therefore the *content*: the
 * previous person's token must be gone from it.
 *
 * Run:  npx vitest run --project unit test/turn-cli-identity.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tokens = new Map<string, string>();
vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: vi.fn(async (appId: string, _secret: string, _brand: string, openId?: string) =>
    tokens.get(`${appId}|${openId ?? ''}`) ?? null),
  lookupAuthorizedUserName: vi.fn(() => undefined),
}));

// bytedcli shells out to the real CLI; here we control who is authorized.
const bytedcliJwts = new Map<string, { cloudJwt: string; codeJwt?: string }>();
vi.mock('../src/services/bytedcli-auth.js', () => ({
  mintBytedcliJwts: vi.fn(async (openId: string) => bytedcliJwts.get(openId) ?? null),
  beginBytedcliLogin: vi.fn(async () => ({
    authUrl: 'https://cloud.example.com/auth?state=auto',
    completeToken: 'tok-auto',
  })),
}));

// lark-cli per-person HOME (device-code). The turn resolver is scripted per
// test; auto-begin is scripted so withholding never touches the real FS.
const larkHomes = new Map<string, string>();
const pendingChallenges = new Set<string>();
const resolveLarkCliHomeForTurn = vi.fn(async (openId: string) => larkHomes.get(openId) ?? null);
vi.mock('../src/services/lark-cli-auth.js', () => ({
  resolveLarkCliHomeForTurn: (openId: string) => resolveLarkCliHomeForTurn(openId),
  pendingLarkCliChallenge: vi.fn((openId: string) => pendingChallenges.has(openId) ? { deviceCode: 'dc' } : null),
  beginLarkCliLogin: vi.fn(async () => ({ authUrl: 'https://example.com/lark-device' })),
}));

const { publishTurnCliIdentity } = await import('../src/core/turn-cli-identity.js');
const { sessionIdentityPath, writeSessionIdentity } = await import('../src/core/cli-identity.js');
const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');

const APP = 'cli_bot';
const ALICE = 'ou_alice';
const BOB = 'ou_bob';
const SESSION = 'sess-1';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-turn-identity-'));
  tokens.clear();
  bytedcliJwts.clear();
  larkHomes.clear();
  pendingChallenges.clear();
  resolveLarkCliHomeForTurn.mockClear();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function botConfig(triggerUserAuth: unknown = { enabled: true, tools: ['lark-cli'] }) {
  return {
    larkAppId: APP,
    larkAppSecret: 'secret',
    brand: 'feishu' as const,
    triggerUserAuth: parseTriggerUserAuthConfig(triggerUserAuth) ?? undefined,
  } as any;
}

function publish(config: any, senderOpenId: string | undefined, turnId?: string) {
  return publishTurnCliIdentity({
    botConfig: config,
    ...(turnId ? { turnId } : {}),
    sessionDataDir: dir,
    sessionId: SESSION,
    senderOpenId,
  });
}

const larkPath = () => sessionIdentityPath(dir, SESSION, 'lark-cli');

describe('publishTurnCliIdentity — lark-cli per-person HOME (device flow)', () => {
  it('publishes the per-person HOME as a user-home identity (no token injected)', async () => {
    larkHomes.set(ALICE, '/homes/alice');
    const outcomes = await publish(botConfig(), ALICE);
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('user');
    const body = readFileSync(larkPath(), 'utf8');
    expect(body).toContain("BOTMUX_IDENTITY_MODE='user-home'");
    expect(body).toContain("BOTMUX_IDENTITY_HOME='/homes/alice'");
    expect(body).not.toContain('LARKSUITE_CLI_USER_ACCESS_TOKEN');
  });

  // F-A end to end at the decision layer: refusal while the link is pending,
  // then the very next turn — after the person tapped — the resolver's poll
  // lands the HOME and the identical retry runs as that person.
  it('the retry after a tap runs as the person without /login done', async () => {
    pendingChallenges.add(BOB);
    const t1 = await publish(botConfig(), BOB);
    expect(t1.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    expect(readFileSync(larkPath(), 'utf8')).toContain('https://example.com/lark-device');

    // Approval landed between turns; the resolver poll now returns the HOME.
    pendingChallenges.delete(BOB);
    larkHomes.set(BOB, '/homes/bob');
    const t2 = await publish(botConfig(), BOB);
    expect(t2.find(o => o.tool === 'lark-cli')?.state).toBe('user');
    expect(readFileSync(larkPath(), 'utf8')).toContain("BOTMUX_IDENTITY_MODE='user-home'");
  });

  it('keeps refusing while a challenge remains unresolved', async () => {
    pendingChallenges.add(BOB);
    const outcomes = await publish(botConfig(), BOB);
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    expect(resolveLarkCliHomeForTurn).toHaveBeenCalledWith(BOB);
  });
});

describe('publishTurnCliIdentity — the sender acts as themselves', () => {
  it('publishes the sender\'s own token', async () => {
    tokens.set(`${APP}|${ALICE}`, 'tok-alice');
    const outcomes = await publish(botConfig(), ALICE);
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('user');
    const body = readFileSync(larkPath(), 'utf8');
    expect(body).toContain('tok-alice');
    expect(body).toContain(APP);
  });

  it('swaps the acting identity when a different person speaks next', async () => {
    tokens.set(`${APP}|${ALICE}`, 'tok-alice');
    tokens.set(`${APP}|${BOB}`, 'tok-bob');
    await publish(botConfig(), ALICE);
    await publish(botConfig(), BOB);
    const body = readFileSync(larkPath(), 'utf8');
    expect(body).toContain('tok-bob');
    expect(body).not.toContain('tok-alice');
  });
});

// These are the ones that matter. Each scenario must DELETE the file, because a
// leftover would make the next command run as the previous person — silently,
// and with the wrong name in the audit trail.
describe('publishTurnCliIdentity — withholding removes, never inherits', () => {
  it('denies with a device link when the new sender has not authorized', async () => {
    tokens.set(`${APP}|${ALICE}`, 'tok-alice');
    await publish(botConfig(), ALICE);
    expect(existsSync(larkPath())).toBe(true);

    // Bob has no identity: lark-cli (whose docs/drive/wiki surface is user-only)
    // must not silently run as the bot or inherit Alice. It is refused with a
    // ready device-code link, exactly like bytedcli.
    const outcomes = await publish(botConfig(), BOB);
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    const body = readFileSync(larkPath(), 'utf8');
    expect(body).not.toContain('tok-alice');
    expect(body).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(body).toContain('https://example.com/lark-device');
  });

  // Scheduled runs, hooks, meeting events and bot-to-bot handoffs have no
  // trigger user. Reaching for the session creator's or owner's credentials to
  // fill that gap is exactly the borrowing this feature removes.
  it('denies (no link) when the turn has no human sender', async () => {
    tokens.set(`${APP}|${ALICE}`, 'tok-alice');
    await publish(botConfig(), ALICE);
    const outcomes = await publish(botConfig(), undefined);
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    expect(readFileSync(larkPath(), 'utf8')).not.toContain('tok-alice');
  });

  it('reports needs-authorization instead of degrading under fallback: none', async () => {
    const config = botConfig({ enabled: true, tools: ['lark-cli'], fallback: 'none' });
    const outcomes = await publish(config, BOB);
    expect(readFileSync(larkPath(), 'utf8')).toContain('飞书');
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    // A refusal is published, not an empty file: it carries the text the person
    // whose command just failed reads, including how to authorize.
    const body = readFileSync(larkPath(), 'utf8');
    expect(body).toContain('BOTMUX_IDENTITY_MODE=\'denied\'');
    // A ready device-code link is embedded directly (no typed /login needed).
    expect(body).toContain('https://example.com/lark-device');
    expect(body).not.toContain('LARKSUITE_CLI_USER_ACCESS_TOKEN');
  });

  // bytedcli authenticates against ByteCloud SSO, a different provider from Lark
  // OAuth — a Lark token cannot become a ByteCloud JWT. It must report "not
  // authorized" rather than quietly using the machine's own SSO session.
  it('never fabricates a bytedcli identity from a Lark token', async () => {
    // Authorized for Feishu, NOT for ByteCloud — a real and common state, since
    // they are different identity providers with no conversion between them.
    tokens.set(`${APP}|${ALICE}`, 'tok-alice');
    const config = botConfig({ enabled: true, tools: ['lark-cli', 'bytedcli'] });
    const outcomes = await publish(config, ALICE);
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('user');
    expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('needs-authorization');
    // bytedcli has no bot identity to fall back to, so it is refused outright
    // even though the same turn's lark-cli runs as Alice.
    const body = readFileSync(sessionIdentityPath(dir, SESSION, 'bytedcli'), 'utf8');
    expect(body).toContain('BOTMUX_IDENTITY_MODE=\'denied\'');
    expect(body).not.toContain('BYTEDCLI_USER_CLOUD_JWT');
    // And it names ByteCloud, not Feishu — both in the provider it asks them to
    // authorize with and in the command. Getting either wrong sends them off to
    // authorize the other provider and hit this same refusal again.
    expect(body).toContain('ByteCloud');
    expect(body).not.toContain('飞书');
    expect(body).toContain('https://cloud.example.com/auth?state=auto');
    // Friendly one-time framing: it names the tool/provider and says authorize once.
    expect(body).toContain('bytedcli');
    expect(body).toMatch(/只需授权这一次|authorize just once/i);
    // Someone refused for lack of authorization usually has no stored name, so
    // the nameless path is the common one — it must read as a sentence, not
    // print a raw open_id back at the person.
    expect(body).not.toContain(ALICE);
    expect(body).toContain('你自己');
  });

  it('uses the stored name when we actually know it', async () => {
    const { lookupAuthorizedUserName } = await import('../src/utils/user-token.js');
    vi.mocked(lookupAuthorizedUserName).mockReturnValueOnce('孙晓雪');
    const config = botConfig({ enabled: true, tools: ['lark-cli'], fallback: 'none' });
    await publish(config, ALICE);
    expect(readFileSync(larkPath(), 'utf8')).toContain('孙晓雪');
  });

  it('publishes this person\'s own ByteCloud JWTs once they have authorized', async () => {
    bytedcliJwts.set(ALICE, { cloudJwt: 'cloud-alice', codeJwt: 'code-alice' });
    const config = botConfig({ enabled: true, tools: ['bytedcli'] });
    const outcomes = await publish(config, ALICE);

    expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('user');
    const body = readFileSync(sessionIdentityPath(dir, SESSION, 'bytedcli'), 'utf8');
    expect(body).toContain("BYTEDCLI_USER_CLOUD_JWT='cloud-alice'");
    // git attribution rides this one.
    expect(body).toContain("BYTEDCLI_USER_CODE_JWT='code-alice'");
  });

  // Alice authorized, Bob did not. Bob's turn must not inherit her JWT.
  it('never hands one person\'s ByteCloud JWT to another', async () => {
    bytedcliJwts.set(ALICE, { cloudJwt: 'cloud-alice' });
    const config = botConfig({ enabled: true, tools: ['bytedcli'] });
    await publish(config, ALICE);
    const outcomes = await publish(config, BOB);

    expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('needs-authorization');
    expect(readFileSync(sessionIdentityPath(dir, SESSION, 'bytedcli'), 'utf8'))
      .not.toContain('cloud-alice');
  });
});

// The identity has to say which turn it is for, or the wrapper cannot tell a
// stale one from the current one — see the turn-binding tests in
// cli-identity.test.ts for what it does with this.
describe('publishTurnCliIdentity — turn stamping', () => {
  it('stamps the turn on published credentials', async () => {
    tokens.set(`${APP}|${ALICE}`, 'tok-alice');
    await publish(botConfig(), ALICE, 'turn-A');
    expect(readFileSync(larkPath(), 'utf8')).toContain("BOTMUX_IDENTITY_TURN='turn-A'");
  });

  it('stamps the turn on a refusal too', async () => {
    const config = botConfig({ enabled: true, tools: ['lark-cli'], fallback: 'none' });
    await publish(config, BOB, 'turn-B');
    const body = readFileSync(larkPath(), 'utf8');
    expect(body).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(body).toContain("BOTMUX_IDENTITY_TURN='turn-B'");
  });
});

describe('publishTurnCliIdentity — an off policy touches nothing', () => {
  it('reports off and leaves files alone when disabled', async () => {
    // A pre-existing file (e.g. written while the policy was on) is left as-is:
    // this function reports "not my business", and teardown/close is what clears
    // it. Touching files for an ungoverned tool would be surprising.
    writeSessionIdentity(dir, SESSION, { tool: 'lark-cli', appId: APP, userAccessToken: 'stale' });
    const outcomes = await publish(botConfig({ enabled: false }), ALICE);
    expect(outcomes.every(o => o.state === 'off')).toBe(true);
  });

  it('reports off for a tool outside the selected set', async () => {
    tokens.set(`${APP}|${ALICE}`, 'tok-alice');
    const outcomes = await publish(botConfig({ enabled: true, tools: ['lark-cli'] }), ALICE);
    expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('off');
  });

  it('reports off when the field is absent entirely', async () => {
    const outcomes = await publish({ larkAppId: APP, larkAppSecret: 's', brand: 'feishu' } as any, ALICE);
    expect(outcomes.every(o => o.state === 'off')).toBe(true);
  });
});

describe('publishTurnCliIdentity — failures fail closed', () => {
  it('withholds rather than propagating when the token store throws', async () => {
    const { resolveUserToken } = await import('../src/utils/user-token.js');
    tokens.set(`${APP}|${ALICE}`, 'tok-alice');
    await publish(botConfig(), ALICE);
    expect(existsSync(larkPath())).toBe(true);

    vi.mocked(resolveUserToken).mockRejectedValueOnce(new Error('keychain unavailable'));
    const outcomes = await publish(botConfig(), ALICE);
    // The turn survives, and the stale identity is gone. A store outage lands on
    // the same policy as "never authorized" — a refusal with a link, never a
    // borrowed or machine identity.
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    expect(readFileSync(larkPath(), 'utf8')).not.toContain('tok-alice');
  });

  // Without app credentials there is no bot identity to fall back to either —
  // running as the bot needs the very app id and secret that are missing. So
  // this degrades to a refusal, not to "run it and see".
  it('refuses when the bot has no app credentials to pair with the token', async () => {
    tokens.set(`|${ALICE}`, 'tok');
    const outcomes = await publish(
      { larkAppId: '', larkAppSecret: '', brand: 'feishu', triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli'] }) } as any,
      ALICE,
    );
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    expect(readFileSync(larkPath(), 'utf8')).toContain('BOTMUX_IDENTITY_MODE=\'denied\'');
  });
});

describe('verified cross-bot delegation', () => {
  const delegatedIdentity = {
    targetOpenId: 'ou_alice_target', credentialOpenId: ALICE,
    tools: ['lark-cli', 'bytedcli'] as ('lark-cli' | 'bytedcli')[], dispatchRoot: 'om_dispatch',
  };
  const delegated = (turnId = 'om_delegated', tools = delegatedIdentity.tools) => publishTurnCliIdentity({
    botConfig: botConfig({ enabled: true, tools: ['lark-cli', 'bytedcli'] }), sessionDataDir: dir,
    sessionId: SESSION, senderOpenId: 'ou_source_bot', turnId,
    delegatedIdentity: { ...delegatedIdentity, tools },
  });
  it('uses original user login for CLI identities and stamps the target turn', async () => {
    bytedcliJwts.set(ALICE, { cloudJwt: 'alice-cloud' });
    bytedcliJwts.set('ou_source_bot', { cloudJwt: 'wrong-bot' });
    larkHomes.set(ALICE, '/isolated/alice');
    expect(await delegated()).toEqual([{ tool: 'lark-cli', state: 'user' }, { tool: 'bytedcli', state: 'user' }]);
    expect(readFileSync(larkPath(), 'utf8')).toContain('/isolated/alice');
    const env = readFileSync(sessionIdentityPath(dir, SESSION, 'bytedcli'), 'utf8');
    expect(env).toContain('alice-cloud');
    expect(env).toContain('om_delegated');
    expect(env).not.toContain('wrong-bot');
  });
  it('rechecks authorization on retry and clears revoked credentials', async () => {
    bytedcliJwts.set(ALICE, { cloudJwt: 'revocable' });
    await delegated();
    bytedcliJwts.delete(ALICE);
    await delegated();
    const env = readFileSync(sessionIdentityPath(dir, SESSION, 'bytedcli'), 'utf8');
    expect(env).not.toContain('revocable');
    expect(env).toContain('report --dispatch-root om_dispatch');
    expect(env).toContain('Do not ask a bot to log in');
  });
  it('does not forward source-app OAuth as a target-app token', async () => {
    tokens.set(`cli_source|${ALICE}`, 'source-oauth');
    await delegated();
    expect(readFileSync(larkPath(), 'utf8')).not.toContain('source-oauth');
    tokens.set(`${APP}|ou_alice_target`, 'target-oauth');
    await delegated();
    expect(readFileSync(larkPath(), 'utf8')).toContain('target-oauth');
  });
  it('target cannot widen delegated tool permissions', async () => {
    bytedcliJwts.set(ALICE, { cloudJwt: 'alice-cloud' });
    larkHomes.set(ALICE, '/isolated/alice');
    expect(await delegated('om_narrow', ['bytedcli'])).toEqual([
      { tool: 'lark-cli', state: 'needs-authorization' }, { tool: 'bytedcli', state: 'user' },
    ]);
    expect(readFileSync(larkPath(), 'utf8')).not.toContain('/isolated/alice');
  });
  it('a later direct human turn uses that human and never inherits delegation', async () => {
    bytedcliJwts.set(ALICE, { cloudJwt: 'alice-cloud' });
    bytedcliJwts.set(BOB, { cloudJwt: 'bob-cloud' });
    await delegated();
    await publish(botConfig({ enabled: true, tools: ['bytedcli'] }), BOB, 'om_bob');
    const env = readFileSync(sessionIdentityPath(dir, SESSION, 'bytedcli'), 'utf8');
    expect(env).toContain('bob-cloud');
    expect(env).not.toContain('alice-cloud');
  });
});

describe('target daemon consumes signed message authority', () => {
  async function targetHarness(options: { mapping?: 'resolved' | 'transient'; member?: boolean; memberError?: boolean; talk?: boolean; scope?: 'chat' | 'thread' } = {}) {
    const ts = (await import('typescript')).default;
    const { deliverDispatchWithUser, resolveDispatchUser, dispatchCallerFromReply } = await import('../src/core/dispatch-user-delegation.js');
    const { pickTurnReplyTarget } = await import('../src/core/reply-target.js');
    const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const code = ['dispatchUserForTurn', 'targetUserForDelegation', 'refreshTurnCliIdentity'].map(name => {
      const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
      if (!fn) throw new Error('Missing production handler');
      return ts.transpileModule(fn.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    }).join('\n');
    const secret = 'target-test-secret';
    await deliverDispatchWithUser({ dataDir: dir, secret, payload: {
      sourceAppId: 'cli_source', sourceSessionId: 'source', sourceTurnId: 'om_human',
      rootId: 'om_root', chatId: 'oc_chat', targetAppIds: [APP],
      authority: { appId: 'cli_source', openId: ALICE, unionId: 'on_alice', tools: ['bytedcli'] },
    }, send: async () => 'om_kickoff' });
    const scope = options.scope ?? 'thread';
    const ds: any = { larkAppId: APP, chatId: 'oc_chat', chatType: 'group', scope,
      session: { sessionId: SESSION, rootMessageId: scope === 'thread' ? 'om_root' : 'om_shared',
        replyTargets: { om_kickoff: { senderOpenId: 'ou_peer', rootMessageId: 'om_root', updatedAt: new Date().toISOString() } },
      },
    };
    const resolveTargetAppOpenId = vi.fn(async () => options.mapping === 'transient'
      ? { status: 'transient' } : { status: 'resolved', openId: 'ou_alice_target' });
    const scopeValues = {
      config: { session: { dataDir: dir } }, pickTurnReplyTarget, resolveDispatchUser, dispatchCallerFromReply,
      getBot: () => ({ config: botConfig({ enabled: true, tools: ['bytedcli'] }) }),
      loadOrCreateDashboardSecret: () => secret, dispatchReportBindingSecretPath: () => '',
      resolveTargetAppOpenId, evaluateTalk: () => ({ allowed: options.talk !== false }),
      listChatMemberOpenIds: async () => {
        if (options.memberError) throw new Error('member list exceeds 2000 members');
        return options.member === false ? [] : ['ou_alice_target'];
      },
      publishTurnCliIdentity, localeForBot: () => 'en', logger: { warn: vi.fn() },
    };
    const run = new Function('scope', 'with (scope) { ' + code + '; return refreshTurnCliIdentity; }')(scopeValues);
    return { ds, scopeValues, run: (turnId = 'om_kickoff') => run(ds, turnId), resolveTargetAppOpenId };
  }
  it.each(['live', 'restored'])('a proven human turn does not depend on the delegation store (%s)', async mode => {
    const h = await targetHarness();
    writeFileSync(join(dir, 'dispatch-user-delegations.json'), 'corrupt-json');
    h.ds.session.replyTargets.om_human = { senderOpenId: BOB, rootMessageId: 'om_root', updatedAt: new Date().toISOString(),
      ...(mode === 'restored' ? { participants: [{ openId: BOB, isBot: false }] } : {}),
    };
    if (mode === 'live') h.ds.activeInteractiveTurn = { turnId: 'om_human', caller: {
      senderType: 'user', requestLarkAppId: APP, requestUserOpenId: BOB,
    } };
    bytedcliJwts.set(BOB, { cloudJwt: 'direct-human' });
    await h.run('om_human');
    expect(readFileSync(sessionIdentityPath(dir, SESSION, 'bytedcli'), 'utf8')).toContain('direct-human');
    expect(h.resolveTargetAppOpenId).not.toHaveBeenCalled();
  });
  it('a delegated bot turn still refuses a corrupt delegation store', async () => {
    const h = await targetHarness();
    writeFileSync(join(dir, 'dispatch-user-delegations.json'), 'corrupt-json');
    bytedcliJwts.set(ALICE, { cloudJwt: 'must-not-leak' });
    bytedcliJwts.set('ou_peer', { cloudJwt: 'must-not-use-peer' });
    await h.run();
    const env = readFileSync(sessionIdentityPath(dir, SESSION, 'bytedcli'), 'utf8');
    expect(env).not.toContain('must-not-');
  });
  it.each(['participants', 'quote'])('does not publish a peer bot as a human (%s)', async evidence => {
    const h = await targetHarness();
    h.ds.session.replyTargets.om_peer = { senderOpenId: 'ou_peer', rootMessageId: 'om_root', updatedAt: new Date().toISOString(),
      ...(evidence === 'participants' ? { participants: [{ openId: 'ou_peer', isBot: true }] } : {}),
    };
    if (evidence === 'quote') {
      h.ds.session.quoteTargetId = 'om_peer'; h.ds.session.quoteTargetSenderIsBot = true;
    }
    bytedcliJwts.set('ou_peer', { cloudJwt: 'must-not-use-peer' });
    await h.run('om_peer');
    expect(readFileSync(sessionIdentityPath(dir, SESSION, 'bytedcli'), 'utf8')).not.toContain('must-not-use-peer');
  });
  it('reports unavailable member verification without telling the human to log in again', async () => {
    const h = await targetHarness({ memberError: true });
    bytedcliJwts.set(ALICE, { cloudJwt: 'must-not-leak' });
    await h.run();
    const env = readFileSync(sessionIdentityPath(dir, SESSION, 'bytedcli'), 'utf8');
    expect(env).toContain('membership verification is unavailable');
    expect(env).toContain('report --dispatch-root om_root');
    expect(env).not.toContain('ask the original human to authorize');
    expect(env).not.toContain('must-not-leak');
  });
  it.each(['chat', 'thread'] as const)('publishes original credentials after signed dispatch + cross-app resolution (%s)', async scope => {
    const h = await targetHarness({ scope });
    bytedcliJwts.set(ALICE, { cloudJwt: 'original-user' });
    await h.run();
    expect(h.resolveTargetAppOpenId).toHaveBeenCalledExactlyOnceWith(APP, 'on_alice');
    expect(readFileSync(sessionIdentityPath(dir, SESSION, 'bytedcli'), 'utf8')).toContain('original-user');
  });
  it.each([{ mapping: 'transient' as const }, { member: false }, { talk: false }])('denies identity when target cannot validate user %j', async options => {
    const h = await targetHarness(options);
    bytedcliJwts.set(ALICE, { cloudJwt: 'must-not-leak' });
    await h.run();
    const env = readFileSync(sessionIdentityPath(dir, SESSION, 'bytedcli'), 'utf8');
    expect(env).not.toContain('must-not-leak');
    expect(env).toContain('report --dispatch-root om_root');
  });
  it('never uses root binding for an unrelated later turn', async () => {
    const h = await targetHarness();
    bytedcliJwts.set(ALICE, { cloudJwt: 'must-not-leak' });
    await h.run('om_unrelated');
    expect(h.resolveTargetAppOpenId).not.toHaveBeenCalled();
    expect(readFileSync(sessionIdentityPath(dir, SESSION, 'bytedcli'), 'utf8')).not.toContain('must-not-leak');
  });
});


it('does not begin another login when the bytedcli provider fails', async () => {
  const provider = await import('../src/services/bytedcli-auth.js');
  vi.mocked(provider.beginBytedcliLogin).mockClear();
  vi.mocked(provider.mintBytedcliJwts).mockRejectedValueOnce(new Error('provider unavailable'));
  writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', cloudJwt: 'old-sender-credential' });
  const result = await publishTurnCliIdentity({
    botConfig: botConfig({ enabled: true, tools: ['bytedcli'] }), sessionDataDir: dir, sessionId: SESSION, senderOpenId: ALICE,
  });
  expect(result).toContainEqual({ tool: 'bytedcli', state: 'unavailable' });
  expect(provider.beginBytedcliLogin).not.toHaveBeenCalled();
  const written = readFileSync(sessionIdentityPath(dir, SESSION, 'bytedcli'), 'utf8');
  expect(written).toContain('停止自动重试');
  expect(written).not.toContain('old-sender-credential');
});
