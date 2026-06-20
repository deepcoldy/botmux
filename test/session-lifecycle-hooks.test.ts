import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
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
  __testOnly_resetSessionLifecycleHooks,
  emitSessionLifecycleHook,
  emitSessionStateTransitionHook,
  setSessionLifecycleShutdown,
} from '../src/services/session-lifecycle-hooks.js';
import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

function makeFakeWorker() {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.pid = 12345;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

function makeDs(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: 'sid-lifecycle-test',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Lifecycle Test',
      status: 'active',
      createdAt: new Date('2026-05-27T00:00:00.000Z').toISOString(),
      chatType: 'group',
      cliId: 'claude-code',
      workingDir: '/repo',
    },
    worker: makeFakeWorker(),
    workerPort: 9999,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1234,
    cliVersion: '1.0',
    lastMessageAt: 5678,
    hasHistory: false,
    workingDir: '/repo',
    displayMode: 'hidden',
    streamCardId: 'om_card',
    streamCardNonce: 'nonce',
    lastScreenContent: '',
    lastScreenStatus: 'working',
    currentTurnTitle: 'Lifecycle Test',
    ...overrides,
  } as DaemonSession;
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  __testOnly_resetSessionLifecycleHooks();
});

describe('session lifecycle hook helper', () => {
  it('emits session.start payload with session context', () => {
    emitSessionLifecycleHook(makeDs(), 'session.start', { reason: 'new_topic' });

    expect(emitHookEventMock).toHaveBeenCalledWith('session.start', expect.objectContaining({
      sessionId: 'sid-lifecycle-test',
      chatId: 'oc_chat',
      chatType: 'group',
      larkAppId: 'app_test',
      scope: 'thread',
      anchor: 'om_root',
      title: 'Lifecycle Test',
      cliId: 'claude-code',
      workingDir: '/repo',
      reason: 'new_topic',
    }));
  });

  it('deduplicates repeated session.idle transitions for 10 seconds', () => {
    vi.useFakeTimers();
    const ds = makeDs();

    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);
    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(2);
  });

  it('silences session.exit while daemon shutdown is active', () => {
    setSessionLifecycleShutdown(true);

    emitSessionLifecycleHook(makeDs(), 'session.exit', { reason: 'daemon_shutdown' });

    expect(emitHookEventMock).not.toHaveBeenCalled();
  });

  it('prunes lastIdleEmits entries for the session on session.exit', () => {
    vi.useFakeTimers();
    const ds = makeDs();

    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(1);

    // session.exit should prune dedup state
    emitSessionLifecycleHook(ds, 'session.exit', { reason: 'exit_code_0' });

    // After exit prune, re-idle for same session should fire again immediately
    vi.advanceTimersByTime(0);
    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    // session.exit + second idle = 3 total calls
    expect(emitHookEventMock).toHaveBeenCalledTimes(3);
  });
});

describe('worker-pool lifecycle hook integration', () => {
  beforeEach(() => {
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
  });

  it('emits session.idle on screen_update status edges', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, lastScreenStatus: 'working' });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screen_update', content: 'ready', status: 'idle' });
    await flush();

    expect(emitHookEventMock).toHaveBeenCalledWith('session.idle', expect.objectContaining({
      sessionId: 'sid-lifecycle-test',
      prevState: 'working',
      newState: 'idle',
      source: 'screen_update',
    }));
  });

  it('reuses the idle transition helper for screenshot_uploaded status edges', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, lastScreenStatus: 'working' });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screenshot_uploaded', imageKey: 'img', status: 'idle' });
    await flush();

    expect(emitHookEventMock).toHaveBeenCalledWith('session.idle', expect.objectContaining({
      sessionId: 'sid-lifecycle-test',
      prevState: 'working',
      newState: 'idle',
      source: 'screenshot_uploaded',
    }));
  });

  it('emits session.requires_attention from tui_prompt and user_notify IPC', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'tui_prompt',
      description: 'Approve command?',
      options: [{ text: 'Yes', selected: false }],
      multiSelect: false,
    });
    worker.emit('message', { type: 'user_notify', message: 'Need manual input' });
    await flush();

    expect(emitHookEventMock).toHaveBeenCalledWith('session.requires_attention', expect.objectContaining({
      reason: 'tui_prompt',
      description: 'Approve command?',
      optionsCount: 1,
    }));
    expect(emitHookEventMock).toHaveBeenCalledWith('session.requires_attention', expect.objectContaining({
      reason: 'user_notify',
      message: 'Need manual input',
    }));
  });

  it('emits session.exit from worker process exit', () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('exit', 1);

    expect(emitHookEventMock).toHaveBeenCalledWith('session.exit', expect.objectContaining({
      sessionId: 'sid-lifecycle-test',
      reason: 'exit_code_1',
      code: 1,
    }));
  });
});
