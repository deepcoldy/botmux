import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  events: {} as Record<string, (data: unknown) => void>,
  getDocComment: vi.fn(),
  sendUserMessage: vi.fn(),
  putDocSubscription: vi.fn(),
  removeDocSubscription: vi.fn(),
  settleDocCommentWsDelivery: vi.fn(),
  addCommentReactionChecked: vi.fn(),
  getDocSubscription: vi.fn(),
  handleDocComment: vi.fn(),
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
vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBot: vi.fn(() => ({
    botOpenId: 'ou_comment_bot',
    config: { larkAppId: 'app-comment-identity', lang: 'zh' },
  })),
  getOwnerOpenId: vi.fn(() => 'ou_comment_owner'),
}));
vi.mock('../src/im/lark/client.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendUserMessage: mocks.sendUserMessage,
}));
vi.mock('../src/im/lark/doc-comment.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDocComment: mocks.getDocComment,
  addCommentReactionChecked: mocks.addCommentReactionChecked,
}));
vi.mock('../src/services/doc-subs-store.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDocSubscription: mocks.getDocSubscription,
  putDocSubscription: mocks.putDocSubscription,
  removeDocSubscription: mocks.removeDocSubscription,
  settleDocCommentWsDelivery: mocks.settleDocCommentWsDelivery,
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { __resetEventClaimsForTest, startLarkEventDispatcher, type EventHandlers } from '../src/im/lark/event-dispatcher.js';

const APP = 'app-comment-identity';
const OWNER = 'ou_comment_owner';
const BOT = 'ou_comment_bot';
const OTHER = 'ou_another_user';
const FILE = 'CommentIdentityDocument';
const COMMENT = '7000000000000000001';
const REPLY = '7000000000000000002';

function comment(author = OWNER, text = '请整理文档', mentions = [BOT]) {
  return {
    commentId: COMMENT,
    isWhole: false,
    isSolved: false,
    replies: [{ replyId: REPLY, userId: author, text, mentions }],
  };
}

function event(meta: Record<string, unknown> = {}, options: { stringify?: boolean; wrapped?: boolean } = {}) {
  const noticeMeta = {
    file_token: FILE,
    file_type: 'docx',
    notice_type: 'add_reply',
    to_user_id: { open_id: BOT },
    ...meta,
  };
  const payload = {
    comment_id: COMMENT,
    reply_id: REPLY,
    is_mentioned: true,
    notice_meta: options.stringify ? JSON.stringify(noticeMeta) : noticeMeta,
  };
  return options.wrapped ? { event: payload } : payload;
}

async function dispatch(payload: unknown) {
  mocks.events['drive.notice.comment_add_v1'](payload);
  // The real handler returns synchronously for ACK, then runs via setImmediate.
  await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  __resetEventClaimsForTest();
  mocks.sendUserMessage.mockReset().mockResolvedValue('om_notification');
  mocks.getDocComment.mockReset().mockResolvedValue(comment());
  mocks.getDocSubscription.mockReset().mockReturnValue({
    fileToken: FILE, fileType: 'docx', ownerOpenId: OWNER,
    sessionAnchor: `doc:${FILE}`, commentTriggerMode: 'mention-only',
  });
  mocks.handleDocComment.mockReset().mockResolvedValue(true);
  mocks.addCommentReactionChecked.mockReset().mockResolvedValue({ ok: true });
  startLarkEventDispatcher(APP, 'test-secret', {
    handleDocComment: mocks.handleDocComment,
  } as unknown as EventHandlers);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('document comment event identity', () => {
  it.each([
    { stringify: false, wrapped: false },
    { stringify: true, wrapped: false },
    { stringify: false, wrapped: true },
    { stringify: true, wrapped: true },
  ])('识别 notice_meta.from_user_id，owner 不收到误报通知 %j', async options => {
    await dispatch(event({ from_user_id: { open_id: OWNER } }, options));
    expect(mocks.handleDocComment).toHaveBeenCalledWith(expect.objectContaining({ authorOpenId: OWNER, replyId: REPLY }));
    expect(mocks.sendUserMessage).not.toHaveBeenCalled();
    expect(mocks.settleDocCommentWsDelivery).toHaveBeenCalled();
  });

  it('正文不可读时仍可从事件识别 owner', async () => {
    mocks.getDocComment.mockResolvedValue(null);
    await dispatch(event({ from_user_id: { open_id: OWNER } }));
    expect(mocks.addCommentReactionChecked).toHaveBeenCalled();
    expect(mocks.handleDocComment).not.toHaveBeenCalled();
    expect(mocks.sendUserMessage).not.toHaveBeenCalled();
  });

  it('非 owner 作者进入审计通知，而不把收件 bot 当作作者', async () => {
    mocks.getDocComment.mockResolvedValue(comment(OTHER));
    await dispatch(event({ from_user_id: { open_id: OTHER } }));
    expect(mocks.sendUserMessage).toHaveBeenCalledWith(APP, OWNER, expect.stringContaining(OTHER.slice(0, 12)));
    expect(mocks.handleDocComment).toHaveBeenCalledWith(expect.objectContaining({ authorOpenId: OTHER }));
  });

  it('新建订阅使用事件中的实际发起者', async () => {
    mocks.getDocSubscription.mockReturnValue(undefined);
    mocks.getDocComment.mockResolvedValue(comment(OTHER));
    await dispatch(event({ from_user_id: { open_id: OTHER } }));
    expect(mocks.putDocSubscription).toHaveBeenCalledWith(expect.any(String), APP, expect.objectContaining({ ownerOpenId: OTHER }));
  });

  it('事件缺少作者时使用触发 reply 的作者判定 owner', async () => {
    await dispatch(event());
    expect(mocks.handleDocComment).toHaveBeenCalled();
    expect(mocks.sendUserMessage).not.toHaveBeenCalled();
  });

  it('纯 @ 评论也使用 reply 作者判定 owner', async () => {
    mocks.getDocComment.mockResolvedValue(comment(OWNER, ''));
    await dispatch(event());
    expect(mocks.addCommentReactionChecked).toHaveBeenCalled();
    expect(mocks.sendUserMessage).not.toHaveBeenCalled();
    expect(mocks.handleDocComment).not.toHaveBeenCalled();
  });

  it('未知事件作者不能把 owner 收件人当作触发者', async () => {
    mocks.getDocComment.mockResolvedValue(comment(OTHER));
    await dispatch(event({ to_user_id: { open_id: OWNER } }));
    expect(mocks.sendUserMessage).toHaveBeenCalledWith(APP, OWNER, expect.stringContaining(OTHER.slice(0, 12)));
  });

  it('兼容旧的 operator_id 字段', async () => {
    await dispatch({ ...event(), operator_id: { open_id: OWNER } });
    expect(mocks.handleDocComment).toHaveBeenCalled();
    expect(mocks.sendUserMessage).not.toHaveBeenCalled();
  });

  it('兼容事件顶层的 from_user_id 字段', async () => {
    mocks.getDocComment.mockResolvedValue(null);
    await dispatch({ ...event(), from_user_id: { open_id: OWNER } });
    expect(mocks.addCommentReactionChecked).toHaveBeenCalled();
    expect(mocks.sendUserMessage).not.toHaveBeenCalled();
  });

  it('解析失败的 notice_meta 不影响顶层字段和旧操作者路径', async () => {
    await dispatch({
      ...event(), file_token: FILE, file_type: 'docx',
      notice_meta: '{invalid json', operator_id: { open_id: OWNER },
    });
    expect(mocks.handleDocComment).toHaveBeenCalled();
    expect(mocks.sendUserMessage).not.toHaveBeenCalled();
  });

  it('事件中的明确操作者优先于 reply 作者', async () => {
    await dispatch({ ...event(), operator_id: { open_id: OTHER } });
    expect(mocks.sendUserMessage).toHaveBeenCalledWith(APP, OWNER, expect.stringContaining(OTHER.slice(0, 12)));
  });

  it('正文不可读且触发者为 bot 自己时不发通知也不打失败标记', async () => {
    mocks.getDocComment.mockResolvedValue(null);
    await dispatch(event({ from_user_id: { open_id: BOT } }));
    expect(mocks.sendUserMessage).not.toHaveBeenCalled();
    expect(mocks.addCommentReactionChecked).not.toHaveBeenCalled();
  });

  it('无法从事件或正文识别作者时仍需通过审计', async () => {
    const data = comment();
    delete (data.replies[0] as { userId?: string }).userId;
    mocks.getDocComment.mockResolvedValue(data);
    await dispatch(event());
    expect(mocks.sendUserMessage).toHaveBeenCalledWith(APP, OWNER, expect.stringContaining('用户 ?'));
  });

  it('非 owner 通知失败时拒绝投递并回滚新订阅', async () => {
    mocks.getDocSubscription.mockReturnValue(undefined);
    mocks.getDocComment.mockResolvedValue(comment(OTHER));
    mocks.sendUserMessage.mockRejectedValue(new Error('DM unavailable'));
    await dispatch(event({ from_user_id: { open_id: OTHER } }));
    expect(mocks.handleDocComment).not.toHaveBeenCalled();
    expect(mocks.removeDocSubscription).toHaveBeenCalledWith(expect.any(String), APP, FILE);
  });

  it('未 @ 本 bot 的评论不发通知或投递', async () => {
    mocks.getDocComment.mockResolvedValue(comment(OTHER, '请看这里', ['ou_other_bot']));
    await dispatch(event({ from_user_id: { open_id: OTHER } }));
    expect(mocks.sendUserMessage).not.toHaveBeenCalled();
    expect(mocks.handleDocComment).not.toHaveBeenCalled();
  });
});
