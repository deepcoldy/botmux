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
  isBotAuthoredReply: vi.fn(() => false),
  getOwnerOpenId: vi.fn(() => 'ou_owner'),
  getBot: vi.fn(() => ({ botOpenId: 'ou_selfbot', config: {} })),
  debug: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../src/im/lark/doc-comment.js', () => ({
  addCommentReaction: mocks.addCommentReaction,
  getDocComment: vi.fn(),
  isBotAuthoredReply: mocks.isBotAuthoredReply,
  hasBotSentinel: vi.fn(() => false),
  commentTriggerAllowed: vi.fn(() => true),
  BOT_REPLY_SENTINEL: '​',
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: mocks.debug, error: vi.fn(), info: mocks.info, warn: vi.fn() },
}));

vi.mock('../src/bot-registry.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOpenId: mocks.getOwnerOpenId,
  getBot: mocks.getBot,
}));

const FILE = { fileToken: 'DocToken1234567890123456', fileType: 'docx' };
const COMMENT_ID = '7681622822925421500';
const REPLY_ID = '7681633934731430857';
const OWNER = 'ou_owner';

describe('markCommentEventDropped: 丢弃事件在文档里留下可见标记', () => {
  let markCommentEventDropped: (
    larkAppId: string,
    file: { fileToken: string; fileType: string },
    commentId: string,
    replyId: string | undefined,
    requesterOpenId: string | undefined,
  ) => Promise<void>;

  beforeEach(async () => {
    mocks.addCommentReaction.mockReset().mockResolvedValue('reaction-1');
    mocks.isBotAuthoredReply.mockReset().mockReturnValue(false);
    mocks.getOwnerOpenId.mockReset().mockReturnValue(OWNER);
    mocks.getBot.mockReset().mockReturnValue({ botOpenId: 'ou_selfbot', config: {} });
    mocks.debug.mockReset();
    mocks.info.mockReset();
    ({ __testOnly_markCommentEventDropped: markCommentEventDropped } =
      await import('../src/im/lark/event-dispatcher.js'));
  });

  it('给触发回复打 ERROR reaction（用飞书文档里确实存在的 emoji_type）', async () => {
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, OWNER);

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
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, OWNER);
    const opts = mocks.addCommentReaction.mock.calls[0][5];
    expect(opts).toMatchObject({ tenantOnly: true });
  });

  it('reply_id 缺失时不发请求（reaction 端点要求 comment_id + reply_id 齐全）', async () => {
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, undefined, OWNER);
    expect(mocks.addCommentReaction).not.toHaveBeenCalled();
  });

  it('打标记失败不外抛 —— 丢弃路径本身已经是失败路径，不能再被它拖垮', async () => {
    mocks.addCommentReaction.mockRejectedValue(new Error('reaction endpoint down'));
    await expect(markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, OWNER)).resolves.toBeUndefined();
    expect(mocks.debug).toHaveBeenCalled();
  });

  /**
   * 审计硬门：打标记是 provider-visible 的持久外部写入，不是内部日志。既有不变量
   * 是「非 owner 触发时 owner 无法感知 = 越权」。这些丢弃点全在那道门之前，且前两处
   * 读不到正文、构造不出门要发的通知，所以取保守侧：只有 owner 本人触发才打。
   */
  it('非 owner 触发不打标记（不能绕过审计硬门做外部写入）', async () => {
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, 'ou_someone_else');
    expect(mocks.addCommentReaction).not.toHaveBeenCalled();
  });

  it('owner 未配置时不打标记（无从判定越权，保守拒绝）', async () => {
    mocks.getOwnerOpenId.mockReturnValue(undefined);
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, OWNER);
    expect(mocks.addCommentReaction).not.toHaveBeenCalled();
  });

  it('operator 缺失时不打标记（判不出是谁触发的）', async () => {
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, undefined);
    expect(mocks.addCommentReaction).not.toHaveBeenCalled();
  });

  /**
   * 自触发：正常那道 self-filter 在下面，前两个丢弃点跑在它之前，必须自己挡一次。
   */
  it('触发者是 bot 自己（应用身份）不打标记 —— 否则给自己打 ❌', async () => {
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, 'ou_selfbot');
    expect(mocks.addCommentReaction).not.toHaveBeenCalled();
  });

  /**
   * 最刁钻的一条：bot 回退 user 身份发评论时作者 = 授权用户 = owner，
   * **恰好穿过上面那道 owner 审计门**。只有 isBotAuthoredReply 挡得住。
   */
  it('bot 以 user 身份发的回复（作者=owner）也不打标记 —— 审计门挡不住这种自标', async () => {
    mocks.isBotAuthoredReply.mockReturnValue(true);
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, OWNER);
    expect(mocks.addCommentReaction).not.toHaveBeenCalled();
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
    // 锚在 processCommentEvent 里的那段注释上 —— helper 内部也有个 selfBotOpenId
    // 声明（它自己挡了一次自触发），直接锚变量名会命中 helper、把区间撑到整个文件。
    const selfFilter = regionBetween(
      '// 3) 自触发过滤（防死循环）',
      '// 4) 触发范围闸',
    );
    expect(selfFilter).not.toMatch(/markCommentEventDropped\(/);
  });

  it('mention-only 未 @ 本 bot 不打标记（压根不该触发，打了是在别人评论上留噪音）', () => {
    const gate = regionBetween(
      'if (!commentTriggerAllowed(',
      'const text = trigger.text.trim();',
    );
    expect(gate).not.toMatch(/markCommentEventDropped\(/);
  });
});
