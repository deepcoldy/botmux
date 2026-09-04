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

import { getDocComment } from '../src/im/lark/doc-comment.js';

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
