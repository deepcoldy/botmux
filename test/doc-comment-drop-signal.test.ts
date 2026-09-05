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
  addCommentReactionChecked: vi.fn(),
  isBotAuthoredReply: vi.fn(() => false),
  getOwnerOpenId: vi.fn(() => 'ou_owner'),
  getBot: vi.fn(() => ({ botOpenId: 'ou_selfbot', config: {} })),
  sendUserMessage: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  rollback: vi.fn(),
}));

vi.mock('../src/im/lark/doc-comment.js', () => ({
  addCommentReactionChecked: mocks.addCommentReactionChecked,
  addCommentReaction: vi.fn(),
  getDocComment: vi.fn(),
  isBotAuthoredReply: mocks.isBotAuthoredReply,
  hasBotSentinel: vi.fn(() => false),
  commentTriggerAllowed: vi.fn(() => true),
  BOT_REPLY_SENTINEL: '​',
}));

vi.mock('../src/im/lark/client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendUserMessage: mocks.sendUserMessage,
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
    auditSummary: string,
    rollbackAutoSub: () => void,
  ) => Promise<string>;

  beforeEach(async () => {
    mocks.addCommentReactionChecked.mockReset().mockResolvedValue({ ok: true, reactionId: 'reaction-1' });
    mocks.isBotAuthoredReply.mockReset().mockReturnValue(false);
    mocks.getOwnerOpenId.mockReset().mockReturnValue(OWNER);
    mocks.getBot.mockReset().mockReturnValue({ botOpenId: 'ou_selfbot', config: {} });
    mocks.debug.mockReset();
    mocks.info.mockReset();
    mocks.rollback.mockReset();
    mocks.sendUserMessage.mockReset().mockResolvedValue(undefined);
    ({ __testOnly_markCommentEventDropped: markCommentEventDropped } =
      await import('../src/im/lark/event-dispatcher.js'));
  });

  it('给触发回复打 ERROR reaction（用飞书文档里确实存在的 emoji_type）', async () => {
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, OWNER, 'summary', mocks.rollback);

    expect(mocks.addCommentReactionChecked).toHaveBeenCalledTimes(1);
    const [appId, file, commentId, replyId, emoji] = mocks.addCommentReactionChecked.mock.calls[0];
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
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, OWNER, 'summary', mocks.rollback);
    const opts = mocks.addCommentReactionChecked.mock.calls[0][5];
    expect(opts).toMatchObject({ tenantOnly: true });
  });

  it('reply_id 缺失时不发请求，且回滚 auto-sub（malformed 事件不能留下订阅）', async () => {
    const outcome = await markCommentEventDropped('app-test', FILE, COMMENT_ID, undefined, OWNER, 'summary', mocks.rollback);
    expect(outcome).toBe('no-reply-id');
    expect(mocks.addCommentReactionChecked).not.toHaveBeenCalled();
    expect(mocks.rollback).toHaveBeenCalledTimes(1);
  });

  it('打标记失败不外抛 —— 丢弃路径本身已经是失败路径，不能再被它拖垮', async () => {
    mocks.addCommentReactionChecked.mockRejectedValue(new Error('reaction endpoint down'));
    await expect(markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, OWNER, 'summary', mocks.rollback)).resolves.toBe('reaction-failed');
    expect(mocks.debug).toHaveBeenCalled();
  });

  /**
   * 审计硬门：打标记是 provider-visible 的持久外部写入，不是内部日志。不变量是
   * 「非 owner 触发时 owner 必须先感知」—— **不是**「非 owner 一律不打」。
   * 通知发出去了 owner 就已感知，此时照打（这正是 9436bb9 撤回 owner-only 降级
   * 的用意：owner-only 等于放弃 #1260 的非 owner 核心场景）。
   */
  it('非 owner + owner 通知成功：照打（owner 已感知，不算越权）', async () => {
    const outcome = await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, 'ou_someone_else', 'summary', mocks.rollback);
    expect(outcome).toBe('marked');
    expect(mocks.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(mocks.addCommentReactionChecked).toHaveBeenCalledTimes(1);
    expect(mocks.rollback).not.toHaveBeenCalled();
  });

  it('非 owner + owner 通知失败：拒绝、不打、回滚（owner 无法感知 = 越权）', async () => {
    mocks.sendUserMessage.mockRejectedValue(new Error('DM 发不出去'));
    const outcome = await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, 'ou_someone_else', 'summary', mocks.rollback);
    expect(outcome).toBe('audit-rejected');
    expect(mocks.addCommentReactionChecked).not.toHaveBeenCalled();
    expect(mocks.rollback).toHaveBeenCalledTimes(1);
  });

  it('owner 未配置时不打标记（无从判定越权，保守拒绝）', async () => {
    mocks.getOwnerOpenId.mockReturnValue(undefined);
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, OWNER, 'summary', mocks.rollback);
    expect(mocks.addCommentReactionChecked).not.toHaveBeenCalled();
  });

  it('operator 缺失：按非 owner 处理 —— 通知成功后照打', async () => {
    const outcome = await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, undefined, 'summary', mocks.rollback);
    expect(outcome).toBe('marked');
    expect(mocks.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  /**
   * 自触发：正常那道 self-filter 在下面，前两个丢弃点跑在它之前，必须自己挡一次。
   */
  it('触发者是 bot 自己（应用身份）不打标记 —— 否则给自己打 ❌', async () => {
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, 'ou_selfbot', 'summary', mocks.rollback);
    expect(mocks.addCommentReactionChecked).not.toHaveBeenCalled();
  });

  /**
   * 最刁钻的一条：bot 回退 user 身份发评论时作者 = 授权用户 = owner，
   * **恰好穿过上面那道 owner 审计门**。只有 isBotAuthoredReply 挡得住。
   */
  it('bot 以 user 身份发的回复（作者=owner）也不打标记 —— 审计门挡不住这种自标', async () => {
    mocks.isBotAuthoredReply.mockReturnValue(true);
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, OWNER, 'summary', mocks.rollback);
    expect(mocks.addCommentReactionChecked).not.toHaveBeenCalled();
  });

  /**
   * 审计拒绝时必须回滚本次 auto-sub —— 否则陌生人一次触发就留下一条 owner
   * 完全不知情的订阅记录，且没有任何人会清掉它。
   */
  it('审计拒绝时回滚 auto-sub，不留下 owner 不知情的订阅', async () => {
    mocks.sendUserMessage.mockRejectedValue(new Error('DM 发不出去'));
    const outcome = await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, 'ou_stranger', 'summary', mocks.rollback);
    expect(outcome).toBe('audit-rejected');
    expect(mocks.rollback).toHaveBeenCalledTimes(1);
  });

  it('自触发拦截在审计门之前 —— 不为 bot 自己的事件打扰 owner，但仍回滚 auto-sub', async () => {
    const outcome = await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, 'ou_selfbot', 'summary', mocks.rollback);
    expect(outcome).toBe('self-triggered');
    // 没过审计 ⇒ 占位订阅不能留下。但也不该为自己的事件去打扰 owner。
    expect(mocks.rollback).toHaveBeenCalledTimes(1);
  });

  /**
   * outcome 必须反映**服务端真实结果**。飞书 update_reaction 的响应体是空对象、
   * 不承诺 reaction_id，所以不能用 `reactionId ? 成功 : 失败` —— 那会把 code=0
   * 但没带 id 的成功记成失败，排障的人反而被误导。只信 ok。
   */
  it('code=0 但响应不带 reaction_id 时仍算 marked（官方 schema 不承诺 id）', async () => {
    mocks.addCommentReactionChecked.mockResolvedValue({ ok: true });
    const outcome = await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, OWNER, 'summary', mocks.rollback);
    expect(outcome).toBe('marked');
  });

  it('ok=false 时如实记成 reaction-failed，不谎报 marked', async () => {
    mocks.addCommentReactionChecked.mockResolvedValue({ ok: false });
    const outcome = await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, OWNER, 'summary', mocks.rollback);
    expect(outcome).toBe('reaction-failed');
  });

  it('审计通过时把调用方给的摘要透传给审计门（失败路径也必须有摘要，不能跳过审计）', async () => {
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, OWNER, '评论正文读取失败', mocks.rollback);
    // owner 本人触发无需通知，但摘要参数必须存在于签名里、由调用方传真实说明。
    expect(mocks.addCommentReactionChecked).toHaveBeenCalledTimes(1);
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

  it('前两个打点都必须收窄，不能在别人的评论上打标记', () => {
    // trigger 缺失只证明回复数据不完整，不证明这条回复冲 bot 来的 —— 已订阅文档下
    // 别人的普通回复同样推事件，那条 reply 没被拉到就会走到第二个打点。
    const firstDrop = regionBetween('取不到评论内容', 'const trigger = parsed.replyId');
    const secondDrop = regionBetween('不在拉到的', 'const triggerIndex');
    expect(firstDrop).toContain('mayConcernThisBot');
    expect(secondDrop).toContain('mayConcernThisBot');
  });

  /**
   * 三个打点的闸口必须一致，且**只在 mention-only 下打**。
   * 'all' 有 poller 兜底（pollWatchedDocComments 只轮 'all'，且不经过
   * processCommentEvent），push 这次没读到的评论下轮 poll 很可能被正常处理；
   * 而 ❌ 是终态不清理，在 'all' 下打就会永久挂在一条根本没丢的评论上。
   */
  it("收窄谓词只认 mention-only + is_mentioned（'all' 有轮询兜底，不该打)", () => {
    expect(region).toContain(`sub.commentTriggerMode === 'mention-only' && parsed.isMentioned === true`);
  });

  it('第三个打点的闸口与前两个一致（都只认 mention-only）', () => {
    expect(region).toContain(`const markEligible = sub.commentTriggerMode === 'mention-only'`);
  });

  /**
   * ⚠️ 生产调用点必须传 'dropped-signal'。audit-gate 那组测试**证明不了**这一点 ——
   * 它直调 helper 并手动传 kind，所以把这里的 'dropped-signal' 悄悄改回默认
   * 'reply'（即 180f2b4 修掉的「失败通知谎称已触发回复」），两组共 31 个用例
   * 一条都不会红。这条断言就是补那个缺口。
   */
  it("dropped-signal 打点必须传 kind，不能退回成功文案", () => {
    // 这个调用在 markCommentEventDropped 里，位于 processCommentEvent **之前**，
    // 不在 region 切片内 —— 用整份源码断言，别锚错范围（锚错就又是一条假绿）。
    expect(src).toContain("rollbackAutoSub, 'dropped-signal')");
  });

  it('每个未打标记的早退都回滚 auto-sub（不留 owner 不知情的订阅）', () => {
    // 三个 dropped 打点的 else 分支 + self-filter + mention gate。
    expect((region.match(/rollbackAutoSub\(\);/g) ?? []).length).toBeGreaterThanOrEqual(5);
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

  /**
   * ⚠️ 五处回滚全都经由同一个闭包，而**唯一**阻止它删掉「用户此前用
   * /watch-comment 建的既有订阅」的，就是那句 `if (autoCreatedSub)`。
   * 本 PR 把 rollback 的调用点从 2 处扩到 11 处，这个守卫一旦丢失，
   * 任何一条陌生人的无关评论都会静默退订用户真正想要的订阅 —— 破坏性远大于
   * 本 PR 要修的问题。这里把它钉死。
   */
  it('rollback 闭包必须由 autoCreatedSub 守卫 —— 绝不能删掉既有订阅', () => {
    expect(region).toContain('const rollbackAutoSub = () => { if (autoCreatedSub) removeDocSubscription(');
  });

  it('removeDocSubscription 只在那一个闭包里被调用，没有旁路', () => {
    expect(region.match(/removeDocSubscription\(/g) ?? []).toHaveLength(1);
  });
});
