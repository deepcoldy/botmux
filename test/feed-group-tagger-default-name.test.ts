/**
 * 会话群标签的**默认名**行为（feed-group + chat-tag 两种模式）。
 *
 * 背景：默认名原本写死「Botmux群会话」，多 bot / 多设备下侧边栏全是同名分组，
 * 毫无区分度。现在回落链是 配置名 → 「<bot 显示名>会话」→ 旧默认名，本文件盯住
 * 三件事：
 *   1. 建群/建标签时用的名字确实按新回落链来（两种模式共用同一套名字）；
 *   2. 默认值变化会让**已存在**的分组在下次打标时被改一次名，且只改一次；
 *   3. 分组实际名已经等于目标名时不发同名 rename（否则每次打标都空转一次）。
 *
 * mock 风格跟随 test/dashboard-feed-groups.test.ts（stub 掉 user-token + fetch）与
 * test/session-groups-store.test.ts（用真实临时目录接管 config.session.dataDir）。
 *
 * Run:  pnpm vitest run test/feed-group-tagger-default-name.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const APP = 'cli_tagger_test';
const CHAT = 'oc_new_session_group';
const OWNER = 'ou_owner';

let tempDir: string;

// vi.mock 工厂在 import 阶段就被调用，早于本文件的 const 初始化——被工厂引用的
// 可变桩必须放进 vi.hoisted，否则命中 TDZ。
const h = vi.hoisted(() => ({
  botState: {
    config: {} as any,
    botName: undefined as string | undefined,
  },
  tenantRequest: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return tempDir; },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: vi.fn(async () => 'u-token'),
  generateAuthUrl: vi.fn(() => ({ authUrl: 'https://auth.example/x', state: 's' })),
  FEED_GROUP_OAUTH_SCOPES: ['im:feed_group_v1'],
}));

vi.mock('../src/im/lark/client.js', () => ({
  sendUserMessage: vi.fn(async () => undefined),
}));

vi.mock('../src/i18n/index.js', () => ({
  t: (key: string) => key,
  localeForBot: vi.fn(() => 'zh' as const),
}));

// bot-registry 是这条链路唯一的「bot 显示名」来源。effectiveBotDisplayName 与生产
// 实现保持同构（displayName > 飞书探测名 botName > larkAppId），这样测的是 tagger
// 怎么用它，而不是一个虚构的优先级。
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => h.botState),
  getBotClient: vi.fn(() => ({ request: (...args: any[]) => h.tenantRequest(...args) })),
  effectiveBotDisplayName: (s: any) => s.config.displayName || s.botName || s.config.larkAppId,
}));

import { tagSessionGroup, defaultSessionTagName } from '../src/services/feed-group-tagger.js';
import { localeForBot } from '../src/i18n/index.js';

function cachePath(): string {
  return join(tempDir, `feed-group-cache-${APP}.json`);
}

function readCache(): any {
  return existsSync(cachePath()) ? JSON.parse(readFileSync(cachePath(), 'utf-8')) : {};
}

function seedCache(cache: Record<string, unknown>): void {
  writeFileSync(cachePath(), JSON.stringify(cache), 'utf-8');
}

function json(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** 记录每次 feed-group HTTP 调用，断言时只关心 method + path + body。 */
interface Call { method: string; url: string; body: any }

/**
 * 装一个 fetch 桩：list 永远返回空（=「本 app 看不到同名分组」），create/rename/add
 * 一律成功。返回记录数组供断言；`overrides` 可让某一条走失败分支。
 */
function stubFetch(overrides?: (call: Call) => Response | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const custom = overrides?.(call);
    if (custom) return custom;
    if (call.method === 'GET') return json({ code: 0, data: { groups: [], has_more: false } });
    if (call.url.includes('batch_add_item')) return json({ code: 0, data: { failed_items: [] } });
    if (call.method === 'POST') return json({ code: 0, data: { group_id: 'ofg_created' } });
    return json({ code: 0, data: {} }); // PUT rename
  }));
  return calls;
}

const creates = (calls: Call[]): string[] => calls
  .filter(c => c.method === 'POST' && c.url.endsWith('/im/v1/groups'))
  .map(c => c.body.feed_group_creator.name);

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'feed-group-tagger-test-'));
  h.botState.config = {
    larkAppId: APP, larkAppSecret: 'sec', brand: 'feishu', cliId: 'codex', sessionGroup: {},
  };
  h.botState.botName = undefined;
  h.tenantRequest.mockReset();
  vi.mocked(localeForBot).mockReturnValue('zh');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('feed-group 模式：默认名 = 「<bot 显示名>会话」', () => {
  it('用飞书探测名建群（bots.json 的 name 为空也能拿到名字）', async () => {
    h.botState.botName = 'CodeXonAst';
    const calls = stubFetch();

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(creates(calls)).toEqual(['CodeXonAst会话']);
    expect(readCache()).toMatchObject({
      groupId: 'ofg_created', name: 'CodeXonAst会话', configuredName: 'CodeXonAst会话',
    });
  });

  it('自定义 displayName 压过飞书探测名', async () => {
    h.botState.botName = 'CodeXonAst';
    h.botState.config.displayName = '小助手';
    const calls = stubFetch();

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(creates(calls)).toEqual(['小助手会话']);
  });

  it('配了 sessionGroup.tag.name 就用配置名', async () => {
    h.botState.botName = 'CodeXonAst';
    h.botState.config.sessionGroup = { tag: { name: '  我的工作台 ' } };
    const calls = stubFetch();

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(creates(calls)).toEqual(['我的工作台']);
  });

  it('连显示名都没有（探测未回 + 没配 displayName）才用旧默认名', async () => {
    const calls = stubFetch();

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(creates(calls)).toEqual(['Botmux群会话']);
  });

  it('en locale 用 "<bot> chats"', async () => {
    h.botState.botName = 'CodeXonAst';
    vi.mocked(localeForBot).mockReturnValue('en');
    const calls = stubFetch();

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(creates(calls)).toEqual(['CodeXonAst chats']);
  });

  it('defaultSessionTagName 给 Dashboard placeholder 用的是同一个名字', () => {
    h.botState.botName = 'CodeXonAst';
    expect(defaultSessionTagName(APP)).toBe('CodeXonAst会话');
    h.botState.botName = undefined;
    expect(defaultSessionTagName(APP)).toBe('Botmux群会话');
  });
});

describe('默认名变化 → 已有分组自动改名（且只改一次）', () => {
  it('老缓存里的「Botmux群会话」在下次打标时被改名成「<bot 名>会话」', async () => {
    h.botState.botName = 'CodeXonAst';
    seedCache({ groupId: 'ofg_old', name: 'Botmux群会话', configuredName: 'Botmux群会话' });
    const calls = stubFetch();

    await tagSessionGroup(APP, CHAT, OWNER);

    const renames = calls.filter(c => c.method === 'PUT');
    expect(renames).toHaveLength(1);
    expect(renames[0].url).toContain('/im/v1/groups/ofg_old');
    expect(renames[0].body.feed_group_updater).toMatchObject({ name: 'CodeXonAst会话', update_fields: [1] });
    expect(readCache()).toMatchObject({ name: 'CodeXonAst会话', configuredName: 'CodeXonAst会话' });

    // 第二次打标：名字已对齐，不能再发 rename。
    const second = stubFetch();
    await tagSessionGroup(APP, 'oc_another', OWNER);
    expect(second.filter(c => c.method === 'PUT')).toHaveLength(0);
  });

  it('分组实际名已等于新默认名时不发同名 rename，只对齐 configuredName', async () => {
    // 典型历史状态：老默认名撞车后退避成了「CodeXonAst会话」，而新默认名恰好就是它。
    // 同名 rename 会被飞书判 230001 already exists → 失败分支不写 configuredName →
    // 每次打标都白跑一次，所以这里必须一次 PUT 都不发。
    h.botState.botName = 'CodeXonAst';
    seedCache({ groupId: 'ofg_fb', name: 'CodeXonAst会话', configuredName: 'Botmux群会话' });
    const calls = stubFetch();

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(0);
    expect(readCache()).toMatchObject({ name: 'CodeXonAst会话', configuredName: 'CodeXonAst会话' });
    // 打标本身照常完成。
    expect(calls.some(c => c.url.includes('/groups/ofg_fb/batch_add_item'))).toBe(true);
  });

  it('改名失败时保留旧 configuredName，下次还会重试', async () => {
    h.botState.botName = 'CodeXonAst';
    seedCache({ groupId: 'ofg_old', name: 'Botmux群会话', configuredName: 'Botmux群会话' });
    stubFetch(call => call.method === 'PUT' ? json({ code: 230001, msg: 'param is invalid' }) : undefined);

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(readCache()).toMatchObject({ name: 'Botmux群会话', configuredName: 'Botmux群会话' });
  });
});

describe('建群名冲突退避', () => {
  it('配置名被别的应用占用 → 退避到「<bot 名>会话」', async () => {
    h.botState.botName = 'CodeXonAst';
    h.botState.config.sessionGroup = { tag: { name: '共享名' } };
    const calls = stubFetch(call =>
      call.method === 'POST' && call.body?.feed_group_creator?.name === '共享名'
        ? json({ code: 230001, msg: 'param is invalid', error: { message: 'name already exists' } })
        : undefined);

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(creates(calls)).toEqual(['共享名', 'CodeXonAst会话']);
    expect(readCache()).toMatchObject({ name: 'CodeXonAst会话', configuredName: '共享名' });
  });

  it('默认名（已含 bot 名）也被占用 → 再退一档带 app 尾号，而不是放弃建群', async () => {
    h.botState.botName = 'CodeXonAst';
    const calls = stubFetch(call =>
      call.method === 'POST' && call.body?.feed_group_creator?.name === 'CodeXonAst会话'
        ? json({ code: 230001, msg: 'param is invalid', error: { message: 'name already exists' } })
        : undefined);

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(creates(calls)).toEqual(['CodeXonAst会话', `CodeXonAst会话·${APP.slice(-4)}`]);
    expect(readCache()).toMatchObject({ name: `CodeXonAst会话·${APP.slice(-4)}` });
  });
});

describe('chat-tag 模式共用同一套默认名', () => {
  it('用「<bot 名>会话」建租户群标签', async () => {
    h.botState.botName = 'CodeXonAst';
    h.botState.config.sessionGroup = { tag: { mode: 'chat-tag' } };
    h.tenantRequest.mockImplementation(async (req: any) =>
      req.url === '/open-apis/im/v2/tags' ? { code: 0, data: { id: 'tag_1' } } : { code: 0, data: {} });

    await tagSessionGroup(APP, CHAT, OWNER);

    const create = h.tenantRequest.mock.calls.find(([req]: any[]) => req.url === '/open-apis/im/v2/tags')![0];
    expect(create.data.create_tag).toMatchObject({ tag_type: 'tenant', name: 'CodeXonAst会话' });
    expect(readCache()).toMatchObject({ chatTagId: 'tag_1', chatTagName: 'CodeXonAst会话' });
  });

  it('老标签名「Botmux群会话」在下次打标时被 PATCH 成新默认名，且只改一次', async () => {
    h.botState.botName = 'CodeXonAst';
    h.botState.config.sessionGroup = { tag: { mode: 'chat-tag' } };
    seedCache({ chatTagId: 'tag_old', chatTagName: 'Botmux群会话' });
    h.tenantRequest.mockResolvedValue({ code: 0, data: {} });

    await tagSessionGroup(APP, CHAT, OWNER);

    const patch = h.tenantRequest.mock.calls.find(([req]: any[]) => req.method === 'PATCH')![0];
    expect(patch.url).toContain('/im/v2/tags/tag_old');
    expect(patch.data.patch_tag).toMatchObject({ name: 'CodeXonAst会话' });
    expect(readCache()).toMatchObject({ chatTagName: 'CodeXonAst会话' });

    // 第二次打标：名字已对齐 → 直接复用 tagId，不再 PATCH。
    h.tenantRequest.mockClear();
    await tagSessionGroup(APP, 'oc_another', OWNER);
    expect(h.tenantRequest.mock.calls.filter(([req]: any[]) => req.method === 'PATCH')).toHaveLength(0);
  });
});
