import { describe, expect, it } from 'vitest';
import {
  BusyReadyDeferralTracker,
  BusyReadyLogThrottle,
  shouldRearmBusyProbeAfterSettleAbort,
} from '../src/utils/busy-ready-deferral.js';

describe('BusyReadyDeferralTracker', () => {
  it('is inactive until something defers', () => {
    const tracker = new BusyReadyDeferralTracker(() => 0);
    expect(tracker.active).toBe(false);
    expect(tracker.current).toBeNull();
    expect(tracker.waitedMs()).toBe(0);
  });

  it('records reason, source, turn identity and the episode start', () => {
    let now = 1_000;
    const tracker = new BusyReadyDeferralTracker(() => now);
    tracker.defer({ reason: 'busy-marker', source: 'Pi first-prompt-timeout', turnId: 't1', dispatchAttempt: 2 });
    expect(tracker.active).toBe(true);
    expect(tracker.current).toEqual({
      reason: 'busy-marker',
      source: 'Pi first-prompt-timeout',
      turnId: 't1',
      dispatchAttempt: 2,
      since: 1_000,
    });
    now = 4_500;
    expect(tracker.waitedMs()).toBe(3_500);
  });

  it('keeps the original start when the same episode defers again with a more specific reason', () => {
    let now = 1_000;
    const tracker = new BusyReadyDeferralTracker(() => now);
    tracker.defer({ reason: 'db-busy', source: 'probe', turnId: 't1' });
    now = 5_000;
    tracker.defer({ reason: 'busy-marker', source: 'probe-2', turnId: 't1' });
    expect(tracker.current?.reason).toBe('busy-marker');
    expect(tracker.current?.source).toBe('probe-2');
    expect(tracker.current?.since).toBe(1_000);
    expect(tracker.waitedMs()).toBe(4_000);
  });

  it('starts a fresh episode for a different turn while still active', () => {
    let now = 1_000;
    const tracker = new BusyReadyDeferralTracker(() => now);
    tracker.defer({ reason: 'busy-marker', source: 'probe', turnId: 't1' });
    now = 9_000;
    tracker.defer({ reason: 'busy-marker', source: 'probe', turnId: 't2' });
    expect(tracker.current?.turnId).toBe('t2');
    expect(tracker.current?.since).toBe(9_000);
    expect(tracker.waitedMs()).toBe(0);
  });

  it('clear returns what was released and deactivates the tracker', () => {
    const tracker = new BusyReadyDeferralTracker(() => 100);
    tracker.defer({ reason: 'db-busy', source: 'probe', turnId: 't1' });
    const cleared = tracker.clear('turn-terminal');
    expect(cleared?.clearedBy).toBe('turn-terminal');
    expect(cleared?.state.reason).toBe('db-busy');
    expect(cleared?.state.turnId).toBe('t1');
    expect(tracker.active).toBe(false);
    expect(tracker.clear('turn-terminal')).toBeNull();
  });

  it('a defer after clear starts a new episode', () => {
    let now = 1_000;
    const tracker = new BusyReadyDeferralTracker(() => now);
    tracker.defer({ reason: 'busy-marker', source: 'probe', turnId: 't1' });
    tracker.clear('prompt-ready');
    now = 60_000;
    tracker.defer({ reason: 'busy-marker', source: 'probe', turnId: 't1' });
    expect(tracker.current?.since).toBe(60_000);
  });
});

describe('BusyReadyLogThrottle', () => {
  it('warns once per reason+turn no matter how often it is asked', () => {
    let now = 0;
    const throttle = new BusyReadyLogThrottle({ now: () => now });
    expect(throttle.shouldLog('startup-pending', 't1')).toBe(true);
    now = 60_000;
    expect(throttle.shouldLog('startup-pending', 't1')).toBe(false);
    expect(throttle.shouldLog('startup-pending', 't1')).toBe(false);
  });

  it('spaces distinct reasons by at least the interval', () => {
    let now = 0;
    const throttle = new BusyReadyLogThrottle({ intervalMs: 30_000, now: () => now });
    expect(throttle.shouldLog('structured-turn-unfinished', 't1')).toBe(true);
    now = 10_000;
    expect(throttle.shouldLog('settle-aborted', 't1')).toBe(false);
    now = 30_000;
    expect(throttle.shouldLog('settle-aborted', 't1')).toBe(true);
    // Re-asking later does not re-admit the already-reported reason.
    now = 120_000;
    expect(throttle.shouldLog('structured-turn-unfinished', 't1')).toBe(false);
  });

  it('treats the same reason on a different turn as a distinct key', () => {
    let now = 0;
    const throttle = new BusyReadyLogThrottle({ intervalMs: 30_000, now: () => now });
    expect(throttle.shouldLog('startup-pending', 't1')).toBe(true);
    now = 30_000;
    expect(throttle.shouldLog('startup-pending', 't2')).toBe(true);
  });

  it('keeps suppressing a reason+turn after the deferral was cleared at turn end', () => {
    let now = 0;
    const tracker = new BusyReadyDeferralTracker(() => now);
    const throttle = new BusyReadyLogThrottle({ intervalMs: 0, now: () => now });
    tracker.defer({ reason: 'busy-marker', source: 'probe', turnId: 't1' });
    expect(throttle.shouldLog('settle-aborted', 't1')).toBe(true);
    tracker.clear('turn-terminal');
    now = 300_000;
    expect(throttle.shouldLog('settle-aborted', 't1')).toBe(false);
  });
});

describe('shouldRearmBusyProbeAfterSettleAbort', () => {
  const base = { deferralActive: true, promptReady: false, settleProceeded: false, revisionChanged: false };

  it('re-arms only for an active deferral whose settle aborted', () => {
    expect(shouldRearmBusyProbeAfterSettleAbort(base)).toBe(true);
    expect(shouldRearmBusyProbeAfterSettleAbort({ ...base, settleProceeded: true })).toBe(false);
    expect(shouldRearmBusyProbeAfterSettleAbort({ ...base, settleProceeded: true, revisionChanged: true })).toBe(true);
  });

  it('never re-arms for non-deferral probe callers', () => {
    expect(shouldRearmBusyProbeAfterSettleAbort({ ...base, deferralActive: false })).toBe(false);
    expect(shouldRearmBusyProbeAfterSettleAbort({ ...base, deferralActive: false, revisionChanged: true })).toBe(false);
  });

  it('never re-arms once readiness was published', () => {
    expect(shouldRearmBusyProbeAfterSettleAbort({ ...base, promptReady: true, revisionChanged: true })).toBe(false);
  });
});
