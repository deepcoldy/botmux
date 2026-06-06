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
});
