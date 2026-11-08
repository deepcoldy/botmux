/**
 * Per-session idle auto-compact (core/idle-auto-compact.ts): the 60s sweep with
 * a fake clock, driven through the real worker-pool idle stamp
 * (stampIdleSinceAt) so the screen-edge bookkeeping is the production path.
 *
 * Run: bun run vitest run test/idle-auto-compact.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/idle-auto-compact-unused' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const persisted = vi.hoisted(() => ({ updates: [] as unknown[] }));
vi.mock('../src/services/session-store.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/session-store.js')>(),
  updateSession: (session: { idleAutoCompact?: unknown }) => {
    persisted.updates.push(structuredClone(session.idleAutoCompact));
  },
}));

import {
  IDLE_AUTO_COMPACT_DEFAULT_MINUTES,
  IDLE_AUTO_COMPACT_TURN_PREFIX,
  applyIdleAutoCompactSetting,
  clearIdleAutoCompactStretch,
  noteIdleAutoCompactRefused,
  noteIdleAutoCompactTurnEnded,
  noteIdleAutoCompactTurnStarted,
  parseIdleAutoCompactCommand,
  runIdleAutoCompactSweep,
  supportsIdleAutoCompact,
  type IdleAutoCompactSweepDeps,
} from '../src/core/idle-auto-compact.js';
import { idleAutoCompactCardState, stampIdleSinceAt } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 1, 0, 0);

function makeDs(id: string, opts: { enabled?: boolean; minutes?: number } = {}): DaemonSession {
  const ds = {
    session: { sessionId: `${id}-0000-0000-0000-000000000000`, lastMessageAt: new Date(T0 - MIN).toISOString() },
    lastScreenStatus: 'working',
  } as unknown as DaemonSession;
  if (opts.enabled) applyIdleAutoCompactSetting(ds.session, { enabled: true, minutes: opts.minutes });
  return ds;
}

/** A daemon restart: a fresh DaemonSession whose setting is only what was last saved. */
function restartFrom(ds: DaemonSession): DaemonSession {
  const session = structuredClone(ds.session);
  session.idleAutoCompact = structuredClone(persisted.updates.at(-1) as never);
  return { session } as unknown as DaemonSession;
}

/** One screen-status edge through the production stamp. */
function edge(ds: DaemonSession, status: 'idle' | 'working', at: number): void {
  const prev = ds.lastScreenStatus;
  ds.lastScreenStatus = status;
  stampIdleSinceAt(ds, prev, at);
}

function harness(overrides: Partial<IdleAutoCompactSweepDeps> = {}) {
  const compact = vi.fn((ds: DaemonSession, turnId: string) => {
    // Mirror the daemon passthrough: the compact starts a turn and marks activity.
    noteIdleAutoCompactTurnStarted(ds, turnId);
    ds.session.lastMessageAt = new Date(clock.now).toISOString();
    return true;
  });
  const notify = vi.fn();
  // The sweep's saves land in the same durable log as the screen-edge saves.
  const persist = vi.fn((ds: DaemonSession) => { persisted.updates.push(structuredClone(ds.session.idleAutoCompact)); });
  const clock = { now: T0 };
  const deps: IdleAutoCompactSweepDeps = {
    now: () => clock.now,
    supported: () => true,
    eligible: () => true,
    contextTokens: () => 150_000,
    persist,
    compact,
    notify,
    log: () => {},
    ...overrides,
  };
  const sweepAt = (sessions: DaemonSession[], at: number) => {
    clock.now = at;
    return runIdleAutoCompactSweep(sessions, deps);
  };
  return { compact, notify, persist, sweepAt, clock };
}

beforeEach(() => { persisted.updates = []; });

describe('idle auto-compact sweep', () => {
  it('is off by default: an idle session that never opted in is never compacted', () => {
    const ds = makeDs('aaaaaaaa');
    edge(ds, 'idle', T0);
    const h = harness();
    for (let m = 0; m <= 120; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).not.toHaveBeenCalled();
    expect(persisted.updates).toEqual([]);
  });

  it('fires once N idle minutes have elapsed; the notice waits until the compact actually ran', () => {
    const ds = makeDs('bbbbbbbb', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    expect(h.sweepAt([ds], T0 + (IDLE_AUTO_COMPACT_DEFAULT_MINUTES - 1) * MIN)).toBe(0);
    expect(h.sweepAt([ds], T0 + IDLE_AUTO_COMPACT_DEFAULT_MINUTES * MIN)).toBe(1);
    expect(h.compact.mock.calls[0][1].startsWith(IDLE_AUTO_COMPACT_TURN_PREFIX)).toBe(true);
    expect(h.compact.mock.calls[0][1].startsWith('auto-compact:')).toBe(true);
    expect(h.notify).not.toHaveBeenCalled();
    edge(ds, 'working', T0 + 55 * MIN + 1_000);
    edge(ds, 'idle', T0 + 55 * MIN + 30_000);
    h.sweepAt([ds], T0 + 56 * MIN);
    expect(h.notify).toHaveBeenCalledWith(ds, { kind: 'compacted', idleMinutes: IDLE_AUTO_COMPACT_DEFAULT_MINUTES, tokens: 150_000 });
    h.sweepAt([ds], T0 + 57 * MIN);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('honours a per-session delay', () => {
    const ds = makeDs('cccccccc', { enabled: true, minutes: 10 });
    edge(ds, 'idle', T0);
    const h = harness();
    expect(h.sweepAt([ds], T0 + 9 * MIN)).toBe(0);
    expect(h.sweepAt([ds], T0 + 10 * MIN)).toBe(1);
  });

  it('resets on activity: a new turn restarts the idle clock', () => {
    const ds = makeDs('dddddddd', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 30 * MIN);
    edge(ds, 'working', T0 + 30 * MIN);
    edge(ds, 'idle', T0 + 40 * MIN);
    expect(h.sweepAt([ds], T0 + 55 * MIN)).toBe(0);
    expect(h.sweepAt([ds], T0 + 94 * MIN)).toBe(0);
    expect(h.sweepAt([ds], T0 + 95 * MIN)).toBe(1);
  });

  it('does not fire while a turn is running, however long it runs', () => {
    const ds = makeDs('eeeeeeee', { enabled: true });
    edge(ds, 'idle', T0);
    edge(ds, 'working', T0 + 5 * MIN);
    const h = harness();
    for (let m = 5; m <= 120; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it('does not fire when the fire-time gate says ineligible, and retries inside the window', () => {
    const ds = makeDs('ffffffff', { enabled: true });
    edge(ds, 'idle', T0);
    let eligible = false;
    const h = harness({ eligible: () => eligible });
    expect(h.sweepAt([ds], T0 + 55 * MIN)).toBe(0);
    eligible = true;
    expect(h.sweepAt([ds], T0 + 56 * MIN)).toBe(1);
  });

  it('fires once per idle period: its own busy→idle edge and later ticks do not re-fire', () => {
    const ds = makeDs('11111111', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    expect(h.sweepAt([ds], T0 + 55 * MIN)).toBe(1);
    // The compact itself runs and returns to idle.
    edge(ds, 'working', T0 + 55 * MIN + 1_000);
    edge(ds, 'idle', T0 + 56 * MIN);
    for (let m = 56; m <= 240; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
    // Real activity afterwards opens a new stretch that is eligible again.
    noteIdleAutoCompactTurnStarted(ds, 'om_user_turn');
    edge(ds, 'working', T0 + 241 * MIN);
    edge(ds, 'idle', T0 + 242 * MIN);
    expect(h.sweepAt([ds], T0 + 297 * MIN)).toBe(1);
  });

  it('a user turn that starts while the compact is in flight opens a fresh stretch', () => {
    const ds = makeDs('22222222', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    edge(ds, 'working', T0 + 55 * MIN + 1_000);
    // The user's queued message starts its turn before the compact's idle edge.
    noteIdleAutoCompactTurnStarted(ds, 'om_user_turn');
    edge(ds, 'idle', T0 + 60 * MIN);
    expect(h.sweepAt([ds], T0 + 115 * MIN)).toBe(1);
  });

  it('a worker refusal (no safe composer) is not retried in the same stretch', () => {
    const ds = makeDs('33333333', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    expect(noteIdleAutoCompactRefused(ds, h.compact.mock.calls[0][1])).toBe(true);
    for (let m = 56; m < 60; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
    // The topic hears it was skipped, never that it compacted.
    expect(h.notify.mock.calls.map(c => c[1].kind)).toEqual(['refused']);
    // Activity that starts no botmux turn (typing in the web terminal) must not
    // be mistaken for the refused compact's own busy→idle edge.
    edge(ds, 'working', T0 + 61 * MIN);
    edge(ds, 'idle', T0 + 62 * MIN);
    expect(h.sweepAt([ds], T0 + 117 * MIN)).toBe(1);
  });

  it('an undelivered send releases the claim so the next tick retries', () => {
    const ds = makeDs('44444444', { enabled: true });
    edge(ds, 'idle', T0);
    let accept = false;
    const h = harness({ compact: vi.fn(() => accept) });
    expect(h.sweepAt([ds], T0 + 55 * MIN)).toBe(0);
    expect(ds.session.idleAutoCompact?.inFlight).toBeUndefined();
    expect(h.notify).not.toHaveBeenCalled();
    accept = true;
    expect(h.sweepAt([ds], T0 + 56 * MIN)).toBe(1);
  });

  it('skips (once, with a notice) when the context is below the threshold', () => {
    const ds = makeDs('55555555', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness({ contextTokens: () => 40_000 });
    for (let m = 55; m < 60; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][1]).toMatchObject({ kind: 'skipped_small', tokens: 40_000 });
  });

  it('compacts when the context size is unknown (threshold not applicable)', () => {
    const ds = makeDs('66666666', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness({ contextTokens: () => undefined });
    expect(h.sweepAt([ds], T0 + 55 * MIN)).toBe(1);
    edge(ds, 'working', T0 + 55 * MIN + 1_000);
    edge(ds, 'idle', T0 + 55 * MIN + 30_000);
    h.sweepAt([ds], T0 + 56 * MIN);
    expect(h.notify.mock.calls[0][1]).toEqual({ kind: 'compacted', idleMinutes: 55 });
  });

  it('never compacts once the 1h cache window has passed', () => {
    const ds = makeDs('77777777', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    expect(h.sweepAt([ds], T0 + 60 * MIN)).toBe(0);
    expect(h.sweepAt([ds], T0 + 61 * MIN)).toBe(0);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('per-session isolation: only the opted-in session is compacted', () => {
    const on = makeDs('88888888', { enabled: true });
    const off = makeDs('99999999');
    edge(on, 'idle', T0);
    edge(off, 'idle', T0);
    const h = harness();
    expect(h.sweepAt([on, off], T0 + 55 * MIN)).toBe(1);
    expect(h.compact.mock.calls.map(c => c[0])).toEqual([on]);
  });

  it('turning it off stops a pending compact', () => {
    const ds = makeDs('aaaa0000', { enabled: true });
    edge(ds, 'idle', T0);
    applyIdleAutoCompactSetting(ds.session, { enabled: false });
    const h = harness();
    expect(h.sweepAt([ds], T0 + 55 * MIN)).toBe(0);
  });

  it('a compaction that runs a long time is still recognised as its own idle edge', () => {
    const ds = makeDs('aaaa1111', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    edge(ds, 'working', T0 + 55 * MIN + 1_000);
    edge(ds, 'idle', T0 + 85 * MIN);
    for (let m = 85; m <= 200; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it('off → on inside the same idle stretch does not compact that stretch again', () => {
    const ds = makeDs('aaaa2222', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    edge(ds, 'working', T0 + 55 * MIN + 1_000);
    edge(ds, 'idle', T0 + 56 * MIN);
    applyIdleAutoCompactSetting(ds.session, { enabled: false });
    applyIdleAutoCompactSetting(ds.session, { enabled: true });
    for (let m = 57; m <= 200; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it('waits while a prompt-cache keep-alive is being typed, then fires on the next tick', () => {
    const ds = makeDs('aaaa3333', { enabled: true });
    edge(ds, 'idle', T0);
    ds.promptCacheKeepalive = { pings: 0, idleSinceAt: T0, inFlightSince: T0 + 55 * MIN };
    const h = harness();
    expect(h.sweepAt([ds], T0 + 55 * MIN)).toBe(0);
    // The keep-alive's own busy→idle restores the original stretch start.
    edge(ds, 'working', T0 + 55 * MIN + 1_000);
    edge(ds, 'idle', T0 + 55 * MIN + 20_000);
    expect(ds.idleSinceAt).toBe(T0);
    expect(h.sweepAt([ds], T0 + 56 * MIN)).toBe(1);
  });

  it('refuses unsupported sessions', () => {
    const ds = makeDs('bbbb0000', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness({ supported: () => false });
    expect(h.sweepAt([ds], T0 + 55 * MIN)).toBe(0);
  });
});

describe('idle auto-compact across a daemon restart', () => {
  it('continues the persisted idle stretch instead of restarting the clock at boot', () => {
    const before = makeDs('cccc0000', { enabled: true });
    edge(before, 'idle', T0);
    expect(before.session.idleAutoCompact?.idleSince).toBe(T0);
    // Restart at T0+30: a fresh DaemonSession over the persisted row; the
    // reattached worker reports idle with no previous status.
    const restored = restartFrom(before);
    edge(restored, 'idle', T0 + 30 * MIN);
    const h = harness();
    expect(h.sweepAt([restored], T0 + 55 * MIN)).toBe(1);
  });

  it('a compacted stretch stays handled after restart', () => {
    const ds = makeDs('dddd0000', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    edge(ds, 'working', T0 + 55 * MIN + 1_000);
    edge(ds, 'idle', T0 + 56 * MIN);
    const restored = restartFrom(ds);
    edge(restored, 'idle', T0 + 70 * MIN);
    for (let m = 70; m <= 200; m += 1) h.sweepAt([restored], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it('a restart while the compact is running does not compact again when it finishes', () => {
    const ds = makeDs('dddd1111', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    edge(ds, 'working', T0 + 55 * MIN + 1_000);
    // Restart mid-compact: the in-memory session is gone, the row survives.
    const restored = restartFrom(ds);
    edge(restored, 'working', T0 + 57 * MIN);
    edge(restored, 'idle', T0 + 58 * MIN);
    for (let m = 58; m <= 200; m += 1) h.sweepAt([restored], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it('a message newer than the persisted stretch starts a new one', () => {
    const before = makeDs('eeee0000', { enabled: true });
    edge(before, 'idle', T0);
    const restored = restartFrom(before);
    restored.session.lastMessageAt = new Date(T0 + 20 * MIN).toISOString();
    edge(restored, 'idle', T0 + 30 * MIN);
    const h = harness();
    expect(h.sweepAt([restored], T0 + 55 * MIN)).toBe(0);
    expect(h.sweepAt([restored], T0 + 85 * MIN)).toBe(1);
  });

  it('a marker inherited across a restart folds silently on the FIRST idle edge', () => {
    const before = makeDs('eeee1111', { enabled: true });
    edge(before, 'idle', T0);
    const h = harness();
    h.sweepAt([before], T0 + 55 * MIN); // claim + dispatch, then the daemon dies mid-compact
    edge(before, 'working', T0 + 55 * MIN + 1_000);
    // Restart: the replacement worker's FIRST observed status is idle and this
    // process never dispatched the marker, so no success claim may be posted.
    const restored = restartFrom(before);
    edge(restored, 'idle', T0 + 58 * MIN);
    expect(restored.session.idleAutoCompact).toMatchObject({ handledIdleSince: T0 + 58 * MIN });
    expect(restored.idleAutoCompactPendingNotice).toBeUndefined();
    h.sweepAt([restored], T0 + 59 * MIN);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it('the screen-edge bookkeeping is saved while opted in, never while off', () => {
    const on = makeDs('ffff0000', { enabled: true });
    edge(on, 'idle', T0);
    edge(on, 'working', T0 + MIN);
    expect(persisted.updates).toEqual([
      { enabled: true, idleSince: T0 },
      { enabled: true },
    ]);
    persisted.updates = [];
    const off = makeDs('ffff1111');
    edge(off, 'idle', T0);
    edge(off, 'working', T0 + MIN);
    expect(persisted.updates).toEqual([]);
  });
});

describe('idle auto-compact interrupted turns', () => {
  it.each(['cancelled', 'failed', 'ambiguous'] as const)(
    'a %s terminal before the idle edge queues "interrupted", never "compacted"',
    (terminalStatus) => {
      const ds = makeDs('intr0001', { enabled: true });
      edge(ds, 'idle', T0);
      const h = harness();
      h.sweepAt([ds], T0 + 55 * MIN);
      const turnId = h.compact.mock.calls[0][1];
      edge(ds, 'working', T0 + 55 * MIN + 1_000);
      expect(noteIdleAutoCompactTurnEnded(ds, turnId, terminalStatus)).toBe(true);
      expect(ds.session.idleAutoCompact.inFlight).toBeUndefined();
      expect(ds.idleAutoCompactDispatchedTurnId).toBeUndefined();
      expect(ds.idleAutoCompactPendingNotice).toEqual({ kind: 'interrupted', idleMinutes: 55 });
      // Back to idle: the queued notice is the only one ever posted.
      edge(ds, 'idle', T0 + 56 * MIN);
      h.sweepAt([ds], T0 + 57 * MIN);
      expect(h.notify).toHaveBeenCalledTimes(1);
      expect(h.notify.mock.calls[0][1]).toEqual({ kind: 'interrupted', idleMinutes: 55 });
    },
  );

  it('retracts the queued "compacted" notice when the cancelled terminal lands after the idle edge', () => {
    const ds = makeDs('intr0002', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    const turnId = h.compact.mock.calls[0][1];
    edge(ds, 'working', T0 + 55 * MIN + 1_000);
    edge(ds, 'idle', T0 + 56 * MIN); // finishing edge wins the race, queues success
    expect(ds.idleAutoCompactPendingNotice?.kind).toBe('compacted');
    expect(noteIdleAutoCompactTurnEnded(ds, turnId, 'cancelled')).toBe(true);
    h.sweepAt([ds], T0 + 57 * MIN);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][1]).toEqual({ kind: 'interrupted', idleMinutes: 55 });
  });

  it('a completed terminal leaves the in-flight compact to finish normally', () => {
    const ds = makeDs('intr0003', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    const turnId = h.compact.mock.calls[0][1];
    edge(ds, 'working', T0 + 55 * MIN + 1_000);
    expect(noteIdleAutoCompactTurnEnded(ds, turnId, 'completed')).toBe(false);
    expect(ds.session.idleAutoCompact.inFlight?.turnId).toBe(turnId);
    expect(ds.idleAutoCompactDispatchedTurnId).toBe(turnId);
    edge(ds, 'idle', T0 + 56 * MIN);
    h.sweepAt([ds], T0 + 57 * MIN);
    expect(h.notify.mock.calls[0][1]).toMatchObject({ kind: 'compacted' });
  });

  it('a terminal for a different turn neither clears the marker nor posts anything', () => {
    const ds = makeDs('intr0004', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    const turnId = h.compact.mock.calls[0][1];
    expect(noteIdleAutoCompactTurnEnded(ds, 'om_some_user_turn', 'cancelled')).toBe(false);
    expect(ds.session.idleAutoCompact.inFlight?.turnId).toBe(turnId);
    expect(ds.idleAutoCompactDispatchedTurnId).toBe(turnId);
    expect(ds.idleAutoCompactPendingNotice).toBeUndefined();
  });

  it('a cancelled terminal inherited from a restart posts nothing (no local witness)', () => {
    const before = makeDs('intr0005', { enabled: true });
    edge(before, 'idle', T0);
    const h = harness();
    h.sweepAt([before], T0 + 55 * MIN);
    const turnId = h.compact.mock.calls[0][1];
    edge(before, 'working', T0 + 55 * MIN + 1_000);
    const restored = restartFrom(before); // in-flight marker on the row, no witness in memory
    expect(noteIdleAutoCompactTurnEnded(restored, turnId, 'cancelled')).toBe(true);
    expect(restored.idleAutoCompactPendingNotice).toBeUndefined();
  });
});

describe('idle auto-compact across a worker suspend', () => {
  it('clearIdleAutoCompactStretch drops only the live-stretch mirror and marker', () => {
    const session: { idleAutoCompact?: any } = {};
    expect(clearIdleAutoCompactStretch(session)).toBe(false);
    applyIdleAutoCompactSetting(session, { enabled: true, minutes: 20 });
    expect(clearIdleAutoCompactStretch(session)).toBe(false);
    session.idleAutoCompact.idleSince = T0;
    session.idleAutoCompact.inFlight = { turnId: 'auto-compact:idle:x', since: T0, idleMinutes: 20 };
    expect(clearIdleAutoCompactStretch(session)).toBe(true);
    expect(session.idleAutoCompact).toEqual({ enabled: true, minutes: 20 });
    // Idempotent.
    expect(clearIdleAutoCompactStretch(session)).toBe(false);
  });

  it('a message-less cold resume starts a fresh stretch: no immediate /compact on the cold CLI', () => {
    const ds = makeDs('susp001', { enabled: true, minutes: 55 });
    edge(ds, 'idle', T0);
    // suspendWorker(): live fields and the persisted mirror are all dropped.
    expect(clearIdleAutoCompactStretch(ds.session)).toBe(true);
    ds.idleSinceAt = undefined;
    ds.lastScreenStatus = undefined;
    ds.idleAutoCompactPendingNotice = undefined;
    delete ds.idleAutoCompactDispatchedTurnId;
    // A web-terminal / dashboard visit cold-starts the CLI with no queued
    // message; its first status is idle at T0+56m.
    const h = harness();
    edge(ds, 'idle', T0 + 56 * MIN);
    expect(h.sweepAt([ds], T0 + 56 * MIN)).toBe(0);
    // The timer counts from the fresh edge, not from before the suspend.
    expect(h.sweepAt([ds], T0 + 110 * MIN)).toBe(0);
    expect(h.sweepAt([ds], T0 + 111 * MIN)).toBe(1);
  });
});


describe('idle auto-compact support and command parsing', () => {
  const base = { cliId: 'claude-code', backendType: 'tmux', codexRpcInput: false, adopted: false, headless: false, vcMeetingReceiver: false };
  it('supports Claude Code and Codex-on-tmux only, and only sessions botmux owns', () => {
    expect(supportsIdleAutoCompact(base)).toBe(true);
    expect(supportsIdleAutoCompact({ ...base, backendType: 'pty' })).toBe(true);
    expect(supportsIdleAutoCompact({ ...base, cliId: 'codex' })).toBe(true);
    expect(supportsIdleAutoCompact({ ...base, cliId: 'codex', backendType: 'pty' })).toBe(false);
    expect(supportsIdleAutoCompact({ ...base, cliId: 'codex', codexRpcInput: true })).toBe(false);
    expect(supportsIdleAutoCompact({ ...base, cliId: 'gemini' })).toBe(false);
    expect(supportsIdleAutoCompact({ ...base, cliId: 'codex-app' })).toBe(false);
    expect(supportsIdleAutoCompact({ ...base, adopted: true })).toBe(false);
    expect(supportsIdleAutoCompact({ ...base, headless: true })).toBe(false);
    expect(supportsIdleAutoCompact({ ...base, vcMeetingReceiver: true })).toBe(false);
    expect(supportsIdleAutoCompact({ ...base, backendType: 'remote-runner' })).toBe(false);
  });

  it('parses on / off / minutes / status and rejects out-of-range minutes', () => {
    expect(parseIdleAutoCompactCommand('')).toEqual({ kind: 'status' });
    expect(parseIdleAutoCompactCommand(' ON ')).toEqual({ kind: 'on' });
    expect(parseIdleAutoCompactCommand('off')).toEqual({ kind: 'off' });
    expect(parseIdleAutoCompactCommand('30')).toEqual({ kind: 'on', minutes: 30 });
    expect(parseIdleAutoCompactCommand('30m')).toEqual({ kind: 'on', minutes: 30 });
    expect(parseIdleAutoCompactCommand('0')).toEqual({ kind: 'invalid' });
    expect(parseIdleAutoCompactCommand('60')).toEqual({ kind: 'invalid' });
    expect(parseIdleAutoCompactCommand('soon')).toEqual({ kind: 'invalid' });
  });

  it('re-affirming "on" keeps the live bookkeeping; "off" keeps only the handled stretch', () => {
    const session: { idleAutoCompact?: any } = {};
    applyIdleAutoCompactSetting(session, { enabled: true, minutes: 20 });
    session.idleAutoCompact.handledIdleSince = T0;
    session.idleAutoCompact.idleSince = T0;
    applyIdleAutoCompactSetting(session, { enabled: true });
    expect(session.idleAutoCompact).toEqual({ enabled: true, minutes: 20, idleSince: T0, handledIdleSince: T0 });
    applyIdleAutoCompactSetting(session, { enabled: false });
    expect(session.idleAutoCompact).toEqual({ enabled: false, minutes: 20, handledIdleSince: T0 });
  });
});

describe('live-card toggle state', () => {
  const live = (cliId: string, extra: Record<string, unknown> = {}) => ({
    session: { sessionId: 'card-0000', cliId, ...extra },
    initConfig: { backendType: 'tmux' },
  }) as unknown as DaemonSession;

  it('is present (off by default) for a supported session and reflects the opt-in', () => {
    const ds = live('claude-code');
    expect(idleAutoCompactCardState(ds)).toEqual({ enabled: false, minutes: IDLE_AUTO_COMPACT_DEFAULT_MINUTES });
    applyIdleAutoCompactSetting(ds.session, { enabled: true, minutes: 30 });
    expect(idleAutoCompactCardState(ds)).toEqual({ enabled: true, minutes: 30 });
  });

  it('is absent for unsupported CLIs and adopted sessions, so no toggle is rendered', () => {
    expect(idleAutoCompactCardState(live('gemini'))).toBeUndefined();
    expect(idleAutoCompactCardState(live('claude-code', { adoptedFrom: { cliId: 'claude-code' } }))).toBeUndefined();
  });
});
