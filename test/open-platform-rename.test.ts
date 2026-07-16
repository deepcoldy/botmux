/**
 * Unit tests for the Open Platform rename service: the console-call chain
 * (read base info → write name for every language → mirror online visibility
 * into a new version → publish), and the structured failure taxonomy the
 * dashboard uses to fall back to a local display name.
 *
 * Run: pnpm vitest run test/open-platform-rename.test.ts
 */
import { describe, it, expect } from 'vitest';
import { renameBotOnOpenPlatform } from '../src/services/open-platform-rename.js';
import { OpenPlatformApiError, type StoredCookie } from '../src/setup/open-platform-automation.js';

const COOKIES: StoredCookie[] = [{
  name: 'session', value: 'x', domain: 'feishu.cn', path: '/', secure: true, httpOnly: true, hostOnly: false,
}];

type Call = { path: string; body: unknown };

/** Build a fake console client that replays canned responses per path prefix. */
function fakeClient(calls: Call[], overrides: Record<string, unknown | ((body: unknown) => unknown)> = {}) {
  return async (_cookies: StoredCookie[]) => ({
    ok: true as const,
    client: {
      apiOrigin: 'https://open.feishu.cn',
      async postJson(path: string, body?: unknown): Promise<unknown> {
        calls.push({ path, body });
        for (const [prefix, resp] of Object.entries(overrides)) {
          if (path.startsWith(prefix)) {
            const r = typeof resp === 'function' ? (resp as (b: unknown) => unknown)(body) : resp;
            if (r instanceof Error) throw r;
            return r;
          }
        }
        throw new Error(`unexpected console call: ${path}`);
      },
      async postForm(): Promise<unknown> {
        throw new Error('unexpected form upload');
      },
    },
  });
}

const BASE_INFO = {
  data: {
    name: '旧名',
    desc: '一个 bot',
    primaryLang: 'zh_cn',
    langs: ['zh_cn', 'en_us'],
    i18n: {
      zh_cn: { name: '旧名', description: '一个 bot', help_use: '' },
      en_us: { name: 'OldName', description: 'a bot' },
    },
  },
};

const ONLINE_VISIBLE = {
  data: {
    whiteList: { departments: [], groups: [], isAll: 0, members: [{ id: 'u1' }, { id: 'u2' }] },
    blackList: { departments: [], groups: [], isAll: 0, members: [{ id: 'u3' }] },
  },
};

const VERSION_LIST = { data: { versions: [{ appVersion: '1.0.4', versionStatus: 2 }] } };

describe('renameBotOnOpenPlatform', () => {
  it('runs the full chain: base_info for every language, version mirroring online visibility, publish', async () => {
    const calls: Call[] = [];
    const r = await renameBotOnOpenPlatform('cli_x', '新名字', undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': BASE_INFO,
        '/developers/v1/base_info/cli_x': { code: 0 },
        '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
        '/developers/v1/app_version/list/cli_x': VERSION_LIST,
        '/developers/v1/app_version/create/cli_x': { data: { versionId: 'v-123' } },
        '/developers/v1/publish/commit/cli_x/v-123': { code: 0 },
      }),
    });

    expect(r).toMatchObject({ ok: true, name: '新名字', versionId: 'v-123' });

    const baseInfoCall = calls.find(c => c.path.startsWith('/developers/v1/base_info/'))!;
    expect(baseInfoCall.body).toMatchObject({
      clientId: 'cli_x',
      name: '新名字',
      desc: '一个 bot',
      languages: ['zh_cn', 'en_us'],
      i18n: {
        // Every configured language gets the new name; other i18n fields survive.
        zh_cn: { name: '新名字', description: '一个 bot', help_use: '' },
        en_us: { name: '新名字', description: 'a bot' },
      },
    });

    const createCall = calls.find(c => c.path.startsWith('/developers/v1/app_version/create/'))!;
    expect(createCall.body).toMatchObject({
      appVersion: '1.0.5', // latest published 1.0.4 + 1
      visibleSuggest: { departments: [], groups: [], isAll: 0, members: ['u1', 'u2'] },
      blackVisibleSuggest: { departments: [], groups: [], isAll: 0, members: ['u3'] },
    });

    expect(calls.some(c => c.path === '/developers/v1/publish/commit/cli_x/v-123')).toBe(true);

    // 读取/解析（visible/online、版本列表）都发生在第一笔写（base_info）之前，
    // 这样可见范围 fail-closed 时零副作用。
    const firstWrite = calls.findIndex(c => c.path.startsWith('/developers/v1/base_info/'));
    expect(calls.findIndex(c => c.path.startsWith('/developers/v1/visible/online/'))).toBeLessThan(firstWrite);
    expect(calls.findIndex(c => c.path.startsWith('/developers/v1/app_version/list/'))).toBeLessThan(firstWrite);
  });

  it('parses departments/groups id field families (departmentId / openChatId / numeric / plain string)', async () => {
    const calls: Call[] = [];
    const r = await renameBotOnOpenPlatform('cli_x', '新名字', undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': BASE_INFO,
        '/developers/v1/base_info/cli_x': { code: 0 },
        '/developers/v1/visible/online/cli_x': {
          data: {
            whiteList: {
              departments: [{ departmentId: 'od-1' }, { open_department_id: 'od-2' }, 'od-3'],
              groups: [{ openChatId: 'oc-1' }, { chat_id: 'oc-2' }],
              isAll: 0,
              members: [{ openId: 'ou_1' }, { user_id: 12345 }],
            },
            blackList: { departments: [], groups: [], isAll: 0, members: [] },
          },
        },
        '/developers/v1/app_version/list/cli_x': VERSION_LIST,
        '/developers/v1/app_version/create/cli_x': { data: { versionId: 'v-124' } },
        '/developers/v1/publish/commit/cli_x/v-124': { code: 0 },
      }),
    });
    expect(r).toMatchObject({ ok: true });
    const createCall = calls.find(c => c.path.startsWith('/developers/v1/app_version/create/'))!;
    expect(createCall.body).toMatchObject({
      visibleSuggest: {
        departments: ['od-1', 'od-2', 'od-3'],
        groups: ['oc-1', 'oc-2'],
        members: ['ou_1', '12345'],
        isAll: 0,
      },
    });
  });

  it('fails closed BEFORE any mutation when a visibility entry shape is unrecognized', async () => {
    const calls: Call[] = [];
    const r = await renameBotOnOpenPlatform('cli_x', '新名字', undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': BASE_INFO,
        '/developers/v1/visible/online/cli_x': {
          data: {
            whiteList: { departments: [{ weirdKey: 'od-1' }], groups: [], isAll: 0, members: [] },
            blackList: { departments: [], groups: [], isAll: 0, members: [] },
          },
        },
      }),
    });
    expect(r).toMatchObject({ ok: false, reason: 'api_error' });
    if (!r.ok) expect(r.message).toContain('whiteList.departments');
    // 名字没有被写、也没有建版：唯一的写接口 base_info / create / commit 都未被调用。
    expect(calls.every(c => !c.path.includes('/base_info/') && !c.path.includes('/app_version/create/') && !c.path.includes('/publish/commit/'))).toBe(true);
  });

  it('fails closed on PARTIAL parse loss too (one member id unparseable)', async () => {
    const calls: Call[] = [];
    const r = await renameBotOnOpenPlatform('cli_x', '新名字', undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': BASE_INFO,
        '/developers/v1/visible/online/cli_x': {
          data: {
            whiteList: { departments: [], groups: [], isAll: 0, members: [{ id: 'u1' }, { avatar: 'no-id-here' }] },
            blackList: { departments: [], groups: [], isAll: 0, members: [] },
          },
        },
      }),
    });
    expect(r).toMatchObject({ ok: false, reason: 'api_error' });
    expect(calls.every(c => !c.path.includes('/base_info/'))).toBe(true);
  });

  it('rejects lark-brand tenants without touching the network', async () => {
    const calls: Call[] = [];
    const r = await renameBotOnOpenPlatform('cli_x', '新名字', 'lark', {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls),
    });
    expect(r).toMatchObject({ ok: false, reason: 'unsupported_brand' });
    expect(calls).toHaveLength(0);
  });

  it('reports no_session when no cached web session exists', async () => {
    const r = await renameBotOnOpenPlatform('cli_x', '新名字', undefined, {
      loadCookies: () => null,
      clientFactory: fakeClient([]),
    });
    expect(r).toMatchObject({ ok: false, reason: 'no_session' });
  });

  it('maps missing_csrf from the client factory to session_expired', async () => {
    const r = await renameBotOnOpenPlatform('cli_x', '新名字', undefined, {
      loadCookies: () => COOKIES,
      clientFactory: async () => ({ ok: false as const, reason: 'missing_csrf' as const, message: 'expired' }),
    });
    expect(r).toMatchObject({ ok: false, reason: 'session_expired' });
  });

  it('maps console code=10003 (not a collaborator) to no_access', async () => {
    const calls: Call[] = [];
    const r = await renameBotOnOpenPlatform('cli_x', '新名字', undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': new OpenPlatformApiError('HTTP 403', { code: 10003, msg: '无权限访问' }),
      }),
    });
    expect(r).toMatchObject({ ok: false, reason: 'no_access' });
  });

  it('surfaces mid-chain API failures as api_error (e.g. version create rejected)', async () => {
    const calls: Call[] = [];
    const r = await renameBotOnOpenPlatform('cli_x', '新名字', undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': BASE_INFO,
        '/developers/v1/base_info/cli_x': { code: 0 },
        '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
        '/developers/v1/app_version/list/cli_x': VERSION_LIST,
        '/developers/v1/app_version/create/cli_x': new OpenPlatformApiError('code=1 msg=审核中', { code: 1, msg: '审核中' }),
      }),
    });
    expect(r).toMatchObject({ ok: false, reason: 'api_error' });
    if (!r.ok) expect(r.message).toContain('审核中');
  });
});
