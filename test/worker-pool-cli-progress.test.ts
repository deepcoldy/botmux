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
import { updateSession } from '../src/services/session-store.js';
import { updateMessage } from '../src/im/lark/client.js';
import type { DaemonSession } from '../src/core/types.js';

function setup(chatType = 'p2p', cliId = 'codex', explicit = false, human: boolean | undefined = false, extra: Partial<DaemonSession> = {}) {
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
  Object.assign(ds, extra);
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
  it.each([false, true])('new owner cannot send or patch an old-generation record (dirty=%s)', async dirty => {
    const h = setup(); h.start();
    const record = h.ds.session.cliProgressNotices![0];
    if (dirty) { record.dirty = true; record.messages = ['om_old_notice']; }
    const original = JSON.parse(JSON.stringify(record));
    const next = Object.assign(new EventEmitter(), {
      killed: false, send: vi.fn(), kill: vi.fn(), pid: 4243,
      stdout: new EventEmitter(), stderr: new EventEmitter(),
    });
    h.ds.worker = next as any;
    __testOnly_setupWorkerHandlers(h.ds, next as any);
    expect(h.ds.workerGeneration).toBeGreaterThan(record.generation);
    // No execution_started for the persisted old turn on an attach/restore.
    await vi.advanceTimersByTimeAsync(915_000);
    expect(h.reply).not.toHaveBeenCalled(); expect(updateMessage).not.toHaveBeenCalled();
    expect(record).toEqual(original);
    // Prove the new owner/timer is live rather than passing by suppressing all UI.
    h.ds.session.turnReplyContexts!.om_new = h.ds.session.turnReplyContexts!.om_turn;
    next.emit('message', { type: 'turn_execution_started', turnId: 'om_new', startedAtMs: Date.now() });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.reply).toHaveBeenCalledTimes(1); expect(h.reply.mock.calls[0][4]).toBe('om_new');
    expect(updateMessage).not.toHaveBeenCalled(); expect(record).toEqual(original);
  });
  it.each(['schedule:task:fire', 'cross-principal:request'])('rejects hostile synthetic %s even with human context and mention', async turnId => {
    const h = setup('group', 'codex', true);
    h.ds.session.turnReplyContexts![turnId] = h.ds.session.turnReplyContexts!.om_turn;
    h.ds.turnExplicitMentions!.add(turnId);
    h.start(turnId);
    await vi.advanceTimersByTimeAsync(915_000);
    expect(h.reply).not.toHaveBeenCalled(); expect(updateMessage).not.toHaveBeenCalled();
    h.start(); await vi.advanceTimersByTimeAsync(300_000);
    expect(h.reply).toHaveBeenCalledTimes(1); expect(h.reply.mock.calls[0][4]).toBe('om_turn');
  });

  it('hot mute pauses pending recovery patches without spending their retry budget', async () => {
    const h = setup(); h.start(); await vi.advanceTimersByTimeAsync(300_000);
    h.worker.emit('message', { type: 'turn_progress', turnId: 'om_turn', stage: 'tool_returned' });
    policy.enabled = false; await vi.advanceTimersByTimeAsync(60_000);
    expect(updateMessage).not.toHaveBeenCalled();
    expect(h.ds.session.cliProgressNotices![0].patchAttempts).toBe(0);
    policy.enabled = true; await vi.advanceTimersByTimeAsync(15_000);
    expect(updateMessage).toHaveBeenCalledTimes(1); expect(h.reply).toHaveBeenCalledTimes(1);
  });

  it('turn_terminal stops future alerts even without a final IM reply', async () => {
    const h = setup(); h.start();
    h.worker.emit('message', { type: 'turn_terminal', sessionId: 'sid-notice', turnId: 'om_turn', status: 'completed' });
    await vi.advanceTimersByTimeAsync(915_000);
    expect(h.ds.session.cliProgressNotices![0].settled).toBe(true);
    expect(h.reply).not.toHaveBeenCalled();
  });
  it('exit drains a terminal card without waiting for the next 15 second tick', async () => {
    const h = setup(); h.start(); await vi.advanceTimersByTimeAsync(300_000);
    h.worker.emit('message', { type: 'turn_terminal', sessionId: 'sid-notice', turnId: 'om_turn', status: 'completed' });
    vi.mocked(updateMessage).mockImplementationOnce(async (_app, _id, _card, opts) => { opts!.beforeWrite!(); });
    h.worker.killed = true; h.worker.emit('exit', 0, null);
    expect(h.ds.worker).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(updateMessage).toHaveBeenCalledOnce();
    const call = vi.mocked(updateMessage).mock.calls[0];
    expect(call[1]).toBe('om_notice'); expect(JSON.parse(call[2]).header.template).toBe('grey');
    expect(call[3]?.beforeWrite).toBeTypeOf('function');
    expect(h.ds.session.cliProgressNotices![0].dirty).toBe(false);
    await vi.advanceTimersByTimeAsync(915_000); expect(h.reply).toHaveBeenCalledOnce();
  });
  it('exit cleanup is fenced if a replacement takes over before PATCH enters transport', async () => {
    const h = setup(); h.start(); await vi.advanceTimersByTimeAsync(300_000);
    let guard!: () => void; let ack!: () => void;
    vi.mocked(updateMessage).mockImplementationOnce(async (_app, _id, _card, opts) => {
      guard = opts!.beforeWrite!; return new Promise<void>(resolve => { ack = resolve; });
    });
    h.worker.killed = true; h.worker.emit('exit', 0, null); await Promise.resolve();
    const next = Object.assign(new EventEmitter(), { killed: false, send: vi.fn(), pid: 4243,
      stdout: new EventEmitter(), stderr: new EventEmitter() });
    h.ds.worker = next as any; __testOnly_setupWorkerHandlers(h.ds, next as any);
    expect(() => guard()).toThrow(); ack(); await vi.advanceTimersByTimeAsync(2_000);
    expect(h.reply).toHaveBeenCalledOnce();
  });
  it.each(['progress', 'waiting'])('scopedReply receives the pre-transport guard for a %s race', async race => {
    const h = setup(); h.start(); const transport = vi.fn();
    h.reply.mockImplementationOnce(async (_root, _content, _type, _app, _turn, opts) => {
      if (race === 'progress') h.worker.emit('message', { type: 'turn_progress', turnId: 'om_turn', stage: 'tool_returned' });
      else h.ds.tuiPromptCardId = 'om_prompt';
      opts?.beforeWrite?.(); transport(); return 'om_bad';
    });
    await vi.advanceTimersByTimeAsync(300_000); expect(transport).not.toHaveBeenCalled();
    expect(h.ds.session.cliProgressNotices![0].deliveryPending).toBe(false);
    h.ds.tuiPromptCardId = undefined;
    await vi.advanceTimersByTimeAsync(315_000); expect(h.reply).toHaveBeenCalledTimes(2);
    expect(h.ds.session.cliProgressNotices![0].messages).toEqual(['om_notice']);
  });
  it.each(['cliEnabled', 'enabled'] as const)('hot %s gate prevents both admission and delivery', async key => {
    const h = setup(); h.start(); policy[key] = false;
    h.ds.session.turnReplyContexts!.om_new = h.ds.session.turnReplyContexts!.om_turn;
    h.start('om_new');
    expect(h.ds.session.cliProgressNotices!.map(r => r.turnId)).toEqual(['om_turn']);
    await vi.advanceTimersByTimeAsync(915_000); expect(h.reply).not.toHaveBeenCalled();
    policy[key] = true; await vi.advanceTimersByTimeAsync(15_000); expect(h.reply).toHaveBeenCalledOnce();
  });
  it.each(['adopted', 'session-adopted', 'meeting', 'doc-native', 'trigger-final'])('rejects %s with otherwise valid human admission', async kind => {
    const h = setup('p2p', 'codex', false, false, kind === 'doc-native' ? { scope: 'chat', chatId: 'doc:test' } : {});
    if (kind === 'adopted') h.ds.adoptedFrom = 'external' as any;
    if (kind === 'session-adopted') h.ds.session.adoptedFrom = 'external' as any;
    if (kind === 'meeting') h.ds.session.vcMeetingReceiver = {} as any;
    if (kind === 'trigger-final') h.ds.suppressedTriggerFinalTurns = new Map([['om_turn', Date.now()]]);
    h.start(); expect(h.ds.session.cliProgressNotices).toBeUndefined();
    await vi.advanceTimersByTimeAsync(915_000); expect(h.reply).not.toHaveBeenCalled();
  });
  it.each(['codex-app', 'claude-code', 'disabled'])('does not allocate notice records for %s', async kind => {
    if (kind === 'disabled') policy.cliEnabled = false;
    const h = setup('p2p', kind === 'disabled' ? 'codex' : kind); h.start();
    h.worker.emit('message', { type: 'turn_progress', turnId: 'om_turn', stage: 'model_output' });
    h.worker.emit('message', { type: 'turn_terminal', sessionId: 'sid-notice', turnId: 'om_turn', status: 'completed' });
    await vi.advanceTimersByTimeAsync(915_000);
    expect(h.ds.session.cliProgressNotices).toBeUndefined();
  });
  it('a session-store rollback retires the notifier and never persists its detached array again', async () => {
    const h = setup(); h.start(); const durable = JSON.parse(JSON.stringify(h.ds.session));
    const detached = h.ds.session.cliProgressNotices;
    vi.mocked(updateSession).mockImplementationOnce(session => {
      for (const key of Object.keys(session)) delete (session as any)[key];
      Object.assign(session, JSON.parse(JSON.stringify(durable)));
      throw new Error('rollback');
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.ds.session.cliProgressNotices).not.toBe(detached);
    const writes = vi.mocked(updateSession).mock.calls.length;
    h.worker.emit('message', { type: 'turn_progress', turnId: 'om_turn', stage: 'tool_returned' });
    h.start(); await vi.advanceTimersByTimeAsync(915_000);
    expect(h.reply).not.toHaveBeenCalled(); expect(updateSession).toHaveBeenCalledTimes(writes);
    expect(h.ds.session.cliProgressNotices).toEqual(durable.cliProgressNotices);
  });

});
