import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 回归：飞书对**单条评论的回复串**分页（实测一页 5 条），并把 `has_more` 挂在
 * 评论对象顶层。吃下这个截断会让长 thread 从第 6 条回复起永久失联 —— 事件带
 * 着新 reply_id 打进来，在只有 5 条的 replies 里找不到，旧代码 `?? replies[last]`
 * 静默回退到最后一条已知回复，turnId 因此恒定不变，每条新评论都被去重逻辑
 * 当成重复回合丢弃。
 */

const mocks = vi.hoisted(() => ({
  tenantRequest: vi.fn(),
  resolveUserToken: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  formatLarkError: vi.fn(),
  getAllBots: vi.fn(() => []),
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app-test', larkAppSecret: 'secret-test', brand: 'feishu' },
  })),
  getBotClient: vi.fn(() => ({ request: mocks.tenantRequest })),
  loadBotConfigs: vi.fn(() => []),
}));

vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: mocks.resolveUserToken,
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: mocks.info, warn: mocks.warn },
}));

import { getDocComment, listDocComments } from '../src/im/lark/doc-comment.js';
import { docCommentRepliesAfterCursor, latestDocCommentPollCursor } from '../src/core/doc-comment-poller.js';

const FILE = { fileToken: 'DocToken1234567890123456', fileType: 'docx' };
const COMMENT_ID = '7681622822925421500';

function reply(id: string, text: string, createTime: number) {
  return {
    reply_id: id,
    user_id: 'ou_author',
    create_time: String(createTime),
    content: { elements: [{ text_run: { text } }] },
  };
}

/** batch_query 的应答：只给前 5 条，顶层 has_more=true。 */
function truncatedBatchQuery(replies: unknown[]) {
  return {
    code: 0,
    data: {
      items: [{
        comment_id: COMMENT_ID,
        is_whole: false,
        is_solved: false,
        quote: '  "grain": "product_id",',
        has_more: true,
        page_token: '7681631714111704022',
        reply_list: { replies },
      }],
    },
  };
}

describe('getDocComment: 补全被分页截断的回复串', () => {
  beforeEach(() => {
    mocks.tenantRequest.mockReset();
    mocks.resolveUserToken.mockReset().mockResolvedValue(null);
    mocks.warn.mockReset();
    mocks.info.mockReset();
  });

  it('has_more=true 时改用 /replies 端点拉全量，返回完整 thread', async () => {
    const first5 = [1, 2, 3, 4, 5].map(i => reply(`reply-${i}`, `msg ${i}`, 1788500000 + i));
    const all11 = Array.from({ length: 11 }, (_, i) => reply(`reply-${i + 1}`, `msg ${i + 1}`, 1788500000 + i + 1));

    mocks.tenantRequest.mockImplementation(async (opts: any) => {
      if (opts.url.endsWith('/comments/batch_query')) return truncatedBatchQuery(first5);
      if (opts.url.includes(`/comments/${COMMENT_ID}/replies`)) {
        return { code: 0, data: { items: all11, has_more: false } };
      }
      throw new Error(`unexpected call ${opts.url}`);
    });

    const comment = await getDocComment('app-test', FILE, COMMENT_ID);

    expect(comment).not.toBeNull();
    expect(comment!.replies).toHaveLength(11);
    expect(comment!.replies.at(-1)!.replyId).toBe('reply-11');
    expect(comment!.hasMoreReplies).toBe(false);
    // 评论自身的元数据（quote / is_whole）不能被补全流程弄丢。
    expect(comment!.quote).toBe('"grain": "product_id",');
    expect(comment!.isWhole).toBe(false);
  });

  it('/replies 自身分页时继续翻页直到 has_more=false', async () => {
    const page1 = [1, 2].map(i => reply(`reply-${i}`, `msg ${i}`, 1788500000 + i));
    const page2 = [3, 4].map(i => reply(`reply-${i}`, `msg ${i}`, 1788500000 + i));

    mocks.tenantRequest.mockImplementation(async (opts: any) => {
      if (opts.url.endsWith('/comments/batch_query')) return truncatedBatchQuery(page1);
      if (opts.url.includes('/replies')) {
        return opts.params?.page_token
          ? { code: 0, data: { items: page2, has_more: false } }
          : { code: 0, data: { items: page1, has_more: true, page_token: 'cursor-2' } };
      }
      throw new Error(`unexpected call ${opts.url}`);
    });

    const comment = await getDocComment('app-test', FILE, COMMENT_ID);
    expect(comment!.replies.map(r => r.replyId)).toEqual(['reply-1', 'reply-2', 'reply-3', 'reply-4']);
  });

  it('has_more=false 时不额外打 /replies', async () => {
    const replies = [reply('reply-1', 'only one', 1788500001)];
    mocks.tenantRequest.mockImplementation(async (opts: any) => {
      if (opts.url.endsWith('/comments/batch_query')) {
        return {
          code: 0,
          data: {
            items: [{ comment_id: COMMENT_ID, has_more: false, reply_list: { replies } }],
          },
        };
      }
      throw new Error(`should not fetch replies: ${opts.url}`);
    });

    const comment = await getDocComment('app-test', FILE, COMMENT_ID);
    expect(comment!.replies).toHaveLength(1);
    expect(mocks.tenantRequest).toHaveBeenCalledTimes(1);
  });

  it('补全失败时退回截断结果并保留 hasMoreReplies 标记（不静默假装完整）', async () => {
    const first5 = [1, 2, 3, 4, 5].map(i => reply(`reply-${i}`, `msg ${i}`, 1788500000 + i));
    mocks.tenantRequest.mockImplementation(async (opts: any) => {
      if (opts.url.endsWith('/comments/batch_query')) return truncatedBatchQuery(first5);
      throw new Error('replies endpoint down');
    });
    // 补全走 preferTenant，tenant 失败会回退 user 身份 —— 让 user 也失败。
    mocks.resolveUserToken.mockResolvedValue(null);

    const comment = await getDocComment('app-test', FILE, COMMENT_ID);
    expect(comment!.replies).toHaveLength(5);
    expect(comment!.hasMoreReplies).toBe(true);
  });
});

/**
 * 事件派发里的触发回复解析：源码形状钉死。
 * 这段逻辑深埋在 handleDocCommentEvent 中间（前面有订阅解析、open_id 探针、
 * 网络拉评论），单测起来要 mock 整条链路；这里按仓库已有做法直接钉源码形状，
 * 保证那个会导致长 thread 永久失联的静默回退不会被改回来。
 */
describe('handleDocCommentEvent 触发回复解析（源码形状）', () => {
  const dispatcherSrc = readFileSync(new URL('../src/im/lark/event-dispatcher.ts', import.meta.url), 'utf-8');
  const region = (() => {
    const start = dispatcherSrc.indexOf('const trigger = parsed.replyId');
    expect(start).toBeGreaterThan(-1);
    return dispatcherSrc.slice(start, dispatcherSrc.indexOf('const triggerIndex', start));
  })();

  it('事件带 reply_id 时不再回退到 replies 的最后一条', () => {
    expect(region).toContain('comment.replies.find(r => r.replyId === parsed.replyId)');
    // 这个 `??` 回退正是 bug 本体：找不到就拿老回复顶上。
    expect(region).not.toContain('?? comment.replies[comment.replies.length - 1]');
  });

  it('找不到触发回复时告警并丢弃本条，而不是静默用错的回复继续', () => {
    expect(region).toContain('if (!trigger) {');
    expect(region).toContain('logger.warn(');
    expect(region).toContain('return;');
    // 告警要带上「回复串是否被截断」，否则线上无法区分是分页截断还是别的原因。
    expect(region).toContain('comment.hasMoreReplies');
  });
});

/**
 * 轮询链路（listDocComments）的补全语义，与事件链路**故意不同**：这里补全失败
 * 必须抛错，绝不能降级返回截断结果。
 */
describe('listDocComments: 轮询链路补全失败必须抛错', () => {
  beforeEach(() => {
    mocks.tenantRequest.mockReset();
    mocks.resolveUserToken.mockReset().mockResolvedValue(null);
    mocks.warn.mockReset();
    mocks.info.mockReset();
  });

  function listResponse(items: unknown[]) {
    return { code: 0, data: { items, has_more: false } };
  }

  it('补全成功时把截断的评论补齐（轮询链路也接上了，不只事件链路）', async () => {
    const first5 = [1, 2, 3, 4, 5].map(i => reply(`reply-${i}`, `msg ${i}`, 1788500000 + i));
    const all11 = Array.from({ length: 11 }, (_, i) => reply(`reply-${i + 1}`, `msg ${i + 1}`, 1788500000 + i + 1));

    mocks.tenantRequest.mockImplementation(async (opts: any) => {
      if (opts.url.endsWith('/comments')) {
        return listResponse([{ comment_id: COMMENT_ID, has_more: true, reply_list: { replies: first5 } }]);
      }
      if (opts.url.includes('/replies')) return { code: 0, data: { items: all11, has_more: false } };
      throw new Error(`unexpected ${opts.url}`);
    });

    const comments = await listDocComments('app-test', FILE);
    expect(comments).toHaveLength(1);
    expect(comments[0].replies).toHaveLength(11);
    expect(comments[0].hasMoreReplies).toBe(false);
  });

  it('补全失败时抛错，不返回截断结果', async () => {
    const first5 = [1, 2, 3, 4, 5].map(i => reply(`reply-${i}`, `msg ${i}`, 1788500000 + i));
    mocks.tenantRequest.mockImplementation(async (opts: any) => {
      if (opts.url.endsWith('/comments')) {
        return listResponse([{ comment_id: COMMENT_ID, has_more: true, reply_list: { replies: first5 } }]);
      }
      throw new Error('replies endpoint down');
    });

    await expect(listDocComments('app-test', FILE)).rejects.toThrow();
  });

  /**
   * 回归：补全失败若降级返回截断结果，游标会按截断的回复数推进，后续回复永久漏投。
   *
   * 复现序列（游标是**全文档所有回复拉平后**的单一游标，见 flattenDocCommentReplies）：
   *   轮 1：补全成功 → 看到 11 条 → 游标推到 reply-11
   *   轮 2：补全失败 →（若降级）只看到 5 条 → 全部 ≤ 游标 → fresh 为空
   *          此时新到的 reply-12 在截断响应里根本不存在，且游标已在 11 不会回退
   *          → reply-12 永久不投
   * 抛错则 daemon 的 per-sub try/catch 跳过本轮、游标不动、下轮重试。
   */
  it('回归：补全失败必须让整轮 poll 失败，而不是让游标基于 5 条回复推进', async () => {
    const first5 = [1, 2, 3, 4, 5].map(i => reply(`reply-${i}`, `msg ${i}`, 1788500000 + i));
    const all11 = Array.from({ length: 11 }, (_, i) => reply(`reply-${i + 1}`, `msg ${i + 1}`, 1788500000 + i + 1));

    // 轮 1：补全成功，游标推到最后一条。
    mocks.tenantRequest.mockImplementation(async (opts: any) => {
      if (opts.url.endsWith('/comments')) {
        return listResponse([{ comment_id: COMMENT_ID, has_more: true, reply_list: { replies: first5 } }]);
      }
      if (opts.url.includes('/replies')) return { code: 0, data: { items: all11, has_more: false } };
      throw new Error(`unexpected ${opts.url}`);
    });
    const round1 = await listDocComments('app-test', FILE);
    const cursor = latestDocCommentPollCursor(round1)!;
    expect(cursor.replyId).toBe('reply-11');

    // 轮 2：补全失败。抛错 ⇒ 调用方拿不到任何 comments，游标不动。
    mocks.tenantRequest.mockImplementation(async (opts: any) => {
      if (opts.url.endsWith('/comments')) {
        return listResponse([{ comment_id: COMMENT_ID, has_more: true, reply_list: { replies: first5 } }]);
      }
      throw new Error('replies endpoint down');
    });
    await expect(listDocComments('app-test', FILE)).rejects.toThrow();

    // 反证：若当初降级返回了截断的 5 条，游标之后就什么都看不到了 ——
    // 而真实新回复 reply-12 恰恰在那个看不见的区间里，于是永久漏投。
    const degraded = [{ ...round1[0], replies: round1[0].replies.slice(0, 5) }];
    expect(docCommentRepliesAfterCursor(degraded, cursor)).toHaveLength(0);
  });

  it('分页游标不推进时不会死循环，超过页数上限抛错', async () => {
    const first5 = [1, 2, 3, 4, 5].map(i => reply(`reply-${i}`, `msg ${i}`, 1788500000 + i));
    let calls = 0;
    mocks.tenantRequest.mockImplementation(async (opts: any) => {
      if (opts.url.endsWith('/comments')) {
        return listResponse([{ comment_id: COMMENT_ID, has_more: true, reply_list: { replies: first5 } }]);
      }
      calls++;
      // 恒定 page_token：服务端 bug 的典型形态。
      return { code: 0, data: { items: [reply('reply-x', 'x', 1788500099)], has_more: true, page_token: 'stuck' } };
    });

    await expect(listDocComments('app-test', FILE)).rejects.toThrow(/页上限|游标未推进/);
    expect(calls).toBeLessThan(200); // 有界，不是死循环
  });
});

/**
 * 排序保险：`/replies` 的顺序是飞书**未承诺**的行为（文档既没声明排序也没给
 * 排序参数）。事件链路的 priorReplies 直接吃这个顺序且不自己排，所以补全后
 * 必须由我们自己排一次，不能只把「实测同序」写在注释里。
 */
describe('hydrate 后按 createdAt 升序排序（不信任 API 顺序）', () => {
  beforeEach(() => {
    mocks.tenantRequest.mockReset();
    mocks.resolveUserToken.mockReset().mockResolvedValue(null);
    mocks.warn.mockReset();
    mocks.info.mockReset();
  });

  function hydrateWith(items: unknown[]) {
    const first5 = [1, 2, 3, 4, 5].map(i => reply(`reply-${i}`, `msg ${i}`, 1788500000 + i));
    mocks.tenantRequest.mockImplementation(async (opts: any) => {
      if (opts.url.endsWith('/comments/batch_query')) return truncatedBatchQuery(first5);
      if (opts.url.includes('/replies')) return { code: 0, data: { items, has_more: false } };
      throw new Error(`unexpected ${opts.url}`);
    });
    return getDocComment('app-test', FILE, COMMENT_ID);
  }

  it('端点若返回降序，补全结果仍是升序', async () => {
    const descending = [5, 4, 3, 2, 1].map(i => reply(`reply-${i}`, `msg ${i}`, 1788500000 + i));
    const comment = await hydrateWith(descending);
    expect(comment!.replies.map(r => r.replyId)).toEqual(['reply-1', 'reply-2', 'reply-3', 'reply-4', 'reply-5']);
  });

  it('create_time 同秒并列时按 replyId 数值序（非字典序）稳定排', async () => {
    // 同一秒内的三条回复，reply_id 长度不同 —— 字典序会把 '710' 排到 '99' 前面。
    const sameSecond = [
      { ...reply('7681633934731430857', 'c', 1788500001) },
      { ...reply('999', 'a', 1788500001) },
      { ...reply('7681622822946343898', 'b', 1788500001) },
    ];
    const comment = await hydrateWith(sameSecond);
    expect(comment!.replies.map(r => r.replyId)).toEqual([
      '999',
      '7681622822946343898',
      '7681633934731430857',
    ]);
  });

  it('正常拉完最后一页不会被误判成分页死循环', async () => {
    // 每页 1 条、共 3 页正常结束：不能因为翻了页就抛错。
    const first5 = [1, 2, 3, 4, 5].map(i => reply(`reply-${i}`, `msg ${i}`, 1788500000 + i));
    let page = 0;
    mocks.tenantRequest.mockImplementation(async (opts: any) => {
      if (opts.url.endsWith('/comments/batch_query')) return truncatedBatchQuery(first5);
      page++;
      const last = page >= 3;
      return {
        code: 0,
        data: {
          items: [reply(`reply-${page}`, `msg ${page}`, 1788500000 + page)],
          has_more: !last,
          page_token: last ? undefined : `cursor-${page}`,
        },
      };
    });
    const comment = await getDocComment('app-test', FILE, COMMENT_ID);
    expect(comment!.replies).toHaveLength(3);
    expect(comment!.hasMoreReplies).toBe(false);
  });
});
