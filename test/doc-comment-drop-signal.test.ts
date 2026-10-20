import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../src/i18n/index.js';

/**
 * #1260：文档评论事件被丢弃时给触发回复打 ❌，让「这条 @ 我没能处理」看得见。
 *
 * 背景：事件已 ACK ⇒ 飞书不重投。通过 @/审计门的投递现在有持久 pending；
 * 但本文件覆盖的是更早、连安全投递上下文都构造不出的失败，所以仍是终点。用户侧
 * 原本零感知 —— doc 发起的会话在飞书整个不可见，只能去 dashboard 翻 terminal。
 */

const mocks = vi.hoisted(() => ({
  events: {} as Record<string, (data: unknown) => void>,
  addCommentReactionChecked: vi.fn(),
  isBotAuthoredReply: vi.fn(() => false),
  getDocComment: vi.fn(),
  getOwnerOpenId: vi.fn(() => 'ou_owner'),
  getBot: vi.fn(() => ({ botOpenId: 'ou_selfbot', config: {} })),
  sendUserMessage: vi.fn(),
  getDocSubscription: vi.fn(),
  putDocSubscription: vi.fn(),
  removeDocSubscription: vi.fn(),
  settleDocCommentWsDelivery: vi.fn(),
  recordDocWatchActivity: vi.fn(),
  handleDocComment: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  rollback: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  EventDispatcher: class {
    register(events: typeof mocks.events) {
      mocks.events = events;
      return this;
    }
  },
}));

vi.mock('../src/im/lark/transport/connection.js', () => ({ startLarkConnection: vi.fn() }));

vi.mock('../src/im/lark/doc-comment.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addCommentReactionChecked: mocks.addCommentReactionChecked,
  addCommentReaction: vi.fn(),
  getDocComment: mocks.getDocComment,
  isBotAuthoredReply: mocks.isBotAuthoredReply,
  fetchDocTitle: vi.fn(async () => undefined),
}));

vi.mock('../src/services/doc-subs-store.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDocSubscription: mocks.getDocSubscription,
  putDocSubscription: mocks.putDocSubscription,
  removeDocSubscription: mocks.removeDocSubscription,
  settleDocCommentWsDelivery: mocks.settleDocCommentWsDelivery,
  recordDocWatchActivity: mocks.recordDocWatchActivity,
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

  /**
   * 失败标记给 owner 的通知必须是「事件未处理」文案；退回审计门默认的 'reply' 文案
   * 就是 180f2b4 修掉的「失败通知谎称已触发回复」。
   */
  it('非 owner 触发失败标记时，owner 收到的是「未处理」通知而不是「已触发回复」', async () => {
    await markCommentEventDropped('app-test', FILE, COMMENT_ID, REPLY_ID, 'ou_someone_else', 'summary', mocks.rollback);
    const text = String(mocks.sendUserMessage.mock.calls[0]?.[2]);
    const locales = ['zh', 'en'] as const;
    expect(locales.some(loc => text.startsWith(t('daemon.doc_dropped_notify_title', undefined, loc)))).toBe(true);
    for (const loc of locales) expect(text).not.toContain(t('daemon.doc_mention_notify_title', undefined, loc));
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
 * processCommentEvent 本身没有导出：经 startLarkEventDispatcher 注册的
 * drive.notice.comment_add_v1 处理器真实跑一遍（订阅表、拉评论、通知、投递都 mock），
 * 断言三个丢弃点的 ❌、auto-sub 回滚、结局记录与 WS 投递的 settle。
 */
describe('processCommentEvent：丢弃点的失败标记、auto-sub 回滚与投递结局', () => {
  const BOT = 'ou_selfbot';
  const STRANGER = 'ou_stranger';
  const APP = 'app-drop-signal';

  const thread = (author: string, text: string, mentions: string[], replyId = REPLY_ID) => ({
    commentId: COMMENT_ID, isWhole: false, isSolved: false,
    replies: [{ replyId, userId: author, text, mentions }],
  });
  const subscription = (commentTriggerMode: 'mention-only' | 'all') => ({
    fileToken: FILE.fileToken, fileType: 'docx', ownerOpenId: OWNER,
    sessionAnchor: `doc:${FILE.fileToken}`, commentTriggerMode, docTitle: 'Doc',
  });
  const dispatch = async (opts: { isMentioned?: boolean; operator?: string } = {}) => {
    mocks.events['drive.notice.comment_add_v1']({
      comment_id: COMMENT_ID,
      reply_id: REPLY_ID,
      is_mentioned: opts.isMentioned ?? true,
      notice_meta: {
        file_token: FILE.fileToken, file_type: 'docx', notice_type: 'add_reply',
        to_user_id: { open_id: BOT }, from_user_id: { open_id: opts.operator ?? OWNER },
      },
    });
    await vi.advanceTimersByTimeAsync(1);
  };
  const outcomes = () => mocks.recordDocWatchActivity.mock.calls.map(call => call[3].outcome);

  /** 三个会打 ❌ 的丢弃点：拉不到评论 / 触发回复不在拉到的回复里（分页截断）/ 纯 @bot 无正文。 */
  const DROPS = {
    'no-comment': () => null,
    'trigger-missing': () => thread(OWNER, '请整理这一段', [BOT], 'reply-outside-fetched-page'),
    'empty-text': () => thread(OWNER, '', [BOT]),
  } as const;

  beforeEach(async () => {
    vi.useFakeTimers();
    for (const fn of Object.values(mocks)) if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
    mocks.getOwnerOpenId.mockReturnValue(OWNER);
    mocks.getBot.mockReturnValue({ botOpenId: BOT, config: {} });
    mocks.isBotAuthoredReply.mockReturnValue(false);
    mocks.sendUserMessage.mockResolvedValue('om_notice');
    mocks.addCommentReactionChecked.mockResolvedValue({ ok: true });
    mocks.getDocSubscription.mockReturnValue(subscription('mention-only'));
    mocks.handleDocComment.mockResolvedValue(true);
    const dispatcher = await import('../src/im/lark/event-dispatcher.js');
    dispatcher.__resetEventClaimsForTest();
    dispatcher.startLarkEventDispatcher(APP, 'test-secret', {
      handleDocComment: mocks.handleDocComment,
    } as unknown as import('../src/im/lark/event-dispatcher.js').EventHandlers);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(Object.keys(DROPS) as (keyof typeof DROPS)[])(
    'mention-only 下确实 @ 了 bot 的 %s 丢弃：给触发回复打 ❌、不投递、记对应结局',
    async drop => {
      mocks.getDocComment.mockResolvedValue(DROPS[drop]());
      await dispatch();
      expect(mocks.addCommentReactionChecked).toHaveBeenCalledWith(
        APP, FILE, COMMENT_ID, REPLY_ID, 'ERROR', { tenantOnly: true },
      );
      expect(mocks.handleDocComment).not.toHaveBeenCalled();
      expect(outcomes()).toEqual([drop]);
    },
  );

  it.each([
    ['no-comment', 'all', true],
    ['no-comment', 'mention-only', false],
    ['trigger-missing', 'all', true],
    ['trigger-missing', 'mention-only', false],
    ['empty-text', 'all', true],
  ] as const)('%s 丢弃在 %s / is_mentioned=%s 下不打 ❌（\'all\' 有轮询兜底，没 @ 的不是找 bot 的）', async (drop, mode, isMentioned) => {
    mocks.getDocSubscription.mockReturnValue(subscription(mode));
    mocks.getDocComment.mockResolvedValue(DROPS[drop]());
    await dispatch({ isMentioned });
    expect(mocks.addCommentReactionChecked).not.toHaveBeenCalled();
    expect(mocks.handleDocComment).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([drop]);
  });

  // 不打 ❌ 的早退：未过审计就结束，本次新建的 auto-sub 占位必须回滚；而既有订阅（用户
  // /watch-comment 建的）在任何早退里都绝不能被删。
  const UNMARKED_EXITS = {
    'self-authored': { comment: () => thread(BOT, '机器人自己的回复', [BOT]), isMentioned: true, operator: BOT },
    'not-mentioned': { comment: () => thread(STRANGER, '@ 了同事', ['ou_colleague']), isMentioned: true, operator: STRANGER },
    'no-comment': { comment: () => null, isMentioned: false, operator: STRANGER },
    'trigger-missing': { comment: DROPS['trigger-missing'], isMentioned: false, operator: STRANGER },
  } as const;

  it.each(Object.keys(UNMARKED_EXITS) as (keyof typeof UNMARKED_EXITS)[])(
    '%s 早退不打 ❌，只回滚本次新建的 auto-sub',
    async exit => {
      const { comment, isMentioned, operator } = UNMARKED_EXITS[exit];
      mocks.getDocSubscription.mockReturnValue(undefined);
      mocks.getDocComment.mockResolvedValue(comment());
      await dispatch({ isMentioned, operator });
      expect(mocks.addCommentReactionChecked).not.toHaveBeenCalled();
      expect(mocks.removeDocSubscription).toHaveBeenCalledTimes(1);
      expect(mocks.removeDocSubscription).toHaveBeenCalledWith(expect.any(String), APP, FILE.fileToken);
      expect(outcomes()).toEqual([exit]);
    },
  );

  it.each([...Object.keys(UNMARKED_EXITS), 'audit-rejected'])('%s 早退绝不删除既有订阅', async exit => {
    if (exit === 'audit-rejected') {
      mocks.getDocComment.mockResolvedValue(thread(STRANGER, '帮我改一下', [BOT]));
      mocks.sendUserMessage.mockRejectedValue(new Error('DM unavailable'));
      await dispatch({ operator: STRANGER });
    } else {
      const { comment, isMentioned, operator } = UNMARKED_EXITS[exit as keyof typeof UNMARKED_EXITS];
      mocks.getDocComment.mockResolvedValue(comment());
      await dispatch({ isMentioned, operator });
    }
    expect(mocks.handleDocComment).not.toHaveBeenCalled();
    expect(mocks.removeDocSubscription).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([exit]);
  });

  it('陌生人 @ 出来的 auto-sub 占位带溯源字段', async () => {
    mocks.getDocSubscription.mockReturnValue(undefined);
    mocks.getDocComment.mockResolvedValue(thread(STRANGER, '帮我改一下', [BOT]));
    await dispatch({ operator: STRANGER });
    expect(mocks.putDocSubscription).toHaveBeenCalledWith(expect.any(String), APP, expect.objectContaining({
      commentTriggerMode: 'mention-only', autoCreated: true, autoCreatedBy: STRANGER,
    }));
  });

  it('事件 reply_id 命中较早的回复时投递那一条，而不是 thread 最后一条', async () => {
    mocks.getDocComment.mockResolvedValue({
      ...thread(OWNER, '第一条：请整理', [BOT]),
      replies: [
        { replyId: REPLY_ID, userId: OWNER, text: '第一条：请整理', mentions: [BOT] },
        { replyId: 'later-reply', userId: OWNER, text: '后来的回复', mentions: [BOT] },
      ],
    });
    await dispatch();
    expect(mocks.handleDocComment).toHaveBeenCalledWith(expect.objectContaining({
      replyId: REPLY_ID, text: '第一条：请整理',
    }));
  });

  it.each([
    ['接纳', () => mocks.handleDocComment.mockResolvedValue(true), true],
    ['未接纳', () => mocks.handleDocComment.mockResolvedValue(false), false],
    ['抛错', () => mocks.handleDocComment.mockRejectedValue(new Error('daemon down')), false],
  ] as const)('WS 投递%s时先 settle 持久重试，只有真接纳才记 dispatched', async (_label, arrange, accepted) => {
    arrange();
    mocks.getDocComment.mockResolvedValue(thread(OWNER, '请整理这一段', [BOT]));
    await dispatch();
    expect(mocks.handleDocComment).toHaveBeenCalledTimes(1);
    expect(mocks.settleDocCommentWsDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.settleDocCommentWsDelivery).toHaveBeenCalledWith(
      expect.any(String), APP, FILE.fileToken,
      expect.objectContaining({ commentId: COMMENT_ID, replyId: REPLY_ID, text: '请整理这一段' }),
      accepted,
    );
    expect(outcomes()).toEqual(accepted ? ['dispatched'] : []);
  });
});
