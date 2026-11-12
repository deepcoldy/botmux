/**
 * Local ByteCloud login finished mid-turn: the refusal the turn started with is
 * replaced, so the agent's retry of the refused command runs in the same turn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let minted: { cloudJwt: string } | null = null;
vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: vi.fn(async () => null),
  lookupAuthorizedUserName: vi.fn(() => undefined),
  isUsableOpenId: (openId: unknown) => typeof openId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(openId),
}));
vi.mock('../src/services/bytedcli-auth.js', () => ({
  renewBytedcliJwts: vi.fn(async () => null),
  mintBytedcliJwts: vi.fn(async () => minted),
  beginBytedcliLogin: vi.fn(async () => ({ authUrl: 'https://cloud.example.test/local', completeToken: 'tok' })),
}));
vi.mock('../src/services/cli-auth-epoch.js', () => ({ readCliAuthEpoch: () => 0 }));
vi.mock('../src/services/lark-cli-auth.js', () => ({
  resolveLarkCliHomeForTurn: vi.fn(async () => null),
  pendingLarkCliChallenge: vi.fn(() => null),
  beginLarkCliLogin: vi.fn(async () => null),
}));

const { publishTurnCliIdentity, adoptLocalBytedcliAuthorization } = await import('../src/core/turn-cli-identity.js');
const { recallProvenIdentityContent, forgetProvenIdentityContent } = await import('../src/core/cli-identity.js');
const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');

const ALICE = 'ou_alice';
const SESSION = 'sess-1';
const TURN = 'om_t1';
let dir: string;
const config = {
  larkAppId: 'cli_bot', larkAppSecret: 'secret', brand: 'feishu' as const,
  triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource: 'local' }) ?? undefined,
} as any;
const current = () => recallProvenIdentityContent(dir, SESSION, TURN, 'bytedcli') ?? '';
const adopt = () => adoptLocalBytedcliAuthorization({
  sessionDataDir: dir, sessionId: SESSION, turnId: TURN, botConfig: config, senderOpenId: ALICE,
});

beforeEach(() => {
  minted = null;
  dir = mkdtempSync(join(tmpdir(), 'botmux-adopt-'));
});
afterEach(() => {
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
  });

  it('leaves a turn that holds no not-authorized refusal alone', async () => {
    minted = { cloudJwt: 'cloud-jwt' };
    expect(await adopt()).toBe('none');
    expect(current()).toBe('');
  });
});
