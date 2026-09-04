/**
 * Per-turn identity publication — the decision layer.
 *
 * The property that matters most is negative: **no turn ever runs with the
 * previous sender's credentials still on disk.** So the tests below are mostly
 * about what happens when a token is *not* available — a new sender who has not
 * authorized, a turn with no human sender at all, a bot whose policy is off.
 * Every one of those must end with the file gone, not merely un-refreshed.
 *
 * Run:  npx vitest run --project unit test/turn-cli-identity.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tokens = new Map<string, string>();
vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: vi.fn(async (appId: string, _secret: string, _brand: string, openId?: string) =>
    tokens.get(`${appId}|${openId ?? ''}`) ?? null),
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

function publish(config: any, senderOpenId: string | undefined) {
  return publishTurnCliIdentity({
    botConfig: config,
    sessionDataDir: dir,
    sessionId: SESSION,
    senderOpenId,
  });
}

const larkPath = () => sessionIdentityPath(dir, SESSION, 'lark-cli');

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
  it('clears when the new sender has not authorized', async () => {
    tokens.set(`${APP}|${ALICE}`, 'tok-alice');
    await publish(botConfig(), ALICE);
    expect(existsSync(larkPath())).toBe(true);

    // Bob has no token: the file must GO, not keep Alice's.
    const outcomes = await publish(botConfig(), BOB);
    expect(existsSync(larkPath())).toBe(false);
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('bot-identity');
  });

  // Scheduled runs, hooks, meeting events and bot-to-bot handoffs have no
  // trigger user. Reaching for the session creator's or owner's credentials to
  // fill that gap is exactly the borrowing this feature removes.
  it('clears when the turn has no human sender', async () => {
    tokens.set(`${APP}|${ALICE}`, 'tok-alice');
    await publish(botConfig(), ALICE);
    const outcomes = await publish(botConfig(), undefined);
    expect(existsSync(larkPath())).toBe(false);
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('bot-identity');
  });

  it('reports needs-authorization instead of degrading under fallback: none', async () => {
    const config = botConfig({ enabled: true, tools: ['lark-cli'], fallback: 'none' });
    const outcomes = await publish(config, BOB);
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('needs-authorization');
    expect(existsSync(larkPath())).toBe(false);
  });

  // bytedcli authenticates against ByteCloud SSO, a different provider from Lark
  // OAuth — a Lark token cannot become a ByteCloud JWT. It must report "not
  // authorized" rather than quietly using the machine's own SSO session.
  it('never fabricates a bytedcli identity from a Lark token', async () => {
    tokens.set(`${APP}|${ALICE}`, 'tok-alice');
    const config = botConfig({ enabled: true, tools: ['lark-cli', 'bytedcli'] });
    const outcomes = await publish(config, ALICE);
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('user');
    expect(outcomes.find(o => o.tool === 'bytedcli')?.state).toBe('needs-authorization');
    expect(existsSync(sessionIdentityPath(dir, SESSION, 'bytedcli'))).toBe(false);
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
    // The turn survives, and the stale identity is gone.
    expect(existsSync(larkPath())).toBe(false);
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('bot-identity');
  });

  it('withholds when the bot has no app credentials to pair with the token', async () => {
    tokens.set(`|${ALICE}`, 'tok');
    const outcomes = await publish(
      { larkAppId: '', larkAppSecret: '', brand: 'feishu', triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli'] }) } as any,
      ALICE,
    );
    expect(outcomes.find(o => o.tool === 'lark-cli')?.state).toBe('bot-identity');
    expect(existsSync(larkPath())).toBe(false);
  });
});
