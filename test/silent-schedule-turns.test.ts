import { describe, expect, it } from 'vitest';
import {
  armSilentScheduledTurn,
  disarmSilentScheduledTurn,
  isActiveTurnSilentSchedule,
  isSilentScheduledTurn,
  noteNonSilentTurnActivity,
} from '../src/core/silent-schedule-turns.js';
import type { DaemonSession } from '../src/core/types.js';

function session(hidden = false): DaemonSession {
  return {
    session: {
      rootMessageId: hidden ? 'schedule-run:hidden:run' : 'om_root',
      ...(hidden ? {
        deferredScheduleRun: {
          taskId: 'task-hidden', turnId: 'schedule:hidden:run',
          routingAnchor: 'schedule-run:hidden:run', createdAt: new Date(0).toISOString(),
        },
      } : {}),
    },
  } as DaemonSession;
}

const now = 100_000_000;

describe('isSilentScheduledTurn', () => {
  it.each(['scheduledRun', 'scheduledRuns'] as const)('retains exact silent policy after JSON restore using %s', field => {
    const ds = session();
    const silentRun = { taskId: 'shared', runId: 'silent', turnId: 'schedule:shared:silent', silent: true };
    const loudRun = { taskId: 'shared', runId: 'loud', turnId: 'schedule:shared:loud', silent: false };
    if (field === 'scheduledRun') {
      ds.session.scheduledRun = silentRun;
      ds.session.scheduledRuns = { [loudRun.turnId]: loudRun };
    } else {
      ds.session.scheduledRun = loudRun;
      ds.session.scheduledRuns = { [silentRun.turnId]: silentRun };
    }
    armSilentScheduledTurn(ds, silentRun.turnId, now);
    const restored = { session: JSON.parse(JSON.stringify(ds.session)) } as DaemonSession;

    expect(restored.silentScheduledTurns).toBeUndefined();
    expect(restored.silentScheduledTurnMeta).toBeUndefined();
    expect(restored.latestSilentScheduledTurn).toBeUndefined();
    expect(isSilentScheduledTurn(restored, silentRun.turnId, now)).toBe(true);
    expect(isSilentScheduledTurn(restored, loudRun.turnId, now)).toBe(false);
    expect(isSilentScheduledTurn(restored, 'schedule:shared:other', now)).toBe(false);
    expect(isSilentScheduledTurn(restored, 'om_human', now)).toBe(false);
    expect(isSilentScheduledTurn(restored, undefined, now)).toBe(false);
  });

  it('retains a persisted silent run after its runtime marker expires', () => {
    const ds = session();
    const turnId = 'schedule:shared:expired';
    ds.session.scheduledRun = { taskId: 'shared', runId: 'expired', turnId, silent: true };
    armSilentScheduledTurn(ds, turnId, 0);
    armSilentScheduledTurn(ds, 'schedule:shared:next', now);

    expect(ds.silentScheduledTurns?.has(turnId)).toBe(false);
    expect(isSilentScheduledTurn(ds, turnId, now)).toBe(true);
    expect(isSilentScheduledTurn(ds, 'om_human', now)).toBe(false);
  });

  it('retains an older persisted silent run after more than 256 runtime markers', () => {
    const ds = session();
    const turnId = 'schedule:shared:old';
    ds.session.scheduledRuns = { [turnId]: { taskId: 'shared', runId: 'old', turnId, silent: true } };
    ds.session.scheduledRun = { taskId: 'shared', runId: 'loud', turnId: 'schedule:shared:loud', silent: false };
    armSilentScheduledTurn(ds, turnId, now);
    for (let i = 0; i < 300; i += 1) armSilentScheduledTurn(ds, `schedule:shared:${i}`, now);

    expect(ds.silentScheduledTurns?.has(turnId)).toBe(false);
    expect(isSilentScheduledTurn(ds, turnId, now)).toBe(true);
    expect(isSilentScheduledTurn(ds, 'schedule:shared:loud', now)).toBe(false);
    expect(isSilentScheduledTurn(ds, 'om_human', now)).toBe(false);
  });

  it.each([false, true])('keeps persisted loud policy non-silent despite stale runtime/deferred state, hidden=%s', hidden => {
    const ds = session(hidden);
    const turnId = hidden ? 'schedule:hidden:run' : 'schedule:shared:loud';
    ds.session.scheduledRun = { taskId: hidden ? 'hidden' : 'shared', runId: 'loud', turnId, silent: false };
    armSilentScheduledTurn(ds, turnId, now);

    expect(isSilentScheduledTurn(ds, turnId, now)).toBe(false);
  });

  it('does not inherit persisted silence from a mismatched run stored under another turn', () => {
    const ds = session();
    ds.session.scheduledRuns = {
      om_human: { taskId: 'shared', runId: 'silent', turnId: 'schedule:shared:silent', silent: true },
    };
    expect(isSilentScheduledTurn(ds, 'om_human', now)).toBe(false);
  });

  it('preserves runtime silence and expiry for legacy persisted runs without a policy', () => {
    const ds = session();
    const turnId = 'schedule:shared:legacy';
    ds.session.scheduledRun = { taskId: 'shared', runId: 'legacy', turnId };
    expect(isSilentScheduledTurn(ds, turnId, 0)).toBe(false);
    armSilentScheduledTurn(ds, turnId, 0);
    expect(isSilentScheduledTurn(ds, turnId, 0)).toBe(true);
    expect(isSilentScheduledTurn(ds, turnId, now)).toBe(false);
  });

  it.each([undefined, 'schedule:hidden:run'])('keeps a dedicated deferred run silent without a registry, turn=%s', turnId => {
    expect(isSilentScheduledTurn(session(true), turnId, now)).toBe(true);
  });

  it.each([undefined, 'schedule:hidden:run'])('keeps the dedicated run silent after registry expiry, turn=%s', turnId => {
    const ds = session(true);
    armSilentScheduledTurn(ds, 'schedule:hidden:run', 0);
    expect(isSilentScheduledTurn(ds, turnId, now)).toBe(true);
  });

  it('does not extend the hidden run to an explicit unrelated turn', () => {
    const ds = session(true);
    expect(isSilentScheduledTurn(ds, 'om_human', now)).toBe(false);
    armSilentScheduledTurn(ds, 'schedule:other:run', now);
    expect(isSilentScheduledTurn(ds, 'schedule:other:run', now)).toBe(true);
  });

  it('preserves original-run silence after materialization without silencing a human follow-up', () => {
    const ds = session(true);
    ds.session.rootMessageId = 'om_materialized';
    ds.currentTurnId = 'schedule:hidden:run';
    expect(isSilentScheduledTurn(ds, undefined, now)).toBe(true);
    ds.currentTurnId = 'om_human';
    expect(isSilentScheduledTurn(ds, undefined, now)).toBe(false);
    expect(isSilentScheduledTurn(ds, 'om_human', now)).toBe(false);
    expect(isSilentScheduledTurn(ds, 'schedule:hidden:run', now)).toBe(true);
  });

  it('requires exact attribution on an ordinary shared session', () => {
    const ds = session();
    armSilentScheduledTurn(ds, 'schedule:shared:run', now);
    expect(isSilentScheduledTurn(ds, undefined, now)).toBe(false);
    expect(isSilentScheduledTurn(ds, 'om_human', now)).toBe(false);
    expect(isSilentScheduledTurn(ds, 'schedule:shared:run', now)).toBe(true);
  });

  it('continues to expire and disarm ordinary shared-session markers', () => {
    const ds = session();
    armSilentScheduledTurn(ds, 'schedule:old:run', 0);
    expect(isSilentScheduledTurn(ds, 'schedule:old:run', now)).toBe(false);
    expect(ds.silentScheduledTurns).toBeUndefined();
    expect(ds.silentScheduledTurnMeta).toBeUndefined();
    expect(ds.latestSilentScheduledTurn).toBeUndefined();
    armSilentScheduledTurn(ds, 'schedule:new:run', now);
    disarmSilentScheduledTurn(ds, 'schedule:new:run');
    expect(isSilentScheduledTurn(ds, 'schedule:new:run', now)).toBe(false);
  });

  it('cleans up silentScheduledTurnMeta and latestSilentScheduledTurn on TTL expiry across 300 rounds', () => {
    const ds = session();
    const TTL_PLUS_ONE = 24 * 60 * 60 * 1000 + 1;
    let t = now;
    for (let i = 0; i < 300; i += 1) {
      const turnId = `schedule:ttl:${i}`;
      armSilentScheduledTurn(ds, turnId, t);
      t += TTL_PLUS_ONE;
      expect(isSilentScheduledTurn(ds, turnId, t)).toBe(false);
      expect(ds.silentScheduledTurns).toBeUndefined();
      expect(ds.silentScheduledTurnMeta).toBeUndefined();
      expect(ds.latestSilentScheduledTurn).toBeUndefined();
    }
    // Capacity bound also prunes metadata and latest pointer synchronously.
    for (let i = 0; i < 300; i += 1) {
      armSilentScheduledTurn(ds, `schedule:cap:${i}`, t);
    }
    expect(ds.silentScheduledTurns?.size).toBeLessThanOrEqual(256);
    expect(ds.silentScheduledTurnMeta?.size).toBeLessThanOrEqual(256);
  });
});

describe('isActiveTurnSilentSchedule', () => {
  function liveSession(hidden = false): DaemonSession {
    const ds = session(hidden);
    ds.worker = { killed: false } as any;
    ds.workerGeneration = 2;
    return ds;
  }

  it('is true only while a live busy turn is a silent schedule on the current worker generation', () => {
    const ds = liveSession();
    armSilentScheduledTurn(ds, 'schedule:poll:1', now);
    ds.currentTurnId = 'schedule:poll:1';
    ds.lastScreenTurnId = 'schedule:poll:1';
    ds.lastScreenTurnGeneration = 2;

    expect(isActiveTurnSilentSchedule(ds, 'working', now)).toBe(true);
    expect(isActiveTurnSilentSchedule(ds, 'analyzing', now)).toBe(true);
    expect(isActiveTurnSilentSchedule(ds, 'starting', now)).toBe(true);
    expect(isActiveTurnSilentSchedule(ds, 'idle', now)).toBe(false);
    expect(isActiveTurnSilentSchedule(ds, 'limited', now)).toBe(false);
    expect(isActiveTurnSilentSchedule(ds, 'dormant', now)).toBe(false);
    // Does not clear the silent registry needed by late screenshot/idle suppression.
    expect(isSilentScheduledTurn(ds, 'schedule:poll:1', now)).toBe(true);
  });

  it('flips false immediately when a human/non-silent turn opens during a silent schedule', () => {
    const ds = liveSession();
    armSilentScheduledTurn(ds, 'schedule:poll:1', now);
    ds.lastScreenTurnId = 'schedule:poll:1';
    ds.lastScreenTurnGeneration = 2;
    ds.currentTurnId = 'om_human_interrupt';

    expect(isActiveTurnSilentSchedule(ds, 'working', now)).toBe(false);
  });

  it('stays true when a shared session runs a silent schedule while ds.currentTurnId still holds an older finished human turn', () => {
    const ds = liveSession();
    // Human turn finished earlier; session-manager reuses the session without overwriting ds.currentTurnId.
    ds.currentTurnId = 'om_human_finished';
    noteNonSilentTurnActivity(ds);

    armSilentScheduledTurn(ds, 'schedule:poll:1', now);
    // Even before the first screen_update (starting/working), the newly armed silent schedule is recognized.
    expect(isActiveTurnSilentSchedule(ds, 'starting', now)).toBe(true);

    ds.lastScreenTurnId = 'schedule:poll:1';
    ds.lastScreenTurnGeneration = 2;
    expect(isActiveTurnSilentSchedule(ds, 'working', now)).toBe(true);

    // Once a NEW human turn interrupts mid-schedule, the exemption drops immediately.
    ds.currentTurnId = 'om_human_new';
    noteNonSilentTurnActivity(ds);
    expect(isActiveTurnSilentSchedule(ds, 'working', now)).toBe(false);
  });

  it('keeps activeTurnSilentSchedule false via lastNonSilentTurnSeq when ds.currentTurnId does not change and a lagging frame re-attributes the silent turn', () => {
    const ds = liveSession();
    ds.currentTurnId = 'om_human_finished';
    noteNonSilentTurnActivity(ds);

    armSilentScheduledTurn(ds, 'schedule:poll:seq', now);
    ds.lastScreenTurnId = 'schedule:poll:seq';
    ds.lastScreenTurnGeneration = 2;
    expect(isActiveTurnSilentSchedule(ds, 'working', now)).toBe(true);

    // Non-silent admission (e.g. card retry / direct submit) bumps sequence without touching ds.currentTurnId.
    noteNonSilentTurnActivity(ds);
    expect(isActiveTurnSilentSchedule(ds, 'working', now)).toBe(false);

    // A lagging working frame still naming the older silent turnId must remain false solely via seq ordering.
    ds.lastScreenTurnId = 'schedule:poll:seq';
    ds.lastScreenTurnGeneration = 2;
    expect(ds.currentTurnId).toBe('om_human_finished');
    expect(isActiveTurnSilentSchedule(ds, 'working', now)).toBe(false);
  });

  it('stays false while a human turn executes even if a silent schedule queued behind it', () => {
    const ds = liveSession();
    armSilentScheduledTurn(ds, 'schedule:poll:2', now);
    ds.lastScreenTurnId = 'om_human_running';
    ds.lastScreenTurnGeneration = 2;
    ds.currentTurnId = 'schedule:poll:2';

    expect(isActiveTurnSilentSchedule(ds, 'working', now)).toBe(false);
  });

  it('ignores stale worker generations and dead/suspended workers', () => {
    const ds = liveSession();
    armSilentScheduledTurn(ds, 'schedule:poll:1', now);
    ds.lastScreenTurnId = 'schedule:poll:1';
    ds.lastScreenTurnGeneration = 1; // older worker generation
    expect(isActiveTurnSilentSchedule(ds, 'working', now)).toBe(false);

    ds.currentTurnId = 'schedule:poll:1';
    ds.lastScreenTurnGeneration = 2;
    ds.worker = { killed: true } as any;
    expect(isActiveTurnSilentSchedule(ds, 'working', now)).toBe(false);
    ds.worker = null;
    expect(isActiveTurnSilentSchedule(ds, 'working', now)).toBe(false);
  });

  it('returns false for a screen-bound silent turn once its terminal has been recorded', () => {
    const ds = liveSession();
    armSilentScheduledTurn(ds, 'schedule:poll:term', now);
    ds.lastScreenTurnId = 'schedule:poll:term';
    ds.lastScreenTurnGeneration = 2;
    expect(isActiveTurnSilentSchedule(ds, 'working', now)).toBe(true);

    ds.lastTurnTerminalTurnId = 'schedule:poll:term';
    ds.lastTurnTerminalStatus = 'completed';
    expect(isActiveTurnSilentSchedule(ds, 'working', now)).toBe(false);

    // Also cleared via terminalIdentityTurnIds when ds.currentTurnId belonged to an older human turn.
    ds.lastTurnTerminalTurnId = undefined;
    ds.lastTurnTerminalStatus = undefined;
    ds.terminalIdentityTurnIds = new Set(['schedule:poll:term']);
    expect(isActiveTurnSilentSchedule(ds, 'working', now)).toBe(false);
  });
});
