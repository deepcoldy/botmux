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

import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import { recordLimitedFailedTurn, clearLimitedFailedTurn } from '../src/core/failed-turn-recovery.js';
import type { DaemonSession } from '../src/core/types.js';
import { EventEmitter } from 'node:events';

const SESSION_ID = 'sid-limited-after-terminal';
const RECOVERY = 'bmx-recovery-1';
const caller = { requestUserOpenId: 'ou_user', requestLarkAppId: 'app_test', senderType: 'user' as const };

function recoverySession(): DaemonSession {
  const worker = new EventEmitter() as any;
  Object.assign(worker, { killed: false, send: vi.fn(), kill: vi.fn(), pid: 99999,
    stdout: new EventEmitter(), stderr: new EventEmitter() });
  const ds = {
    session: { sessionId: SESSION_ID, rootMessageId: 'om_root', chatId: 'oc_chat', title: 'fixture',
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), pid: null, chatType: 'group', cliId: 'pi',
      larkAppId: 'app_test',
      failedTurnRecovery: { originalTurnId: 'om_old', turnId: RECOVERY, caller } },
    worker, workerPort: 0, workerToken: 'tok', larkAppId: 'app_test', chatId: 'oc_chat', chatType: 'group',
    spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(), hasHistory: true,
    // Admin recovery dispatches without beginNewTurn: currentTurnId still names the old turn.
    currentTurnId: 'om_old',
    lastCliInputTurnId: RECOVERY, lastUserPrompt: 'task', lastCliInput: 'wrapped',
    // Left over from the earlier 429; only a working frame clears it.
    usageLimit: { limited: true, kind: 'rate', retryLabel: '5-10 min' },
    lastScreenStatus: 'limited',
    workerReady: true,
  } as any;
  __testOnly_setupWorkerHandlers(ds, worker);
  return ds;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const statuses: Array<{ status: string; turnId?: string }> = [];

describe('limited frame after a completed recovery turn', () => {
  beforeEach(() => {
    statuses.length = 0;
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      // Same wiring as daemon.ts onScreenStatus.
      onScreenStatus(ds: DaemonSession, context: { prevStatus?: string; status: string; turnId?: string }) {
        statuses.push({ status: context.status, turnId: context.turnId });
        if (context.status === 'limited') recordLimitedFailedTurn(ds, context.turnId);
        else if (context.prevStatus === 'limited') clearLimitedFailedTurn(ds);
      },
    } as any);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('does not record the answered recovery turn as rate_limited', async () => {
    const ds = recoverySession();
    (ds.worker as any).emit('message', { type: 'turn_terminal', sessionId: SESSION_ID, turnId: RECOVERY, status: 'completed' });
    await settle();
    (ds.worker as any).emit('message', { type: 'screen_update', sessionId: SESSION_ID, content: '> ', status: 'idle', turnId: RECOVERY });
    await settle();
    // The idle frame really was projected `limited` for the recovery turn...
    expect(statuses).toContainEqual({ status: 'limited', turnId: RECOVERY });
    // ...but an answered turn is not a quota failure.
    expect(ds.session.lastFailedTurn).toBeUndefined();
  });

  it('still records a limit seen while the recovery turn is in flight', async () => {
    const ds = recoverySession();
    (ds.worker as any).emit('message', { type: 'screen_update', sessionId: SESSION_ID, content: '> ', status: 'idle', turnId: RECOVERY });
    await settle();
    expect(ds.session.lastFailedTurn).toMatchObject({ turnId: RECOVERY, errorCode: 'rate_limited', limitedSnapshot: true });
  });
});
