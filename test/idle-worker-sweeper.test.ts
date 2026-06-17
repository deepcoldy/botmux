import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/session-store.js', () => ({
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

import { sweepIdleWorkers, DEFAULT_MAX_LIVE_WORKERS } from '../src/core/idle-worker-sweeper.js';

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
});
