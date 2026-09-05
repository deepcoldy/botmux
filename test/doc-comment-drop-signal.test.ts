import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1260：文档评论事件被丢弃时给触发回复打 ❌，让「这条 @ 我没能处理」看得见。
 *
 * 背景：事件已 ACK ⇒ 飞书不重投；mention-only 订阅不进轮询（poller 只收
 * commentTriggerMode==='all'）⇒ 没有兜底。所以事件链路一丢就是终点，而用户侧
 * 原本零感知 —— doc 发起的会话在飞书整个不可见，只能去 dashboard 翻 terminal。
 */

const mocks = vi.hoisted(() => ({
  addCommentReaction: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../src/im/lark/doc-comment.js', () => ({
  addCommentReaction: mocks.addCommentReaction,
  getDocComment: vi.fn(),
  isBotAuthoredReply: vi.fn(() => false),
  hasBotSentinel: vi.fn(() => false),
  commentTriggerAllowed: vi.fn(() => true),
  BOT_REPLY_SENTINEL: '​',
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: mocks.debug, error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const FILE = { fileToken: 'DocToken1234567890123456', fileType: 'docx' };
const COMMENT_ID = '7681622822925421500';
const REPLY_ID = '7681633934731430857';

describe('markCommentEventDropped: 丢弃事件在文档里留下可见标记', () => {
  let markCommentEventDropped: (
    larkAppId: string,
    file: { fileToken: string; fileType: string },
    commentId: string,
    replyId: string | undefined,
  ) => Promise<void>;

  beforeEach(async () => {
    mocks.addCommentReaction.mockReset().mockResolvedValue('reaction-1');
    mocks.debug.mockReset();
    ({ __testOnly_markCommentEventDropped: markCommentEventDropped } =
      await import('../src/im/lark/event-dispatcher.js'));
  });

  it('给触发回复打 ERROR reaction（用飞书文档里确实存在的 emoji_type）', async () => {
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID);

    expect(mocks.addCommentReaction).toHaveBeenCalledTimes(1);
    const [appId, file, commentId, replyId, emoji] = mocks.addCommentReaction.mock.calls[0];
    expect(appId).toBe('app-test');
    expect(file).toEqual(FILE);
    expect(commentId).toBe(COMMENT_ID);
    expect(replyId).toBe(REPLY_ID);
    // 'ERROR' 在飞书 emoji_type 表里；写错的 key 会静默不显示，那就白打了。
    expect(emoji).toBe('ERROR');
  });

  /**
   * 这个 ❌ 是**终态**标记、故意不清理。若以授权用户身份落上去，就是在用户自己的
   * 评论上、以用户自己的名义、永久挂一个叉 —— 错误主体的持久写入比没有标记更糟。
   * 对比 Typing：成对、几秒后必被清掉，回退 user 只是短暂误导，故仍用 preferTenant。
   */
  it('必须 tenantOnly —— 绝不以授权用户身份留下永久标记', async () => {
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID);
    const opts = mocks.addCommentReaction.mock.calls[0][5];
    expect(opts).toMatchObject({ tenantOnly: true });
  });

  it('reply_id 缺失时不发请求（reaction 端点要求 comment_id + reply_id 齐全）', async () => {
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, undefined);
    expect(mocks.addCommentReaction).not.toHaveBeenCalled();
  });

  it('打标记失败不外抛 —— 丢弃路径本身已经是失败路径，不能再被它拖垮', async () => {
    mocks.addCommentReaction.mockRejectedValue(new Error('reaction endpoint down'));
    await expect(markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID)).resolves.toBeUndefined();
    expect(mocks.debug).toHaveBeenCalled();
  });
});

/**
 * 接线点用源码形状钉住：processCommentEvent 没有导出，且要跑通它得 mock 订阅表、
 * open_id 探针、审计通知等整条链路。这里按仓库已有做法钉源码形状，保证标记被接在
 * **该接的那两个丢弃点**上，且**没有**被接到不该打的那几个上。
 */
describe('processCommentEvent 的接线点（源码形状）', () => {
  const src = readFileSync(new URL('../src/im/lark/event-dispatcher.ts', import.meta.url), 'utf-8');

  /**
   * 取源码区间。**每个锚点都必须先断言找得到** —— `indexOf` 找不到返回 -1，
   * `slice(-1, n)` 会静默给出空串，下面的 `not.toContain` 就必然通过，测试变成
   * 永远绿的空断言。而这几条负向断言的全部价值就是「防止后续有人把标记顺手扩大
   * 到所有 return」，假绿等于没测。
   */
  function regionBetween(startAnchor: string, endAnchor: string, from = 0): string {
    const start = src.indexOf(startAnchor, from);
    expect(start, `锚点失效（源码已变动？）: ${startAnchor}`).toBeGreaterThan(-1);
    const end = src.indexOf(endAnchor, start);
    expect(end, `锚点失效（源码已变动？）: ${endAnchor}`).toBeGreaterThan(-1);
    return src.slice(start, end);
  }

  const region = regionBetween('async function processCommentEvent', 'const LARK_WS_PROXY_ENV_KEYS');

  it('三个该打的丢弃点都接上了：拉不到评论 / 触发回复不在回复里 / 纯 @bot 无正文', () => {
    expect(region.match(/await markCommentEventDropped\(/g) ?? []).toHaveLength(3);
  });

  it('第一个打点（拉不到评论内容）必须收窄，不能在别人的评论上打标记', () => {
    const firstDrop = regionBetween('取不到评论内容', 'const trigger = parsed.replyId');
    // mention-only 下拉不到正文时无从判断是不是冲 bot 来的，只能靠 is_mentioned 收紧。
    expect(firstDrop).toContain(`sub.commentTriggerMode !== 'mention-only' || parsed.isMentioned`);
  });

  it('自触发过滤不打标记（那是 bot 自己的回复，打了是自己标自己）', () => {
    const selfFilter = regionBetween(
      'const selfBotOpenId = getBot(larkAppId).botOpenId;',
      '// 4) 触发范围闸',
    );
    expect(selfFilter).not.toContain('markCommentEventDropped');
  });

  it('mention-only 未 @ 本 bot 不打标记（压根不该触发，打了是在别人评论上留噪音）', () => {
    const gate = regionBetween(
      'if (!commentTriggerAllowed(',
      'const text = trigger.text.trim();',
    );
    expect(gate).not.toContain('markCommentEventDropped');
  });
});
