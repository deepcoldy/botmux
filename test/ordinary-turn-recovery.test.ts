import { describe, expect, it, vi } from 'vitest';
import {
  attachOrdinaryTurnRecovery,
  beginOrdinaryTurnRecovery,
  cancelOrdinaryTurnRecoveryForUserInput,
  disposeOrdinaryTurnRecovery,
  handleOrdinaryTurnRecoveryTerminal,
  ordinaryTurnRecoveryHandlesTerminal,
  ordinaryTurnRecoverySilentTurnIds,
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

    // The running owner keeps the terminal; the successor is only remembered.
    expect(current).toEqual({ ...running, queuedLogicalTurnIds: ['om_type_ahead'] });
    expect(persist).toHaveBeenCalledWith({ ...running, queuedLogicalTurnIds: ['om_type_ahead'] });
    expect(coordinator.begin('om_type_ahead')).toEqual(current);
  });

  it('hands ownership to the queued type-ahead turn once the running turn completes', () => {
    const scheduled: Array<() => void> = [];
    const enqueue = vi.fn(() => true);
    const coordinator = new OrdinaryTurnRecoveryCoordinator({
      schedule: (_delayMs, run) => { scheduled.push(run); return run; },
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue,
      warn: vi.fn(),
      now: () => 1_000,
      randomId: () => 'one',
      backoffMs: [2_000, 8_000],
    });
    coordinator.restore(state());
    const queued = coordinator.begin('om_type_ahead');

    const promoted = coordinator.onTerminal(queued, { turnId: 'om_original', status: 'completed' });
    expect(promoted).toEqual({
      logicalTurnId: 'om_type_ahead',
      currentTurnId: 'om_type_ahead',
      continuationsStarted: 0,
      status: 'running',
    });

    // Before this, the successor's failure had no recovery consumer at all and
    // fell through to the「未启动自动续跑」card.
    const failed = coordinator.onTerminal(promoted, {
      turnId: 'om_type_ahead', status: 'failed', errorCode: 'provider_server_error', retryable: true,
    });
    expect(failed.status).toBe('backoff');
    scheduled[0]!();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      logicalTurnId: 'om_type_ahead',
      turnId: 'bmx-recovery-one',
      continuation: 1,
    }));
  });

  it('adopts a queued successor whose terminal arrives while the owner terminal was lost', () => {
    const schedule = vi.fn((_delayMs: number, run: () => void) => run);
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
    coordinator.restore(state());
    const queued = coordinator.begin('om_type_ahead');

    const next = coordinator.onTerminal(queued, {
      turnId: 'om_type_ahead', status: 'failed', errorCode: 'provider_server_error', retryable: true,
    });
    expect(next).toEqual(expect.objectContaining({
      logicalTurnId: 'om_type_ahead',
      currentTurnId: 'om_type_ahead',
      status: 'backoff',
    }));
    expect(next.queuedLogicalTurnIds).toBeUndefined();
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('keeps a delivered continuation as owner when the earlier-queued successor terminates first', () => {
    const scheduled: Array<() => void> = [];
    const enqueue = vi.fn(() => true);
    const persist = vi.fn();
    const coordinator = new OrdinaryTurnRecoveryCoordinator({
      schedule: (_delayMs, run) => { scheduled.push(run); return run; },
      cancel: vi.fn(),
      persist,
      enqueue,
      warn: vi.fn(),
      now: () => 1_000,
      randomId: () => 'one',
      backoffMs: [2_000, 8_000],
    });
    coordinator.restore(state());
    const queued = coordinator.begin('om_type_ahead');
    // A fails → backoff → A's continuation delivered and running.
    coordinator.onTerminal(queued, {
      turnId: 'om_original', status: 'failed', errorCode: 'provider_server_error', retryable: true,
    });
    scheduled[0]!();
    const inFlight = persist.mock.calls.at(-1)![0] as OrdinaryTurnRecoveryState;
    expect(inFlight).toEqual(expect.objectContaining({
      currentTurnId: 'bmx-recovery-one', continuationsStarted: 1, status: 'running',
      queuedLogicalTurnIds: ['om_type_ahead'],
    }));

    // B was queued in Claude before the continuation, so it terminates first:
    // it must not steal the slot from the delivered continuation, and its
    // failure must not dispatch a second recovery.
    const afterB = coordinator.onTerminal(inFlight, {
      turnId: 'om_type_ahead', status: 'failed', errorCode: 'provider_server_error', retryable: true,
    });
    expect(afterB).toEqual(expect.objectContaining({
      logicalTurnId: 'om_original', currentTurnId: 'bmx-recovery-one', continuationsStarted: 1, status: 'running',
    }));
    expect(afterB.queuedLogicalTurnIds).toBeUndefined();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);

    // The continuation's own terminal still settles the original logical turn.
    expect(coordinator.onTerminal(afterB, { turnId: 'bmx-recovery-one', status: 'completed' }))
      .toEqual(expect.objectContaining({ logicalTurnId: 'om_original', status: 'completed' }));
  });

  it('does not let a queued successor completing first overwrite a running continuation', () => {
    const scheduled: Array<() => void> = [];
    const enqueue = vi.fn(() => true);
    const persist = vi.fn();
    const coordinator = new OrdinaryTurnRecoveryCoordinator({
      schedule: (_delayMs, run) => { scheduled.push(run); return run; },
      cancel: vi.fn(),
      persist,
      enqueue,
      warn: vi.fn(),
      now: () => 1_000,
      randomId: () => 'one',
      backoffMs: [2_000, 8_000],
    });
    coordinator.restore(state());
    const queued = coordinator.begin('om_type_ahead');
    coordinator.onTerminal(queued, {
      turnId: 'om_original', status: 'failed', errorCode: 'provider_server_error', retryable: true,
    });
    scheduled[0]!();
    const inFlight = persist.mock.calls.at(-1)![0] as OrdinaryTurnRecoveryState;

    // B completes before A_recovery: A_recovery must stay the running owner ...
    const afterB = coordinator.onTerminal(inFlight, { turnId: 'om_type_ahead', status: 'completed' });
    expect(afterB).toEqual(expect.objectContaining({
      logicalTurnId: 'om_original', currentTurnId: 'bmx-recovery-one', continuationsStarted: 1, status: 'running',
    }));
    expect(afterB.queuedLogicalTurnIds).toBeUndefined();
    // ... so its later retryable failure still drives the second (bounded) continuation.
    const afterRecoveryFailed = coordinator.onTerminal(afterB, {
      turnId: 'bmx-recovery-one', status: 'failed', errorCode: 'provider_server_error', retryable: true,
    });
    expect(afterRecoveryFailed.status).toBe('backoff');
    expect(scheduled).toHaveLength(2);
  });

  it('only forgets a queued successor that terminates while a recovery is already in flight', () => {
    const schedule = vi.fn((_delayMs: number, run: () => void) => run);
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
    const backoff = state({ status: 'backoff', nextAttemptAt: 3_000, queuedLogicalTurnIds: ['om_type_ahead'] });
    coordinator.restore(backoff);

    const after = coordinator.onTerminal(backoff, { turnId: 'om_type_ahead', status: 'completed' });
    expect(after).toEqual(expect.objectContaining({ currentTurnId: 'om_original', status: 'backoff' }));
    expect(after.queuedLogicalTurnIds).toBeUndefined();
    expect(coordinator.onTerminal(after, { turnId: 'om_unknown', status: 'completed' })).toEqual(after);
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
  it('claims a terminal for a queued type-ahead successor so the fallback card stays quiet', () => {
    const session = { sessionId: 'session-queued', ordinaryTurnRecovery: state() } as any;
    attachOrdinaryTurnRecovery(session, {
      schedule: (_delay, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => true),
      warn: vi.fn(),
    });
    beginOrdinaryTurnRecovery(session, 'om_type_ahead');

    expect(ordinaryTurnRecoveryHandlesTerminal(session, { turnId: 'om_original', status: 'completed' })).toBe(true);
    expect(ordinaryTurnRecoveryHandlesTerminal(session, { turnId: 'om_type_ahead', status: 'failed' })).toBe(true);
    expect(ordinaryTurnRecoveryHandlesTerminal(session, { turnId: 'om_unknown', status: 'failed' })).toBe(false);

    // Once a continuation holds the slot, the queued successor is no longer claimed.
    session.ordinaryTurnRecovery = state({
      currentTurnId: 'bmx-recovery-live', continuationsStarted: 1, queuedLogicalTurnIds: ['om_type_ahead'],
    });
    expect(ordinaryTurnRecoveryHandlesTerminal(session, { turnId: 'bmx-recovery-live', status: 'failed' })).toBe(true);
    expect(ordinaryTurnRecoveryHandlesTerminal(session, { turnId: 'om_type_ahead', status: 'failed' })).toBe(false);
  });

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

describe('continuation identity', () => {
  function drive(mint: ((logicalTurnId: string, continuation: number) => string | undefined) | undefined, logicalTurnId: string) {
    const scheduled: Array<() => void> = [];
    const enqueue = vi.fn(() => true);
    const persist = vi.fn();
    const coordinator = new OrdinaryTurnRecoveryCoordinator({
      schedule: (_delayMs, run) => { scheduled.push(run); return run; },
      cancel: vi.fn(),
      persist,
      enqueue,
      warn: vi.fn(),
      randomId: () => 'rand',
      ...(mint ? { mintContinuationTurnId: mint } : {}),
    });
    coordinator.onTerminal(state({ logicalTurnId, currentTurnId: logicalTurnId }), {
      turnId: logicalTurnId,
      status: 'failed',
      errorCode: 'provider_server_error',
      retryable: true,
    });
    scheduled[0]!();
    return { enqueue, persist };
  }

  it('lets the daemon mint the continuation turn id and persists that exact identity before enqueue', () => {
    const mint = vi.fn((logicalTurnId: string, continuation: number) => `schedule:abcdef12:cont-${continuation}`);
    const { enqueue, persist } = drive(mint, 'schedule:abcdef12:11111111-1111-1111-1111-111111111111');

    expect(mint).toHaveBeenCalledWith('schedule:abcdef12:11111111-1111-1111-1111-111111111111', 1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      logicalTurnId: 'schedule:abcdef12:11111111-1111-1111-1111-111111111111',
      turnId: 'schedule:abcdef12:cont-1',
      continuation: 1,
    }));
    const dispatching = persist.mock.calls.map(([value]) => value).find(value => value.status === 'dispatching');
    expect(dispatching).toEqual(expect.objectContaining({ currentTurnId: 'schedule:abcdef12:cont-1' }));
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({
      currentTurnId: 'schedule:abcdef12:cont-1',
      status: 'running',
    }));
  });

  it('keeps the default bmx-recovery id when the minter declines or is absent', () => {
    expect(drive(() => undefined, 'om_original').enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'bmx-recovery-rand' }),
    );
    expect(drive(undefined, 'om_original').enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'bmx-recovery-rand' }),
    );
  });
});

describe('silent scheduled turns keep their silence across continuations', () => {
  const SILENT = 'schedule:abcdef12:11111111-1111-1111-1111-111111111111';

  function coordinatorWith(enqueue = vi.fn(() => true)) {
    const scheduled: Array<() => void> = [];
    let seq = 0;
    const coordinator = new OrdinaryTurnRecoveryCoordinator({
      schedule: (_delayMs, run) => { scheduled.push(run); return run; },
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue,
      warn: vi.fn(),
      now: () => 1_000,
      randomId: () => `r${++seq}`,
      backoffMs: [2_000, 8_000],
    });
    const fail = (current: OrdinaryTurnRecoveryState, turnId: string) => coordinator.onTerminal(current, {
      turnId, status: 'failed', errorCode: 'provider_server_error', retryable: true,
    });
    const fire = () => { scheduled.shift()!(); };
    return { coordinator, enqueue, fail, fire };
  }

  it('freezes the silent attribute at admission and carries it onto every continuation', () => {
    const { coordinator, enqueue, fail, fire } = coordinatorWith();
    const running = coordinator.begin(SILENT, { silent: true });
    expect(running.silentLogicalTurnIds).toEqual([SILENT]);

    fail(running, SILENT); fire();
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ logicalTurnId: SILENT, continuation: 1, silent: true }));
    const first = enqueue.mock.calls[0]![0] as any;
    fail({ ...running, currentTurnId: first.turnId, continuationsStarted: 1, status: 'running', silentLogicalTurnIds: [SILENT] }, first.turnId); fire();
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ continuation: 2, silent: true }));
  });

  it('keeps silence per logical turn: a queued silent successor is silent after promotion, an ordinary successor is not', () => {
    const { coordinator, enqueue, fail, fire } = coordinatorWith();
    const owner = coordinator.begin('om_first');
    const withSilent = coordinator.begin(SILENT, { silent: true });
    expect(withSilent.queuedLogicalTurnIds).toEqual([SILENT]);
    expect(withSilent.silentLogicalTurnIds).toEqual([SILENT]);
    const withOm = coordinator.begin('om_second');
    expect(withOm.queuedLogicalTurnIds).toEqual([SILENT, 'om_second']);

    // The loud owner's own continuation stays loud.
    const backoff = fail(withOm, 'om_first'); fire();
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ logicalTurnId: 'om_first', silent: false }));
    const cont = (enqueue.mock.calls.at(-1)![0] as any).turnId;
    const promotedSilent = coordinator.onTerminal(
      { ...backoff, currentTurnId: cont, continuationsStarted: 1, status: 'running' },
      { turnId: cont, status: 'completed' },
    );
    expect(promotedSilent).toEqual(expect.objectContaining({ logicalTurnId: SILENT, currentTurnId: SILENT, status: 'running' }));
    expect(promotedSilent.silentLogicalTurnIds).toEqual([SILENT]);
    expect(promotedSilent.queuedLogicalTurnIds).toEqual(['om_second']);

    fail(promotedSilent, SILENT); fire();
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ logicalTurnId: SILENT, silent: true }));
    const silentCont = (enqueue.mock.calls.at(-1)![0] as any).turnId;
    const promotedOm = coordinator.onTerminal(
      { ...promotedSilent, currentTurnId: silentCont, continuationsStarted: 1, status: 'running' },
      { turnId: silentCont, status: 'completed' },
    );
    expect(promotedOm).toEqual(expect.objectContaining({ logicalTurnId: 'om_second', status: 'running' }));
    expect(promotedOm.silentLogicalTurnIds).toBeUndefined();
    fail(promotedOm, 'om_second'); fire();
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ logicalTurnId: 'om_second', silent: false }));
    expect(owner.silentLogicalTurnIds).toBeUndefined();
  });

  it('keeps silence when a queued silent successor is adopted after the owner terminal was lost', () => {
    const { coordinator, enqueue, fail, fire } = coordinatorWith();
    coordinator.begin('om_first');
    const queued = coordinator.begin(SILENT, { silent: true });
    const adopted = fail(queued, SILENT);
    expect(adopted).toEqual(expect.objectContaining({ logicalTurnId: SILENT, status: 'backoff', silentLogicalTurnIds: [SILENT] }));
    fire();
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ logicalTurnId: SILENT, silent: true }));
  });

  it('does not inherit silence into a fresh turn after cancellation, and tolerates archives without the field', () => {
    const { coordinator, enqueue, fail, fire } = coordinatorWith();
    const silent = coordinator.begin(SILENT, { silent: true });
    fail(silent, SILENT);
    coordinator.cancelForUserInput('om_next');
    const fresh = coordinator.begin('om_next');
    expect(fresh.silentLogicalTurnIds).toBeUndefined();
    fail(fresh, 'om_next'); fire();
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ logicalTurnId: 'om_next', silent: false }));

    const legacy = coordinatorWith();
    legacy.coordinator.restore({ logicalTurnId: SILENT, currentTurnId: SILENT, continuationsStarted: 0, status: 'backoff', nextAttemptAt: 0 });
    legacy.fire();
    expect(legacy.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ logicalTurnId: SILENT, silent: false }));
  });

  it('lists the turn ids a restore must re-arm as silent', () => {
    expect(ordinaryTurnRecoverySilentTurnIds(undefined)).toEqual([]);
    expect(ordinaryTurnRecoverySilentTurnIds(state())).toEqual([]);
    // Owner silent, its delivered continuation running: both ids.
    expect(ordinaryTurnRecoverySilentTurnIds(state({
      logicalTurnId: SILENT, currentTurnId: 'schedule:abcdef12:22222222-2222-2222-2222-222222222222',
      continuationsStarted: 1, silentLogicalTurnIds: [SILENT],
    }))).toEqual([SILENT, 'schedule:abcdef12:22222222-2222-2222-2222-222222222222']);
    // Loud owner with a silent queued successor: only the successor.
    expect(ordinaryTurnRecoverySilentTurnIds(state({
      queuedLogicalTurnIds: [SILENT], silentLogicalTurnIds: [SILENT],
    }))).toEqual([SILENT]);
    // Settled states still re-arm: late idle/final events after a restart must
    // stay hushed, and marks are turn-exact so this cannot leak onto other turns.
    expect(ordinaryTurnRecoverySilentTurnIds(state({
      logicalTurnId: SILENT, currentTurnId: 'schedule:abcdef12:22222222-2222-2222-2222-222222222222',
      continuationsStarted: 1, status: 'completed', silentLogicalTurnIds: [SILENT],
    }))).toEqual([SILENT, 'schedule:abcdef12:22222222-2222-2222-2222-222222222222']);
    expect(ordinaryTurnRecoverySilentTurnIds(state({ status: 'cancelled' }))).toEqual([]);
  });
});
