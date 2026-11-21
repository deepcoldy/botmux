import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { finalizeCotMessageMock, botState } = vi.hoisted(() => ({
  finalizeCotMessageMock: vi.fn(),
  botState: {
    cliId: 'antigravity' as string,
    dshRuntime: undefined as 'official' | 'tui' | undefined,
    env: undefined as Record<string, string> | undefined,
  },
}));

vi.mock('../src/im/lark/cot-message.js', () => ({
  handleCotThinkingUpdate: vi.fn(),
  handleCotThinkingSuperseded: vi.fn(),
  finalizeCotMessage: (...args: unknown[]) => finalizeCotMessageMock(...args),
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
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      cliId: botState.cliId,
      ...(botState.dshRuntime ? { dshRuntime: botState.dshRuntime } : {}),
      ...(botState.env ? { env: botState.env } : {}),
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
  Client: class {},
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { __testOnly_setupWorkerHandlers, initWorkerPool } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

interface SetupOpts {
  cliId?: string;
  dshRuntime?: 'official' | 'tui';
  env?: Record<string, string>;
  promptInjection?: 'default' | 'none';
  adopted?: boolean;
  sandbox?: boolean | 'off' | 'scratch';
}

function setup(opts: SetupOpts = {}) {
  const cliId = opts.cliId ?? 'antigravity';
  botState.cliId = cliId;
  botState.dshRuntime = opts.dshRuntime;
  botState.env = opts.env;
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
      ...(opts.promptInjection ? { promptInjection: opts.promptInjection } : {}),
      ...(opts.adopted ? { adoptedFrom: { source: 'tmux', paneId: '%1' } } : {}),
      ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
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
    cotForced: true,
    lastThinkingUpdate: { turnId: 'om_turn', entries: [] },
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

describe('screen_update working -> idle CoT finalization (real adapter registry)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['antigravity ordinary PTY', { cliId: 'antigravity' }],
    ['opencode2', { cliId: 'opencode2' }],
    ['kimi', { cliId: 'kimi' }],
    ['dsh-tui', { cliId: 'dsh', dshRuntime: 'tui' as const }],
    ['cursor under scratch', { cliId: 'cursor', sandbox: 'scratch' as const }],
  ])('finalizes CoT and clears cached CoT state on working -> idle for %s', (_label, opts) => {
    const { ds, worker } = setup(opts);
    worker.emit('message', {
      type: 'screen_update',
      content: 'ready',
      status: 'idle',
      turnId: 'om_turn',
      dispatchAttempt: 1,
    });
    expect(finalizeCotMessageMock).toHaveBeenCalledTimes(1);
    expect(finalizeCotMessageMock).toHaveBeenCalledWith(ds, 'om_turn', 'completed', 1);
    expect(ds.cotForced).toBeUndefined();
    expect(ds.lastThinkingUpdate).toBeUndefined();
  });

  it.each([
    ['antigravity zero-prompt', { cliId: 'antigravity', promptInjection: 'none' as const }],
    ['antigravity adopt', { cliId: 'antigravity', adopted: true }],
    ['antigravity ACP', { cliId: 'antigravity', env: { AGY_BOTMUX_TRANSPORT: 'acp' } }],
    ['claude-code', { cliId: 'claude-code' }],
    ['seed (claude-family)', { cliId: 'seed' }],
    ['relay (claude-family)', { cliId: 'relay' }],
    ['genius (claude-family)', { cliId: 'genius' }],
    ['codex', { cliId: 'codex' }],
    ['codex-app', { cliId: 'codex-app' }],
    ['headless dsh', { cliId: 'dsh' }],
    ['minimax (runnerFramedInput)', { cliId: 'minimax' }],
    ['cursor (non-scratch)', { cliId: 'cursor' }],
  ])('does not finalize CoT on idle for %s (uses turn_terminal)', (_label, opts) => {
    const { ds, worker } = setup(opts);
    worker.emit('message', {
      type: 'screen_update',
      content: 'ready',
      status: 'idle',
      turnId: 'om_turn',
      dispatchAttempt: 1,
    });
    expect(finalizeCotMessageMock).not.toHaveBeenCalled();
    expect(ds.cotForced).toBe(true);
    expect(ds.lastThinkingUpdate).toBeDefined();
  });
});
