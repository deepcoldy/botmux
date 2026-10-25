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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
const { writeSessionIdentity, recallProvenIdentityContent, renderIdentityWrapper } = await import('../src/core/cli-identity.js');
const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
const { noteSenderUnionId } = await import('../src/core/platform-credential-source.js');

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

function publish(config: any, senderOpenId: string | undefined, turnId = 'turn-default') {
  return publishTurnCliIdentity({
    botConfig: config,
    turnId,
    storageModel: 'proven',
    sessionDataDir: dir,
    sessionId: SESSION,
    senderOpenId,
  });
}

// Proven identities live in daemon memory; these read them back the way the
// current-execution route would, keyed by turn exactly as published.
function identityBody(tool: 'lark-cli' | 'bytedcli', turnId = 'turn-default'): string {
  const value = recallProvenIdentityContent(dir, SESSION, turnId, tool);
  if (value === undefined) throw new Error(`no proven ${tool} identity for ${turnId}`);
  return value;
}
function published(tool: 'lark-cli' | 'bytedcli', turnId = 'turn-default'): boolean {
  return recallProvenIdentityContent(dir, SESSION, turnId, tool) !== undefined;
}


describe('publishTurnCliIdentity — lark-cli per-person HOME (device flow)', () => {
  it('publishes the per-person HOME as a user-home identity (no token injected)', async () => {
    larkHomes.set(ALICE, '/homes/alice');
    const outcomes = await publish(botConfig(), ALICE);
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('user');
    const body = identityBody('lark-cli');
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
    expect(identityBody('lark-cli')).toContain('https://example.com/lark-device');

    // Approval landed between turns; the resolver poll now returns the HOME.
    pendingChallenges.delete(BOB);
    larkHomes.set(BOB, '/homes/bob');
    const t2 = await publish(botConfig(), BOB);
    expect(t2.find(o => o.tool === 'lark-cli')?.state).toBe('user');
    expect(identityBody('lark-cli')).toContain("BOTMUX_IDENTITY_MODE='user-home'");
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
    const body = identityBody('lark-cli');
    expect(body).toContain('tok-alice');
    expect(body).toContain(APP);
  });

  it('swaps the acting identity when a different person speaks next', async () => {
    tokens.set(`${APP}|${ALICE}`, 'tok-alice');
    tokens.set(`${APP}|${BOB}`, 'tok-bob');
    await publish(botConfig(), ALICE);
    await publish(botConfig(), BOB);
    const body = identityBody('lark-cli');
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
    expect(published('lark-cli')).toBe(true);

    // Bob has no identity: lark-cli (whose docs/drive/wiki surface is user-only)
    // must not silently run as the bot or inherit Alice. It is refused with a
    // ready device-code link, exactly like bytedcli.
    const outcomes = await publish(botConfig(), BOB);
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    const body = identityBody('lark-cli');
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
    expect(identityBody('lark-cli')).not.toContain('tok-alice');
  });

  it('reports needs-authorization instead of degrading under fallback: none', async () => {
    const config = botConfig({ enabled: true, tools: ['lark-cli'], fallback: 'none' });
    const outcomes = await publish(config, BOB);
    expect(identityBody('lark-cli')).toContain('飞书');
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    // A refusal is published, not an empty file: it carries the text the person
    // whose command just failed reads, including how to authorize.
    const body = identityBody('lark-cli');
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
    const body = identityBody('bytedcli');
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
    expect(identityBody('lark-cli')).toContain('孙晓雪');
  });

  it('publishes this person\'s own ByteCloud JWTs once they have authorized', async () => {
    bytedcliJwts.set(ALICE, { cloudJwt: 'cloud-alice', codeJwt: 'code-alice' });
    const config = botConfig({ enabled: true, tools: ['bytedcli'] });
    const outcomes = await publish(config, ALICE);

    expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('user');
    const body = identityBody('bytedcli');
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
    expect(identityBody('bytedcli'))
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
    expect(identityBody('lark-cli', 'turn-A')).toContain("BOTMUX_IDENTITY_TURN='turn-A'");
  });

  it('stamps the turn on a refusal too', async () => {
    const config = botConfig({ enabled: true, tools: ['lark-cli'], fallback: 'none' });
    await publish(config, BOB, 'turn-B');
    const body = identityBody('lark-cli', 'turn-B');
    expect(body).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(body).toContain("BOTMUX_IDENTITY_TURN='turn-B'");
  });
});

describe('publishTurnCliIdentity — an off policy touches nothing', () => {
  it('reports off and leaves files alone when disabled', async () => {
    // A pre-existing file (e.g. written while the policy was on) is left as-is:
    // this function reports "not my business", and teardown/close is what clears
    // it. Touching files for an ungoverned tool would be surprising.
    writeSessionIdentity(dir, SESSION, { tool: 'lark-cli', appId: APP, userAccessToken: 'stale', turnId: 'turn-stale' }, 'proven');
    const outcomes = await publish(botConfig({ enabled: false }), ALICE);
    expect(outcomes.every(o => o.state === 'off')).toBe(true);
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-stale', 'lark-cli')).toContain('stale');
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
    expect(published('lark-cli')).toBe(true);

    vi.mocked(resolveUserToken).mockRejectedValueOnce(new Error('keychain unavailable'));
    const outcomes = await publish(botConfig(), ALICE);
    // The turn survives, and the stale identity is gone. A store outage lands on
    // the same policy as "never authorized" — a refusal with a link, never a
    // borrowed or machine identity.
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    expect(identityBody('lark-cli')).not.toContain('tok-alice');
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
    expect(identityBody('lark-cli')).toContain('BOTMUX_IDENTITY_MODE=\'denied\'');
  });
});

describe('verified cross-bot delegation', () => {
  const delegatedIdentity = {
    targetOpenId: 'ou_alice_target', credentialOpenId: ALICE,
    tools: ['lark-cli', 'bytedcli'] as ('lark-cli' | 'bytedcli')[], dispatchRoot: 'om_dispatch',
  };
  const delegated = (turnId = 'om_delegated', tools = delegatedIdentity.tools) => publishTurnCliIdentity({
    botConfig: botConfig({ enabled: true, tools: ['lark-cli', 'bytedcli'] }), sessionDataDir: dir,
    sessionId: SESSION, senderOpenId: 'ou_source_bot', turnId, storageModel: 'proven',
    delegatedIdentity: { ...delegatedIdentity, tools },
  });
  it('uses original user login for CLI identities and stamps the target turn', async () => {
    bytedcliJwts.set(ALICE, { cloudJwt: 'alice-cloud' });
    bytedcliJwts.set('ou_source_bot', { cloudJwt: 'wrong-bot' });
    larkHomes.set(ALICE, '/isolated/alice');
    expect(await delegated()).toEqual([{ tool: 'lark-cli', state: 'user' }, { tool: 'bytedcli', state: 'user' }]);
    expect(identityBody('lark-cli', 'om_delegated')).toContain('/isolated/alice');
    const env = identityBody('bytedcli', 'om_delegated');
    expect(env).toContain('alice-cloud');
    expect(env).toContain('om_delegated');
    expect(env).not.toContain('wrong-bot');
  });
  it('rechecks authorization on retry and clears revoked credentials', async () => {
    bytedcliJwts.set(ALICE, { cloudJwt: 'revocable' });
    await delegated();
    bytedcliJwts.delete(ALICE);
    await delegated();
    const env = identityBody('bytedcli', 'om_delegated');
    expect(env).not.toContain('revocable');
    expect(env).toContain('report --dispatch-root om_dispatch');
    expect(env).toContain('Do not ask a bot to log in');
  });
  it('does not forward source-app OAuth as a target-app token', async () => {
    tokens.set(`cli_source|${ALICE}`, 'source-oauth');
    await delegated();
    expect(identityBody('lark-cli', 'om_delegated')).not.toContain('source-oauth');
    tokens.set(`${APP}|ou_alice_target`, 'target-oauth');
    await delegated();
    expect(identityBody('lark-cli', 'om_delegated')).toContain('target-oauth');
  });
  it('target cannot widen delegated tool permissions', async () => {
    bytedcliJwts.set(ALICE, { cloudJwt: 'alice-cloud' });
    larkHomes.set(ALICE, '/isolated/alice');
    expect(await delegated('om_narrow', ['bytedcli'])).toEqual([
      { tool: 'lark-cli', state: 'needs-authorization' }, { tool: 'bytedcli', state: 'user' },
    ]);
    expect(identityBody('lark-cli', 'om_narrow')).not.toContain('/isolated/alice');
  });
  it('a later direct human turn uses that human and never inherits delegation', async () => {
    bytedcliJwts.set(ALICE, { cloudJwt: 'alice-cloud' });
    bytedcliJwts.set(BOB, { cloudJwt: 'bob-cloud' });
    await delegated();
    await publish(botConfig({ enabled: true, tools: ['bytedcli'] }), BOB, 'om_bob');
    const env = identityBody('bytedcli', 'om_bob');
    expect(env).toContain('bob-cloud');
    expect(env).not.toContain('alice-cloud');
  });
});

describe('queued identities stay separate from the executing task', () => {
  // The proven runner returns the env ASSIGNMENTS for the execution it proved;
  // here a stub stands in for that daemon channel and cats the body the test
  // published for the currently executing turn. Nothing in the session
  // directory participates in the selection.
  function installProvenWrapper(tool: 'lark-cli' | 'bytedcli'): { wrapper: string; proofFile: string } {
    const proofFile = join(dir, `proof-current-${tool}`);
    const runner = join(dir, `fake-runner-${tool}`);
    writeFileSync(runner, '#!/bin/sh\ncat "$BOTMUX_TEST_PROOF_FILE"\n', { mode: 0o755 });
    const wrapper = join(dir, `identity-wrapper-${tool}`);
    writeFileSync(wrapper, renderIdentityWrapper(tool, '/usr/bin/printenv', 'proven', [runner]));
    return { wrapper, proofFile };
  }

  it.each([
    ['direct', 'lark-cli'], ['direct', 'bytedcli'],
    ['delegated', 'lark-cli'], ['delegated', 'bytedcli'],
  ] as const)('selects %s %s credentials only when their turn starts', async (route, tool) => {
    const { publishActiveTurn } = await import('../src/core/cli-identity.js');
    const { wrapper, proofFile } = installProvenWrapper(tool);
    const config = botConfig({ enabled: true, tools: [tool] });
    const users = [ALICE, BOB, 'ou_charlie'];
    const targetId = (user: string) => route === 'delegated' ? `${user}_target` : user;
    const prepare = async (user: string) => publishTurnCliIdentity({
      botConfig: config, sessionDataDir: dir, sessionId: SESSION,
      senderOpenId: route === 'delegated' ? 'ou_peer_bot' : user,
      turnId: `turn-${user}`, storageModel: 'proven',
      ...(route === 'delegated' ? { delegatedIdentity: {
        targetOpenId: targetId(user), credentialOpenId: user,
        tools: [tool], dispatchRoot: `dispatch-${user}`,
      } } : {}),
    });
    const run = () => spawnSync('/bin/sh', [wrapper,
      tool === 'bytedcli' ? 'BYTEDCLI_USER_CLOUD_JWT' : 'LARKSUITE_CLI_USER_ACCESS_TOKEN'], {
      env: { PATH: '/usr/bin:/bin', SESSION_DATA_DIR: dir, BOTMUX_SESSION_ID: SESSION, BOTMUX_TEST_PROOF_FILE: proofFile },
      encoding: 'utf8',
    });
    // Simulate the daemon serving the proven content of the turn that just
    // became the current execution.
    const beginExecuting = (user: string) => {
      publishActiveTurn(dir, SESSION, `turn-${user}`, undefined, targetId(user));
      writeFileSync(proofFile, recallProvenIdentityContent(dir, SESSION, `turn-${user}`, tool)!);
    };
    for (const user of users) {
      tokens.set(`${APP}|${targetId(user)}`, `credential-${user}`);
      bytedcliJwts.set(user, { cloudJwt: `credential-${user}` });
    }
    await prepare(ALICE);
    beginExecuting(ALICE);
    await prepare(BOB);
    await prepare('ou_charlie');
    expect(run().stdout.trim()).toBe(`credential-${ALICE}`);
    for (const user of users.slice(1)) {
      beginExecuting(user);
      const result = run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(`credential-${user}`);
    }
    bytedcliJwts.delete(BOB);
    tokens.delete(`${APP}|${targetId(BOB)}`);
    await prepare(BOB);
    expect(run().stdout.trim()).toBe('credential-ou_charlie');
    beginExecuting(BOB);
    expect(run().status).toBe(77);
  });

  it('cannot be redirected by rewriting the active-turn marker (proven content)', async () => {
    const tool = 'bytedcli' as const;
    const { publishActiveTurn } = await import('../src/core/cli-identity.js');
    const { wrapper, proofFile } = installProvenWrapper(tool);
    const config = botConfig({ enabled: true, tools: [tool] });
    bytedcliJwts.set(ALICE, { cloudJwt: 'cloud-alice' });
    bytedcliJwts.set(BOB, { cloudJwt: 'cloud-bob' });
    await publishTurnCliIdentity({ botConfig: config, sessionDataDir: dir, sessionId: SESSION,
      senderOpenId: ALICE, turnId: 'turn-a', storageModel: 'proven' });
    await publishTurnCliIdentity({ botConfig: config, sessionDataDir: dir, sessionId: SESSION,
      senderOpenId: BOB, turnId: 'turn-b', storageModel: 'proven' });
    publishActiveTurn(dir, SESSION, 'turn-a');
    writeFileSync(proofFile, recallProvenIdentityContent(dir, SESSION, 'turn-a', tool)!);
    const env = { PATH: '/usr/bin:/bin', SESSION_DATA_DIR: dir, BOTMUX_SESSION_ID: SESSION, BOTMUX_TEST_PROOF_FILE: proofFile };
    const run = () => spawnSync('/bin/sh', [wrapper, 'BYTEDCLI_USER_CLOUD_JWT'], { env, encoding: 'utf8' });
    expect(run().stdout.trim()).toBe('cloud-alice');
    // The attack from the review: enumerate the turn dirs and repoint the
    // marker at Bob's prepared snapshot. The proven wrapper never reads the
    // marker, so the execution keeps using Alice.
    const marker = join(dir, 'cli-identity', SESSION + '.bin', '.data', 'turn');
    const current = readFileSync(marker, 'utf8');
    const rewritten = current.split('\n').map((line, i) => i === 2
      ? createHash('sha256').update('turn-b').digest('hex')
      : i === 3 ? 'turn-b' : line).join('\n');
    writeFileSync(marker, rewritten);
    expect(run().stdout.trim()).toBe('cloud-alice');
  });
});

describe('target daemon consumes signed message authority', () => {
  async function targetHarness(options: { mapping?: 'resolved' | 'transient'; member?: boolean; memberError?: boolean; talk?: boolean; scope?: 'chat' | 'thread' } = {}) {
    const ts = (await import('typescript')).default;
    const { deliverDispatchWithUser, resolveDispatchUser, dispatchCallerFromReply } = await import('../src/core/dispatch-user-delegation.js');
    const { pickTurnReplyTarget } = await import('../src/core/reply-target.js');
    const { trustedCallerForScheduledTask } = await import('../src/core/scheduled-turn-provenance.js');
    const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
    const code = ['triggerUserAuthEnabledFor', 'prepareTurnCliIdentity',
      'dispatchUserForTurn', 'targetUserForDelegation', 'delegatedScheduleRuntimeDeps',
      'delegatedScheduleCliIdentity', 'prepareScheduledTurnCliIdentity', 'prepareDelegatedScheduledTurnIdentity',
      'refreshTurnCliIdentity', 'identityPublicationConflicted', 'identityModelForPublication'].map(name => {
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
      loadOrCreateDispatchReportBindingSecret: () => secret,
      resolveTargetAppOpenId, evaluateTalk: () => ({ allowed: options.talk !== false }),
      listChatMemberOpenIds: async () => {
        if (options.memberError) throw new Error('member list exceeds 2000 members');
        return options.member === false ? [] : ['ou_alice_target'];
      },
      publishTurnCliIdentity, noteSenderUnionId, localeForBot: () => 'en', logger: { warn: vi.fn(), error: vi.fn() },
      identityStorageModelForDaemonSession: () => 'proven',
      identityDecisionConflict: () => undefined,
      parseScheduledTurnId: (turnId: string) => {
        const match = /^schedule:([0-9a-z_]{1,50}):[0-9a-f-]{36}$/.exec(turnId);
        return match?.[1] ?? null;
      },
      trustedCallerForScheduledTask,
      scheduleStore: { effectiveScheduleChatIds: (task: any) => task.chatIds ?? [task.chatId] },
      getDashboardAdminOpenIds: () => [ALICE],
      canOperate: vi.fn((_appId: string, _chatId: string, openId?: string) => openId === ALICE),
      scheduleAuthorityStore: undefined as any,
    };
    const handlers = new Function('scope', 'with (scope) { ' + code
      + '; return { refreshTurnCliIdentity, prepareTurnCliIdentity }; }')(scopeValues);
    return {
      ds,
      scopeValues,
      run: (turnId = 'om_kickoff') => turnId.startsWith('schedule:')
        ? handlers.prepareTurnCliIdentity(ds, turnId)
        : handlers.refreshTurnCliIdentity(ds, turnId),
      resolveTargetAppOpenId,
      installSchedulerCallback: (scope: Record<string, unknown>) => {
        let registration: import('typescript').CallExpression | undefined;
        const find = (node: import('typescript').Node) => {
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && node.expression.expression.getText(source) === 'scheduler'
            && node.expression.name.text === 'setExecuteCallback') registration = node;
          ts.forEachChild(node, find);
        };
        find(source);
        if (!registration) throw new Error('Missing production scheduler callback');
        const code = ts.transpileModule(registration.getText(source), {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText;
        new Function('scope', 'with (scope) { ' + code + ' }')({
          ...scopeValues, prepareTurnCliIdentity: handlers.prepareTurnCliIdentity, ...scope,
        });
      },
    };
  }
  function directSchedule(h: Awaited<ReturnType<typeof targetHarness>>, patch: Record<string, unknown> = {}) {
    const task = {
      id: 'a1b2c3d4', chatId: 'oc_chat', larkAppId: APP, creatorLarkAppId: APP,
      ownerOpenId: ALICE, ownerUnionId: 'on_alice',
      parsed: { kind: 'interval', minutes: 30 }, ...patch,
    };
    const authority = { kind: 'direct', state: 'active', task };
    h.scopeValues.scheduleAuthorityStore = { getRecord: () => authority };
    return { task, authority };
  }
  const firstScheduledTurn = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
  const nextScheduledTurn = 'schedule:a1b2c3d4:23456789-1234-1234-1234-123456789abc';

  it.each(['bytedcli', 'lark-cli'] as const)('publishes creator credentials and executes the %s wrapper on every scheduled turn', async tool => {
    const h = await targetHarness();
    directSchedule(h);
    h.scopeValues.getBot = () => ({ config: botConfig({ enabled: true, tools: [tool] }) });
    const home = join(dir, 'alice-home');
    mkdirSync(home);
    larkHomes.set(ALICE, home);
    bytedcliJwts.set(ALICE, { cloudJwt: 'scheduled-alice' });
    const { publishActiveTurn, renderIdentityWrapper } = await import('../src/core/cli-identity.js');
    const proofFile = join(dir, `proof-scheduled-${tool}`);
    const runner = join(dir, `fake-scheduled-runner-${tool}`);
    writeFileSync(runner, '#!/bin/sh\ncat "$BOTMUX_TEST_PROOF_FILE"\n', { mode: 0o755 });
    const wrapper = join(dir, `${tool}-wrapper`);
    writeFileSync(wrapper, renderIdentityWrapper(tool, '/usr/bin/printenv', 'proven', [runner]));
    const wrapperEnv = { PATH: '/usr/bin:/bin', SESSION_DATA_DIR: dir, BOTMUX_SESSION_ID: SESSION, BOTMUX_TEST_PROOF_FILE: proofFile };
    for (const turnId of [firstScheduledTurn, nextScheduledTurn]) {
      await h.run(turnId);
      publishActiveTurn(dir, SESSION, turnId);
      writeFileSync(proofFile, recallProvenIdentityContent(dir, SESSION, turnId, tool)!);
      const result = spawnSync('/bin/sh', [wrapper, tool === 'bytedcli' ? 'BYTEDCLI_USER_CLOUD_JWT' : 'HOME'], {
        env: wrapperEnv, encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(tool === 'bytedcli' ? 'scheduled-alice' : home);
    }
    // Queued messages leave the scheduled execution's selected identity intact.
    bytedcliJwts.set(BOB, { cloudJwt: 'bob-cloud' });
    await publish(botConfig({ enabled: true, tools: [tool] }), BOB, 'om_bob');
    const stale = spawnSync('/bin/sh', [wrapper, tool === 'bytedcli' ? 'BYTEDCLI_USER_CLOUD_JWT' : 'HOME'], {
      env: wrapperEnv, encoding: 'utf8',
    });
    expect(stale.status, stale.stderr).toBe(0);
    expect(stale.stdout.trim()).toBe(tool === 'bytedcli' ? 'scheduled-alice' : home);
  });

  it('the production scheduler prepares ordinary tasks before dispatch', async () => {
    const h = await targetHarness();
    const { task } = directSchedule(h);
    bytedcliJwts.set(ALICE, { cloudJwt: 'scheduled-alice' });
    let execute: (task: any, context: any) => Promise<void>;
    let dispatches = 0;
    h.installSchedulerCallback({
      cfg: { larkAppId: APP }, scheduler: { setExecuteCallback: (fn: typeof execute) => { execute = fn; } },
      executeScheduledTaskWithPrecondition: async (_task: any, _app: any, run: () => Promise<void>) => {
        await run(); return 'executed';
      },
      executeScheduledTaskForTargets: async (task: any, _chats: any, run: (task: any) => Promise<void>) => {
        await run(task); return [];
      },
      withBotTurnAdmission: (_app: any, run: () => Promise<void>) => run(),
      activeSessions: new Map(), refreshCliVersion: vi.fn(),
      ScheduleTargetExecutionError: class extends Error {},
      resolveScheduleRunLogErrorDetails: (_precondition: any, error: Error) => ({ error: error.message }),
      executeScheduledTask: async (_task: any, _active: any, _refresh: any, _prompt: any, runtime: any) => {
        const turnId = dispatches++ === 0 ? firstScheduledTurn : nextScheduledTurn;
        await runtime?.prepareTurnIdentity(h.ds, turnId);
        const env = identityBody('bytedcli', turnId);
        expect(env).toContain('scheduled-alice');
        expect(env).toContain(turnId);
      },
      appendScheduleRunLog: vi.fn(),
    });
    for (let i = 0; i < 2; i++) await execute!(task, { runId: 'test-run', trigger: 'scheduler', startedAt: new Date().toISOString() });
    expect(dispatches).toBe(2);
  });

  it.each([
    { ownerOpenId: undefined }, { ownerUnionId: undefined },
    { creatorLarkAppId: 'cli_other' }, { ownerOpenId: BOB },
  ])('clears previous credentials when the scheduled creator is untrusted: %o', async patch => {
    const h = await targetHarness();
    directSchedule(h, patch);
    bytedcliJwts.set(ALICE, { cloudJwt: 'old-human' });
    bytedcliJwts.set(BOB, { cloudJwt: 'unauthorized-human' });
    await publish(botConfig({ enabled: true, tools: ['bytedcli'] }), ALICE, 'om_old');
    await h.run(firstScheduledTurn);
    const env = identityBody('bytedcli', firstScheduledTurn);
    expect(env).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(env).toContain(firstScheduledTurn);
    expect(env).not.toContain('old-human');
    expect(env).not.toContain('unauthorized-human');
  });

  it('publishes a denial when the scheduled creator has not authorized the tool', async () => {
    const h = await targetHarness();
    directSchedule(h);
    await h.run(firstScheduledTurn);
    expect(identityBody('bytedcli', firstScheduledTurn))
      .toContain("BOTMUX_IDENTITY_MODE='denied'");
  });

  it('honors open-mode schedule creators without requiring dashboard admin membership', async () => {
    const h = await targetHarness();
    directSchedule(h);
    h.scopeValues.getDashboardAdminOpenIds = () => [];
    h.scopeValues.canOperate.mockReturnValue(true);
    bytedcliJwts.set(ALICE, { cloudJwt: 'open-mode-alice' });
    await h.run(firstScheduledTurn);
    expect(h.scopeValues.canOperate).toHaveBeenCalledWith(APP, 'oc_chat', ALICE, 'on_alice');
    expect(identityBody('bytedcli', firstScheduledTurn)).toContain('open-mode-alice');
  });

  it('prepares restored completed one-shot turns without allowing paused tasks', async () => {
    const h = await targetHarness();
    const { authority } = directSchedule(h, {
      parsed: { kind: 'once', timestamp: Date.now() }, disabledReason: 'once_completed',
    });
    authority.state = 'completed';
    bytedcliJwts.set(ALICE, { cloudJwt: 'restored-alice' });
    await h.run(firstScheduledTurn);
    expect(identityBody('bytedcli', firstScheduledTurn)).toContain('restored-alice');
    authority.state = 'paused';
    await expect(h.run(nextScheduledTurn)).rejects.toThrow('refusing identity');
  });

  it('rejects missing authority and wrong target chat before publishing credentials', async () => {
    const h = await targetHarness();
    await expect(h.run(firstScheduledTurn)).rejects.toThrow('authority record missing');
    directSchedule(h, { chatId: 'oc_other' });
    await expect(h.run(firstScheduledTurn)).rejects.toThrow('target does not match');
  });

  it('keeps disabled trigger-user authentication inert for scheduled turns', async () => {
    const h = await targetHarness();
    h.scopeValues.getBot = () => ({ config: botConfig({ enabled: false }) });
    await h.run(firstScheduledTurn);
    expect(published('bytedcli', firstScheduledTurn)).toBe(false);
  });
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
    expect(identityBody('bytedcli', 'om_human')).toContain('direct-human');
    expect(h.resolveTargetAppOpenId).not.toHaveBeenCalled();
  });
  it('a delegated bot turn still refuses a corrupt delegation store', async () => {
    const h = await targetHarness();
    writeFileSync(join(dir, 'dispatch-user-delegations.json'), 'corrupt-json');
    bytedcliJwts.set(ALICE, { cloudJwt: 'must-not-leak' });
    bytedcliJwts.set('ou_peer', { cloudJwt: 'must-not-use-peer' });
    await h.run();
    const env = identityBody('bytedcli', 'om_kickoff');
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
    expect(identityBody('bytedcli', 'om_peer')).not.toContain('must-not-use-peer');
  });
  it('reports unavailable member verification without telling the human to log in again', async () => {
    const h = await targetHarness({ memberError: true });
    bytedcliJwts.set(ALICE, { cloudJwt: 'must-not-leak' });
    await h.run();
    const env = identityBody('bytedcli', 'om_kickoff');
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
    expect(identityBody('bytedcli', 'om_kickoff')).toContain('original-user');
  });
  it.each([{ mapping: 'transient' as const }, { member: false }, { talk: false }])('denies identity when target cannot validate user %j', async options => {
    const h = await targetHarness(options);
    bytedcliJwts.set(ALICE, { cloudJwt: 'must-not-leak' });
    await h.run();
    const env = identityBody('bytedcli', 'om_kickoff');
    expect(env).not.toContain('must-not-leak');
    expect(env).toContain('report --dispatch-root om_root');
  });
  it('never uses root binding for an unrelated later turn', async () => {
    const h = await targetHarness();
    bytedcliJwts.set(ALICE, { cloudJwt: 'must-not-leak' });
    await h.run('om_unrelated');
    expect(h.resolveTargetAppOpenId).not.toHaveBeenCalled();
    expect(identityBody('bytedcli', 'om_unrelated')).not.toContain('must-not-leak');
  });
  it('publishes the persisted bytedcli scope for an exact delegated scheduled turn', async () => {
    const h = await targetHarness();
    const turnId = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
    const task = { id: 'a1b2c3d4', chatId: 'oc_chat' };
    h.scopeValues.scheduleAuthorityStore = { getRecord: () => ({
      kind: 'delegated', state: 'active', task,
      controlOpenId: 'ou_alice_target', controlUnionId: 'on_alice',
      credentialOpenId: ALICE, runScopes: ['bytedcli'], selfManage: true,
      sourceMessageId: 'om_root',
    }) };
    h.scopeValues.authorizeDelegatedScheduleRun = vi.fn(async () => ({
      task, targetOpenId: 'ou_alice_target',
    }));
    h.scopeValues.readGlobalConfig = () => ({ scheduleDelegation: {
      runEnabled: true, runScopes: ['bytedcli'],
    } });
    h.scopeValues.getDashboardAdminOpenIds = () => ['ou_alice_target'];
    bytedcliJwts.set(ALICE, { cloudJwt: 'scheduled-original-user' });
    await h.run(turnId);
    expect(identityBody('bytedcli', turnId))
      .toContain('scheduled-original-user');
  });

  it('withholds every identity publication while the worker decision conflicts', async () => {
    const h = await targetHarness();
    const publish = vi.fn();
    h.scopeValues.publishTurnCliIdentity = publish;
    h.scopeValues.identityDecisionConflict = () => 'structurally cannot run proven';
    await h.run('om_kickoff');
    expect(publish).not.toHaveBeenCalled();
    // A live worker reporting again clears the conflict: publication resumes.
    h.scopeValues.identityDecisionConflict = () => undefined;
    await h.run('om_kickoff');
    expect(publish).toHaveBeenCalledOnce();
  });
});


it('does not begin another login when the bytedcli provider fails', async () => {
  const provider = await import('../src/services/bytedcli-auth.js');
  vi.mocked(provider.beginBytedcliLogin).mockClear();
  vi.mocked(provider.mintBytedcliJwts).mockRejectedValueOnce(new Error('provider unavailable'));
  writeSessionIdentity(dir, SESSION, { tool: 'bytedcli', cloudJwt: 'old-sender-credential', turnId: 'turn-unavailable' }, 'proven');
  const result = await publishTurnCliIdentity({
    botConfig: botConfig({ enabled: true, tools: ['bytedcli'] }), sessionDataDir: dir, sessionId: SESSION, senderOpenId: ALICE,
    turnId: 'turn-unavailable', storageModel: 'proven',
  });
  expect(result).toContainEqual({ tool: 'bytedcli', state: 'unavailable' });
  expect(provider.beginBytedcliLogin).not.toHaveBeenCalled();
  const written = identityBody('bytedcli', 'turn-unavailable');
  expect(written).toContain('停止自动重试');
  expect(written).not.toContain('old-sender-credential');
});
