/**
 * P2: daemon-side retry of `final_output` on transient Lark failures.
 *
 * The worker pops each turn off its queue at emit time and never re-sends
 * the same payload, so the daemon owns retry. We verify:
 *   - transient sessionReply rejections retry up to 3 times with backoff
 *   - dedup marker is committed only after a successful send
 *   - MessageWithdrawnError aborts retries (no point), commits dedup, and
 *     closes the session
 *   - 3 consecutive failures give up and DO NOT commit the dedup marker
 *     (so any retransmit can still deliver)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
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
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { initWorkerPool } from '../src/core/worker-pool.js';
import { MessageWithdrawnError } from '../src/im/lark/client.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import { EventEmitter } from 'node:events';

// Build a fake worker child process whose IPC `message` event we can fire
// manually, then wire it through setupWorkerHandlers via forkAdoptWorker.
// To keep this test focused on the retry pipeline (and avoid spawning a
// real fork), we exercise the case branch by invoking the registered
// listener directly.

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
      sessionId: 'sid-final-out',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
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
    adoptedFrom: {
      tmuxTarget: '0:1.0',
      originalCliPid: 1234,
      sessionId: 'claude-session-xyz',
      cliId: 'claude-code' as const,
      cwd: '/tmp',
    },
  };
}

function finalOutputMsg(): Extract<WorkerToDaemon, { type: 'final_output' }> {
  return { type: 'final_output', content: 'final answer', lastUuid: 'uuid-1', turnId: 'turn-1' };
}

describe('Bridge final_output delivery (P2 retry)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('commits dedup uuid only after a successful sessionReply', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    // Drive the case 'final_output' by invoking the registered handler.
    // setupWorkerHandlers attaches handler when a worker is forked, but we
    // bypass that: invoke the callback by emitting a message to the
    // EventEmitter that the live `worker.on('message')` registers. The
    // simplest path is to fork the worker via forkAdoptWorker — but that
    // spawns a real process. Instead we rely on the case branch's
    // self-contained behavior by importing deliverFinalOutput indirectly
    // via firing the IPC 'message' event after attaching a listener that
    // mirrors the case branch.
    //
    // Implementation detail: setupWorkerHandlers is internal; we exercise
    // it by directly calling the IPC entry. Since deliverFinalOutput is
    // file-private, we reach it through the public IPC dispatch.

    const ds = makeDs();
    // Hand-wired dispatcher that mirrors the relevant case branch in
    // setupWorkerHandlers. Keeping it here keeps the test independent of
    // unrelated card/state plumbing.
    const dispatcher = async (msg: WorkerToDaemon) => {
      if (msg.type !== 'final_output') return;
      if (!msg.content || !msg.content.trim()) return;
      if (msg.lastUuid && ds.lastBridgeEmittedUuid === msg.lastUuid) return;
      // Direct call to the public path:
      const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
      __testOnly_deliverFinalOutput(ds, msg, 'tag', 0);
    };

    await dispatcher(finalOutputMsg());
    // First attempt is delayed 0ms; flush microtasks + timers
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBe('uuid-1');
  });

  it('retries on transient failure and commits after success', async () => {
    const sessionReply = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockResolvedValueOnce('om_reply');
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    // Attempt 1 (delay 0)
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();

    // Attempt 2 (delay 5000)
    await vi.advanceTimersByTimeAsync(5000);
    expect(sessionReply).toHaveBeenCalledTimes(2);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();

    // Attempt 3 (delay 15000)
    await vi.advanceTimersByTimeAsync(15000);
    expect(sessionReply).toHaveBeenCalledTimes(3);
    expect(ds.lastBridgeEmittedUuid).toBe('uuid-1');
  });

  it('gives up after 3 attempts and does NOT commit dedup', async () => {
    const sessionReply = vi.fn().mockRejectedValue(new Error('persistent'));
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(15000);

    expect(sessionReply).toHaveBeenCalledTimes(3);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('MessageWithdrawnError aborts retries, commits dedup, and closes session', async () => {
    const sessionReply = vi.fn().mockRejectedValue(new MessageWithdrawnError('om_root'));
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    await vi.advanceTimersByTimeAsync(0);

    // Single attempt, no further retries
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBe('uuid-1');
    expect(closeSession).toHaveBeenCalledWith(ds);
  });

  it('aborts pending retry if the session was closed in the meantime', async () => {
    const sessionReply = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockResolvedValueOnce('om_reply');  // would succeed if a 2nd attempt fired
    const closeSession = vi.fn();
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession,
    });

    const ds = makeDs();
    const { __testOnly_deliverFinalOutput } = await import('../src/core/worker-pool.js') as any;
    __testOnly_deliverFinalOutput(ds, finalOutputMsg(), 'tag', 0);

    // Attempt 1 fails
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionReply).toHaveBeenCalledTimes(1);

    // User closes the session before the 5s retry fires
    ds.session.status = 'closed' as any;

    // Backoff fires — must NOT call sessionReply again
    await vi.advanceTimersByTimeAsync(5000);
    expect(sessionReply).toHaveBeenCalledTimes(1);
    expect(ds.lastBridgeEmittedUuid).toBeUndefined();
  });
});
