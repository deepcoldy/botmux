/**
 * `ensureTerminalWorkerPort` — a dormant session's web terminal must be able to
 * cold-wake, instead of 502-ing forever.
 *
 * The backing pane being GONE is the normal state for most sessions on a box
 * with a small `maxLiveWorkers`: the idle sweeper suspends worker + CLI + pane
 * together. Refusing to wake on 'missing' therefore does not protect anything —
 * it just makes `/s/{id}` permanently unavailable for every session but the
 * live one. `forkWorker` recreates the pane, which is the same thing an
 * incoming message already does.
 *
 * The two things that must NOT change with it:
 *   · 'unknown' still bails — a failed probe is ignorance, not absence.
 *   · adopted sessions still bail on 'missing' — waking one through
 *     `forkWorker` would push wrapped input into a CLI the user never injected.
 *
 * Run:  bun run vitest run --project unit test/terminal-cold-wake.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionProbe } from '../src/adapters/backend/types.js';
import type { DaemonSession } from '../src/core/types.js';

const state = vi.hoisted(() => ({
  probe: 'exists' as SessionProbe,
  /** Not hardcoded to 'tmux': a mock pinned to one value quietly deletes the
   *  branch it is pinning. `undefined` (no persistent backend) is a real
   *  production path out of this function and needs its own cell. */
  backendType: 'tmux' as string | undefined,
  logs: [] as string[],
  forkCalls: [] as unknown[][],
  /** what the forked worker does: bind a port after `portAfterMs`, or never. */
  portAfterMs: 0 as number | null,
  forkResult: true,
}));

// The wake log line is the only field-observable difference between a cold wake
// and a re-attach, and diagnosing this class of failure in production starts by
// grepping for it (its ABSENCE is what proved the old gate never let anything
// through). So it is asserted, not just printed.
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: (m: string) => { state.logs.push(m); },
    warn: (m: string) => { state.logs.push(m); },
    error: (m: string) => { state.logs.push(m); },
    debug: () => {},
  },
}));

vi.mock('../src/core/persistent-backend.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/persistent-backend.js')>(),
  getSessionPersistentBackendType: vi.fn(() => state.backendType),
  persistentBackendTargetForSession: vi.fn(() => ({ backendType: 'tmux', sessionName: 'bmx-test' })),
  probePersistentBackendTarget: vi.fn(() => state.probe),
}));

vi.mock('../src/core/worker-pool.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/worker-pool.js')>(),
  forkWorker: vi.fn((ds: DaemonSession, ...rest: unknown[]) => {
    state.forkCalls.push([ds, ...rest]);
    if (!state.forkResult) return false;
    ds.worker = {} as DaemonSession['worker'];
    if (state.portAfterMs !== null) {
      setTimeout(() => { ds.workerPort = 47_111; }, state.portAfterMs);
    }
    return true;
  }),
}));

const { ensureTerminalWorkerPort } = await import('../src/core/session-manager.js');

function makeDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: { sessionId: 'sess-0001-cold-wake', status: 'active', backendType: 'tmux' },
    worker: undefined,
    workerPort: null,
    ...overrides,
  } as unknown as DaemonSession;
}

beforeEach(() => {
  state.probe = 'exists';
  state.backendType = 'tmux';
  state.logs = [];
  state.forkCalls = [];
  state.portAfterMs = 0;
  state.forkResult = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ensureTerminalWorkerPort — pane probe', () => {
  it('a session with no persistent backend bails, and never reaches the probe', async () => {
    state.backendType = undefined;
    const ds = makeDs();
    expect(await ensureTerminalWorkerPort(ds)).toBeUndefined();
    expect(state.forkCalls.length).toBe(0);
    expect(state.logs.filter(l => l.includes('terminal accessed with no live worker')).length).toBe(0);
  });

  it.each<[SessionProbe, boolean, string | undefined]>([
    ['exists', true, 'waking to re-attach'],
    // The regression this file exists for: before, 'missing' returned undefined
    // and the terminal 502'd forever.
    ['missing', true, 'backing pane is gone, waking cold'],
    ['unknown', false, undefined],
  ])('probe=%s → wakes: %s', async (probe, shouldWake, logMarker) => {
    state.probe = probe;
    const ds = makeDs();
    const port = await ensureTerminalWorkerPort(ds);
    expect(state.forkCalls.length).toBe(shouldWake ? 1 : 0);
    expect(port).toBe(shouldWake ? 47_111 : undefined);
    // Not just "a line was printed": the two wake kinds must stay
    // distinguishable, and 'unknown' must stay silent about waking.
    const wakeLines = state.logs.filter(l => l.includes('terminal accessed with no live worker'));
    expect(wakeLines.length).toBe(shouldWake ? 1 : 0);
    if (logMarker) expect(wakeLines[0]).toContain(logMarker);
  });

  it('an already-live worker is served without forking at all', async () => {
    const ds = makeDs({ workerPort: 5000 });
    expect(await ensureTerminalWorkerPort(ds)).toBe(5000);
    expect(state.forkCalls.length).toBe(0);
  });

  it('a refused fork serves unavailable rather than waiting for a port', async () => {
    state.probe = 'missing';
    state.forkResult = false;
    const ds = makeDs();
    expect(await ensureTerminalWorkerPort(ds)).toBeUndefined();
    expect(state.forkCalls.length).toBe(1);
  });
});

describe('ensureTerminalWorkerPort — adopted sessions never cold-wake', () => {
  // `forkWorker` (not `forkAdoptWorker`) would create a fresh bmx-* pane and
  // push wrapped input into the user's own CLI. Both fields are checked because
  // a restored adopt session only carries the persisted one — same predicate as
  // `idle-worker-sweeper.ts`.
  const adopted = { target: 'user-pane' } as unknown as DaemonSession['adoptedFrom'];

  it.each<[string, Partial<DaemonSession>]>([
    ['ds.adoptedFrom', { adoptedFrom: adopted }],
    ['ds.session.adoptedFrom', {
      session: {
        sessionId: 'sess-0002-adopt', status: 'active', backendType: 'tmux', adoptedFrom: adopted,
      } as unknown as DaemonSession['session'],
    }],
  ])('probe=missing + %s → bails, no fork', async (_label, overrides) => {
    state.probe = 'missing';
    const ds = makeDs(overrides);
    expect(await ensureTerminalWorkerPort(ds)).toBeUndefined();
    expect(state.forkCalls.length).toBe(0);
  });

  it('probe=exists + adopted still re-attaches (this change must not narrow that)', async () => {
    state.probe = 'exists';
    const ds = makeDs({ adoptedFrom: adopted });
    expect(await ensureTerminalWorkerPort(ds)).toBe(47_111);
    expect(state.forkCalls.length).toBe(1);
  });
});

describe('ensureTerminalWorkerPort — the cold path gets its own budget', () => {
  // Re-attach is a reconnect (~1-2s). A cold wake has to create the pane AND
  // boot the CLI first, so the same 10s bound would time out on exactly the
  // sessions this change is meant to serve. 20s is picked to sit between the
  // two bounds: the re-attach budget must have expired, the cold one must not.
  const BETWEEN = 20_000;

  it.each<[SessionProbe, number | undefined]>([
    ['exists', undefined],
    ['missing', 47_111],
  ])('probe=%s, port arrives at 20s → %s', async (probe, expected) => {
    vi.useFakeTimers();
    state.probe = probe;
    state.portAfterMs = BETWEEN;
    const ds = makeDs();
    const pending = ensureTerminalWorkerPort(ds);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await pending).toBe(expected);
  });

  // The budget comes from what ACTUALLY happened (`forkedCold`), not from what
  // the probe said (`coldWake`). The two disagree in exactly one state, and it
  // is a real window rather than a contrived one: the message path assigns
  // `ds.worker` synchronously when it forks, and the worker child creates the
  // pane only afterwards — a terminal opened in between sees a live worker and
  // a missing pane. Nothing here cold-starts: we are waiting for a worker that
  // is already booting, which is the re-attach case.
  //
  // Without this cell the distinction has no guard at all. Both reviewers
  // independently changed `forkedCold` back to `coldWake` and got 11/11 green,
  // i.e. the trap the PR description names ("that would hand the 40s budget to
  // a session that never cold-started") was untested. Under that mutant this
  // case returns 47_111 instead of undefined.
  it('worker 已在（非本函数 fork）+ probe=missing → 仍走 re-attach 预算', async () => {
    vi.useFakeTimers();
    state.probe = 'missing';
    // The port is scheduled by the test, not by the forkWorker mock: the whole
    // point is that this call must NOT fork.
    state.portAfterMs = null;
    const ds = makeDs({ worker: {} as DaemonSession['worker'] });
    setTimeout(() => { ds.workerPort = 47_111; }, BETWEEN);

    const pending = ensureTerminalWorkerPort(ds);
    await vi.advanceTimersByTimeAsync(45_000);

    expect(await pending).toBeUndefined();
    // Load-bearing: if this ever forks, `forkedCold` would legitimately be true
    // and the case would be asserting something else entirely.
    expect(state.forkCalls.length).toBe(0);
  });
});
