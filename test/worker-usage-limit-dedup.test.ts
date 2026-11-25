import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyUsageLimitTriggerEdge,
  computeUsageLimitTurnScope,
  detectCliUsageLimit,
  reconcileUsageLimitState,
  usageLimitEvidenceKey,
  usageLimitStateKey,
  type CliUsageLimitState,
} from '../src/utils/cli-usage-limit.js';
import { createUsageLimitTracker } from '../src/utils/usage-limit-tracker.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { PromptSuggestionPublisher } from '../src/utils/prompt-suggestion-publisher.js';
import { ClaudeModelRequestClock } from '../src/services/claude-transcript.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const fn of cleanups.splice(0).reverse()) fn();
});

describe('non-agy usage-limit dedup and turn-scoped transient 429 cooldowns', () => {
  it('reconcileUsageLimitState defaults sameTransientTurn to false so a new turn never inherits an expired bare-429 cooldown', () => {
    const t0 = Date.parse('2026-11-25T00:00:00.000Z');
    const turn1 = detectCliUsageLimit('status: 429', new Date(t0));
    expect(turn1.limited).toBe(true);
    const expiredTurn1: CliUsageLimitState = {
      ...(turn1 as CliUsageLimitState),
      retryReady: true,
    };

    // At t0 + 15min, turn-2 hits a fresh bare 429 with future retryAtMs and retryReady=false.
    const t2 = t0 + 15 * 60_000;
    const turn2 = detectCliUsageLimit('status: 429', new Date(t2)) as CliUsageLimitState;
    expect(turn2.retryReady).toBe(false);
    expect(turn2.retryAtMs).toBeGreaterThan(t2);

    // Default (fail-closed, different turn): MUST adopt turn-2's future deadline & retryReady=false.
    const crossTurn = reconcileUsageLimitState(expiredTurn1, turn2, { nowMs: t2 });
    expect(crossTurn.retryAtMs).toBe(turn2.retryAtMs);
    expect(crossTurn.retryReady).toBe(false);

    // Explicit sameTransientTurn=true: pins initial deadline across 5-min bucket rollover.
    const sameTurn = reconcileUsageLimitState(turn1 as CliUsageLimitState, turn2, {
      nowMs: t2,
      sameTransientTurn: true,
    });
    expect(sameTurn.retryAtMs).toBe((turn1 as CliUsageLimitState).retryAtMs);
    expect(sameTurn.retryReady).toBe(true);
  });

  it('usageLimitEvidenceKey drops volatile retryAtMs only when episode-keyed or transient, preventing non-agy per-tick IPC spam', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T00:00:00.000Z'));

    // 1. Static bare 429 on Grok across 0s, 300s, 600s, 900s pins first deadline & flips retryReady on schedule.
    const frames: any[] = [];
    const usageLimitTracker = createUsageLimitTracker({ isRateKindSuppressed: () => false, isOutputActive: () => false });
    const scope: Record<string, any> = {
      renderCols: 80, renderRows: 24, backend: {}, cliSpawnGeneration: 1, cliLifetimeNonce: 1,
      TerminalRenderer: class { rawSnapshot() { return 'HTTP status: 429'; } },
      awaitingFirstPrompt: false, lastInitConfig: { cliId: 'grok' }, cliAdapter: { id: 'grok' },
      observedPaneGridRevision: 0, lastPtyActivityAtMs: 0, lastAnalyzerSnapshot: '',
      shouldCaptureScreen: () => true, isScreenSelfDriven: () => false,
      snapshotToText: async () => ({ content: 'HTTP status: 429', ansi: 'HTTP status: 429', cols: 80, rows: 24 }),
      projectedRuntimeScreenStatus: () => 'idle',
      traexQuestionBridgeActive: () => false, observeTraexAutoModelCapacity() {}, publishNativeReasoningFooter() {},
      settleBackgroundTasksFromSiblings() {}, refreshBackgroundWait() {}, startupInputHeld: () => false,
      backgroundWaitTasks: 0, backgroundWaitPayload: () => ({}), modelRequestPayload: () => ({}),
      modelRequestClock: new ClaudeModelRequestClock(), PromptSuggestionPublisher,
      currentBotmuxTurnId: 'turn-1', currentBotmuxDispatchAttempt: undefined, foldedTypeAheadTurn: undefined,
      turnTerminalEmitted: false, promptSuggestionReportTurn: () => undefined,
      SCREEN_UPDATE_INTERVAL_MS: 300_000, backendScreenEvidenceIsAuthoritativeForMutation: () => true,
      usageLimitTracker, webTerminalInputGeneration: 0,
      send: (msg: any) => { if (msg.type === 'screen_update') frames.push(msg); },
      log() {},
    };
    scope.snapshotWithLatestRuntimeStatus = loadWorkerFunction('snapshotWithLatestRuntimeStatus', scope);
    scope.classifyUsageLimitWithNativeEvidence = loadWorkerFunction('classifyUsageLimitWithNativeEvidence', scope);
    const start = loadWorkerFunction<() => void>('startScreenUpdates', scope);
    start();
    cleanups.push(() => { if (scope.screenUpdateTimer) clearInterval(scope.screenUpdateTimer); });

    // t = 300s (1st tick): initial frame with deadline = t0 + 15m? At t=300s, bucketStart=300s -> retryAtMs = 900s.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(frames).toHaveLength(1);
    const pinnedDeadline = frames[0].usageLimit.retryAtMs;
    expect(frames[0].usageLimit.retryReady).toBe(false);

    // t = 600s (2nd tick, next 5-min bucket): deadline stays pinned, still retryReady=false -> deduped (still 1 frame).
    await vi.advanceTimersByTimeAsync(300_000);
    expect(frames).toHaveLength(1);

    // t = 900s (3rd tick, reaches pinnedDeadline): flips retryReady=true and emits once with the SAME pinnedDeadline!
    await vi.advanceTimersByTimeAsync(300_000);
    expect(frames).toHaveLength(2);
    expect(frames[1].usageLimit.retryAtMs).toBe(pinnedDeadline);
    expect(frames[1].usageLimit.retryReady).toBe(true);

    // t = 1200s (4th tick, same turn): deduped (still 2 frames).
    await vi.advanceTimersByTimeAsync(300_000);
    expect(frames).toHaveLength(2);

    // new turn (turn-2) on same static 429 text reopens with fresh future deadline!
    scope.currentBotmuxTurnId = 'turn-2';
    usageLimitTracker.beginTurn('');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(frames).toHaveLength(3);
    expect(frames[2].turnId).toBe('turn-2');
    expect(frames[2].usageLimit.retryReady).toBe(false);
    expect(frames[2].usageLimit.retryAtMs).toBeGreaterThan(pinnedDeadline);

    // Direct Web Terminal submit generation bump reopens once, while non-submit keystrokes stay deduped.
    scope.webTerminalInputGeneration = 1;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(frames).toHaveLength(3);

    scope.webTerminalSubmitGeneration = 1;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(frames).toHaveLength(4);
    expect(frames[3].usageLimit.retryReady).toBe(false);
  });

  it('real worker-pool on Grok does NOT inherit expired turn-1 synthetic cooldown on turn-2 and notifies owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-grok-turn-429-'));
    const previousDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = join(root, 'data');
    cleanups.push(() => {
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
      rmSync(root, { recursive: true, force: true });
    });

    const { registerBot } = await import('../src/bot-registry.js');
    const sessionStore = await import('../src/services/session-store.js');
    const { initWorkerPool, __testOnly_setupWorkerHandlers, setActiveSessionsRegistry } = await import('../src/core/worker-pool.js');
    const { activeSessionKey } = await import('../src/core/types.js');

    const app = 'grok_turn_scoped_429_app';
    registerBot({
      larkAppId: app,
      larkAppSecret: 'secret',
      cliId: 'grok',
      allowedUsers: ['ou_owner'],
      disableStreamingCard: true,
    } as never);
    sessionStore.init(app);
    const replies: string[] = [];
    initWorkerPool({
      sessionReply: async (_root: string, content: string) => { replies.push(content); return 'om_reply'; },
      getSessionWorkingDir: () => root,
      getActiveCount: () => 1,
      closeSession: () => {},
    } as never);

    const session = sessionStore.createSession('oc_grok', 'om_grok_root', 'grok turn-scoped 429', 'group', 'chat');
    session.ownerOpenId = 'ou_owner';
    sessionStore.updateSession(session);
    const worker = Object.assign(new EventEmitter(), {
      killed: false,
      pid: 5151,
      send: () => true,
      kill: () => { worker.killed = true; return true; },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const nowMs = Date.now();
    const expiredTurn1: CliUsageLimitState = {
      limited: true,
      kind: 'rate',
      retryAtMs: nowMs - 60_000,
      retryLabel: '5-10 min',
      retryReady: true,
    };
    const ds: any = {
      session,
      larkAppId: app,
      chatId: session.chatId,
      chatType: 'group',
      scope: 'chat',
      worker,
      workerPort: 9998,
      workerReady: true,
      cliReady: true,
      spawnedAt: nowMs - 120_000,
      lastMessageAt: nowMs - 60_000,
      lastCliInputTurnId: 'turn-1',
      lastScreenStatus: 'limited',
      usageLimit: expiredTurn1,
      usageLimitTurnScope: computeUsageLimitTurnScope('turn-1', undefined, 0),
      rateLimitNotifiedKey: usageLimitStateKey(expiredTurn1),
    };
    setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
    cleanups.push(() => setActiveSessionsRegistry(new Map()));
    __testOnly_setupWorkerHandlers(ds, worker as never);

    // Now turn-2 hits a fresh bare HTTP 429 with future retryAtMs and retryReady=false.
    ds.lastCliInputTurnId = 'turn-2';
    const freshTurn2: CliUsageLimitState = {
      limited: true,
      kind: 'rate',
      retryAtMs: nowMs + 600_000,
      retryLabel: '5-10 min',
      retryReady: false,
    };
    worker.emit('message', {
      type: 'screen_update',
      content: 'status: 429',
      status: 'limited',
      usageLimit: freshTurn2,
      turnId: 'turn-2',
    });
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));

    expect(ds.usageLimit.retryAtMs).toBe(freshTurn2.retryAtMs);
    expect(ds.usageLimit.retryReady).toBe(false);
    const stored = sessionStore.getSessionFresh(session.sessionId);
    expect(stored?.usageLimit?.retryAtMs).toBe(freshTurn2.retryAtMs);
    expect(stored?.usageLimit?.retryReady).toBe(false);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('<at id=ou_owner></at>');
  });

  it('classifyUsageLimitTriggerEdge fires replaced_transient_turn with turn-scoped notificationKey even within same 5-min bucket', () => {
    const t = Date.parse('2026-11-25T00:01:00.000Z');
    const lim: CliUsageLimitState = {
      limited: true,
      kind: 'rate',
      retryAtMs: t + 540_000,
      retryLabel: '5-10 min',
      retryReady: false,
    };
    const edge = classifyUsageLimitTriggerEdge({
      prevStatus: 'limited',
      prevLimit: lim,
      prevTurnScope: computeUsageLimitTurnScope('turn-1', undefined, 0),
      nextLimit: lim,
      nextTurnScope: computeUsageLimitTurnScope('turn-2', undefined, 0),
      nowMs: t,
    });
    expect(edge?.kind).toBe('replaced_transient_turn');
    expect(edge?.notificationKey).toContain('turn-2');
    expect(usageLimitEvidenceKey(lim)).toBe(usageLimitEvidenceKey({ ...lim, retryAtMs: lim.retryAtMs + 300_000 }));
  });

  it('keeps Grok durable-turn synthetic 429 cooldown pinned without duplicate @owner alert after capture identity retires', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-grok-durable-retire-'));
    const previousDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = join(root, 'data');
    cleanups.push(() => {
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
      rmSync(root, { recursive: true, force: true });
    });

    const { registerBot } = await import('../src/bot-registry.js');
    const sessionStore = await import('../src/services/session-store.js');
    const { initWorkerPool, __testOnly_setupWorkerHandlers, setActiveSessionsRegistry } = await import('../src/core/worker-pool.js');
    const { activeSessionKey } = await import('../src/core/types.js');

    const app = 'grok_durable_retire_app';
    registerBot({
      larkAppId: app, larkAppSecret: 'secret', cliId: 'grok',
      allowedUsers: ['ou_owner'], disableStreamingCard: true,
    } as never);
    sessionStore.init(app);
    const replies: string[] = [];
    initWorkerPool({
      sessionReply: async (_root: string, content: string) => { replies.push(content); return 'om_reply'; },
      getSessionWorkingDir: () => root,
      getActiveCount: () => 1,
      closeSession: () => {},
    } as never);

    const session = sessionStore.createSession('oc_grok_d', 'om_grok_d', 'grok durable retire', 'group', 'chat');
    session.ownerOpenId = 'ou_owner';
    sessionStore.updateSession(session);
    const worker = Object.assign(new EventEmitter(), {
      killed: false, pid: 5252, send: () => true, kill: () => { worker.killed = true; return true; },
      stdout: new EventEmitter(), stderr: new EventEmitter(),
    });
    const nowMs = Date.now();
    const ds: any = {
      session, larkAppId: app, chatId: session.chatId, chatType: 'group', scope: 'chat',
      worker, workerPort: 9997, workerReady: true, cliReady: true,
      spawnedAt: nowMs - 10_000, lastMessageAt: nowMs - 5_000, lastCliInputTurnId: 'turn-1',
    };
    setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
    cleanups.push(() => setActiveSessionsRegistry(new Map()));
    __testOnly_setupWorkerHandlers(ds, worker as never);

    // Frame 1: active durable turn (turnId='turn-1', dispatchAttempt=1).
    const firstLimit: CliUsageLimitState = {
      limited: true, kind: 'rate', retryAtMs: nowMs + 480_000, retryLabel: '5-10 min', retryReady: false,
    };
    worker.emit('message', {
      type: 'screen_update', content: 'status: 429', status: 'limited',
      usageLimit: firstLimit, turnId: 'turn-1', dispatchAttempt: 1,
    });
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
    expect(replies).toHaveLength(1);

    // Frame 2: capture identity retired (turnId=undefined, dispatchAttempt=undefined) in next 5-min bucket -> MUST stay pinned with zero duplicate alert!
    const nextBucketLimit: CliUsageLimitState = {
      limited: true, kind: 'rate', retryAtMs: nowMs + 780_000, retryLabel: '5-10 min', retryReady: false,
    };
    worker.emit('message', {
      type: 'screen_update', content: 'status: 429', status: 'limited',
      usageLimit: nextBucketLimit,
    });
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
    expect(ds.usageLimit.retryAtMs).toBe(firstLimit.retryAtMs);
    expect(replies).toHaveLength(1);
  });
});
