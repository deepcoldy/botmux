/**
 * Unit tests for the Open Platform avatar service: PNG validation, the
 * console-call chain (read base info → upload icon → write base_info with
 * `avatar` while preserving names for every language → mirror online
 * visibility into a new version → publish), and the structured failure
 * taxonomy shared with the rename service.
 *
 * Run: pnpm vitest run test/open-platform-avatar.test.ts
 */
import { describe, it, expect } from 'vitest';
import { crc32 } from 'node:zlib';
import {
  AVATAR_IMAGE_MAX_BYTES,
  changeBotAvatarOnOpenPlatform,
  renameBotOnOpenPlatform,
  validateAvatarPng,
} from '../src/services/open-platform-rename.js';
import { type StoredCookie } from '../src/setup/open-platform-automation.js';

const COOKIES: StoredCookie[] = [{
  name: 'session', value: 'x', domain: 'feishu.cn', path: '/', secure: true, httpOnly: true, hostOnly: false,
}];

type Call = { kind: 'json' | 'form'; path: string; body: unknown };

/** Fake console client replaying canned responses per path prefix; records
 *  postJson and postForm calls in one ordered list. */
function fakeClient(calls: Call[], overrides: Record<string, unknown | ((body: unknown) => unknown)> = {}) {
  const respond = (kind: 'json' | 'form', path: string, body: unknown): unknown => {
    calls.push({ kind, path, body });
    for (const [prefix, resp] of Object.entries(overrides)) {
      if (path.startsWith(prefix)) {
        const r = typeof resp === 'function' ? (resp as (b: unknown) => unknown)(body) : resp;
        if (r instanceof Error) throw r;
        return r;
      }
    }
    throw new Error(`unexpected console call: ${path}`);
  };
  return async (_cookies: StoredCookie[]) => ({
    ok: true as const,
    client: {
      apiOrigin: 'https://open.feishu.cn',
      async postJson(path: string, body?: unknown): Promise<unknown> {
        return respond('json', path, body);
      },
      async postForm(path: string, body: FormData): Promise<unknown> {
        return respond('form', path, body);
      },
    },
  });
}

/** Minimal buffer that satisfies validateAvatarPng: PNG magic + structurally
 *  valid IHDR chunk (length=13, type, dims, correct CRC over type+data). */
function fakePng(width = 512, height = 512, opts: { corruptCrc?: boolean } = {}): Buffer {
  const b = Buffer.alloc(33); // 8 magic + 4 len + 4 'IHDR' + 13 data + 4 crc
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  const crc = crc32(b.subarray(12, 29)) >>> 0;
  b.writeUInt32BE(opts.corruptCrc ? (crc ^ 0xdeadbeef) >>> 0 : crc, 29);
  return b;
}

const BASE_INFO = {
  data: {
    name: '小助手',
    desc: '一个 bot',
    primaryLang: 'zh_cn',
    langs: ['zh_cn', 'en_us'],
    i18n: {
      zh_cn: { name: '小助手', description: '一个 bot', help_use: '' },
      en_us: { name: 'Helper', description: 'a bot' },
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

const UPLOADED = { data: { url: 'https://s1-imfile.feishucdn.com/static-resource/v1/v3_new_avatar' } };

describe('validateAvatarPng', () => {
  it('accepts a 512×512 PNG', () => {
    expect(validateAvatarPng(fakePng())).toEqual({ ok: true });
  });

  it('rejects non-PNG bytes, wrong dimensions, and oversized buffers', () => {
    expect(validateAvatarPng(Buffer.from('not a png at all, definitely'))).toMatchObject({ ok: false });
    expect(validateAvatarPng(fakePng(256, 256))).toMatchObject({ ok: false });
    expect(validateAvatarPng(fakePng(512, 256))).toMatchObject({ ok: false });
    const huge = Buffer.alloc(AVATAR_IMAGE_MAX_BYTES + 1);
    fakePng().copy(huge, 0);
    expect(validateAvatarPng(huge)).toMatchObject({ ok: false });
  });

  it('rejects magic-only pseudo-PNGs without a real IHDR chunk, and corrupted IHDR CRCs', () => {
    // codex 二审复现样本：24 字节，仅 PNG 魔数 + 在 offset 16/20 伪造 512×512，
    // 没有 IHDR chunk（长度/类型字段是垃圾）——必须本地拒绝，不得送上 console。
    const pseudo = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pseudo, 0);
    pseudo.writeUInt32BE(512, 16);
    pseudo.writeUInt32BE(512, 20);
    expect(validateAvatarPng(pseudo)).toMatchObject({ ok: false });

    // 结构齐全但 CRC 不对（手工拼接的伪头）。
    expect(validateAvatarPng(fakePng(512, 512, { corruptCrc: true }))).toMatchObject({ ok: false });

    // 同样的伪文件走完整入口必须是 invalid_image、零 cookie/网络。
    let cookiesLoaded = 0;
    return changeBotAvatarOnOpenPlatform('cli_x', pseudo, undefined, {
      loadCookies: () => { cookiesLoaded++; return COOKIES; },
      clientFactory: fakeClient([]),
    }).then(r => {
      expect(r).toMatchObject({ ok: false, reason: 'invalid_image' });
      expect(cookiesLoaded).toBe(0);
    });
  });
});

describe('changeBotAvatarOnOpenPlatform', () => {
  it('runs the full chain: upload icon, base_info with avatar + preserved names, version mirroring online visibility, publish', async () => {
    const calls: Call[] = [];
    const r = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': BASE_INFO,
        '/developers/v1/app/upload/image': UPLOADED,
        '/developers/v1/base_info/cli_x': { code: 0 },
        '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
        '/developers/v1/app_version/list/cli_x': VERSION_LIST,
        '/developers/v1/app_version/create/cli_x': { data: { versionId: 'v-123' } },
        '/developers/v1/publish/commit/cli_x/v-123': { code: 0 },
      }),
    });

    expect(r).toMatchObject({ ok: true, avatarUrl: UPLOADED.data.url, versionId: 'v-123' });

    const uploadCall = calls.find(c => c.path.startsWith('/developers/v1/app/upload/image'))!;
    expect(uploadCall.kind).toBe('form');
    const form = uploadCall.body as FormData;
    expect(form.get('uploadType')).toBe('4');
    expect(form.get('isIsv')).toBe('false');
    expect(JSON.parse(String(form.get('scale')))).toEqual({ width: 512, height: 512 });
    expect((form.get('file') as Blob).size).toBe(fakePng().length);

    const baseInfoCall = calls.find(c => c.path.startsWith('/developers/v1/base_info/'))!;
    expect(baseInfoCall.body).toMatchObject({
      clientId: 'cli_x',
      // 名字/描述原样保留 —— 改头像绝不动名字。
      name: '小助手',
      desc: '一个 bot',
      languages: ['zh_cn', 'en_us'],
      i18n: {
        zh_cn: { name: '小助手', description: '一个 bot', help_use: '' },
        en_us: { name: 'Helper', description: 'a bot' },
      },
      avatar: UPLOADED.data.url,
    });

    const createCall = calls.find(c => c.path.startsWith('/developers/v1/app_version/create/'))!;
    expect(createCall.body).toMatchObject({
      appVersion: '1.0.5',
      visibleSuggest: { departments: [], groups: [], isAll: 0, members: ['u1', 'u2'] },
      blackVisibleSuggest: { departments: [], groups: [], isAll: 0, members: ['u3'] },
    });
    expect(calls.some(c => c.path === '/developers/v1/publish/commit/cli_x/v-123')).toBe(true);

    // 读取/解析（可见范围、版本列表）都发生在上传与第一笔写之前；上传本身
    // 也在 base_info 之前 —— 可见范围 fail-closed 时连图都不会传。
    const firstWrite = calls.findIndex(c => c.path.startsWith('/developers/v1/base_info/'));
    const uploadIdx = calls.findIndex(c => c.path.startsWith('/developers/v1/app/upload/image'));
    expect(calls.findIndex(c => c.path.startsWith('/developers/v1/visible/online/'))).toBeLessThan(uploadIdx);
    expect(calls.findIndex(c => c.path.startsWith('/developers/v1/app_version/list/'))).toBeLessThan(uploadIdx);
    expect(uploadIdx).toBeLessThan(firstWrite);
  });

  it('falls back to the top-level name for languages missing an i18n name', async () => {
    const calls: Call[] = [];
    const r = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': {
          data: {
            name: '小助手',
            desc: '',
            primaryLang: 'zh_cn',
            langs: ['zh_cn', 'ja_jp'],
            i18n: { zh_cn: { name: '小助手' }, ja_jp: { description: 'no name here' } },
          },
        },
        '/developers/v1/app/upload/image': UPLOADED,
        '/developers/v1/base_info/cli_x': { code: 0 },
        '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
        '/developers/v1/app_version/list/cli_x': VERSION_LIST,
        '/developers/v1/app_version/create/cli_x': { data: { versionId: 'v-124' } },
        '/developers/v1/publish/commit/cli_x/v-124': { code: 0 },
      }),
    });
    expect(r).toMatchObject({ ok: true });
    const baseInfoCall = calls.find(c => c.path.startsWith('/developers/v1/base_info/'))!;
    expect(baseInfoCall.body).toMatchObject({
      i18n: {
        zh_cn: { name: '小助手' },
        ja_jp: { description: 'no name here', name: '小助手' },
      },
    });
  });

  it('rejects invalid images without touching cookies or the network', async () => {
    const calls: Call[] = [];
    let cookiesLoaded = 0;
    const r = await changeBotAvatarOnOpenPlatform('cli_x', Buffer.from('nope'), undefined, {
      loadCookies: () => { cookiesLoaded++; return COOKIES; },
      clientFactory: fakeClient(calls),
    });
    expect(r).toMatchObject({ ok: false, reason: 'invalid_image' });
    expect(cookiesLoaded).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('aborts before any write when the current app name is unreadable', async () => {
    const calls: Call[] = [];
    const r = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': { data: { desc: 'no name field', langs: ['zh_cn'], i18n: { zh_cn: { description: 'x' } } } },
        '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
        '/developers/v1/app_version/list/cli_x': VERSION_LIST,
      }),
    });
    expect(r).toMatchObject({ ok: false, reason: 'api_error' });
    if (!r.ok) expect(r.message).toContain('当前名称');
    expect(calls.every(c => !c.path.includes('/base_info/') && !c.path.includes('/app_version/create/') && !c.path.includes('/upload/image'))).toBe(true);
  });

  it('fail-closes langs: missing langs + multi-language i18n must abort instead of dropping languages', async () => {
    // langs 缺失、i18n 含 zh_cn/en_us：回退 [primaryLang] 回写会把 en_us 整块删掉 → 中止。
    const calls1: Call[] = [];
    const multi = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls1, {
        '/developers/v1/app/cli_x': {
          data: {
            name: '小助手', desc: 'd', primaryLang: 'zh_cn',
            i18n: { zh_cn: { name: '小助手' }, en_us: { name: 'Helper' } },
          },
        },
      }),
    });
    expect(multi).toMatchObject({ ok: false, reason: 'api_error' });
    if (!multi.ok) expect(multi.message).toContain('en_us');
    expect(calls1.every(c => !c.path.includes('/base_info/') && !c.path.includes('/upload/image'))).toBe(true);

    // langs 含非字符串条目：形态未识别，中止（不许静默过滤后继续全量回写）。
    const calls2: Call[] = [];
    const badLangs = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls2, {
        '/developers/v1/app/cli_x': {
          data: { name: '小助手', desc: 'd', primaryLang: 'zh_cn', langs: ['zh_cn', 7], i18n: { zh_cn: { name: '小助手' } } },
        },
      }),
    });
    expect(badLangs).toMatchObject({ ok: false, reason: 'api_error' });
    expect(calls2.every(c => !c.path.includes('/base_info/') && !c.path.includes('/upload/image'))).toBe(true);

    // langs 缺失但 i18n 恰好只有主语言：允许按 primaryLang 回退，链路完整走通。
    const calls3: Call[] = [];
    const singleLang = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls3, {
        '/developers/v1/app/cli_x': {
          data: { name: '小助手', desc: 'd', primaryLang: 'zh_cn', i18n: { zh_cn: { name: '小助手' } } },
        },
        '/developers/v1/app/upload/image': UPLOADED,
        '/developers/v1/base_info/cli_x': { code: 0 },
        '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
        '/developers/v1/app_version/list/cli_x': VERSION_LIST,
        '/developers/v1/app_version/create/cli_x': { data: { versionId: 'v-single' } },
        '/developers/v1/publish/commit/cli_x/v-single': { code: 0 },
      }),
    });
    expect(singleLang).toMatchObject({ ok: true });
    const baseInfoCall = calls3.find(c => c.path.startsWith('/developers/v1/base_info/'))!;
    expect(baseInfoCall.body).toMatchObject({ languages: ['zh_cn'], i18n: { zh_cn: { name: '小助手' } } });
  });

  it('aborts (zero mutation) when desc or a configured i18n block is unreadable — base_info is a full overwrite', async () => {
    // desc 缺失：不允许用 '' 顶替把线上描述清掉。
    const calls1: Call[] = [];
    const noDesc = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls1, {
        '/developers/v1/app/cli_x': { data: { name: '小助手', langs: ['zh_cn'], i18n: { zh_cn: { name: '小助手' } } } },
      }),
    });
    expect(noDesc).toMatchObject({ ok: false, reason: 'api_error' });
    if (!noDesc.ok) expect(noDesc.message).toContain('desc');
    expect(calls1.every(c => !c.path.includes('/base_info/') && !c.path.includes('/upload/image') && !c.path.includes('/app_version/create/'))).toBe(true);

    // 已配语言缺 i18n 块：不允许重建成仅含 name 的空块清掉本地化字段。
    const calls2: Call[] = [];
    const noBlock = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls2, {
        '/developers/v1/app/cli_x': { data: { name: '小助手', desc: 'd', langs: ['zh_cn', 'en_us'], i18n: { zh_cn: { name: '小助手' } } } },
      }),
    });
    expect(noBlock).toMatchObject({ ok: false, reason: 'api_error' });
    if (!noBlock.ok) expect(noBlock.message).toContain('en_us');
    expect(calls2.every(c => !c.path.includes('/base_info/') && !c.path.includes('/upload/image') && !c.path.includes('/app_version/create/'))).toBe(true);
  });

  it('aborts before base_info when the upload returns no url', async () => {
    const calls: Call[] = [];
    const r = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': BASE_INFO,
        '/developers/v1/app/upload/image': { code: 0, data: {} },
        '/developers/v1/visible/online/cli_x': ONLINE_VISIBLE,
        '/developers/v1/app_version/list/cli_x': VERSION_LIST,
      }),
    });
    expect(r).toMatchObject({ ok: false, reason: 'api_error' });
    if (!r.ok) expect(r.message).toContain('url');
    expect(calls.every(c => !c.path.includes('/base_info/') && !c.path.includes('/app_version/create/'))).toBe(true);
  });

  it('fails closed BEFORE upload/mutation when a visibility entry shape is unrecognized', async () => {
    const calls: Call[] = [];
    const r = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
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
    expect(calls.every(c => !c.path.includes('/upload/image') && !c.path.includes('/base_info/') && !c.path.includes('/publish/commit/'))).toBe(true);
  });

  it('fails closed on structurally-broken visibility payloads (data:null / empty / missing keys / non-array collections / missing blackList)', async () => {
    const brokenShapes: Array<{ label: string; response: unknown; expectIn: string }> = [
      { label: 'data:null', response: { data: null }, expectIn: 'data' },
      { label: 'data:{}', response: { data: {} }, expectIn: 'whiteList' },
      // whiteList 存在但缺 groups 键（残缺块不允许默认为空集合）。
      { label: 'whiteList missing groups', response: { data: { whiteList: { departments: [], isAll: 0, members: [] }, blackList: { departments: [], groups: [], isAll: 0, members: [] } } }, expectIn: 'whiteList.groups' },
      // 集合存在但不是数组——不能静默当空。
      { label: 'members non-array', response: { data: { whiteList: { departments: [], groups: [], isAll: 0, members: 'bogus' }, blackList: { departments: [], groups: [], isAll: 0, members: [] } } }, expectIn: 'whiteList.members' },
      // 现行契约 white/black 成对出现；黑名单丢失会把被拉黑的人放出来。
      { label: 'blackList missing', response: { data: { whiteList: { departments: [], groups: [], isAll: 0, members: [{ id: 'u1' }] } } }, expectIn: 'blackList' },
      // 四键都在但集合全是 null——不得静默变成空可见范围。
      { label: 'collections all null', response: { data: { whiteList: { departments: null, groups: null, isAll: 0, members: null }, blackList: { departments: [], groups: [], isAll: 0, members: [] } } }, expectIn: 'whiteList.departments' },
      // isAll 只认 0/1/false/true：'1' 会被旧实现折叠成 0，把全员可见发布成不可见。
      { label: "isAll:'1' (string)", response: { data: { whiteList: { departments: [], groups: [], isAll: '1', members: [] }, blackList: { departments: [], groups: [], isAll: 0, members: [] } } }, expectIn: 'whiteList.isAll' },
    ];
    for (const shape of brokenShapes) {
      const calls: Call[] = [];
      const r = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
        loadCookies: () => COOKIES,
        clientFactory: fakeClient(calls, {
          '/developers/v1/app/cli_x': BASE_INFO,
          '/developers/v1/visible/online/cli_x': shape.response,
        }),
      });
      expect(r, shape.label).toMatchObject({ ok: false, reason: 'api_error' });
      if (!r.ok) expect(r.message, shape.label).toContain(shape.expectIn);
      // 零副作用：没上传、没写 base_info、没建版、没发布。
      expect(
        calls.every(c => !c.path.includes('/upload/image') && !c.path.includes('/base_info/') && !c.path.includes('/app_version/create/') && !c.path.includes('/publish/commit/')),
        shape.label,
      ).toBe(true);
    }
  });

  it('still parses the legacy top-level visibility shape (no whiteList container)', async () => {
    const calls: Call[] = [];
    const r = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls, {
        '/developers/v1/app/cli_x': BASE_INFO,
        '/developers/v1/app/upload/image': UPLOADED,
        '/developers/v1/base_info/cli_x': { code: 0 },
        // 旧形态：可见范围直接铺在 data 顶层，没有 whiteList/blackList/groups 容器。
        '/developers/v1/visible/online/cli_x': { data: { departments: [], isAll: 0, members: [{ id: 'u9' }] } },
        '/developers/v1/app_version/list/cli_x': VERSION_LIST,
        '/developers/v1/app_version/create/cli_x': { data: { versionId: 'v-legacy' } },
        '/developers/v1/publish/commit/cli_x/v-legacy': { code: 0 },
      }),
    });
    expect(r).toMatchObject({ ok: true });
    const createCall = calls.find(c => c.path.startsWith('/developers/v1/app_version/create/'))!;
    expect(createCall.body).toMatchObject({
      visibleSuggest: { departments: [], groups: [], isAll: 0, members: ['u9'] },
      blackVisibleSuggest: { departments: [], groups: [], isAll: 0, members: [] },
    });
  });

  it('serializes concurrent avatar × rename chains on the same app (TOCTOU lost-update guard)', async () => {
    const order: string[] = [];
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });

    const canned = (path: string): unknown => {
      if (path.startsWith('/developers/v1/app/cli_race')) return BASE_INFO;
      if (path.startsWith('/developers/v1/visible/online/')) return ONLINE_VISIBLE;
      if (path.startsWith('/developers/v1/app_version/list/')) return VERSION_LIST;
      if (path.startsWith('/developers/v1/base_info/')) return { code: 0 };
      if (path.startsWith('/developers/v1/app_version/create/')) return { data: { versionId: 'v-race' } };
      if (path.startsWith('/developers/v1/publish/commit/')) return { code: 0 };
      throw new Error(`unexpected console call: ${path}`);
    };
    const factory = (label: string, gateUpload: boolean) => async () => ({
      ok: true as const,
      client: {
        apiOrigin: 'https://open.feishu.cn',
        async postJson(path: string): Promise<unknown> {
          order.push(`${label}:${path}`);
          return canned(path);
        },
        async postForm(path: string): Promise<unknown> {
          order.push(`${label}:${path}`);
          if (gateUpload) await uploadGate; // 复刻 codex 的交错窗口：卡在 upload
          return UPLOADED;
        },
      },
    });

    const avatarP = changeBotAvatarOnOpenPlatform('cli_race', fakePng(), undefined, {
      loadCookies: () => COOKIES,
      clientFactory: factory('avatar', true),
    });
    // 等 avatar 链路真正开始（读到 base info 并卡在 upload）。
    for (let i = 0; i < 400 && !order.some(x => x === 'avatar:/developers/v1/app/upload/image'); i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(order.some(x => x === 'avatar:/developers/v1/app/upload/image')).toBe(true);

    const renameP = renameBotOnOpenPlatform('cli_race', '并发新名', undefined, {
      loadCookies: () => COOKIES,
      clientFactory: factory('rename', false),
    });
    // avatar 未完成前，rename 不得发起任何 console 调用（否则就会拿旧快照回写）。
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(order.some(x => x.startsWith('rename:'))).toBe(false);

    releaseUpload();
    const [avatarResult, renameResult] = await Promise.all([avatarP, renameP]);
    expect(avatarResult).toMatchObject({ ok: true });
    expect(renameResult).toMatchObject({ ok: true, name: '并发新名' });

    // 两条链路零交错：rename 的第一个调用晚于 avatar 的最后一个调用。
    const firstRename = order.findIndex(x => x.startsWith('rename:'));
    const lastAvatar = order.reduce((last, x, i) => (x.startsWith('avatar:') ? i : last), -1);
    expect(firstRename).toBeGreaterThan(lastAvatar);
  });

  it('rejects lark-brand tenants and reports no_session when cookies are absent', async () => {
    const calls: Call[] = [];
    const lark = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), 'lark', {
      loadCookies: () => COOKIES,
      clientFactory: fakeClient(calls),
    });
    expect(lark).toMatchObject({ ok: false, reason: 'unsupported_brand' });
    expect(calls).toHaveLength(0);

    const noSession = await changeBotAvatarOnOpenPlatform('cli_x', fakePng(), undefined, {
      loadCookies: () => null,
      clientFactory: fakeClient(calls),
    });
    expect(noSession).toMatchObject({ ok: false, reason: 'no_session' });
  });
});
