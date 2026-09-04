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
