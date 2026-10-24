/**
 * 看板批次 → 管家群会话的一个回合（deliverOwnerBatchTurn）：
 *   - 管家会话在跑：注入同一个会话，带 owner 身份与附图；不新建会话；
 *   - 没有会话：发横幅、新建 chat 级会话、首轮就是批次消息；
 *   - 话题群：以横幅开话题（thread 级会话）；
 *   - 管家会话还在等开场（选仓库）：拒绝，留给重投，不抢开场 prompt。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: {
    session: { get dataDir() { return tempDir; } },
    daemon: { backendType: 'pty', workingDir: '~', workingDirs: ['~'] },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const wp = vi.hoisted(() => ({
  forkWorker: vi.fn(),
  sendWorkerInput: vi.fn(() => true),
}));

vi.mock('../src/core/worker-pool.js', () => ({
  forkWorker: wp.forkWorker,
  sendWorkerInput: wp.sendWorkerInput,
  getCurrentCliVersion: vi.fn(() => '1.0.0-test'),
  withActiveSessionKeyLock: vi.fn(async (_map: Map<string, any>, _key: string, action: () => any) => action()),
  setActiveSessionIfActive: vi.fn((map: Map<string, any>, key: string, ds: any) => {
    const current = map.get(key);
    if (current && current !== ds) return false;
    map.set(key, ds);
    return true;
  }),
  isRelayableRealSession: (ds: any) => !!ds?.worker || !!ds?.session?.cliId || !!ds?.session?.lastCliInput,
  isDisposableCommandScratch: () => false,
  closeSession: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../src/bot-registry.js', () => {
  const bot = {
    config: { larkAppId: 'app_s', cliId: 'claude-code', steward: { enabled: true, chatId: 'oc_steward' } },
    botName: '管家',
    botOpenId: 'ou_bot',
    resolvedAllowedUsers: ['ou_owner'],
  };
  return {
    getBot: vi.fn(() => bot),
    getAllBots: vi.fn(() => [bot]),
    getOwnerOpenId: vi.fn(() => 'ou_owner'),
    findOncallChat: vi.fn(() => undefined),
    effectiveDefaultWorkingDir: vi.fn(() => undefined),
  };
});

const lark = vi.hoisted(() => ({
  chatMode: 'group' as 'group' | 'topic' | 'p2p',
  sendMessage: vi.fn(async () => 'om_banner'),
}));

vi.mock('../src/im/lark/client.js', () => ({
  getChatMode: vi.fn(async () => lark.chatMode),
  sendMessage: lark.sendMessage,
  downloadMessageResource: vi.fn(),
  listChatBotMembers: vi.fn(),
}));

vi.mock('../src/services/message-queue.js', () => ({ ensureQueue: vi.fn() }));
vi.mock('../src/core/session-activity.js', () => ({
  announceSessionRow: vi.fn(),
  announcePendingRepoSession: vi.fn(),
  markSessionActivity: vi.fn(),
  clearAgentAttention: vi.fn((ds: any) => {
    if (ds.agentAttention) { ds.agentAttention = undefined; return true; }
    return false;
  }),
  stampHumanActivity: vi.fn((session: any, at: number) => {
    session.lastHumanMessageAt = new Date(at).toISOString();
  }),
}));

import { deliverOwnerBatchTurn } from '../src/core/session-manager.js';
import * as sessionStore from '../src/services/session-store.js';
import * as sessionActivity from '../src/core/session-activity.js';
import { sessionKey } from '../src/core/types.js';

const INPUT = {
  larkAppId: 'app_s',
  chatId: 'oc_steward',
  turnId: 'board:app_s:1',
  prompt: '【决策看板 · 批次 #1】owner 提交了 1 项决定。',
  banner: '📥 收到 1 项',
  attachments: [{ type: 'image' as const, path: '/tmp/x.png', name: 'x.png' }],
  ownerOpenId: 'ou_owner',
  ownerName: 'owner',
  sessionTitle: '管家',
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'decision-board-delivery-'));
  sessionStore.init('app_s');
  lark.chatMode = 'group';
  wp.forkWorker.mockClear();
  wp.sendWorkerInput.mockClear();
  lark.sendMessage.mockClear();
  vi.mocked(sessionActivity.markSessionActivity).mockClear();
  vi.mocked(sessionActivity.clearAgentAttention).mockClear();
  vi.mocked(sessionActivity.stampHumanActivity).mockClear();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function liveSession(map: Map<string, any>, extra: Record<string, unknown> = {}) {
  const session = sessionStore.createSession('oc_steward', 'oc_steward', '管家', 'group');
  session.larkAppId = 'app_s';
  session.scope = 'chat';
  session.cliId = 'claude-code';
  sessionStore.updateSession(session);
  const ds = {
    session, worker: { killed: false }, workerPort: 1, workerToken: 't', larkAppId: 'app_s', chatId: 'oc_steward',
    chatType: 'group', scope: 'chat', spawnedAt: Date.now(), lastMessageAt: Date.now(), hasHistory: true, ...extra,
  };
  map.set(sessionKey('oc_steward', 'app_s'), ds);
  return ds;
}

describe('deliverOwnerBatchTurn', () => {
  it('管家会话在跑：注入同一会话，回合带 owner 身份和附图，不新建会话', async () => {
    const map = new Map<string, any>();
    const ds = liveSession(map);
    const res = await deliverOwnerBatchTurn(INPUT, map, () => false);
    expect(res.sessionId).toBe(ds.session.sessionId);
    expect(lark.sendMessage).toHaveBeenCalledWith('app_s', 'oc_steward', '📥 收到 1 项');
    expect(wp.sendWorkerInput).toHaveBeenCalledTimes(1);
    const [target, payload, turnId, opts] = wp.sendWorkerInput.mock.calls[0] as any[];
    expect(target).toBe(ds);
    expect(turnId).toBe('board:app_s:1');
    expect(opts.trustedCaller).toEqual({ requestUserOpenId: 'ou_owner', requestLarkAppId: 'app_s', senderType: 'user' });
    expect(JSON.stringify(payload)).toContain('批次 #1');
    expect(JSON.stringify(payload)).toContain('/tmp/x.png');
    expect(wp.forkWorker).not.toHaveBeenCalled();
    expect(map.size).toBe(1);
  });

  it('没有会话：新建 chat 级会话，首轮就是批次消息', async () => {
    const map = new Map<string, any>();
    const res = await deliverOwnerBatchTurn(INPUT, map, () => false);
    const ds = map.get(sessionKey('oc_steward', 'app_s'));
    expect(ds.session.sessionId).toBe(res.sessionId);
    expect(ds.scope).toBe('chat');
    expect(ds.session.ownerOpenId).toBe('ou_owner');
    expect(wp.forkWorker).toHaveBeenCalledTimes(1);
    const [, prompt, turnId] = wp.forkWorker.mock.calls[0] as any[];
    expect(turnId).toBe('board:app_s:1');
    expect(JSON.stringify(prompt)).toContain('批次 #1');
  });

  it('话题群：以横幅开话题，会话挂在横幅下', async () => {
    lark.chatMode = 'topic';
    const map = new Map<string, any>();
    await deliverOwnerBatchTurn(INPUT, map, () => false);
    const ds = map.get(sessionKey('om_banner', 'app_s'));
    expect(ds?.scope).toBe('thread');
    expect(map.has(sessionKey('oc_steward', 'app_s'))).toBe(false);
  });

  it('管家会话还在选仓库：拒绝投递，不碰会话，横幅也不发（shared/chat 锚点在锁内检查后才发）', async () => {
    const map = new Map<string, any>();
    liveSession(map, { pendingRepo: true });
    await expect(deliverOwnerBatchTurn(INPUT, map, () => false)).rejects.toThrow(/pending_repo/);
    expect(wp.sendWorkerInput).not.toHaveBeenCalled();
    expect(wp.forkWorker).not.toHaveBeenCalled();
    expect(lark.sendMessage).not.toHaveBeenCalled();
  });

  it('话题群开场保留中：横幅本就是新话题锚点，照常发出', async () => {
    lark.chatMode = 'topic';
    const map = new Map<string, any>();
    liveSession(map, { pendingRepo: true });
    // chat 锚点上的保留会话挡的是 oc_steward，横幅是全新 om_ id，投递在新锚点上继续。
    await deliverOwnerBatchTurn(INPUT, map, () => false);
    expect(lark.sendMessage).toHaveBeenCalledTimes(1);
    expect(map.has(sessionKey('om_banner', 'app_s'))).toBe(true);
  });

  it('批次投递清掉管家的决策举手，并按真人消息刷新人活动钟', async () => {
    const map = new Map<string, any>();
    const ds = liveSession(map, { agentAttention: { kind: 'decision', reason: '等拍板', at: 1 } });
    await deliverOwnerBatchTurn(INPUT, map, () => false);
    expect(ds.agentAttention).toBeUndefined();
    expect(sessionActivity.clearAgentAttention).toHaveBeenCalledTimes(1);
    expect(sessionActivity.markSessionActivity).toHaveBeenCalledWith(
      expect.anything(), expect.any(Number), expect.objectContaining({ human: true }));
  });

  it('没有 owner 身份时不写人活动钟，但仍投递成功', async () => {
    const map = new Map<string, any>();
    await deliverOwnerBatchTurn({ ...INPUT, ownerOpenId: undefined, ownerName: undefined }, map, () => false);
    const call = (sessionActivity.markSessionActivity as any).mock.calls[0];
    expect(call?.[2]?.human).toBeFalsy();
  });
});
