/**
 * card-handler 多目标授权「部分落库失败」路径（Codex review blocker 回归）：
 *   - 失败 target 的 pending 必须清掉（否则无 TTL，isThrottled 永久挡住后续申请）；
 *   - owner 必须看到失败清单（不做「撤卡 + 静默失败」）；
 *   - 成功的 bot 仍登记花名册、卡仍撤回。
 * Run: pnpm vitest run test/card-handler-grant-partial.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

const replyMock = vi.fn(async () => 'om_reply');
const deleteMock = vi.fn(async () => true);
const getMessageDetailMock = vi.fn(async () => ({ items: [{ thread_id: 'omt_thread' }] }));
const isHumanMock = vi.fn(async () => false);
vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return {
    ...actual,
    replyMessage: (...a: any[]) => replyMock(...a),
    deleteMessage: (...a: any[]) => deleteMock(...a),
    getMessageDetail: (...a: any[]) => getMessageDetailMock(...a),
    isHumanOpenId: (...a: any[]) => isHumanMock(...a),
  };
});

// grant-store 全 mock：openId === 'ou_fail' 落库失败，其它成功。不碰真实 config。
const addChatGrantMock = vi.fn(async (_app: string, _chat: string, openId: string) =>
  (openId === 'ou_fail' ? { ok: false, reason: 'boom' } : { ok: true, created: true }));
vi.mock('../src/services/grant-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/grant-store.js')>();
  return { ...actual, addChatGrant: (...a: any[]) => addChatGrantMock(...a) };
});

const recordObservedMock = vi.fn();
vi.mock('../src/services/observed-bots-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/observed-bots-store.js')>();
  return { ...actual, recordObservedBots: (...a: any[]) => recordObservedMock(...a) };
});

const deps = { activeSessions: new Map(), sessionReply: vi.fn(async () => 'mid'), lastRepoScan: new Map() } as any;

// 通知卡 / 部分失败文字 / 撤回原卡现在走 fire-and-forget 后台（handleCardAction 先同步返回
// 终态卡避免 callback 超时 → 300000）。一次宏任务把整条后台微任务链排空再断言后台副作用。
const flushBackground = () => new Promise(resolve => setTimeout(resolve, 0));

async function fresh() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const pending = await import('../src/im/lark/grant-pending.js');
  const handler = await import('../src/im/lark/card-handler.js');
  const bot = registry.registerBot({ larkAppId: 'h1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] });
  bot.botOpenId = 'ou_bot';
  bot.resolvedAllowedUsers = ['ou_owner'];
  return { registry, pending, handler };
}

beforeEach(() => {
  replyMock.mockClear();
  deleteMock.mockClear().mockImplementation(async () => true);
  getMessageDetailMock.mockClear().mockImplementation(async () => ({ items: [{ thread_id: 'omt_thread' }] }));
  isHumanMock.mockClear().mockImplementation(async () => false);
  recordObservedMock.mockClear();
  addChatGrantMock.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('card-handler 部分授权失败', () => {
  function multiAction(ids: string[], names: string[], nonce: string) {
    return {
      operator: { open_id: 'ou_owner' }, context: { open_message_id: 'om_card' },
      action: { value: { action: 'grant_chat', target_open_ids: ids, target_names: names, chat_id: 'oc_1', nonce } },
    };
  }

  it('部分成功：失败 target 的 pending 被清（不再永久 throttle），owner 收到失败清单，成功 bot 仍登记+撤卡', async () => {
    const { pending, handler } = await fresh();
    const nonce = pending.openPendingMulti('h1', 'oc_1', ['ou_ok', 'ou_fail']);
    await handler.handleCardAction(multiAction(['ou_ok', 'ou_fail'], ['好机器人', '坏目标'], nonce), deps, 'h1');

    // 失败 target 的 pending 必须清掉：checkNonce/isThrottled 都不再挡它（同步发生，扣 pending 在落库阶段）
    expect(pending.checkNonce('h1', 'oc_1', 'ou_fail', nonce)).toBe(false);
    expect(pending.isThrottled('h1', 'oc_1', 'ou_fail')).toBe(false);
    // 成功 target 也清了
    expect(pending.checkNonce('h1', 'oc_1', 'ou_ok', nonce)).toBe(false);

    await flushBackground();   // 通知 + 失败清单文字 + 撤卡走后台 fire-and-forget

    // owner 收到失败清单（含失败目标名），且不是静默
    const partialReply = replyMock.mock.calls.find(c => typeof c[2] === 'string' && String(c[2]).includes('坏目标'));
    expect(partialReply).toBeTruthy();

    // 成功的 bot 仍被登记进花名册（只含成功的 ou_ok）
    expect(recordObservedMock).toHaveBeenCalledTimes(1);
    const [, , , entries] = recordObservedMock.mock.calls.at(-1)!;
    expect(entries).toEqual([{ openId: 'ou_ok', name: '好机器人' }]);

    // 卡仍撤回
    expect(deleteMock).toHaveBeenCalledWith('h1', 'om_card');
  });

  it('全部失败：保留 pending（owner 可点原卡重试）+ toast 报错，不撤卡', async () => {
    const { pending, handler } = await fresh();
    const nonce = pending.openPendingMulti('h1', 'oc_1', ['ou_fail', 'ou_fail2']);
    addChatGrantMock.mockImplementation(async () => ({ ok: false, reason: 'boom' }));
    const res = await handler.handleCardAction(multiAction(['ou_fail', 'ou_fail2'], ['坏1', '坏2'], nonce), deps, 'h1');

    expect(res?.toast?.type).toBe('error');
    // pending 保留，nonce 仍有效 → owner 可点原卡重试
    expect(pending.checkNonce('h1', 'oc_1', 'ou_fail', nonce)).toBe(true);
    expect(pending.checkNonce('h1', 'oc_1', 'ou_fail2', nonce)).toBe(true);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(recordObservedMock).not.toHaveBeenCalled();
  });
});
