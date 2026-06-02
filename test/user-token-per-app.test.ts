/**
 * Per-app User Token isolation (Codex review F3): a Feishu bot and a Lark bot
 * on the same machine must not share / overwrite / cross-use each other's
 * User Token. resolveUserToken reads a per-app file and refuses tokens that
 * belong to a different app, with a guarded legacy-single-file fallback.
 *
 * Run:  pnpm vitest run test/user-token-per-app.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.botmux', 'data');
const legacyPath = join(DIR, 'user-token.json');
const perAppPath = (appId: string) => join(DIR, `user-token-${appId}.json`);

// In-memory fake filesystem keyed by absolute path.
const files = new Map<string, string>();

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((p: string, data: string) => { files.set(p, data); }),
    readFileSync: vi.fn((p: string) => {
      if (files.has(p)) return files.get(p)!;
      const err: any = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
    }),
  };
});

function validToken(extra: Record<string, unknown> = {}): string {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  return JSON.stringify({
    access_token: 'AT', refresh_token: 'RT', token_type: 'Bearer',
    expires_at: future, refresh_expires_at: future, scope: 's', ...extra,
  });
}

async function fresh() {
  vi.resetModules();
  return await import('../src/utils/user-token.js');
}

describe('resolveUserToken — per-app isolation', () => {
  beforeEach(() => {
    files.clear();
    delete process.env.FEISHU_USER_ACCESS_TOKEN;
  });

  it('returns the per-app token for the matching app', async () => {
    files.set(perAppPath('app_feishu'), validToken({ access_token: 'TOK_F', appId: 'app_feishu', brand: 'feishu' }));
    const { resolveUserToken } = await fresh();
    expect(await resolveUserToken('app_feishu', 'sec', 'feishu')).toBe('TOK_F');
  });

  it('does NOT hand one bot the token of a different app (no cross-bleed)', async () => {
    files.set(perAppPath('app_feishu'), validToken({ access_token: 'TOK_F', appId: 'app_feishu', brand: 'feishu' }));
    const { resolveUserToken } = await fresh();
    // A different Lark bot has no token file of its own → must get null, not TOK_F.
    expect(await resolveUserToken('app_lark', 'sec', 'lark')).toBeNull();
  });

  it('honours a legacy single-file token for a feishu bot (backward compat)', async () => {
    files.set(legacyPath, validToken({ access_token: 'TOK_LEGACY' })); // no appId/brand = pre-upgrade
    const { resolveUserToken } = await fresh();
    expect(await resolveUserToken('any_feishu_app', 'sec', 'feishu')).toBe('TOK_LEGACY');
  });

  it('does NOT let a Lark bot consume an unlabelled legacy (feishu) token', async () => {
    files.set(legacyPath, validToken({ access_token: 'TOK_LEGACY' }));
    const { resolveUserToken } = await fresh();
    expect(await resolveUserToken('app_lark', 'sec', 'lark')).toBeNull();
  });

  it('env override still wins regardless of app', async () => {
    process.env.FEISHU_USER_ACCESS_TOKEN = 'ENV_TOK';
    const { resolveUserToken } = await fresh();
    expect(await resolveUserToken('whatever', 'sec', 'lark')).toBe('ENV_TOK');
  });

  // Hardening (Codex review): validate the file's inner appId/brand, not just the
  // filename — a mis-named / hand-edited per-app file must not be trusted.
  it('rejects a per-app file whose inner appId mismatches the filename', async () => {
    files.set(perAppPath('app_a'), validToken({ access_token: 'TOK', appId: 'app_OTHER', brand: 'feishu' }));
    const { resolveUserToken } = await fresh();
    expect(await resolveUserToken('app_a', 'sec', 'feishu')).toBeNull();
  });

  it('rejects a per-app file whose inner brand mismatches the request', async () => {
    files.set(perAppPath('app_a'), validToken({ access_token: 'TOK', appId: 'app_a', brand: 'feishu' }));
    const { resolveUserToken } = await fresh();
    expect(await resolveUserToken('app_a', 'sec', 'lark')).toBeNull();
  });
});

describe('getTokenStatus — per-app', () => {
  beforeEach(() => { files.clear(); delete process.env.FEISHU_USER_ACCESS_TOKEN; });

  it('reports 未登录 for an app with no token file', async () => {
    files.set(perAppPath('app_a'), validToken({ appId: 'app_a' }));
    const { getTokenStatus } = await fresh();
    expect(getTokenStatus('app_b', 'lark')).toContain('未登录');
  });

  it('reports 已登录 for the app that owns a valid token', async () => {
    files.set(perAppPath('app_a'), validToken({ appId: 'app_a', brand: 'feishu' }));
    const { getTokenStatus } = await fresh();
    expect(getTokenStatus('app_a', 'feishu')).toContain('已登录');
  });
});
