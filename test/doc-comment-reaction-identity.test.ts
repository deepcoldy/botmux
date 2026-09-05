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

import { addCommentReaction } from '../src/im/lark/doc-comment.js';

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
