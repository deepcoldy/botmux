import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 审计硬门的行为测试。
 *
 * 这道门原本内联在 processCommentEvent 里、**没有任何测试覆盖**；#1261 把它抽成
 * 共用 helper 给「回复」和「失败标记」两条路径用。抽取本身是重构，最容易在无人
 * 察觉时改变语义 —— 所以这里把不变量钉住：
 *
 *   owner 本人触发       → 放行，不通知、不回滚
 *   非 owner + 通知成功  → 放行（owner 已感知）
 *   非 owner + 通知失败  → 拒绝 + 回滚 auto-sub（owner 无法感知 = 越权）
 *   owner 未配置         → 拒绝 + 回滚（无从判定越权，保守拒绝）
 */

const mocks = vi.hoisted(() => ({
  sendUserMessage: vi.fn(),
  getOwnerOpenId: vi.fn(),
  rollback: vi.fn(),
}));

vi.mock('../src/im/lark/client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendUserMessage: mocks.sendUserMessage,
}));

vi.mock('../src/bot-registry.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOpenId: mocks.getOwnerOpenId,
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const FILE_TOKEN = 'DocToken1234567890123456';
const OWNER = 'ou_owner';

describe('passesDocCommentAuditGate', () => {
  let gate: (
    larkAppId: string,
    fileToken: string,
    requesterOpenId: string | undefined,
    textSummary: string,
    rollbackAutoSub: () => void,
  ) => Promise<boolean>;

  beforeEach(async () => {
    mocks.sendUserMessage.mockReset().mockResolvedValue(undefined);
    mocks.getOwnerOpenId.mockReset().mockReturnValue(OWNER);
    mocks.rollback.mockReset();
    ({ __testOnly_passesDocCommentAuditGate: gate } =
      await import('../src/im/lark/event-dispatcher.js'));
  });

  it('owner 本人触发：放行，且不打扰自己、不回滚', async () => {
    await expect(gate('app-test', FILE_TOKEN, OWNER, '正文', mocks.rollback)).resolves.toBe(true);
    expect(mocks.sendUserMessage).not.toHaveBeenCalled();
    expect(mocks.rollback).not.toHaveBeenCalled();
  });

  it('非 owner + 通知成功：放行（owner 已感知），不回滚', async () => {
    await expect(gate('app-test', FILE_TOKEN, 'ou_stranger', '正文', mocks.rollback)).resolves.toBe(true);
    expect(mocks.sendUserMessage).toHaveBeenCalledTimes(1);
    const [, target] = mocks.sendUserMessage.mock.calls[0];
    expect(target).toBe(OWNER);
    expect(mocks.rollback).not.toHaveBeenCalled();
  });

  it('非 owner + 通知失败：拒绝并回滚 auto-sub（owner 无法感知 = 越权）', async () => {
    mocks.sendUserMessage.mockRejectedValue(new Error('DM 发不出去'));
    await expect(gate('app-test', FILE_TOKEN, 'ou_stranger', '正文', mocks.rollback)).resolves.toBe(false);
    expect(mocks.rollback).toHaveBeenCalledTimes(1);
  });

  it('owner 未配置：拒绝并回滚，且不尝试发通知', async () => {
    mocks.getOwnerOpenId.mockReturnValue(undefined);
    await expect(gate('app-test', FILE_TOKEN, 'ou_stranger', '正文', mocks.rollback)).resolves.toBe(false);
    expect(mocks.sendUserMessage).not.toHaveBeenCalled();
    expect(mocks.rollback).toHaveBeenCalledTimes(1);
  });

  it('operator 缺失：按非 owner 处理（判不出是谁触发的）', async () => {
    await expect(gate('app-test', FILE_TOKEN, undefined, '正文', mocks.rollback)).resolves.toBe(true);
    expect(mocks.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  /**
   * 关键：摘要**可以不是评论正文**。失败路径根本读不到正文，若因此跳过审计，
   * 就等于给外部写入开了个免审计通道 —— #1261 早先的版本正是这么错的。
   */
  it('摘要透传进通知正文 —— 失败路径可以用说明文字代替评论正文', async () => {
    await gate('app-test', FILE_TOKEN, 'ou_stranger', '评论正文读取失败，bot 未处理该条 @', mocks.rollback);
    const [, , notifyText] = mocks.sendUserMessage.mock.calls[0];
    expect(notifyText).toContain('评论正文读取失败，bot 未处理该条 @');
    expect(notifyText).toContain(FILE_TOKEN);
  });

  it('超长摘要截断到 200 字并加省略号（原行为，不能因抽取而改变）', async () => {
    await gate('app-test', FILE_TOKEN, 'ou_stranger', 'x'.repeat(500), mocks.rollback);
    const [, , notifyText] = mocks.sendUserMessage.mock.calls[0];
    expect(notifyText).toContain('x'.repeat(200) + '…');
    expect(notifyText).not.toContain('x'.repeat(201));
  });
});
