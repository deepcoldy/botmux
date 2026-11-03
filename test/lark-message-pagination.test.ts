/**
 * client.ts 里四条 `im/v1/messages` 翻页路径的行为钉死（listByThread /
 * listChatMessages / listChatMessagesUntil / listByChatFilter）。
 *
 * 这四份循环曾是复制粘贴的近乎同构实现，现在共用一个页迭代器；本文件对
 * 请求参数序列、请求次数（提前终止后不许多取一页）、截断/排序/尾部窗口、
 * 错误文案逐条断言，重构前后必须一字不差。
 *
 * history-thread-window.test.ts 另外钉了「尾部而非头部」这条历史坑的端到端形态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const state = {
    /** 合成会话，oldest -> newest */
    messages: [] as any[],
    /** message.get 是否能解析出 thread_id（快路径 / 回落路径） */
    threadIdResolvable: true,
    /** 第 N 次（1 起）list 调用返回非零业务码 */
    failAtListCall: 0,
    /** 第 N 次 list 调用返回的 data 不带 items（但仍给 page_token） */
    itemsMissingAtListCall: 0,
    listCalls: [] as Array<Record<string, unknown>>,
  };
  const ROOT = 'om_root';

  class MockClient {
    async request({ url, params }: { url: string; params?: any }) {
      if (/\/open-apis\/im\/v1\/messages\/[^/]+$/.test(url)) {
        return {
          code: 0,
          data: { items: [{ message_id: ROOT, thread_id: state.threadIdResolvable ? 'omt_x' : undefined }] },
        };
      }
      if (url === '/open-apis/im/v1/messages') {
        state.listCalls.push({ ...params });
        const n = state.listCalls.length;
        if (state.failAtListCall === n) return { code: 230002, msg: 'bot not in chat' };
        const pageSize = Number(params?.page_size ?? 50);
        const ordered = params?.sort_type === 'ByCreateTimeDesc' ? [...state.messages].reverse() : [...state.messages];
        const offset = params?.page_token ? Number(params.page_token) : 0;
        const next = offset + pageSize;
        const page_token = next < ordered.length ? String(next) : undefined;
        if (state.itemsMissingAtListCall === n) return { code: 0, data: { page_token } };
        return { code: 0, data: { items: ordered.slice(offset, offset + pageSize), page_token } };
      }
      throw new Error(`unexpected url in mock: ${url}`);
    }
  }
  return { state, MockClient, ROOT };
});
const { state, MockClient, ROOT } = hoisted;

vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return '/tmp/botmux-test'; } } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/utils/user-token.js', () => ({ resolveUserToken: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({
  loadBotConfigs: vi.fn(() => []),
  getBotClient: vi.fn(() => new MockClient()),
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({ LoggerLevel: { error: 4 }, Client: MockClient }));

/** n 条消息，ids m001..；每第 `otherEvery` 条不属于 ROOT（用于回落路径的过滤）。 */
function build(n: number, opts: { otherEvery?: number; noCreateTime?: boolean } = {}) {
  state.messages = Array.from({ length: n }, (_, i) => {
    const other = opts.otherEvery !== undefined && (i + 1) % opts.otherEvery === 0;
    return {
      message_id: `m${String(i + 1).padStart(3, '0')}`,
      root_id: other ? 'om_other' : ROOT,
      ...(opts.noCreateTime ? {} : { create_time: String(1_700_000_000_000 + i * 1000) }),
    };
  });
}
const ids = (msgs: any[]) => msgs.map(m => m.message_id);
const pageSizes = () => state.listCalls.map(c => c.page_size);
const tokens = () => state.listCalls.map(c => c.page_token);
const range = (a: number, b: number) =>
  Array.from({ length: b - a + 1 }, (_, i) => `m${String(a + i).padStart(3, '0')}`);

beforeEach(() => {
  state.listCalls = [];
  state.threadIdResolvable = true;
  state.failAtListCall = 0;
  state.itemsMissingAtListCall = 0;
  build(130);
});

describe('listMessagesByThreadId (listByThread)', () => {
  it('请求参数逐字：thread 容器 / Desc / with_sender_name / 首页无 page_token', async () => {
    const { listMessagesByThreadId } = await import('../src/im/lark/client.js');
    await listMessagesByThreadId('cli_x', 'omt_1', 10);
    expect(state.listCalls).toEqual([{
      container_id_type: 'thread', container_id: 'omt_1', page_size: 10,
      sort_type: 'ByCreateTimeDesc', with_sender_name: 'true',
    }]);
    expect(Object.keys(state.listCalls[0])).toEqual(
      ['container_id_type', 'container_id', 'page_size', 'sort_type', 'with_sender_name']);
  });

  it('limit < 单页：一页取够即停，返回最新 N 条且按时间正序', async () => {
    const { listMessagesByThreadId } = await import('../src/im/lark/client.js');
    const out = await listMessagesByThreadId('cli_x', 'omt_1', 3);
    expect(ids(out)).toEqual(['m128', 'm129', 'm130']);
    expect(pageSizes()).toEqual([3]);
  });

  it('limit > 50：page_size 夹到 50，翻页带 page_token，越过 limit 的那页截尾部窗口，不再多取一页', async () => {
    const { listMessagesByThreadId } = await import('../src/im/lark/client.js');
    const out = await listMessagesByThreadId('cli_x', 'omt_1', 80);
    expect(pageSizes()).toEqual([50, 50]); // 100 >= 80 即停，没有第 3 页
    expect(tokens()).toEqual([undefined, '50']);
    expect(ids(out)).toEqual(range(51, 130));
    expect(out).toHaveLength(80);
  });

  it('limit 恰为整页倍数：取满即停', async () => {
    const { listMessagesByThreadId } = await import('../src/im/lark/client.js');
    const out = await listMessagesByThreadId('cli_x', 'omt_1', 100);
    expect(pageSizes()).toEqual([50, 50]);
    expect(ids(out)).toEqual(range(31, 130));
  });

  it('线程比 limit 短：翻到没有 page_token 为止，全部返回', async () => {
    build(7);
    const { listMessagesByThreadId } = await import('../src/im/lark/client.js');
    const out = await listMessagesByThreadId('cli_x', 'omt_1', 50);
    expect(ids(out)).toEqual(range(1, 7));
    expect(state.listCalls).toHaveLength(1);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('pageSize=%s 视为不限：翻完全部页、全部返回', async (limit) => {
    const { listMessagesByThreadId } = await import('../src/im/lark/client.js');
    const out = await listMessagesByThreadId('cli_x', 'omt_1', limit);
    expect(pageSizes()).toEqual([50, 50, 50]);
    expect(tokens()).toEqual([undefined, '50', '100']);
    expect(ids(out)).toEqual(range(1, 130));
  });

  it('某页没有 items 字段：跳过该页但继续按 page_token 翻', async () => {
    state.itemsMissingAtListCall = 1;
    const { listMessagesByThreadId } = await import('../src/im/lark/client.js');
    const out = await listMessagesByThreadId('cli_x', 'omt_1', 0);
    expect(state.listCalls).toHaveLength(3);
    expect(ids(out)).toEqual(range(1, 80)); // 第 1 页（最新 50 条）整页缺失
  });

  it('业务错误：message 文案逐字 + 结构化 code，且立即抛出不再取页', async () => {
    state.failAtListCall = 2;
    const { listMessagesByThreadId } = await import('../src/im/lark/client.js');
    const err = await listMessagesByThreadId('cli_x', 'omt_1', 0).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Failed to list thread messages: bot not in chat (code: 230002)');
    expect(err.code).toBe(230002);
    expect(state.listCalls).toHaveLength(2);
  });
});

describe('listChatMessages', () => {
  it('请求参数逐字：chat 容器', async () => {
    const { listChatMessages } = await import('../src/im/lark/client.js');
    await listChatMessages('cli_x', 'oc_1', 10);
    expect(state.listCalls).toEqual([{
      container_id_type: 'chat', container_id: 'oc_1', page_size: 10,
      sort_type: 'ByCreateTimeDesc', with_sender_name: 'true',
    }]);
    expect(Object.keys(state.listCalls[0])).toEqual(
      ['container_id_type', 'container_id', 'page_size', 'sort_type', 'with_sender_name']);
  });

  it('默认 limit=50：一页，最新 50 条正序', async () => {
    const { listChatMessages } = await import('../src/im/lark/client.js');
    const out = await listChatMessages('cli_x', 'oc_1');
    expect(pageSizes()).toEqual([50]);
    expect(ids(out)).toEqual(range(81, 130));
  });

  it('limit=120：50/50/50 三页后截尾部 120', async () => {
    const { listChatMessages } = await import('../src/im/lark/client.js');
    const out = await listChatMessages('cli_x', 'oc_1', 120);
    expect(pageSizes()).toEqual([50, 50, 50]);
    expect(tokens()).toEqual([undefined, '50', '100']);
    expect(ids(out)).toEqual(range(11, 130));
  });

  it.each([0, Number.POSITIVE_INFINITY])('pageSize=%s 不限：全取', async (limit) => {
    const { listChatMessages } = await import('../src/im/lark/client.js');
    const out = await listChatMessages('cli_x', 'oc_1', limit);
    expect(ids(out)).toEqual(range(1, 130));
    expect(state.listCalls).toHaveLength(3);
  });

  it('业务错误文案与 code', async () => {
    state.failAtListCall = 1;
    const { listChatMessages } = await import('../src/im/lark/client.js');
    const err = await listChatMessages('cli_x', 'oc_1', 5).catch(e => e);
    expect(err.message).toBe('Failed to list chat messages: bot not in chat (code: 230002)');
    expect(err.code).toBe(230002);
  });
});

describe('listChatMessagesUntil', () => {
  it('默认 page_size=50；不给 stopAfter 则翻完全部页，返回全量正序', async () => {
    const { listChatMessagesUntil } = await import('../src/im/lark/client.js');
    const out = await listChatMessagesUntil('cli_x', 'oc_1');
    expect(pageSizes()).toEqual([50, 50, 50]);
    expect(tokens()).toEqual([undefined, '50', '100']);
    expect(ids(out)).toEqual(range(1, 130));
  });

  it.each([
    [undefined, 50], [Number.NaN, 50], [0, 1], [-5, 1], [7.9, 7], [999, 50], [1, 1],
  ])('options.pageSize=%s → 每页 %s', async (pageSize, expected) => {
    const { listChatMessagesUntil } = await import('../src/im/lark/client.js');
    await listChatMessagesUntil('cli_x', 'oc_1', pageSize === undefined ? {} : { pageSize });
    expect(state.listCalls[0].page_size).toBe(expected);
  });

  it('stopAfter 在页中命中：包含命中那条、之后的不取、不再请求下一页', async () => {
    const { listChatMessagesUntil } = await import('../src/im/lark/client.js');
    const seen: Array<[string, number]> = [];
    const out = await listChatMessagesUntil('cli_x', 'oc_1', {
      pageSize: 10,
      stopAfter: (m, n) => { seen.push([m.message_id, n]); return m.message_id === 'm118'; },
    });
    expect(state.listCalls).toHaveLength(2); // 命中在第 2 页（m121..m112）
    expect(seen.at(0)).toEqual(['m130', 1]);
    expect(seen.at(-1)).toEqual(['m118', 13]);
    expect(ids(out)).toEqual(range(118, 130));
  });

  it('stopAfter 恰在页尾命中：不会为它多取下一页', async () => {
    const { listChatMessagesUntil } = await import('../src/im/lark/client.js');
    const out = await listChatMessagesUntil('cli_x', 'oc_1', {
      pageSize: 10, stopAfter: (_m, n) => n === 10,
    });
    expect(state.listCalls).toHaveLength(1);
    expect(ids(out)).toEqual(range(121, 130));
  });

  it('stopAfter 从不命中：扫到末页为止', async () => {
    build(23);
    const { listChatMessagesUntil } = await import('../src/im/lark/client.js');
    const out = await listChatMessagesUntil('cli_x', 'oc_1', { pageSize: 10, stopAfter: () => false });
    expect(state.listCalls).toHaveLength(3);
    expect(ids(out)).toEqual(range(1, 23));
  });

  it('某页缺 items：跳过继续', async () => {
    state.itemsMissingAtListCall = 2;
    const { listChatMessagesUntil } = await import('../src/im/lark/client.js');
    const out = await listChatMessagesUntil('cli_x', 'oc_1');
    expect(state.listCalls).toHaveLength(3);
    expect(ids(out)).toEqual([...range(1, 30), ...range(81, 130)]);
  });

  it('业务错误：文案与 list chat messages 相同，并带 code', async () => {
    state.failAtListCall = 2;
    const { listChatMessagesUntil } = await import('../src/im/lark/client.js');
    const err = await listChatMessagesUntil('cli_x', 'oc_1').catch(e => e);
    expect(err.message).toBe('Failed to list chat messages: bot not in chat (code: 230002)');
    expect(err.code).toBe(230002);
  });
});

describe('listThreadMessages 回落路径 (listByChatFilter)', () => {
  beforeEach(() => { state.threadIdResolvable = false; });

  it('请求参数逐字；每第 5 条是别的 root 的，被过滤掉', async () => {
    build(40, { otherEvery: 5 });
    const { listThreadMessages } = await import('../src/im/lark/client.js');
    const out = await listThreadMessages('cli_x', 'oc_1', ROOT, 0);
    expect(state.listCalls[0]).toEqual({
      container_id_type: 'chat', container_id: 'oc_1', page_size: 50,
      sort_type: 'ByCreateTimeDesc', with_sender_name: 'true',
    });
    expect(Object.keys(state.listCalls[0])).toEqual(
      ['container_id_type', 'container_id', 'page_size', 'sort_type', 'with_sender_name']);
    expect(out).toHaveLength(32);
    expect(ids(out).every(id => Number(id.slice(1)) % 5 !== 0)).toBe(true);
  });

  it('截断按「过滤后」条数计：够 limit 才停，取尾部窗口并正序', async () => {
    build(130, { otherEvery: 2 }); // 一半属于 ROOT
    const { listThreadMessages } = await import('../src/im/lark/client.js');
    const out = await listThreadMessages('cli_x', 'oc_1', ROOT, 20);
    // 每页 page_size=20（< 50），Desc 取 20 条里约 10 条匹配 → 需 2 页凑够 20
    expect(pageSizes()).toEqual([20, 20]);
    expect(out).toHaveLength(20);
    expect(ids(out)).toEqual(
      range(1, 130).filter((_, i) => (i + 1) % 2 === 1).slice(-20),
    );
  });

  it('匹配数少于 limit（常态）：Math.max(0, …) 保住最老的那批，不被负 slice 吃掉', async () => {
    build(12);
    const { listThreadMessages } = await import('../src/im/lark/client.js');
    const out = await listThreadMessages('cli_x', 'oc_1', ROOT, 50);
    expect(ids(out)).toEqual(range(1, 12));
  });

  it('缺 create_time 的消息按空串排序，不抛', async () => {
    build(6, { noCreateTime: true });
    const { listThreadMessages } = await import('../src/im/lark/client.js');
    const out = await listThreadMessages('cli_x', 'oc_1', ROOT, 50);
    expect(out).toHaveLength(6);
  });

  it('业务错误文案与 code', async () => {
    state.failAtListCall = 1;
    const { listThreadMessages } = await import('../src/im/lark/client.js');
    const err = await listThreadMessages('cli_x', 'oc_1', ROOT, 5).catch(e => e);
    expect(err.message).toBe('Failed to list messages: bot not in chat (code: 230002)');
    expect(err.code).toBe(230002);
  });
});
