import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1260 复审：`addCommentReaction` 的身份选择。
 *
 * 「事件被丢弃」的 ❌ 是**终态**标记、故意不清理，所以绝不能回退 user 身份 ——
 * 那等于在用户自己的评论上、以用户自己的名义、永久挂一个叉（错误主体的持久
 * 外部写入）。而 Typing 指示器是成对的、几秒后必被 removeCommentReaction 清掉，
 * 回退 user 只是短暂误导，故保持 preferTenant 不变。
 *
 * 这一层是**行为级**测试：直接看 provider 选择的结果（打没打 user 那条路），
 * 而不是钉源码字符串。
 */

const mocks = vi.hoisted(() => ({
  tenantRequest: vi.fn(),
  resolveUserToken: vi.fn(),
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
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { addCommentReaction, addCommentReactionChecked } from '../src/im/lark/doc-comment.js';

const FILE = { fileToken: 'DocToken1234567890123456', fileType: 'docx' };
const COMMENT_ID = '7681622822925421500';
const REPLY_ID = '7681633934731430857';

describe('addCommentReaction 的身份选择', () => {
  beforeEach(() => {
    mocks.tenantRequest.mockReset();
    // user token 存在且可用 —— 只有这样「有没有回退」才是可观测的：
    // 若代码真的回退，fetch 会被调用；tenantOnly 下它必须一次都不被调。
    mocks.resolveUserToken.mockReset().mockResolvedValue('u-token-live');
    vi.unstubAllGlobals();
  });

  it('tenantOnly: tenant 失败时不回退 user —— 一次 user 请求都不能发', async () => {
    mocks.tenantRequest.mockRejectedValue(new Error('bot 对该文档无权限'));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const id = await addCommentReaction('app-test', FILE, COMMENT_ID, REPLY_ID, 'ERROR', { tenantOnly: true });

    // best-effort：失败返回 undefined，不外抛（丢弃路径已经是失败路径了）。
    expect(id).toBeUndefined();
    // 关键断言：user 身份走的是裸 fetch，这里必须零调用。
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('tenantOnly: tenant 返回 code!=0 同样不回退 user', async () => {
    mocks.tenantRequest.mockResolvedValue({ code: 1069307, msg: 'no permission' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const id = await addCommentReaction('app-test', FILE, COMMENT_ID, REPLY_ID, 'ERROR', { tenantOnly: true });

    expect(id).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('tenantOnly: tenant 成功时正常返回 reaction_id', async () => {
    mocks.tenantRequest.mockResolvedValue({ code: 0, data: { reaction_id: 'r-1' } });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const id = await addCommentReaction('app-test', FILE, COMMENT_ID, REPLY_ID, 'ERROR', { tenantOnly: true });

    expect(id).toBe('r-1');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.tenantRequest).toHaveBeenCalledTimes(1);
  });

  /**
   * 回归护栏：本 PR 只收紧「丢弃标记」这一条路径，**不许**顺手把 Typing 也改成
   * tenantOnly —— Typing 必须保证落地（会被清理，短暂显示成授权用户可以接受）。
   */
  it('默认（Typing 路径）：tenant 失败仍回退 user，行为不变', async () => {
    mocks.tenantRequest.mockRejectedValue(new Error('bot 对该文档无权限'));
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ code: 0, data: { reaction_id: 'r-user' } }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const id = await addCommentReaction('app-test', FILE, COMMENT_ID, REPLY_ID, 'Typing');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(id).toBe('r-user');
  });
});

/**
 * userOnly + tenantOnly 同时传是调用方的逻辑错误。必须炸，不能静默走 userOnly ——
 * tenantOnly 的全部意义就是禁止 user 身份写入，静默降级成 user-only 恰好是它要防
 * 的那件事。当前没有调用方这么传，这是给未来的护栏。
 */
describe('driveApiCall: userOnly 与 tenantOnly 互斥', () => {
  beforeEach(() => {
    mocks.tenantRequest.mockReset();
    mocks.resolveUserToken.mockReset().mockResolvedValue('u-token-live');
    vi.unstubAllGlobals();
  });

  it('同时指定时抛错，绝不静默降级成 user-only', async () => {
    const { __testOnly_driveApiCall } = await import('../src/im/lark/doc-comment.js') as any;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(__testOnly_driveApiCall('app-test', {
      method: 'POST',
      path: '/open-apis/drive/v1/whatever',
      userOnly: true,
      tenantOnly: true,
    })).rejects.toThrow(/互斥/);

    // 关键：一次 provider 请求都不能发出去。
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.tenantRequest).not.toHaveBeenCalled();
  });
});

/**
 * `addCommentReactionChecked` 的 `ok` 必须反映**服务端真实结果**，不能用
 * `reactionId` 是否存在来推断 —— 飞书官方 `update_reaction` 的响应体是空对象、
 * **不承诺**带 `reaction_id`。用 id 判成败会把 code=0 的成功记成失败，让排障的人
 * 以为「飞书拒绝了」，正好和引入 outcome 字段的目的相反。
 */
describe('addCommentReactionChecked: ok 反映真实服务端结果', () => {
  beforeEach(() => {
    mocks.tenantRequest.mockReset();
    mocks.resolveUserToken.mockReset().mockResolvedValue(null);
    vi.unstubAllGlobals();
  });

  it('code=0 但响应体不带 reaction_id ⇒ ok=true（官方 schema 就是空对象）', async () => {
    mocks.tenantRequest.mockResolvedValue({ code: 0, data: {} });
    const res = await addCommentReactionChecked('app-test', FILE, COMMENT_ID, REPLY_ID, 'ERROR', { tenantOnly: true });
    expect(res.ok).toBe(true);
    expect(res.reactionId).toBeUndefined();
  });

  it('code=0 且带 reaction_id ⇒ ok=true 并透出 id', async () => {
    mocks.tenantRequest.mockResolvedValue({ code: 0, data: { reaction_id: 'r-9' } });
    const res = await addCommentReactionChecked('app-test', FILE, COMMENT_ID, REPLY_ID, 'ERROR', { tenantOnly: true });
    expect(res).toEqual({ ok: true, reactionId: 'r-9' });
  });

  it('请求抛错 ⇒ ok=false（tenantOnly 下 code!=0 也会抛）', async () => {
    mocks.tenantRequest.mockRejectedValue(new Error('boom'));
    const res = await addCommentReactionChecked('app-test', FILE, COMMENT_ID, REPLY_ID, 'ERROR', { tenantOnly: true });
    expect(res.ok).toBe(false);
  });

  it('旧签名 addCommentReaction 行为不变（仍返回 reactionId | undefined）', async () => {
    mocks.tenantRequest.mockResolvedValue({ code: 0, data: { reaction_id: 'r-legacy' } });
    await expect(addCommentReaction('app-test', FILE, COMMENT_ID, REPLY_ID, 'Typing')).resolves.toBe('r-legacy');
  });
});
