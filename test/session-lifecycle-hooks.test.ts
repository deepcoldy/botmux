import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { emitHookEventMock, botConfig } = vi.hoisted(() => ({
  emitHookEventMock: vi.fn(),
  botConfig: {
    larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code',
    silentTurnReactions: undefined as boolean | undefined,
  },
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
    config: botConfig,
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
  __testOnly_resetSessionLifecycleHooks,
  emitSessionLifecycleHook,
  emitSessionStateTransitionHook,
  setSessionLifecycleShutdown,
} from '../src/services/session-lifecycle-hooks.js';
import {
  detachWorkerForTransfer,
  updateCodexAppEffort,
  updateCodexCliEffort,
  initWorkerPool,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { logger } from '../src/utils/logger.js';
import { updateSession } from '../src/services/session-store.js';
import { getBot } from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
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
  botConfig.silentTurnReactions = undefined;
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

  it('mutes only the Lark push for codex_app_no_progress when the live bot opts out', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const botWith = (noProgressNotify?: { enabled: boolean }) => ({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', ...(noProgressNotify ? { noProgressNotify } : {}) },
      resolvedAllowedUsers: [],
      botOpenId: 'ou_bot',
      botName: 'TestBot',
    });
    const restoreGetBot = vi.mocked(getBot).mockImplementation(() => botWith() as never);

    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    // Muted: the attention hook still fires, but no Lark reply is sent.
    vi.mocked(getBot).mockImplementation(() => botWith({ enabled: false }) as never);
    worker.emit('message', { type: 'user_notify', kind: 'codex_app_no_progress', message: 'nudge stalled' });
    await flush();
    expect(emitHookEventMock).toHaveBeenCalledWith('session.requires_attention', expect.objectContaining({
      reason: 'user_notify',
      message: 'nudge stalled',
    }));
    expect(sessionReply).not.toHaveBeenCalled();

    // Unmuted (config read is live): the same nudge goes through.
    vi.mocked(getBot).mockImplementation(() => botWith({ enabled: true }) as never);
    worker.emit('message', { type: 'user_notify', kind: 'codex_app_no_progress', message: 'nudge delivered' });
    await flush();
    expect(sessionReply).toHaveBeenCalledTimes(1);

    // Plain user_notify without the kind is never affected by the opt-out.
    vi.mocked(getBot).mockImplementation(() => botWith({ enabled: false }) as never);
    worker.emit('message', { type: 'user_notify', message: 'unrelated warning' });
    await flush();
    expect(sessionReply).toHaveBeenCalledTimes(2);

    restoreGetBot.mockRestore();
  });

  it('repaints the status card from current state when an input was not submitted', async () => {
    const { buildStreamingCard } = await import('../src/im/lark/card-builder.js');
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeFakeWorker();
    // The working→idle edge already happened; only its card PATCH was lost.
    const ds = makeDs({ worker, workerReady: true, lastScreenStatus: 'idle', currentTurnId: 'om_turn' });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'user_notify', message: 'plain warning', turnId: 'om_turn' });
    await flush();
    expect(buildStreamingCard).not.toHaveBeenCalled();

    worker.emit('message', { type: 'user_notify', kind: 'input_not_submitted', message: 'not submitted', turnId: 'om_turn' });
    await flush();
    expect(buildStreamingCard).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildStreamingCard).mock.calls[0]![5]).toBe('idle');
    expect(sessionReply).toHaveBeenCalledTimes(2);

    // A late notice about an older turn must not repaint the current turn's card.
    worker.emit('message', { type: 'user_notify', kind: 'input_not_submitted', message: 'stale', turnId: 'om_older' });
    await flush();
    expect(buildStreamingCard).toHaveBeenCalledTimes(1);
  });

  it('emits session.requires_attention from user_notify IPC', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'user_notify', message: 'Need manual input' });
    await flush();

    expect(emitHookEventMock).toHaveBeenCalledWith('session.requires_attention', expect.objectContaining({
      reason: 'user_notify',
      message: 'Need manual input',
    }));
  });

  it.each([undefined, false, true])('routes accepted steer feedback with silentTurnReactions=%s without raising attention', async (silent) => {
    botConfig.silentTurnReactions = silent;
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

    if (silent) {
      expect(sessionReply).not.toHaveBeenCalled();
    } else {
      expect(sessionReply).toHaveBeenCalledWith(
        'om_root',
        '收到，引导成功',
        'text',
        'app_test',
        'om_exact_steer_message',
        { sourceSessionId: 'sid-lifecycle-test' },
      );
    }
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

  it('does not emit lifecycle hooks for receiver notifications, status, or exit', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, lastScreenStatus: 'working' });
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      memberId: 'member-1',
      memberEpoch: 1,
    };
    __testOnly_setupWorkerHandlers(ds, worker);

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

  it('reconciles a remote rebuild when its backend exits after worker ready', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    ds.session.cliId = 'remote-runner';
    ds.session.backendType = 'remote-runner';
    ds.suppressRecoveryCard = true;
    const reconcile = vi.fn(async () => true);
    __testOnly_setupWorkerHandlers(ds, worker, {
      ready: true,
      failureNotified: false,
      onRemoteBackendStartupExit: reconcile,
    } as any);

    worker.emit('message', {
      type: 'claude_exit',
      code: 1,
      signal: null,
    });
    await flush();

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(worker.kill).toHaveBeenCalledWith('SIGTERM');
    expect(ds.worker).toBeNull();
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('keeps remote rebuild reconciliation armed while canonical commit is pending', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    ds.session.cliId = 'remote-runner';
    ds.session.backendType = 'remote-runner';
    ds.session.remoteBackendState = {
      version: 1,
      provider: 'reference',
      generation: 2,
    };
    ds.suppressRecoveryCard = true;
    const reconcile = vi.fn(() => true);
    const startupState = {
      ready: true,
      failureNotified: false,
      onRemoteBackendStartupExit: reconcile,
    };
    __testOnly_setupWorkerHandlers(ds, worker, startupState as any);

    worker.emit('message', {
      type: 'remote_backend_state',
      state: {
        version: 1,
        provider: 'reference',
        generation: 3,
        remoteSessionId: 'replacement',
      },
    });
    await flush();

    expect(ds.session.remoteBackendState?.generation).toBe(3);
    expect(startupState.onRemoteBackendStartupExit).toBe(reconcile);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('retires an exited remote provider after canonical commit without replaying startup rollback', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    ds.session.cliId = 'remote-runner';
    ds.session.backendType = 'remote-runner';
    ds.suppressRecoveryCard = undefined;
    const reconcile = vi.fn(async () => true);
    __testOnly_setupWorkerHandlers(ds, worker, {
      ready: true,
      failureNotified: false,
      onRemoteBackendStartupExit: reconcile,
    } as any);

    worker.emit('message', {
      type: 'claude_exit',
      code: 1,
      signal: null,
    });
    await flush();

    expect(reconcile).not.toHaveBeenCalled();
    expect(worker.kill).toHaveBeenCalledWith('SIGTERM');
    expect(ds.worker).toBeNull();
    expect(sessionReply).toHaveBeenCalledOnce();
    expect(sessionReply.mock.calls[0]?.[1]).toEqual(expect.stringContaining('不支持重启'));
  });

  it('keeps remote rebuild reconciliation armed for the initial same-generation state replay', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    ds.session.cliId = 'remote-runner';
    ds.session.backendType = 'remote-runner';
    ds.session.remoteBackendState = {
      version: 1,
      provider: 'reference',
      generation: 2,
    };
    ds.suppressRecoveryCard = true;
    const reconcile = vi.fn(async () => true);
    const startupState = {
      ready: true,
      failureNotified: false,
      onRemoteBackendStartupExit: reconcile,
    };
    __testOnly_setupWorkerHandlers(ds, worker, startupState as any);

    worker.emit('message', {
      type: 'remote_backend_state',
      state: {
        version: 1,
        provider: 'reference',
        generation: 2,
      },
    });
    await flush();

    expect(startupState.onRemoteBackendStartupExit).toBe(reconcile);
    expect(reconcile).not.toHaveBeenCalled();

    worker.emit('message', {
      type: 'claude_exit',
      code: 1,
      signal: null,
    });
    await flush();

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(worker.kill).toHaveBeenCalledWith('SIGTERM');
    expect(ds.worker).toBeNull();
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it.each(['preparing', 'uncertain'] as const)(
    'keeps a latched mojo %s close fence when the provider exits (fence clearing is remote-runner-only)',
    async phase => {
      const sessionReply = vi.fn(async () => 'om_reply');
      initWorkerPool({
        sessionReply,
        getSessionWorkingDir: () => '/repo',
        getActiveCount: () => 1,
        closeSession: vi.fn(),
      });
      const worker = makeFakeWorker();
      const ds = makeDs({ worker });
      ds.session.cliId = 'mojo';
      ds.session.backendType = 'mojo';
      ds.remoteCloseState = { phase, requestId: 'mojo-close-req', taskId: 'sid-mojo' };
      __testOnly_setupWorkerHandlers(ds, worker, {
        ready: true,
        failureNotified: false,
      } as any);

      worker.emit('message', {
        type: 'claude_exit',
        code: 1,
        signal: null,
      });
      await flush();

      // The dead provider worker is still retired, but the mojo close verdict
      // must survive for durable journal reconciliation: clearing an in-flight
      // fence on provider exit is deliberately scoped to remote-runner.
      expect(worker.kill).toHaveBeenCalledWith('SIGTERM');
      expect(ds.worker).toBeNull();
      expect(ds.remoteCloseState).toEqual({
        phase,
        requestId: 'mojo-close-req',
        taskId: 'sid-mojo',
      });
    },
  );

  it('clears the persisted terminal port and Dashboard proxy state on worker exit', () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    ds.session.webPort = 9999;
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('exit', 1);

    expect(ds.workerPort).toBe(null);
    expect(ds.session.webPort).toBeUndefined();
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
    expect(dashboardEventBus.publish).toHaveBeenCalledWith({
      type: 'session.update',
      body: {
        sessionId: 'sid-lifecycle-test',
        patch: { webPort: null, workerPid: null },
      },
    });
  });

  it('suppresses external exit events for an intentional transfer detach', async () => {
    const onWorkerExit = vi.fn();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onWorkerExit,
    });
    const worker = makeFakeWorker();
    worker.connected = true;
    worker.exitCode = null;
    worker.signalCode = null;
    worker.send = vi.fn((
      message: { type: string; requestId?: string },
      callback?: (error: Error | null) => void,
    ) => {
      callback?.(null);
      if (message.type !== 'detach_for_transfer') return;
      queueMicrotask(() => {
        worker.emit('message', {
          type: 'transfer_detached',
          requestId: message.requestId,
        });
        worker.exitCode = 0;
        worker.emit('exit', 0, null);
      });
    });
    const ds = makeDs({ worker, lastScreenStatus: 'idle' });
    __testOnly_setupWorkerHandlers(ds, worker);

    await expect(detachWorkerForTransfer(ds, { timeoutMs: 100 })).resolves.toBe(true);

    expect(onWorkerExit).not.toHaveBeenCalled();
    expect(emitHookEventMock).not.toHaveBeenCalledWith(
      'session.exit',
      expect.anything(),
    );
    expect(dashboardEventBus.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.exited' }),
    );
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

  it('exit handler isolates sessionStore.updateSession failures without skipping reconciliation', async () => {
    const onWorkerExit = vi.fn();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onWorkerExit,
    });
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    // Simulate a durable row-persist failure (SQLite busy timeout, disk full).
    // The crash vector: the daemon has no global uncaughtException trap, so a
    // throwing exit handler would take down every other session.
    vi.mocked(updateSession).mockImplementationOnce(() => {
      throw new Error('database is locked (SQLITE_BUSY: busy timeout)');
    });

    // The emit must NOT throw — the narrow try/catch around the persistence
    // write isolates the failure and logs it instead of propagating.
    expect(() => worker.emit('exit', 1, null)).not.toThrow();
    await flush();

    // The persistence failure was logged at the narrow catch site.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist worker exit generation'),
    );
    // Durable-exit reconciliation still ran exactly once despite the write failure.
    expect(onWorkerExit).toHaveBeenCalledTimes(1);
    expect(onWorkerExit).toHaveBeenCalledWith(
      ds,
      expect.objectContaining({ sessionId: 'sid-lifecycle-test', code: 1 }),
    );
    // The dashboard dormant-update and the session.exit lifecycle hook still
    // fired exactly once: an active row's worker death publishes session.update
    // (dormant) rather than session.exited (see worker-exit-dashboard-event.ts).
    const dormantPublishes = dashboardEventBus.publish.mock.calls.filter(
      ([event]) => (event as { type?: string; body?: { patch?: { status?: string } } })
        .body?.patch?.status === 'dormant',
    );
    expect(dormantPublishes).toHaveLength(1);
    expect(emitHookEventMock).toHaveBeenCalledWith(
      'session.exit',
      expect.objectContaining({ sessionId: 'sid-lifecycle-test', reason: 'exit_code_1' }),
    );
  });
});

describe('Codex App effort IPC', () => {
  it('correlates the receipt while keeping a busy business turn intact', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerReady: true, cliReady: true, lastScreenStatus: 'working' });
    ds.session.cliId = 'codex-app';
    const before = { ...ds };
    const pending = updateCodexAppEffort(ds, 'high');
    const request = worker.send.mock.calls[0][0];
    expect(request).toMatchObject({ type: 'codex_app_effort', effort: 'high' });
    worker.emit('message', { type: 'codex_app_effort_result', requestId: 'another-request', status: 'error' });
    expect(worker.listenerCount('message')).toBe(1);
    worker.emit('message', { type: 'codex_app_effort_result', requestId: request.requestId, status: 'applied' });
    expect(await pending).toMatchObject({ status: 'applied' });
    expect(worker.listenerCount('message')).toBe(0);
    expect(worker.listenerCount('exit')).toBe(0);
    expect(worker.send).toHaveBeenCalledTimes(1);
    expect(ds).toEqual(before);
  });

  it.each(['timeout', 'exit', 'replacement'] as const)('cleans up on %s without accepting a stale success', async mode => {
    vi.useFakeTimers();
    try {
      const worker = makeFakeWorker();
      const ds = makeDs({ worker, workerReady: true, cliReady: true });
      ds.session.cliId = 'codex-app';
      const pending = updateCodexAppEffort(ds, 'high', 100);
      const request = worker.send.mock.calls[0][0];
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(100);
      else if (mode === 'exit') worker.emit('exit', 1);
      else {
        ds.worker = makeFakeWorker();
        worker.emit('message', { type: 'codex_app_effort_result', requestId: request.requestId, status: 'applied' });
      }
      expect(await pending).toEqual({ status: 'error' });
      expect(worker.listenerCount('message')).toBe(0);
      expect(worker.listenerCount('exit')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['codex-app', 'codex'] as const)('uses the frozen %s CLI before session and init config', async cliId => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerReady: true, cliReady: true });
    ds.session.cliId = cliId === 'codex-app' ? 'codex' : 'codex-app';
    ds.initConfig = { cliId: ds.session.cliId } as NonNullable<DaemonSession['initConfig']>;
    ds.session.cliLaunchSnapshot = {
      version: 1, state: 'pending', entryId: cliId, cliId, cliRuntime: null,
      cliPathOverride: null, wrapperCli: null, model: null, reasoningEffort: null,
      launchShell: null, startupCommands: [],
    };
    const pending = updateCodexAppEffort(ds, 'high');
    if (cliId === 'codex-app') {
      const request = worker.send.mock.calls[0][0];
      worker.emit('message', {
        type: 'codex_app_effort_result', requestId: request.requestId,
        status: 'future_only', reason: 'step_model_switching_disabled',
      });
      expect(await pending).toMatchObject({ status: 'future_only', reason: 'step_model_switching_disabled' });
    } else {
      expect(await pending).toEqual({ status: 'unavailable' });
      expect(worker.send).not.toHaveBeenCalled();
    }
  });

  it('rejects unready and ordinary CLI sessions before sending', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerReady: true, cliReady: true });
    expect(await updateCodexAppEffort(ds, 'high')).toEqual({ status: 'unavailable' });
    ds.session.cliId = 'codex-app';
    ds.cliReady = false;
    expect(await updateCodexAppEffort(ds, 'high')).toEqual({ status: 'unavailable' });
    expect(worker.send).not.toHaveBeenCalled();
  });
});


describe('Codex CLI effort IPC', () => {
  function fixture() {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerReady: true, cliReady: true, activeReasoningEffort: 'high' });
    ds.session.cliId = 'codex';
    ds.session.backendType = 'tmux';
    ds.session.reasoningEffort = 'high';
    ds.session.cliLaunchSnapshot = { cliId: 'codex', reasoningEffort: 'high' } as any;
    ds.initConfig = { cliId: 'codex', backendType: 'tmux', reasoningEffort: 'high' } as any;
    return { worker, ds };
  }

  it('persists confirmed future effort without changing the running turn or killing it', async () => {
    const { worker, ds } = fixture();
    const pending = updateCodexCliEffort(ds, 'max');
    const request = worker.send.mock.calls[0][0];
    expect(request).toMatchObject({ type: 'codex_cli_effort', effort: 'max' });
    expect(ds.session.reasoningEffort).toBe('high');
    worker.emit('message', { type: 'codex_cli_effort_result', requestId: request.requestId, status: 'future_only', reason: 'cli_next_turn' });
    expect(await pending).toMatchObject({ status: 'future_only' });
    expect(ds.session.reasoningEffort).toBe('max');
    expect(ds.session.cliLaunchSnapshot?.reasoningEffort).toBe('max');
    expect(ds.initConfig?.reasoningEffort).toBe('max');
    expect(ds.activeReasoningEffort).toBe('high');
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
    expect(worker.kill).not.toHaveBeenCalled();
  });

  it('rolls back the saved preference if durable storage rejects the update', async () => {
    const { worker, ds } = fixture();
    vi.mocked(sessionStore.updateSession).mockImplementationOnce(() => { throw new Error('disk full'); });
    const pending = updateCodexCliEffort(ds, 'max');
    const request = worker.send.mock.calls[0][0];
    worker.emit('message', { type: 'codex_cli_effort_result', requestId: request.requestId, status: 'future_only', reason: 'cli_next_turn' });
    expect(await pending).toEqual({ status: 'error' });
    expect(ds.session.reasoningEffort).toBe('high');
    expect(ds.session.cliLaunchSnapshot?.reasoningEffort).toBe('high');
    expect(ds.initConfig?.reasoningEffort).toBe('high');
    expect(ds.codexCliEffortConfirmed).toBeUndefined();
  });

  it('allows explicit sandbox off and rejects active sandbox modes before IPC', async () => {
    const { worker, ds } = fixture();
    for (const sandbox of [true, 'oncall', 'scratch'] as const) {
      ds.initConfig!.sandbox = sandbox;
      expect(await updateCodexCliEffort(ds, 'max')).toMatchObject({ status: 'unavailable' });
    }
    expect(worker.send).not.toHaveBeenCalled();
    ds.initConfig!.sandbox = 'off';
    const pending = updateCodexCliEffort(ds, 'max');
    const request = worker.send.mock.calls[0][0];
    worker.emit('message', { type: 'codex_cli_effort_result', requestId: request.requestId, status: 'future_only', reason: 'cli_next_turn' });
    expect(await pending).toMatchObject({ status: 'future_only' });
  });

  it.each(['workerGeneration', 'cliSessionId'])('rejects a receipt after the session %s changes', async field => {
    const { worker, ds } = fixture();
    const pending = updateCodexCliEffort(ds, 'max');
    const request = worker.send.mock.calls[0][0];
    Object.assign(ds.session, { [field]: field === 'workerGeneration' ? 2 : 'replacement-thread' });
    worker.emit('message', { type: 'codex_cli_effort_result', requestId: request.requestId, status: 'future_only', reason: 'cli_next_turn' });
    expect(await pending).toEqual({ status: 'error' });
    expect(ds.session.reasoningEffort).toBe('high');
  });

  it('rejects stale worker receipts without changing the launch preference', async () => {
    const { worker, ds } = fixture();
    const pending = updateCodexCliEffort(ds, 'max');
    const request = worker.send.mock.calls[0][0];
    ds.worker = makeFakeWorker();
    worker.emit('message', { type: 'codex_cli_effort_result', requestId: request.requestId, status: 'future_only', reason: 'cli_next_turn' });
    expect(await pending).toEqual({ status: 'error' });
    expect(ds.session.reasoningEffort).toBe('high');
  });

  it('serializes requests and cancels timed-out menu operations', async () => {
    vi.useFakeTimers();
    try {
      const { worker, ds } = fixture();
      const pending = updateCodexCliEffort(ds, 'max', 100);
      expect(await updateCodexCliEffort(ds, 'low')).toMatchObject({ status: 'unavailable' });
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toEqual({ status: 'error' });
      expect(worker.send.mock.calls.at(-1)[0]).toMatchObject({ type: 'codex_cli_effort_cancel' });
      expect(ds.session.reasoningEffort).toBe('high');
      expect(worker.listenerCount('message')).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
