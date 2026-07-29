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
  buildBareShellLaunchFailureCard: vi.fn((message: string, sessionId: string, rootId: string, cliId: string, retryNonce: string) => JSON.stringify({
    type: 'bare-shell-launch-failure', message, sessionId, rootId, cliId, retryNonce,
  })),
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
  __testOnly_resetSessionLifecycleHooks,
  emitSessionLifecycleHook,
  emitSessionStateTransitionHook,
  setSessionLifecycleShutdown,
} from '../src/services/session-lifecycle-hooks.js';
import {
  initWorkerPool,
  __testOnly_setupWorkerHandlers,
  __testOnly_resetBareShellLaunchRetries,
  __testOnly_resetRestartCoordinator,
  requestBareShellLaunchRetry,
} from '../src/core/worker-pool.js';
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
  __testOnly_resetBareShellLaunchRetries();
  __testOnly_resetRestartCoordinator();
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

  it('fails closed for dedicated VC receivers while retaining exit dedupe cleanup', () => {
    const ds = makeDs();

    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'ordinary' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(1);

    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      memberId: 'member-1',
      memberEpoch: 1,
    };
    emitSessionLifecycleHook(ds, 'session.requires_attention', {
      reason: 'tui_prompt',
      description: 'meeting-derived secret',
    });
    emitSessionStateTransitionHook(ds, 'working', 'idle', {
      source: 'screen_update',
      content: 'meeting transcript',
    });
    emitSessionLifecycleHook(ds, 'session.exit', { reason: 'exit_code_1' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(1);

    // The suppressed receiver exit still pruned its old idle dedupe key.
    ds.session.vcMeetingReceiver = undefined;
    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'ordinary-again' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(2);
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

  it('renders only bare-shell launch notifications as interactive retry cards', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'user_notify', message: 'ordinary warning', turnId: 'om_normal' });
    worker.emit('message', {
      type: 'user_notify',
      kind: 'bare_shell_launch_failed',
      retryNonce: 'retry-current',
      message: 'launch failed',
      turnId: 'om_failed',
    });
    await flush();

    expect(sessionReply).toHaveBeenNthCalledWith(
      1,
      'om_root',
      'ordinary warning',
      'text',
      'app_test',
      'om_normal',
      undefined,
    );
    expect(sessionReply).toHaveBeenNthCalledWith(
      2,
      'om_root',
      JSON.stringify({
        type: 'bare-shell-launch-failure',
        message: 'launch failed',
        sessionId: 'sid-lifecycle-test',
        rootId: 'om_root',
        cliId: 'claude-code',
        retryNonce: 'retry-current',
      }),
      'interactive',
      'app_test',
      'om_failed',
      undefined,
    );
  });

  it('claims a bare-shell retry once and sends the nonce to the same live worker', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', {
      type: 'user_notify',
      kind: 'bare_shell_launch_failed',
      retryNonce: 'retry-once',
      message: 'launch failed',
      turnId: 'om_failed',
    });
    await flush();

    const observer = { source: 'card' as const, notify: vi.fn() };
    expect(requestBareShellLaunchRetry(ds, 'retry-once', observer)).toBe('started');
    expect(worker.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'restart',
        attemptId: expect.any(String),
        bareShellRetryNonce: 'retry-once',
      }),
      expect.any(Function),
    );
    expect(requestBareShellLaunchRetry(ds, 'retry-once', observer)).toBe('expired');
    expect(worker.send).toHaveBeenCalledTimes(1);
  });

  it('keeps the retry claim valid when the blocked bare shell emits another prompt-ready signal', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', {
      type: 'user_notify',
      kind: 'bare_shell_launch_failed',
      retryNonce: 'retry-after-prompt',
      message: 'launch failed',
    });
    await flush();

    worker.emit('message', { type: 'prompt_ready' });
    await flush();

    expect(requestBareShellLaunchRetry(
      ds,
      'retry-after-prompt',
      { source: 'card', notify: vi.fn() },
    )).toBe('started');
    expect(worker.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'restart',
        bareShellRetryNonce: 'retry-after-prompt',
      }),
      expect.any(Function),
    );
  });

  it('expires the retry when the worker generation changes', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', {
      type: 'user_notify',
      kind: 'bare_shell_launch_failed',
      retryNonce: 'retry-stale',
      message: 'launch failed',
    });
    await flush();

    ds.worker = makeFakeWorker();
    expect(requestBareShellLaunchRetry(
      ds,
      'retry-stale',
      { source: 'card', notify: vi.fn() },
    )).toBe('expired');
    expect(worker.send).not.toHaveBeenCalled();
  });

  it('does not let an older card invalidate the latest retry nonce', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', {
      type: 'user_notify',
      kind: 'bare_shell_launch_failed',
      retryNonce: 'retry-old',
      message: 'old failure',
    });
    worker.emit('message', {
      type: 'user_notify',
      kind: 'bare_shell_launch_failed',
      retryNonce: 'retry-current',
      message: 'current failure',
    });
    await flush();

    const observer = { source: 'card' as const, notify: vi.fn() };
    expect(requestBareShellLaunchRetry(ds, 'retry-old', observer)).toBe('expired');
    expect(requestBareShellLaunchRetry(ds, 'retry-current', observer)).toBe('started');
    expect(worker.send).toHaveBeenCalledTimes(1);
  });

  it('ignores bare-shell notifications from a stale worker generation', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);
    ds.worker = makeFakeWorker();

    worker.emit('message', {
      type: 'user_notify',
      kind: 'bare_shell_launch_failed',
      retryNonce: 'retry-stale-notify',
      message: 'stale launch failed',
    });
    await flush();

    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('routes accepted steer feedback to its exact turn without raising attention', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'steer_accepted',
      appTurnId: 'app-turn-accepted',
      turnId: 'om_exact_steer_message',
    });
    await flush();

    expect(sessionReply).toHaveBeenCalledWith(
      'om_root',
      '收到，引导成功',
      'text',
      'app_test',
      'om_exact_steer_message',
      undefined,
    );
    expect(emitHookEventMock).not.toHaveBeenCalledWith(
      'session.requires_attention',
      expect.anything(),
    );
  });

  it('ignores accepted steer feedback from a replaced worker generation', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeFakeWorker();
    const replacement = makeFakeWorker();
    const ds = makeDs({ worker: replacement });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'steer_accepted',
      appTurnId: 'app-turn-stale',
      turnId: 'om_stale',
    });
    await flush();

    expect(sessionReply).not.toHaveBeenCalled();
    expect(emitHookEventMock).not.toHaveBeenCalled();
  });

  it('does not emit lifecycle hooks for receiver TUI, notifications, status, or exit', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, lastScreenStatus: 'working' });
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      memberId: 'member-1',
      memberEpoch: 1,
    };
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'tui_prompt',
      description: 'Approve meeting action?',
      options: [{ text: 'Yes', selected: false }],
      multiSelect: false,
    });
    worker.emit('message', { type: 'user_notify', message: 'meeting-derived diagnostic' });
    worker.emit('message', { type: 'screen_update', content: 'transcript', status: 'idle' });
    worker.emit('exit', 1);
    await flush();

    expect(emitHookEventMock).not.toHaveBeenCalled();
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

  it('forwards exact durable_expiry_ready evidence with worker generation', async () => {
    const onDurableExpiryReady = vi.fn();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onDurableExpiryReady,
    });
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'durable_expiry_ready',
      sessionId: 'sid-lifecycle-test',
      turnId: 'delivery-1',
      dispatchAttempt: 3,
      disposition: 'queued_removed',
    });
    await flush();

    expect(onDurableExpiryReady).toHaveBeenCalledWith(ds, {
      sessionId: 'sid-lifecycle-test',
      turnId: 'delivery-1',
      dispatchAttempt: 3,
      workerGeneration: 1,
      disposition: 'queued_removed',
    });
  });
});
