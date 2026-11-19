import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: Error,
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Codex'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'codex' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'pty', cliId: 'codex' },
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
  Client: vi.fn(),
  WSClient: vi.fn(),
  EventDispatcher: vi.fn(),
  LoggerLevel: { info: 2 },
}));

/** Session replies are observed without publishing real Lark messages. */
const sessionReplyMock = vi.fn(async () => 'om_reply');
import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { EventEmitter } from 'node:events';

/** Create one live worker whose generation is assigned by the real IPC setup. */
function makeDs(): DaemonSession {
  /** Event emitter implements only the process surfaces used by production handlers. */
  const fakeWorker = new EventEmitter() as any;
  fakeWorker.killed = false;
  fakeWorker.send = vi.fn();
  fakeWorker.kill = vi.fn();
  fakeWorker.pid = 99999;
  fakeWorker.stdout = new EventEmitter();
  fakeWorker.stderr = new EventEmitter();
  /** Active session contains the routing and identity required by lifecycle ownership. */
  const ds: DaemonSession = {
    session: {
      sessionId: 'sid-async-settle',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: 'claude-code',
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
  return ds;
}


import { runningLongTasks } from '../src/core/long-task-reminder.js';

/** Drive real worker IPC handlers; all application side effects are already mocked above. */
function lifecycle() {
  /** Fresh runtime prevents state leaking between retirement sequences. */
  const ds = makeDs();
  initWorkerPool({ sessionReply: sessionReplyMock, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() } as any);
  __testOnly_setupWorkerHandlers(ds, ds.worker as any);
  /** Await the actual handler directly so each transition completes deterministically. */
  const message = (ds.worker as any).listeners('message')[0];
  return { ds, message };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(600_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('independent execution retirement probes', () => {
  it('ignores a late first start whose exact terminal was already observed', async () => {
    /** A terminal may arrive without an earlier persisted/native execution observation. */
    const h = lifecycle();
    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_late', dispatchAttempt: 1, status: 'completed' });
    await h.message({ type: 'turn_execution_started', turnId: 'om_late', dispatchAttempt: 1, startedAtMs: 0 });
    expect(runningLongTasks(h.ds)).toEqual([]);
  });

  it('rejects a late start predating a legacy terminal while allowing a later fresh attempt', async () => {
    /** The attempt-less terminal closes any input that began before its receipt. */
    const h = lifecycle();
    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_legacy', status: 'completed' });
    await h.message({ type: 'turn_execution_started', turnId: 'om_legacy', dispatchAttempt: 1, startedAtMs: 0 });
    expect(runningLongTasks(h.ds)).toEqual([]);
    vi.setSystemTime(660_000);
    await h.message({ type: 'turn_execution_started', turnId: 'om_legacy', dispatchAttempt: 2, startedAtMs: 660_000 });
    expect(runningLongTasks(h.ds)).toHaveLength(1);
    expect(runningLongTasks(h.ds)[0].executionKey).toBe(JSON.stringify(['om_legacy', 2]));
  });

  it('does not revive a terminal clock after a late start and bounded terminal-set eviction', async () => {
    /** Drive native starts and terminals through the same production worker generation. */
    const h = lifecycle();
    await h.message({ type: 'turn_execution_started', turnId: 'om_old', dispatchAttempt: 1, startedAtMs: 0 });
    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_old', dispatchAttempt: 1, status: 'completed' });
    expect(runningLongTasks(h.ds)).toEqual([]);
    await h.message({ type: 'turn_execution_started', turnId: 'om_old', dispatchAttempt: 1, startedAtMs: 0 });
    /** Exceed the identity tombstone retention while keeping the execution clock retained. */
    for (let index = 0; index < 65; index++) {
      await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: `om_finished_${index}`, status: 'completed' });
    }
    expect(h.ds.terminalIdentityTurnIds?.has('om_old')).toBe(false);
    expect(runningLongTasks(h.ds)).toEqual([]);
  });

  it('does not revive an attempt clock when a compatibility terminal omits attempt and its tombstone expires', async () => {
    /** Drive native starts and terminals through the same production worker generation. */
    const h = lifecycle();
    await h.message({ type: 'turn_execution_started', turnId: 'om_old', dispatchAttempt: 1, startedAtMs: 0 });
    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_old', status: 'completed' });
    expect(runningLongTasks(h.ds)).toEqual([]);
    /** Exceed the identity tombstone retention while keeping the execution clock retained. */
    for (let index = 0; index < 65; index++) {
      await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: `om_finished_${index}`, status: 'completed' });
    }
    expect(runningLongTasks(h.ds)).toEqual([]);
  });

  it('does not let a prior generation terminal suppress a newly observed replacement execution', async () => {
    /** Drive native starts and terminals through the same production worker generation. */
    const h = lifecycle();
    await h.message({ type: 'turn_execution_started', turnId: 'om_restart', dispatchAttempt: 1, startedAtMs: 0 });
    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_restart', dispatchAttempt: 1, status: 'failed' });
    /** A different process advances generation through the actual reservation path. */
    const replacement = makeDs().worker;
    h.ds.worker = replacement;
    __testOnly_setupWorkerHandlers(h.ds, replacement as any);
    /** Replacement events must remain eligible even if its predecessor later emits terminal. */
    const replacementMessage = (replacement as any).listeners('message')[0];
    await replacementMessage({ type: 'turn_execution_started', turnId: 'om_restart', dispatchAttempt: 1, startedAtMs: 600_000 });
    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_restart', dispatchAttempt: 1, status: 'failed' });
    expect(runningLongTasks(h.ds)).toHaveLength(1);
    expect(runningLongTasks(h.ds)[0].workerGeneration).toBe(2);
  });

  it('accepts a fresh attempt of the same turn while ignoring its already-completed predecessor', async () => {
    /** Drive native starts and terminals through the same production worker generation. */
    const h = lifecycle();
    await h.message({ type: 'turn_execution_started', turnId: 'om_retry', dispatchAttempt: 1, startedAtMs: 0 });
    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_retry', dispatchAttempt: 1, status: 'failed' });
    await h.message({ type: 'turn_execution_started', turnId: 'om_retry', dispatchAttempt: 2, startedAtMs: 600_000 });
    /** The latest exact attempt must survive the older turn-level identity tombstone. */
    const live = runningLongTasks(h.ds);
    expect(live).toHaveLength(1);
    expect(live[0].executionKey).toBe(JSON.stringify(['om_retry', 2]));
  });
});
