import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { finalizeCotMessageMock, cotFinishStatuses, botState } = vi.hoisted(() => {
  const statuses = new Map<string, 'done' | 'interrupted'>();
  return {
    cotFinishStatuses: statuses,
    finalizeCotMessageMock: vi.fn((_ds: unknown, turnId: string, status: string, dispatchAttempt?: number) => {
      const key = `${turnId}|${dispatchAttempt ?? ''}`;
      if (!statuses.has(key)) statuses.set(key, status === 'completed' ? 'done' : 'interrupted');
    }),
    botState: {
      cliId: 'antigravity' as string,
      env: undefined as Record<string, string> | undefined,
      dshRuntime: undefined as 'official' | 'tui' | undefined,
    },
  };
});

vi.mock('../src/im/lark/cot-message.js', () => ({
  handleCotThinkingUpdate: vi.fn(),
  handleCotThinkingSuperseded: vi.fn(),
  finalizeCotMessage: (...args: unknown[]) => finalizeCotMessageMock(...args),
  cotMessageFinishStatus: (_ds: unknown, binding: { turnId: string; dispatchAttempt?: number }) =>
    cotFinishStatuses.get(`${binding.turnId}|${binding.dispatchAttempt ?? ''}`),
  abortCotMessage: vi.fn(),
  resumeCotMessage: vi.fn(),
  cotMessageCarriesTurn: vi.fn(() => false),
  hasCotMessageForTurn: vi.fn(() => false),
  prepareCotMessageBeforeReply: vi.fn(),
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  MessageWithdrawnError: class extends Error {},
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{"type":"streaming"}'),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
  buildTuiPromptCard: vi.fn(() => '{"type":"tui"}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{"type":"tui-resolved"}'),
  getCliDisplayName: vi.fn(() => 'Antigravity'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: {
      larkAppId: 'app_test', larkAppSecret: 'secret', cliId: botState.cliId,
      ...(botState.env ? { env: botState.env } : {}),
      ...(botState.dshRuntime ? { dshRuntime: botState.dshRuntime } : {}),
    },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'Castor',
  })),
  getAllBots: vi.fn(() => []),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'antigravity' },
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

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class {},
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class {},
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { __testOnly_setSuspendBackingVerifier, __testOnly_setupWorkerHandlers, initWorkerPool, killWorker, suspendWorker } from '../src/core/worker-pool.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import type { DaemonSession } from '../src/core/types.js';

interface SetupOptions {
  cliId?: string;
  promptInjection?: 'default' | 'none';
  adopted?: boolean;
  agyTransport?: 'terminal' | 'acp';
  dshRuntime?: 'official' | 'tui';
  backendType?: 'tmux' | 'remote-runner';
  scratch?: boolean;
}

function setup(opts: SetupOptions = {}) {
  const cliId = opts.cliId ?? 'antigravity';
  botState.cliId = cliId;
  botState.env = opts.agyTransport ? { AGY_BOTMUX_TRANSPORT: opts.agyTransport } : undefined;
  botState.dshRuntime = opts.dshRuntime;
  const worker = Object.assign(new EventEmitter(), {
    killed: false, send: vi.fn(), kill: vi.fn(), pid: 4242,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
  });
  const ds = {
    session: {
      sessionId: 'sid-cot-held',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      status: 'active',
      createdAt: new Date().toISOString(),
      chatType: 'p2p',
      cliId,
      workingDir: '/repo',
      backendType: opts.backendType ?? 'tmux',
      ...(opts.scratch ? { sandbox: 'scratch' } : {}),
      ...(opts.promptInjection ? { promptInjection: opts.promptInjection } : {}),
      ...(opts.adopted ? { adoptedFrom: { source: 'tmux', paneId: '%1' } } : {}),
    },
    worker,
    workerPort: 9999,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'p2p',
    scope: 'chat',
    spawnedAt: 1,
    lastMessageAt: 2,
    hasHistory: false,
    workingDir: '/repo',
    displayMode: 'hidden',
    lastScreenContent: 'working',
    lastScreenStatus: 'working',
    activeTurnId: 'om_turn',
    activeDispatchAttempt: 1,
    ...(opts.adopted ? { adoptedFrom: { source: 'tmux', paneId: '%1' } } : {}),
  } as unknown as DaemonSession;
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => '/repo',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  } as any);
  __testOnly_setupWorkerHandlers(ds, worker as any);
  return { ds, worker };
}

function terminal(worker: EventEmitter, extra: Record<string, unknown> = {}): void {
  worker.emit('message', {
    type: 'turn_terminal', sessionId: 'sid-cot-held', turnId: 'om_turn', dispatchAttempt: 1, status: 'completed', ...extra,
  });
}

function screen(worker: EventEmitter, backgroundTasks?: number): void {
  worker.emit('message', {
    type: 'screen_update', content: 'ready', status: 'idle', turnId: 'om_turn', dispatchAttempt: 1,
    ...(backgroundTasks ? { backgroundTasks } : {}),
  });
}

async function startupCircuit(worker: EventEmitter): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await Promise.all(worker.listeners('message').map(listener => listener.call(worker, {
      type: 'claude_exit', code: 1, startupFailure: true, turnId: 'om_turn', dispatchAttempt: 1,
    })));
  }
}

describe('CoT message of a turn that ended with background tasks running', () => {
  beforeEach(() => {
    cotFinishStatuses.clear();
    vi.clearAllMocks();
  });

  it('closes the CoT message at the terminal when no background task runs', () => {
    const { ds, worker } = setup({ cliId: 'claude-code' });
    terminal(worker);
    expect(finalizeCotMessageMock).toHaveBeenCalledWith(ds, 'om_turn', 'completed', 1);
  });

  it('keeps the CoT message open until the background task count reaches 0', () => {
    const { ds, worker } = setup({ cliId: 'claude-code' });
    terminal(worker, { backgroundTasks: 1 });
    screen(worker, 1);
    expect(finalizeCotMessageMock).not.toHaveBeenCalled();
    screen(worker);
    expect(finalizeCotMessageMock).toHaveBeenCalledTimes(1);
    expect(finalizeCotMessageMock).toHaveBeenCalledWith(ds, 'om_turn', 'completed', 1);
    screen(worker);
    expect(finalizeCotMessageMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the held CoT message open when the same terminal is replayed', () => {
    const { ds, worker } = setup({ cliId: 'claude-code' });
    terminal(worker, { backgroundTasks: 1 });
    terminal(worker, { backgroundTasks: 1 });
    expect(finalizeCotMessageMock).not.toHaveBeenCalled();
    expect(ds.cotHeldForBackground).toEqual({ turnId: 'om_turn', dispatchAttempt: 1 });
    screen(worker);
    expect(finalizeCotMessageMock).toHaveBeenCalledTimes(1);
  });

  it.each(['stalled', 'limited'] as const)('does not treat a positive count on a %s frame as zero', status => {
    const { worker } = setup({ cliId: 'claude-code' });
    terminal(worker, { backgroundTasks: 1 });
    worker.emit('message', {
      type: 'screen_update', content: 'still waiting', status, turnId: 'om_turn', dispatchAttempt: 1,
      backgroundTasks: 1,
    });
    expect(finalizeCotMessageMock).not.toHaveBeenCalled();
    screen(worker);
    expect(finalizeCotMessageMock).toHaveBeenCalledTimes(1);
  });

  it('releases on a raw idle zero frame even when a sticky limit projects limited', () => {
    const { ds, worker } = setup({ cliId: 'claude-code' });
    ds.usageLimit = {
      limited: true, kind: 'rate', retryAtMs: Date.now() + 60_000,
      retryLabel: '1 min', retryReady: false,
    };
    terminal(worker, { backgroundTasks: 1 });
    screen(worker);
    expect(ds.lastScreenStatus).toBe('limited');
    expect(finalizeCotMessageMock).toHaveBeenCalledTimes(1);
  });

  it('clears and publishes the background count when the startup circuit stops the CLI', async () => {
    const { ds, worker } = setup({ cliId: 'claude-code' });
    screen(worker, 1);
    expect(ds.backgroundTaskCount).toBe(1);
    await startupCircuit(worker);
    expect(ds.cliStartupFailureReason).toBeTruthy();
    expect(ds.backgroundTaskCount).toBeUndefined();
    expect(dashboardEventBus.publish).toHaveBeenCalledWith({
      type: 'session.update',
      body: { sessionId: ds.session.sessionId, patch: { status: 'interrupted', backgroundTaskCount: null } },
    });
  });

  it('settles the held CoT as interrupted when the startup circuit stops the CLI', async () => {
    const { ds, worker } = setup({ cliId: 'claude-code' });
    terminal(worker, { backgroundTasks: 1 });
    await startupCircuit(worker);
    expect(ds.cliStartupFailureReason).toBeTruthy();
    expect(finalizeCotMessageMock).toHaveBeenCalledWith(ds, 'om_turn', 'failed', 1);
    expect(ds.cotHeldForBackground).toBeUndefined();
  });

  it('settles the held CoT once on an ordinary CLI restart, not again on a later zero frame', async () => {
    const { ds, worker } = setup({ cliId: 'claude-code' });
    terminal(worker, { backgroundTasks: 1 });
    await Promise.all(worker.listeners('message').map(listener => listener.call(worker, {
      type: 'claude_exit', code: 1, startupFailure: false, turnId: 'om_turn', dispatchAttempt: 1,
    })));
    expect(finalizeCotMessageMock).toHaveBeenCalledWith(ds, 'om_turn', 'failed', 1);
    screen(worker);
    expect(finalizeCotMessageMock).toHaveBeenCalledTimes(1);
    expect(ds.cotHeldForBackground).toBeUndefined();
  });

  it('does not recreate a hold when a completed terminal replays after the circuit', async () => {
    const { ds, worker } = setup({ cliId: 'claude-code' });
    terminal(worker, { backgroundTasks: 1 });
    await startupCircuit(worker);
    expect(finalizeCotMessageMock).toHaveBeenCalledTimes(1);
    terminal(worker, { backgroundTasks: 1 });
    expect(ds.cotHeldForBackground).toBeUndefined();
    expect(finalizeCotMessageMock).toHaveBeenCalledTimes(1);
  });

  it('clears and interrupts background state on shared worker retirement', () => {
    const { ds } = setup({ cliId: 'claude-code' });
    ds.backgroundTaskCount = 1;
    ds.cotHeldForBackground = { turnId: 'om_turn', dispatchAttempt: 1 };
    killWorker(ds);
    expect(ds.worker).toBeNull();
    expect(ds.backgroundTaskCount).toBeUndefined();
    expect(ds.cotHeldForBackground).toBeUndefined();
    expect(finalizeCotMessageMock).toHaveBeenCalledWith(ds, 'om_turn', 'failed', 1);
    expect(dashboardEventBus.publish).toHaveBeenCalledWith({
      type: 'session.update',
      body: { sessionId: ds.session.sessionId, patch: { backgroundTaskCount: null } },
    });
  });

  it('keeps background state when remote worker retirement is refused', () => {
    const { ds, worker } = setup({ cliId: 'claude-code', backendType: 'remote-runner' });
    ds.backgroundTaskCount = 1;
    ds.cotHeldForBackground = { turnId: 'om_turn', dispatchAttempt: 1 };
    killWorker(ds);
    expect(ds.worker).toBe(worker);
    expect(ds.backgroundTaskCount).toBe(1);
    expect(ds.cotHeldForBackground).toEqual({ turnId: 'om_turn', dispatchAttempt: 1 });
    expect(finalizeCotMessageMock).not.toHaveBeenCalled();
    expect(dashboardEventBus.publish).not.toHaveBeenCalled();
  });

  it('does not infer CLI loss from worker-less best-effort orphan cleanup', () => {
    const { ds } = setup({ cliId: 'claude-code', adopted: true });
    ds.worker = null;
    ds.backgroundTaskCount = 1;
    ds.cotHeldForBackground = { turnId: 'om_turn', dispatchAttempt: 1 };
    killWorker(ds);
    expect(ds.backgroundTaskCount).toBe(1);
    expect(ds.cotHeldForBackground).toEqual({ turnId: 'om_turn', dispatchAttempt: 1 });
    expect(finalizeCotMessageMock).not.toHaveBeenCalled();
    expect(dashboardEventBus.publish).not.toHaveBeenCalled();
  });

  it('closes the held CoT message when a later terminal arrives', () => {
    const { ds, worker } = setup({ cliId: 'claude-code' });
    terminal(worker, { backgroundTasks: 1 });
    expect(finalizeCotMessageMock).not.toHaveBeenCalled();
    terminal(worker, { turnId: 'om_turn2', dispatchAttempt: 2 });
    expect(finalizeCotMessageMock).toHaveBeenCalledWith(ds, 'om_turn', 'completed', 1);
  });

  it('closes the held CoT message as completed when the worker is suspended', () => {
    const { ds, worker } = setup({ cliId: 'claude-code' });
    terminal(worker, { backgroundTasks: 1 });
    expect(finalizeCotMessageMock).not.toHaveBeenCalled();
    ds.initConfig = { backendType: 'tmux' } as DaemonSession['initConfig'];
    __testOnly_setSuspendBackingVerifier(() => true);
    try {
      expect(suspendWorker(ds)).toBe(true);
    } finally {
      __testOnly_setSuspendBackingVerifier();
    }
    expect(finalizeCotMessageMock).toHaveBeenCalledWith(ds, 'om_turn', 'completed', 1);
  });

  it('keeps held CoT open across working/idle frames carrying cotHoldForBackground:true and releases once cleared', () => {
    const { ds, worker } = setup({ cliId: 'claude-code' });
    terminal(worker, { backgroundTasks: 1 });
    expect(ds.cotHeldForBackground).toEqual({ turnId: 'om_turn', dispatchAttempt: 1 });

    // During a suppressed Monitor micro-turn, backgroundWait() drops to 0 while
    // the bounded Monitor is still live; worker sends cotHoldForBackground: true.
    worker.emit('message', {
      type: 'screen_update', content: 'checking monitor', status: 'working',
      turnId: 'om_turn', dispatchAttempt: 1, cotHoldForBackground: true,
    });
    expect(ds.backgroundTaskCount).toBeUndefined();
    expect(ds.cotHeldForBackground).toEqual({ turnId: 'om_turn', dispatchAttempt: 1 });
    expect(finalizeCotMessageMock).not.toHaveBeenCalled();

    worker.emit('message', {
      type: 'screen_update', content: 'prompt ready', status: 'idle',
      turnId: 'om_turn', dispatchAttempt: 1, cotHoldForBackground: true,
    });
    expect(ds.cotHeldForBackground).toEqual({ turnId: 'om_turn', dispatchAttempt: 1 });
    expect(finalizeCotMessageMock).not.toHaveBeenCalled();

    // Once the Monitor stops/expires or the switch turns off, cotHoldForBackground clears.
    screen(worker);
    expect(finalizeCotMessageMock).toHaveBeenCalledTimes(1);
    expect(finalizeCotMessageMock).toHaveBeenCalledWith(ds, 'om_turn', 'completed', 1);
    expect(ds.cotHeldForBackground).toBeUndefined();
  });

  it('keeps om_turn held CoT open when a sibling synthesized local wake completes with remaining backgroundTasks', () => {
    const { ds, worker } = setup({ cliId: 'claude-code' });
    terminal(worker, { backgroundTasks: 2 });
    expect(ds.cotHeldForBackground).toEqual({ turnId: 'om_turn', dispatchAttempt: 1 });

    // Sibling subagent finishes while bounded Monitor still runs (backgroundTasks: 1).
    terminal(worker, { turnId: 'local-headless-ag1', dispatchAttempt: undefined, backgroundTasks: 1 });
    expect(finalizeCotMessageMock).not.toHaveBeenCalled();
    expect(ds.cotHeldForBackground).toEqual({ turnId: 'om_turn', dispatchAttempt: 1 });

    // When the final background task finishes (backgroundTasks: 0), om_turn CoT closes cleanly.
    terminal(worker, { turnId: 'local-headless-m1-done', dispatchAttempt: undefined });
    expect(finalizeCotMessageMock).toHaveBeenCalledWith(ds, 'om_turn', 'completed', 1);
    expect(ds.cotHeldForBackground).toBeUndefined();
  });

  it('allows TurnReplyCardStore tools updates on a completed unified card ONLY when allowWhileTerminal is set', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { TurnReplyCardStore } = await import('../src/services/turn-reply-card.js');
    const dir = mkdtempSync(join(tmpdir(), 'unified-bg-cot-'));
    try {
      const store = new TurnReplyCardStore(dir);
      const key = { botId: 'app', sessionId: 's1', turnId: 'om_turn', dispatchAttempt: 1 };
      await store.prepare(key, { mode: 'unified', chatId: 'oc_1', rootId: 'om_root' });
      const patches: string[] = [];
      const io = {
        beforeEffect: () => {},
        render: (r: any) => JSON.stringify({ phase: r.phase, tools: r.tools.map((t: any) => t.name) }),
        send: async (body: string) => { patches.push(body); return 'om_card_1'; },
        patch: async (_id: string, body: string) => { patches.push(body); },
      };
      await store.update(key, { kind: 'tools', tools: [{ id: 't1', name: 'Monitor', subject: 'CI' }] }, io);
      await store.update(key, { kind: 'terminal', phase: 'completed' }, io);
      const afterTerminal = patches.length;

      // Without allowWhileTerminal: completed card stays immutable.
      await store.update(key, { kind: 'tools', tools: [{ id: 't1', name: 'Monitor', subject: 'CI' }, { id: 't2', name: 'Read', subject: 'x' }] }, io);
      expect(patches.length).toBe(afterTerminal);

      // With allowWhileTerminal (held background Monitor): activity appends and patches!
      await store.update(key, {
        kind: 'tools',
        allowWhileTerminal: true,
        tools: [{ id: 't1', name: 'Monitor', subject: 'CI' }, { id: 't2', name: 'Bash', subject: 'check' }],
      }, io);
      expect(patches.length).toBeGreaterThan(afterTerminal);
      expect(patches.at(-1)).toContain('"Bash"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
