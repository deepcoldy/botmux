/**
 * worker-pool: a worker reports that its CLI install changed under the running
 * process (Pi after a global upgrade). The daemon queues the same suspend as
 * `botmux suspend` on a busy session, says so once in the chat, and the next
 * message cold-starts on the new install.
 *
 * Run: bun x vitest run --project unit test/worker-pool-cli-install-changed.test.ts
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { emitHookEventMock } = vi.hoisted(() => ({
  emitHookEventMock: vi.fn(),
}));

vi.mock('../src/services/hook-runner.js', () => ({
  emitHookEvent: (...args: unknown[]) => emitHookEventMock(...args),
}));

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    MessageWithdrawnError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{"type":"streaming"}'),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
  buildTuiPromptCard: vi.fn(() => '{"type":"tui"}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{"type":"tui-resolved"}'),
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
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  ensureSessionWhiteboard: vi.fn(),
  persistStreamCardState: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(() => ({ tokenUsage: null })),
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
  __testOnly_setSuspendBackingVerifier,
} from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

function makeFakeWorker() {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.once = vi.fn();
  worker.pid = 4242;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

function makeDs(worker: any, status: 'idle' | 'working'): DaemonSession {
  return {
    session: {
      sessionId: 'sid-install', rootMessageId: 'om_root', chatId: 'oc_chat', title: 'Upgrade',
      status: 'active', createdAt: new Date('2026-10-20T06:00:00.000Z').toISOString(), chatType: 'group',
      cliId: 'pi', workingDir: '/repo', cliSessionId: 'native-known',
    },
    worker, workerPort: 9999, workerToken: 'tok', larkAppId: 'app_test', chatId: 'oc_chat', chatType: 'group',
    scope: 'thread', spawnedAt: 1, cliVersion: '1.1.0', lastMessageAt: 2, hasHistory: true, workingDir: '/repo',
    displayMode: 'hidden', lastScreenContent: '', lastScreenStatus: status,
    initConfig: { backendType: 'tmux' },
  } as unknown as DaemonSession;
}

const REPORT = { type: 'cli_install_changed', runningVersion: '1.1.0', installedVersion: '1.3.0' };

async function flush(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); }

describe('cli_install_changed', () => {
  let sessionReply: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    // TmuxBackend is mocked as an empty class below; suspend now verifies the
    // backing via a daemon-side kill + post-probe. These cases test the
    // install-change queueing semantics, so the verifier is stubbed exactly as
    // in the other suspendWorker suites (the real verifier has its own tests).
    __testOnly_setSuspendBackingVerifier(() => true);
    sessionReply = vi.fn(async () => 'om_notice');
    initWorkerPool({ sessionReply, getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn() } as any);
  });

  afterEach(() => __testOnly_setSuspendBackingVerifier());

  it('suspends an idle session right away and says why, once', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'idle');
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', REPORT);
    await flush();

    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.worker).toBe(null);
    expect(ds.session.suspendedColdResume).toBe(true);
    expect(ds.pendingSuspendReason).toBeUndefined();
    expect(sessionReply).toHaveBeenCalledTimes(1);
    const [anchor, text, msgType] = sessionReply.mock.calls[0]!;
    expect(anchor).toBe('om_root');
    expect(msgType).toBe('text');
    expect(text).toContain('1.3.0');
    expect(text).toContain('1.1.0');
  });

  it('waits for the running turn: the suspend is queued for this generation, not done', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'working');
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', REPORT);
    await flush();

    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.worker).toBe(worker);
    expect(ds.pendingSuspendReason).toBe('cli_install_changed');
    expect(ds.pendingSuspendGeneration).toBe(ds.workerGeneration);
  });

  it('leaves a manual suspend already queued for this generation in charge', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'working');
    __testOnly_setupWorkerHandlers(ds, worker);
    ds.pendingSuspendReason = 'manual_suspend';
    ds.pendingSuspendGeneration = ds.workerGeneration;

    worker.emit('message', REPORT);
    await flush();

    expect(ds.pendingSuspendReason).toBe('manual_suspend');
  });

  it('ignores a report from a worker that was already replaced', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs(worker, 'idle');
    __testOnly_setupWorkerHandlers(ds, worker);
    const replacement = makeFakeWorker();
    ds.worker = replacement;

    worker.emit('message', REPORT);
    await flush();

    expect(replacement.send).not.toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.pendingSuspendReason).toBeUndefined();
    expect(sessionReply).not.toHaveBeenCalled();
  });
});
