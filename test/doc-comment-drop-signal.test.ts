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
  const region = (() => {
    const start = src.indexOf('async function processCommentEvent');
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('const LARK_WS_PROXY_ENV_KEYS', start));
  })();

  it('「取不到评论内容」和「触发回复不在回复里」两处都打标记', () => {
    expect(region.match(/await markCommentEventDropped\(/g) ?? []).toHaveLength(2);
  });

  it('自触发过滤不打标记（那是 bot 自己的回复，打了是自己标自己）', () => {
    const selfFilter = region.slice(
      region.indexOf('const selfBotOpenId = getBot(larkAppId).botOpenId;'),
      region.indexOf('// 4) 触发范围闸'),
    );
    expect(selfFilter).not.toContain('markCommentEventDropped');
  });

  it('mention-only 未 @ 本 bot 不打标记（压根不该触发，打了是在别人评论上留噪音）', () => {
    const gate = region.slice(
      region.indexOf('if (!commentTriggerAllowed('),
      region.indexOf('const text = trigger.text.trim();'),
    );
    expect(gate).not.toContain('markCommentEventDropped');
  });
});
