/**
 * 会话群标签的**自愈**行为（feed-group + chat-tag 两种模式）。
 *
 * 背景（线上真实故障）：用户在飞书侧边栏手动删掉了「Botmux群会话」分组，本地缓存
 * ~/.botmux/data/feed-group-cache-<appId>.json 里的 groupId 变成野指针，之后每次打标
 * 飞书都回 230004（group_id Not Exists）——旧实现既不清缓存也不重建，于是永久失败。
 *
 * 本文件盯住四件事：
 *   1. 打标/改名撞上「已不存在」→ 丢缓存 → 按名反查复用（没有就新建）→ 重试一次成功；
 *   2. 自愈重建后 configuredName 语义正确：下一次打标**不能**再多发一次 rename；
 *   3. 只有**明确**的不存在信号才自愈——网络错误、限流、鉴权失败绝不能清缓存，
 *      否则会把一个还活着的分组孤儿化（负向保护，这条比正向用例更重要）；
 *   4. 自愈额度每次调用只有一份：重试后仍报不存在就直接失败，不无限循环。
 *
 * mock 风格跟随 test/feed-group-tagger-default-name.test.ts（同一条链路的姊妹文件）。
 *
 * Run:  pnpm vitest run test/feed-group-tagger-self-heal.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const APP = 'cli_heal_test';
const CHAT = 'oc_new_session_group';
const OWNER = 'ou_owner';
/** 缓存里那个「已经被用户删掉」的分组 id。 */
const DEAD = 'ofg_dead';

let tempDir: string;

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

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => h.botState),
  getBotClient: vi.fn(() => ({ request: (...args: any[]) => h.tenantRequest(...args) })),
  effectiveBotDisplayName: (s: any) => s.config.displayName || s.botName || s.config.larkAppId,
}));

import { tagSessionGroup } from '../src/services/feed-group-tagger.js';
import { logger } from '../src/utils/logger.js';

/** 默认名：botName = 'Zed' → 「Zed会话」，两种模式共用。 */
const NAME = 'Zed会话';

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

/** 飞书对着已删分组返回的错误体（线上实测形状）。 */
const GONE = { code: 230004, msg: 'group_id Not Exists' };

interface Call { method: string; url: string; body: any }

/**
 * fetch 桩：list 默认空、create/rename/add 默认成功；`overrides` 让某一条走别的分支。
 * `listGroups` 可以让反查看到已存在的同名分组（复用路径）。
 */
function stubFetch(opts?: {
  listGroups?: Array<{ group_id: string; name: string }>;
  overrides?: (call: Call) => Response | undefined;
  reject?: (call: Call) => boolean;
}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (opts?.reject?.(call)) throw new Error('fetch failed: ECONNRESET');
    const custom = opts?.overrides?.(call);
    if (custom) return custom;
    if (call.method === 'GET') return json({ code: 0, data: { groups: opts?.listGroups ?? [], has_more: false } });
    if (call.url.includes('batch_add_item')) return json({ code: 0, data: { failed_items: [] } });
    if (call.method === 'POST') return json({ code: 0, data: { group_id: 'ofg_created' } });
    return json({ code: 0, data: {} }); // PUT rename
  }));
  return calls;
}

const creates = (calls: Call[]): string[] => calls
  .filter(c => c.method === 'POST' && c.url.endsWith('/im/v1/groups'))
  .map(c => c.body.feed_group_creator.name);

/** 每次 batch_add_item 打到的分组 id，按调用顺序。 */
const addTargets = (calls: Call[]): string[] => calls
  .filter(c => c.url.includes('batch_add_item'))
  .map(c => /\/groups\/([^/]+)\/batch_add_item/.exec(c.url)![1]);

const renames = (calls: Call[]): Call[] => calls.filter(c => c.method === 'PUT');

const infoLogs = (): string[] => vi.mocked(logger.info).mock.calls.map(([m]) => String(m));

// ── chat-tag 辅助 ────────────────────────────────────────────────────────────

type TenantCall = { method: string; url: string; data: any };
const tenantCalls = (): TenantCall[] => h.tenantRequest.mock.calls.map(([req]: any[]) => req);
const tagCreates = (): TenantCall[] => tenantCalls().filter(r => r.url === '/open-apis/im/v2/tags' && r.method === 'POST');
const tagPatches = (): TenantCall[] => tenantCalls().filter(r => r.method === 'PATCH');
/** 每次 bind 用的 tag id，按调用顺序。 */
const binds = (): string[] => tenantCalls()
  .filter(r => r.url === '/open-apis/im/v2/biz_entity_tag_relation')
  .map(r => r.data.tag_ids[0]);

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'feed-group-heal-test-'));
  h.botState.config = {
    larkAppId: APP, larkAppSecret: 'sec', brand: 'feishu', cliId: 'codex', sessionGroup: {},
  };
  h.botState.botName = 'Zed';
  h.tenantRequest.mockReset();
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('feed-group 自愈：打标撞上「分组已被删」', () => {
  it('① 230004 → 丢缓存 → 按名反查到旧同名分组 → 复用并重试打标成功', async () => {
    seedCache({ groupId: DEAD, name: NAME, configuredName: NAME });
    const calls = stubFetch({
      listGroups: [{ group_id: 'ofg_live', name: NAME }],
      overrides: call => call.url.includes(`/groups/${DEAD}/batch_add_item`) ? json(GONE) : undefined,
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    // 死 id 打一次 → 反查复用 → 活 id 再打一次，一共两次、只重试一次。
    expect(addTargets(calls)).toEqual([DEAD, 'ofg_live']);
    // 反查命中就不该新建分组。
    expect(creates(calls)).toEqual([]);
    expect(readCache()).toMatchObject({ groupId: 'ofg_live', name: NAME, configuredName: NAME });
    expect(infoLogs().some(m => m.includes('no longer exists') && m.includes(DEAD))).toBe(true);
    expect(infoLogs().some(m => m.includes('rebuilt/reused') && m.includes('ofg_live'))).toBe(true);
  });

  it('② 230004 → 反查无同名分组 → 新建 → 重试打标成功', async () => {
    seedCache({ groupId: DEAD, name: NAME, configuredName: NAME });
    const calls = stubFetch({
      overrides: call => call.url.includes(`/groups/${DEAD}/batch_add_item`) ? json(GONE) : undefined,
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(creates(calls)).toEqual([NAME]);
    expect(addTargets(calls)).toEqual([DEAD, 'ofg_created']);
    expect(readCache()).toMatchObject({ groupId: 'ofg_created', name: NAME, configuredName: NAME });
  });

  it('自愈后缓存 configuredName 正确 → 下一次打标不再发多余 rename、也不再重建', async () => {
    seedCache({ groupId: DEAD, name: NAME, configuredName: NAME });
    stubFetch({
      listGroups: [{ group_id: 'ofg_live', name: NAME }],
      overrides: call => call.url.includes(`/groups/${DEAD}/batch_add_item`) ? json(GONE) : undefined,
    });
    await tagSessionGroup(APP, CHAT, OWNER);

    const second = stubFetch({ listGroups: [{ group_id: 'ofg_live', name: NAME }] });
    await tagSessionGroup(APP, 'oc_another', OWNER);

    expect(renames(second)).toHaveLength(0);
    expect(creates(second)).toEqual([]);
    expect(addTargets(second)).toEqual(['ofg_live']);
  });
});

describe('feed-group 自愈：改名撞上「分组已被删」', () => {
  it('③ rename 230004 → 丢缓存重建 → 本次打标继续；之后不再发多余 rename', async () => {
    // 老缓存还是旧默认名，本次目标名是「Zed会话」→ 会先走 rename。
    seedCache({ groupId: DEAD, name: 'Botmux群会话', configuredName: 'Botmux群会话' });
    const calls = stubFetch({
      overrides: call => call.method === 'PUT' ? json(GONE) : undefined,
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    // 改名只发一次就放弃改名路线，转去重建。
    expect(renames(calls)).toHaveLength(1);
    expect(creates(calls)).toEqual([NAME]);
    // 打标直接打在新分组上——不会先往死 id 上白打一次。
    expect(addTargets(calls)).toEqual(['ofg_created']);
    expect(readCache()).toMatchObject({ groupId: 'ofg_created', name: NAME, configuredName: NAME });

    const second = stubFetch();
    await tagSessionGroup(APP, 'oc_another', OWNER);
    expect(renames(second)).toHaveLength(0);
    expect(creates(second)).toEqual([]);
  });

  it('rename 是普通失败（230001 撞名）时不自愈：保留旧分组，下次还会重试改名', async () => {
    seedCache({ groupId: 'ofg_old', name: 'Botmux群会话', configuredName: 'Botmux群会话' });
    const calls = stubFetch({
      overrides: call => call.method === 'PUT'
        ? json({ code: 230001, msg: 'param is invalid', error: { message: 'name already exists' } })
        : undefined,
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(creates(calls)).toEqual([]);
    expect(addTargets(calls)).toEqual(['ofg_old']);
    expect(readCache()).toMatchObject({ groupId: 'ofg_old', name: 'Botmux群会话', configuredName: 'Botmux群会话' });
  });
});

describe('feed-group 负向保护：只有明确的「不存在」才清缓存', () => {
  /** 打标失败时，缓存里的 groupId 必须原封不动，且不能触发反查/新建。 */
  async function expectNoHeal(failure: () => { response?: Response; reject?: boolean }): Promise<Call[]> {
    seedCache({ groupId: DEAD, name: NAME, configuredName: NAME });
    const isTarget = (call: Call) => call.url.includes(`/groups/${DEAD}/batch_add_item`);
    const calls = stubFetch({
      reject: call => isTarget(call) && failure().reject === true,
      overrides: call => isTarget(call) ? failure().response : undefined,
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(addTargets(calls)).toEqual([DEAD]);           // 一次也没重试
    expect(calls.filter(c => c.method === 'GET')).toHaveLength(0); // 没反查
    expect(creates(calls)).toEqual([]);                  // 没重建
    expect(readCache()).toMatchObject({ groupId: DEAD, name: NAME, configuredName: NAME });
    return calls;
  }

  it('④a 网络错误（fetch reject，连 code 都没有）→ 不清缓存', async () => {
    await expectNoHeal(() => ({ reject: true }));
  });

  it('④b 限流 / 服务端错误码 → 不清缓存', async () => {
    await expectNoHeal(() => ({ response: json({ code: 11232, msg: 'rate limit exceeded' }) }));
  });

  it('④c 鉴权失败（缺 scope）→ 不清缓存', async () => {
    await expectNoHeal(() => ({
      response: json({ code: 99991672, msg: 'Access denied', error: { message: 'no permission [im:feed_group_v1:write]' } }),
    }));
  });

  it('④d HTTP 404「Not Found」（路由/网关问题，不是分组没了）→ 不清缓存', async () => {
    await expectNoHeal(() => ({
      response: new Response('not found', { status: 404, statusText: 'Not Found' }),
    }));
  });

  it('④e 230001 + "already exists"（撞名，不是不存在）→ 不清缓存', async () => {
    await expectNoHeal(() => ({
      response: json({ code: 230001, msg: 'param is invalid', error: { message: 'name already exists' } }),
    }));
  });

  it('230001 且 error.message 明确说不存在时才算「已删」（文案兜底档确实生效）', async () => {
    seedCache({ groupId: DEAD, name: NAME, configuredName: NAME });
    const calls = stubFetch({
      overrides: call => call.url.includes(`/groups/${DEAD}/batch_add_item`)
        ? json({ code: 230001, msg: 'param is invalid', error: { message: 'group_id does not exist' } })
        : undefined,
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(addTargets(calls)).toEqual([DEAD, 'ofg_created']);
    expect(readCache()).toMatchObject({ groupId: 'ofg_created' });
  });
});

describe('feed-group 自愈额度：一次调用最多自愈一次', () => {
  it('⑤ 重建后仍 230004 → 只重试一次就失败，不无限循环', async () => {
    seedCache({ groupId: DEAD, name: NAME, configuredName: NAME });
    // 无差别 230004：任何 batch_add_item 都说分组不存在。
    const calls = stubFetch({
      overrides: call => call.url.includes('batch_add_item') ? json(GONE) : undefined,
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(addTargets(calls)).toEqual([DEAD, 'ofg_created']); // 恰好两次
    expect(creates(calls)).toEqual([NAME]);                   // 只重建一次
    expect(vi.mocked(logger.warn).mock.calls.some(([m]) => String(m).includes('feed group add'))).toBe(true);
  });

  it('rename 已经用掉自愈额度后，打标再撞 230004 不再重试', async () => {
    seedCache({ groupId: DEAD, name: 'Botmux群会话', configuredName: 'Botmux群会话' });
    const calls = stubFetch({
      overrides: call => (call.method === 'PUT' || call.url.includes('batch_add_item')) ? json(GONE) : undefined,
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(creates(calls)).toEqual([NAME]);              // rename 自愈重建了一次
    expect(addTargets(calls)).toEqual(['ofg_created']);  // 打标失败后不再自愈
  });
});

describe('feed-group：新建撞「已存在」→ 先按名反查复用，再走退避候选', () => {
  it('创建报 230001 already exists 而分组确实在 → 复用它，不建退避名分组', async () => {
    // 第一次反查（建群前）看不到，创建报已存在，第二次反查（退避前）能看到 → 复用。
    let listed = 0;
    const calls = stubFetch({
      overrides: call => {
        if (call.method === 'GET') {
          listed += 1;
          return json({
            code: 0,
            data: { groups: listed === 1 ? [] : [{ group_id: 'ofg_raced', name: NAME }], has_more: false },
          });
        }
        return call.method === 'POST' && call.body?.feed_group_creator?.name === NAME
          ? json({ code: 230001, msg: 'param is invalid', error: { message: 'name already exists' } })
          : undefined;
      },
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(creates(calls)).toEqual([NAME]);              // 没有退避名的第二次创建
    expect(addTargets(calls)).toEqual(['ofg_raced']);
    expect(readCache()).toMatchObject({ groupId: 'ofg_raced', name: NAME, configuredName: NAME });
  });

  it('反查两次都看不到（真被别的应用占着）→ 照旧走退避候选名', async () => {
    const calls = stubFetch({
      overrides: call => call.method === 'POST' && call.body?.feed_group_creator?.name === NAME
        ? json({ code: 230001, msg: 'param is invalid', error: { message: 'name already exists' } })
        : undefined,
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(creates(calls)).toEqual([NAME, `${NAME}·${APP.slice(-4)}`]);
  });
});

// ─── chat-tag 模式 ───────────────────────────────────────────────────────────

/** chat-tag 模式下飞书对着已删标签返回的错误体（错误码未公开 → 按文案判）。 */
const TAG_GONE = { code: 232010, msg: 'tag not exists' };

function useChatTagMode(): void {
  h.botState.config.sessionGroup = { tag: { mode: 'chat-tag' } };
}

describe('chat-tag 自愈', () => {
  it('⑥ bind 撞「标签不存在」→ 丢缓存 → 重建/复用同名标签 → 重试 bind 成功', async () => {
    useChatTagMode();
    seedCache({ chatTagId: 'tag_dead', chatTagName: NAME });
    h.tenantRequest.mockImplementation(async (req: any) => {
      if (req.url === '/open-apis/im/v2/tags') return { code: 0, data: { id: 'tag_new' } };
      if (req.data?.tag_ids?.[0] === 'tag_dead') return { code: TAG_GONE.code, msg: TAG_GONE.msg };
      return { code: 0, data: {} };
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(binds()).toEqual(['tag_dead', 'tag_new']);
    expect(tagCreates()).toHaveLength(1);
    expect(readCache()).toMatchObject({ chatTagId: 'tag_new', chatTagName: NAME });
    expect(infoLogs().some(m => m.includes('rebuilt/reused') && m.includes('tag_new'))).toBe(true);
  });

  it('⑥ SDK 抛错（err.response.data 里带 230004）也能判出「标签不存在」', async () => {
    useChatTagMode();
    seedCache({ chatTagId: 'tag_dead', chatTagName: NAME });
    h.tenantRequest.mockImplementation(async (req: any) => {
      if (req.url === '/open-apis/im/v2/tags') return { code: 0, data: { id: 'tag_new' } };
      if (req.data?.tag_ids?.[0] === 'tag_dead') {
        throw Object.assign(new Error('req failed'), {
          response: { data: { code: 230004, msg: 'tag_id Not Exists' } },
        });
      }
      return { code: 0, data: {} };
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(binds()).toEqual(['tag_dead', 'tag_new']);
    expect(readCache()).toMatchObject({ chatTagId: 'tag_new' });
  });

  it('⑥ 标签重建时同名标签还在 → 用飞书回的 duplicate_id 复用，不产生新标签', async () => {
    useChatTagMode();
    seedCache({ chatTagId: 'tag_dead', chatTagName: NAME });
    h.tenantRequest.mockImplementation(async (req: any) => {
      if (req.url === '/open-apis/im/v2/tags') {
        return { code: 0, data: { create_tag_fail_reason: { duplicate_id: 'tag_existing' } } };
      }
      if (req.data?.tag_ids?.[0] === 'tag_dead') return { code: TAG_GONE.code, msg: TAG_GONE.msg };
      return { code: 0, data: {} };
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(binds()).toEqual(['tag_dead', 'tag_existing']);
    expect(readCache()).toMatchObject({ chatTagId: 'tag_existing', chatTagName: NAME });
  });

  it('⑥ PATCH 改名撞「标签不存在」→ 重建后继续打标，且之后不再发多余 PATCH', async () => {
    useChatTagMode();
    seedCache({ chatTagId: 'tag_dead', chatTagName: 'Botmux群会话' });
    h.tenantRequest.mockImplementation(async (req: any) => {
      if (req.method === 'PATCH') return { code: TAG_GONE.code, msg: TAG_GONE.msg };
      if (req.url === '/open-apis/im/v2/tags') return { code: 0, data: { id: 'tag_new' } };
      return { code: 0, data: {} };
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(tagPatches()).toHaveLength(1);
    expect(binds()).toEqual(['tag_new']);   // 不会先往死 id 上白打一次
    expect(readCache()).toMatchObject({ chatTagId: 'tag_new', chatTagName: NAME });

    h.tenantRequest.mockClear();
    await tagSessionGroup(APP, 'oc_another', OWNER);
    expect(tagPatches()).toHaveLength(0);
    expect(tagCreates()).toHaveLength(0);
  });

  it('⑥负向 缺 scope（99991672）→ 不清缓存不自愈', async () => {
    useChatTagMode();
    seedCache({ chatTagId: 'tag_dead', chatTagName: NAME });
    h.tenantRequest.mockImplementation(async (req: any) => {
      if (req.url === '/open-apis/im/v2/biz_entity_tag_relation') {
        throw Object.assign(new Error('req failed'), {
          response: {
            data: { code: 99991672, msg: 'Access denied', error: { message: 'no permission [im:tag:write]' } },
          },
        });
      }
      return { code: 0, data: {} };
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(binds()).toEqual(['tag_dead']);
    expect(tagCreates()).toHaveLength(0);
    expect(readCache()).toMatchObject({ chatTagId: 'tag_dead', chatTagName: NAME });
  });

  it('⑥负向 网络异常（没有 code）→ 不清缓存不自愈', async () => {
    useChatTagMode();
    seedCache({ chatTagId: 'tag_dead', chatTagName: NAME });
    h.tenantRequest.mockImplementation(async (req: any) => {
      if (req.url === '/open-apis/im/v2/biz_entity_tag_relation') throw new Error('socket hang up');
      return { code: 0, data: {} };
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(binds()).toEqual(['tag_dead']);
    expect(readCache()).toMatchObject({ chatTagId: 'tag_dead', chatTagName: NAME });
  });

  it('⑥负向 只说「参数非法」、没点名标签 → 不清缓存（判错必须精确）', async () => {
    useChatTagMode();
    seedCache({ chatTagId: 'tag_dead', chatTagName: NAME });
    h.tenantRequest.mockImplementation(async (req: any) => {
      if (req.url === '/open-apis/im/v2/biz_entity_tag_relation') {
        return { code: 230001, msg: 'param is invalid' };
      }
      return { code: 0, data: {} };
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(binds()).toEqual(['tag_dead']);
    expect(readCache()).toMatchObject({ chatTagId: 'tag_dead' });
  });

  it('⑤ chat-tag 自愈一次后仍报不存在 → 只重试一次即失败', async () => {
    useChatTagMode();
    seedCache({ chatTagId: 'tag_dead', chatTagName: NAME });
    h.tenantRequest.mockImplementation(async (req: any) => {
      if (req.url === '/open-apis/im/v2/tags') return { code: 0, data: { id: 'tag_new' } };
      if (req.url === '/open-apis/im/v2/biz_entity_tag_relation') return { code: TAG_GONE.code, msg: TAG_GONE.msg };
      return { code: 0, data: {} };
    });

    await tagSessionGroup(APP, CHAT, OWNER);

    expect(binds()).toEqual(['tag_dead', 'tag_new']);
    expect(tagCreates()).toHaveLength(1);
  });
});
