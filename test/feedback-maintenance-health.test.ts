import { describe, expect, it } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import { hasFeedbackMaintenanceSessionWork, isFeedbackMaintenanceBusy } from '../src/core/feedback-maintenance-health.js';
import { withBotTurnAdmission, withBotTurnMutation } from '../src/core/bot-turn-mutation-gate.js';

function session(runtime: Record<string, unknown> = {}, durable: Record<string, unknown> = {}): DaemonSession {
  return {
    session: { status: 'active', backendType: 'tmux', ...durable },
    worker: null,
    ...runtime,
  } as unknown as DaemonSession;
}

describe('feedback maintenance session activity', () => {
  // Regression: using logical status alone wedges maintenance after restore/suspend.
  it.each([
    ['restored', {}, {}],
    ['cold suspended', {}, { suspendedColdResume: true }],
    ['queued', {}, { queued: true }],
    ['waiting for repository selection', { pendingRepo: {} }, { pendingRepoSetup: {} }],
    ['retired worker', { worker: { killed: true } }, {}],
    ['stale working screen', { lastScreenStatus: 'working' }, {}],
  ])('allows %s local sessions with no runtime work', (_name, runtime, durable) => {
    expect(hasFeedbackMaintenanceSessionWork(session(runtime, durable))).toBe(false);
  });

  it.each(['pty', 'tmux', 'herdr', 'zellij', 'zmx'])('allows dormant %s sessions', backendType => {
    expect(hasFeedbackMaintenanceSessionWork(session({}, { backendType }))).toBe(false);
  });

  it.each(['claude-code', 'codex', 'codex-app', 'traex', 'pi'])('allows dormant %s sessions', cliId => {
    expect(hasFeedbackMaintenanceSessionWork(session({}, { cliId }))).toBe(false);
  });

  it.each([undefined, 'working', 'idle', 'limited', 'interrupted'])(
    'preserves live-worker drain policy for screen %s', lastScreenStatus => {
      expect(hasFeedbackMaintenanceSessionWork(session({
        worker: { killed: false }, lastScreenStatus,
      }))).toBe(lastScreenStatus === undefined || lastScreenStatus === 'working');
    },
  );

  it.each(['riff', 'mojo', 'remote-runner'])('keeps workerless %s activity conservative', backendType => {
    expect(hasFeedbackMaintenanceSessionWork(session({}, { backendType }))).toBe(true);
    expect(hasFeedbackMaintenanceSessionWork(session({ lastScreenStatus: 'working' }, { backendType }))).toBe(true);
    expect(hasFeedbackMaintenanceSessionWork(session({ lastScreenStatus: 'idle' }, { backendType }))).toBe(false);
  });

  it.each(['riff', 'mojo', 'remote-runner'])('keeps legacy %s sessions without a backend stamp conservative', cliId => {
    expect(hasFeedbackMaintenanceSessionWork(session({}, { cliId, backendType: undefined }))).toBe(true);
    expect(hasFeedbackMaintenanceSessionWork(session({ lastScreenStatus: 'idle' }, { cliId, backendType: undefined }))).toBe(false);
  });

  // Final deliveries are daemon-owned promises that settle even after the
  // worker is gone, so their guard must stay independent of worker liveness.
  it.each(['active', 'closed'])('waits for final delivery on %s sessions even without a worker', status => {
    expect(hasFeedbackMaintenanceSessionWork(session({
      finalOutputDeliveriesInFlight: new Set([Promise.resolve()]),
    }, { status }))).toBe(true);
    expect(hasFeedbackMaintenanceSessionWork(session({
      finalOutputDeliveriesInFlight: new Set(), backgroundTaskCount: 0,
    }, { status }))).toBe(false);
  });

  it('keeps a live worker busy while a background task runs against an idle screen', () => {
    expect(hasFeedbackMaintenanceSessionWork(session({
      worker: { killed: false }, lastScreenStatus: 'idle', backgroundTaskCount: 1,
    }))).toBe(true);
  });

  it('treats a stale background-task count after local worker loss as dormant', () => {
    // Regression: the background leg ignored worker liveness, so a worker that
    // crashed while background tasks were running wedged maintenance until the
    // daemon restarted (nothing resets the stale count without a screen_update).
    expect(hasFeedbackMaintenanceSessionWork(session({
      backgroundTaskCount: 1, lastScreenStatus: 'idle',
    }))).toBe(false);
    expect(hasFeedbackMaintenanceSessionWork(session({
      worker: { killed: true }, backgroundTaskCount: 1, lastScreenStatus: 'working',
    }))).toBe(false);
  });

  it.each(['riff', 'mojo', 'remote-runner'])('keeps a stale background count conservative for workerless remote %s', cliId => {
    expect(hasFeedbackMaintenanceSessionWork(session({
      backgroundTaskCount: 1, lastScreenStatus: 'idle',
    }, { cliId }))).toBe(true);
    expect(hasFeedbackMaintenanceSessionWork(session({
      backgroundTaskCount: 1, lastScreenStatus: 'idle',
    }, { backendType: cliId, cliId: 'some-local-cli' }))).toBe(true);
  });

  it.each(['initialStartPending', 'worktreeCreating', 'pendingRepoCommitInFlight'])(
    'waits for %s before worker creation', flag => {
      expect(hasFeedbackMaintenanceSessionWork(session({ [flag]: true, lastScreenStatus: 'idle' }))).toBe(true);
    },
  );
});

describe('feedback maintenance admission activity', () => {
  it('waits for an admitted request before its session or worker exists', async () => {
    await withBotTurnAdmission('maintenance-admission', async () => {
      await Promise.resolve();
      expect(isFeedbackMaintenanceBusy('maintenance-admission', [])).toBe(true);
      expect(isFeedbackMaintenanceBusy('other-bot', [])).toBe(false);
      await withBotTurnAdmission('maintenance-admission', () => {
        expect(isFeedbackMaintenanceBusy('maintenance-admission', [session()])).toBe(true);
      });
      expect(isFeedbackMaintenanceBusy('maintenance-admission', [])).toBe(true);
    });
    expect(isFeedbackMaintenanceBusy('maintenance-admission', [session()])).toBe(false);
  });

  it('waits through an admission upgraded to a mutation and its remaining handler', async () => {
    await withBotTurnAdmission('maintenance-mutation', async () => {
      await withBotTurnMutation('maintenance-mutation', () => {
        expect(isFeedbackMaintenanceBusy('maintenance-mutation', [])).toBe(true);
      });
      expect(isFeedbackMaintenanceBusy('maintenance-mutation', [])).toBe(true);
    });
    expect(isFeedbackMaintenanceBusy('maintenance-mutation', [])).toBe(false);
  });

  it('releases activity when preparation fails', async () => {
    await expect(withBotTurnAdmission('maintenance-error', () => {
      throw new Error('preparation_failed');
    })).rejects.toThrow('preparation_failed');
    expect(isFeedbackMaintenanceBusy('maintenance-error', [])).toBe(false);
  });
});
