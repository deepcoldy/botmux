/**
 * 「执行失败」卡头在会话走出失败后要恢复。
 *
 * 失败轮次把 `failedIdleTurnId` 钉在会话上，原先只有下一条 IM 消息入轮
 * （beginNewTurn / 输入提交）才清。用户在 Web 终端直接敲「继续」跑完的轮次
 * 不经过这两道门：现场是 Pi 的 PR 评审会话，17:00 失败、17:04 终端里「继续」、
 * 17:54 结论已发到群里，卡片却一直停在「执行失败」。
 *
 * 驱动真实的 worker-pool IPC handler（fake worker），与 async-terminal-settle
 * 同一套脚手架。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Pi'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'pi' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getOwnerOpenId: vi.fn(() => undefined),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'pty', cliId: 'pi' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import {
  CARD_POSTING_SENTINEL,
  idleCardLabel,
  initWorkerPool,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import { EventEmitter } from 'node:events';

const SESSION_ID = 'sid-failed-idle';

function makeDs(): DaemonSession {
  const fakeWorker = new EventEmitter() as any;
  fakeWorker.killed = false;
  fakeWorker.send = vi.fn();
  fakeWorker.kill = vi.fn();
  fakeWorker.pid = 99999;
  fakeWorker.stdout = new EventEmitter();
  fakeWorker.stderr = new EventEmitter();
  return {
    session: {
      sessionId: SESSION_ID,
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'pi',
    },
    worker: fakeWorker,
    workerPort: 0,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: false,
  } as any;
}

function terminal(
  turnId: string,
  extra: Partial<Extract<WorkerToDaemon, { type: 'turn_terminal' }>> = {},
): Extract<WorkerToDaemon, { type: 'turn_terminal' }> {
  return { type: 'turn_terminal', sessionId: SESSION_ID, turnId, status: 'completed', ...extra };
}

/** The Channel-B failure notice a structured CLI emits for a failed turn. */
function failedFinal(turnId: string): Extract<WorkerToDaemon, { type: 'final_output' }> {
  return {
    type: 'final_output', sessionId: SESSION_ID, turnId, lastUuid: turnId,
    content: '⚠️ Pi 获取模型凭据失败', turnFailed: true, turnFailureCode: 'pi_credential_unavailable',
  };
}

/** Let the async IPC handler run past its first await. */
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('「执行失败」卡头：之后有轮次正常完成就恢复', () => {
  beforeEach(() => {
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
  });
  afterEach(() => { vi.clearAllMocks(); });

  function failedSession(): DaemonSession {
    const ds = makeDs();
    ds.currentTurnId = 'om_failed';
    __testOnly_setupWorkerHandlers(ds, ds.worker as any);
    (ds.worker as any).emit('message', failedFinal('om_failed'));
    (ds.worker as any).emit('message', terminal('om_failed', { status: 'failed', errorCode: 'pi_credential_unavailable' }));
    return ds;
  }

  it('终端里敲「继续」的本地轮次完成后，清掉失败标签并重刷空闲卡', async () => {
    const ds = failedSession();
    await settle();
    expect(idleCardLabel(ds)).toBe('failed');

    // Card already settled to idle under the failed label; the refresh is
    // observable as a pending patch while the card POST is in flight.
    ds.lastScreenStatus = 'idle';
    ds.streamCardId = CARD_POSTING_SENTINEL;
    ds.pendingActiveRuntimeCardRefresh = undefined;
    (ds.worker as any).emit('message', terminal('codex-local-1a2b3c'));
    await settle();

    expect(ds.failedIdleTurnId).toBeUndefined();
    expect(idleCardLabel(ds)).toBeUndefined();
    expect(ds.pendingActiveRuntimeCardRefresh).toBe(true);
  });

  it('本地轮次仍在跑（卡在 working）时只清标签，等下一个空闲边沿自然带上', async () => {
    const ds = failedSession();
    await settle();
    ds.lastScreenStatus = 'working';
    ds.streamCardId = CARD_POSTING_SENTINEL;
    ds.pendingActiveRuntimeCardRefresh = undefined;
    (ds.worker as any).emit('message', terminal('codex-local-1a2b3c'));
    await settle();

    expect(ds.failedIdleTurnId).toBeUndefined();
    expect(ds.pendingActiveRuntimeCardRefresh).toBeUndefined();
  });

  it('另一轮以失败或中断收尾时，不清失败标签', async () => {
    const ds = failedSession();
    await settle();
    (ds.worker as any).emit('message', terminal('codex-local-a', { status: 'failed', errorCode: 'codex_task_failed' }));
    (ds.worker as any).emit('message', terminal('codex-local-b', { status: 'ambiguous', errorCode: 'pi_turn_aborted' }));
    await settle();
    expect(idleCardLabel(ds)).toBe('failed');
  });

  it('失败轮次自己的终态（含重复投递）不会把标签清掉', async () => {
    const ds = failedSession();
    await settle();
    (ds.worker as any).emit('message', terminal('om_failed'));
    await settle();
    expect(ds.failedIdleTurnId).toBe('om_failed');
  });
});
