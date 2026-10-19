import { describe, expect, it } from 'vitest';
import {
  appendDurablePrimaryInputCommit,
  durablePrimaryExistingTurnDisposition,
} from '../src/services/durable-primary-turn-admission.js';

function state(overrides: Record<string, unknown> = {}) {
  return {
    session: {},
    worker: { killed: false },
    cliReady: true,
    ...overrides,
  };
}

describe('durable primary existing-turn admission', () => {
  it('lets a dead worker reach cold refork but retries an in-flight start', () => {
    expect(durablePrimaryExistingTurnDisposition(
      state({ worker: null }),
      'om_next',
    )).toBe('ready');
    expect(durablePrimaryExistingTurnDisposition(
      state({ worker: { killed: true } }),
      'om_next',
    )).toBe('ready');
    expect(durablePrimaryExistingTurnDisposition(
      state({ worker: null, workerStartBlocker: 'in-flight-claim' }),
      'om_next',
    )).toBe('retry');
    expect(durablePrimaryExistingTurnDisposition(
      state({ worker: null, workerStartBlocker: 'pending-repo' }),
      'om_next',
    )).toBe('retry');
  });

  it('does not treat a durable queued-activation journal as a live start conflict', () => {
    expect(durablePrimaryExistingTurnDisposition(
      state({ worker: null }),
      'om_queued_recovery',
    )).toBe('ready');
  });

  it('retries before a live worker is ready or while another turn owns the session', () => {
    expect(durablePrimaryExistingTurnDisposition(
      state({ cliReady: false }),
      'om_next',
    )).toBe('retry');
    expect(durablePrimaryExistingTurnDisposition(
      state({ activeInteractiveTurn: { turnId: 'om_current' } }),
      'om_next',
    )).toBe('retry');
  });

  it('reuses a provider-submit marker before considering runtime busy state', () => {
    expect(durablePrimaryExistingTurnDisposition({
      session: {
        durablePrimaryInputCommits: [{
          version: 1,
          turnId: 'om_recovered',
          workerGeneration: 3,
          committedAt: '2026-10-18T00:00:00.000Z',
          dispatchAttempt: 2,
        }],
      },
      worker: null,
      cliReady: false,
      activeInteractiveTurn: { turnId: 'om_recovered' },
    }, 'om_recovered')).toBe('committed');
  });

  it('admits an uncommitted turn only on an idle ready worker', () => {
    expect(durablePrimaryExistingTurnDisposition(state(), 'om_next')).toBe('ready');
  });

  it('dedupes commit markers and retains only the newest bounded history', () => {
    const first = appendDurablePrimaryInputCommit([], {
      turnId: 'om_1', workerGeneration: 1, dispatchAttempt: 1,
      committedAt: '2026-10-18T00:00:00.000Z',
    }, 2);
    const duplicate = appendDurablePrimaryInputCommit(first.history, {
      turnId: 'om_1', workerGeneration: 2, dispatchAttempt: 2,
      committedAt: '2026-10-18T00:00:01.000Z',
    }, 2);
    const second = appendDurablePrimaryInputCommit(duplicate.history, {
      turnId: 'om_2', workerGeneration: 2,
      committedAt: '2026-10-18T00:00:02.000Z',
    }, 2);
    const third = appendDurablePrimaryInputCommit(second.history, {
      turnId: 'om_3', workerGeneration: 3,
      committedAt: '2026-10-18T00:00:03.000Z',
    }, 2);

    expect(first.added).toBe(true);
    expect(duplicate.added).toBe(false);
    expect(duplicate.history[0]).toMatchObject({ workerGeneration: 1, dispatchAttempt: 1 });
    expect(third.history.map(item => item.turnId)).toEqual(['om_2', 'om_3']);
  });
});
