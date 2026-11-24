import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DaemonSession } from '../src/core/types.js';
import type { LarkMessage } from '../src/types.js';

// Use the real worker-pool, including its fork boundary. The isolated fixture
// deliberately has no active-session registry, so the real fork refuses with
// session_not_active instead of spawning; reaching that refusal proves drain ran.
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/bot-registry.js')>(),
  getBot: vi.fn(() => ({
    botName: 'Agy', botOpenId: 'ou_bot', resolvedAllowedUsers: ['ou_sender'],
    config: {
      larkAppId: 'app_terminal', larkAppSecret: 'secret', cliId: 'antigravity' as const,
      workingDir: '/tmp', workingDirs: ['/tmp'], replyCardMode: 'legacy' as const,
    },
  })),
  getAllBots: vi.fn(() => []),
  getOwnerOpenId: vi.fn(() => 'ou_sender'),
}));
vi.mock('../src/im/lark/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/im/lark/client.js')>(),
  getMessageDetail: vi.fn(async (_app: string, id: string) => ({ items: [{ message_id: id, deleted: false }] })),
  replyMessage: vi.fn(async () => 'om_fork_seed'),
  sendMessage: vi.fn(async () => 'om_fork_seed'),
  getMessageThreadId: vi.fn(async () => 'omt_fork_terminal'),
  getChatModeStrict: vi.fn(async () => 'topic' as const),
  deleteMessage: vi.fn(async () => true),
}));
vi.mock('../src/services/session-groups-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/session-groups-store.js')>(),
  isSessionGroup: vi.fn(() => true),
}));
vi.mock('../src/core/session-manager.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/session-manager.js')>(),
  getAvailableBots: vi.fn(async () => []),
  getSessionWorkingDir: vi.fn(() => '/tmp'),
  buildNewTopicCliInput: vi.fn((content: string) => ({ content })),
}));
vi.mock('../src/services/session-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/session-store.js')>(),
  updateSession: vi.fn(),
}));

import {
  __testOnly_setupWorkerHandlers,
  initWorkerPool,
  isForkSourceBusy,
} from '../src/core/worker-pool.js';
import { drainQueuedForks, handleCommand, isPendingForkTopic } from '../src/core/command-handler.js';
import { sessionKey } from '../src/core/types.js';

function makeSession(): { ds: DaemonSession; worker: EventEmitter; activeSessions: Map<string, DaemonSession> } {
  const worker = Object.assign(new EventEmitter(), {
    killed: false, send: vi.fn(), kill: vi.fn(), pid: 99999,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
  });
  const ds = {
    session: {
      sessionId: 'sess-terminal', chatId: 'oc_terminal', rootMessageId: 'oc_terminal',
      title: 'Terminal source', status: 'active' as const,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pid: null,
      chatType: 'group' as const, scope: 'chat' as const, cliId: 'antigravity' as const,
      cliSessionId: 'agy-parent', ownerOpenId: 'ou_sender', backendType: 'pty' as const,
    },
    worker: worker as any, workerPort: null, workerToken: null,
    larkAppId: 'app_terminal', chatId: 'oc_terminal', chatType: 'group' as const,
    scope: 'chat' as const, spawnedAt: Date.now(), cliVersion: '1',
    lastMessageAt: Date.now(), hasHistory: true, lastScreenStatus: 'working' as const,
    initConfig: { cliId: 'antigravity' as const, backendType: 'pty' as const },
  } as DaemonSession;
  const activeSessions = new Map([[sessionKey(ds.chatId, ds.larkAppId), ds]]);
  return { ds, worker, activeSessions };
}

describe('queued fork terminal settlement', () => {
  it('drains a real worker terminal with a stale working screen, but not newer live work', async () => {
    const { ds, worker, activeSessions } = makeSession();
    const sessionReply = vi.fn(async () => 'om_notice');
    const deps = {
      activeSessions, sessionReply, getActiveCount: () => 1, lastRepoScan: new Map(),
      canRunQueuedFork: vi.fn(() => true),
    };
    const message: LarkMessage = {
      messageId: 'om_fork_terminal', rootId: '', chatId: ds.chatId,
      senderId: 'ou_sender', senderType: 'user', msgType: 'text', content: '/fork terminal task', createTime: '1',
    };
    await handleCommand('/fork', ds.chatId, message, deps, ds.larkAppId);
    expect(isPendingForkTopic(ds, message.messageId)).toBe(true);
    sessionReply.mockClear();

    let terminalCalls = 0;
    let terminalDone: Promise<void> | undefined;
    initWorkerPool({
      sessionReply, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1,
      closeSession: vi.fn(),
      onTurnTerminal: current => {
        terminalCalls += 1;
        terminalDone = drainQueuedForks(current);
        return terminalDone;
      },
    });
    __testOnly_setupWorkerHandlers(ds, worker as any);
    worker.emit('message', {
      type: 'turn_input_committed', sessionId: ds.session.sessionId, turnId: 'om_busy_turn', dispatchAttempt: 1,
    });
    expect(isForkSourceBusy(ds)).toBe(true);
    worker.emit('message', {
      type: 'turn_terminal', sessionId: ds.session.sessionId, turnId: 'om_busy_turn', dispatchAttempt: 1, status: 'completed',
    });

    await vi.waitFor(() => expect(terminalCalls).toBe(1));
    expect(ds.lastTurnTerminalStatus).toBe('completed');
    expect(isForkSourceBusy(ds)).toBe(false);
    await vi.waitFor(() => expect(deps.canRunQueuedFork).toHaveBeenCalledTimes(1));
    expect(ds.session.cliSessionId).toBe('agy-parent');
    await terminalDone;
    await vi.waitFor(() => expect(isPendingForkTopic(ds, message.messageId)).toBe(false));
    // No registry is installed by design: the REAL fork boundary refuses the
    // execution instead of spawning. Old code never reaches this notice because
    // the terminal-only queue remains pending behind the stale working screen.
    expect(sessionReply).toHaveBeenCalledExactlyOnceWith(ds.chatId, expect.any(String), 'text', ds.larkAppId,
      message.messageId, { replyTarget: { mode: 'thread', rootMessageId: message.messageId } });
    expect(ds.lastScreenStatus).toBe('working');

    ds.currentTurnId = 'om_newer_turn';
    expect(isForkSourceBusy(ds)).toBe(true);
    ds.currentTurnId = undefined;
    ds.postTerminalLiveWorkAt = Date.now();
    expect(isForkSourceBusy(ds)).toBe(true);
    ds.postTerminalLiveWorkAt = undefined;
    expect(isForkSourceBusy(ds)).toBe(false);
    ds.lastTurnTerminalStatus = 'failed';
    expect(isForkSourceBusy(ds)).toBe(true);
  });

  it('holds a terminalized stale-working source until background tasks settle', async () => {
    const { ds, activeSessions } = makeSession();
    ds.lastTurnTerminalStatus = 'completed';
    ds.lastTurnTerminalTurnId = 'om_done';
    ds.lastTurnTerminalAt = Date.now();
    ds.backgroundTaskCount = 1;
    const sessionReply = vi.fn(async () => 'om_notice');
    const deps = {
      activeSessions, sessionReply, getActiveCount: () => 1, lastRepoScan: new Map(),
      canRunQueuedFork: vi.fn(() => true),
    };
    const message: LarkMessage = {
      messageId: 'om_fork_background', rootId: '', chatId: ds.chatId,
      senderId: 'ou_sender', senderType: 'user', msgType: 'text', content: '/fork background task', createTime: '1',
    };
    await handleCommand('/fork', ds.chatId, message, deps, ds.larkAppId);
    expect(isPendingForkTopic(ds, message.messageId)).toBe(true);
    sessionReply.mockClear();

    await drainQueuedForks(ds);
    expect(isPendingForkTopic(ds, message.messageId)).toBe(true);
    expect(deps.canRunQueuedFork).not.toHaveBeenCalled();
    expect(sessionReply).not.toHaveBeenCalled();

    ds.backgroundTaskCount = 0;
    await drainQueuedForks(ds);
    expect(isPendingForkTopic(ds, message.messageId)).toBe(false);
    expect(deps.canRunQueuedFork).toHaveBeenCalledOnce();
    expect(sessionReply).toHaveBeenCalledOnce();
  });
});
