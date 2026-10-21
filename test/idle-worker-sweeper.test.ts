import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  updateSessionPid: vi.fn(),
  updateSession: vi.fn(),
}));
vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  selectIdleSuspendCandidates,
  sweepIdleWorkers,
  sweepIdleWorkersAsync,
  sweepIdleWorkersAfterTurnDrain,
  sweepIdleWorkersByAge,
  sweepIdleWorkersByAgeAsync,
  sweepIdleWorkersByAgeAfterTurnDrain,
  reclaimIdleWorkersForAdmission,
  reclaimIdleWorkersForAdmissionAsync,
  reclaimIdleWorkersForAdmissionAfterTurnDrain,
  DEFAULT_MAX_LIVE_WORKERS,
} from '../src/core/idle-worker-sweeper.js';
import {
  __testOnly_resetBotTurnMutationGates,
  withBotTurnAdmission,
  withBotTurnMutation,
} from '../src/core/bot-turn-mutation-gate.js';
import { updateSession } from '../src/services/session-store.js';
import { __testOnly_setSuspendBackingVerifier } from '../src/core/worker-pool.js';

function ds(sessionId: string, backendType: string, lastMessageAt: number, worker = {}) {
  return {
    session: {
      sessionId,
      status: 'active',
      title: `title-${sessionId}`,
      cliId: 'traex',
      lastMessageAt: new Date(lastMessageAt).toISOString(),
    },
    initConfig: { backendType },
    worker: {
      killed: false,
      send: vi.fn(),
      once: vi.fn(),
      kill: vi.fn(),
      exitCode: null,
      signalCode: null,
      ...worker,
    },
    workerPort: 1000,
    workerToken: 'tok',
    workerReady: true,
    larkAppId: 'cli_test',
    spawnedAt: lastMessageAt,
    lastMessageAt,
    lastScreenStatus: 'idle',
    exitEventEmitted: false,
  } as any;
}

const now = Date.UTC(2026, 9, 19, 12, 0, 0);

beforeEach(() => __testOnly_setSuspendBackingVerifier(() => true));
afterEach(() => __testOnly_setSuspendBackingVerifier());

describe('maintenance idle suspension', () => {
  const day = 24 * 60 * 60 * 1_000;

  beforeEach(() => {
    __testOnly_resetBotTurnMutationGates();
    vi.mocked(updateSession).mockReset();
  });

  it('selects only old, ready, idle, recoverable, unprotected sessions', () => {
    const old = ds('old', 'tmux', now - 8 * day, { pid: 4242 });
    const recent = ds('recent', 'tmux', now - 2 * day);
    const working = { ...ds('working', 'tmux', now - 9 * day), lastScreenStatus: 'working' };
    const notReady = { ...ds('not-ready', 'tmux', now - 9 * day), workerReady: false };
    const pty = ds('pty', 'pty', now - 10 * day);
    const adopted = { ...ds('adopted', 'tmux', now - 11 * day), adoptedFrom: { tmuxTarget: 'user:0.1' } };
    const locked = ds('locked', 'tmux', now - 12 * day);
    locked.session.locked = true;
    const protectedDispatch = ds('protected', 'tmux', now - 13 * day);
    protectedDispatch.session.codexAppDispatchLedger = [
      { dispatchId: 'd-1', turnId: 't-1', state: 'accepted', content: 'owned' },
    ];
    const pendingRepo = ds('pending-repo', 'tmux', now - 14 * day);
    pendingRepo.session.pendingRepoSetup = { mode: 'picker', prompt: 'pending' };
    const queued = ds('queued', 'tmux', now - 14 * day);
    queued.session.queued = true;
    const activationHead = ds('activation-head', 'tmux', now - 14 * day);
    activationHead.session.queuedActivationPending = true;
    const activationTail = ds('activation-tail', 'tmux', now - 14 * day);
    activationTail.session.queuedActivationTail = [{ turnId: 't-tail' }];
    const initialStart = ds('initial-start', 'tmux', now - 14 * day);
    initialStart.initialStartPending = true;
    const pendingInput = ds('pending-input', 'tmux', now - 15 * day);
    pendingInput.pendingRawInput = '/goal';
    const attention = ds('attention', 'tmux', now - 16 * day);
    attention.agentAttention = { kind: 'decision', reason: 'pick one', at: now - day };
    const unknown = ds('unknown', 'tmux', now - 17 * day);
    unknown.session.lastMessageAt = undefined;
    unknown.lastMessageAt = 0;
    unknown.idleSinceAt = undefined;
    unknown.spawnedAt = undefined;

    const activeSessions = new Map<string, any>([
      ['old', old], ['recent', recent], ['working', working], ['notReady', notReady],
      ['pty', pty], ['adopted', adopted], ['locked', locked], ['protected', protectedDispatch],
      ['pendingRepo', pendingRepo], ['queued', queued], ['activationHead', activationHead],
      ['activationTail', activationTail], ['initialStart', initialStart],
      ['pendingInput', pendingInput], ['attention', attention],
      ['unknown', unknown],
    ]);

    const candidates = selectIdleSuspendCandidates(activeSessions, { olderThanMs: 7 * day, now });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sessionId: 'old',
      larkAppId: 'cli_test',
      title: 'title-old',
      workerPid: 4242,
      backendType: 'tmux',
      processTypes: ['botmux __worker', 'tmux session', 'traex', 'traex-code-mode-host'],
    });
    expect(candidates[0]?.backendTarget).toContain('old');
  });

  it('uses the newest safety clock and rejects future timestamps', () => {
    const newlyIdle = ds('newly-idle', 'tmux', now - 9 * day);
    newlyIdle.idleSinceAt = now - day;
    const newlySpawned = ds('newly-spawned', 'tmux', now - 10 * day);
    newlySpawned.spawnedAt = now - 2 * day;
    const future = ds('future', 'tmux', now - 11 * day);
    future.session.lastMessageAt = new Date(now + day).toISOString();

    expect(selectIdleSuspendCandidates(new Map([
      ['newlyIdle', newlyIdle], ['newlySpawned', newlySpawned], ['future', future],
    ]), { olderThanMs: 7 * day, now })).toEqual([]);
  });

  it('covers every resumable backend without depending on a TraeX-specific CLI', () => {
    const entries = (['tmux', 'herdr', 'zellij', 'zmx', 'pty'] as const).map((backend) => {
      const session = ds(`old-${backend}`, backend, now - 8 * day);
      session.session.cliId = 'claude-code';
      session.initConfig.cliId = 'claude-code';
      return [backend, session] as const;
    });

    const candidates = selectIdleSuspendCandidates(new Map(entries), {
      olderThanMs: 7 * day,
      now,
    });

    expect(candidates.map(candidate => candidate.backendType)).toEqual([
      'tmux', 'herdr', 'zellij', 'zmx',
    ]);
    expect(candidates.every(candidate => candidate.processTypes.at(-1) === 'claude-code')).toBe(true);
  });

  it('isolates one persistence failure and continues the batch', () => {
    const first = ds('first', 'tmux', now - 9 * day);
    const second = ds('second', 'tmux', now - 8 * day);
    vi.mocked(updateSession).mockImplementationOnce(() => { throw new Error('disk full'); });

    const result = sweepIdleWorkersByAge(new Map([
      ['first', first], ['second', second],
    ]), { olderThanMs: 7 * day, now });

    expect(result.candidates.map(candidate => candidate.sessionId)).toEqual(['first', 'second']);
    expect(result.suspended.map(candidate => candidate.sessionId)).toEqual(['second']);
    expect(result.failures).toEqual([
      { candidate: expect.objectContaining({ sessionId: 'first' }), error: 'suspend_failed' },
    ]);
  });

  it('is idempotent when the same batch is run again', () => {
    const old = ds('old-once', 'tmux', now - 8 * day);
    const sessions = new Map<string, any>([['old', old]]);

    expect(sweepIdleWorkersByAge(sessions, { olderThanMs: 7 * day, now })).toMatchObject({
      suspended: [expect.objectContaining({ sessionId: 'old-once' })],
      failures: [],
    });
    expect(sweepIdleWorkersByAge(sessions, { olderThanMs: 7 * day, now })).toEqual({
      candidates: [],
      suspended: [],
      failures: [],
    });
  });

  it('returns null rather than mutating when the admission gate stays busy', async () => {
    const appId = 'cli_busy';
    const old = ds('old', 'tmux', now - 8 * day);
    const activeSessions = new Map<string, any>([['old', old]]);
    let release!: () => void;
    let started!: () => void;
    const admitted = new Promise<void>(resolve => { started = resolve; });
    const admission = withBotTurnAdmission(appId, async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
    });
    await admitted;

    await expect(sweepIdleWorkersByAgeAfterTurnDrain(appId, activeSessions, {
      olderThanMs: 7 * day,
      now,
      mutationAcquireTimeoutMs: 5,
    })).resolves.toBeNull();
    expect(old.worker).not.toBe(null);

    release();
    await admission;
  });

  // Every unsettled-state exclusion must be independently distinguishable:
  // deleting the corresponding OR clause in hasUnsettledIdleSuspendState (or
  // dropping one of the protected-ownership predicates) must make exactly its
  // row select a candidate.
  it.each([
    ['protected: queued todo', (d: any) => { d.session.queued = true; }],
    ['protected: activation head', (d: any) => { d.session.queuedActivationPending = true; }],
    ['protected: activation tail', (d: any) => { d.session.queuedActivationTail = [{ turnId: 't' }]; }],
    ['protected: repository setup', (d: any) => { d.session.pendingRepoSetup = { mode: 'picker' }; }],
    ['protected: initial start', (d: any) => { d.initialStartPending = true; }],
    ['protected: codex app dispatch', (d: any) => {
      d.session.codexAppDispatchLedger = [{ dispatchId: 'd', turnId: 't', state: 'accepted', content: 'x' }];
    }],
    ['pending repo picker', (d: any) => { d.pendingRepo = true; }],
    ['pending repo commit', (d: any) => { d.pendingRepoCommitInFlight = true; }],
    ['worktree creating', (d: any) => { d.worktreeCreating = true; }],
    ['pending raw input', (d: any) => { d.pendingRawInput = '/goal'; }],
    ['pending follow-up input', (d: any) => { d.pendingFollowUpInput = { userPrompt: 'p', cliInput: 'p' }; }],
    ['pending follow-ups', (d: any) => { d.pendingFollowUps = ['queued']; }],
    ['cascade in flight', (d: any) => { d.cascadeInFlight = true; }],
    ['cascade deferred', (d: any) => { d.cascadeDeferred = [{ data: 1, ctx: 2 }]; }],
    ['tui prompt card', (d: any) => { d.tuiPromptCardId = 'om_prompt'; }],
    ['tui prompt options', (d: any) => { d.tuiPromptOptions = [{ text: 'a', selected: false }]; }],
    ['tui prompt processing', (d: any) => { d.tuiPromptProcessing = true; }],
    ['agent attention', (d: any) => { d.agentAttention = { kind: 'decision', reason: 'pick', at: now }; }],
    ['usage limit', (d: any) => { d.usageLimit = { kind: 'rate_limited' }; }],
    ['background tasks still running', (d: any) => { d.backgroundTaskCount = 2; }],
    ['final output delivery', (d: any) => { d.finalOutputDeliveriesInFlight = new Set([Promise.resolve()]); }],
    ['queued suspend reason', (d: any) => { d.pendingSuspendReason = 'manual_suspend'; }],
    ['queued suspend generation', (d: any) => { d.pendingSuspendGeneration = 0; }],
    ['remote close state', (d: any) => { d.remoteCloseState = { phase: 'preparing', requestId: 'r' }; }],
    ['remote shutdown state', (d: any) => { d.remoteShutdownState = { phase: 'preparing', requestId: 'r' }; }],
  ] as const)('excludes a session with %s', (_label, mutate) => {
    const session = ds('unsettled', 'tmux', now - 8 * day);
    mutate(session);
    expect(selectIdleSuspendCandidates(new Map([['unsettled', session]]), {
      olderThanMs: 7 * day,
      now,
    })).toEqual([]);
  });

  it('yields to the event loop once per candidate in the async batch sweep', async () => {
    const first = ds('ay', 'tmux', now - 9 * day);
    const second = ds('by', 'tmux', now - 8 * day);
    const sessions = new Map<string, any>([['ay', first], ['by', second]]);
    const yields: string[] = [];

    const result = await sweepIdleWorkersByAgeAsync(
      sessions,
      { olderThanMs: 7 * day, now },
      () => { yields.push('yield'); return Promise.resolve(); },
    );

    expect(result.suspended.map(c => c.sessionId)).toEqual(['ay', 'by']);
    expect(yields).toHaveLength(2);
  });

  it('re-checks every guard immediately before acting and skips changed candidates', async () => {
    // A is older and suspends first; while its (synchronous) suspend runs, B's
    // worker screen flips to a scheduled turn. B must be re-evaluated and
    // skipped, never suspended, while the batch stays isolated per candidate.
    const a = ds('aaa', 'tmux', now - 9 * day);
    const b = ds('bbb', 'tmux', now - 8 * day);
    const sessions = new Map<string, any>([['aaa', a], ['bbb', b]]);
    __testOnly_setSuspendBackingVerifier((target: any) => {
      if (target.session.sessionId === 'aaa') b.lastScreenStatus = 'working';
      return true;
    });

    const result = await sweepIdleWorkersByAgeAsync(
      sessions,
      { olderThanMs: 7 * day, now },
      () => Promise.resolve(),
    );

    expect(result.suspended.map(c => c.sessionId)).toEqual(['aaa']);
    expect(result.failures).toEqual([
      { candidate: expect.objectContaining({ sessionId: 'bbb' }), error: 'session_changed' },
    ]);
    expect(b.worker).not.toBe(null);
  });
});

describe('sweepIdleWorkers (per-bot count cap)', () => {
  beforeEach(() => {
    __testOnly_resetBotTurnMutationGates();
  });

  it('falls back to the default cap when the bot has no explicit value', () => {
    // DEFAULT_MAX_LIVE_WORKERS + 2 sessions, oldest first by lastMessageAt.
    const n = DEFAULT_MAX_LIVE_WORKERS + 2;
    const entries: [string, any][] = [];
    for (let i = 0; i < n; i++) entries.push([`s${i}`, ds(`s${i}`, 'tmux', now - (n - i) * 60_000)]);
    const activeSessions = new Map<string, any>(entries);

    // No explicit cap → default 30 → suspend the 2 oldest (s0, s1).
    const suspended = sweepIdleWorkers(activeSessions, {});
    expect(suspended.map(s => s.sessionId)).toEqual(['s0', 's1']);
    expect(activeSessions.get('s0').worker).toBe(null);
    expect(activeSessions.get('s2').worker).not.toBe(null);
  });

  it('treats an explicit ≤0 cap as the unlimited escape hatch (never suspends)', () => {
    const make = () => new Map<string, any>([
      ['a', ds('a', 'tmux', now - 90 * 60_000)],
      ['b', ds('b', 'herdr', now - 80 * 60_000)],
      ['c', ds('c', 'zellij', now - 70 * 60_000)],
    ]);
    expect(sweepIdleWorkers(make(), { maxLiveWorkers: 0 })).toEqual([]);
    expect(sweepIdleWorkers(make(), { maxLiveWorkers: -5 })).toEqual([]);
  });

  it('does nothing while live workers are at or under the cap', () => {
    const activeSessions = new Map<string, any>([
      ['a', ds('a', 'tmux', now - 60 * 60_000)],
      ['b', ds('b', 'herdr', now - 50 * 60_000)],
      ['c', ds('c', 'zellij', now - 40 * 60_000)],
      ['d', ds('d', 'tmux', now - 2 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { maxLiveWorkers: 4 });

    expect(suspended).toEqual([]);
    expect(activeSessions.get('a').worker).not.toBe(null);
    expect(activeSessions.get('d').worker).not.toBe(null);
  });

  it('suspends the oldest (by lastMessageAt) sessions down to the cap', () => {
    const activeSessions = new Map<string, any>([
      ['a', ds('a', 'tmux', now - 90 * 60_000)],
      ['b', ds('b', 'herdr', now - 80 * 60_000)],
      ['c', ds('c', 'zellij', now - 70 * 60_000)],
      ['d', ds('d', 'tmux', now - 60 * 60_000)],
      ['e', ds('e', 'herdr', now - 50 * 60_000)],
      ['f', ds('f', 'zellij', now - 40 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { maxLiveWorkers: 4 });

    expect(suspended.map(s => s.sessionId)).toEqual(['a', 'b']);
    expect(suspended.every(s => s.reason === 'live_worker_cap')).toBe(true);
    expect(activeSessions.get('a').worker).toBe(null);
    expect(activeSessions.get('b').worker).toBe(null);
    expect(activeSessions.get('c').worker).not.toBe(null);
    expect(activeSessions.get('f').worker).not.toBe(null);
  });

  it('skips an idle session with durable Codex App dispatch ownership and suspends the next candidate', () => {
    const owned = ds('a', 'tmux', now - 90 * 60_000);
    owned.session.codexAppDispatchLedger = [
      { dispatchId: 'd-1', turnId: 't-1', state: 'accepted', content: 'owned' },
    ];
    const activeSessions = new Map<string, any>([
      ['a', owned],
      ['b', ds('b', 'tmux', now - 80 * 60_000)],
      ['c', ds('c', 'tmux', now - 70 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { maxLiveWorkers: 2 });

    expect(suspended.map(entry => entry.sessionId)).toEqual(['b']);
    expect(activeSessions.get('a').worker).not.toBe(null);
    expect(activeSessions.get('b').worker).toBe(null);
  });

  it('is purely count-based: suspends a recently-active session with NO idle-time threshold', () => {
    // Both sessions are only a couple minutes idle. The old budget had a 30-min
    // idle gate that would have suspended nothing here; the new policy caps by
    // count alone, so the single oldest session is suspended down to the cap.
    const activeSessions = new Map<string, any>([
      ['a', ds('a', 'tmux', now - 2 * 60_000)],
      ['b', ds('b', 'herdr', now - 1 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { maxLiveWorkers: 1 });

    expect(suspended.map(s => s.sessionId)).toEqual(['a']);
    expect(activeSessions.get('a').worker).toBe(null);
    expect(activeSessions.get('b').worker).not.toBe(null);
  });

  it('never suspends pty (non-resumable) workers', () => {
    const activeSessions = new Map<string, any>([
      ['a', ds('a', 'pty', now - 60 * 60_000)],
      ['b', ds('b', 'pty', now - 60 * 60_000)],
      ['c', ds('c', 'pty', now - 60 * 60_000)],
      ['d', ds('d', 'tmux', now - 60 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { maxLiveWorkers: 1 });

    // Cap 1, 4 live → wants to drop 3, but only the single tmux session is
    // resumable, so only 'd' can be suspended.
    expect(suspended.map(s => s.sessionId)).toEqual(['d']);
    expect(activeSessions.get('a').worker).not.toBe(null);
    expect(activeSessions.get('c').worker).not.toBe(null);
  });

  it('never suspends a session that is mid-turn (lastScreenStatus !== idle)', () => {
    const activeSessions = new Map<string, any>([
      ['a', { ...ds('a', 'tmux', now - 90 * 60_000), lastScreenStatus: 'working' }],
      ['b', { ...ds('b', 'herdr', now - 80 * 60_000), lastScreenStatus: 'analyzing' }],
      ['c', { ...ds('c', 'zellij', now - 70 * 60_000), lastScreenStatus: 'limited' }],
      ['d', { ...ds('d', 'tmux', now - 60 * 60_000), lastScreenStatus: undefined }],
      ['e', ds('e', 'herdr', now - 50 * 60_000)],
      ['f', ds('f', 'zellij', now - 40 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { maxLiveWorkers: 4 });

    // a–d are busy → only the two idle ones (e, f) are eligible.
    expect(suspended.map(s => s.sessionId)).toEqual(['e', 'f']);
    expect(activeSessions.get('a').worker).not.toBe(null);
    expect(activeSessions.get('d').worker).not.toBe(null);
  });

  it('never suspends an idle session whose background tasks are still running (cap, TTL and admission rescue)', () => {
    // 'waiting' ended its turn but its CI monitor still runs (the card shows
    // 「后台子任务运行中（1）」): killing the CLI would kill the monitor.
    const make = () => new Map<string, any>([
      ['waiting', { ...ds('waiting', 'tmux', now - 90 * 60_000), backgroundTaskCount: 1, idleSinceAt: now - 90 * 60_000 }],
      ['idle', { ...ds('idle', 'tmux', now - 80 * 60_000), idleSinceAt: now - 80 * 60_000 }],
      ['recent', ds('recent', 'tmux', now - 10 * 60_000)],
    ]);

    let activeSessions = make();
    expect(sweepIdleWorkers(activeSessions, { maxLiveWorkers: 1 }).map(s => s.sessionId)).toEqual(['idle', 'recent']);
    expect(activeSessions.get('waiting').worker).not.toBe(null);

    activeSessions = make();
    expect(sweepIdleWorkers(activeSessions, { maxLiveWorkers: 0, idleTtlMs: 30 * 60_000, now })
      .map(s => s.sessionId)).toEqual(['idle']);

    activeSessions = make();
    expect(reclaimIdleWorkersForAdmission(activeSessions, { maxSuspend: 4 }).map(s => s.sessionId)).toEqual(['idle', 'recent']);

    // Once the task stops (the next screen_update carries no count), it is an
    // ordinary idle candidate again.
    activeSessions = make();
    activeSessions.get('waiting').backgroundTaskCount = undefined;
    expect(sweepIdleWorkers(activeSessions, { maxLiveWorkers: 2 }).map(s => s.sessionId)).toEqual(['waiting']);
  });

  it('never suspends adopt sessions even when oldest and over cap', () => {
    // 'a' (runtime mirror) and 'b' (persisted marker) are the oldest, but are
    // adopt sessions → skipped; the sweeper falls through to the oldest normal
    // sessions ('c', 'd').
    const adoptRuntime = { ...ds('a', 'tmux', now - 90 * 60_000), adoptedFrom: { tmuxTarget: 'user:0.1' } };
    const adoptPersisted = ds('b', 'herdr', now - 80 * 60_000);
    adoptPersisted.session.adoptedFrom = { herdrTarget: 'user-herdr' };
    const activeSessions = new Map<string, any>([
      ['a', adoptRuntime],
      ['b', adoptPersisted],
      ['c', ds('c', 'zellij', now - 70 * 60_000)],
      ['d', ds('d', 'tmux', now - 60 * 60_000)],
      ['e', ds('e', 'herdr', now - 50 * 60_000)],
      ['f', ds('f', 'zellij', now - 40 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { maxLiveWorkers: 4 });

    expect(suspended.map(s => s.sessionId)).toEqual(['c', 'd']);
    expect(activeSessions.get('a').worker).not.toBe(null);
    expect(activeSessions.get('b').worker).not.toBe(null);
  });

  it('does not suspend an adopt session even if it is the only over-cap candidate', () => {
    const adopt = { ...ds('a', 'tmux', now - 90 * 60_000), adoptedFrom: { tmuxTarget: 'user:0.1' } };
    const activeSessions = new Map<string, any>([
      ['a', adopt],
      ['b', ds('b', 'pty', now - 2 * 60_000)], // pty → also never suspendable
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { maxLiveWorkers: 1 });

    expect(suspended).toEqual([]);
    expect(activeSessions.get('a').worker).not.toBe(null);
  });

  it('waits for pre-accept inbound turns before choosing an idle cap victim', async () => {
    const appId = 'cli_a';
    const a = ds('a', 'tmux', now - 90 * 60_000);
    const b = ds('b', 'tmux', now - 10 * 60_000);
    const activeSessions = new Map<string, any>([['a', a], ['b', b]]);
    let releaseAdmission!: () => void;
    const pausedBeforeAccept = new Promise<void>(resolve => { releaseAdmission = resolve; });
    let admissionStarted!: () => void;
    const started = new Promise<void>(resolve => { admissionStarted = resolve; });

    // Session A has entered the existing-owner message path but is still
    // waiting on sender/reaction work, so its old screen snapshot says idle and
    // its durable dispatch ledger is not populated yet.
    const inboundA = withBotTurnAdmission(appId, async () => {
      admissionStarted();
      await pausedBeforeAccept;
      // Durable acceptance occurs before the admission is released.
      a.session.codexAppDispatchLedger = [
        { dispatchId: 'd-a', turnId: 't-a', state: 'accepted', content: 'message-a' },
      ];
    });
    await started;

    // Spawning B puts the bot over cap.  The cap sweep must drain A's
    // admission rather than synchronously suspending A from its stale snapshot.
    const sweep = sweepIdleWorkersAfterTurnDrain(appId, activeSessions, { maxLiveWorkers: 1 });
    await Promise.resolve();
    expect(a.worker).not.toBe(null);

    releaseAdmission();
    await inboundA;
    const suspended = await sweep;

    expect(suspended.map(entry => entry.sessionId)).toEqual(['b']);
    expect(a.worker).not.toBe(null);
    expect(b.worker).toBe(null);
  });

  it('queues a Codex App cap sweep behind a same-admission mutation and preserves its durable owner', async () => {
    const appId = 'cli_same_admission';
    const owned = ds('owned', 'tmux', now - 90 * 60_000);
    owned.session.codexAppDispatchLedger = [
      { dispatchId: 'd-owned', turnId: 't-owned', state: 'accepted', content: 'owned' },
    ];
    const next = ds('next', 'tmux', now - 80 * 60_000);
    const newest = ds('newest', 'tmux', now - 10 * 60_000);
    const activeSessions = new Map<string, any>([
      ['owned', owned],
      ['next', next],
      ['newest', newest],
    ]);
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });

    const admitted = withBotTurnAdmission(appId, async () => {
      const firstMutation = withBotTurnMutation(appId, async () => {
        firstStarted();
        await holdFirst;
      });
      const sweep = sweepIdleWorkersAfterTurnDrain(appId, activeSessions, {
        maxLiveWorkers: 2,
        mutationAcquireTimeoutMs: 1_000,
      });
      const [, suspended] = await Promise.all([firstMutation, sweep]);
      return suspended;
    });

    await started;
    await Promise.resolve();
    const stayedLiveWhileQueued = next.worker !== null;
    releaseFirst();
    expect(stayedLiveWhileQueued).toBe(true);

    await expect(admitted).resolves.toEqual([
      { sessionId: 'next', reason: 'live_worker_cap' },
    ]);
    expect(owned.worker).not.toBe(null);
    expect(next.worker).toBe(null);
  });

  it('skips a sweep after a bounded wait instead of freezing the bot mutation gate', async () => {
    const appId = 'cli_wedged';
    const activeSessions = new Map<string, any>([
      ['a', ds('a', 'tmux', now - 90 * 60_000)],
      ['b', ds('b', 'tmux', now - 10 * 60_000)],
    ]);
    let releaseAdmission!: () => void;
    let admissionStarted!: () => void;
    const started = new Promise<void>(resolve => { admissionStarted = resolve; });
    const admission = withBotTurnAdmission(appId, async () => {
      admissionStarted();
      await new Promise<void>(resolve => { releaseAdmission = resolve; });
    });
    await started;

    await expect(sweepIdleWorkersAfterTurnDrain(appId, activeSessions, {
      maxLiveWorkers: 1,
      mutationAcquireTimeoutMs: 5,
    })).resolves.toEqual([]);
    expect(activeSessions.get('a').worker).not.toBe(null);

    releaseAdmission();
    await admission;
    await expect(withBotTurnAdmission(appId, async () => 'open')).resolves.toBe('open');
  });
});

describe('sweepIdleWorkers (per-bot idle TTL)', () => {
  beforeEach(() => {
    __testOnly_resetBotTurnMutationGates();
  });

  const ttlMs = 30 * 60_000;

  it('suspends an idle session past the TTL with reason idle_ttl even under the cap', () => {
    const activeSessions = new Map<string, any>([
      ['a', { ...ds('a', 'tmux', now - 60 * 60_000), idleSinceAt: now - 31 * 60_000 }],
      ['b', { ...ds('b', 'herdr', now - 10 * 60_000), idleSinceAt: now - 5 * 60_000 }],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { maxLiveWorkers: 30, idleTtlMs: ttlMs, now });

    expect(suspended).toEqual([{ sessionId: 'a', reason: 'idle_ttl' }]);
    expect(activeSessions.get('a').worker).toBe(null);
    expect(activeSessions.get('b').worker).not.toBe(null);
  });

  it('does not suspend when the TTL is not reached yet (boundary inclusive)', () => {
    const activeSessions = new Map<string, any>([
      // stamp exactly at now-ttl → idleSinceAt+ttl === now → due (inclusive).
      ['due', { ...ds('due', 'tmux', now - 60 * 60_000), idleSinceAt: now - ttlMs }],
      // 1ms short of the boundary → stays live.
      ['soon', { ...ds('soon', 'herdr', now - 60 * 60_000), idleSinceAt: now - ttlMs + 1 }],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { idleTtlMs: ttlMs, now });

    expect(suspended.map(s => s.sessionId)).toEqual(['due']);
    expect(activeSessions.get('soon').worker).not.toBe(null);
  });

  it('does not TTL-suspend a session without an idleSinceAt stamp', () => {
    const activeSessions = new Map<string, any>([
      // lastScreenStatus idle but no stamp (e.g. restored after daemon restart).
      ['a', ds('a', 'tmux', now - 24 * 60 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { idleTtlMs: ttlMs, now });

    expect(suspended).toEqual([]);
    expect(activeSessions.get('a').worker).not.toBe(null);
  });

  it('does not TTL-suspend busy / adopt / non-resumable sessions even when stamp is old', () => {
    const adopt = { ...ds('adopt', 'tmux', now - 24 * 60 * 60_000), idleSinceAt: now - 60 * 60_000, adoptedFrom: { x: 1 } };
    const activeSessions = new Map<string, any>([
      ['busy', { ...ds('busy', 'tmux', now - 24 * 60 * 60_000), lastScreenStatus: 'working', idleSinceAt: now - 60 * 60_000 }],
      ['pty', { ...ds('pty', 'pty', now - 24 * 60 * 60_000), idleSinceAt: now - 60 * 60_000 }],
      ['riff', { ...ds('riff', 'riff', now - 24 * 60 * 60_000), idleSinceAt: now - 60 * 60_000 }],
      ['adopt', adopt],
      ['ok', { ...ds('ok', 'zellij', now - 24 * 60 * 60_000), idleSinceAt: now - 31 * 60_000 }],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { idleTtlMs: ttlMs, now });

    expect(suspended.map(s => s.sessionId)).toEqual(['ok']);
    for (const id of ['busy', 'pty', 'riff', 'adopt']) {
      expect(activeSessions.get(id).worker).not.toBe(null);
    }
  });

  it('still applies the TTL when maxLiveWorkers is the ≤0 unlimited escape hatch', () => {
    const activeSessions = new Map<string, any>([
      ['a', { ...ds('a', 'tmux', now - 100 * 60_000), idleSinceAt: now - 31 * 60_000 }],
      ['b', { ...ds('b', 'herdr', now - 50 * 60_000), idleSinceAt: now - 5 * 60_000 }],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { maxLiveWorkers: 0, idleTtlMs: ttlMs, now });

    expect(suspended).toEqual([{ sessionId: 'a', reason: 'idle_ttl' }]);
    expect(activeSessions.get('b').worker).not.toBe(null);
  });

  it('takes the UNION of cap victims and TTL victims in one LRU-ordered pass', () => {
    // Five live, cap=3 → two over cap. TTL additionally expires 'ttlNew',
    // which is NOT one of the two oldest: union must suspend 3 sessions and
    // label each with its own reason.
    const activeSessions = new Map<string, any>([
      ['old1', { ...ds('old1', 'tmux', now - 100 * 60_000), idleSinceAt: now - 5 * 60_000 }],
      ['old2', { ...ds('old2', 'herdr', now - 90 * 60_000), idleSinceAt: now - 5 * 60_000 }],
      ['mid', { ...ds('mid', 'zellij', now - 80 * 60_000), idleSinceAt: now - 5 * 60_000 }],
      ['ttlNew', { ...ds('ttlNew', 'tmux', now - 10 * 60_000), idleSinceAt: now - 45 * 60_000 }],
      ['new', { ...ds('new', 'zmx', now - 5 * 60_000), idleSinceAt: now - 2 * 60_000 }],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { maxLiveWorkers: 3, idleTtlMs: ttlMs, now });

    expect(suspended).toEqual([
      { sessionId: 'old1', reason: 'live_worker_cap' },
      { sessionId: 'old2', reason: 'live_worker_cap' },
      { sessionId: 'ttlNew', reason: 'idle_ttl' },
    ]);
    expect(activeSessions.get('mid').worker).not.toBe(null);
    expect(activeSessions.get('new').worker).not.toBe(null);
  });

  it('does not double-count a TTL victim that already brings the bot to the cap', () => {
    // Two live, cap=1 → one over cap. The OLDEST is itself TTL-due: it must be
    // suspended exactly once as idle_ttl, and the still-under-TTL second session
    // must NOT be cap-suspended (the TTL suspension already reached the cap).
    const activeSessions = new Map<string, any>([
      ['old', { ...ds('old', 'tmux', now - 100 * 60_000), idleSinceAt: now - 40 * 60_000 }],
      ['young', { ...ds('young', 'herdr', now - 50 * 60_000), idleSinceAt: now - 5 * 60_000 }],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, { maxLiveWorkers: 1, idleTtlMs: ttlMs, now });

    expect(suspended).toEqual([{ sessionId: 'old', reason: 'idle_ttl' }]);
    expect(activeSessions.get('young').worker).not.toBe(null);
  });

  it('does nothing when TTL is configured but nobody is due (also under cap)', () => {
    const activeSessions = new Map<string, any>([
      ['a', { ...ds('a', 'tmux', now - 60 * 60_000), idleSinceAt: now - 5 * 60_000 }],
      ['b', { ...ds('b', 'herdr', now - 40 * 60_000), idleSinceAt: now - 3 * 60_000 }],
    ]);

    expect(sweepIdleWorkers(activeSessions, { idleTtlMs: ttlMs, now })).toEqual([]);
  });
});

describe('automatic idle worker async variants', () => {
  beforeEach(() => {
    __testOnly_resetBotTurnMutationGates();
  });

  it('yields before each cap candidate and re-reads every candidate before suspending', async () => {
    const a = ds('async-a', 'tmux', now - 90 * 60_000);
    const b = ds('async-b', 'tmux', now - 80 * 60_000);
    const c = ds('async-c', 'tmux', now - 70 * 60_000);
    const activeSessions = new Map<string, any>([['a', a], ['b', b], ['c', c]]);
    let yields = 0;

    const suspended = await sweepIdleWorkersAsync(
      activeSessions,
      { maxLiveWorkers: 1 },
      () => {
        yields++;
        if (yields === 2) b.lastScreenStatus = 'working';
        return Promise.resolve();
      },
    );

    expect(yields).toBe(3);
    expect(suspended).toEqual([
      { sessionId: 'async-a', reason: 'live_worker_cap' },
      { sessionId: 'async-c', reason: 'live_worker_cap' },
    ]);
    expect(b.worker).not.toBe(null);
  });

  it('does not transfer an old candidate to a replacement generation with the same session id', async () => {
    const old = { ...ds('same-id', 'tmux', now - 90 * 60_000), idleSinceAt: now - 40 * 60_000 };
    const recent = ds('recent', 'tmux', now - 2 * 60_000);
    const activeSessions = new Map<string, any>([['same', old], ['recent', recent]]);
    const replacement = { ...ds('same-id', 'tmux', now - 1 * 60_000), idleSinceAt: now - 40 * 60_000 };
    let yielded = false;

    const suspended = await sweepIdleWorkersAsync(
      activeSessions,
      { idleTtlMs: 30 * 60_000, now },
      () => {
        if (!yielded) activeSessions.set('same', replacement);
        yielded = true;
        return Promise.resolve();
      },
    );

    expect(suspended).toEqual([]);
    expect(old.worker).not.toBe(null);
    expect(replacement.worker).not.toBe(null);
  });

  it('isolates one failed admission candidate and continues with unrelated safe candidates', async () => {
    const a = ds('fail-a', 'tmux', now - 90 * 60_000);
    const b = ds('safe-b', 'tmux', now - 80 * 60_000);
    const c = ds('safe-c', 'tmux', now - 70 * 60_000);
    const activeSessions = new Map<string, any>([['a', a], ['b', b], ['c', c]]);
    __testOnly_setSuspendBackingVerifier((target: any) => {
      if (target.session.sessionId === 'fail-a') throw new Error('candidate failure');
      return true;
    });

    const suspended = await reclaimIdleWorkersForAdmissionAsync(
      activeSessions,
      { maxSuspend: 2 },
      () => Promise.resolve(),
    );

    expect(suspended).toEqual([
      { sessionId: 'safe-b', reason: 'admission_memory' },
      { sessionId: 'safe-c', reason: 'admission_memory' },
    ]);
    expect(a.worker).not.toBe(null);
  });

  it('isolates one failed cap candidate and still reaches the cap with later safe candidates', async () => {
    const a = ds('cap-fail-a', 'tmux', now - 90 * 60_000);
    const b = ds('cap-safe-b', 'tmux', now - 80 * 60_000);
    const c = ds('cap-safe-c', 'tmux', now - 70 * 60_000);
    const activeSessions = new Map<string, any>([['a', a], ['b', b], ['c', c]]);
    __testOnly_setSuspendBackingVerifier((target: any) => {
      if (target.session.sessionId === 'cap-fail-a') throw new Error('candidate failure');
      return true;
    });

    const suspended = await sweepIdleWorkersAsync(
      activeSessions,
      { maxLiveWorkers: 1 },
      () => Promise.resolve(),
    );

    expect(suspended).toEqual([
      { sessionId: 'cap-safe-b', reason: 'live_worker_cap' },
      { sessionId: 'cap-safe-c', reason: 'live_worker_cap' },
    ]);
    expect(a.worker).not.toBe(null);
  });

  it('keeps the cap/TTL AfterTurnDrain path asynchronous and skips drift before the first kill', async () => {
    const due = { ...ds('auto-ttl', 'tmux', now - 90 * 60_000), idleSinceAt: now - 40 * 60_000 };
    const activeSessions = new Map<string, any>([['due', due]]);
    setImmediate(() => { due.lastScreenStatus = 'working'; });

    await expect(sweepIdleWorkersAfterTurnDrain('cli_auto_ttl_async', activeSessions, {
      idleTtlMs: 30 * 60_000,
      now,
    })).resolves.toEqual([]);
    expect(due.worker).not.toBe(null);
  });

  it('keeps the admission AfterTurnDrain path asynchronous and skips drift before the first kill', async () => {
    const candidate = ds('auto-admission', 'tmux', now - 90 * 60_000);
    const activeSessions = new Map<string, any>([['candidate', candidate]]);
    setImmediate(() => { candidate.lastScreenStatus = 'working'; });

    await expect(reclaimIdleWorkersForAdmissionAfterTurnDrain(
      'cli_auto_admission_async',
      activeSessions,
    )).resolves.toEqual([]);
    expect(candidate.worker).not.toBe(null);
  });
});

describe('reclaimIdleWorkersForAdmission (marginal-admission rescue)', () => {
  beforeEach(() => {
    __testOnly_resetBotTurnMutationGates();
  });

  it('reclaims idle candidates regardless of any count cap, LRU first', () => {
    // Six live, well under the default cap of 30 — the cap path does nothing,
    // but admission rescue still reclaims the four oldest.
    const entries: [string, any][] = [];
    for (let i = 0; i < 6; i++) {
      entries.push([`s${i}`, ds(`s${i}`, 'tmux', now - (60 - i) * 60_000)]);
    }
    const activeSessions = new Map<string, any>(entries);

    const suspended = reclaimIdleWorkersForAdmission(activeSessions);

    expect(suspended.map(s => s.sessionId)).toEqual(['s0', 's1', 's2', 's3']);
    expect(suspended.every(s => s.reason === 'admission_memory')).toBe(true);
    for (const id of ['s0', 's1', 's2', 's3']) expect(activeSessions.get(id).worker).toBe(null);
    for (const id of ['s4', 's5']) expect(activeSessions.get(id).worker).not.toBe(null);
  });

  it('respects a smaller injected maxSuspend and treats ≤0 as a no-op', () => {
    const make = () => new Map<string, any>([
      ['a', ds('a', 'tmux', now - 60 * 60_000)],
      ['b', ds('b', 'tmux', now - 50 * 60_000)],
    ]);
    expect(reclaimIdleWorkersForAdmission(make(), { maxSuspend: 1 }).map(s => s.sessionId)).toEqual(['a']);
    expect(reclaimIdleWorkersForAdmission(make(), { maxSuspend: 0 })).toEqual([]);
  });

  it('never reclaims adopt, busy, or non-resumable sessions', () => {
    const adopt = { ...ds('adopt', 'tmux', now - 100 * 60_000), adoptedFrom: { x: 1 } };
    const activeSessions = new Map<string, any>([
      ['adopt', adopt],
      ['busy', { ...ds('busy', 'tmux', now - 90 * 60_000), lastScreenStatus: 'working' }],
      ['pty', ds('pty', 'pty', now - 80 * 60_000)],
      ['ok', ds('ok', 'herdr', now - 70 * 60_000)],
    ]);

    const suspended = reclaimIdleWorkersForAdmission(activeSessions, { maxSuspend: 4 });

    expect(suspended.map(s => s.sessionId)).toEqual(['ok']);
    for (const id of ['adopt', 'busy', 'pty']) expect(activeSessions.get(id).worker).not.toBe(null);
  });

  it('returns [] when there are no reclaimable idle sessions', () => {
    const activeSessions = new Map<string, any>([
      ['busy', { ...ds('busy', 'tmux', now - 90 * 60_000), lastScreenStatus: 'working' }],
    ]);
    expect(reclaimIdleWorkersForAdmission(activeSessions)).toEqual([]);
    expect(activeSessions.get('busy').worker).not.toBe(null);
  });

  it('never reclaims the rescue-initiating session, even when it is an idle candidate', () => {
    // Five LRU-ordered idle candidates; s1 asks for the rescue. It must be
    // skipped and reclaim must continue with the next four (still capped at 4).
    const entries: [string, any][] = [];
    for (let i = 0; i < 5; i++) {
      entries.push([`s${i}`, ds(`s${i}`, 'tmux', now - (60 - i) * 60_000)]);
    }
    const activeSessions = new Map<string, any>(entries);

    const suspended = reclaimIdleWorkersForAdmission(activeSessions, {
      excludeSessionId: 's1',
    });

    expect(suspended.map(s => s.sessionId)).toEqual(['s0', 's2', 's3', 's4']);
    expect(activeSessions.get('s1').worker).not.toBe(null);
    for (const id of ['s0', 's2', 's3', 's4']) expect(activeSessions.get(id).worker).toBe(null);
  });

  it('gated wrapper reclaims inside an admission lease and skips on timeout', async () => {
    const appId = 'cli_reclaim';
    const activeSessions = new Map<string, any>([
      ['a', ds('a', 'tmux', now - 90 * 60_000)],
    ]);

    await withBotTurnAdmission(appId, async () => {
      const suspended = await reclaimIdleWorkersForAdmissionAfterTurnDrain(appId, activeSessions);
      expect(suspended).toEqual([{ sessionId: 'a', reason: 'admission_memory' }]);
      expect(activeSessions.get('a').worker).toBe(null);
    });

    // A wedged foreign admission → bounded skip, no suspension.
    const blocked = new Map<string, any>([
      ['b', ds('b', 'tmux', now - 90 * 60_000)],
    ]);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { started = resolve; });
    const foreign = withBotTurnAdmission('cli_wedged_reclaim', async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
    });
    await gate;
    await expect(reclaimIdleWorkersForAdmissionAfterTurnDrain('cli_wedged_reclaim', blocked, {
      mutationAcquireTimeoutMs: 5,
    })).resolves.toEqual([]);
    expect(blocked.get('b').worker).not.toBe(null);
    release();
    await foreign;
  });
});
