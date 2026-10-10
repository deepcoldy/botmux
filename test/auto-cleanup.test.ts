import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_CLEANUP_TICK_MS,
  createAutoCleanupTickRunner,
  evaluateAutoCleanupDue,
  resolveCleanupHours,
  resolveCleanupIntervalMs,
  runAutoCleanupTick,
  startAutoCleanup,
  stopAutoCleanup,
  type AutoCleanupTickDeps,
} from '../src/dashboard/auto-cleanup.js';
import type { IdleCleanupSessionRow, IdleCleanupCloseResult } from '../src/dashboard/session-cleanup.js';
import type { SessionCleanupGlobalConfig } from '../src/global-config.js';

const NOW = Date.UTC(2026, 5, 22, 12, 0, 0);
const hour = 60 * 60 * 1000;
const minute = 60 * 1000;

afterEach(() => {
  stopAutoCleanup();
  vi.useRealTimers();
});

function row(id: string, patch: Record<string, unknown> = {}): IdleCleanupSessionRow & { larkAppId: string } {
  return {
    sessionId: id,
    larkAppId: 'cli_test',
    status: 'idle',
    lastMessageAt: NOW - 200 * hour,
    ...patch,
  } as IdleCleanupSessionRow & { larkAppId: string };
}

describe('auto-cleanup config resolution', () => {
  it('resolves the idle threshold, defaulting to 168h and rejecting bad values', () => {
    expect(resolveCleanupHours(undefined)).toBe(168);
    expect(resolveCleanupHours({})).toBe(168);
    expect(resolveCleanupHours({ olderThanHours: 24 })).toBe(24);
    expect(resolveCleanupHours({ olderThanHours: 72 })).toBe(72);
    expect(resolveCleanupHours({ olderThanHours: 168 })).toBe(168);
    // Unsupported thresholds fall back to the default, never pass through.
    expect(resolveCleanupHours({ olderThanHours: 12 as never })).toBe(168);
    expect(resolveCleanupHours({ olderThanHours: 0 as never })).toBe(168);
  });

  it('resolves the interval, defaulting to 60min and enforcing a 5min floor', () => {
    expect(resolveCleanupIntervalMs(undefined)).toBe(60 * minute);
    expect(resolveCleanupIntervalMs({})).toBe(60 * minute);
    expect(resolveCleanupIntervalMs({ intervalMinutes: 30 })).toBe(30 * minute);
    expect(resolveCleanupIntervalMs({ intervalMinutes: 5 })).toBe(5 * minute);
    // Sub-floor / garbage values are raised to the floor or defaulted, never a hot loop.
    expect(resolveCleanupIntervalMs({ intervalMinutes: 1 })).toBe(5 * minute);
    expect(resolveCleanupIntervalMs({ intervalMinutes: 0 })).toBe(5 * minute);
    expect(resolveCleanupIntervalMs({ intervalMinutes: Number.NaN })).toBe(60 * minute);
    expect(resolveCleanupIntervalMs({ intervalMinutes: 90.7 })).toBe(90 * minute);
  });
});

describe('evaluateAutoCleanupDue', () => {
  it('is disabled when the feature is off or config missing', () => {
    expect(evaluateAutoCleanupDue(undefined, undefined, NOW)).toEqual({ decision: 'disabled' });
    expect(evaluateAutoCleanupDue({}, undefined, NOW)).toEqual({ decision: 'disabled' });
    expect(evaluateAutoCleanupDue({ enabled: false }, undefined, NOW)).toEqual({ decision: 'disabled' });
  });

  it('is due on the first tick after enable (no prior run)', () => {
    expect(evaluateAutoCleanupDue({ enabled: true }, undefined, NOW)).toEqual({ decision: 'due', hours: 168 });
    expect(evaluateAutoCleanupDue({ enabled: true, olderThanHours: 24 }, undefined, NOW))
      .toEqual({ decision: 'due', hours: 24 });
  });

  it('waits until the interval elapses since the last run', () => {
    const cfg: SessionCleanupGlobalConfig = { enabled: true, intervalMinutes: 60 };
    // 59 minutes after last run → not yet.
    expect(evaluateAutoCleanupDue(cfg, NOW - 59 * minute, NOW)).toEqual({ decision: 'not-yet' });
    // exactly 60 minutes → due.
    expect(evaluateAutoCleanupDue(cfg, NOW - 60 * minute, NOW)).toEqual({ decision: 'due', hours: 168 });
    // well past → due.
    expect(evaluateAutoCleanupDue(cfg, NOW - 120 * minute, NOW)).toEqual({ decision: 'due', hours: 168 });
  });

  it('applies the 5-minute floor to the interval gate', () => {
    const cfg: SessionCleanupGlobalConfig = { enabled: true, intervalMinutes: 1 };
    // Sub-floor config is treated as 5 minutes: 4 min → not yet, 5 min → due.
    expect(evaluateAutoCleanupDue(cfg, NOW - 4 * minute, NOW)).toEqual({ decision: 'not-yet' });
    expect(evaluateAutoCleanupDue(cfg, NOW - 5 * minute, NOW)).toEqual({ decision: 'due', hours: 168 });
  });
});

describe('runAutoCleanupTick', () => {
  function makeDeps(
    cfg: SessionCleanupGlobalConfig | undefined,
    rows: (IdleCleanupSessionRow & { larkAppId: string })[],
    lastRun: number | undefined,
    opts: { failIds?: Set<string> } = {},
  ) {
    const closed: string[] = [];
    let stored = lastRun;
    const logs: string[] = [];
    const deps: AutoCleanupTickDeps<IdleCleanupSessionRow & { larkAppId: string }> = {
      now: () => NOW,
      readConfig: () => cfg,
      readLastRun: () => stored,
      writeLastRun: (ms) => { stored = ms; },
      getSessions: () => rows,
      closeCandidate: async (r) => {
        if (opts.failIds?.has(r.sessionId)) {
          return { sessionId: r.sessionId, ok: false, error: 'close_failed' } as IdleCleanupCloseResult;
        }
        closed.push(r.sessionId);
        return { sessionId: r.sessionId, ok: true } as IdleCleanupCloseResult;
      },
      log: (m) => logs.push(m),
    };
    return { deps, closed, logs, getStored: () => stored };
  }

  it('returns null and closes nothing when disabled', async () => {
    const { deps, closed } = makeDeps(undefined, [row('a')], undefined);
    const result = await runAutoCleanupTick(deps);
    expect(result).toBeNull();
    expect(closed).toEqual([]);
  });

  it('returns null and closes nothing when the interval has not elapsed', async () => {
    const { deps, closed, getStored } = makeDeps(
      { enabled: true, intervalMinutes: 60 }, [row('a')], NOW - 10 * minute,
    );
    const result = await runAutoCleanupTick(deps);
    expect(result).toBeNull();
    expect(closed).toEqual([]);
    // last-run timestamp untouched when not due.
    expect(getStored()).toBe(NOW - 10 * minute);
  });

  it('closes only genuine idle candidates when due, and stamps the run time', async () => {
    const rows = [
      row('old-idle'),
      row('new-idle', { lastMessageAt: NOW - 1 * hour }),
      row('working', { status: 'working', lastMessageAt: NOW - 300 * hour }),
      row('locked', { locked: true, lastMessageAt: NOW - 300 * hour }),
      row('pending', { pendingRepo: true, lastMessageAt: NOW - 300 * hour }),
    ];
    const { deps, closed, getStored } = makeDeps({ enabled: true, olderThanHours: 24 }, rows, undefined);
    const result = await runAutoCleanupTick(deps);
    expect(closed).toEqual(['old-idle']);
    expect(result).not.toBeNull();
    expect(result!.matched).toBe(1);
    expect(result!.closed).toBe(1);
    expect(result!.failed).toBe(0);
    expect(result!.olderThanHours).toBe(24);
    // run time stamped so the interval gate advances.
    expect(getStored()).toBe(NOW);
  });

  it('stamps the run before awaiting the first close', async () => {
    const { deps, getStored } = makeDeps({ enabled: true, olderThanHours: 24 }, [row('slow')], undefined);
    let resolveClose!: (result: IdleCleanupCloseResult) => void;
    deps.closeCandidate = candidate => new Promise((resolve) => {
      resolveClose = resolve;
      expect(candidate.sessionId).toBe('slow');
    });

    const pending = runAutoCleanupTick(deps);

    // This synchronous assertion pins the ordering contract: moving the stamp
    // below cleanupIdleSessions would leave the old gate visible here.
    expect(getStored()).toBe(NOW);
    resolveClose({ sessionId: 'slow', ok: true });
    await expect(pending).resolves.toMatchObject({ matched: 1, closed: 1 });
  });

  it('reports partial failures without throwing', async () => {
    const rows = [row('a'), row('b'), row('c')];
    const { deps, closed } = makeDeps(
      { enabled: true, olderThanHours: 24 }, rows, undefined, { failIds: new Set(['b']) },
    );
    const result = await runAutoCleanupTick(deps);
    expect(closed.sort()).toEqual(['a', 'c']);
    expect(result!.closed).toBe(2);
    expect(result!.failed).toBe(1);
    expect(result!.ok).toBe(false);
  });

  it('advances the run gate even when zero candidates match (no infinite re-fire)', async () => {
    const rows = [row('working', { status: 'working' })];
    const { deps, closed, getStored } = makeDeps({ enabled: true, olderThanHours: 24 }, rows, undefined);
    const result = await runAutoCleanupTick(deps);
    expect(closed).toEqual([]);
    expect(result!.matched).toBe(0);
    // Even a no-op sweep stamps the time so the next tick waits a full interval.
    expect(getStored()).toBe(NOW);
  });

  it('closes dormant workerless candidates too (union with idle)', async () => {
    const rows = [
      row('old-idle'),
      row('old-dormant', { status: 'dormant' }),
      row('dormant-with-port', { status: 'dormant', webPort: 41235 }),
    ];
    const { deps, closed } = makeDeps({ enabled: true, olderThanHours: 24 }, rows, undefined);
    await runAutoCleanupTick(deps);
    expect(closed.sort()).toEqual(['old-dormant', 'old-idle']);
  });

  it('exposes a sane tick cadence constant', () => {
    expect(AUTO_CLEANUP_TICK_MS).toBe(60_000);
  });
});

describe('auto-cleanup timer lifecycle', () => {
  it('clears both the startup delay and recurring timer when stopped', () => {
    vi.useFakeTimers();
    startAutoCleanup({
      getSessions: () => [],
      closeCandidate: async candidate => ({ sessionId: candidate.sessionId, ok: true }),
    });
    expect(vi.getTimerCount()).toBe(2);

    stopAutoCleanup();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('auto-cleanup single-flight runner', () => {
  it('does not overlap a slow sweep with a later due tick', async () => {
    let now = NOW;
    let stored: number | undefined;
    let closes = 0;
    const resolvers: Array<(result: IdleCleanupCloseResult) => void> = [];
    const deps: AutoCleanupTickDeps<IdleCleanupSessionRow> = {
      now: () => now,
      readConfig: () => ({ enabled: true, olderThanHours: 24, intervalMinutes: 5 }),
      readLastRun: () => stored,
      writeLastRun: value => { stored = value; },
      getSessions: () => [row('slow')],
      closeCandidate: candidate => {
        closes += 1;
        expect(candidate.sessionId).toBe('slow');
        return new Promise(resolve => { resolvers.push(resolve); });
      },
    };
    const runTick = createAutoCleanupTickRunner(deps);

    const first = runTick();
    expect(closes).toBe(1);
    now += 6 * minute;
    await expect(runTick()).resolves.toBeNull();
    expect(closes).toBe(1);

    resolvers.shift()!({ sessionId: 'slow', ok: true });
    await expect(first).resolves.toMatchObject({ matched: 1, closed: 1 });
    const second = runTick();
    expect(closes).toBe(2);
    resolvers.shift()!({ sessionId: 'slow', ok: true });
    await expect(second).resolves.toMatchObject({ matched: 1, closed: 1 });
  });
});
