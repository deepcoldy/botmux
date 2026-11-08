import { describe, expect, it } from 'vitest';
import { armSilentScheduledTurn, disarmSilentScheduledTurn, isSilentScheduledTurn } from '../src/core/silent-schedule-turns.js';
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
    armSilentScheduledTurn(ds, 'schedule:new:run', now);
    disarmSilentScheduledTurn(ds, 'schedule:new:run');
    expect(isSilentScheduledTurn(ds, 'schedule:new:run', now)).toBe(false);
  });
});
