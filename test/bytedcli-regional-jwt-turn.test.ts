/**
 * Partition-scoped ByteCloud JWTs, end to end: a turn's identity is published
 * through the real decision layer — from this machine's per-person login
 * (local) or from the bound platform's grant (platform, faked only at the HTTP
 * seam of the real grant client) — and then a real bytedcli wrapper runs.
 *
 * A cn token sent to an overseas partition is refused there (HTTP 401, which
 * people read as "not logged in"). So a call whose partition has a token for
 * this turn's sender uses it, and one whose partition has none is refused by
 * the wrapper, naming the partition — never sent with the default token.
 *
 * Run:  npx vitest run --project unit test/bytedcli-regional-jwt-turn.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: vi.fn(async () => null),
  lookupAuthorizedUserName: vi.fn(() => undefined),
  // cli-identity.ts imports this; bun rejects a mock missing an imported export.
  isUsableOpenId: (openId: unknown) => typeof openId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(openId),
}));
type LocalJwts = { cloudJwt: string; codeJwt?: string; regionalCloudJwts?: Record<string, string> };
const localJwts = new Map<string, LocalJwts>();
vi.mock('../src/services/bytedcli-auth.js', () => ({
  renewBytedcliJwts: vi.fn(async () => null),
  mintBytedcliJwts: vi.fn(async (openId: string) => localJwts.get(openId) ?? null),
  beginBytedcliLogin: vi.fn(async () => ({ authUrl: 'https://cloud.example.test/local-bytedcli', completeToken: 'tok' })),
}));
vi.mock('../src/services/lark-cli-auth.js', () => ({
  resolveLarkCliHomeForTurn: vi.fn(async () => null),
  pendingLarkCliChallenge: vi.fn(() => null),
  beginLarkCliLogin: vi.fn(async () => ({ authUrl: 'https://example.test/local-lark-device' })),
}));

const { publishTurnCliIdentity } = await import('../src/core/turn-cli-identity.js');
const { renderIdentityWrapper, IDENTITY_DENIED_EXIT_CODE } = await import('../src/core/cli-identity.js');
const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
const { __setPlatformCredentialDepsForTest } = await import('../src/core/platform-credential-source.js');
const { requestCredentialGrant } = await import('../src/platform/credential-grant-client.js');

const SESSION = 'sess-regional';
const ALICE = 'ou_alice';
const BOB = 'ou_bob';
const UNION_IDS: Record<string, string> = { [ALICE]: 'on_alice', [BOB]: 'on_bob' };
const BINDING = { platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' };

const EXP = Math.floor(Date.now() / 1000) + 7200;
/** A JWT-shaped string whose payload claims `region`; `who` keeps people apart. */
function jwt(region: string, who: string): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ region, who, exp: EXP })}.sig`;
}

const REGIONAL_VARIABLES: Record<string, string> = {
  i18n: 'BYTEDCLI_USER_CLOUD_JWT_I18N', i18nbd: 'BYTEDCLI_USER_CLOUD_JWT_I18NBD', tx: 'BYTEDCLI_USER_CLOUD_JWT_TX',
};

/**
 * The platform's side of the grant, per person: which partitions their stored
 * login can mint. `upToDate: false` is a platform from before regional tokens —
 * it reads only the request fields it knows and answers with the default token.
 */
let platform: { upToDate: boolean; partitions: Record<string, string[]>; wrongClaim?: boolean };
let grantBodies: Array<Record<string, unknown>>;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-regional-jwt-turn-'));
  localJwts.clear();
  grantBodies = [];
  platform = { upToDate: true, partitions: {} };
  __setPlatformCredentialDepsForTest({
    readBinding: () => BINDING,
    resolveUnionId: async (_app, openId) => UNION_IDS[openId] ?? null,
    requestGrant: (req, opts) => requestCredentialGrant(req, {
      ...opts,
      http: {
        post: async (_url, body) => {
          const b = body as Record<string, unknown>;
          grantBodies.push(b);
          const who = String(b.unionId);
          const variables: Record<string, string> = { BYTEDCLI_USER_CLOUD_JWT: jwt('cn', who) };
          const asked = platform.upToDate && Array.isArray(b.cloudJwtRegions) ? b.cloudJwtRegions as string[] : undefined;
          for (const region of asked ?? []) {
            if (!(platform.partitions[who] ?? []).includes(region)) continue;
            variables[REGIONAL_VARIABLES[region]!] = jwt(platform.wrongClaim ? 'cn' : region, who);
          }
          return {
            status: 200,
            json: {
              ok: true, tool: b.tool, unionId: who, expiresAt: Date.now() + 3_600_000, variables,
              ...(asked ? { cloudJwtRegions: asked } : {}),
            },
          };
        },
      },
    }),
  });
});
afterEach(() => {
  __setPlatformCredentialDepsForTest(null);
  rmSync(dir, { recursive: true, force: true });
});

function botConfig(credentialSource: 'local' | 'platform') {
  return {
    larkAppId: 'cli_bot', larkAppSecret: 'secret', brand: 'feishu' as const,
    triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli'], credentialSource }) ?? undefined,
  } as any;
}

async function publishFor(source: 'local' | 'platform', sender: string, turnId = 'om_turn_1') {
  const out = await publishTurnCliIdentity({
    botConfig: botConfig(source), sessionDataDir: dir, sessionId: SESSION,
    senderOpenId: sender, turnId, storageModel: 'single', privateChat: true,
  });
  expect(out.find(o => o.tool === 'bytedcli')?.state).toBe('user');
}

/** Run the session's bytedcli wrapper; the stand-in tool prints the JWT it got. */
function bytedcli(...args: string[]): { status: number; jwt: string; stderr: string } {
  const tool = join(dir, 'real-bytedcli.sh');
  writeFileSync(tool, '#!/bin/sh\nprintf "%s" "$BYTEDCLI_USER_CLOUD_JWT"\n');
  chmodSync(tool, 0o755);
  const wrapper = join(dir, 'bytedcli');
  writeFileSync(wrapper, renderIdentityWrapper('bytedcli', tool, 'single'));
  const r = spawnSync('/bin/sh', [wrapper, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', SESSION_DATA_DIR: dir, BOTMUX_SESSION_ID: SESSION },
  });
  return { status: r.status ?? -1, jwt: r.stdout, stderr: r.stderr };
}

function expectRefused(r: ReturnType<typeof bytedcli>, region: string, hint: string): void {
  expect(r.status).toBe(IDENTITY_DENIED_EXIT_CODE);
  expect(r.jwt).toBe('');
  expect(r.stderr).toContain(`属于 ${region} 分区`);
  expect(r.stderr).toContain(hint);
  expect(r.stderr).toContain('[reason=regional_jwt_missing]');
}

describe('local authorization (this machine mints from the sender\'s login)', () => {
  it('uses the sender\'s token for a partition they have one for', async () => {
    localJwts.set(ALICE, { cloudJwt: jwt('cn', 'alice'), regionalCloudJwts: { i18n: jwt('i18n', 'alice') } });
    await publishFor('local', ALICE);
    expect(bytedcli('--site', 'i18n-tt', 'aa', 'query')).toMatchObject({ status: 0, jwt: jwt('i18n', 'alice') });
    expect(bytedcli('aa', 'query')).toMatchObject({ status: 0, jwt: jwt('cn', 'alice') });
    // A partition this login minted nothing for is refused, not sent the cn token.
    expectRefused(bytedcli('--site', 'us-ttp'), 'tx', '本机为发起人签票');
  });

  it('refuses an overseas call when the sender has no token for its partition', async () => {
    localJwts.set(ALICE, { cloudJwt: jwt('cn', 'alice') });
    await publishFor('local', ALICE);
    expectRefused(bytedcli('--site', 'i18n-tt', 'aa', 'query'), 'i18n', '本机为发起人签票');
    expect(bytedcli('aa', 'query')).toMatchObject({ status: 0, jwt: jwt('cn', 'alice') });
  });

  it('does not carry one sender\'s partition token into the next sender\'s turn', async () => {
    localJwts.set(ALICE, { cloudJwt: jwt('cn', 'alice'), regionalCloudJwts: { i18n: jwt('i18n', 'alice') } });
    localJwts.set(BOB, { cloudJwt: jwt('cn', 'bob') });
    await publishFor('local', ALICE, 'om_turn_1');
    await publishFor('local', BOB, 'om_turn_2');
    expectRefused(bytedcli('--site', 'i18n-tt'), 'i18n', '本机为发起人签票');
    expect(bytedcli()).toMatchObject({ status: 0, jwt: jwt('cn', 'bob') });
  });
});

describe('platform grant', () => {
  it('asks for every partition and uses the sender\'s token the platform issued', async () => {
    platform.partitions.on_alice = ['i18n'];
    await publishFor('platform', ALICE);
    expect(grantBodies).toHaveLength(1);
    expect(grantBodies[0]).toMatchObject({ unionId: 'on_alice', tool: 'bytedcli', cloudJwtRegions: ['i18n', 'i18nbd', 'tx'] });
    expect(bytedcli('--site', 'i18n-tt', 'aa', 'query')).toMatchObject({ status: 0, jwt: jwt('i18n', 'on_alice') });
    expect(bytedcli('aa', 'query')).toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
    expectRefused(bytedcli('--site', 'i18n-bd'), 'i18nbd', '平台为发起人签票');
  });

  it('refuses a partition the platform issued no token for', async () => {
    platform.partitions.on_alice = [];
    await publishFor('platform', ALICE);
    expectRefused(bytedcli('--site', 'i18n-tt', 'aa', 'query'), 'i18n', '平台为发起人签票');
    expect(bytedcli('aa', 'query')).toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
  });

  it('says the platform must be upgraded when it does not issue partition tokens at all', async () => {
    platform = { upToDate: false, partitions: { on_alice: ['i18n', 'i18nbd', 'tx'] } };
    await publishFor('platform', ALICE);
    expectRefused(bytedcli('--site', 'i18n-tt', 'aa', 'query'), 'i18n', '升级平台');
    expect(bytedcli('aa', 'query')).toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
  });

  it('drops an issued token that claims another partition', async () => {
    platform = { upToDate: true, partitions: { on_alice: ['i18n'] }, wrongClaim: true };
    await publishFor('platform', ALICE);
    expectRefused(bytedcli('--site', 'i18n-tt'), 'i18n', '平台为发起人签票');
  });

  it('gives each turn the partition tokens granted for that turn\'s sender', async () => {
    platform.partitions = { on_alice: ['i18n'], on_bob: ['i18n'] };
    await publishFor('platform', ALICE, 'om_turn_1');
    await publishFor('platform', BOB, 'om_turn_2');
    expect(grantBodies.map(b => b.unionId)).toEqual(['on_alice', 'on_bob']);
    expect(bytedcli('--site', 'i18n-tt')).toMatchObject({ status: 0, jwt: jwt('i18n', 'on_bob') });

    platform.partitions = { on_alice: ['i18n'], on_bob: [] };
    await publishFor('platform', ALICE, 'om_turn_3');
    await publishFor('platform', BOB, 'om_turn_4');
    expectRefused(bytedcli('--site', 'i18n-tt'), 'i18n', '平台为发起人签票');
  });
});
