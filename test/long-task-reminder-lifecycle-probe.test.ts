import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: Error,
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Codex'),
}));

const botConfigMock = {
  cliId: 'codex' as string,
  env: undefined as Record<string, string> | undefined,
};

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: {
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      cliId: botConfigMock.cliId,
      ...(botConfigMock.env ? { env: botConfigMock.env } : {}),
    },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'pty', cliId: 'codex' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(() => undefined),
  updateSessionPid: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(),
  WSClient: vi.fn(),
  EventDispatcher: vi.fn(),
  LoggerLevel: { info: 2 },
}));

/** Session replies are observed without publishing real Lark messages. */
const sessionReplyMock = vi.fn(async () => 'om_reply');
import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { EventEmitter } from 'node:events';

/** Create one live worker whose generation is assigned by the real IPC setup. */
function makeDs(opts: { cliId?: string; promptInjection?: 'default' | 'none'; workerReady?: boolean } = {}): DaemonSession {
  /** Event emitter implements only the process surfaces used by production handlers. */
  const fakeWorker = new EventEmitter() as any;
  fakeWorker.killed = false;
  fakeWorker.send = vi.fn();
  fakeWorker.kill = vi.fn();
  fakeWorker.pid = 99999;
  fakeWorker.stdout = new EventEmitter();
  fakeWorker.stderr = new EventEmitter();
  /** Active session contains the routing and identity required by lifecycle ownership. */
  const ds: DaemonSession = {
    session: {
      sessionId: 'sid-async-settle',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'fixture',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
      cliId: opts.cliId ?? 'claude-code',
      ...(opts.promptInjection ? { promptInjection: opts.promptInjection } : {}),
    },
    worker: fakeWorker,
    workerReady: opts.workerReady ?? true,
    workerPort: 0,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: false,
  } as any;
  return ds;
}


import { LongTaskReminderController, runningLongTasks } from '../src/core/long-task-reminder.js';

/** Drive real worker IPC handlers; all application side effects are already mocked above. */
function lifecycle(opts: { cliId?: string; botCliId?: string; env?: Record<string, string>; promptInjection?: 'default' | 'none' } = {}) {
  botConfigMock.cliId = opts.botCliId ?? opts.cliId ?? 'codex';
  botConfigMock.env = opts.env;
  /** Fresh runtime prevents state leaking between retirement sequences. */
  const ds = makeDs({ cliId: opts.cliId, promptInjection: opts.promptInjection });
  initWorkerPool({ sessionReply: sessionReplyMock, getSessionWorkingDir: () => '/tmp', getActiveCount: () => 1, closeSession: vi.fn() } as any);
  __testOnly_setupWorkerHandlers(ds, ds.worker as any);
  /** Await the actual handler directly so each transition completes deterministically. */
  const message = (ds.worker as any).listeners('message')[0];
  return { ds, message };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(600_000);
  botConfigMock.cliId = 'codex';
  botConfigMock.env = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('independent execution retirement probes', () => {
  it('ignores a late first start whose exact terminal was already observed', async () => {
    /** A terminal may arrive without an earlier persisted/native execution observation. */
    const h = lifecycle();
    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_late', dispatchAttempt: 1, status: 'completed' });
    await h.message({ type: 'turn_execution_started', turnId: 'om_late', dispatchAttempt: 1, startedAtMs: 0 });
    expect(runningLongTasks(h.ds)).toEqual([]);
  });

  it('rejects a late start predating a legacy terminal while allowing a later fresh attempt', async () => {
    /** The attempt-less terminal closes any input that began before its receipt. */
    const h = lifecycle();
    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_legacy', status: 'completed' });
    await h.message({ type: 'turn_execution_started', turnId: 'om_legacy', dispatchAttempt: 1, startedAtMs: 0 });
    expect(runningLongTasks(h.ds)).toEqual([]);
    vi.setSystemTime(660_000);
    await h.message({ type: 'turn_execution_started', turnId: 'om_legacy', dispatchAttempt: 2, startedAtMs: 660_000 });
    expect(runningLongTasks(h.ds)).toHaveLength(1);
    expect(runningLongTasks(h.ds)[0].executionKey).toBe(JSON.stringify(['om_legacy', 2]));
  });

  it('does not revive a terminal clock after a late start and bounded terminal-set eviction', async () => {
    /** Drive native starts and terminals through the same production worker generation. */
    const h = lifecycle();
    await h.message({ type: 'turn_execution_started', turnId: 'om_old', dispatchAttempt: 1, startedAtMs: 0 });
    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_old', dispatchAttempt: 1, status: 'completed' });
    expect(runningLongTasks(h.ds)).toEqual([]);
    await h.message({ type: 'turn_execution_started', turnId: 'om_old', dispatchAttempt: 1, startedAtMs: 0 });
    /** Exceed the identity tombstone retention while keeping the execution clock retained. */
    for (let index = 0; index < 65; index++) {
      await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: `om_finished_${index}`, status: 'completed' });
    }
    expect(h.ds.terminalIdentityTurnIds?.has('om_old')).toBe(false);
    expect(runningLongTasks(h.ds)).toEqual([]);
  });

  it('does not revive an attempt clock when a compatibility terminal omits attempt and its tombstone expires', async () => {
    /** Drive native starts and terminals through the same production worker generation. */
    const h = lifecycle();
    await h.message({ type: 'turn_execution_started', turnId: 'om_old', dispatchAttempt: 1, startedAtMs: 0 });
    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_old', status: 'completed' });
    expect(runningLongTasks(h.ds)).toEqual([]);
    /** Exceed the identity tombstone retention while keeping the execution clock retained. */
    for (let index = 0; index < 65; index++) {
      await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: `om_finished_${index}`, status: 'completed' });
    }
    expect(runningLongTasks(h.ds)).toEqual([]);
  });

  it('does not let a prior generation terminal suppress a newly observed replacement execution', async () => {
    /** Drive native starts and terminals through the same production worker generation. */
    const h = lifecycle();
    await h.message({ type: 'turn_execution_started', turnId: 'om_restart', dispatchAttempt: 1, startedAtMs: 0 });
    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_restart', dispatchAttempt: 1, status: 'failed' });
    /** A different process advances generation through the actual reservation path. */
    const replacement = makeDs().worker;
    h.ds.worker = replacement;
    __testOnly_setupWorkerHandlers(h.ds, replacement as any);
    /** Replacement events must remain eligible even if its predecessor later emits terminal. */
    const replacementMessage = (replacement as any).listeners('message')[0];
    await replacementMessage({ type: 'turn_execution_started', turnId: 'om_restart', dispatchAttempt: 1, startedAtMs: 600_000 });
    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_restart', dispatchAttempt: 1, status: 'failed' });
    expect(runningLongTasks(h.ds)).toHaveLength(1);
    expect(runningLongTasks(h.ds)[0].workerGeneration).toBe(2);
  });

  it('accepts a fresh attempt of the same turn while ignoring its already-completed predecessor', async () => {
    /** Drive native starts and terminals through the same production worker generation. */
    const h = lifecycle();
    await h.message({ type: 'turn_execution_started', turnId: 'om_retry', dispatchAttempt: 1, startedAtMs: 0 });
    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_retry', dispatchAttempt: 1, status: 'failed' });
    await h.message({ type: 'turn_execution_started', turnId: 'om_retry', dispatchAttempt: 2, startedAtMs: 600_000 });
    /** The latest exact attempt must survive the older turn-level identity tombstone. */
    const live = runningLongTasks(h.ds);
    expect(live).toHaveLength(1);
    expect(live[0].executionKey).toBe(JSON.stringify(['om_retry', 2]));
  });

  it('retires steered turns on thinking_superseded without disturbing sibling turns', async () => {
    const h = lifecycle({ cliId: 'claude-code' });
    await h.message({ type: 'turn_execution_started', turnId: 'om_steered', dispatchAttempt: 1, startedAtMs: 600_000 });
    await h.message({ type: 'turn_execution_started', turnId: 'om_keep', dispatchAttempt: 1, startedAtMs: 600_000 });
    expect(runningLongTasks(h.ds)).toHaveLength(2);

    await h.message({ type: 'thinking_superseded', sessionId: h.ds.session.sessionId, turnId: 'om_steered', dispatchAttempt: 1 });
    expect(runningLongTasks(h.ds).map(t => t.turnId)).toEqual(['om_keep']);

    // Authoritative supersede permanently prevents reviving that exact attempt.
    await h.message({ type: 'turn_execution_started', turnId: 'om_steered', dispatchAttempt: 1, startedAtMs: 610_000 });
    expect(runningLongTasks(h.ds).map(t => t.turnId)).toEqual(['om_keep']);
  });
});

describe('non-turn-terminal PTY execution lifecycle settlement', () => {
  it.each(['antigravity', 'kimi', 'opencode'] as const)(
    '%s (default terminal mode): retires execution on idle screen so completed turns never fire reminders',
    async cliId => {
      const h = lifecycle({ cliId });
      const send = vi.fn(async (_task, _elapsed, _uuid, beforeWrite) => { beforeWrite(); });
      const controller = new LongTaskReminderController({
        config: () => ({ enabled: true, thresholdMinutes: 10, intervalMinutes: 10 }),
        sessions: () => [h.ds],
        canSend: () => true,
        send,
        now: Date.now,
      });

      // Turn 1 starts, runs for 3 minutes, then returns to idle without turn_terminal.
      await h.message({ type: 'turn_execution_started', turnId: 'om_turn1', startedAtMs: 600_000 });
      await h.message({ type: 'screen_update', content: 'working...', status: 'working', turnId: 'om_turn1' });
      expect(runningLongTasks(h.ds)).toHaveLength(1);

      vi.setSystemTime(600_000 + 3 * 60_000);
      await h.message({ type: 'prompt_ready' });
      await h.message({ type: 'screen_update', content: '> ', status: 'idle', turnId: 'om_turn1' });
      expect(h.ds.replyExecutionStarts?.get(JSON.stringify(['om_turn1', null]))?.completed).toBe(true);
      expect(runningLongTasks(h.ds)).toEqual([]);

      // 10m and 20m after start: zero false-positive reminders.
      vi.setSystemTime(600_000 + 10 * 60_000);
      await controller.scan();
      vi.setSystemTime(600_000 + 20 * 60_000);
      await controller.scan();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('antigravity (default terminal mode): fires reminders while genuinely working and stops once idle', async () => {
    const h = lifecycle({ cliId: 'antigravity' });
    const send = vi.fn(async (_task, _elapsed, _uuid, beforeWrite) => { beforeWrite(); });
    const controller = new LongTaskReminderController({
      config: () => ({ enabled: true, thresholdMinutes: 10, intervalMinutes: 10 }),
      sessions: () => [h.ds],
      canSend: () => true,
      send,
      now: Date.now,
    });

    await h.message({ type: 'turn_execution_started', turnId: 'om_long', startedAtMs: 600_000 });
    await h.message({ type: 'screen_update', content: 'working...', status: 'working', turnId: 'om_long' });

    vi.setSystemTime(600_000 + 10 * 60_000);
    await controller.scan();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe(10);

    vi.setSystemTime(600_000 + 20 * 60_000);
    await controller.scan();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toBe(20);

    // Finishes at T+25m; T+30m must stay silent.
    vi.setSystemTime(600_000 + 25 * 60_000);
    await h.message({ type: 'prompt_ready' });
    await h.message({ type: 'screen_update', content: '> ', status: 'idle', turnId: 'om_long' });
    vi.setSystemTime(600_000 + 30 * 60_000);
    await controller.scan();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('antigravity (default terminal mode): multi-turn thread tracks only the active turn and supersedes missed idle edges', async () => {
    const h = lifecycle({ cliId: 'antigravity' });
    const send = vi.fn(async (_task, _elapsed, _uuid, beforeWrite) => { beforeWrite(); });
    const controller = new LongTaskReminderController({
      config: () => ({ enabled: true, thresholdMinutes: 10, intervalMinutes: 10 }),
      sessions: () => [h.ds],
      canSend: () => true,
      send,
      now: Date.now,
    });

    // Turn 1 starts at T+0m, finishes at T+3m.
    await h.message({ type: 'turn_execution_started', turnId: 'om_t1', startedAtMs: 600_000 });
    await h.message({ type: 'screen_update', content: 'working...', status: 'working', turnId: 'om_t1' });
    vi.setSystemTime(600_000 + 3 * 60_000);
    await h.message({ type: 'screen_update', content: '> ', status: 'idle', turnId: 'om_t1' });

    // Turn 2 starts at T+4m and runs for 12m.
    vi.setSystemTime(600_000 + 4 * 60_000);
    await h.message({ type: 'turn_execution_started', turnId: 'om_t2', startedAtMs: 600_000 + 4 * 60_000 });
    await h.message({ type: 'screen_update', content: 'working...', status: 'working', turnId: 'om_t2' });

    // At T+10m (Turn 1 would have hit 10m if leaked): 0 reminders.
    vi.setSystemTime(600_000 + 10 * 60_000);
    await controller.scan();
    expect(send).not.toHaveBeenCalled();

    // At T+14m (Turn 2 hits 10m): exactly 1 reminder, owned by om_t2.
    vi.setSystemTime(600_000 + 14 * 60_000);
    await controller.scan();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].turnId).toBe('om_t2');

    // Turn 3 starts at T+16m WITHOUT an intermediate idle screen (e.g. queued/interrupted).
    vi.setSystemTime(600_000 + 16 * 60_000);
    await h.message({ type: 'turn_execution_started', turnId: 'om_t3', startedAtMs: 600_000 + 16 * 60_000 });
    expect(h.ds.replyExecutionStarts?.get(JSON.stringify(['om_t2', null]))?.completed).toBe(true);
    expect(runningLongTasks(h.ds).map(t => t.turnId)).toEqual(['om_t3']);
  });

  it('antigravity (default terminal mode): keeps Turn 1 alive across startup prompt_ready, intervening idle, background tasks, and stale idle frames', async () => {
    const h = lifecycle({ cliId: 'antigravity' });

    // Even if an idle screen arrives between init's turn_execution_started and
    // flushPending()'s literal write (or on in-worker CLI restart replay on the
    // same workerGeneration), a strictly newer start re-opens the clock, while a
    // duplicate/older start stays retired.
    await h.message({ type: 'turn_execution_started', turnId: 'om_startup', startedAtMs: 600_000 });
    await h.message({ type: 'prompt_ready' });
    await h.message({ type: 'screen_update', content: '> ', status: 'idle', turnId: 'om_startup' });
    expect(runningLongTasks(h.ds)).toEqual([]);

    // Duplicate/older start does not revive the heuristic idle retirement.
    await h.message({ type: 'turn_execution_started', turnId: 'om_startup', startedAtMs: 600_000 });
    expect(runningLongTasks(h.ds)).toEqual([]);

    // Strictly newer literal-write / replay start re-opens the execution clock.
    vi.setSystemTime(605_000);
    await h.message({ type: 'turn_execution_started', turnId: 'om_startup', startedAtMs: 605_000 });
    expect(runningLongTasks(h.ds)).toHaveLength(1);
    expect(runningLongTasks(h.ds)[0].startedAtMs).toBe(605_000);

    // Idle screen with active background tasks must NOT prematurely close the turn.
    await h.message({ type: 'screen_update', content: '> ', status: 'idle', turnId: 'om_startup', backgroundTasks: 1 });
    expect(runningLongTasks(h.ds)).toHaveLength(1);

    // Turn 2 starts; a delayed async idle snapshot attributed to om_startup must not retire om_next.
    vi.setSystemTime(610_000);
    await h.message({ type: 'turn_execution_started', turnId: 'om_next', startedAtMs: 610_000 });
    await h.message({ type: 'screen_update', content: '> ', status: 'idle', turnId: 'om_startup' });
    expect(runningLongTasks(h.ds).map(t => t.turnId)).toEqual(['om_next']);
  });

  it.each([
    { label: 'claude-code', opts: { cliId: 'claude-code' } },
    { label: 'codex', opts: { cliId: 'codex' } },
    { label: 'antigravity ACP', opts: { cliId: 'antigravity', env: { AGY_BOTMUX_TRANSPORT: 'acp' } } },
    { label: 'antigravity zero-prompt', opts: { cliId: 'antigravity', promptInjection: 'none' as const } },
  ])('$label (turn-terminal CLI): transient idle screen does not prematurely retire execution before turn_terminal', async ({ opts }) => {
    const h = lifecycle(opts);
    await h.message({ type: 'turn_execution_started', turnId: 'om_struct', dispatchAttempt: 1, startedAtMs: 600_000 });
    await h.message({ type: 'screen_update', content: 'working...', status: 'working', turnId: 'om_struct', dispatchAttempt: 1 });
    await h.message({ type: 'prompt_ready' });
    await h.message({ type: 'screen_update', content: '> ', status: 'idle', turnId: 'om_struct', dispatchAttempt: 1 });

    // Still active until authoritative turn_terminal arrives.
    expect(runningLongTasks(h.ds)).toHaveLength(1);

    await h.message({ type: 'turn_terminal', sessionId: h.ds.session.sessionId, turnId: 'om_struct', dispatchAttempt: 1, status: 'completed' });
    expect(runningLongTasks(h.ds)).toEqual([]);
  });
});
