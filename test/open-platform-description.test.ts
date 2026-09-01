import { describe, expect, it } from 'bun:test';
import {
  readBotDescriptionsOnOpenPlatform,
  updateBotDescriptionsOnOpenPlatform,
} from '../src/services/open-platform-rename.js';
import {
  OpenPlatformApiError,
  type StoredCookie,
} from '../src/setup/open-platform-automation.js';

const COOKIES: StoredCookie[] = [{
  name: 'session', value: 'x', domain: 'feishu.cn', path: '/', secure: true,
  httpOnly: true, hostOnly: false,
}];

type Call = { path: string; body: unknown };

function fakeClient(
  calls: Call[],
  responses: Record<string, unknown | ((body: unknown) => unknown)>,
) {
  return async () => ({
    ok: true as const,
    client: {
      apiOrigin: 'https://open.feishu.cn',
      async postJson(path: string, body?: unknown): Promise<unknown> {
        calls.push({ path, body });
        for (const [prefix, response] of Object.entries(responses)) {
          if (!path.startsWith(prefix)) continue;
          const value = typeof response === 'function' ? response(body) : response;
          if (value instanceof Error) throw value;
          return value;
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
    name: '旧名', avatar: 'https://cdn.example/old.png', desc: '旧描述',
    primaryLang: 'zh_cn', langs: ['zh_cn', 'en_us'],
    i18n: {
      zh_cn: { name: '旧名', description: '旧描述', help_use: '' },
      en_us: { name: 'OldName', description: 'Old description' },
    },
  },
};

const ONLINE_VISIBLE = {
  data: {
    whiteList: { departments: [], groups: [], isAll: 0, members: [{ id: 'u1' }] },
    blackList: { departments: [], groups: [], isAll: 0, members: [] },
  },
};

const VERSION_LIST = { data: { versions: [{ appVersion: '1.0.4', versionStatus: 2 }] } };

describe('readBotDescriptionsOnOpenPlatform', () => {
  it('reads every configured locale and falls back to top-level desc for the primary locale', async () => {
    const calls: Call[] = [];
    const result = await readBotDescriptionsOnOpenPlatform('cli_x', 'feishu', {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': {
          data: {
            name: '助手', desc: '主语言描述', primaryLang: 'zh_cn',
            langs: ['zh_cn', 'en_us'],
            i18n: { zh_cn: { name: '助手' }, en_us: { name: 'Helper', description: 'English' } },
          },
        },
      }),
    });
    expect(result).toEqual({
      ok: true,
      primaryLang: 'zh_cn',
      languages: [
        { lang: 'zh_cn', description: '主语言描述' },
        { lang: 'en_us', description: 'English' },
      ],
    });
    expect(calls.map(call => call.path)).toEqual(['/developers/v1/app/cli_x']);
  });

  it.each([
    ['primary locale outside langs', { ...BASE_INFO.data, primaryLang: 'ja_jp' }],
    ['malformed langs', { ...BASE_INFO.data, langs: ['zh_cn', 7] }],
    ['missing desc', { ...BASE_INFO.data, desc: undefined }],
    ['missing configured-language block', {
      ...BASE_INFO.data,
      i18n: { zh_cn: BASE_INFO.data.i18n.zh_cn },
    }],
  ] as const)('fails closed on %s', async (_label, data) => {
    const calls: Call[] = [];
    const result = await readBotDescriptionsOnOpenPlatform('cli_x', 'feishu', {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, { '/developers/v1/app/cli_x': { data } }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    expect(calls.map(call => call.path)).toEqual(['/developers/v1/app/cli_x']);
  });

  it('reports unsupported brand and missing session before constructing a client', async () => {
    let clients = 0;
    const clientFactory = async () => { clients += 1; throw new Error('must not run'); };
    await expect(readBotDescriptionsOnOpenPlatform('cli_x', 'lark', {
      loadCookies: () => COOKIES, clientFactory,
    })).resolves.toMatchObject({ ok: false, reason: 'unsupported_brand' });
    await expect(readBotDescriptionsOnOpenPlatform('cli_x', 'feishu', {
      loadCookies: () => null, clientFactory,
    })).resolves.toMatchObject({ ok: false, reason: 'no_session' });
    expect(clients).toBe(0);
  });

  it('maps console collaborator rejection to no_access', async () => {
    const result = await readBotDescriptionsOnOpenPlatform('cli_x', 'feishu', {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient([], {
        '/developers/v1/app/cli_x': new OpenPlatformApiError(
          'HTTP 403', { code: 10003, msg: '无权限访问' }, 403,
        ),
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'no_access' });
  });
});

describe('updateBotDescriptionsOnOpenPlatform', () => {
  it('writes each locale, syncs top-level desc to primary, preserves fields, and publishes', async () => {
    const calls: Call[] = [];
    const result = await updateBotDescriptionsOnOpenPlatform(
      'cli_x',
      { zh_cn: '中文新版', en_us: 'English new' },
      'feishu',
      {
        loadCookies: () => COOKIES,
        clientFactory: fakeClient(calls, {
          '/developers/v1/app/cli_x': BASE_INFO,
          '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
          '/developers/v1/app_version/list/cli_x': VERSION_LIST,
          '/developers/v1/base_info/cli_x': { code: 0 },
          '/developers/v1/app_version/create/cli_x': { data: { versionId: 'v-description' } },
          '/developers/v1/publish/commit/cli_x/v-description': { code: 0 },
        }),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      primaryLang: 'zh_cn',
      descriptions: { zh_cn: '中文新版', en_us: 'English new' },
      versionId: 'v-description',
    });
    const write = calls.find(call => call.path === '/developers/v1/base_info/cli_x');
    expect(write?.body).toMatchObject({
      clientId: 'cli_x',
      name: '旧名',
      desc: '中文新版',
      languages: ['zh_cn', 'en_us'],
      i18n: {
        zh_cn: { name: '旧名', description: '中文新版', help_use: '' },
        en_us: { name: 'OldName', description: 'English new' },
      },
    });
    expect(calls.at(-1)?.path).toBe('/developers/v1/publish/commit/cli_x/v-description');
  });

  it('returns languages_changed before mutation when submitted keys are stale', async () => {
    const calls: Call[] = [];
    const result = await updateBotDescriptionsOnOpenPlatform(
      'cli_x', { zh_cn: '中文' }, 'feishu', {
        loadCookies: () => COOKIES,
        clientFactory: fakeClient(calls, {
          '/developers/v1/app/cli_x': BASE_INFO,
          '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
          '/developers/v1/app_version/list/cli_x': VERSION_LIST,
        }),
      },
    );
    expect(result).toMatchObject({ ok: false, reason: 'languages_changed' });
    expect(calls.every(call => !call.path.includes('/base_info/') && !call.path.includes('/app_version/create/'))).toBe(true);
  });

  it.each([
    [{ zh_cn: '   ', en_us: 'English' }, 'description_required'],
    [{ zh_cn: 'x'.repeat(121), en_us: 'English' }, 'description_too_long'],
    [{ zh_cn: '中文', bad: 'English' }, 'invalid_descriptions'],
  ] as const)('rejects invalid input before loading cookies: %j', async (input, reason) => {
    let cookieReads = 0;
    const result = await updateBotDescriptionsOnOpenPlatform('cli_x', input, 'feishu', {
      loadCookies: () => { cookieReads += 1; return COOKIES; },
      clientFactory: fakeClient([], {}),
    });
    expect(result).toMatchObject({ ok: false, reason });
    expect(cookieReads).toBe(0);
  });

  it('accepts the same language set in a different object-key order', async () => {
    const calls: Call[] = [];
    const result = await updateBotDescriptionsOnOpenPlatform(
      'cli_x',
      { en_us: 'English new', zh_cn: '中文新版' },
      'feishu',
      {
        loadCookies: () => COOKIES,
        clientFactory: fakeClient(calls, {
          '/developers/v1/app/cli_x': BASE_INFO,
          '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
          '/developers/v1/app_version/list/cli_x': VERSION_LIST,
          '/developers/v1/base_info/cli_x': { code: 0 },
          '/developers/v1/app_version/create/cli_x': { data: { versionId: 'v-order' } },
          '/developers/v1/publish/commit/cli_x/v-order': { code: 0 },
        }),
      },
    );
    expect(result).toMatchObject({ ok: true, versionId: 'v-order' });
  });

  it('aborts before base_info when the current application name is unreadable', async () => {
    const calls: Call[] = [];
    const broken = structuredClone(BASE_INFO);
    delete (broken.data as Partial<typeof BASE_INFO.data>).name;
    const result = await updateBotDescriptionsOnOpenPlatform(
      'cli_x', { zh_cn: '中文', en_us: 'English' }, 'feishu', {
        loadCookies: () => COOKIES,
        clientFactory: fakeClient(calls, {
          '/developers/v1/app/cli_x': broken,
          '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
          '/developers/v1/app_version/list/cli_x': VERSION_LIST,
        }),
      },
    );
    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    expect(calls.every(call => !call.path.includes('/base_info/'))).toBe(true);
  });
});
