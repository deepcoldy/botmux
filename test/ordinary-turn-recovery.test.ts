import { describe, expect, it, vi } from 'vitest';
import {
  attachOrdinaryTurnRecovery,
  beginOrdinaryTurnRecovery,
  cancelOrdinaryTurnRecoveryForUserInput,
  disposeOrdinaryTurnRecovery,
  handleOrdinaryTurnRecoveryTerminal,
  requireOrdinaryTurnRecoveryAttention,
  ORDINARY_TURN_RECOVERY_PROMPT,
  OrdinaryTurnRecoveryCoordinator,
  type OrdinaryTurnRecoveryState,
} from '../src/services/ordinary-turn-recovery.js';

function state(overrides: Partial<OrdinaryTurnRecoveryState> = {}): OrdinaryTurnRecoveryState {
  return {
    logicalTurnId: 'om_original',
    currentTurnId: 'om_original',
    continuationsStarted: 0,
    status: 'running',
    ...overrides,
  };
}

describe('OrdinaryTurnRecoveryCoordinator', () => {
  it('automatically enqueues a continuation without replaying the original prompt', () => {
    const scheduled: Array<{ delayMs: number; run: () => void }> = [];
    const persist = vi.fn();
    const enqueue = vi.fn(() => true);
    const coordinator = new OrdinaryTurnRecoveryCoordinator({
      schedule: (delayMs, run) => { scheduled.push({ delayMs, run }); return run; },
      cancel: vi.fn(),
      persist,
      enqueue,
      warn: vi.fn(),
      now: () => 1_000,
      randomId: () => 'recovery-one',
      backoffMs: [2_000, 8_000],
    });

    const next = coordinator.onTerminal(state(), {
      turnId: 'om_original',
      status: 'failed',
      errorCode: 'provider_unexpected_eof',
      retryable: true,
    });

    expect(next.status).toBe('backoff');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(2_000);
    scheduled[0].run();

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      logicalTurnId: 'om_original',
      turnId: 'bmx-recovery-recovery-one',
      prompt: ORDINARY_TURN_RECOVERY_PROMPT,
      continuation: 1,
    }));
    expect(enqueue.mock.calls[0][0].prompt).not.toContain('original user prompt');
    expect(persist.mock.calls.some(([value]) => value.status === 'dispatching')).toBe(true);
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({
      currentTurnId: 'bmx-recovery-recovery-one',
      continuationsStarted: 1,
      status: 'running',
    }));
  });

  it('allows exactly two continuations then raises one exhaustion warning', () => {
    const timers: Array<() => void> = [];
    const warn = vi.fn();
    const coordinator = new OrdinaryTurnRecoveryCoordinator({
      schedule: (_delayMs, run) => { timers.push(run); return run; },
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => true),
      warn,
      now: () => 1_000,
      randomId: vi.fn()
        .mockReturnValueOnce('one')
        .mockReturnValueOnce('two'),
      backoffMs: [2_000, 8_000],
    });

    let current = coordinator.onTerminal(state(), {
      turnId: 'om_original', status: 'failed', retryable: true,
      errorCode: 'provider_unexpected_eof',
    });
    timers.shift()!();
    current = state({ currentTurnId: 'bmx-recovery-one', continuationsStarted: 1 });
    current = coordinator.onTerminal(current, {
      turnId: current.currentTurnId, status: 'failed', retryable: true,
      errorCode: 'provider_unexpected_eof',
    });
    timers.shift()!();
    current = state({ currentTurnId: 'bmx-recovery-two', continuationsStarted: 2 });
    current = coordinator.onTerminal(current, {
      turnId: current.currentTurnId, status: 'failed', retryable: true,
      errorCode: 'provider_unexpected_eof',
    });
    const duplicate = coordinator.onTerminal(current, {
      turnId: current.currentTurnId, status: 'failed', retryable: true,
      errorCode: 'provider_unexpected_eof',
    });

    expect(current.status).toBe('exhausted');
    expect(duplicate).toEqual(current);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('cancels pending recovery when a new user turn arrives', () => {
    const cancel = vi.fn();
    const persist = vi.fn();
    const coordinator = new OrdinaryTurnRecoveryCoordinator({
      schedule: (_delayMs, run) => run,
      cancel,
      persist,
      enqueue: vi.fn(() => true),
      warn: vi.fn(),
      now: () => 1_000,
      randomId: () => 'one',
      backoffMs: [2_000, 8_000],
    });
    const backing = state({ status: 'backoff', nextAttemptAt: 3_000 });
    coordinator.restore(backing);

    const cleared = coordinator.cancelForUserInput('om_new_user');

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cleared.status).toBe('cancelled');
    expect(cleared.cancelledByTurnId).toBe('om_new_user');
    expect(persist).toHaveBeenLastCalledWith(cleared);
  });

  it('keeps the live backoff state when cancellation persistence fails', () => {
    const scheduled: Array<() => void> = [];
    const persist = vi.fn();
    const coordinator = new OrdinaryTurnRecoveryCoordinator({
      schedule: (_delayMs, run) => { scheduled.push(run); return run; },
      cancel: vi.fn(),
      persist,
      enqueue: vi.fn(() => true),
      warn: vi.fn(),
      now: () => 1_000,
      randomId: () => 'one',
      backoffMs: [2_000, 8_000],
    });
    const backing = state({ status: 'backoff', nextAttemptAt: 3_000 });
    coordinator.restore(backing);
    persist.mockImplementation(() => { throw new Error('store unavailable'); });

    expect(() => coordinator.cancelForUserInput('om_new_user')).toThrow('store unavailable');
    expect(coordinator.onTerminal(backing, {
      turnId: 'om_original',
      status: 'failed',
      retryable: true,
    })).toEqual(backing);
    expect(scheduled).toHaveLength(2);
  });

  it('re-arms the prior backoff when beginning the admitted turn cannot be persisted', () => {
    const scheduled: Array<() => void> = [];
    const persist = vi.fn();
    const coordinator = new OrdinaryTurnRecoveryCoordinator({
      schedule: (_delayMs, run) => { scheduled.push(run); return run; },
      cancel: vi.fn(),
      persist,
      enqueue: vi.fn(() => true),
      warn: vi.fn(),
      now: () => 1_000,
      randomId: () => 'one',
      backoffMs: [2_000, 8_000],
    });
    const backing = state({ status: 'backoff', nextAttemptAt: 3_000 });
    coordinator.restore(backing);
    persist.mockImplementation(() => { throw new Error('store unavailable'); });

    expect(() => coordinator.begin('om_new_user')).toThrow('store unavailable');
    expect(coordinator.onTerminal(backing, {
      turnId: 'om_original',
      status: 'failed',
      retryable: true,
    })).toEqual(backing);
    expect(scheduled).toHaveLength(2);
  });

  it('does not let an admitted type-ahead turn replace the running terminal owner', () => {
    const persist = vi.fn();
    const coordinator = new OrdinaryTurnRecoveryCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist,
      enqueue: vi.fn(() => true),
      warn: vi.fn(),
    });
    const running = state();
    coordinator.restore(running);

    const current = coordinator.begin('om_type_ahead');

    expect(current).toEqual(running);
    expect(persist).not.toHaveBeenCalled();
  });

  it('ignores stale, duplicate, non-retryable, and rate-limited terminals', () => {
    const schedule = vi.fn();
    const coordinator = new OrdinaryTurnRecoveryCoordinator({
      schedule,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => true),
      warn: vi.fn(),
      now: () => 1_000,
      randomId: () => 'one',
      backoffMs: [2_000, 8_000],
    });
    const running = state({ currentTurnId: 'bmx-recovery-live', continuationsStarted: 1 });

    expect(coordinator.onTerminal(running, {
      turnId: 'bmx-recovery-stale', status: 'failed', retryable: true,
    })).toEqual(running);
    expect(coordinator.onTerminal(running, {
      turnId: running.currentTurnId, status: 'failed', retryable: false,
    }).status).toBe('attention_required');
    expect(coordinator.onTerminal(running, {
      turnId: running.currentTurnId, status: 'failed', retryable: true,
      errorCode: 'provider_rate_limited',
    })).toEqual(running);
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe('ordinary recovery session registry', () => {
  it('begins a fresh logical turn only after its daemon admission succeeds', () => {
    const session = { sessionId: 'session-begin' } as any;
    attachOrdinaryTurnRecovery(session, {
      schedule: (_delay, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => true),
      warn: vi.fn(),
    });

    beginOrdinaryTurnRecovery(session, 'om_new');

    expect(session.ordinaryTurnRecovery).toEqual({
      logicalTurnId: 'om_new',
      currentTurnId: 'om_new',
      continuationsStarted: 0,
      status: 'running',
    });
  });

  it('restores the persisted session projection when a registry write fails', () => {
    const original = state({ status: 'backoff', nextAttemptAt: 3_000 });
    const session = {
      sessionId: 'session-persist-rollback',
      ordinaryTurnRecovery: original,
    } as any;
    attachOrdinaryTurnRecovery(session, {
      schedule: (_delay, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(() => { throw new Error('store unavailable'); }),
      enqueue: vi.fn(() => true),
      warn: vi.fn(),
    });

    expect(() => cancelOrdinaryTurnRecoveryForUserInput(session, 'om_new'))
      .toThrow('store unavailable');
    expect(session.ordinaryTurnRecovery).toEqual(original);
  });

  it('persists continuation state, preserves reply context, and survives coordinator re-attach', () => {
    const timers: Array<() => void> = [];
    const session = {
      sessionId: 'session-one',
      ordinaryTurnRecovery: state(),
      turnReplyContexts: { om_original: { target: { mode: 'thread', rootMessageId: 'om_root' } } },
      replyTargets: { om_original: { updatedAt: '2026-08-13T00:00:00.000Z', senderOpenId: 'ou_user' } },
    } as any;
    const persist = vi.fn();
    const enqueue = vi.fn(() => true);

    attachOrdinaryTurnRecovery(session, {
      schedule: (_delay, run) => { timers.push(run); return run; },
      cancel: vi.fn(),
      persist,
      enqueue,
      warn: vi.fn(),
      now: () => 1_000,
      randomId: () => 'persisted',
      backoffMs: [2_000, 8_000],
    });
    handleOrdinaryTurnRecoveryTerminal(session, {
      turnId: 'om_original', status: 'failed', retryable: true,
      errorCode: 'provider_unexpected_eof',
    });
    disposeOrdinaryTurnRecovery(session);

    const restoredTimers: Array<() => void> = [];
    attachOrdinaryTurnRecovery(session, {
      schedule: (_delay, run) => { restoredTimers.push(run); return run; },
      cancel: vi.fn(),
      persist,
      enqueue,
      warn: vi.fn(),
      now: () => 1_500,
      randomId: () => 'persisted',
      backoffMs: [2_000, 8_000],
    });
    restoredTimers[0]();

    expect(session.ordinaryTurnRecovery).toMatchObject({
      logicalTurnId: 'om_original',
      currentTurnId: 'bmx-recovery-persisted',
      continuationsStarted: 1,
      status: 'running',
    });
    expect(session.turnReplyContexts['bmx-recovery-persisted'])
      .toEqual(session.turnReplyContexts.om_original);
    expect(session.replyTargets['bmx-recovery-persisted'])
      .toEqual(session.replyTargets.om_original);
    expect(persist).toHaveBeenCalled();
  });

  it('cancels a restored backoff before a fresh user turn can be crossed', () => {
    const cancel = vi.fn();
    const session = {
      sessionId: 'session-two',
      ordinaryTurnRecovery: state({ status: 'backoff', nextAttemptAt: 3_000 }),
    } as any;
    attachOrdinaryTurnRecovery(session, {
      schedule: (_delay, run) => run,
      cancel,
      persist: vi.fn(),
      enqueue: vi.fn(() => true),
      warn: vi.fn(),
      now: () => 1_000,
      randomId: () => 'unused',
      backoffMs: [2_000, 8_000],
    });

    cancelOrdinaryTurnRecoveryForUserInput(session, 'om_new_user');

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(session.ordinaryTurnRecovery).toMatchObject({
      status: 'cancelled',
      cancelledByTurnId: 'om_new_user',
    });
  });

  it.each(['exhausted', 'attention_required'] as const)(
    'cancels a terminal recovery record when a fresh user turn is admitted (%s)',
    status => {
      const session = {
        sessionId: `session-terminal-${status}`,
        ordinaryTurnRecovery: state({ status }),
      } as any;
      attachOrdinaryTurnRecovery(session, {
        schedule: (_delay, run) => run,
        cancel: vi.fn(),
        persist: vi.fn(),
        enqueue: vi.fn(() => true),
        warn: vi.fn(),
      });

      cancelOrdinaryTurnRecoveryForUserInput(session, 'om_new_user');

      expect(session.ordinaryTurnRecovery).toMatchObject({
        status: 'cancelled',
        cancelledByTurnId: 'om_new_user',
      });
    },
  );

  it('fails closed after a daemon restart interrupted the enqueue handoff', () => {
    const warn = vi.fn();
    const enqueue = vi.fn(() => true);
    const session = {
      sessionId: 'session-dispatching',
      ordinaryTurnRecovery: state({
        currentTurnId: 'bmx-recovery-interrupted',
        continuationsStarted: 1,
        status: 'dispatching',
      }),
    } as any;

    attachOrdinaryTurnRecovery(session, {
      schedule: (_delay, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue,
      warn,
    });

    expect(enqueue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(session.ordinaryTurnRecovery).toMatchObject({
      status: 'attention_required',
      lastErrorCode: 'recovery_dispatch_interrupted',
      alertSentAt: expect.any(Number),
      warningDispatched: true,
    });
  });

  it('fails closed exactly once when worker delivery of a continuation is exhausted', () => {
    const warn = vi.fn();
    const session = {
      sessionId: 'session-delivery-failed',
      ordinaryTurnRecovery: state({
        currentTurnId: 'bmx-recovery-undelivered',
        continuationsStarted: 1,
        status: 'running',
      }),
    } as any;

    attachOrdinaryTurnRecovery(session, {
      schedule: (_delay, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => true),
      warn,
    });

    requireOrdinaryTurnRecoveryAttention(
      session,
      'bmx-recovery-undelivered',
      'recovery_delivery_failed',
    );
    requireOrdinaryTurnRecoveryAttention(
      session,
      'bmx-recovery-undelivered',
      'recovery_delivery_failed',
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(session.ordinaryTurnRecovery).toMatchObject({
      status: 'attention_required',
      lastErrorCode: 'recovery_delivery_failed',
      alertSentAt: expect.any(Number),
      warningDispatched: true,
    });
  });

  it('schedules one warning when restore finds an unwarned terminal recovery state', () => {
    const warn = vi.fn();
    const session = {
      sessionId: 'session-unwarned-terminal',
      ordinaryTurnRecovery: state({
        status: 'attention_required',
        lastErrorCode: 'provider_unknown_error',
        alertSentAt: 1_000,
      }),
    } as any;

    attachOrdinaryTurnRecovery(session, {
      schedule: (_delay, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => true),
      warn,
      now: () => 2_000,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(session.ordinaryTurnRecovery).toMatchObject({
      status: 'attention_required',
      alertSentAt: 1_000,
      warningDispatched: true,
    });
  });
});
