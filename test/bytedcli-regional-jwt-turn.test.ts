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
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/user-token.js', () => ({
  // im/lark/client.ts imports this (attachment download); bun rejects a mock
  // missing an imported export at link time.
  resolveUserTokenWithScopes: vi.fn(async () => null),
  resolveUserToken: vi.fn(async () => null),
  lookupAuthorizedUserName: vi.fn(() => undefined),
  // cli-identity.ts imports this; bun rejects a mock missing an imported export.
  isUsableOpenId: (openId: unknown) => typeof openId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(openId),
}));
type LocalJwts = { cloudJwt: string; codeJwt?: string; regionalCloudJwts?: Record<string, string> };
const localJwts = new Map<string, LocalJwts>();
/** What a mid-turn renewal of this person's local login returns. */
const renewedJwts = new Map<string, LocalJwts>();
const renewCalls: string[] = [];
vi.mock('../src/services/bytedcli-auth.js', () => ({
  renewBytedcliJwts: vi.fn(async (openId: string) => { renewCalls.push(openId); return renewedJwts.get(openId) ?? null; }),
  mintBytedcliJwts: vi.fn(async (openId: string) => localJwts.get(openId) ?? null),
  beginBytedcliLogin: vi.fn(async () => ({ authUrl: 'https://cloud.example.test/local-bytedcli', completeToken: 'tok' })),
}));
vi.mock('../src/services/lark-cli-auth.js', () => ({
  resolveLarkCliHomeForTurn: vi.fn(async () => null),
  pendingLarkCliChallenge: vi.fn(() => null),
  beginLarkCliLogin: vi.fn(async () => ({ authUrl: 'https://example.test/local-lark-device' })),
}));

const { publishTurnCliIdentity, retryMissingRegionalGrant } = await import('../src/core/turn-cli-identity.js');
const {
  renderIdentityEnv, renderIdentityWrapper, IDENTITY_DENIED_EXIT_CODE, recallProvenIdentityContent, forgetProvenIdentityContent,
} = await import('../src/core/cli-identity.js');
const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
const { renewExpiringBytedcliIdentities, forgetBytedcliIdentityRenewals } = await import('../src/core/bytedcli-identity-renewal.js');
const { __setPlatformCredentialDepsForTest } = await import('../src/core/platform-credential-source.js');
const { requestCredentialGrant } = await import('../src/platform/credential-grant-client.js');

const SESSION = 'sess-regional';
const ALICE = 'ou_alice';
const BOB = 'ou_bob';
const UNION_IDS: Record<string, string> = { [ALICE]: 'on_alice', [BOB]: 'on_bob' };
const BINDING = { platformUrl: 'https://platform.example.test', machineToken: 'mt', machineId: 'm-1' };

const EXP = Math.floor(Date.now() / 1000) + 7200;
/** A JWT-shaped string whose payload claims `region`; `who` keeps people apart. */
function jwt(region: string, who: string, exp = EXP): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ region, who, exp })}.sig`;
}

const REGIONAL_VARIABLES: Record<string, string> = {
  i18n: 'BYTEDCLI_USER_CLOUD_JWT_I18N', i18nbd: 'BYTEDCLI_USER_CLOUD_JWT_I18NBD', tx: 'BYTEDCLI_USER_CLOUD_JWT_TX',
  cn: 'BYTEDCLI_USER_CLOUD_JWT_CN',
};

/**
 * The platform's side of the grant, per person: which partitions their stored
 * login can mint. `upToDate: false` is a platform from before regional tokens —
 * it reads only the request fields it knows and answers with the default token.
 */
let platform: {
  upToDate: boolean; partitions: Record<string, string[]>;
  defaultRegion?: string;
  /** Optional per-partition states returned alongside the grant. */
  regionalStates?: Record<string, string>;
  /** Issue tickets claiming the wrong partition / already expired. */
  wrongClaim?: boolean; expired?: boolean;
  /** This partition's ticket arrives unusable (a value with a line break). */
  malformed?: string;
};
let grantBodies: Array<Record<string, unknown>>;
let dir: string;
/** How the session keeps its identity: a file the wrapper sources (single), or
 *  daemon memory the wrapper is served through a resolver (proven). */
let storageModel: 'single' | 'proven';
let lastTurn: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-regional-jwt-turn-'));
  localJwts.clear();
  renewedJwts.clear();
  renewCalls.length = 0;
  forgetBytedcliIdentityRenewals();
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
          const variables: Record<string, string> = { BYTEDCLI_USER_CLOUD_JWT: jwt(platform.defaultRegion ?? 'cn', who) };
          const asked = platform.upToDate && Array.isArray(b.cloudJwtRegions) ? b.cloudJwtRegions as string[] : undefined;
          for (const region of asked ?? []) {
            if (!(platform.partitions[who] ?? []).includes(region)) continue;
            variables[REGIONAL_VARIABLES[region]!] = platform.malformed === region ? 'broken\nvalue'
              : platform.expired ? jwt(region, who, EXP - 9_000)
                : jwt(platform.wrongClaim ? 'cn' : region, who);
          }
          return {
            status: 200,
            json: {
              ok: true, tool: b.tool, unionId: who, expiresAt: Date.now() + 3_600_000, variables,
              ...(asked ? { cloudJwtRegions: asked } : {}),
              ...(asked && platform.regionalStates ? { cloudJwtRegionStates: platform.regionalStates } : {}),
            },
          };
        },
      },
    }),
  });
});
afterEach(() => {
  __setPlatformCredentialDepsForTest(null);
  forgetProvenIdentityContent(dir, SESSION);
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
    senderOpenId: sender, turnId, storageModel, privateChat: true,
  });
  expect(out.find(o => o.tool === 'bytedcli')?.state).toBe('user');
  lastTurn = turnId;
}

/** Run the session's bytedcli wrapper; the stand-in tool prints the JWT it got. */
function bytedcli(...args: string[]): { status: number; jwt: string; stderr: string } {
  return bytedcliWithEnv({}, ...args);
}

function bytedcliWithEnv(env: Record<string, string>, ...args: string[]): { status: number; jwt: string; stderr: string } {
  return runBytedcli(args, { env });
}

function runBytedcli(args: string[], {
  env = {}, followup,
}: { env?: Record<string, string>; followup?: { region: 'tx' | 'default'; body: string } } = {}): { status: number; jwt: string; stderr: string } {
  const tool = join(dir, 'real-bytedcli.sh');
  writeFileSync(tool, '#!/bin/sh\nprintf "%s" "$BYTEDCLI_USER_CLOUD_JWT"\n');
  chmodSync(tool, 0o755);
  const wrapper = join(dir, 'bytedcli');
  let resolver: string[] | undefined;
  if (storageModel === 'proven') {
    // Stands in for the daemon channel: serves the body the daemon holds for
    // the turn it proved (here, the last one published).
    const body = recallProvenIdentityContent(dir, SESSION, lastTurn, 'bytedcli');
    expect(body).toBeDefined();
    resolver = [join(dir, 'identity-resolver')];
    rmSync(join(dir, 'resolver-args'), { force: true });
    writeFileSync(resolver[0]!, [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$SESSION_DATA_DIR/resolver-args"',
      ...(followup ? [
        `if [ "$2" = --region ] && [ "$3" = ${followup.region} ]; then`,
        "cat <<'BOTMUX_IDENTITY_EOF'",
        followup.body,
        'BOTMUX_IDENTITY_EOF',
        'exit',
        'fi',
      ] : []),
      "cat <<'BOTMUX_IDENTITY_EOF'",
      body,
      'BOTMUX_IDENTITY_EOF',
      '',
    ].join('\n'), { mode: 0o755 });
  }
  writeFileSync(wrapper, renderIdentityWrapper('bytedcli', tool, storageModel, resolver));
  const r = spawnSync('/bin/sh', [wrapper, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', SESSION_DATA_DIR: dir, BOTMUX_SESSION_ID: SESSION, ...env },
  });
  return { status: r.status ?? -1, jwt: r.stdout, stderr: r.stderr };
}

function expectRefused(r: ReturnType<typeof bytedcli>, region: string, hint?: string): void {
  expect(r.status).toBe(IDENTITY_DENIED_EXIT_CODE);
  expect(r.jwt).toBe('');
  expect(r.stderr).toContain(`属于 ${region} 分区`);
  if (hint) expect(r.stderr).toContain(hint);
  expect(r.stderr).toContain('[reason=regional_jwt_missing]');
}

function resolverArgs(): string {
  return readFileSync(join(dir, 'resolver-args'), 'utf8').trim();
}

describe.each(['single', 'proven'] as const)('%s identity storage', model => {
beforeEach(() => { storageModel = model; });

describe('local authorization (this machine mints from the sender\'s login)', () => {
  it('uses the sender\'s CN token for Oncall while ROW remains the default', async () => {
    const row = jwt('i18n', 'alice');
    const rowEnv = { BYTEDCLI_CLOUD_SITE: 'i18n-tt' };
    const cn = jwt('cn', 'alice');
    localJwts.set(ALICE, { cloudJwt: row, regionalCloudJwts: { i18n: row, cn } });
    await publishFor('local', ALICE);
    expect(bytedcliWithEnv(rowEnv, '--site', 'cn', 'oncall', 'tenant', 'get')).toMatchObject({ status: 0, jwt: cn });
    expect(bytedcliWithEnv(rowEnv, 'aa', 'query')).toMatchObject({ status: 0, jwt: row });

    localJwts.set(BOB, { cloudJwt: jwt('i18n', 'bob'), regionalCloudJwts: { i18n: jwt('i18n', 'bob') } });
    await publishFor('local', BOB, 'om_turn_2');
    expectRefused(bytedcliWithEnv(rowEnv, '--site', 'cn', 'oncall', 'tenant', 'get'), 'cn', '本机为发起人签票');
  });

  it('uses the sender\'s token for a partition they have one for', async () => {
    localJwts.set(ALICE, { cloudJwt: jwt('cn', 'alice'), regionalCloudJwts: { i18n: jwt('i18n', 'alice') } });
    await publishFor('local', ALICE);
    expect(bytedcli('--site', 'i18n-tt', 'aa', 'query')).toMatchObject({ status: 0, jwt: jwt('i18n', 'alice') });
    expect(bytedcli('aa', 'query')).toMatchObject({ status: 0, jwt: jwt('cn', 'alice') });
    // A partition this login minted nothing for is refused, not sent the cn token.
    expectRefused(bytedcli('--site', 'us-ttp', 'aa', 'query'), 'tx', '本机为发起人签票');
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
    expectRefused(bytedcli('--site', 'i18n-tt', 'aa', 'query'), 'i18n', '本机为发起人签票');
    expect(bytedcli('aa', 'query')).toMatchObject({ status: 0, jwt: jwt('cn', 'bob') });
  });
});

describe('platform grant', () => {
  it('asks for every partition and uses the sender\'s token the platform issued', async () => {
    platform.defaultRegion = 'i18n';
    platform.partitions.on_alice = ['i18n', 'cn'];
    await publishFor('platform', ALICE);
    expect(grantBodies).toHaveLength(1);
    expect(grantBodies[0]).toMatchObject({ unionId: 'on_alice', tool: 'bytedcli', cloudJwtRegions: ['i18n', 'i18nbd', 'tx', 'cn'] });
    expect(bytedcli('--site', 'i18n-tt', 'aa', 'query')).toMatchObject({ status: 0, jwt: jwt('i18n', 'on_alice') });
    expect(bytedcli('--site', 'cn', 'oncall', 'tenant', 'get')).toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
    expect(bytedcli('aa', 'query')).toMatchObject({ status: 0, jwt: jwt('i18n', 'on_alice') });
    expectRefused(bytedcli('--site', 'i18n-bd', 'aa', 'query'), 'i18nbd');
  });

  it('refuses a partition the platform issued no token for', async () => {
    platform.partitions.on_alice = [];
    await publishFor('platform', ALICE);
    const refused = bytedcli('--site', 'i18n-tt', 'aa', 'query');
    expectRefused(refused, 'i18n', storageModel === 'proven' ? '重试本命令' : '发一条新消息');
    expect(bytedcli('aa', 'query')).toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
  });

  it('says the platform must be upgraded when it does not issue partition tokens at all', async () => {
    platform = { upToDate: false, partitions: { on_alice: ['i18n', 'i18nbd', 'tx'] } };
    await publishFor('platform', ALICE);
    expectRefused(bytedcli('--site', 'i18n-tt', 'aa', 'query'), 'i18n', '升级平台');
    expect(bytedcli('--site', 'cn', 'aa', 'query')).toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
    expect(bytedcli('aa', 'query')).toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
  });

  // A bot may set an overseas site for every session. Until the platform
  // issues partition tickets, its people must keep what never used one.
  it('keeps Codebase, Meego and help working under a session-wide overseas site', async () => {
    platform = { upToDate: false, partitions: {} };
    await publishFor('platform', ALICE);
    const site = { BYTEDCLI_CLOUD_SITE: 'i18n-tt' };
    for (const args of [['codebase', 'mr', 'list'], ['-j', 'meego', 'workitem', 'list'], ['aa', 'query', '--help']]) {
      expect(bytedcliWithEnv(site, ...args)).toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
    }
    for (const args of [['--version'], []]) {
      expect(bytedcliWithEnv(site, ...args)).toMatchObject({ status: 0, jwt: '' });
    }
    expectRefused(bytedcliWithEnv(site, 'aa', 'query'), 'i18n', '升级平台');
  });

  it('drops an issued token that claims another partition', async () => {
    platform = { upToDate: true, partitions: { on_alice: ['i18n'] }, wrongClaim: true };
    await publishFor('platform', ALICE);
    expectRefused(bytedcli('--site', 'i18n-tt', 'aa', 'query'), 'i18n');
  });

  it('drops an issued token that has already expired', async () => {
    platform = { upToDate: true, partitions: { on_alice: ['i18n'] }, expired: true };
    await publishFor('platform', ALICE);
    expectRefused(bytedcli('--site', 'i18n-tt', 'aa', 'query'), 'i18n');
    expect(bytedcli('aa', 'query')).toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
  });

  it('loses only the partition whose ticket arrived malformed, not the default ticket', async () => {
    platform = { upToDate: true, partitions: { on_alice: ['i18n', 'tx'] }, malformed: 'tx' };
    await publishFor('platform', ALICE);
    expect(bytedcli('--site', 'i18n-tt')).toMatchObject({ status: 0, jwt: jwt('i18n', 'on_alice') });
    expectRefused(bytedcli('--site', 'us-ttp', 'aa', 'query'), 'tx');
    expect(bytedcli('aa', 'query')).toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
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
    expectRefused(bytedcli('--site', 'i18n-tt', 'aa', 'query'), 'i18n');
  });
});
});

it('tells the proven identity resolver which ByteCloud ticket a command needs', async () => {
  storageModel = 'proven';
  platform.partitions.on_alice = ['i18n'];
  await publishFor('platform', ALICE);
  const site = { BYTEDCLI_CLOUD_SITE: 'EU-TTP' };
  for (const args of [['aa', 'query'], ['--cloud-site=ROW', 'aa', 'query'], ['--site', 'EU-TTP', 'aa', 'query', '--site', 'i18n-tt']]) {
    expect(bytedcliWithEnv(site, ...args).status).toBe(0);
    expect(resolverArgs()).toBe('bytedcli --region i18n');
  }
  for (const args of [['scm', 'repo', 'build'], ['env', 'service', 'list']]) {
    expect(bytedcli(...args)).toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
    expect(resolverArgs()).toBe('bytedcli --region default');
  }
  expect(bytedcli('--site', 'BoE', 'env', 'service', 'list')).toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
  expect(resolverArgs()).toBe('bytedcli --region default');
  for (const args of [
    ['--site', 'boei18n', 'env', 'service', 'list'],
    ['--site=boe-i18n', 'scm', 'repo', 'build'],
    ['--site', 'unlisted-example', 'scm', 'repo', 'build'],
  ]) {
    expect(bytedcli(...args)).toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
    expect(resolverArgs()).toBe('bytedcli --region default');
  }
  for (const cloudSite of ['boei18n', 'unlisted-example']) {
    expect(bytedcliWithEnv({ BYTEDCLI_CLOUD_SITE: cloudSite }, 'scm', 'repo', 'build'))
      .toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
    expect(resolverArgs()).toBe('bytedcli --region default');
  }
  expect(bytedcliWithEnv(site, '--site', 'cn', 'aa', 'query')).toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
  expect(resolverArgs()).toBe('bytedcli --region cn');
  expect(bytedcliWithEnv({ BYTEDCLI_CLOUD_SITE: 'cn' }, 'scm', 'repo', 'build'))
    .toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
  expect(resolverArgs()).toBe('bytedcli --region cn');
});

it('resolves the selected subcommand ticket or its default fallback after the global prerequisite', async () => {
  storageModel = 'proven';
  platform.partitions.on_alice = ['i18n'];
  await publishFor('platform', ALICE);
  expect(bytedcli('--site', 'cn', 'aa', 'query', '--site', 'boei18n'))
    .toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
  expect(resolverArgs()).toBe('bytedcli --region default');
  expect(bytedcli('--site', 'cn', 'aa', 'query', '--site', 'i18n-tt'))
    .toMatchObject({ status: 0, jwt: jwt('i18n', 'on_alice') });
  expect(resolverArgs()).toBe('bytedcli\nbytedcli --region i18n');
  expect(bytedcli('aa', 'query', '--site', 'cn'))
    .toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
  expect(resolverArgs()).toBe('bytedcli --region cn');
  expect(bytedcli('--site', 'i18n-tt', 'aa', 'query', '--site', 'boe'))
    .toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
  expect(resolverArgs()).toBe('bytedcli --region i18n\nbytedcli --region default');
  expect(bytedcli('--site', 'i18n-tt', 'aa', 'query', '--site', 'cn'))
    .toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
  expect(resolverArgs()).toBe('bytedcli --region i18n\nbytedcli --region cn');
  expect(bytedcli('aa', 'query', '--site', 'us-ttp'))
    .toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
  expect(resolverArgs()).toBe('bytedcli\nbytedcli --region default');
  expect(bytedcli('--site', 'i18n-tt', 'aa', 'query', '--site', 'us-ttp'))
    .toMatchObject({ status: 0, jwt: jwt('cn', 'on_alice') });
  expect(resolverArgs()).toBe('bytedcli --region i18n\nbytedcli --region default');
  expectRefused(bytedcli('--site', 'us-ttp', 'aa', 'query'), 'tx');
  expect(resolverArgs()).toBe('bytedcli --region tx');
  expectRefused(bytedcli('--site', 'us-ttp', 'aa', 'query', '--site', 'i18n-tt'), 'tx');
  expect(resolverArgs()).toBe('bytedcli --region tx');
  // The subcommand owns this site flag and already has its own partition JWT.
  expect(bytedcli('bytecloud', 'list-legacy-vregions', '--site', 'eu-ttp'))
    .toMatchObject({ status: 0, jwt: jwt('i18n', 'on_alice') });
  expect(resolverArgs()).toBe('bytedcli\nbytedcli --region i18n');
});

it('requests the Codebase ticket for nested commands while leaving help and Meego independent', async () => {
  storageModel = 'proven';
  await publishFor('platform', ALICE);
  const site = { BYTEDCLI_CLOUD_SITE: 'EU-TTP' };
  for (const args of [
    ['--profile', 'value', 'codebase', 'mr', 'list'],
    ['--network-profile', 'office', 'codebase', 'mr', 'list'],
    ['--network-profile=office', 'codebase', 'mr', 'list'],
    ['--verbose', 'codebase', 'mr', 'list'],
    ['-v', 'codebase', 'mr', 'list'],
    ['-json', 'codebase', 'mr', 'list'],
    ['-jv', 'codebase', 'mr', 'list'],
  ]) {
    expect(bytedcliWithEnv(site, ...args).status).toBe(0);
    expect(resolverArgs()).toBe('bytedcli --codebase');
  }
  for (const args of [
    ['aa', 'query', '--help'], ['meego', 'workitem', 'list'], ['codebase'], ['codebase', 'help'],
    ['codebase', 'mr', '--help'], ['codebase', 'mr', '-h'], ['codebase', 'mr', '--all-help'], ['--version', 'codebase', 'mr'],
  ]) {
    expect(bytedcliWithEnv(site, ...args).status).toBe(0);
    expect(resolverArgs()).toBe('bytedcli');
  }
});

it.each([
  { label: 'same turn and sender', openId: ALICE, turnId: 'om_turn_1', hasSelected: true, reason: undefined },
  { label: 'new turn', openId: ALICE, turnId: 'om_turn_2', hasSelected: true, reason: 'lineage_unproven' },
  { label: 'different sender', openId: BOB, turnId: 'om_turn_1', hasSelected: true, reason: 'lineage_unproven' },
  { label: 'withdrawn selected token', openId: ALICE, turnId: 'om_turn_1', hasSelected: false, reason: 'regional_jwt_missing' },
])('uses a distinct selected region only when its second lookup serves the same identity ($label)', async ({ openId, turnId, hasSelected, reason }) => {
  storageModel = 'proven';
  platform.partitions.on_alice = ['i18n', 'tx'];
  await publishFor('platform', ALICE);
  const renewed = jwt('tx', 'on_alice', EXP + 3_600);
  const body = renderIdentityEnv({ tool: 'bytedcli', openId, turnId, cloudJwt: jwt('cn', 'on_alice'),
    regionalCloudJwts: { i18n: jwt('i18n', 'on_alice'), ...(hasSelected ? { tx: renewed } : {}) } });
  const result = runBytedcli(['--site', 'i18n-tt', 'aa', 'query', '--site', 'us-ttp'], { followup: { region: 'tx', body } });
  expect(resolverArgs()).toBe('bytedcli --region i18n\nbytedcli --region tx');
  if (reason) {
    expect(result).toMatchObject({ status: IDENTITY_DENIED_EXIT_CODE, jwt: '' });
    expect(result.stderr).toContain(`[reason=${reason}]`);
  } else {
    expect(result).toMatchObject({ status: 0, jwt: renewed });
  }
});

it('keeps the resolved default fallback if a concurrent publication adds the selected token', async () => {
  storageModel = 'proven';
  platform.partitions.on_alice = ['i18n'];
  await publishFor('platform', ALICE);
  const renewed = jwt('cn', 'on_alice', EXP + 3_600);
  const body = renderIdentityEnv({ tool: 'bytedcli', openId: ALICE, turnId: 'om_turn_1', cloudJwt: renewed,
    regionalCloudJwts: { i18n: jwt('i18n', 'on_alice'), tx: jwt('tx', 'on_alice') } });
  const result = runBytedcli(['--site', 'i18n-tt', 'aa', 'query', '--site', 'us-ttp'], { followup: { region: 'default', body } });
  expect(resolverArgs()).toBe('bytedcli --region i18n\nbytedcli --region default');
  expect(result).toMatchObject({ status: 0, jwt: renewed });
});

it.each([
  ['external trigger', 'trg_external'],
  ['workflow event', 'workflow-event:run-1:1'],
  ['scheduled fire', 'schedule:abcd1234:12345678-1234-1234-1234-123456789abc'],
  ['registered background job', 'background:12345678-1234-1234-1234-123456789abc'],
] as const)('does not offer same-turn regional retries for an unattended %s', async (_label, turnId) => {
  storageModel = 'proven';
  platform.regionalStates = { i18n: 'failed' };
  await publishFor('platform', ALICE, turnId);
  const body = recallProvenIdentityContent(dir, SESSION, turnId, 'bytedcli')!;
  expect(body).not.toContain('BOTMUX_IDENTITY_REGIONAL_RETRY');
  const refused = bytedcli('--site', 'i18n-tt', 'aa', 'query');
  expectRefused(refused, 'i18n', '平台本次未能签发');
  expect(refused.stderr).not.toContain('可稍等后重试本命令');
  await retryMissingRegionalGrant({
    sessionDataDir: dir, sessionId: SESSION, turnId, region: 'i18n', speakerOpenId: ALICE,
    currentPolicy: () => botConfig('platform').triggerUserAuth, executionStillCurrent: () => true, waitMs: 1000,
  });
  expect(grantBodies).toHaveLength(1);
});

it('paces regional retries and exhausts only the region that reached its limit', async () => {
  storageModel = 'proven';
  platform.regionalStates = { i18n: 'failed', tx: 'failed' };
  await publishFor('platform', ALICE);
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const retry = (region: 'i18n' | 'tx' = 'i18n') => retryMissingRegionalGrant({
    sessionDataDir: dir, sessionId: SESSION, turnId: 'om_turn_1', region, speakerOpenId: ALICE,
    currentPolicy: () => botConfig('platform').triggerUserAuth, executionStillCurrent: () => true, waitMs: 1000,
  });
  try {
    await retry();
    expect(grantBodies).toHaveLength(2);
    await retry();
    expect(grantBodies).toHaveLength(2);
    now += 9_999;
    await retry();
    expect(grantBodies).toHaveLength(2);
    now += 1;
    await retry();
    expect(grantBodies).toHaveLength(3);
    expect(recallProvenIdentityContent(dir, SESSION, 'om_turn_1', 'bytedcli'))
      .toContain("BOTMUX_IDENTITY_REGIONAL_STATE_I18N='retry_exhausted'");
    now += 10_000;
    await retry();
    expect(grantBodies).toHaveLength(3);

    // Exhaustion is per region: tx still has its own retry budget and hint.
    await retry('tx');
    expect(grantBodies).toHaveLength(4);
    expectRefused(bytedcli('--site', 'us-ttp', 'aa', 'query'), 'tx', '可稍等后重试本命令');
    const refused = bytedcli('--site', 'i18n-tt', 'aa', 'query');
    expectRefused(refused, 'i18n', '补票已达上限');
    expect(refused.stderr).not.toContain('可稍等后重试本命令');
  } finally {
    clock.mockRestore();
  }
});

it('finishes regional exhaustion after a policy change suppressed the second response', async () => {
  storageModel = 'proven';
  platform.regionalStates = { i18n: 'failed' };
  await publishFor('platform', ALICE);
  let livePolicy = botConfig('platform').triggerUserAuth;
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const retry = () => retryMissingRegionalGrant({
    sessionDataDir: dir, sessionId: SESSION, turnId: 'om_turn_1', region: 'i18n', speakerOpenId: ALICE,
    currentPolicy: () => livePolicy, executionStillCurrent: () => true, waitMs: 1000,
  });
  let release: () => void = () => {};
  try {
    await retry();
    expect(grantBodies).toHaveLength(2);
    now += 10_000;

    let started!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let secondGrantCalls = 0;
    __setPlatformCredentialDepsForTest({
      readBinding: () => BINDING,
      resolveUnionId: async (_app, openId) => UNION_IDS[openId] ?? null,
      requestGrant: async () => {
        secondGrantCalls++;
        started();
        await gate;
        return { ok: true, value: {
          tool: 'bytedcli', unionId: 'on_alice', expiresAt: Date.now() + 3_600_000,
          cloudJwtRegions: ['i18n'], cloudJwtRegionStates: { i18n: 'failed' },
          variables: { BYTEDCLI_USER_CLOUD_JWT: jwt('cn', 'on_alice') },
        } };
      },
    });
    const pending = retry();
    await didStart;
    livePolicy = botConfig('local').triggerUserAuth;
    release();
    await pending;
    expect(recallProvenIdentityContent(dir, SESSION, 'om_turn_1', 'bytedcli'))
      .toContain("BOTMUX_IDENTITY_REGIONAL_STATE_I18N='failed'");

    livePolicy = botConfig('platform').triggerUserAuth;
    now += 10_000;
    await retry();
    expect(secondGrantCalls).toBe(1);
    expect(recallProvenIdentityContent(dir, SESSION, 'om_turn_1', 'bytedcli'))
      .toContain("BOTMUX_IDENTITY_REGIONAL_STATE_I18N='retry_exhausted'");
    const refused = bytedcli('--site', 'i18n-tt', 'aa', 'query');
    expectRefused(refused, 'i18n', '补票已达上限');
    expect(refused.stderr).not.toContain('可稍等后重试本命令');
  } finally {
    release();
    clock.mockRestore();
  }
});

// Only a locally minted identity held by the daemon (proven) is renewed mid-turn.
describe('mid-turn renewal of a local identity', () => {
  beforeEach(() => { storageModel = 'proven'; });

  it('serves --site cn with the renewed default once that claims CN, not with a CN token from before', async () => {
    const soon = Math.floor(Date.now() / 1000) + 20 * 60;
    const earlierCn = jwt('cn', 'alice', soon);
    localJwts.set(ALICE, { cloudJwt: jwt('i18n', 'alice', soon), regionalCloudJwts: { i18n: jwt('i18n', 'alice', soon), cn: earlierCn } });
    await publishFor('local', ALICE);
    expect(bytedcli('--site', 'cn', 'oncall', 'tenant', 'get')).toMatchObject({ status: 0, jwt: earlierCn });

    // The renewed default claims CN, so the renewal mints no separate CN token.
    const renewedDefault = jwt('cn', 'alice-renewed');
    renewedJwts.set(ALICE, { cloudJwt: renewedDefault, regionalCloudJwts: { i18n: jwt('i18n', 'alice-renewed') } });
    expect(await renewExpiringBytedcliIdentities()).toBe(1);
    expect(bytedcli('--site', 'cn', 'oncall', 'tenant', 'get')).toMatchObject({ status: 0, jwt: renewedDefault });
    expect(bytedcli('--site', 'i18n-tt', 'aa', 'query')).toMatchObject({ status: 0, jwt: jwt('i18n', 'alice-renewed') });
    // Nothing published is close to expiry any more, so the next sweep leaves the turn alone.
    expect(await renewExpiringBytedcliIdentities()).toBe(0);
    expect(renewCalls).toEqual([ALICE]);
  });

  it('keeps a CN token serving --site cn while the renewed default stays outside CN', async () => {
    const soon = Math.floor(Date.now() / 1000) + 20 * 60;
    const earlierCn = jwt('cn', 'alice', soon);
    localJwts.set(ALICE, { cloudJwt: jwt('i18n', 'alice', soon), regionalCloudJwts: { i18n: jwt('i18n', 'alice', soon), cn: earlierCn } });
    await publishFor('local', ALICE);

    // The CN refresh failed this time: the earlier CN token is kept until a later sweep refreshes it.
    renewedJwts.set(ALICE, { cloudJwt: jwt('i18n', 'alice-1'), regionalCloudJwts: { i18n: jwt('i18n', 'alice-1') } });
    expect(await renewExpiringBytedcliIdentities()).toBe(1);
    expect(bytedcli('--site', 'cn', 'oncall', 'tenant', 'get')).toMatchObject({ status: 0, jwt: earlierCn });

    renewedJwts.set(ALICE, { cloudJwt: jwt('i18n', 'alice-2'), regionalCloudJwts: { i18n: jwt('i18n', 'alice-2'), cn: jwt('cn', 'alice-2') } });
    expect(await renewExpiringBytedcliIdentities()).toBe(1);
    expect(bytedcli('--site', 'cn', 'oncall', 'tenant', 'get')).toMatchObject({ status: 0, jwt: jwt('cn', 'alice-2') });
  });
});
