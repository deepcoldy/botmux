import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { emitHookEventMock, policy, asks } = vi.hoisted(() => ({
  emitHookEventMock: vi.fn(), policy: { enabled: true, cliEnabled: true }, asks: [] as any[],
}));
vi.mock('../src/core/ask-broker.js', () => ({ listPendingAsks: () => asks }));

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
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'codex', noProgressNotify: policy },
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
    daemon: { backendType: 'tmux', cliId: 'codex', noProgressNotify: policy },
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


import { __testOnly_setupWorkerHandlers, initWorkerPool } from '../src/core/worker-pool.js';
import { updateMessage } from '../src/im/lark/client.js';
import type { DaemonSession } from '../src/core/types.js';

function setup(chatType = 'p2p', cliId = 'codex', explicit = false, human: boolean | undefined = false) {
  const worker = Object.assign(new EventEmitter(), {
    killed: false, send: vi.fn(), kill: vi.fn(), pid: 4242,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
  });
  const ds = {
    session: { sessionId: 'sid-notice', rootMessageId: 'om_root', chatId: 'oc_chat', status: 'active',
      createdAt: new Date().toISOString(), chatType, cliId, workingDir: '/repo',
      turnReplyContexts: { om_turn: { target: { mode: 'thread', chatId: 'oc_chat', rootMessageId: 'om_original' },
        replyTargetSenderOpenId: 'ou_original', replyTargetSenderIsBot: human } } },
    worker, workerPort: 9999, workerToken: 'tok', larkAppId: 'app_test', chatId: 'oc_chat', chatType,
    scope: 'thread', spawnedAt: 1, lastMessageAt: 2, hasHistory: false, workingDir: '/repo',
    displayMode: 'hidden', lastScreenContent: '', lastScreenStatus: 'working',
    turnExplicitMentions: new Set(explicit ? ['om_turn'] : []),
  } as unknown as DaemonSession;
  const reply = vi.fn(async (_root, _content, _type, _app, _turn, opts) => { opts?.beforeWrite?.(); return 'om_notice'; });
  initWorkerPool({ sessionReply: reply, getSessionWorkingDir: () => '/repo', getActiveCount: () => 1, closeSession: vi.fn() } as any);
  __testOnly_setupWorkerHandlers(ds, worker as any);
  const start = (turnId = 'om_turn') => worker.emit('message', { type: 'turn_execution_started', turnId, startedAtMs: Date.now() });
  return { ds, worker, reply, start };
}

describe('CLI progress timer at actual worker IPC seam', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); vi.clearAllMocks(); policy.enabled = true; policy.cliEnabled = true; asks.length = 0; });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it('daemon timer alone delivers to the frozen turn and original sender, then patches on progress', async () => {
    const h = setup(); h.start();
    h.ds.session.quoteTargetSenderOpenId = 'ou_later';
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.reply).toHaveBeenCalledTimes(1);
    const args = h.reply.mock.calls[0];
    expect(args[1]).toContain('ou_original'); expect(args[1]).not.toContain('ou_later');
    expect(args[4]).toBe('om_turn'); expect(args[5].replyTarget.rootMessageId).toBe('om_original');
    expect(args[5].suppressHook).toBe(true);
    h.worker.emit('message', { type: 'turn_progress', turnId: 'om_turn', stage: 'tool_returned' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateMessage).mock.calls[0][2]).not.toContain('<at');
    expect(h.reply).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['group listener', 'group', 'codex', false, false],
    ['bot sender', 'p2p', 'codex', false, true],
    ['App runner', 'p2p', 'codex-app', false, false],
    ['other CLI', 'p2p', 'claude-code', false, false],
  ])('does not notify for %s', async (_label, chat, cli, explicit, human) => {
    const h = setup(chat as string, cli as string, explicit as boolean, human as boolean); h.start();
    await vi.advanceTimersByTimeAsync(900_000); expect(h.reply).not.toHaveBeenCalled();
  });
  it('does not infer a missing human identity from session ownership', async () => {
    const h = setup(); delete h.ds.session.turnReplyContexts!.om_turn.replyTargetSenderIsBot; h.start();
    await vi.advanceTimersByTimeAsync(900_000); expect(h.reply).not.toHaveBeenCalled();
  });
  it('allows an explicitly mentioned group human, but not synthetic scheduler input', async () => {
    const h = setup('group', 'codex', true); h.start('schedule:test');
    await vi.advanceTimersByTimeAsync(300_000); expect(h.reply).not.toHaveBeenCalled();
    h.start(); await vi.advanceTimersByTimeAsync(300_000); expect(h.reply).toHaveBeenCalledTimes(1);
  });
  it('leaves disabled bots unchanged', async () => {
    policy.cliEnabled = false; const h = setup(); h.start();
    await vi.advanceTimersByTimeAsync(900_000); expect(h.reply).not.toHaveBeenCalled();
  });
  it('does not count acceptance/queue waiting as running', async () => {
    const h = setup(); await vi.advanceTimersByTimeAsync(900_000); expect(h.reply).not.toHaveBeenCalled();
  });
  it('suppresses pending ask and starts a new window after answer', async () => {
    const h = setup(); h.start(); asks.push({ larkAppId: 'app_test', sessionId: 'sid-notice' });
    await vi.advanceTimersByTimeAsync(900_000); expect(h.reply).not.toHaveBeenCalled();
    asks.length = 0; await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(300_000); expect(h.reply).toHaveBeenCalledTimes(1);
  });
  it.each(['agentAttention', 'tuiPromptCardId'])('suppresses %s', async field => {
    const h = setup(); h.start(); (h.ds as any)[field] = field === 'agentAttention' ? { kind: 'blocked' } : 'om_prompt';
    await vi.advanceTimersByTimeAsync(900_000); expect(h.reply).not.toHaveBeenCalled();
  });
  it('retires the timer when worker ownership changes', async () => {
    const h = setup(); h.start(); h.ds.worker = new EventEmitter() as any;
    await vi.advanceTimersByTimeAsync(900_000); expect(h.reply).not.toHaveBeenCalled();
    h.worker.emit('message', { type: 'turn_progress', turnId: 'om_turn', stage: 'model_output' });
    expect(h.ds.session.cliProgressNotices![0].progressAt).toBe(1_000_000);
  });
});
