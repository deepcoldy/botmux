/**
 * Window-paced ordinary-turn recovery (the Claude wiring's pacing).
 *
 * 2026-11-13 11:08:18Z: a gateway answered 503 "no eligible upstream account is
 * currently available; the earliest account is expected to be available at
 * 2026-11-13T11:10:16Z". The fixed 2s/8s ladder continued at 11:08:21 and
 * 11:08:46 — both before that time — and gave up at 11:09, leaving the task
 * half-done until a human came back.
 *
 * Every case drives the real coordinator (and, where the exported session
 * functions matter, the real attach/restore path) on a fake clock.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  attachOrdinaryTurnRecovery,
  beginOrdinaryTurnRecovery,
  cancelOrdinaryTurnRecoveryForStop,
  DEFAULT_ORDINARY_TURN_RECOVERY_PACING,
  disposeOrdinaryTurnRecovery,
  handleOrdinaryTurnRecoveryTerminal,
  OrdinaryTurnRecoveryCoordinator,
  ORDINARY_RECOVERY_BUSY_RECHECK_MS,
  ORDINARY_RECOVERY_EXPIRED_GRACE_MS,
  planOrdinaryTurnRecoveryContinuation,
  type OrdinaryTurnRecoveryDeps,
  type OrdinaryTurnRecoveryPacing,
  type OrdinaryTurnRecoverySession,
  type OrdinaryTurnRecoveryState,
  type OrdinaryTurnRecoveryTerminal,
} from '../src/services/ordinary-turn-recovery.js';

const PACING = DEFAULT_ORDINARY_TURN_RECOVERY_PACING;
const MIN = 60_000;
const FAILED_AT = Date.parse('2026-11-13T11:08:19.343Z');
const LAST_ANSWERED_AT = Date.parse('2026-11-13T11:07:58.000Z');
const PROVIDER_AVAILABLE_AT = Date.parse('2026-11-13T11:10:16.000Z');

interface FakeTimer { at: number; run: () => void }

function fakeClock(start = FAILED_AT) {
  let now = start;
  const timers = new Set<FakeTimer>();
  return {
    now: () => now,
    schedule: (delayMs: number, run: () => void): FakeTimer => {
      const timer = { at: now + Math.max(0, delayMs), run };
      timers.add(timer);
      return timer;
    },
    cancel: (timer: FakeTimer) => { timers.delete(timer); },
    /** Run every timer due up to now + ms, in time order, moving the clock. */
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        now = Math.max(now, due.at);
        due.run();
      }
      now = target;
    },
    pending: () => [...timers].map(timer => timer.at),
  };
}

function failed(turnId: string, over: Partial<OrdinaryTurnRecoveryTerminal> = {}): OrdinaryTurnRecoveryTerminal {
  return { turnId, status: 'failed', errorCode: 'provider_server_error', retryable: true, ...over };
}

function harness(over: Partial<OrdinaryTurnRecoveryDeps<FakeTimer>> = {}, start = FAILED_AT) {
  const clock = fakeClock(start);
  const log: string[] = [];
  const persisted: OrdinaryTurnRecoveryState[] = [];
  let seq = 0;
  const enqueue = vi.fn(() => true);
  const warn = vi.fn();
  const deps: OrdinaryTurnRecoveryDeps<FakeTimer> = {
    schedule: clock.schedule,
    cancel: clock.cancel,
    persist: value => { persisted.push(structuredClone(value)); log.push(`persist:${value.status}`); },
    enqueue,
    warn,
    now: clock.now,
    random: () => 0.5,
    randomId: () => `c${++seq}`,
    pacing: PACING,
    ...over,
  };
  const coordinator = new OrdinaryTurnRecoveryCoordinator(deps);
  coordinator.restore({ logicalTurnId: 'om_original', currentTurnId: 'om_original', continuationsStarted: 0, status: 'running' });
  const live = () => persisted.at(-1)!;
  /** Fail whichever execution currently holds the slot. */
  const fail = (over: Partial<OrdinaryTurnRecoveryTerminal> = {}) =>
    coordinator.onTerminal(live() ?? { logicalTurnId: 'om_original', currentTurnId: 'om_original', continuationsStarted: 0, status: 'running' },
      failed((live() ?? { currentTurnId: 'om_original' }).currentTurnId, over));
  return { clock, coordinator, persisted, live, enqueue, warn, log, fail };
}

describe('planOrdinaryTurnRecoveryContinuation', () => {
  const base = { now: FAILED_AT, pacing: PACING, continuationsStarted: 0, ladderBase: 0, firstFailureAt: FAILED_AT };

  it('follows a fresh provider time with a small positive jitter, bounded by the window', () => {
    const early = planOrdinaryTurnRecoveryContinuation({ ...base, random: () => 0, providerRetryAt: PROVIDER_AVAILABLE_AT });
    const late = planOrdinaryTurnRecoveryContinuation({ ...base, random: () => 0.999_999, providerRetryAt: PROVIDER_AVAILABLE_AT });
    expect(early).toMatchObject({ kind: 'retry', providerRetryAt: PROVIDER_AVAILABLE_AT });
    expect(early.kind === 'retry' && early.nextAttemptAt).toBeGreaterThan(PROVIDER_AVAILABLE_AT);
    expect(late.kind === 'retry' && late.nextAttemptAt).toBeGreaterThan(early.kind === 'retry' ? early.nextAttemptAt : Infinity);
    expect(late.kind === 'retry' && late.nextAttemptAt).toBeLessThanOrEqual(PROVIDER_AVAILABLE_AT + 16_000);
  });

  it('puts the last attempt at the window end instead of past it', () => {
    const plan = planOrdinaryTurnRecoveryContinuation({
      ...base, random: () => 0, continuationsStarted: 10, firstFailureAt: FAILED_AT - 54 * MIN,
    });
    expect(plan).toEqual({ kind: 'retry', nextAttemptAt: FAILED_AT + MIN, windowEndsAt: FAILED_AT + MIN });
    const closed = planOrdinaryTurnRecoveryContinuation({
      ...base, now: FAILED_AT + MIN, random: () => 0, continuationsStarted: 11, firstFailureAt: FAILED_AT - 54 * MIN,
    });
    expect(closed).toEqual({ kind: 'stop', stopReason: 'window_closed', windowEndsAt: FAILED_AT + MIN });
  });
});

describe('window-paced ordinary-turn recovery', () => {
  it('waits for the provider\'s "available at" instead of spending continuations before it (11-13 replay)', () => {
    const h = harness();
    h.fail({ providerRetryAtMs: PROVIDER_AVAILABLE_AT, providerLastSuccessAtMs: LAST_ANSWERED_AT });

    expect(h.live()).toMatchObject({
      status: 'backoff',
      providerRetryAt: PROVIDER_AVAILABLE_AT,
      providerLastSuccessAt: LAST_ANSWERED_AT,
      windowEndsAt: LAST_ANSWERED_AT + PACING.windowMs,
    });
    const at = h.live().nextAttemptAt!;
    expect(at).toBeGreaterThan(PROVIDER_AVAILABLE_AT);
    expect(at).toBeLessThanOrEqual(PROVIDER_AVAILABLE_AT + 16_000);

    // 11:08:21 and 11:08:46 — where the fixed ladder continued — pass quietly.
    h.clock.advance(PROVIDER_AVAILABLE_AT - FAILED_AT);
    expect(h.enqueue).not.toHaveBeenCalled();
    h.clock.advance(at - h.clock.now());
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.live()).toMatchObject({ status: 'running', continuationsStarted: 1, dispatchedAt: at });
  });

  it('lengthens the backoff to minutes and keeps continuing until the window closes, then warns once', () => {
    const h = harness();
    h.fail({ providerLastSuccessAtMs: LAST_ANSWERED_AT });
    const windowEndsAt = LAST_ANSWERED_AT + PACING.windowMs;
    const delays: number[] = [];
    for (let guard = 0; h.live().status === 'backoff' && guard < 50; guard += 1) {
      const next = h.live().nextAttemptAt!;
      expect(next).toBeLessThanOrEqual(windowEndsAt);
      delays.push(next - h.clock.now());
      h.clock.advance(next - h.clock.now());
      expect(h.live().status).toBe('running');
      h.fail();
    }
    expect(delays.slice(0, 2)).toEqual([2_000, 8_000]);
    expect(delays[2]).toBeGreaterThanOrEqual(30_000);
    expect(delays.filter(delay => delay >= 300_000).length).toBeGreaterThan(3);
    // The last continuation went out right at the window's end.
    expect(h.persisted.filter(value => value.status === 'dispatching').at(-1)?.dispatchedAt).toBe(windowEndsAt);
    expect(h.live()).toMatchObject({ status: 'exhausted', stopReason: 'window_closed', windowEndsAt });
    expect(h.live().continuationsStarted).toBe(delays.length);
    expect(h.live().continuationsStarted).toBeGreaterThan(10);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.clock.pending()).toEqual([]);
  });

  it('stops at once, naming the provider time, when that time lies beyond the window', () => {
    const h = harness();
    const providerRetryAt = FAILED_AT + 30 * MIN;
    h.fail({ providerRetryAtMs: providerRetryAt, providerLastSuccessAtMs: FAILED_AT - 50 * MIN });
    expect(h.live()).toMatchObject({
      status: 'exhausted',
      stopReason: 'provider_eta_beyond_window',
      providerRetryAt,
      // Last answer 50 min ago: the floor of ten minutes after the failure.
      windowEndsAt: FAILED_AT + PACING.minWindowMs,
      continuationsStarted: 0,
    });
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.clock.pending()).toEqual([]);
    h.clock.advance(60 * MIN);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('restarts the ladder and extends the window after a continuation that got replies before failing', () => {
    const h = harness();
    h.fail({ providerLastSuccessAtMs: LAST_ANSWERED_AT });
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(h.live().nextAttemptAt! - h.clock.now());
      h.fail();
    }
    const longStep = h.live().nextAttemptAt! - h.clock.now();
    expect(longStep).toBeGreaterThanOrEqual(120_000);
    h.clock.advance(longStep);
    const dispatchedAt = h.live().dispatchedAt!;
    h.clock.advance(20 * MIN);
    const answeredAt = dispatchedAt + 19 * MIN;
    h.fail({ providerLastSuccessAtMs: answeredAt });
    expect(h.live()).toMatchObject({
      status: 'backoff',
      nextAttemptAt: h.clock.now() + 2_000,
      providerLastSuccessAt: answeredAt,
      windowEndsAt: answeredAt + PACING.windowMs,
    });
  });

  it('ignores a stale or far-future provider time and clamps a last success reported from the future', () => {
    const stale = harness();
    stale.fail({ providerRetryAtMs: FAILED_AT - 5_000 });
    expect(stale.live().nextAttemptAt).toBe(FAILED_AT + 2_000);
    expect(stale.live().providerRetryAt).toBeUndefined();

    const far = harness();
    far.fail({ providerRetryAtMs: FAILED_AT + 7 * 60 * MIN });
    expect(far.live()).toMatchObject({ status: 'backoff', nextAttemptAt: FAILED_AT + 2_000 });
    expect(far.live().providerRetryAt).toBeUndefined();

    const future = harness();
    future.fail({ providerLastSuccessAtMs: FAILED_AT + 60 * MIN });
    expect(future.live()).toMatchObject({ providerLastSuccessAt: FAILED_AT, windowEndsAt: FAILED_AT + PACING.windowMs });
  });

  it('caps the continuations of one logical turn even while each one makes progress', () => {
    const pacing: OrdinaryTurnRecoveryPacing = { ...PACING, maxContinuations: 3 };
    const h = harness({ pacing });
    h.fail();
    for (let guard = 0; h.live().status === 'backoff' && guard < 10; guard += 1) {
      h.clock.advance(h.live().nextAttemptAt! - h.clock.now());
      h.clock.advance(MIN);
      h.fail({ providerLastSuccessAtMs: h.clock.now() - 1_000 });
    }
    expect(h.live()).toMatchObject({ status: 'exhausted', stopReason: 'max_continuations', continuationsStarted: 3 });
    expect(h.enqueue).toHaveBeenCalledTimes(3);
  });

  it('does not type a due continuation into a busy CLI: it waits for idle within the window', () => {
    let busy = false;
    const h = harness({ isCliOccupied: () => busy });
    h.fail({ providerLastSuccessAtMs: LAST_ANSWERED_AT });
    busy = true;
    h.clock.advance(2_000);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.live().status).toBe('backoff');
    h.clock.advance(5 * ORDINARY_RECOVERY_BUSY_RECHECK_MS);
    expect(h.enqueue).not.toHaveBeenCalled();
    busy = false;
    // One more look after the CLI went quiet: whatever that work produced (a
    // human's terminal turn cancels the wait) lands before anything is typed.
    h.clock.advance(ORDINARY_RECOVERY_BUSY_RECHECK_MS);
    expect(h.enqueue).not.toHaveBeenCalled();
    h.clock.advance(ORDINARY_RECOVERY_BUSY_RECHECK_MS);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.live()).toMatchObject({ status: 'running', continuationsStarted: 1 });
  });

  it('is not held back by a usage limit: only a CLI that is running something defers it', () => {
    const h = harness({ isCliBusy: () => true, isCliOccupied: () => false });
    h.fail({ providerLastSuccessAtMs: LAST_ANSWERED_AT });
    h.clock.advance(2_000);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('settles as window_closed at the window end if the CLI is still in use, instead of typing into it', () => {
    const h = harness({ isCliOccupied: () => true });
    h.fail({ providerLastSuccessAtMs: LAST_ANSWERED_AT });
    const windowEndsAt = h.live().windowEndsAt!;
    h.clock.advance(windowEndsAt - h.clock.now() - 1);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.live().status).toBe('backoff');
    h.clock.advance(1);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.live()).toMatchObject({ status: 'exhausted', stopReason: 'window_closed', continuationsStarted: 0 });
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.clock.pending()).toEqual([]);
  });

  it('treats a provider time that leaves no margin before the window end as beyond the window', () => {
    const h = harness();
    const windowEndsAt = FAILED_AT + PACING.minWindowMs;
    h.fail({ providerRetryAtMs: windowEndsAt - 200, providerLastSuccessAtMs: FAILED_AT - 50 * MIN });
    expect(h.live()).toMatchObject({ status: 'exhausted', stopReason: 'provider_eta_beyond_window', windowEndsAt });
  });

  describe('the "waiting for the provider" notice', () => {
    it('is raised once per logical turn, after the state that records it is saved', () => {
      const log: string[] = [];
      const notifyWaiting = vi.fn((value: OrdinaryTurnRecoveryState) => { log.push(`notify:${value.waitNoticeSentAt}`); });
      const h = harness({
        notifyWaiting,
        persist: value => { log.push(`persist:${value.status}:${value.waitNoticeSentAt ?? '-'}`); },
      });
      // persist is swapped out above; read state from the notice instead.
      h.coordinator.onTerminal(
        { logicalTurnId: 'om_original', currentTurnId: 'om_original', continuationsStarted: 0, status: 'running' },
        failed('om_original', { providerRetryAtMs: PROVIDER_AVAILABLE_AT, providerLastSuccessAtMs: LAST_ANSWERED_AT }),
      );
      expect(notifyWaiting).toHaveBeenCalledTimes(1);
      expect(notifyWaiting.mock.calls[0][0]).toMatchObject({
        status: 'backoff', providerRetryAt: PROVIDER_AVAILABLE_AT, waitNoticeSentAt: FAILED_AT,
      });
      expect(log).toEqual([`persist:backoff:${FAILED_AT}`, `notify:${FAILED_AT}`]);
    });

    it('is not repeated for later long waits of the same turn, nor raised for short ones', () => {
      const notifyWaiting = vi.fn();
      const h = harness({ notifyWaiting });
      h.fail();
      expect(notifyWaiting).not.toHaveBeenCalled();
      for (let guard = 0; guard < 8 && h.live().status === 'backoff'; guard += 1) {
        h.clock.advance(h.live().nextAttemptAt! - h.clock.now());
        h.fail();
      }
      expect(notifyWaiting).toHaveBeenCalledTimes(1);
      expect(notifyWaiting.mock.calls[0][0].nextAttemptAt - notifyWaiting.mock.calls[0][0].waitNoticeSentAt)
        .toBeGreaterThanOrEqual(PACING.waitNoticeMinDelayMs);
    });

    it('is never raised for a silent scheduled turn, while the same failure of a loud one raises it', () => {
      const turn = (silent: boolean): OrdinaryTurnRecoveryState => ({
        logicalTurnId: 'schedule:t1:u1', currentTurnId: 'schedule:t1:u1', continuationsStarted: 0,
        status: 'running', ...(silent ? { silentLogicalTurnIds: ['schedule:t1:u1'] } : {}),
      });
      const loud = vi.fn();
      harness({ notifyWaiting: loud }).coordinator
        .onTerminal(turn(false), failed('schedule:t1:u1', { providerRetryAtMs: PROVIDER_AVAILABLE_AT }));
      expect(loud).toHaveBeenCalledTimes(1);

      const quiet = vi.fn();
      const h = harness({ notifyWaiting: quiet });
      h.coordinator.onTerminal(turn(true), failed('schedule:t1:u1', { providerRetryAtMs: PROVIDER_AVAILABLE_AT }));
      expect(h.live()).toMatchObject({ status: 'backoff', providerRetryAt: PROVIDER_AVAILABLE_AT });
      expect(h.live().waitNoticeSentAt).toBeUndefined();
      expect(quiet).not.toHaveBeenCalled();
    });

    it('cannot break the recovery when it throws', () => {
      const notifyWaiting = vi.fn(() => { throw new Error('feishu down'); });
      const h = harness({ notifyWaiting });
      h.fail({ providerRetryAtMs: PROVIDER_AVAILABLE_AT });
      expect(notifyWaiting).toHaveBeenCalledTimes(1);
      expect(h.live().status).toBe('backoff');
      expect(h.live().nextAttemptAt).toBeGreaterThan(PROVIDER_AVAILABLE_AT);
      h.clock.advance(h.live().nextAttemptAt! - h.clock.now());
      expect(h.enqueue).toHaveBeenCalledTimes(1);
    });
  });
});

/** The session-level functions the daemon calls, around a long provider wait. */
describe('window-paced recovery keeps the existing interruption semantics', () => {
  function attached(over: Partial<OrdinaryTurnRecoveryDeps<FakeTimer>> = {}, start = FAILED_AT) {
    const clock = fakeClock(start);
    const session: OrdinaryTurnRecoverySession = { sessionId: `pacing-${Math.random()}` };
    const enqueue = vi.fn(() => true);
    const warn = vi.fn();
    const deps: OrdinaryTurnRecoveryDeps<FakeTimer> = {
      schedule: clock.schedule, cancel: clock.cancel, persist: vi.fn(), enqueue, warn,
      now: clock.now, random: () => 0.5, pacing: PACING, ...over,
    };
    attachOrdinaryTurnRecovery(session, deps);
    beginOrdinaryTurnRecovery(session, 'om_original');
    handleOrdinaryTurnRecoveryTerminal(session, failed('om_original', {
      providerRetryAtMs: PROVIDER_AVAILABLE_AT, providerLastSuccessAtMs: LAST_ANSWERED_AT,
    }));
    expect(session.ordinaryTurnRecovery?.status).toBe('backoff');
    // The scenario of every case below: a wait of minutes, not seconds.
    expect(session.ordinaryTurnRecovery?.nextAttemptAt).toBeGreaterThan(PROVIDER_AVAILABLE_AT);
    return { clock, session, enqueue, warn, deps };
  }
  /** Let the wait run out; returns the continuation's turn id. */
  function continueAfterWait(h: ReturnType<typeof attached>): string {
    h.clock.advance(PROVIDER_AVAILABLE_AT - h.clock.now());
    expect(h.enqueue).not.toHaveBeenCalled();
    h.clock.advance(h.session.ordinaryTurnRecovery!.nextAttemptAt! - h.clock.now());
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    return (h.enqueue.mock.calls[0] as unknown as [{ turnId: string }])[0].turnId;
  }

  it('a new user message during the wait replaces it: nothing is continued afterwards', () => {
    const h = attached();
    h.clock.advance(30_000);
    beginOrdinaryTurnRecovery(h.session, 'om_newer');
    expect(h.session.ordinaryTurnRecovery).toMatchObject({ logicalTurnId: 'om_newer', status: 'running' });
    expect(h.session.ordinaryTurnRecovery?.windowEndsAt).toBeUndefined();
    h.clock.advance(60 * MIN);
    expect(h.enqueue).not.toHaveBeenCalled();
    disposeOrdinaryTurnRecovery(h.session);
  });

  it('/stop during the wait cancels it', () => {
    const h = attached();
    h.clock.advance(30_000);
    expect(cancelOrdinaryTurnRecoveryForStop(h.session)?.status).toBe('cancelled');
    h.clock.advance(60 * MIN);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
    disposeOrdinaryTurnRecovery(h.session);
  });

  it('closing the session drops the wait', () => {
    const h = attached();
    h.clock.advance(30_000);
    disposeOrdinaryTurnRecovery(h.session);
    h.clock.advance(60 * MIN);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('a daemon restart re-arms the saved provider time, not a fresh ladder', () => {
    const h = attached();
    const saved = structuredClone(h.session.ordinaryTurnRecovery!);
    disposeOrdinaryTurnRecovery(h.session);

    const clock = fakeClock(FAILED_AT + 40_000);
    const restored: OrdinaryTurnRecoverySession = { sessionId: `${h.session.sessionId}-restored`, ordinaryTurnRecovery: saved };
    const enqueue = vi.fn(() => true);
    attachOrdinaryTurnRecovery(restored, { ...h.deps, schedule: clock.schedule, cancel: clock.cancel, now: clock.now, enqueue });
    expect(clock.pending()).toEqual([saved.nextAttemptAt]);
    clock.advance(PROVIDER_AVAILABLE_AT - clock.now());
    expect(enqueue).not.toHaveBeenCalled();
    clock.advance(saved.nextAttemptAt! - clock.now());
    expect(enqueue).toHaveBeenCalledTimes(1);
    disposeOrdinaryTurnRecovery(restored);
  });

  it('a wait restored after its window ended settles as window_closed instead of continuing late', () => {
    const h = attached();
    const saved = structuredClone(h.session.ordinaryTurnRecovery!);
    disposeOrdinaryTurnRecovery(h.session);
    // The daemon was down (or the closed session woke up) long after the window.
    const clock = fakeClock(saved.windowEndsAt! + ORDINARY_RECOVERY_EXPIRED_GRACE_MS + 3 * 60 * MIN);
    const restored: OrdinaryTurnRecoverySession = { sessionId: `${h.session.sessionId}-late`, ordinaryTurnRecovery: saved };
    const enqueue = vi.fn(() => true);
    const warn = vi.fn();
    attachOrdinaryTurnRecovery(restored, { ...h.deps, schedule: clock.schedule, cancel: clock.cancel, now: clock.now, enqueue, warn });
    clock.advance(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(restored.ordinaryTurnRecovery).toMatchObject({ status: 'exhausted', stopReason: 'window_closed', continuationsStarted: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    disposeOrdinaryTurnRecovery(restored);
  });

  it('a wait restored just after its window end (timer lag) still makes its last attempt', () => {
    const h = attached();
    const saved = structuredClone(h.session.ordinaryTurnRecovery!);
    saved.nextAttemptAt = saved.windowEndsAt;
    disposeOrdinaryTurnRecovery(h.session);
    const clock = fakeClock(saved.windowEndsAt! + 5_000);
    const restored: OrdinaryTurnRecoverySession = { sessionId: `${h.session.sessionId}-lag`, ordinaryTurnRecovery: saved };
    const enqueue = vi.fn(() => true);
    attachOrdinaryTurnRecovery(restored, { ...h.deps, schedule: clock.schedule, cancel: clock.cancel, now: clock.now, enqueue });
    clock.advance(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    disposeOrdinaryTurnRecovery(restored);
  });

  it('a restart that may not resume backoff still settles it as needing attention', () => {
    const h = attached();
    const saved = structuredClone(h.session.ordinaryTurnRecovery!);
    disposeOrdinaryTurnRecovery(h.session);
    const restored: OrdinaryTurnRecoverySession = { sessionId: `${h.session.sessionId}-strict`, ordinaryTurnRecovery: saved };
    const warn = vi.fn();
    attachOrdinaryTurnRecovery(restored, { ...h.deps, warn, resumeRecoveryOnRestore: false });
    expect(restored.ordinaryTurnRecovery).toMatchObject({ status: 'attention_required', lastErrorCode: 'recovery_restart_unverified' });
    expect(warn).toHaveBeenCalledTimes(1);
    disposeOrdinaryTurnRecovery(restored);
  });

  it('a continuation that runs into the usage limit keeps the recovery running, unpaced', () => {
    const notifyWaiting = vi.fn();
    const h = attached({ notifyWaiting });
    notifyWaiting.mockClear();
    const continuation = continueAfterWait(h);
    handleOrdinaryTurnRecoveryTerminal(h.session, {
      turnId: continuation, status: 'failed', errorCode: 'provider_rate_limited', retryable: false,
      providerRetryAtMs: h.clock.now() + 5 * MIN,
    });
    expect(h.session.ordinaryTurnRecovery).toMatchObject({ status: 'running', currentTurnId: continuation, continuationsStarted: 1 });
    expect(h.clock.pending()).toEqual([]);
    expect(notifyWaiting).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
    disposeOrdinaryTurnRecovery(h.session);
  });

  it('a continuation that fails non-retryably goes straight to attention even when it names a retry time', () => {
    const h = attached();
    const continuation = continueAfterWait(h);
    handleOrdinaryTurnRecoveryTerminal(h.session, {
      turnId: continuation, status: 'failed', errorCode: 'provider_invalid_request', retryable: false,
      providerRetryAtMs: h.clock.now() + 2 * MIN,
    });
    expect(h.session.ordinaryTurnRecovery).toMatchObject({ status: 'attention_required', lastErrorCode: 'provider_invalid_request' });
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.clock.pending()).toEqual([]);
    h.clock.advance(60 * MIN);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    disposeOrdinaryTurnRecovery(h.session);
  });
});
