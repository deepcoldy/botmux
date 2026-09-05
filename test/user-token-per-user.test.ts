/**
 * Per-USER User Token isolation — the openId dimension.
 *
 * Before this, storage was keyed by appId alone: a second person running
 * `/login` on the same bot silently overwrote the first, and every later call
 * ran as whoever authorized last — no error, wrong name in the audit trail.
 * These tests pin the properties that make "act as the person who sent this
 * message" actually true:
 *
 *   1. two people on one bot coexist;
 *   2. asking for person A never returns person B's token;
 *   3. an unattributed legacy file is NEVER claimed for a named person
 *      (we cannot prove whose it is);
 *   4. refreshing a person's token rewrites THAT person's file, not the
 *      per-app path;
 *   5. `listAuthorizedUsers` reports who authorized without leaking tokens.
 *
 * Run:  npx vitest run --project unit test/user-token-per-user.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.botmux', 'data');
const legacyPath = join(DIR, 'user-token.json');
const perAppPath = (appId: string) => join(DIR, `user-token-${appId}.json`);
const perUserPath = (appId: string, openId: string) => join(DIR, `user-token-${appId}-${openId}.json`);

const files = new Map<string, string>();

// The real atomicWriteFileSync goes through openSync/fsyncSync/realpathSync/rename;
// stubbing it keeps these tests about WHICH FILE gets written, not about durable-write
// mechanics (which atomic-write.test.ts already covers).
vi.mock('../src/utils/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn((p: string, data: string) => { files.set(p, data); }),
}));

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((p: string, data: string) => { files.set(p, data); }),
    readdirSync: vi.fn(() => [...files.keys()]
      .filter(p => p.startsWith(`${DIR}/`))
      .map(p => p.slice(DIR.length + 1))),
    readFileSync: vi.fn((p: string) => {
      if (files.has(p)) return files.get(p)!;
      const err: any = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
    }),
  };
});

function tokenFor(extra: Record<string, unknown> = {}, ageMs = 3_600_000): string {
  const when = new Date(Date.now() + ageMs).toISOString();
  return JSON.stringify({
    access_token: 'AT', refresh_token: 'RT', token_type: 'Bearer',
    expires_at: when, refresh_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    scope: 's', ...extra,
  });
}

async function fresh() {
  vi.resetModules();
  return await import('../src/utils/user-token.js');
}

const APP = 'cli_shared_bot';
const ALICE = 'ou_alice';
const BOB = 'ou_bob';

describe('resolveUserToken — per-user isolation', () => {
  beforeEach(() => { files.clear(); vi.unstubAllGlobals(); });

  it('keeps two people on the same bot side by side', async () => {
    files.set(perUserPath(APP, ALICE), tokenFor({ access_token: 'TOK_ALICE', appId: APP, brand: 'feishu', openId: ALICE }));
    files.set(perUserPath(APP, BOB), tokenFor({ access_token: 'TOK_BOB', appId: APP, brand: 'feishu', openId: BOB }));
    const { resolveUserToken } = await fresh();
    expect(await resolveUserToken(APP, 'sec', 'feishu', ALICE)).toBe('TOK_ALICE');
    expect(await resolveUserToken(APP, 'sec', 'feishu', BOB)).toBe('TOK_BOB');
  });

  it('never hands back another person\'s token when the asked-for one is absent', async () => {
    files.set(perUserPath(APP, BOB), tokenFor({ access_token: 'TOK_BOB', appId: APP, brand: 'feishu', openId: BOB }));
    const { resolveUserToken } = await fresh();
    expect(await resolveUserToken(APP, 'sec', 'feishu', ALICE)).toBeNull();
  });

  // The whole point of the boundary: a file with no recorded owner has no
  // provable owner. Claiming it for Alice would silently run as whoever
  // actually authorized it.
  it('refuses an unattributed per-app file when asked for a specific person', async () => {
    files.set(perAppPath(APP), tokenFor({ access_token: 'TOK_UNKNOWN', appId: APP, brand: 'feishu' }));
    const { resolveUserToken } = await fresh();
    expect(await resolveUserToken(APP, 'sec', 'feishu', ALICE)).toBeNull();
    // …but the bot-level (no openId) path still reads it — legacy compatibility.
    expect(await resolveUserToken(APP, 'sec', 'feishu')).toBe('TOK_UNKNOWN');
  });

  it('refuses the pre-multi-bot legacy single file for a specific person', async () => {
    files.set(legacyPath, tokenFor({ access_token: 'TOK_LEGACY' }));
    const { resolveUserToken } = await fresh();
    expect(await resolveUserToken(APP, 'sec', 'feishu', ALICE)).toBeNull();
  });

  // Filename says Alice, content says Bob → trust neither. Guards a hand-edited
  // or renamed file from becoming an identity swap.
  it('rejects a per-user file whose inner openId contradicts its name', async () => {
    files.set(perUserPath(APP, ALICE), tokenFor({ access_token: 'TOK', appId: APP, brand: 'feishu', openId: BOB }));
    const { resolveUserToken } = await fresh();
    expect(await resolveUserToken(APP, 'sec', 'feishu', ALICE)).toBeNull();
  });

  it('refreshes into the same person\'s file, never the per-app path', async () => {
    // Access token already expired, refresh token still good.
    files.set(perUserPath(APP, ALICE), tokenFor(
      { access_token: 'OLD', appId: APP, brand: 'feishu', openId: ALICE, userName: 'Alice' },
      -60_000,
    ));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'NEW', refresh_token: 'RT2', token_type: 'Bearer',
      expires_in: 7200, refresh_token_expires_in: 2_592_000, scope: 's',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const { resolveUserToken } = await fresh();
    expect(await resolveUserToken(APP, 'sec', 'feishu', ALICE)).toBe('NEW');

    const written = JSON.parse(files.get(perUserPath(APP, ALICE))!);
    expect(written.access_token).toBe('NEW');
    // Ownership survives the refresh — a refresh is the same person, and the
    // display name must not be lost either.
    expect(written.openId).toBe(ALICE);
    expect(written.userName).toBe('Alice');
    expect(files.has(perAppPath(APP))).toBe(false);
  });

  it('does not invent an owner when refreshing an unattributed file', async () => {
    files.set(perAppPath(APP), tokenFor({ access_token: 'OLD', appId: APP, brand: 'feishu' }, -60_000));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'NEW', refresh_token: 'RT2', token_type: 'Bearer',
      expires_in: 7200, refresh_token_expires_in: 2_592_000, scope: 's',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const { resolveUserToken } = await fresh();
    expect(await resolveUserToken(APP, 'sec', 'feishu')).toBe('NEW');
    expect(JSON.parse(files.get(perAppPath(APP))!).openId).toBeUndefined();
  });

  it('rejects an openId that could escape the token directory', async () => {
    const { resolveUserToken, isUsableOpenId } = await fresh();
    expect(isUsableOpenId('../../etc/passwd')).toBe(false);
    expect(isUsableOpenId('ou_ok')).toBe(true);
    // A traversal-shaped id degrades to the bot-level lookup rather than
    // composing a path outside ~/.botmux/data.
    expect(await resolveUserToken(APP, 'sec', 'feishu', '../../etc/passwd')).toBeNull();
  });
});

describe('listAuthorizedUsers', () => {
  beforeEach(() => { files.clear(); });

  it('reports each authorizing person without exposing token material', async () => {
    files.set(perUserPath(APP, ALICE), tokenFor({ access_token: 'TOK_ALICE', appId: APP, brand: 'feishu', openId: ALICE, userName: 'Alice' }));
    files.set(perUserPath(APP, BOB), tokenFor({ access_token: 'TOK_BOB', appId: APP, brand: 'feishu', openId: BOB }));
    // Noise that must not be counted: another bot's user, and an unattributed file.
    files.set(perUserPath('cli_other', ALICE), tokenFor({ access_token: 'X', appId: 'cli_other', brand: 'feishu', openId: ALICE }));
    files.set(perAppPath(APP), tokenFor({ access_token: 'X', appId: APP, brand: 'feishu' }));

    const { listAuthorizedUsers } = await fresh();
    const rows = listAuthorizedUsers(APP, 'feishu');
    expect(rows.map(r => r.openId).sort()).toEqual([ALICE, BOB]);
    expect(rows.find(r => r.openId === ALICE)?.userName).toBe('Alice');
    expect(JSON.stringify(rows)).not.toContain('TOK_');
  });

  it('is empty for a bot nobody authorized', async () => {
    const { listAuthorizedUsers } = await fresh();
    expect(listAuthorizedUsers('cli_nobody', 'feishu')).toEqual([]);
  });
});

describe('resolveOwnerUserToken — the one narrow fallback', () => {
  beforeEach(() => { files.clear(); });

  // Feed-group labels live in the OWNER's own sidebar; a bot has no inbox, so
  // this call can only ever mean "as the owner". Existing installs stored the
  // owner's token in the unattributed per-app file, and refusing it would make
  // the label feature silently stop working right after an upgrade.
  it('accepts an unattributed per-app file as the owner', async () => {
    files.set(perAppPath(APP), tokenFor({ access_token: 'TOK_OLD_OWNER', appId: APP, brand: 'feishu' }));
    const { resolveOwnerUserToken, resolveUserToken } = await fresh();
    expect(await resolveOwnerUserToken(APP, 'sec', 'feishu', ALICE)).toBe('TOK_OLD_OWNER');
    // The strict per-person path still refuses it — the fallback is owner-only.
    expect(await resolveUserToken(APP, 'sec', 'feishu', ALICE)).toBeNull();
  });

  it('prefers the owner\'s own file over the unattributed one', async () => {
    files.set(perAppPath(APP), tokenFor({ access_token: 'TOK_OLD', appId: APP, brand: 'feishu' }));
    files.set(perUserPath(APP, ALICE), tokenFor({ access_token: 'TOK_ALICE', appId: APP, brand: 'feishu', openId: ALICE }));
    const { resolveOwnerUserToken } = await fresh();
    expect(await resolveOwnerUserToken(APP, 'sec', 'feishu', ALICE)).toBe('TOK_ALICE');
  });

  // The fallback widens WHICH FILE counts as the owner's, never WHOSE identity
  // may be borrowed: another named person's file is still off limits.
  it('never falls back to a different named person', async () => {
    files.set(perUserPath(APP, BOB), tokenFor({ access_token: 'TOK_BOB', appId: APP, brand: 'feishu', openId: BOB }));
    const { resolveOwnerUserToken } = await fresh();
    expect(await resolveOwnerUserToken(APP, 'sec', 'feishu', ALICE)).toBeNull();
  });
});

/**
 * Attribution at the moment of authorization.
 *
 * The OAuth token response carries no open_id, so who authorized is known only
 * by reading `user_info` back with the fresh token. That read-back is not a
 * formality: a /login link can be forwarded, so the person who clicked is not
 * reliably the person who asked. If it fails, guessing "probably the requester"
 * is exactly how B's credentials end up filed under A — after which every one
 * of A's commands runs with B's permissions, with nothing to show for it.
 */
describe('handleCallbackUrl — attribution must be proven, never assumed', () => {
  beforeEach(() => { files.clear(); vi.unstubAllGlobals(); });

  /** @param userInfo how the user_info read-back behaves. */
  async function runCallback(userInfo: { status?: number; body?: unknown; throws?: boolean }) {
    const mod = await fresh();
    const { authUrl } = mod.generateAuthUrl(APP, 'sec', 'feishu', [], ALICE);
    const state = new URL(authUrl).searchParams.get('state')!;

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 'AT', refresh_token: 'RT', token_type: 'Bearer',
            expires_in: 7200, refresh_token_expires_in: 604800, scope: 's',
          }),
        };
      }
      if (userInfo.throws) throw new Error('network down');
      return { ok: userInfo.status === undefined, status: userInfo.status ?? 200, json: async () => userInfo.body };
    }));

    const msg = await mod.handleCallbackUrl(`http://127.0.0.1:9768/callback?code=abc&state=${state}`);
    return { msg, mod };
  }

  it('files the token under the person who actually authorized', async () => {
    const { msg } = await runCallback({ body: { code: 0, data: { open_id: ALICE, name: '爱丽丝' } } });
    expect(msg).toContain('✅');
    expect(files.has(perUserPath(APP, ALICE))).toBe(true);
  });

  // The forwarded-link case: Bob clicked Alice's link. Bob's token is Bob's.
  it('files under the clicker, not the requester, and says so', async () => {
    const { msg } = await runCallback({ body: { code: 0, data: { open_id: BOB, name: '鲍勃' } } });
    expect(files.has(perUserPath(APP, BOB))).toBe(true);
    expect(files.has(perUserPath(APP, ALICE))).toBe(false);
    expect(msg).toContain('不是同一个人');
  });

  it.each([
    ['a non-2xx response', { status: 500, body: {} }],
    ['a Lark error code', { body: { code: 99991663, msg: 'invalid token' } }],
    ['a response with no usable open_id', { body: { code: 0, data: { name: 'nobody' } } }],
    ['a network failure', { throws: true }],
  ])('saves nothing when the read-back gives %s', async (_label, userInfo) => {
    const { msg } = await runCallback(userInfo as any);
    // Nothing written anywhere — not under the requester, not per-app.
    expect([...files.keys()].filter(p => p.includes('user-token'))).toEqual([]);
    // And the person is told to retry rather than left believing they are done.
    expect(msg).toContain('无法确认');
    expect(msg).toContain('/login');
  });
});
