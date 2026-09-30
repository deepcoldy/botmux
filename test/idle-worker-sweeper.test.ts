import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  sweepIdleWorkers,
  sweepIdleWorkersAfterTurnDrain,
  reclaimIdleWorkersForAdmission,
  reclaimIdleWorkersForAdmissionAfterTurnDrain,
  DEFAULT_MAX_LIVE_WORKERS,
  ADMISSION_RECLAIM_MAX_SUSPEND,
} from '../src/core/idle-worker-sweeper.js';
import {
  __testOnly_resetBotTurnMutationGates,
  withBotTurnAdmission,
  withBotTurnMutation,
} from '../src/core/bot-turn-mutation-gate.js';

function ds(sessionId: string, backendType: string, lastMessageAt: number, worker = {}) {
  return {
    session: { sessionId, status: 'active' },
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
    lastMessageAt,
    lastScreenStatus: 'idle',
    exitEventEmitted: false,
  } as any;
}

const now = 1_000_000;

describe('sweepIdleWorkers (per-bot count cap)', () => {
  beforeEach(() => {
    __testOnly_resetBotTurnMutationGates();
  });

  it('falls back to the default cap (30) when the bot has no explicit value', () => {
    expect(DEFAULT_MAX_LIVE_WORKERS).toBe(30);
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
    expect(ADMISSION_RECLAIM_MAX_SUSPEND).toBe(4);
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
