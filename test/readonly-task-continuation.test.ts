import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachReadonlyTaskContinuation,
  awaitReadonlyTaskContinuationUser,
  cancelReadonlyTaskContinuationForUserInput,
  completeReadonlyTaskContinuation,
  disposeReadonlyTaskContinuation,
  handleReadonlyTaskContinuationTerminal,
  READONLY_TASK_CONTINUATION_OUTPUT_LIMIT_CODE,
  READONLY_TASK_CONTINUATION_PROMPT,
  ReadonlyTaskContinuationCoordinator,
  startReadonlyTaskContinuation,
  type ReadonlyTaskContinuationSession,
  type ReadonlyTaskContinuationState,
} from '../src/services/readonly-task-continuation.js';

function state(overrides: Partial<ReadonlyTaskContinuationState> = {}): ReadonlyTaskContinuationState {
  return {
    leaseId: 'readonly-lease',
    logicalTurnId: 'om_original',
    currentTurnId: 'om_original',
    createdAt: 1_000,
    expiresAt: 61_000,
    maxContinuations: 2,
    continuationsStarted: 0,
    currentWorkerGeneration: 1,
    status: 'active',
    ...overrides,
  };
}

afterEach(() => {
  disposeReadonlyTaskContinuation({ sessionId: 'session' });
});

describe('ReadonlyTaskContinuationCoordinator', () => {
  it('continues a completed turn without replaying the original prompt', () => {
    const timers: Array<() => void> = [];
    const enqueue = vi.fn(() => 7);
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => { timers.push(run); return run; },
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue,
      warn: vi.fn(),
      enabled: () => true,
      now: () => 2_000,
      randomId: () => 'next',
      delayMs: 1_000,
    });
    coordinator.restore(state());

    expect(coordinator.onTerminal(state(), {
      turnId: 'om_original',
      status: 'completed',
      workerGeneration: 1,
    }).status).toBe('backoff');
    timers.at(-1)!();
    expect((coordinator as any).state).toMatchObject({ currentWorkerGeneration: 7 });

    expect(enqueue).toHaveBeenCalledWith({
      logicalTurnId: 'om_original',
      turnId: 'bmx-readonly-next',
      dispatchAttempt: 1,
      prompt: READONLY_TASK_CONTINUATION_PROMPT,
      continuation: 1,
    });
    expect(enqueue.mock.calls[0][0].prompt).not.toContain('original user prompt');
  });

  it('continues only the exact allowlisted failed terminal', () => {
    const timers: Array<() => void> = [];
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => { timers.push(run); return run; },
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => 1),
      warn: vi.fn(),
      enabled: () => true,
      now: () => 2_000,
      now: () => 2_000,
    });
    coordinator.restore(state());

    expect(coordinator.onTerminal(state(), {
      turnId: 'om_original',
      status: 'failed',
      errorCode: READONLY_TASK_CONTINUATION_OUTPUT_LIMIT_CODE,
      workerGeneration: 1,
    }).status).toBe('backoff');
    expect(timers).toHaveLength(2);

    const ordinaryFailure = state({ leaseId: 'other' });
    coordinator.restore(ordinaryFailure);
    expect(coordinator.onTerminal(ordinaryFailure, {
      turnId: 'om_original',
      status: 'failed',
      errorCode: 'codex_connection_failed',
      workerGeneration: 1,
    }).status).toBe('failed');
    expect(timers).toHaveLength(3);
  });

  it('waits for worker/RPC readiness without consuming a continuation attempt', () => {
    const timers: Array<() => void> = [];
    let ready = false;
    const enqueue = vi.fn(() => 9);
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => { timers.push(run); return run; },
      cancel: vi.fn(),
      persist: vi.fn(),
      canEnqueue: () => ready,
      enqueue,
      warn: vi.fn(),
      enabled: () => true,
      now: () => 2_000,
      randomId: () => 'next',
      delayMs: 1_000,
    });
    coordinator.restore(state());
    coordinator.onTerminal(state(), {
      turnId: 'om_original', status: 'completed', workerGeneration: 1,
    });

    timers.at(-1)!();
    expect(enqueue).not.toHaveBeenCalled();
    expect((coordinator as any).state).toMatchObject({
      status: 'backoff', continuationsStarted: 0, nextAttemptAt: 3_000,
    });

    ready = true;
    timers.at(-1)!();
    expect(enqueue).toHaveBeenCalledOnce();
    expect((coordinator as any).state).toMatchObject({
      status: 'active', continuationsStarted: 1, currentWorkerGeneration: 9,
    });
  });

  it.each([
    ['new user input', (coordinator: ReadonlyTaskContinuationCoordinator) =>
      coordinator.cancelForUserInput('om_new'), 'readonly_continuation_user_cancel_persist_failed'],
    ['explicit cancel', (coordinator: ReadonlyTaskContinuationCoordinator) =>
      coordinator.cancelExplicit('om_original'), 'readonly_continuation_explicit_cancel_persist_failed'],
  ] as const)('retains a failed fence when %s cannot persist', (_label, cancel, errorCode) => {
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(() => { throw new Error('store unavailable'); }),
      enqueue: vi.fn(() => 1),
      warn: vi.fn(),
      enabled: () => true,
      now: () => 2_000,
    });
    coordinator.restore(state());

    expect(() => cancel(coordinator)).toThrow('store unavailable');
    expect((coordinator as any).state).toMatchObject({
      status: 'failed', lastErrorCode: errorCode,
    });
  });

  it('settles only on an explicit final proof for the current turn', () => {
    const persist = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist,
      enqueue: vi.fn(() => 1),
      warn: vi.fn(),
      enabled: () => true,
      now: () => 2_000,
    });
    coordinator.restore(state());

    expect(coordinator.complete('stale-turn', undefined, 'om_reply', 1)).toEqual(state());
    expect(coordinator.complete('om_original', 1, 'om_wrong_attempt', 1)).toEqual(state());
    expect(coordinator.complete('om_original', undefined, 'om_reply', 1)).toMatchObject({
      status: 'completed',
      completedMessageId: 'om_reply',
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('stops for user input or an explicit await-user handoff', () => {
    const cancel = vi.fn();
    const persist = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel,
      persist,
      enqueue: vi.fn(() => 1),
      warn: vi.fn(),
      enabled: () => true,
      now: () => 2_000,
    });
    coordinator.restore(state({ status: 'backoff', nextAttemptAt: 12_000 }));
    expect(coordinator.cancelForUserInput('om_new')).toMatchObject({
      status: 'cancelled',
      cancelledByTurnId: 'om_new',
    });

    coordinator.restore(state());
    expect(coordinator.awaitUser('om_original')).toMatchObject({ status: 'awaiting_user' });
    expect(coordinator.cancelForUserInput('om_answer')).toMatchObject({
      status: 'cancelled',
      cancelledByTurnId: 'om_answer',
    });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(3);
  });

  it('allows explicit cancellation while awaiting user input', () => {
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => 1),
      warn: vi.fn(),
      enabled: () => true,
    });
    coordinator.restore(state({ status: 'awaiting_user' }));

    expect(coordinator.cancelExplicit('om_original')).toMatchObject({
      status: 'cancelled',
      cancelledByTurnId: 'om_original',
    });
  });

  it('expires and exhausts with one warning instead of dispatching forever', () => {
    const warn = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => 1),
      warn,
      enabled: () => true,
      now: () => 61_000,
    });
    coordinator.restore(state());
    expect(coordinator.onTerminal(state(), {
      turnId: 'om_original', status: 'completed', workerGeneration: 1,
    }).status).toBe('expired');
    expect(warn).toHaveBeenCalledTimes(1);

    const exhausted = state({ expiresAt: 120_000, continuationsStarted: 2 });
    coordinator.restore(exhausted);
    expect(coordinator.onTerminal(exhausted, {
      turnId: 'om_original', status: 'completed', workerGeneration: 1,
    }).status).toBe('exhausted');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the kill switch is off', () => {
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => 1),
      warn: vi.fn(),
      enabled: () => false,
    });

    expect(() => coordinator.start({ turnId: 'om_original', workerGeneration: 1 }))
      .toThrow('readonly_continuation_disabled');
    coordinator.restore(state({ status: 'backoff', nextAttemptAt: Date.now() + 10_000 }));
    expect(coordinator.onTerminal(state(), {
      turnId: 'om_original', status: 'completed', workerGeneration: 1,
    }).status).toBe('cancelled');
  });

  it('expires an active lease even when the CLI never emits another terminal', () => {
    const timers: Array<() => void> = [];
    let now = 1_000;
    const warn = vi.fn();
    const persist = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => { timers.push(run); return run; },
      cancel: vi.fn(),
      persist,
      enqueue: vi.fn(() => 1),
      warn,
      enabled: () => true,
      now: () => now,
      randomId: () => 'lease',
    });

    expect(coordinator.start({ turnId: 'om_original', workerGeneration: 1, ttlMs: 5_000 }).status).toBe('active');
    expect(timers).toHaveLength(1);
    now = 6_000;
    timers.at(-1)!();
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'expired',
      lastErrorCode: 'readonly_continuation_expired',
    }));
    expect(warn).toHaveBeenCalledOnce();
  });

  it('fails closed without crashing when activation persistence fails after enqueue', () => {
    const timers: Array<() => void> = [];
    let persistCalls = 0;
    const warn = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => { timers.push(run); return run; },
      cancel: vi.fn(),
      persist: vi.fn(() => {
        persistCalls++;
        if (persistCalls === 3) throw new Error('store unavailable');
      }),
      enqueue: vi.fn(() => 1),
      warn,
      enabled: () => true,
      now: () => 2_000,
      randomId: () => 'next',
    });
    coordinator.restore(state());
    coordinator.onTerminal(state(), { turnId: 'om_original', status: 'completed', workerGeneration: 1 });

    expect(() => timers.at(-1)!()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      lastErrorCode: 'readonly_continuation_activation_persist_failed',
    }));
    expect((coordinator as any).state).toMatchObject({
      status: 'failed',
      lastErrorCode: 'readonly_continuation_activation_persist_failed',
      pendingWarning: { startedAt: 2_000, deliveryAttempts: 0 },
    });
  });

  it('never enqueues when the dispatching fence cannot be persisted', () => {
    const timers: Array<() => void> = [];
    let persistCalls = 0;
    const enqueue = vi.fn(() => 1);
    const warn = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => { timers.push(run); return run; },
      cancel: vi.fn(),
      persist: vi.fn(() => {
        persistCalls++;
        if (persistCalls === 2) throw new Error('store unavailable');
      }),
      enqueue,
      warn,
      enabled: () => true,
      now: () => 2_000,
      randomId: () => 'next',
    });
    coordinator.restore(state());
    coordinator.onTerminal(state(), { turnId: 'om_original', status: 'completed', workerGeneration: 1 });

    expect(() => timers.at(-1)!()).not.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
    expect((coordinator as any).state).toMatchObject({
      status: 'failed',
      lastErrorCode: 'readonly_continuation_dispatch_persist_failed',
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('recovers only a recent persisted daemon-owned delivery', () => {
    const recoverDelivery = vi.fn();
    const warn = vi.fn();
    const persist = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist,
      enqueue: vi.fn(() => 1),
      warn,
      recoverDelivery,
      enabled: () => true,
      now: () => 2_000,
    });
    const delivering = state({
      status: 'delivering',
      pendingDelivery: { kind: 'completed', content: 'done', startedAt: 1_500 },
    });

    coordinator.restore(delivering);

    expect(recoverDelivery).toHaveBeenCalledWith(delivering);
    expect(warn).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('fails visibly instead of replaying a stale or legacy delivery', () => {
    const warn = vi.fn();
    const persist = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist,
      enqueue: vi.fn(() => 1),
      warn,
      recoverDelivery: vi.fn(),
      enabled: () => true,
      now: () => 60 * 60_000,
    });

    coordinator.restore(state({
      status: 'delivering',
      pendingDelivery: { kind: 'completed', content: 'done', startedAt: 1_000 },
    }));

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      lastErrorCode: 'readonly_continuation_delivery_recovery_unavailable',
    }));
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('replays a recent persisted warning until delivery is acknowledged', () => {
    const warn = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => 1),
      warn,
      enabled: () => true,
      now: () => 2_000,
    });
    const pending = state({
      status: 'failed',
      lastErrorCode: 'readonly_continuation_enqueue_failed',
      pendingWarning: { startedAt: 1_500, deliveryAttempts: 0 },
    });

    coordinator.restore(pending);

    expect(warn).toHaveBeenCalledWith(pending);
    expect((coordinator as any).state.warningDispatched).toBeUndefined();
    expect(coordinator.completeWarning(pending.leaseId, 'om_warning')).toMatchObject({
      warningDispatched: true,
      warningMessageId: 'om_warning',
      pendingWarning: undefined,
    });
  });

  it('does not publish a warning whose outbox state failed to persist', () => {
    const warn = vi.fn();
    const attend = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(() => { throw new Error('store unavailable'); }),
      enqueue: vi.fn(() => 1),
      warn,
      attend,
      enabled: () => true,
      now: () => 2_000,
    });
    coordinator.restore(state());

    coordinator.failVisible('om_original', undefined, 1, 'terminal_failure');

    expect((coordinator as any).state).toMatchObject({
      status: 'failed',
      lastErrorCode: 'terminal_failure',
      pendingWarning: expect.any(Object),
    });
    expect(attend).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps retrying a pending warning until its delivery window expires', () => {
    const timers: Array<() => void> = [];
    let now = 2_000;
    const warn = vi.fn();
    const persist = vi.fn();
    const attend = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => { timers.push(run); return run; },
      cancel: vi.fn(),
      persist,
      enqueue: vi.fn(() => 1),
      warn,
      attend,
      enabled: () => true,
      now: () => now,
    });
    const pending = state({
      status: 'failed',
      pendingWarning: { startedAt: 1_500, deliveryAttempts: 0 },
    });
    coordinator.restore(pending);
    expect(attend).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();

    coordinator.warningDeliveryFailed(pending.leaseId);
    expect((coordinator as any).state.pendingWarning).toMatchObject({
      deliveryAttempts: 1,
      nextAttemptAt: 62_000,
    });
    now = 62_000;
    timers.at(-1)!();
    expect(warn).toHaveBeenCalledTimes(2);

    now = 1_500 + 55 * 60_000;
    coordinator.warningDeliveryFailed(pending.leaseId);
    expect((coordinator as any).state).toMatchObject({
      lastErrorCode: 'readonly_continuation_warning_delivery_expired',
      pendingWarning: undefined,
    });
  });
});

describe('attached read-only continuation', () => {
  it('persists the lease, copies routing context, and exposes explicit terminal controls', () => {
    const session: ReadonlyTaskContinuationSession = {
      sessionId: 'session',
      turnReplyContexts: { om_original: { inThread: true } },
      replyTargets: { om_original: { rootMessageId: 'om_root' } },
    };
    const timers: Array<() => void> = [];
    const enqueue = vi.fn(() => 1);
    attachReadonlyTaskContinuation(session, {
      schedule: (_delayMs, run) => { timers.push(run); return run; },
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue,
      warn: vi.fn(),
      enabled: () => true,
      now: () => 1_000,
      randomId: vi.fn().mockReturnValueOnce('lease').mockReturnValueOnce('next'),
    });

    expect(startReadonlyTaskContinuation(session, { turnId: 'om_original', workerGeneration: 1 }))
      .toMatchObject({ leaseId: 'readonly-lease', status: 'active' });
    expect(handleReadonlyTaskContinuationTerminal(session, {
      turnId: 'om_original', status: 'completed', workerGeneration: 1,
    })?.status).toBe('backoff');
    timers.at(-1)!();
    expect(session.turnReplyContexts?.['bmx-readonly-next']).toEqual({ inThread: true });
    expect(session.replyTargets?.['bmx-readonly-next']).toEqual({ rootMessageId: 'om_root' });
    expect(enqueue).toHaveBeenCalledOnce();

    expect(awaitReadonlyTaskContinuationUser(session, 'bmx-readonly-next'))
      .toMatchObject({ status: 'awaiting_user' });

    startReadonlyTaskContinuation(session, { turnId: 'om_new', workerGeneration: 1 });
    expect(cancelReadonlyTaskContinuationForUserInput(session, 'om_interrupt'))
      .toMatchObject({ status: 'cancelled', cancelledByTurnId: 'om_interrupt' });

    startReadonlyTaskContinuation(session, { turnId: 'om_final', workerGeneration: 1 });
    expect(completeReadonlyTaskContinuation(session, 'om_final', undefined, 'om_reply', 1))
      .toMatchObject({ status: 'completed', completedMessageId: 'om_reply' });
  });
});
