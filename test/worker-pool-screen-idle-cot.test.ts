import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { finalizeCotMessageMock, botState } = vi.hoisted(() => ({
  finalizeCotMessageMock: vi.fn(),
  botState: {
    cliId: 'antigravity' as string,
    env: undefined as Record<string, string> | undefined,
    dshRuntime: undefined as 'official' | 'tui' | undefined,
  },
}));

vi.mock('../src/im/lark/cot-message.js', () => ({
  handleCotThinkingUpdate: vi.fn(),
  handleCotThinkingSuperseded: vi.fn(),
  finalizeCotMessage: (...args: unknown[]) => finalizeCotMessageMock(...args),
  cotMessageFinishStatus: vi.fn(() => undefined),
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

import { __testOnly_setupWorkerHandlers, initWorkerPool } from '../src/core/worker-pool.js';
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
      sessionId: 'sid-cot-idle',
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

function emitIdle(worker: EventEmitter): void {
  worker.emit('message', {
    type: 'screen_update',
    content: 'ready',
    status: 'idle',
    turnId: 'om_turn',
    dispatchAttempt: 1,
  });
}

describe('screen_update working -> idle CoT finalization (real adapter registry)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each<[string, SetupOptions]>([
    ['ordinary antigravity', { cliId: 'antigravity' }],
    ['opencode2 without runner framing', { cliId: 'opencode2' }],
    ['kimi', { cliId: 'kimi' }],
    ['dsh-tui without a runner terminal', { cliId: 'dsh', dshRuntime: 'tui' }],
    ['cursor with scratch disabling the host bridge', { cliId: 'cursor', scratch: true }],
    ['adopted seed without a spawned Claude-family bridge', { cliId: 'seed', adopted: true }],
  ])('finalizes CoT on working -> idle for %s', (_label, opts) => {
    const { ds, worker } = setup(opts);
    emitIdle(worker);
    expect(finalizeCotMessageMock).toHaveBeenCalledTimes(1);
    expect(finalizeCotMessageMock).toHaveBeenCalledWith(ds, 'om_turn', 'completed', 1);
  });

  it('clears the one-shot CoT force and cached thinking on idle finalization', () => {
    const { ds, worker } = setup({ cliId: 'antigravity' });
    ds.cotForced = true;
    ds.lastThinkingUpdate = {
      turnId: 'om_turn', dispatchAttempt: 1, entries: [{ kind: 'thinking', text: 'stale' }],
    };
    emitIdle(worker);
    expect(finalizeCotMessageMock).toHaveBeenCalledTimes(1);
    expect(ds.cotForced).toBeUndefined();
    expect(ds.lastThinkingUpdate).toBeUndefined();
  });

  it.each<[string, SetupOptions]>([
    ['antigravity zero-prompt', { cliId: 'antigravity', promptInjection: 'none' }],
    ['antigravity adopt', { cliId: 'antigravity', adopted: true }],
    ['antigravity ACP', { cliId: 'antigravity', agyTransport: 'acp' }],
    ['codex', { cliId: 'codex' }],
    ['claude-code', { cliId: 'claude-code' }],
    ['claude-code adopt', { cliId: 'claude-code', adopted: true }],
    ['seed', { cliId: 'seed' }],
    ['relay', { cliId: 'relay' }],
    ['genius', { cliId: 'genius' }],
    ['codex-app signed socket', { cliId: 'codex-app' }],
    ['headless dsh OSC', { cliId: 'dsh', dshRuntime: 'official' }],
    ['mira OSC', { cliId: 'mira' }],
    ['mir OSC', { cliId: 'mir' }],
    ['minimax runner framing', { cliId: 'minimax' }],
    ['ordinary cursor structured bridge', { cliId: 'cursor' }],
    ['remote-runner backend', { cliId: 'remote-runner', backendType: 'remote-runner' }],
  ])('does not finalize CoT on idle for %s (uses turn_terminal)', (_label, opts) => {
    const { ds, worker } = setup(opts);
    ds.cotForced = true;
    ds.lastThinkingUpdate = { turnId: 'om_turn', entries: [] };
    emitIdle(worker);
    expect(finalizeCotMessageMock).not.toHaveBeenCalled();
    expect(ds.cotForced).toBe(true);
    expect(ds.lastThinkingUpdate).toBeDefined();
  });
});
