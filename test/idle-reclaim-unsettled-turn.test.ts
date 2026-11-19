/**
 * worker-pool + idle-worker-sweeper: the automatic reclaims (live-worker cap,
 * idle TTL, admission rescue) run on the idle edge. An idle screen does not
 * mean the turn's answer is out: the bridge may not have handed it over yet
 * (no terminal), or the daemon may still be writing it to Lark. Suspending
 * then loses the answer. The reclaims hold such a session until the turn has
 * settled and re-check the cap as soon as it does. Each wait is bounded (a
 * delivery from its start, a terminal from the idle edge), an earlier turn
 * that never got a terminal stops counting once a later one is accepted, and
 * a CLI that never reports terminals is not waited on.
 *
 * Real worker IPC handlers and final-delivery registry; fake worker processes.
 *
 * Run: bun x vitest run --project unit test/idle-reclaim-unsettled-turn.test.ts
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/hook-runner.js', () => ({
  emitHookEvent: vi.fn(),
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
  TmuxBackend: class { static sessionName(sessionId: string) { return `bmx-${sessionId.slice(0, 8)}`; } },
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
  manualSuspendWaits,
  queueManualSuspend as queueManualSuspendBehind,
  __testOnly_resetTurnTerminalReportingClis,
  __testOnly_setupWorkerHandlers,
  __testOnly_setSuspendBackingVerifier,
} from '../src/core/worker-pool.js';
import {
  DEFAULT_MAX_LIVE_WORKERS,
  FINAL_DELIVERY_RECLAIM_GRACE_MS,
  UNSETTLED_TURN_RECLAIM_GRACE_MS,
  coalesceSweepTriggers,
  reclaimIdleWorkersForAdmission,
  sweepIdleWorkers,
  sweepIdleWorkersAsync,
} from '../src/core/idle-worker-sweeper.js';
import { beginFinalOutputDelivery } from '../src/core/final-output-delivery-drain.js';
import type { DaemonSession } from '../src/core/types.js';

const TURN = 'om_answered_turn_001';
const NEXT_TURN = 'om_answered_turn_002';

function makeFakeWorker() {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.once = vi.fn();
  worker.pid = 4242;
  worker.exitCode = null;
  worker.signalCode = null;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

function makeDs(sessionId: string, worker: any, status: 'idle' | 'working', lastMessageAt: number, cliId = 'claude-code'): DaemonSession {
  return {
    session: {
      sessionId, rootMessageId: `om_root_${sessionId}`, chatId: 'oc_chat', title: sessionId,
      status: 'active', createdAt: new Date(lastMessageAt - 86_400_000).toISOString(), chatType: 'group',
      cliId, workingDir: '/repo', cliSessionId: `native-${sessionId}`,
      lastMessageAt: new Date(lastMessageAt).toISOString(), workerGeneration: 1,
    },
    worker, workerGeneration: 1, workerPort: 9999, workerToken: 'tok', workerReady: true, larkAppId: 'app_test',
    chatId: 'oc_chat', chatType: 'group', scope: 'thread', spawnedAt: lastMessageAt, lastMessageAt,
    hasHistory: true, workingDir: '/repo', displayMode: 'hidden', lastScreenContent: '',
    lastScreenStatus: status, initConfig: { backendType: 'tmux', cliId },
  } as unknown as DaemonSession;
}

function accept(worker: any, turnId: string): void {
  worker.emit('message', { type: 'turn_input_committed', turnId });
}

function working(worker: any, turnId: string): void {
  worker.emit('message', { type: 'screen_update', content: '', status: 'working', turnId });
}

/** The CLI's prompt is back: the idle edge the daemon's cap sweep runs on. */
function screenIdle(worker: any, turnId = TURN): void {
  worker.emit('message', { type: 'screen_update', content: '', status: 'idle', turnId });
}

function turnTerminal(worker: any, ds: DaemonSession, turnId = TURN): void {
  worker.emit('message', { type: 'turn_terminal', sessionId: ds.session.sessionId, turnId, status: 'completed' });
}

/** A bot one session over its cap; every other session is mid-turn. The one
 *  under test runs on `cliId` and has just started TURN. */
function overCapWithOneSessionAnswering(cliId = 'claude-code') {
  const now = Date.now();
  const worker = makeFakeWorker();
  const answering = makeDs('answering', worker, 'working', now, cliId);
  __testOnly_setupWorkerHandlers(answering, worker, undefined, 1);
  const sessions = new Map<string, DaemonSession>();
  for (let i = 0; i < DEFAULT_MAX_LIVE_WORKERS; i++) {
    sessions.set(`busy-${i}`, makeDs(`busy-${i}`, makeFakeWorker(), 'working', now - (i + 1) * 60_000));
  }
  sessions.set('answering', answering);
  accept(worker, TURN);
  working(worker, TURN);
  return { worker, answering, sessions };
}

/** This daemon has seen claude-code report a turn terminal before. */
function claudeReportsTerminals(): void {
  const { worker, answering } = overCapWithOneSessionAnswering();
  turnTerminal(worker, answering);
}

async function flush(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)); }

const cap = (sessions: Map<string, DaemonSession>, now?: number) =>
  sweepIdleWorkers(sessions, now === undefined ? {} : { now });

describe('automatic reclaim of a session whose last answer may still be on its way', () => {
  let enforceLiveSessionCap: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    __testOnly_resetTurnTerminalReportingClis();
    __testOnly_setSuspendBackingVerifier(() => true);
    enforceLiveSessionCap = vi.fn();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'), getSessionWorkingDir: () => '/repo', getActiveCount: () => 1,
      closeSession: vi.fn(), enforceLiveSessionCap,
    } as any);
  });

  afterEach(() => {
    __testOnly_setSuspendBackingVerifier();
    vi.restoreAllMocks();
  });

  it('is held while idle and its turn has no terminal yet, then reclaimed once the terminal comes', async () => {
    claudeReportsTerminals();
    const { worker, answering, sessions } = overCapWithOneSessionAnswering();
    screenIdle(worker);
    await flush();

    // The bridge has not handed the answer over: cap, TTL and admission
    // rescue all leave the session alone.
    expect(cap(sessions)).toEqual([]);
    expect(sweepIdleWorkers(sessions, { idleTtlMs: 1 })).toEqual([]);
    expect(reclaimIdleWorkersForAdmission(sessions, { maxSuspend: 1 })).toEqual([]);
    expect(answering.worker).toBe(worker);

    // The answer was handed over (or deliberately not sent) and the turn ended:
    // the cap is re-checked right away rather than on the next idle edge.
    enforceLiveSessionCap.mockClear();
    turnTerminal(worker, answering);
    await flush();
    expect(enforceLiveSessionCap).toHaveBeenCalled();

    expect(cap(sessions)).toEqual([{ sessionId: 'answering', reason: 'live_worker_cap' }]);
    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(answering.worker).toBe(null);
  });

  it('leaves the cap check to the idle edge when the terminal comes while the session still works', async () => {
    claudeReportsTerminals();
    const { worker, answering } = overCapWithOneSessionAnswering();
    enforceLiveSessionCap.mockClear();

    turnTerminal(worker, answering);
    await flush();
    expect(enforceLiveSessionCap).not.toHaveBeenCalled();

    screenIdle(worker);
    await flush();
    expect(enforceLiveSessionCap).toHaveBeenCalledTimes(1);
  });

  it('is held while its answer is being delivered, then reclaimed once the delivery settles', async () => {
    const { worker, answering, sessions } = overCapWithOneSessionAnswering();
    const finishDelivery = beginFinalOutputDelivery(answering, TURN);
    turnTerminal(worker, answering);
    screenIdle(worker);
    await flush();

    expect(cap(sessions)).toEqual([]);
    expect(sweepIdleWorkers(sessions, { idleTtlMs: 1 })).toEqual([]);
    expect(reclaimIdleWorkersForAdmission(sessions, { maxSuspend: 1 })).toEqual([]);
    expect(answering.worker).toBe(worker);

    enforceLiveSessionCap.mockClear();
    finishDelivery();
    await flush();
    expect(enforceLiveSessionCap).toHaveBeenCalled();

    expect(cap(sessions)).toEqual([{ sessionId: 'answering', reason: 'live_worker_cap' }]);
    expect(answering.worker).toBe(null);
  });

  it('is re-checked right before the kill: a delivery starting during the async sweep saves it', async () => {
    const { worker, answering, sessions } = overCapWithOneSessionAnswering();
    turnTerminal(worker, answering);
    screenIdle(worker);
    await flush();

    let finishDelivery: (() => void) | undefined;
    const suspended = await sweepIdleWorkersAsync(sessions, {}, async () => {
      finishDelivery ??= beginFinalOutputDelivery(answering, TURN);
    });

    expect(suspended).toEqual([]);
    expect(answering.worker).toBe(worker);
    finishDelivery?.();
  });

  it('holds a slow delivery past the turn grace, bounded from when the delivery started', async () => {
    const { worker, answering, sessions } = overCapWithOneSessionAnswering();
    turnTerminal(worker, answering);
    screenIdle(worker);
    await flush();
    const idleAt = answering.idleSinceAt!;
    // Delivery started a while after the idle edge and is retrying.
    const startedAt = idleAt + 30_000;
    vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    beginFinalOutputDelivery(answering, TURN);
    vi.restoreAllMocks();

    expect(cap(sessions, idleAt + UNSETTLED_TURN_RECLAIM_GRACE_MS + 1)).toEqual([]);
    expect(cap(sessions, startedAt + FINAL_DELIVERY_RECLAIM_GRACE_MS - 1)).toEqual([]);
    expect(answering.worker).toBe(worker);

    // Stuck for good: no longer holds the session.
    expect(cap(sessions, startedAt + FINAL_DELIVERY_RECLAIM_GRACE_MS))
      .toEqual([{ sessionId: 'answering', reason: 'live_worker_cap' }]);
    expect(answering.worker).toBe(null);
  });

  it('stops waiting for a terminal that never comes after the turn grace', async () => {
    claudeReportsTerminals();
    const { worker, answering, sessions } = overCapWithOneSessionAnswering();
    screenIdle(worker);
    await flush();
    const idleAt = answering.idleSinceAt!;

    expect(cap(sessions, idleAt + UNSETTLED_TURN_RECLAIM_GRACE_MS - 1)).toEqual([]);
    expect(answering.worker).toBe(worker);
    expect(await sweepIdleWorkersAsync(sessions, { maxLiveWorkers: 0, idleTtlMs: 1, now: idleAt + UNSETTLED_TURN_RECLAIM_GRACE_MS }, async () => {}))
      .toEqual([{ sessionId: 'answering', reason: 'idle_ttl' }]);
    expect(answering.worker).toBe(null);
  });

  it('clocks the wait from acceptance for a turn that never showed as working', async () => {
    claudeReportsTerminals();
    const { worker, answering, sessions } = overCapWithOneSessionAnswering();
    turnTerminal(worker, answering);
    screenIdle(worker);
    await flush();
    const idleAt = answering.idleSinceAt!;

    // Long idle; then a turn runs without the screen ever leaving idle.
    vi.spyOn(Date, 'now').mockReturnValue(idleAt + 600_000);
    accept(worker, NEXT_TURN);
    vi.restoreAllMocks();

    expect(cap(sessions, idleAt + 600_000 + UNSETTLED_TURN_RECLAIM_GRACE_MS - 1)).toEqual([]);
    expect(answering.worker).toBe(worker);
  });

  it('does not wait on an earlier turn that never got a terminal once a later turn settled', async () => {
    claudeReportsTerminals();
    const { worker, answering, sessions } = overCapWithOneSessionAnswering();
    // TURN never reports a terminal (its bridge mark expired, or the CLI died).
    screenIdle(worker);
    accept(worker, NEXT_TURN);
    working(worker, NEXT_TURN);
    turnTerminal(worker, answering, NEXT_TURN);
    screenIdle(worker, NEXT_TURN);
    await flush();

    expect(cap(sessions)).toEqual([{ sessionId: 'answering', reason: 'live_worker_cap' }]);
  });

  it('does not wait for a terminal from a CLI that has never reported one', async () => {
    // Without a transcript bridge the screen idle is the turn's only end.
    const { worker, answering, sessions } = overCapWithOneSessionAnswering('copilot');
    screenIdle(worker);
    await flush();

    expect(cap(sessions)).toEqual([{ sessionId: 'answering', reason: 'live_worker_cap' }]);
    expect(answering.worker).toBe(null);
  });
});

/** What the manual suspend route does when the session is mid-turn. */
function queueManualSuspend(ds: DaemonSession): void {
  ds.pendingSuspendReason = 'manual_suspend';
  ds.pendingSuspendGeneration = ds.workerGeneration;
}

describe('a suspend queued while the session works', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testOnly_resetTurnTerminalReportingClis();
    __testOnly_setSuspendBackingVerifier(() => true);
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'), getSessionWorkingDir: () => '/repo', getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
  });

  afterEach(() => {
    __testOnly_setSuspendBackingVerifier();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits for the answer being delivered when the turn ends, then is carried out', async () => {
    const { worker, answering } = overCapWithOneSessionAnswering();
    queueManualSuspend(answering);
    // The worker handed the answer over and ended the turn; the daemon is
    // writing it to Lark when the prompt comes back.
    const finishDelivery = beginFinalOutputDelivery(answering, TURN);
    turnTerminal(worker, answering);
    screenIdle(worker);
    await flush();

    expect(answering.worker).toBe(worker);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'suspend' });
    expect(answering.pendingSuspendReason).toBe('manual_suspend');

    finishDelivery();
    await flush();
    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(answering.worker).toBe(null);
    expect(answering.pendingSuspendReason).toBeUndefined();
  });

  it('waits for the terminal of a turn that looks idle, then is carried out', async () => {
    claudeReportsTerminals();
    const { worker, answering } = overCapWithOneSessionAnswering();
    queueManualSuspend(answering);
    screenIdle(worker);
    await flush();
    expect(answering.worker).toBe(worker);

    turnTerminal(worker, answering);
    await flush();
    expect(answering.worker).toBe(null);
  });

  it('is carried out once the hold runs out, even if the delivery never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { worker, answering } = overCapWithOneSessionAnswering();
    queueManualSuspend(answering);
    beginFinalOutputDelivery(answering, TURN);
    turnTerminal(worker, answering);
    screenIdle(worker);
    await vi.advanceTimersByTimeAsync(0);
    expect(answering.worker).toBe(worker);

    await vi.advanceTimersByTimeAsync(FINAL_DELIVERY_RECLAIM_GRACE_MS - 1_000);
    expect(answering.worker).toBe(worker);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(answering.worker).toBe(null);
  });

  it('is still carried out right away when the answer is already out', async () => {
    const { worker, answering } = overCapWithOneSessionAnswering();
    queueManualSuspend(answering);
    turnTerminal(worker, answering);
    screenIdle(worker);
    await flush();

    expect(answering.worker).toBe(null);
  });

  // `botmux suspend` asked for after the prompt came back: the route queues
  // only while one of these waits holds, and says which.
  it('makes a suspend asked for once the screen is idle wait for the answer being delivered', async () => {
    const { worker, answering } = overCapWithOneSessionAnswering();
    const finishDelivery = beginFinalOutputDelivery(answering, TURN);
    turnTerminal(worker, answering);
    screenIdle(worker);
    await flush();

    const waits = manualSuspendWaits(answering);
    expect(waits.waitingFor).toEqual(['reply']);
    expect(waits.replyHoldUntil).toBeGreaterThan(Date.now());
    queueManualSuspendBehind(answering, waits);
    await flush();
    expect(answering.worker).toBe(worker);

    finishDelivery();
    await flush();
    expect(answering.worker).toBe(null);
    expect(answering.pendingSuspendReason).toBeUndefined();
  });

  it('carries a suspend asked for during the terminal wait out at the wait\'s bound, with no further edge', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    claudeReportsTerminals();
    const { worker, answering } = overCapWithOneSessionAnswering();
    screenIdle(worker);
    await vi.advanceTimersByTimeAsync(0);

    const waits = manualSuspendWaits(answering);
    expect(waits.waitingFor).toEqual(['reply']);
    expect(waits.replyHoldUntil! - Date.now()).toBeGreaterThan(UNSETTLED_TURN_RECLAIM_GRACE_MS - 1_000);
    expect(waits.replyHoldUntil! - Date.now()).toBeLessThanOrEqual(UNSETTLED_TURN_RECLAIM_GRACE_MS);
    queueManualSuspendBehind(answering, waits);
    await vi.advanceTimersByTimeAsync(UNSETTLED_TURN_RECLAIM_GRACE_MS - 1_000);
    expect(answering.worker).toBe(worker);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(answering.worker).toBe(null);
  });

  it('has nothing to wait for once the answer is out', async () => {
    const { worker, answering } = overCapWithOneSessionAnswering();
    turnTerminal(worker, answering);
    screenIdle(worker);
    await flush();

    expect(manualSuspendWaits(answering)).toEqual({ waitingFor: [] });
  });
});

describe('coalesced sweep triggers', () => {
  it('runs one more sweep for triggers that arrive while one is running', async () => {
    const runs: string[] = [];
    let release!: () => void;
    const trigger = coalesceSweepTriggers(async (source: string) => {
      runs.push(source);
      if (runs.length === 1) await new Promise<void>(done => { release = done; });
    });

    trigger('idle-edge');
    trigger('turn-settled');
    trigger('periodic');
    expect(runs).toEqual(['idle-edge']);

    release();
    await flush();
    expect(runs).toEqual(['idle-edge', 'turn-settled']);

    trigger('periodic');
    await flush();
    expect(runs).toEqual(['idle-edge', 'turn-settled', 'periodic']);
  });
});
