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

  it('waits for asynchronous scheduled-turn identity preparation before enqueue', async () => {
    const scheduled: Array<() => void> = [];
    const persisted: OrdinaryTurnRecoveryState[] = [];
    const enqueue = vi.fn(() => true);
    let release!: () => void;
    const prepare = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const coordinator = new OrdinaryTurnRecoveryCoordinator({
      schedule: (_delayMs, run) => { scheduled.push(run); return run; },
      cancel: vi.fn(),
      persist: value => { persisted.push(structuredClone(value)); },
      prepare,
      enqueue,
      warn: vi.fn(),
      now: () => 1_000,
      randomId: () => 'prepared',
      backoffMs: [2_000],
    });
    coordinator.onTerminal(state(), {
      turnId: 'om_original', status: 'failed', retryable: true,
      errorCode: 'provider_unexpected_eof',
    });
    scheduled[0]();
    expect(prepare).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
    expect(persisted.at(-1)?.status).toBe('dispatching');
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(persisted.at(-1)?.status).toBe('running');
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

describe('restricted capacity-recovery policy', () => {
  function attach(session: any, extras: any = {}) {
    const runs: Array<() => void> = [];
    const enqueue = vi.fn(() => true);
    const warn = vi.fn();
    attachOrdinaryTurnRecovery(session, {
      schedule: (_delay, run) => { runs.push(run); return run; }, cancel: vi.fn(),
      persist: vi.fn(), enqueue, warn, recoverableErrorCodes: ['codex_capacity_exceeded'],
      supersedeOnUserInput: true, backoffMs: [15_000, 45_000], now: () => 1_000, ...extras,
    });
    return { runs, enqueue, warn };
  }
  it('restores the persisted backoff once and never enqueues on a duplicate timer callback', () => {
    const session = { sessionId: 'capacity-restore', ordinaryTurnRecovery: state({ status: 'backoff', nextAttemptAt: 16_000 }) };
    const { runs, enqueue } = attach(session);
    runs[0](); runs[0]();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(session.ordinaryTurnRecovery).toMatchObject({ status: 'running', continuationsStarted: 1 });
    disposeOrdinaryTurnRecovery(session);
  });
  it('does not replay a handoff with an unknown execution outcome after restart', () => {
    const session = { sessionId: 'capacity-handoff', ordinaryTurnRecovery: state({ status: 'dispatching', currentTurnId: 'bmx-recovery-unknown', continuationsStarted: 1 }) };
    const { runs, enqueue, warn } = attach(session);
    expect(runs).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(session.ordinaryTurnRecovery).toMatchObject({ status: 'attention_required', lastErrorCode: 'recovery_dispatch_interrupted' });
    disposeOrdinaryTurnRecovery(session);
  });
  it('honours an explicit retry refusal even for a capacity code', () => {
    const session = { sessionId: 'capacity-refused', ordinaryTurnRecovery: state() };
    const { runs, enqueue, warn } = attach(session);
    handleOrdinaryTurnRecoveryTerminal(session, { turnId: 'om_original', status: 'failed', errorCode: 'codex_capacity_exceeded', retryable: false });
    expect(runs).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    disposeOrdinaryTurnRecovery(session);
  });
});

describe('async recovery persistence failures', () => {
  it.each(['after-enqueue', 'after-prepare-rejected'] as const)('reports %s without an unhandled rejection or replay', async phase => {
    let run!: () => void;
    const saved: OrdinaryTurnRecoveryState[] = [];
    const enqueue = vi.fn(() => true);
    const onError = vi.fn();
    const failure = new Error('disk full during asynchronous dispatch');
    const coordinator = new OrdinaryTurnRecoveryCoordinator({
      schedule: (_delay, next) => { run = next; return next; }, cancel: vi.fn(),
      persist: value => {
        if ((phase === 'after-enqueue' && value.status === 'running')
          || (phase === 'after-prepare-rejected' && value.status === 'attention_required')) throw failure;
        saved.push(structuredClone(value));
      },
      prepare: phase === 'after-enqueue' ? async () => {} : async () => { throw new Error('prepare failed'); },
      enqueue, onError, warn: vi.fn(), backoffMs: [0],
    });
    coordinator.onTerminal(state(), { turnId: 'om_original', status: 'failed', errorCode: 'provider_server_error', retryable: true });
    run();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(onError).toHaveBeenCalledOnce();
    expect(saved.at(-1)).toMatchObject({ status: 'dispatching', continuationsStarted: 1 });
    run();
    expect(enqueue).toHaveBeenCalledTimes(phase === 'after-enqueue' ? 1 : 0);
  });
});

describe('Codex cancellation fences', () => {
  function fixture(options: { prepare?: () => Promise<void>; persist?: (s: OrdinaryTurnRecoveryState) => void } = {}) {
    const session = { sessionId: `cancel-${Math.random()}` } as any;
    const timers: Array<{ run: () => void; cancelled: boolean }> = [];
    const enqueue = vi.fn(() => true);
    attachOrdinaryTurnRecovery(session, {
      schedule: (_ms, run) => { const timer = { run, cancelled: false }; timers.push(timer); return timer; },
      cancel: timer => { timer.cancelled = true; }, persist: options.persist ?? vi.fn(),
      prepare: options.prepare, enqueue, warn: vi.fn(),
      recoverableErrorCodes: ['codex_capacity_exceeded'], supersedeOnUserInput: true,
      backoffMs: [0, 0],
    });
    beginOrdinaryTurnRecovery(session, 'om_original');
    handleOrdinaryTurnRecoveryTerminal(session, { turnId: 'om_original', status: 'failed', errorCode: 'codex_capacity_exceeded' });
    return { session, timers, enqueue };
  }

  it('stops dispatching before asynchronous preparation can enqueue', async () => {
    let release!: () => void;
    const { session, timers, enqueue } = fixture({ prepare: () => new Promise<void>(r => { release = r; }) });
    timers.at(-1)!.run();
    expect(session.ordinaryTurnRecovery.status).toBe('dispatching');
    cancelOrdinaryTurnRecoveryForUserInput(session, 'stop');
    expect(session.ordinaryTurnRecovery.status).toBe('cancelled');
    release(); await Promise.resolve(); await Promise.resolve();
    expect(enqueue).not.toHaveBeenCalled();
    disposeOrdinaryTurnRecovery(session);
  });

  it('stops a running continuation and ignores its late capacity terminal', () => {
    const { session, timers, enqueue } = fixture();
    timers.at(-1)!.run();
    const turnId = session.ordinaryTurnRecovery.currentTurnId;
    expect(enqueue).toHaveBeenCalledOnce();
    cancelOrdinaryTurnRecoveryForUserInput(session, 'stop');
    handleOrdinaryTurnRecoveryTerminal(session, { turnId, status: 'failed', errorCode: 'codex_capacity_exceeded' });
    for (const timer of timers) if (!timer.cancelled) timer.run();
    expect(session.ordinaryTurnRecovery.status).toBe('cancelled');
    expect(enqueue).toHaveBeenCalledOnce();
    disposeOrdinaryTurnRecovery(session);
  });

  it('an admitted newer input retains a local fence when persistence fails', () => {
    const { session, timers, enqueue } = fixture({ persist: s => {
      if (s.logicalTurnId === 'om_new') throw new Error('disk full');
    } });
    expect(() => beginOrdinaryTurnRecovery(session, 'om_new')).toThrow('disk full');
    expect(session.ordinaryTurnRecovery).toMatchObject({ status: 'cancelled', logicalTurnId: 'om_new' });
    for (const timer of timers) if (!timer.cancelled) timer.run();
    expect(enqueue).not.toHaveBeenCalled();
    disposeOrdinaryTurnRecovery(session);
  });

  it('retains stop locally on save failure and does not rearm the old backoff', () => {
    const { session, timers, enqueue } = fixture({ persist: s => {
      if (s.status === 'cancelled') throw new Error('disk full');
    } });
    expect(() => cancelOrdinaryTurnRecoveryForUserInput(session, 'stop')).not.toThrow();
    expect(session.ordinaryTurnRecovery).toMatchObject({ status: 'cancelled', cancelledByTurnId: 'stop' });
    for (const timer of timers) if (!timer.cancelled) timer.run();
    expect(enqueue).not.toHaveBeenCalled();
    disposeOrdinaryTurnRecovery(session);
  });
});

it('does not restore a possibly cancelled Codex backoff after a process restart', () => {
  // The old process accepted stop/new input but could not persist it. Its
  // process-local fence is gone; the stored row alone cannot authorise replay.
  const session = { sessionId: 'cancelled-before-restart', ordinaryTurnRecovery: state({ status: 'backoff', nextAttemptAt: 0 }) };
  const schedule = vi.fn();
  const enqueue = vi.fn(() => true);
  const warn = vi.fn();
  attachOrdinaryTurnRecovery(session, {
    schedule, cancel: vi.fn(), persist: vi.fn(), enqueue, warn,
    recoverableErrorCodes: ['codex_capacity_exceeded'], supersedeOnUserInput: true,
    resumeRecoveryOnRestore: false,
  });
  expect(schedule).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledOnce();
  expect(session.ordinaryTurnRecovery).toMatchObject({ status: 'attention_required', lastErrorCode: 'recovery_restart_unverified' });
  disposeOrdinaryTurnRecovery(session);
});

it.each(['codex', 'claude'] as const)('%s: cancel-save failure followed by restart honours the CLI restore policy', cli => {
  let durable!: OrdinaryTurnRecoveryState;
  const original = { sessionId: `restart-after-cancel-${cli}` } as any;
  const policy = cli === 'codex'
    ? { recoverableErrorCodes: ['codex_capacity_exceeded'], supersedeOnUserInput: true, resumeRecoveryOnRestore: false }
    : {};
  attachOrdinaryTurnRecovery(original, {
    ...policy, schedule: (_ms, run) => run, cancel: vi.fn(),
    persist: s => { if (s.status === 'cancelled') throw new Error('disk full'); durable = structuredClone(s); },
    enqueue: vi.fn(() => true), warn: vi.fn(), backoffMs: [0],
  });
  beginOrdinaryTurnRecovery(original, 'om_original');
  handleOrdinaryTurnRecoveryTerminal(original, {
    turnId: 'om_original', status: 'failed', retryable: true,
    errorCode: cli === 'codex' ? 'codex_capacity_exceeded' : 'provider_server_error',
  });
  if (cli === 'codex') expect(() => cancelOrdinaryTurnRecoveryForUserInput(original, 'stop')).not.toThrow();
  else expect(() => cancelOrdinaryTurnRecoveryForUserInput(original, 'stop')).toThrow('disk full');
  expect(durable.status).toBe('backoff');
  disposeOrdinaryTurnRecovery(original);

  // A fresh process sees only the old durable row, not the local stop fence.
  const restored = { sessionId: original.sessionId, ordinaryTurnRecovery: structuredClone(durable) };
  const timers: Array<() => void> = [];
  const enqueue = vi.fn(() => true);
  const warn = vi.fn();
  attachOrdinaryTurnRecovery(restored, {
    ...policy, schedule: (_ms, run) => { timers.push(run); return run; },
    cancel: vi.fn(), persist: vi.fn(), enqueue, warn,
  });
  for (const run of timers) run();
  expect(enqueue).toHaveBeenCalledTimes(cli === 'codex' ? 0 : 1);
  expect(warn).toHaveBeenCalledTimes(cli === 'codex' ? 1 : 0);
  expect(restored.ordinaryTurnRecovery.status).toBe(cli === 'codex' ? 'attention_required' : 'running');
  disposeOrdinaryTurnRecovery(restored);
});


it.each(['stop', 'new-input'] as const)('Codex restored running after %s save failure cannot retry a late capacity terminal', action => {
  let durable!: OrdinaryTurnRecoveryState;
  let run!: () => void;
  let rejectUserSave = false;
  const original = { sessionId: `running-cancel-restart-${action}` } as any;
  const policy = { recoverableErrorCodes: ['codex_capacity_exceeded'], supersedeOnUserInput: true, resumeRecoveryOnRestore: false };
  attachOrdinaryTurnRecovery(original, {
    ...policy, schedule: (_ms, next) => { run = next; return next; }, cancel: vi.fn(),
    persist: s => { if (rejectUserSave) throw new Error('disk full'); durable = structuredClone(s); },
    enqueue: vi.fn(() => true), warn: vi.fn(), backoffMs: [0, 0],
  });
  beginOrdinaryTurnRecovery(original, 'om_original');
  handleOrdinaryTurnRecoveryTerminal(original, { turnId: 'om_original', status: 'failed', errorCode: 'codex_capacity_exceeded' });
  run();
  const oldTurn = durable.currentTurnId;
  expect(durable).toMatchObject({ status: 'running', continuationsStarted: 1 });
  rejectUserSave = true;
  if (action === 'stop') cancelOrdinaryTurnRecoveryForUserInput(original, 'stop');
  else expect(() => beginOrdinaryTurnRecovery(original, 'om_new')).toThrow('disk full');
  expect(original.ordinaryTurnRecovery.status).toBe('cancelled');
  disposeOrdinaryTurnRecovery(original);

  const restored = { sessionId: original.sessionId, ordinaryTurnRecovery: structuredClone(durable) };
  const timers: Array<() => void> = [];
  const enqueue = vi.fn(() => true);
  const warn = vi.fn();
  attachOrdinaryTurnRecovery(restored, {
    ...policy, schedule: (_ms, next) => { timers.push(next); return next; }, cancel: vi.fn(),
    persist: vi.fn(), enqueue, warn, backoffMs: [0, 0],
  });
  expect(restored.ordinaryTurnRecovery.status).toBe('running');
  handleOrdinaryTurnRecoveryTerminal(restored, { turnId: oldTurn, status: 'failed', errorCode: 'codex_capacity_exceeded' });
  for (const next of timers) next();
  expect(enqueue).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledOnce();
  expect(restored.ordinaryTurnRecovery).toMatchObject({ status: 'attention_required', lastErrorCode: 'recovery_restart_unverified' });
  disposeOrdinaryTurnRecovery(restored);
});

it.each(['codex', 'claude'] as const)('%s restored running still observes success, and fresh input may recover', cli => {
  const session = { sessionId: `restored-running-success-${cli}`, ordinaryTurnRecovery: state({ status: 'running', continuationsStarted: 1 }) };
  const timers: Array<() => void> = [];
  const enqueue = vi.fn(() => true);
  const warn = vi.fn();
  attachOrdinaryTurnRecovery(session, {
    ...(cli === 'codex' ? { recoverableErrorCodes: ['codex_capacity_exceeded'], supersedeOnUserInput: true, resumeRecoveryOnRestore: false } : {}),
    schedule: (_ms, next) => { timers.push(next); return next; }, cancel: vi.fn(), persist: vi.fn(), enqueue, warn,
  });
  handleOrdinaryTurnRecoveryTerminal(session, { turnId: 'om_original', status: 'completed' });
  expect(session.ordinaryTurnRecovery.status).toBe('completed');
  expect(warn).not.toHaveBeenCalled();
  beginOrdinaryTurnRecovery(session, 'om_fresh');
  handleOrdinaryTurnRecoveryTerminal(session, {
    turnId: 'om_fresh', status: 'failed', retryable: true,
    errorCode: cli === 'codex' ? 'codex_capacity_exceeded' : 'provider_server_error',
  });
  for (const next of timers) next();
  expect(enqueue).toHaveBeenCalledOnce();
  expect(session.ordinaryTurnRecovery.status).toBe('running');
  disposeOrdinaryTurnRecovery(session);
});

it('Claude restored running can still retry its late provider terminal', () => {
  const session = { sessionId: 'claude-running-restart', ordinaryTurnRecovery: state({ status: 'running', continuationsStarted: 1 }) };
  const timers: Array<() => void> = [];
  const enqueue = vi.fn(() => true);
  attachOrdinaryTurnRecovery(session, {
    schedule: (_ms, next) => { timers.push(next); return next; }, cancel: vi.fn(), persist: vi.fn(), enqueue, warn: vi.fn(),
  });
  handleOrdinaryTurnRecoveryTerminal(session, { turnId: 'om_original', status: 'failed', retryable: true, errorCode: 'provider_server_error' });
  for (const next of timers) next();
  expect(enqueue).toHaveBeenCalledOnce();
  expect(session.ordinaryTurnRecovery).toMatchObject({ status: 'running', continuationsStarted: 2 });
  disposeOrdinaryTurnRecovery(session);
});

it.each([
  { restricted: true, status: 'completed', turnId: 'om_original', code: 'codex_capacity_exceeded', owns: true },
  { restricted: true, status: 'completed', turnId: 'bmx-recovery-done', code: 'codex_capacity_exceeded', owns: false },
  { restricted: true, status: 'completed', turnId: 'om_original', code: 'codex_auth_failed', owns: false },
  { restricted: true, status: 'cancelled', turnId: 'om_original', code: 'codex_capacity_exceeded', owns: false },
  { restricted: false, status: 'completed', turnId: 'om_original', code: 'provider_server_error', owns: false },
] as const)('late predecessor notice policy: $restricted / $status / $turnId / $code', ({ restricted, status, turnId, code, owns }) => {
  const session = { sessionId: `predecessor-${restricted}-${status}-${turnId}-${code}`, ordinaryTurnRecovery: state({ status, currentTurnId: 'bmx-recovery-done', continuationsStarted: 1 }) };
  attachOrdinaryTurnRecovery(session, {
    ...(restricted ? { recoverableErrorCodes: ['codex_capacity_exceeded'] } : {}),
    schedule: vi.fn(), cancel: vi.fn(), persist: vi.fn(), enqueue: vi.fn(() => true), warn: vi.fn(),
  });
  expect(ordinaryTurnRecoveryHandlesTerminal(session, { turnId, status: 'failed', errorCode: code })).toBe(owns);
  disposeOrdinaryTurnRecovery(session);
});
