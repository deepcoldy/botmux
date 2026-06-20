/**
 * 单测 src/setup/verify-permissions.ts.
 *
 * Run: pnpm vitest run test/setup-verify-permissions.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 占位 mock — 单测里不真实调 Lark.Client. checkRequiredScopes / applyScopesUnverified
// 单测都需要 mock 这个.
vi.mock('@larksuiteoapi/node-sdk', () => {
  const scopeListMock = vi.fn();
  const scopeApplyMock = vi.fn();
  class FakeClient {
    application = { scope: { list: scopeListMock, apply: scopeApplyMock } };
    // checkRequiredScopes now reads scopes via client.request() (GET empty-body
    // 411 guard) instead of the generated scope.list; delegate to the same
    // scopeListMock so existing mockResolved/mockRejected setups still apply.
    request = (...args: unknown[]) => scopeListMock(...args);
    constructor(_: unknown) {}
  }
  return {
    Client: FakeClient,
    Domain: { Feishu: 0, Lark: 1 },
    LoggerLevel: { error: 0, fatal: 0 },
    // 暴露 mock 函数给 test 直接拿到
    __scopeListMock: scopeListMock,
    __scopeApplyMock: scopeApplyMock,
  };
});

import * as sdk from '@larksuiteoapi/node-sdk';
import {
  validateCredentials,
  checkRequiredScopes,
  applyScopesUnverified,
  buildScopeDeepLink,
  buildEventSubDeepLink,
  buildRemainingSteps,
  BOTMUX_REQUIRED_SCOPES,
  DOC_FEATURE_SCOPES,
} from '../src/setup/verify-permissions.js';
import { DOC_COMMENT_OAUTH_SCOPES } from '../src/utils/user-token.js';

const scopeListMock = (sdk as any).__scopeListMock as ReturnType<typeof vi.fn>;
const scopeApplyMock = (sdk as any).__scopeApplyMock as ReturnType<typeof vi.fn>;

// fetch 在 verify-permissions.ts 里只在 validateCredentials 用. mock 掉.
const fetchMock = vi.fn();
beforeEach(() => {
  scopeListMock.mockReset();
  scopeApplyMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

describe('validateCredentials', () => {
  it('ok=true when tenant_access_token returned (code=0)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, tenant_access_token: 't-xxx', expire: 7200 }),
    });
    const r = await validateCredentials('cli_x', 'sec', 'feishu');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tenantAccessToken).toBe('t-xxx');
      expect(r.tokenExpiresIn).toBe(7200);
    }
  });

  it('classifies 10003 / 10012 / 99991663 as invalid_credentials', async () => {
    for (const code of [10003, 10012, 99991663]) {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ code, msg: 'invalid' }),
      });
      const r = await validateCredentials('cli_x', 'sec', 'feishu');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('invalid_credentials');
    }
  });

  it('does not leak secret into error message on credential failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ code: 10003, msg: 'invalid' }) });
    const r = await validateCredentials('cli_x', 'super-secret-value-do-not-leak', 'feishu');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain('super-secret-value-do-not-leak');
  });

  it('returns network error on fetch throw', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    const r = await validateCredentials('cli_x', 'sec', 'feishu');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('network');
  });

  it('honors budgetMs and classifies timeout as network', async () => {
    // fetch 永远不 resolve — 自带的 AbortController 应该在 budgetMs 后中止
    fetchMock.mockImplementation(
      (_url: string, init: any) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted') as any;
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const r = await validateCredentials('cli_x', 'sec', 'feishu', { budgetMs: 30 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('network');
      expect(r.message).toContain('超时');
    }
  });

  it('respects external AbortSignal', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: any) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted') as any;
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const ctrl = new AbortController();
    const p = validateCredentials('cli_x', 'sec', 'feishu', { budgetMs: 10_000, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('network');
  });

  it('uses larksuite.com host when brand=lark', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: 'x' }) });
    await validateCredentials('cli_x', 'sec', 'lark');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('open.larksuite.com'),
      expect.any(Object),
    );
  });
});

describe('checkRequiredScopes (helper, not in main path)', () => {
  it('lists granted scopes and computes missing critical/optional via grant_status===2', async () => {
    scopeListMock.mockResolvedValue({
      code: 0,
      data: {
        scopes: [
          { scope_name: 'im:message', grant_status: 2 },
          { scope_name: 'im:resource', grant_status: 1 }, // 已申请未生效, 算 missing
          { scope_name: 'unrelated:scope', grant_status: 2 },
        ],
      },
    });
    const r = await checkRequiredScopes('cli_x', 'sec', 'feishu');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.granted).toContain('im:message');
      expect(r.granted).not.toContain('im:resource');
      // missingCritical 应该包含 im:resource (critical=true, granted_status!=2)
      expect(r.missingCritical.some(s => s.name === 'im:resource')).toBe(true);
      // im:message 已 granted, 不应该在 missingCritical 里
      expect(r.missingCritical.some(s => s.name === 'im:message')).toBe(false);
    }
  });

  it('treats im:chat.members:write_only as CRITICAL (拉群刚需) so its absence is surfaced', async () => {
    scopeListMock.mockResolvedValue({
      code: 0,
      data: { scopes: [{ scope_name: 'im:message', grant_status: 2 }] }, // write_only NOT granted
    });
    const r = await checkRequiredScopes('cli_x', 'sec', 'feishu');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.missingCritical.some(s => s.name === 'im:chat.members:write_only')).toBe(true);
      expect(r.missingOptional.some(s => s.name === 'im:chat.members:write_only')).toBe(false);
    }
  });

  it('returns need_self_manage when scope.list returns 99991672', async () => {
    scopeListMock.mockResolvedValue({ code: 99991672, msg: 'no permission' });
    const r = await checkRequiredScopes('cli_x', 'sec', 'feishu');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('need_self_manage');
  });

  it('classifies SDK throw as network', async () => {
    scopeListMock.mockRejectedValue(new Error('network'));
    const r = await checkRequiredScopes('cli_x', 'sec', 'feishu');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('network');
  });
});

describe('applyScopesUnverified (helper, not in main path)', () => {
  it('maps Lark error codes to structured status', async () => {
    const cases: Array<[number, string]> = [
      [0, 'submitted'],
      [212001, 'super_scope_only'],
      [212002, 'nothing_to_apply'],
      [212003, 'over_limit'],
      [212004, 'already_applied'],
      [99999, 'error'],
    ];
    for (const [code, status] of cases) {
      scopeApplyMock.mockResolvedValueOnce({ code, msg: 'msg' });
      const r = await applyScopesUnverified('cli_x', 'sec', { brand: 'feishu', budgetMs: 5000 });
      expect(r.status).toBe(status);
    }
  });

  it('honors budgetMs and returns timeout when call exceeds deadline', async () => {
    // 让 scope.apply 永远 pending
    scopeApplyMock.mockReturnValue(new Promise(() => {}));
    const r = await applyScopesUnverified('cli_x', 'sec', { brand: 'feishu', budgetMs: 50 });
    expect(r.status).toBe('timeout');
  });

  it('honors AbortSignal mid-flight', async () => {
    scopeApplyMock.mockReturnValue(new Promise(() => {}));
    const ctrl = new AbortController();
    const p = applyScopesUnverified('cli_x', 'sec', { brand: 'feishu', signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    const r = await p;
    expect(r.status).toBe('timeout');
  });
});

describe('deep-link builders', () => {
  it('buildScopeDeepLink encodes scope name', () => {
    const u = buildScopeDeepLink('cli_x', 'im:message.group_at_msg', 'feishu');
    expect(u).toContain('cli_x');
    expect(u).toContain(encodeURIComponent('im:message.group_at_msg'));
    expect(u).toContain('open.feishu.cn');
  });

  it('buildEventSubDeepLink + buildRemainingSteps point to correct host for lark brand', () => {
    expect(buildEventSubDeepLink('cli_x', 'lark')).toContain('open.larksuite.com');
    const steps = buildRemainingSteps('cli_x', 'lark');
    // 主线收敛到 2 步: 权限申请 + 重定向 URL (PersonalAgent 默认配好事件/bot 不再列)
    expect(steps.length).toBe(2);
    for (const s of steps) expect(s.url).toContain('open.larksuite.com');
  });
});

describe('BOTMUX_REQUIRED_SCOPES', () => {
  it('contains the critical scopes botmux needs to receive messages', () => {
    const names = BOTMUX_REQUIRED_SCOPES.filter(s => s.critical).map(s => s.name);
    expect(names).toContain('im:message');
    expect(names).toContain('im:message.group_at_msg:readonly');
    expect(names).toContain('im:resource');
    expect(names).toContain('im:chat:read');
    expect(names).toContain('contact:user.base:readonly');
  });

  it('requires im:message.group_msg so the bot can fetch group history (botmux history)', () => {
    // 没有这个 scope 时 listChatMessages 拿不到群里非 @bot 的历史消息，
    // botmux history 失效。标 critical 是为了让启动自检在它缺失时也会 DM
    // 管理员——非 critical 的缺失只在同时缺 critical 时才会被提示。
    const entry = BOTMUX_REQUIRED_SCOPES.find(s => s.name === 'im:message.group_msg');
    expect(entry, 'im:message.group_msg should be in BOTMUX_REQUIRED_SCOPES').toBeDefined();
    expect(entry?.critical).toBe(true);
  });

  it('every required scope exists in lark-scopes.json manifest (no bare names that Lark API would never return)', async () => {
    // Regression: BOTMUX_REQUIRED_SCOPES used bare names `im:chat` /
    // `im:message.group_at_msg` that don't exist in Lark's scope catalog —
    // every scope in the API response carries an access-mode suffix
    // (`:read`, `:readonly`, `:update`, ...). The bare names could never
    // match the API output, so every correctly-authorized user got false
    // "missing scope" warnings. Lock that down: each required scope must
    // exist in the canonical manifest the user imports.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const manifestPath = join(here, '..', 'src', 'setup', 'lark-scopes.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const declared = new Set<string>([
      ...(manifest.scopes?.tenant ?? []),
      ...(manifest.scopes?.user ?? []),
    ]);

    const missing = BOTMUX_REQUIRED_SCOPES.filter(s => !declared.has(s.name));
    expect(
      missing,
      `BOTMUX_REQUIRED_SCOPES entries not in lark-scopes.json: ${missing.map(s => s.name).join(', ')}`,
    ).toEqual([]);
  });

  it('DOC_FEATURE_SCOPES are valid manifest scopes and match DOC_COMMENT_OAUTH_SCOPES (no drift)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, '..', 'src', 'setup', 'lark-scopes.json'), 'utf-8'));
    const declared = new Set<string>([...(manifest.scopes?.tenant ?? []), ...(manifest.scopes?.user ?? [])]);

    const missing = DOC_FEATURE_SCOPES.filter(s => !declared.has(s.name));
    expect(missing, `DOC_FEATURE_SCOPES not in lark-scopes.json: ${missing.map(s => s.name).join(', ')}`).toEqual([]);

    // The startup-check list and the OAuth-request list must stay name-aligned.
    expect(DOC_FEATURE_SCOPES.map(s => s.name).sort()).toEqual([...DOC_COMMENT_OAUTH_SCOPES].sort());
    // Doc-feature scopes are opt-in → must never be critical (would nag every bot).
    expect(DOC_FEATURE_SCOPES.every(s => !s.critical)).toBe(true);
  });
});
