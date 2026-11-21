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
  isLocalCliCommand,
  noteIdleAutoCompactDirectInput,
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
  // Starts mid-turn: a botmux turn is running (seen busy), so its idle edge is warm.
  noteIdleAutoCompactTurnStarted(ds, `om_${id}_first`, T0 - 2 * MIN);
  ds.idleAutoCompactArm!.busy = true;
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
    expect(noteIdleAutoCompactTurnEnded(ds, h.compact.mock.calls[0][1], 'completed')).toBe(true);
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
    noteIdleAutoCompactTurnStarted(ds, 'om_second', T0 + 30 * MIN);
    edge(ds, 'working', T0 + 30 * MIN);
    edge(ds, 'idle', T0 + 40 * MIN);
    expect(h.sweepAt([ds], T0 + 55 * MIN)).toBe(0);
    expect(h.sweepAt([ds], T0 + 94 * MIN)).toBe(0);
    expect(h.sweepAt([ds], T0 + 95 * MIN)).toBe(1);
  });

  it('a busy flicker that is not a botmux turn does not restart the clock', () => {
    // E.g. a CLI restarting inside the same worker shows working before idle.
    const ds = makeDs('dddd9999', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    edge(ds, 'working', T0 + 20 * MIN);
    edge(ds, 'idle', T0 + 21 * MIN);
    expect(h.sweepAt([ds], T0 + 55 * MIN)).toBe(1);
  });

  it('a stretch that expired days ago stays expired through a CLI restart showing working first', () => {
    const ds = makeDs('dddd8888', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 61 * MIN); // past the cache window: skipped
    // Two days later the CLI is restarted in place (crash auto-restart,
    // /restart, model change); --resume boots with a working spinner first.
    const r = T0 + 2 * 24 * 60 * MIN;
    edge(ds, 'working', r + 15_000);
    edge(ds, 'idle', r + 27_000);
    for (let m = 0; m <= 120; m += 1) h.sweepAt([ds], r + m * MIN);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
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
    noteIdleAutoCompactTurnStarted(ds, 'om_user_turn', T0 + 241 * MIN);
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

  it('a draft in the input box is reported at once and not retried in the same stretch', () => {
    const ds = makeDs('33333333', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    expect(noteIdleAutoCompactRefused(ds, h.compact.mock.calls[0][1], 'composer_not_empty'))
      .toEqual({ reason: 'draft', attempt: 1, retry: false });
    for (let m = 56; m < 60; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
    // The topic hears what stopped it, never that it compacted.
    expect(h.notify.mock.calls.map(c => c[1])).toEqual([{ kind: 'refused', idleMinutes: 55, reason: 'draft', attempts: 1 }]);
    // Activity that starts no botmux turn (typing in the web terminal) is not
    // proof of a warm cache: the handled stretch stays current.
    edge(ds, 'working', T0 + 61 * MIN);
    edge(ds, 'idle', T0 + 62 * MIN);
    expect(h.sweepAt([ds], T0 + 117 * MIN)).toBe(0);
    // The next botmux turn opens a fresh stretch.
    noteIdleAutoCompactTurnStarted(ds, 'om_after_refusal', T0 + 120 * MIN);
    edge(ds, 'working', T0 + 120 * MIN);
    edge(ds, 'idle', T0 + 121 * MIN);
    expect(h.sweepAt([ds], T0 + 176 * MIN)).toBe(1);
  });

  it('a dialog waiting for an answer is reported at once as well', () => {
    const ds = makeDs('33333334', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    expect(noteIdleAutoCompactRefused(ds, h.compact.mock.calls[0][1], 'action_prompt_open')?.retry).toBe(false);
    for (let m = 56; m < 60; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls.map(c => c[1])).toEqual([{ kind: 'refused', idleMinutes: 55, reason: 'choice', attempts: 1 }]);
  });

  it('an input box that was not recognised is tried again inside the window, then reported with why', () => {
    const ds = makeDs('33333335', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    const refuseLast = () => {
      const outcome = noteIdleAutoCompactRefused(ds, h.compact.mock.calls.at(-1)![1], 'prompt_not_framed');
      h.persist(ds); // worker-pool saves the row after every refusal
      return outcome;
    };
    expect(h.sweepAt([ds], T0 + 55 * MIN)).toBe(1);
    expect(refuseLast()).toEqual({ reason: 'unconfirmed', attempt: 1, retry: true });
    expect(h.sweepAt([ds], T0 + 56 * MIN)).toBe(1);
    expect(refuseLast()).toEqual({ reason: 'unconfirmed', attempt: 2, retry: true });
    expect(h.sweepAt([ds], T0 + 57 * MIN)).toBe(1);
    expect(refuseLast()).toEqual({ reason: 'unconfirmed', attempt: 3, retry: false });
    for (let m = 58; m <= 120; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(3);
    // One notice, after the last try, with the real reason.
    expect(h.notify.mock.calls.map(c => c[1])).toEqual([{ kind: 'refused', idleMinutes: 57, reason: 'unconfirmed', attempts: 3 }]);
  });

  it('a retry that the worker runs is announced as compacted, with no refusal notice', () => {
    const ds = makeDs('33333336', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    noteIdleAutoCompactRefused(ds, h.compact.mock.calls[0][1], 'prompt_not_ready');
    expect(h.sweepAt([ds], T0 + 56 * MIN)).toBe(1);
    // This time the compact runs and returns to idle; success waits for the
    // completed terminal even though the idle edge arrived first.
    edge(ds, 'working', T0 + 56 * MIN + 1_000);
    edge(ds, 'idle', T0 + 57 * MIN);
    expect(noteIdleAutoCompactTurnEnded(ds, h.compact.mock.calls.at(-1)![1], 'completed')).toBe(true);
    for (let m = 57; m <= 120; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(2);
    expect(h.notify.mock.calls.map(c => c[1].kind)).toEqual(['compacted']);
    expect(ds.session.idleAutoCompact?.retry).toBeUndefined();
  });

  it('the window closing before the next try still tells the topic why nothing ran', () => {
    const ds = makeDs('33333337', { enabled: true, minutes: 59 });
    edge(ds, 'idle', T0);
    const h = harness();
    expect(h.sweepAt([ds], T0 + 59 * MIN)).toBe(1);
    expect(noteIdleAutoCompactRefused(ds, h.compact.mock.calls[0][1], 'no_screen_evidence')?.retry).toBe(true);
    for (let m = 60; m <= 120; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls.map(c => c[1])).toEqual([{ kind: 'refused', idleMinutes: 60, reason: 'no_screen', attempts: 1 }]);
  });

  it('an older worker that gives no reason is retried and reported as unknown', () => {
    const ds = makeDs('33333338', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    for (let m = 55; m <= 57; m += 1) {
      h.sweepAt([ds], T0 + m * MIN);
      noteIdleAutoCompactRefused(ds, h.compact.mock.calls.at(-1)![1]);
    }
    h.sweepAt([ds], T0 + 58 * MIN);
    expect(h.compact).toHaveBeenCalledTimes(3);
    expect(h.notify.mock.calls.map(c => c[1])).toEqual([{ kind: 'refused', idleMinutes: 57, reason: 'unknown', attempts: 3 }]);
  });

  it('a botmux turn between a refused try and the next ends that stretch: no retry, no stale notice', () => {
    const ds = makeDs('3333333a', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    const stretch = ds.session.idleAutoCompact?.inFlight?.stretch;
    noteIdleAutoCompactRefused(ds, h.compact.mock.calls[0][1], 'prompt_not_framed');
    expect(noteIdleAutoCompactTurnStarted(ds, 'om_user_meanwhile', T0 + 55 * MIN + 20_000)).toBe(true);
    expect(ds.session.idleAutoCompact?.retry).toBeUndefined();
    expect(ds.session.idleAutoCompact?.handledIdleSince).toBe(stretch);
    edge(ds, 'working', T0 + 55 * MIN + 20_000);
    edge(ds, 'idle', T0 + 56 * MIN);
    expect(ds.session.idleAutoCompact?.retry).toBeUndefined();
    for (let m = 56; m < 111; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
    // The new stretch compacts on its own schedule, as a first attempt.
    expect(h.sweepAt([ds], T0 + 111 * MIN)).toBe(1);
    expect(ds.session.idleAutoCompact?.inFlight?.attempt).toBe(1);
  });

  it('someone using the session between tries ends that stretch: nothing is compacted under them', () => {
    const ds = makeDs('3333333b', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    const stretch = ds.session.idleAutoCompact?.inFlight?.stretch;
    noteIdleAutoCompactRefused(ds, h.compact.mock.calls[0][1], 'prompt_not_framed');
    // A turn typed straight into the web terminal: no botmux turn, just busy → idle.
    edge(ds, 'working', T0 + 55 * MIN + 20_000);
    edge(ds, 'idle', T0 + 56 * MIN + 40_000);
    for (let m = 57; m <= 120; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(ds.session.idleAutoCompact?.retry).toBeUndefined();
    expect(ds.session.idleAutoCompact?.handledIdleSince).toBe(stretch);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('a busy edge before the refusal cancels the stretch instead of creating a retry', () => {
    const ds = makeDs('3333333e', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    const turnId = h.compact.mock.calls[0][1];
    const stretch = ds.session.idleAutoCompact?.inFlight?.stretch;
    // A direct-terminal turn is already busy when the worker's refusal arrives.
    edge(ds, 'working', T0 + 55 * MIN + 10_000);
    expect(ds.session.idleAutoCompact?.inFlight?.busyBeforeSettled).toBe(true);
    expect(noteIdleAutoCompactRefused(ds, turnId, 'prompt_not_ready'))
      .toEqual({ reason: 'busy', attempt: 1, retry: false });
    h.persist(ds);
    expect(ds.session.idleAutoCompact?.handledIdleSince).toBe(stretch);
    expect(ds.session.idleAutoCompact?.retry).toBeUndefined();
    expect(ds.idleAutoCompactPendingNotice).toBeUndefined();
    edge(ds, 'idle', T0 + 55 * MIN + 40_000);
    for (let m = 56; m <= 120; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it.each(['terminal-first', 'sweep-first'] as const)(
    'idle before refusal never announces success (%s)',
    (order) => {
      const ds = makeDs(`3333334${order === 'terminal-first' ? '1' : '2'}`, { enabled: true });
      edge(ds, 'idle', T0);
      const h = harness();
      h.sweepAt([ds], T0 + 55 * MIN);
      const turnId = h.compact.mock.calls[0][1];
      const stretch = ds.session.idleAutoCompact?.inFlight?.stretch;
      edge(ds, 'working', T0 + 55 * MIN + 10_000);
      edge(ds, 'idle', T0 + 55 * MIN + 40_000);
      // The user's busy → idle is not our compact's completion. Neither a
      // pending success nor a sweep may publish it before the terminal arrives.
      expect(ds.session.idleAutoCompact?.inFlight?.turnId).toBe(turnId);
      expect(ds.idleAutoCompactPendingNotice).toBeUndefined();
      if (order === 'sweep-first') {
        h.sweepAt([ds], T0 + 56 * MIN);
        expect(h.notify).not.toHaveBeenCalled();
      }
      expect(noteIdleAutoCompactRefused(ds, turnId, 'prompt_not_ready')?.retry).toBe(false);
      expect(noteIdleAutoCompactTurnEnded(ds, turnId, 'failed')).toBe(false);
      h.persist(ds);
      expect(ds.session.idleAutoCompact?.handledIdleSince).toBe(stretch);
      expect(ds.session.idleAutoCompact?.retry).toBeUndefined();
      expect(ds.idleAutoCompactPendingNotice).toBeUndefined();
      for (let m = 56; m <= 120; m += 1) h.sweepAt([ds], T0 + m * MIN);
      expect(h.compact).toHaveBeenCalledTimes(1);
      expect(h.notify).not.toHaveBeenCalled();
    },
  );

  it('the pre-refusal busy marker survives a restart and cancels on the late refusal', () => {
    const ds = makeDs('3333333f', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    const turnId = h.compact.mock.calls[0][1];
    edge(ds, 'working', T0 + 55 * MIN + 10_000);
    const restored = restartFrom(ds);
    expect(restored.session.idleAutoCompact?.inFlight?.busyBeforeSettled).toBe(true);
    expect(noteIdleAutoCompactRefused(restored, turnId, 'prompt_not_ready')?.retry).toBe(false);
    h.persist(restored);
    expect(restored.session.idleAutoCompact?.retry).toBeUndefined();
    expect(restored.idleAutoCompactPendingNotice).toBeUndefined();
    edge(restored, 'idle', T0 + 55 * MIN + 40_000);
    for (let m = 56; m <= 120; m += 1) h.sweepAt([restored], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("a keep-alive's busy edge before the refusal is not user activity", () => {
    const ds = makeDs('33333340', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    ds.promptCacheKeepalive = { pings: 0, idleSinceAt: T0, inFlightSince: T0 + 55 * MIN + 10_000 };
    edge(ds, 'working', T0 + 55 * MIN + 11_000);
    expect(ds.session.idleAutoCompact?.inFlight?.busyBeforeSettled).toBeUndefined();
    expect(noteIdleAutoCompactRefused(ds, h.compact.mock.calls[0][1], 'prompt_not_ready')?.retry).toBe(true);
  });

  it("a keep-alive's own busy edge does not end a pending retry", () => {
    const ds = makeDs('3333333c', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    noteIdleAutoCompactRefused(ds, h.compact.mock.calls[0][1], 'prompt_not_framed');
    ds.promptCacheKeepalive = { pings: 0, idleSinceAt: T0, inFlightSince: T0 + 55 * MIN + 10_000 };
    edge(ds, 'working', T0 + 55 * MIN + 11_000);
    expect(ds.session.idleAutoCompact?.retry?.attempts).toBe(1);
    // The keep-alive finishes and restores the idle start (prompt-cache-keepalive.ts).
    ds.promptCacheKeepalive = { pings: 1, idleSinceAt: T0 };
    edge(ds, 'idle', T0 + 55 * MIN + 30_000);
    expect(h.sweepAt([ds], T0 + 56 * MIN)).toBe(1);
    expect(ds.session.idleAutoCompact?.inFlight?.attempt).toBe(2);
  });

  it("a local command's own busy repaint keeps the retry through its idle edge", () => {
    const ds = makeDs('33333343', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    noteIdleAutoCompactRefused(ds, h.compact.mock.calls[0][1], 'prompt_not_framed');
    const localArm = ds.idleAutoCompactArm;
    noteIdleAutoCompactTurnStarted(ds, 'om_cost', T0 + 55 * MIN + 20_000, { preserveRetry: true });
    ds.idleAutoCompactArm = localArm;
    edge(ds, 'working', T0 + 55 * MIN + 21_000);
    // A completed terminal can precede the local command's own busy repaint.
    noteIdleAutoCompactTurnEnded(ds, 'om_cost', 'completed');
    expect(ds.session.idleAutoCompact?.retry?.attempts).toBe(1);
    edge(ds, 'idle', T0 + 55 * MIN + 40_000);
    expect(h.sweepAt([ds], T0 + 56 * MIN)).toBe(1);
    expect(ds.session.idleAutoCompact?.inFlight?.attempt).toBe(2);
  });

  it('a direct Web submit during a local command cancels instead of being hidden by its exemption', () => {
    const ds = makeDs('33333345', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    noteIdleAutoCompactRefused(ds, h.compact.mock.calls[0][1], 'prompt_not_framed');
    const stretch = ds.session.idleAutoCompact?.retry?.stretch;
    noteIdleAutoCompactTurnStarted(ds, 'om_cost', T0 + 55 * MIN + 20_000, { preserveRetry: true });
    expect(noteIdleAutoCompactDirectInput(ds)).toBe(true);
    expect(ds.session.idleAutoCompact?.retry).toBeUndefined();
    expect(ds.session.idleAutoCompact?.handledIdleSince).toBe(stretch);
    expect(ds.idleAutoCompactLocalTurn).toBeUndefined();
    edge(ds, 'working', T0 + 55 * MIN + 25_000);
    edge(ds, 'idle', T0 + 55 * MIN + 40_000);
    expect(h.sweepAt([ds], T0 + 56 * MIN)).toBe(0);
  });

  it('a direct Web submit marks an unsettled compact before its refusal', () => {
    const ds = makeDs('33333346', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    const turnId = h.compact.mock.calls[0][1];
    expect(noteIdleAutoCompactDirectInput(ds)).toBe(true);
    expect(ds.session.idleAutoCompact?.inFlight?.busyBeforeSettled).toBe(true);
    expect(noteIdleAutoCompactRefused(ds, turnId, 'prompt_not_ready')?.retry).toBe(false);
  });

  it('a real busy edge after the already-idle local command still cancels retry', () => {
    const ds = makeDs('33333344', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    noteIdleAutoCompactRefused(ds, h.compact.mock.calls[0][1], 'prompt_not_framed');
    const localArm = ds.idleAutoCompactArm;
    noteIdleAutoCompactTurnStarted(ds, 'om_cost', T0 + 55 * MIN + 20_000, { preserveRetry: true });
    ds.idleAutoCompactArm = localArm;
    noteIdleAutoCompactTurnEnded(ds, 'om_cost', 'completed');
    edge(ds, 'working', T0 + 55 * MIN + 30_000);
    expect(ds.session.idleAutoCompact?.retry).toBeUndefined();
    edge(ds, 'idle', T0 + 55 * MIN + 40_000);
    expect(h.sweepAt([ds], T0 + 56 * MIN)).toBe(0);
  });

  it('a local CLI command or a toggle between tries does not reset the count', () => {
    const ds = makeDs('3333333d', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    noteIdleAutoCompactRefused(ds, h.compact.mock.calls.at(-1)![1], 'prompt_not_framed');
    // `/cost` from the topic: the daemon preserves both its arm and retry.
    const arm = ds.idleAutoCompactArm;
    expect(noteIdleAutoCompactTurnStarted(ds, 'om_cost', T0 + 55 * MIN + 30_000, { preserveRetry: true })).toBe(false);
    ds.idleAutoCompactArm = arm;
    h.sweepAt([ds], T0 + 56 * MIN);
    expect(ds.session.idleAutoCompact?.inFlight?.attempt).toBe(2);
    noteIdleAutoCompactRefused(ds, h.compact.mock.calls.at(-1)![1], 'prompt_not_framed');
    // Turned off and on again from the card.
    applyIdleAutoCompactSetting(ds.session, { enabled: false });
    applyIdleAutoCompactSetting(ds.session, { enabled: true });
    h.sweepAt([ds], T0 + 57 * MIN);
    expect(noteIdleAutoCompactRefused(ds, h.compact.mock.calls.at(-1)![1], 'prompt_not_framed'))
      .toEqual({ reason: 'unconfirmed', attempt: 3, retry: false });
    for (let m = 58; m <= 120; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(3);
    expect(h.notify.mock.calls.map(c => c[1].attempts)).toEqual([3]);
  });

  it('a claim that cannot be saved is not sent, and the next tick tries again', () => {
    const ds = makeDs('3333333e', { enabled: true });
    edge(ds, 'idle', T0);
    let failSave = true;
    const h = harness({ persist: vi.fn(() => { if (failSave) throw new Error('database is locked'); }) });
    expect(h.sweepAt([ds], T0 + 55 * MIN)).toBe(0);
    expect(h.compact).not.toHaveBeenCalled();
    expect(ds.session.idleAutoCompact?.inFlight).toBeUndefined();
    failSave = false;
    expect(h.sweepAt([ds], T0 + 56 * MIN)).toBe(1);
  });

  it('a refusal for a turn that is not our in-flight compact changes nothing', () => {
    const ds = makeDs('33333339', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    expect(noteIdleAutoCompactRefused(ds, 'auto-compact:threshold', 'prompt_not_framed')).toBeUndefined();
    expect(ds.session.idleAutoCompact?.inFlight?.turnId).toBe(h.compact.mock.calls[0][1]);
    expect(ds.session.idleAutoCompact?.retry).toBeUndefined();
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
    expect(noteIdleAutoCompactTurnEnded(ds, h.compact.mock.calls[0][1], 'completed')).toBe(true);
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

  it('turned on mid-stretch: the sweep mirrors the stretch so a restart continues it', () => {
    const before = makeDs('cccc1111');
    edge(before, 'idle', T0);
    applyIdleAutoCompactSetting(before.session, { enabled: true });
    const h = harness();
    h.sweepAt([before], T0 + 5 * MIN);
    expect(before.session.idleAutoCompact?.idleSince).toBe(T0);
    const restored = restartFrom(before);
    edge(restored, 'idle', T0 + 30 * MIN);
    expect(h.sweepAt([restored], T0 + 55 * MIN)).toBe(1);
    expect(h.compact.mock.calls[0][0]).toBe(restored);
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

  it('a restart between a refused try and the next keeps counting the same stretch', () => {
    const ds = makeDs('dddd2222', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    for (let m = 55; m <= 56; m += 1) {
      h.sweepAt([ds], T0 + m * MIN);
      noteIdleAutoCompactRefused(ds, h.compact.mock.calls.at(-1)![1], 'prompt_not_framed');
      h.persist(ds);
    }
    const restored = restartFrom(ds);
    edge(restored, 'idle', T0 + 56 * MIN + 30_000);
    expect(h.sweepAt([restored], T0 + 57 * MIN)).toBe(1);
    expect(noteIdleAutoCompactRefused(restored, h.compact.mock.calls.at(-1)![1], 'prompt_not_framed'))
      .toEqual({ reason: 'unconfirmed', attempt: 3, retry: false });
    for (let m = 58; m <= 120; m += 1) h.sweepAt([restored], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(3);
    expect(h.notify.mock.calls.map(c => c[1].kind)).toEqual(['refused']);
  });

  it('an inherited claim without a local dispatch witness never starts a new retry', () => {
    const ds = makeDs('dddd2224', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    const turnId = h.compact.mock.calls[0][1];
    // Even without a durable busy marker, a restart must not turn a late
    // refusal into fresh activity: the original dispatch cannot be re-witnessed.
    const restored = restartFrom(ds);
    expect(noteIdleAutoCompactRefused(restored, turnId, 'prompt_not_ready')?.retry).toBe(false);
    h.persist(restored);
    expect(restored.session.idleAutoCompact?.retry).toBeUndefined();
    expect(restored.idleAutoCompactPendingNotice).toBeUndefined();
    edge(restored, 'idle', T0 + 56 * MIN);
    for (let m = 57; m <= 120; m += 1) h.sweepAt([restored], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it('a real turn persists retry cancellation before a restart can miss its busy edge', () => {
    const ds = makeDs('dddd2223', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    noteIdleAutoCompactRefused(ds, h.compact.mock.calls[0][1], 'prompt_not_framed');
    h.persist(ds);
    const stretch = ds.session.idleAutoCompact?.retry?.stretch;
    // The worker accepted a real turn. beginNewTurn persists this invalidation
    // immediately; its busy → idle then happens entirely while the daemon is down.
    expect(noteIdleAutoCompactTurnStarted(ds, 'om_user_during_outage', T0 + 55 * MIN + 20_000)).toBe(true);
    h.persist(ds);
    expect(ds.session.idleAutoCompact?.retry).toBeUndefined();
    expect(ds.session.idleAutoCompact?.handledIdleSince).toBe(stretch);
    const restored = restartFrom(ds);
    edge(restored, 'idle', T0 + 56 * MIN + 40_000);
    for (let m = 57; m <= 120; m += 1) h.sweepAt([restored], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
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

  it('a daemon restart mid-turn keeps the turn: its idle edge after reattach is warm', () => {
    const before = makeDs('eeee0000', { enabled: true });
    edge(before, 'idle', T0);
    noteIdleAutoCompactTurnStarted(before, 'om_mid_restart', T0 + 10 * MIN);
    edge(before, 'working', T0 + 10 * MIN);
    expect(before.session.idleAutoCompact?.armed).toEqual({ at: T0 + 10 * MIN, busy: true });
    // The daemon restarts; the turn ends while it is down.
    const restored = restartFrom(before);
    edge(restored, 'idle', T0 + 12 * MIN);
    const h = harness();
    // Dated from the turn start: its request was no earlier than that.
    expect(h.sweepAt([restored], T0 + 64 * MIN)).toBe(0);
    expect(h.sweepAt([restored], T0 + 65 * MIN)).toBe(1);
  });

  it('a daemon down for days mid-turn: the reattach idle edge is not a warm stretch', () => {
    const before = makeDs('eeee0001', { enabled: true });
    edge(before, 'idle', T0);
    noteIdleAutoCompactTurnStarted(before, 'om_before_outage', T0 + 10 * MIN);
    edge(before, 'working', T0 + 10 * MIN);
    const back = T0 + 2 * 24 * 60 * MIN;
    const restored = restartFrom(before);
    edge(restored, 'idle', back);
    const h = harness();
    for (let m = 0; m <= 120; m += 1) h.sweepAt([restored], back + m * MIN);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('a turn that ends in a usage limit: leaving limited hours later is not a warm stretch', () => {
    const ds = makeDs('eeee0002', { enabled: true });
    edge(ds, 'idle', T0);
    noteIdleAutoCompactTurnStarted(ds, 'om_limited', T0 + 10 * MIN);
    edge(ds, 'working', T0 + 10 * MIN);
    const prev = ds.lastScreenStatus;
    ds.lastScreenStatus = 'limited';
    stampIdleSinceAt(ds, prev, T0 + 11 * MIN);
    edge(ds, 'idle', T0 + 5 * 60 * MIN);
    const h = harness();
    for (let m = 0; m <= 120; m += 1) h.sweepAt([ds], T0 + 5 * 60 * MIN + m * MIN);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it('a turn that never went busy (rejected) does not warm a much later busy flicker', () => {
    const ds = makeDs('eeee0003', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 61 * MIN); // expired
    noteIdleAutoCompactTurnStarted(ds, 'om_rejected', T0 + 70 * MIN);
    const later = T0 + 2 * 24 * 60 * MIN;
    edge(ds, 'working', later); // CLI crash-restart spinner two days later
    edge(ds, 'idle', later + 20_000);
    for (let m = 0; m <= 120; m += 1) h.sweepAt([ds], later + m * MIN);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it('an idle edge before the turn goes busy keeps the arm for the real busy period', () => {
    const ds = makeDs('eeee0004', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 61 * MIN); // expired
    noteIdleAutoCompactTurnStarted(ds, 'om_slow_start', T0 + 100 * MIN);
    // A stray idle report before the turn's input reaches the CLI.
    edge(ds, 'working', T0 + 100 * MIN + 1_000);
    ds.idleAutoCompactArm!.busy = false; // that flicker preceded the turn's busy
    edge(ds, 'idle', T0 + 100 * MIN + 2_000);
    expect(ds.idleAutoCompactArm).toBeDefined();
    // The turn's real busy period, then its idle edge: warm from there.
    edge(ds, 'working', T0 + 101 * MIN);
    edge(ds, 'idle', T0 + 170 * MIN);
    expect(h.sweepAt([ds], T0 + 224 * MIN)).toBe(0);
    expect(h.sweepAt([ds], T0 + 225 * MIN)).toBe(1);
  });

  it('re-affirming "on" mid-turn keeps the persisted arm', () => {
    const before = makeDs('eeee0005', { enabled: true });
    edge(before, 'idle', T0);
    noteIdleAutoCompactTurnStarted(before, 'om_reaffirm', T0 + 10 * MIN);
    edge(before, 'working', T0 + 10 * MIN);
    applyIdleAutoCompactSetting(before.session, { enabled: true, minutes: 30 });
    persisted.updates.push(structuredClone(before.session.idleAutoCompact));
    expect(before.session.idleAutoCompact?.armed).toEqual({ at: T0 + 10 * MIN, busy: true });
    const restored = restartFrom(before);
    edge(restored, 'idle', T0 + 12 * MIN);
    const h = harness();
    expect(h.sweepAt([restored], T0 + 40 * MIN)).toBe(1);
  });

  it('a row with no persisted stretch: idle for days, reattach at restart is not timed as fresh idle', () => {
    // Opted in on a build that never mirrored the stretch (or the mirror was
    // lost): the row says enabled and nothing else.
    const before = makeDs('eeee2222', { enabled: true });
    edge(before, 'idle', T0);
    before.session.idleAutoCompact = { enabled: true };
    persisted.updates.push(structuredClone(before.session.idleAutoCompact));
    // Two days later the daemon restarts and reattaches the live tmux CLI.
    const reattachAt = T0 + 2 * 24 * 60 * MIN;
    const restored = restartFrom(before);
    edge(restored, 'idle', reattachAt);
    const h = harness();
    for (let m = 0; m <= 120; m += 1) h.sweepAt([restored], reattachAt + m * MIN);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('a marker inherited across a restart folds silently on the FIRST idle edge', () => {
    const before = makeDs('eeee1111', { enabled: true });
    edge(before, 'idle', T0);
    const h = harness();
    h.sweepAt([before], T0 + 55 * MIN); // claim + dispatch, then the daemon dies mid-compact
    const turnId = h.compact.mock.calls[0][1];
    edge(before, 'working', T0 + 55 * MIN + 1_000);
    // Restart: the replacement worker's FIRST observed status is idle and this
    // process never dispatched the marker, so no success claim may be posted.
    const restored = restartFrom(before);
    edge(restored, 'idle', T0 + 58 * MIN);
    expect(noteIdleAutoCompactTurnEnded(restored, turnId, 'completed')).toBe(true);
    expect(restored.session.idleAutoCompact).toMatchObject({ handledIdleSince: T0 + 58 * MIN });
    expect(restored.idleAutoCompactPendingNotice).toBeUndefined();
    h.sweepAt([restored], T0 + 59 * MIN);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it('the screen-edge bookkeeping is saved while opted in, never while off', () => {
    const on = makeDs('ffff0000', { enabled: true });
    edge(on, 'idle', T0);
    edge(on, 'working', T0 + MIN); // not a turn: nothing to save
    edge(on, 'idle', T0 + 2 * MIN);
    noteIdleAutoCompactTurnStarted(on, 'om_ffff', T0 + 3 * MIN);
    edge(on, 'working', T0 + 3 * MIN);
    edge(on, 'idle', T0 + 4 * MIN);
    expect(persisted.updates).toEqual([
      { enabled: true, idleSince: T0 },
      { enabled: true, idleSince: T0, armed: { at: T0 + 3 * MIN, busy: true } },
      { enabled: true, idleSince: T0 + 4 * MIN },
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
    edge(ds, 'idle', T0 + 56 * MIN); // idle alone is not success any more
    expect(noteIdleAutoCompactTurnEnded(ds, turnId, 'completed')).toBe(true);
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
    expect(noteIdleAutoCompactTurnEnded(ds, turnId, 'completed')).toBe(true);
    expect(ds.session.idleAutoCompact.inFlight?.turnId).toBe(turnId);
    expect(ds.session.idleAutoCompact.inFlight?.completed).toBe(true);
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

  it('a compact cancelled before its idle edge is not compacted again 55 minutes later', () => {
    const ds = makeDs('intr0009', { enabled: true });
    edge(ds, 'idle', T0);
    const h = harness();
    h.sweepAt([ds], T0 + 55 * MIN);
    const turnId = h.compact.mock.calls[0][1];
    edge(ds, 'working', T0 + 55 * MIN + 1_000);
    noteIdleAutoCompactTurnEnded(ds, turnId, 'cancelled'); // Ctrl-C
    edge(ds, 'idle', T0 + 56 * MIN);
    for (let m = 57; m <= 200; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).toHaveBeenCalledTimes(1);
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
  it('clearIdleAutoCompactStretch drops the stretch, the arm and the marker', () => {
    const ds = { session: {} } as unknown as DaemonSession;
    expect(clearIdleAutoCompactStretch(ds)).toBe(false);
    applyIdleAutoCompactSetting(ds.session, { enabled: true, minutes: 20 });
    expect(clearIdleAutoCompactStretch(ds)).toBe(false);
    ds.idleAutoCompactWarmSince = T0;
    ds.idleAutoCompactArm = { at: T0, busy: true };
    Object.assign(ds.session.idleAutoCompact!, {
      idleSince: T0, armed: { at: T0, busy: true },
      inFlight: { turnId: 'auto-compact:idle:x', since: T0, idleMinutes: 20 },
    });
    expect(clearIdleAutoCompactStretch(ds)).toBe(true);
    expect(ds.session.idleAutoCompact).toEqual({ enabled: true, minutes: 20 });
    expect(ds.idleAutoCompactWarmSince).toBeUndefined();
    expect(ds.idleAutoCompactArm).toBeUndefined();
    // Idempotent.
    expect(clearIdleAutoCompactStretch(ds)).toBe(false);
    // A refused compact waiting for another try goes with the stretch (and the
    // row is saved: the caller is told something changed).
    ds.session.idleAutoCompact!.retry = { stretch: T0, attempts: 1, reason: 'unconfirmed' };
    expect(clearIdleAutoCompactStretch(ds)).toBe(true);
    expect(ds.session.idleAutoCompact).toEqual({ enabled: true, minutes: 20 });
  });

  it('a message-less cold resume is never compacted: its cache was never warmed', () => {
    const ds = makeDs('susp001', { enabled: true, minutes: 55 });
    edge(ds, 'idle', T0);
    // suspendWorker(): live fields and the persisted mirror are all dropped.
    expect(clearIdleAutoCompactStretch(ds)).toBe(true);
    ds.idleSinceAt = undefined;
    ds.lastScreenStatus = undefined;
    ds.idleAutoCompactPendingNotice = undefined;
    delete ds.idleAutoCompactDispatchedTurnId;
    // A web-terminal / dashboard visit cold-starts the CLI with no queued
    // message; its first status is idle at T0+56m.
    const h = harness();
    edge(ds, 'idle', T0 + 56 * MIN);
    expect(h.sweepAt([ds], T0 + 56 * MIN)).toBe(0);
    // Nor 55 minutes after the cold start: compacting would read it all cold.
    for (let m = 57; m <= 240; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    // A cold resume can also show working before its first idle (a slow
    // --resume boot): still no request, still cold.
    edge(ds, 'working', T0 + 241 * MIN);
    edge(ds, 'idle', T0 + 242 * MIN);
    expect(h.sweepAt([ds], T0 + 297 * MIN)).toBe(0);
    // The next botmux turn warms it.
    noteIdleAutoCompactTurnStarted(ds, 'om_after_resume', T0 + 300 * MIN);
    edge(ds, 'working', T0 + 300 * MIN);
    edge(ds, 'idle', T0 + 301 * MIN);
    expect(h.sweepAt([ds], T0 + 356 * MIN)).toBe(1);
  });

  it('turning the feature on after a cold start does not time the cold stretch', () => {
    const ds = makeDs('susp002');
    edge(ds, 'idle', T0);
    clearIdleAutoCompactStretch(ds); // suspend
    ds.idleSinceAt = undefined;
    ds.lastScreenStatus = undefined;
    edge(ds, 'idle', T0 + 10 * MIN); // cold resume while the feature is off
    applyIdleAutoCompactSetting(ds.session, { enabled: true });
    const h = harness();
    for (let m = 10; m <= 120; m += 1) h.sweepAt([ds], T0 + m * MIN);
    expect(h.compact).not.toHaveBeenCalled();
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

  it('only locally answered CLI commands are exempt from arming a warm stretch', () => {
    expect(isLocalCliCommand('/model opus')).toBe(true);
    expect(isLocalCliCommand('/cost')).toBe(true);
    expect(isLocalCliCommand('/review')).toBe(false);
    expect(isLocalCliCommand('/compact')).toBe(false);
    expect(isLocalCliCommand('/my-skill do it')).toBe(false);
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
