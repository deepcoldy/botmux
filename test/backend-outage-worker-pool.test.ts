/**
 * Daemon side of a lost shared tmux server (worker-pool `case 'claude_exit'`
 * with `backendLost`), driven through the real worker message handlers with
 * fake workers.
 *
 * Before: every such exit went through the per-session crash loop — an
 * immediate restart IPC per session, and after four losses within a minute a
 * "⚠️ … 在 1 分钟内崩溃 4 次，已停止自动重启" text in every topic. Now one
 * outage: no crash count, one interactive status card per topic (patched in
 * place), one canary restart while the server is down, the rest once it is
 * up, and one summary to the owner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  class MessageUpdateExpiredError extends Error {}
  return {
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    MessageWithdrawnError,
    MessageUpdateExpiredError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{"type":"streaming"}'),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
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
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'codex' },
  },
}));

const sessionReplyMock = vi.fn(async (..._args: any[]) => `om_reply_${sessionReplyMock.mock.calls.length}`);
const notifyOwnerMock = vi.fn(async (..._args: any[]) => {});
vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  persistStreamCardState: vi.fn(),
  ensureSessionWhiteboard: vi.fn(),
  rememberLastCliInput: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(),
}));

vi.mock('../src/skills/installer.js', () => ({
  ensureSkills: vi.fn(),
}));

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(),
}));

vi.mock('../src/adapters/cli/claude-code.js', () => ({
  claudeJsonlPathForSession: vi.fn(),
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class {},
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import {
  initWorkerPool,
  __testOnly_setupWorkerHandlers,
  __testOnly_resetRestartCoordinator,
  __testOnly_resetBackendOutage,
  restartCounts,
  setActiveSessionsRegistry,
  isSessionLifecycleInFlight,
  retireWorkerProcessOnly,
} from '../src/core/worker-pool.js';
import { updateMessage } from '../src/im/lark/client.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

function makeFakeWorker() {
  const w = new EventEmitter() as any;
  w.killed = false;
  w.send = vi.fn();
  w.kill = vi.fn();
  w.pid = 12345;
  w.stdout = new EventEmitter();
  w.stderr = new EventEmitter();
  return w;
}

function makeDs(sessionId: string, worker: any): DaemonSession {
  return {
    session: {
      sessionId,
      rootMessageId: `om_root_${sessionId}`,
      chatId: 'oc_chat',
      title: `Topic ${sessionId}`,
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    displayMode: 'hidden',
    lastScreenContent: '',
    lastScreenStatus: 'working',
    currentTurnTitle: 'Test task',
  } as unknown as DaemonSession;
}

function onSocket(ds: DaemonSession, socketName = 'botmux'): DaemonSession {
  (ds.session as any).persistentBackendTarget = { backendType: 'tmux', socketName };
  return ds;
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

async function waitFor(cond: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

const restartsOf = (worker: any) => worker.send.mock.calls.map((c: any[]) => c[0]).filter((m: any) => m.type === 'restart');
const repliesTo = (sessionId: string) => sessionReplyMock.mock.calls.filter(c => c[0] === `om_root_${sessionId}`);
const textReplies = () => sessionReplyMock.mock.calls.filter(c => c[2] === 'text' || c[2] === undefined);
const lostServer = { type: 'claude_exit', code: null, signal: null, canParkDiagnostic: true,
  backendLost: { backend: 'tmux', kind: 'gone', socketName: 'botmux' } };

describe('daemon: a lost tmux server is one backend outage', () => {
  let serverUp = false;
  const sessions: Array<{ ds: DaemonSession; worker: any }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    restartCounts.clear();
    __testOnly_resetRestartCoordinator();
    serverUp = false;
    __testOnly_resetBackendOutage(
      { serverUp: async () => serverUp },
      { gatherMs: 30, serverBackoffMs: [30, 30], summarySettleMs: 60 },
    );
    initWorkerPool({
      sessionReply: sessionReplyMock,
      notifyOwner: notifyOwnerMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 4,
      closeSession: vi.fn(),
    } as any);
    sessions.length = 0;
    const registry = new Map<string, DaemonSession>();
    for (const id of ['sid-a', 'sid-b', 'sid-c', 'sid-d']) {
      const worker = makeFakeWorker();
      const ds = onSocket(makeDs(id, worker));
      __testOnly_setupWorkerHandlers(ds, worker);
      sessions.push({ ds, worker });
      registry.set(activeSessionKey(ds), ds);
    }
    setActiveSessionsRegistry(registry);
  });

  afterEach(() => {
    __testOnly_resetBackendOutage();
    setActiveSessionsRegistry(undefined);
  });

  it('restarts once through a canary, never counts a crash, and keeps one card per topic', async () => {
    for (const { worker } of sessions) worker.emit('message', lostServer);
    await flush();

    // Not the crash loop: no counter, no immediate restart herd.
    for (const { ds, worker } of sessions) {
      expect(restartCounts.has(ds.session.sessionId)).toBe(false);
      expect(restartsOf(worker)).toEqual([]);
    }
    // One interactive status card per topic, no crash text.
    await waitFor(() => sessions.every(({ ds }) => repliesTo(ds.session.sessionId).length === 1), 'cards');
    for (const { ds } of sessions) {
      const [reply] = repliesTo(ds.session.sessionId);
      expect(reply[2]).toBe('interactive');
      expect(String(reply[1])).toContain('tmux server「botmux」');
    }
    expect(textReplies()).toEqual([]);

    // Server still down after the gather window: exactly one canary.
    await waitFor(() => sessions.some(({ worker }) => restartsOf(worker).length > 0), 'canary restart');
    await new Promise(r => setTimeout(r, 20));
    const restarted = sessions.filter(({ worker }) => restartsOf(worker).length > 0);
    expect(restarted).toHaveLength(1);
    const canary = restarted[0];
    // Plain reads: bun's toMatchObject writes an asymmetric matcher back into
    // the inspected object, which would clobber the attempt id used below.
    const canaryRestart = restartsOf(canary.worker)[0];
    expect(canaryRestart.reason).toBe('cli_crash');
    expect(typeof canaryRestart.attemptId).toBe('string');

    // The canary's CLI came back (and with it the server): everyone else follows.
    serverUp = true;
    canary.worker.emit('message', {
      type: 'restart_result', attemptId: restartsOf(canary.worker)[0].attemptId, status: 'succeeded', category: 'prompt_ready',
    });
    await waitFor(() => sessions.every(({ worker }) => restartsOf(worker).length === 1), 'drain restarts');
    for (const { worker } of sessions) {
      if (worker === canary.worker) continue;
      worker.emit('message', {
        type: 'restart_result', attemptId: restartsOf(worker)[0].attemptId, status: 'succeeded', category: 'prompt_ready',
      });
    }

    // Recovered: each topic's card was patched in place, never re-posted.
    await waitFor(() => vi.mocked(updateMessage).mock.calls.filter(c => String(c[2]).includes('已恢复')).length === sessions.length, 'recovered patches');
    for (const { ds } of sessions) expect(repliesTo(ds.session.sessionId)).toHaveLength(1);
    expect(textReplies()).toEqual([]);

    // One owner summary for the whole outage.
    await waitFor(() => notifyOwnerMock.mock.calls.length === 1, 'owner summary');
    await new Promise(r => setTimeout(r, 100));
    expect(notifyOwnerMock).toHaveBeenCalledTimes(1);
    const [appId, summary] = notifyOwnerMock.mock.calls[0];
    expect(appId).toBe('app_test');
    expect(summary).toContain('4 个会话受影响');
    expect(summary).toContain('已恢复 4 个');
  });

  it('repeated server losses never produce the crash-loop notice', async () => {
    const [{ ds, worker }] = sessions;
    serverUp = true;
    for (let i = 0; i < 4; i++) {
      worker.emit('message', lostServer);
      await flush();
    }
    await new Promise(r => setTimeout(r, 120));
    expect(restartCounts.has(ds.session.sessionId)).toBe(false);
    for (const call of sessionReplyMock.mock.calls) {
      expect(String(call[1])).not.toContain('1 分钟内崩溃');
      expect(String(call[1])).not.toContain('已停止自动重启');
    }
    expect(repliesTo(ds.session.sessionId)).toHaveLength(1);
  });

  it('folds the resumed CLI\'s interruption notice and a start failure into the card', async () => {
    const [{ ds, worker }] = sessions;
    serverUp = true;
    worker.emit('message', lostServer);
    await waitFor(() => restartsOf(worker).length === 1, 'restart');
    worker.emit('message', { type: 'error', message: 'tmux new-session failed: error connecting to /tmp/tmux-0/botmux (Connection refused)' });
    await flush();
    // The outage owns the retry: no independent transient-startup re-fork.
    expect(ds.startupAutoRetry).toBeUndefined();
    worker.emit('message', {
      type: 'user_notify', kind: 'restart_interruption',
      message: '⚠️ 会话刚刚重启（Codex 进程中途退出），重启前的工作被中断：上一轮还没做完。已提醒 Codex 检查后继续。',
    });
    worker.emit('message', {
      type: 'restart_result', attemptId: restartsOf(worker)[0].attemptId, status: 'succeeded', category: 'prompt_ready',
    });
    await waitFor(() => vi.mocked(updateMessage).mock.calls.some(c => String(c[2]).includes('已提醒 Codex 检查后继续')), 'notice in card');
    expect(textReplies()).toEqual([]);
    expect(repliesTo(ds.session.sessionId)).toHaveLength(1);
  });

  it('re-queued in-flight inputs are reported only on an outage card, never as a message', async () => {
    const [{ ds, worker }, other] = sessions;
    const requeued = { type: 'inflight_requeued', count: 1, message: '中断时还没处理完的 1 条消息已重新提交给 Codex。' };
    // Ordinary restart (no outage): nothing is posted.
    other!.worker.emit('message', requeued);
    await flush();
    expect(repliesTo(other!.ds.session.sessionId)).toEqual([]);

    serverUp = true;
    worker.emit('message', lostServer);
    await waitFor(() => restartsOf(worker).length === 1, 'restart');
    worker.emit('message', requeued);
    worker.emit('message', {
      type: 'restart_result', attemptId: restartsOf(worker)[0].attemptId, status: 'succeeded', category: 'prompt_ready',
    });
    await waitFor(() => vi.mocked(updateMessage).mock.calls.some(c => String(c[2]).includes('已重新提交给 Codex')), 'requeue note in card');
    expect(repliesTo(ds.session.sessionId)).toHaveLength(1);
    expect(textReplies()).toEqual([]);
  });

  it('a non-transient start failure during recovery is not posted on its own either', async () => {
    const [{ ds, worker }] = sessions;
    serverUp = true;
    worker.emit('message', lostServer);
    await waitFor(() => restartsOf(worker).length === 1, 'restart');
    worker.emit('message', { type: 'error', message: 'spawn /opt/cli/bin/hermes ENOENT' });
    await flush();
    await new Promise(r => setTimeout(r, 20));
    expect(textReplies()).toEqual([]);
    expect(repliesTo(ds.session.sessionId)).toHaveLength(1);
  });

  it('a worker that dies before ready during recovery posts no start-failure notice', async () => {
    const [{ ds, worker }] = sessions;
    worker.emit('message', lostServer);
    await flush();
    worker.emit('exit', 1, null);
    await flush();
    await new Promise(r => setTimeout(r, 20));
    expect(textReplies()).toEqual([]);
    expect(repliesTo(ds.session.sessionId)).toHaveLength(1);
  });

  // tmux shuts an EMPTY server down cleanly: a lone session whose own CLI
  // exited 0 leaves the same "nobody listens" answer as a crash. With no other
  // session of ours on that server it is the CLI's own exit, not an outage.
  it('a `gone` server that held no other session of ours is an ordinary CLI exit', async () => {
    const [{ ds, worker }, ...others] = sessions;
    for (const other of others) (other.ds.session as any).persistentBackendTarget = { backendType: 'tmux', socketName: 'elsewhere' };
    worker.emit('message', { ...lostServer, code: 0 });
    await flush();
    expect(restartCounts.get(ds.session.sessionId)?.count).toBe(1);
    expect(restartsOf(worker)).toHaveLength(1);
    expect(repliesTo(ds.session.sessionId)).toEqual([]);
  });

  it('a session already in an outage corroborates the next `gone` report', async () => {
    const [a, b] = sessions;
    for (const other of sessions.slice(1)) (other.ds.session as any).persistentBackendTarget = { backendType: 'tmux', socketName: 'elsewhere' };
    // a's report is corroborated by b still being on the socket at that time…
    (b!.ds.session as any).persistentBackendTarget = { backendType: 'tmux', socketName: 'botmux' };
    a!.worker.emit('message', lostServer);
    await flush();
    // …and b's own later report by the outage a opened.
    (b!.ds.session as any).persistentBackendTarget = { backendType: 'tmux', socketName: 'elsewhere' };
    b!.worker.emit('message', lostServer);
    await flush();
    for (const s of [a!, b!]) {
      expect(restartCounts.has(s.ds.session.sessionId)).toBe(false);
      expect(restartsOf(s.worker)).toEqual([]);
    }
  });

  it('an ordinary CLI exit still goes through the crash loop', async () => {
    const [{ ds, worker }] = sessions;
    worker.emit('message', { type: 'claude_exit', code: 1, signal: null });
    await flush();
    expect(restartCounts.get(ds.session.sessionId)?.count).toBe(1);
    expect(restartsOf(worker)).toHaveLength(1);
    expect(repliesTo(ds.session.sessionId)).toEqual([]);
  });

  for (const kind of ['worker-less', 'cold-resume', 'parked'] as const) {
    it(`a ${kind} row does not corroborate a clean empty-server exit`, async () => {
      const [a, b, ...others] = sessions;
      for (const other of others) (other.ds.session as any).persistentBackendTarget = { backendType: 'tmux', socketName: 'elsewhere' };
      if (kind === 'worker-less') b!.ds.worker = null;
      if (kind === 'cold-resume') b!.ds.session.suspendedColdResume = true;
      if (kind === 'parked') b!.ds.crashDiagnosticParked = true;
      a!.worker.emit('message', { ...lostServer, code: 0 });
      await flush();
      expect(restartCounts.get(a!.ds.session.sessionId)?.count).toBe(1);
      expect(restartsOf(a!.worker)).toHaveLength(1);
      expect(repliesTo(a!.ds.session.sessionId)).toEqual([]);
    });
  }

  it('an old episode alone does not corroborate a clean exit after its other members go cold', async () => {
    __testOnly_resetBackendOutage({ serverUp: async () => serverUp }, { gatherMs: 30, serverBackoffMs: [30, 30], summarySettleMs: 1_000 });
    const [a, b, ...others] = sessions;
    serverUp = true;
    for (const other of others) (other.ds.session as any).persistentBackendTarget = { backendType: 'tmux', socketName: 'elsewhere' };
    a!.worker.emit('message', lostServer);
    b!.worker.emit('message', lostServer);
    await waitFor(() => restartsOf(a!.worker).length === 1 && restartsOf(b!.worker).length === 1, 'initial outage restarts');
    for (const member of [a!, b!]) {
      member.worker.emit('message', {
        type: 'restart_result', attemptId: restartsOf(member.worker)[0].attemptId, status: 'succeeded', category: 'prompt_ready',
      });
    }
    await flush();
    b!.ds.worker = null;
    b!.ds.session.suspendedColdResume = true;
    a!.worker.emit('message', { ...lostServer, code: 0 });
    await flush();
    expect(restartCounts.get(a!.ds.session.sessionId)?.count).toBe(1);
    expect(restartsOf(a!.worker)).toHaveLength(2);
  });

  it('a cancelled recovery does not restart a replacement that is ready but not prompt-ready', async () => {
    const [{ ds, worker }, ...others] = sessions;
    for (const other of others.slice(1)) (other.ds.session as any).persistentBackendTarget = { backendType: 'tmux', socketName: 'elsewhere' };
    serverUp = true;
    worker.emit('message', lostServer);
    await waitFor(() => restartsOf(worker).length === 1, 'outage restart');

    retireWorkerProcessOnly(ds, 'test replacement');
    const replacement = makeFakeWorker();
    ds.worker = replacement;
    ds.workerReady = true; // process-level ready landed…
    ds.cliReady = false; // …but the CLI prompt has not arrived yet
    __testOnly_setupWorkerHandlers(ds, replacement);
    worker.emit('exit', null, null); // release the old retirement marker
    await flush();
    await new Promise(r => setTimeout(r, 80));
    expect(restartsOf(replacement)).toEqual([]);

    replacement.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(restartsOf(replacement)).toEqual([]);
    expect(ds.cliReady).toBe(true);
  });

  it('prompt-ready after a parked outage retry releases the lifecycle fence', async () => {
    const [{ ds, worker }, ...others] = sessions;
    for (const other of others.slice(1)) (other.ds.session as any).persistentBackendTarget = { backendType: 'tmux', socketName: 'elsewhere' };
    serverUp = true;
    worker.emit('message', lostServer);
    await waitFor(() => restartsOf(worker).length === 1, 'first restart');
    worker.emit('message', { type: 'restart_result', attemptId: restartsOf(worker)[0].attemptId, status: 'failed' });
    await waitFor(() => restartsOf(worker).length === 2, 'second restart');
    worker.emit('message', { type: 'restart_result', attemptId: restartsOf(worker)[1].attemptId, status: 'failed' });
    await waitFor(() => ds.crashDiagnosticParked === true, 'parked worker');
    worker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(ds.cliReady).toBe(true);
    expect(ds.workerReady).toBe(true);
    expect(ds.crashDiagnosticParked).toBeUndefined();
    expect(isSessionLifecycleInFlight(ds)).toBe(false);
  });
});
