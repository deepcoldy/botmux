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

import { sweepIdleWorkers } from '../src/core/idle-worker-sweeper.js';

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

describe('sweepIdleWorkers', () => {
  it('does nothing while live workers are at or under the resolved budget', () => {
    const now = 1_000_000;
    const activeSessions = new Map<string, any>([
      ['a', ds('a', 'tmux', now - 60 * 60_000)],
      ['b', ds('b', 'herdr', now - 50 * 60_000)],
      ['c', ds('c', 'zellij', now - 40 * 60_000)],
      ['d', ds('d', 'tmux', now - 2 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, {
      now,
      workerBudget: { maxLiveWorkers: 8, idleSuspendMs: 30 * 60_000 },
    });

    expect(suspended).toEqual([]);
    expect(activeSessions.get('a').worker).not.toBe(null);
    expect(activeSessions.get('b').worker).not.toBe(null);
    expect(activeSessions.get('c').worker).not.toBe(null);
    expect(activeSessions.get('d').worker).not.toBe(null);
  });

  it('uses the resolved policy and suspends oldest idle workers over the live-worker budget', () => {
    const now = 1_000_000;
    const activeSessions = new Map<string, any>([
      ['a', ds('a', 'tmux', now - 90 * 60_000)],
      ['b', ds('b', 'herdr', now - 80 * 60_000)],
      ['c', ds('c', 'zellij', now - 70 * 60_000)],
      ['d', ds('d', 'tmux', now - 60 * 60_000)],
      ['e', ds('e', 'herdr', now - 50 * 60_000)],
      ['f', ds('f', 'zellij', now - 40 * 60_000)],
      ['g', ds('g', 'tmux', now - 35 * 60_000)],
      ['h', ds('h', 'herdr', now - 31 * 60_000)],
      ['i', ds('i', 'zellij', now - 30 * 60_000)],
      ['j', ds('j', 'tmux', now - 2 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, {
      now,
      workerBudget: { maxLiveWorkers: 8, idleSuspendMs: 30 * 60_000 },
    });

    expect(suspended.map(s => s.sessionId)).toEqual(['a', 'b']);
    expect(activeSessions.get('a').session.status).toBe('active');
    expect(activeSessions.get('b').session.status).toBe('active');
    expect(activeSessions.get('c').worker).not.toBe(null);
    expect(activeSessions.get('j').worker).not.toBe(null);
  });

  it('honors configured max live workers and idle suspend threshold', () => {
    const now = 1_000_000;
    const activeSessions = new Map<string, any>([
      ['a', ds('a', 'tmux', now - 120 * 60_000)],
      ['b', ds('b', 'herdr', now - 90 * 60_000)],
      ['c', ds('c', 'zellij', now - 45 * 60_000)],
      ['d', ds('d', 'tmux', now - 20 * 60_000)],
      ['e', ds('e', 'herdr', now - 10 * 60_000)],
      ['f', ds('f', 'zellij', now - 5 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, {
      now,
      workerBudget: { maxLiveWorkers: 4, idleSuspendMs: 30 * 60_000 },
    });

    expect(suspended.map(s => s.sessionId)).toEqual(['a', 'b']);
    expect(activeSessions.get('a').worker).toBe(null);
    expect(activeSessions.get('b').worker).toBe(null);
    expect(activeSessions.get('c').worker).not.toBe(null);
    expect(activeSessions.get('d').worker).not.toBe(null);
  });

  it('never suspends pty workers', () => {
    const now = 1_000_000;
    const activeSessions = new Map<string, any>([
      ['a', ds('a', 'pty', now - 60 * 60_000)],
      ['b', ds('b', 'pty', now - 60 * 60_000)],
      ['c', ds('c', 'pty', now - 60 * 60_000)],
      ['d', ds('d', 'pty', now - 60 * 60_000)],
      ['e', ds('e', 'pty', now - 60 * 60_000)],
      ['f', ds('f', 'pty', now - 60 * 60_000)],
      ['g', ds('g', 'pty', now - 60 * 60_000)],
      ['h', ds('h', 'pty', now - 60 * 60_000)],
      ['i', ds('i', 'pty', now - 60 * 60_000)],
      ['j', ds('j', 'tmux', now - 60 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, {
      now,
      workerBudget: { maxLiveWorkers: 8, idleSuspendMs: 30 * 60_000 },
    });

    expect(suspended.map(s => s.sessionId)).toEqual(['j']);
    expect(activeSessions.get('a').worker).not.toBe(null);
    expect(activeSessions.get('i').worker).not.toBe(null);
  });

  it('does not suspend workers that are not idle', () => {
    const now = 1_000_000;
    const activeSessions = new Map<string, any>([
      ['a', { ...ds('a', 'tmux', now - 90 * 60_000), lastScreenStatus: 'working' }],
      ['b', { ...ds('b', 'herdr', now - 80 * 60_000), lastScreenStatus: 'analyzing' }],
      ['c', { ...ds('c', 'zellij', now - 70 * 60_000), lastScreenStatus: 'limited' }],
      ['d', { ...ds('d', 'tmux', now - 60 * 60_000), lastScreenStatus: undefined }],
      ['e', ds('e', 'herdr', now - 50 * 60_000)],
      ['f', ds('f', 'zellij', now - 40 * 60_000)],
      ['g', ds('g', 'tmux', now - 35 * 60_000)],
      ['h', ds('h', 'herdr', now - 31 * 60_000)],
      ['i', ds('i', 'zellij', now - 30 * 60_000)],
      ['j', ds('j', 'tmux', now - 2 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, {
      now,
      workerBudget: { maxLiveWorkers: 8, idleSuspendMs: 30 * 60_000 },
    });

    expect(suspended.map(s => s.sessionId)).toEqual(['e', 'f']);
    expect(activeSessions.get('a').worker).not.toBe(null);
    expect(activeSessions.get('b').worker).not.toBe(null);
    expect(activeSessions.get('c').worker).not.toBe(null);
    expect(activeSessions.get('d').worker).not.toBe(null);
  });

  it('never suspends adopt sessions even when idle, over-budget, and on a suspendable backend', () => {
    const now = 1_000_000;
    // 'a' and 'b' are the oldest idle workers — without the adopt guard they
    // would be the first picked. They are adopt sessions (one marked via the
    // runtime mirror ds.adoptedFrom, one via the persisted ds.session.adoptedFrom)
    // so they must be skipped; the sweeper falls through to the oldest *normal*
    // sessions ('c', 'd') instead. Suspending an adopt session would break it:
    // the worker-null resume path re-forks via forkWorker, not forkAdoptWorker.
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
      ['g', ds('g', 'tmux', now - 35 * 60_000)],
      ['h', ds('h', 'herdr', now - 31 * 60_000)],
      ['i', ds('i', 'zellij', now - 30 * 60_000)],
      ['j', ds('j', 'tmux', now - 2 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, {
      now,
      workerBudget: { maxLiveWorkers: 8, idleSuspendMs: 30 * 60_000 },
    });

    expect(suspended.map(s => s.sessionId)).toEqual(['c', 'd']);
    expect(activeSessions.get('a').worker).not.toBe(null);
    expect(activeSessions.get('b').worker).not.toBe(null);
  });

  it('does not suspend an adopt session even if it is the only over-budget candidate', () => {
    const now = 1_000_000;
    // Budget 1, but the single eligible-looking over-budget worker is an adopt
    // session → nothing is suspended (an adopt session is never a candidate).
    const adopt = { ...ds('a', 'tmux', now - 90 * 60_000), adoptedFrom: { tmuxTarget: 'user:0.1' } };
    const activeSessions = new Map<string, any>([
      ['a', adopt],
      ['b', ds('b', 'tmux', now - 2 * 60_000)], // recent, under idle threshold
    ]);

    const suspended = sweepIdleWorkers(activeSessions, {
      now,
      workerBudget: { maxLiveWorkers: 1, idleSuspendMs: 30 * 60_000 },
    });

    expect(suspended).toEqual([]);
    expect(activeSessions.get('a').worker).not.toBe(null);
  });

  it('always mode suspends every eligible idle worker even under the budget', () => {
    const now = 1_000_000;
    const activeSessions = new Map<string, any>([
      ['a', ds('a', 'tmux', now - 90 * 60_000)],
      ['b', ds('b', 'herdr', now - 80 * 60_000)],
      ['c', ds('c', 'zellij', now - 31 * 60_000)],
      ['d', ds('d', 'tmux', now - 2 * 60_000)], // under the idle threshold
    ]);

    // 4 live workers, budget 8 — budget mode would do nothing here.
    const suspended = sweepIdleWorkers(activeSessions, {
      now,
      workerBudget: { maxLiveWorkers: 8, idleSuspendMs: 30 * 60_000, idleSuspendMode: 'always' },
    });

    expect(suspended.map(s => s.sessionId)).toEqual(['a', 'b', 'c']);
    expect(suspended.every(s => s.reason === 'idle_suspend_always')).toBe(true);
    expect(activeSessions.get('a').worker).toBe(null);
    expect(activeSessions.get('b').worker).toBe(null);
    expect(activeSessions.get('c').worker).toBe(null);
    expect(activeSessions.get('d').worker).not.toBe(null);
    // Suspension keeps sessions active (resumable on the next message).
    expect(activeSessions.get('a').session.status).toBe('active');
  });

  it('always mode still skips non-idle, non-suspendable, and adopt sessions', () => {
    const now = 1_000_000;
    const adopt = { ...ds('a', 'tmux', now - 90 * 60_000), adoptedFrom: { tmuxTarget: 'user:0.1' } };
    const activeSessions = new Map<string, any>([
      ['a', adopt],
      ['b', { ...ds('b', 'herdr', now - 80 * 60_000), lastScreenStatus: 'working' }],
      ['c', ds('c', 'pty', now - 70 * 60_000)],
      ['d', ds('d', 'tmux', now - 60 * 60_000)],
    ]);

    const suspended = sweepIdleWorkers(activeSessions, {
      now,
      workerBudget: { maxLiveWorkers: 8, idleSuspendMs: 30 * 60_000, idleSuspendMode: 'always' },
    });

    expect(suspended.map(s => s.sessionId)).toEqual(['d']);
    expect(activeSessions.get('a').worker).not.toBe(null);
    expect(activeSessions.get('b').worker).not.toBe(null);
    expect(activeSessions.get('c').worker).not.toBe(null);
  });
});
