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
  TASK_CONTINUATION_CLI_EXIT_CODE,
  TASK_CONTINUATION_CONNECTION_CODE,
  TASK_CONTINUATION_ENGINE_DEAD_CODE,
  TASK_CONTINUATION_RATE_LIMIT_CODE,
  TASK_CONTINUATION_UPSTREAM_CODE,
  ReadonlyTaskContinuationCoordinator,
  startReadonlyTaskContinuation,
  type ReadonlyTaskContinuationSession,
  type ReadonlyTaskContinuationState,
} from '../src/services/readonly-task-continuation.js';

const TRUSTED_CALLER = {
  requestUserOpenId: 'ou_owner',
  requestUserUnionId: 'on_owner',
  requestLarkAppId: 'app_test',
  senderType: 'user' as const,
};

function state(overrides: Partial<ReadonlyTaskContinuationState> = {}): ReadonlyTaskContinuationState {
  return {
    leaseId: 'readonly-lease',
    logicalTurnId: 'om_original',
    currentTurnId: 'om_original',
    createdAt: 1_000,
    expiresAt: 61_000,
    maxContinuations: 2,
    continuationsStarted: 0,
    authorizationMode: 'inherited',
    startMode: 'explicit',
    trustedCaller: TRUSTED_CALLER,
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
      turnId: 'bmx-continuation-next',
      dispatchAttempt: 1,
      prompt: READONLY_TASK_CONTINUATION_PROMPT,
      continuation: 1,
    });
    expect(enqueue.mock.calls[0][0].prompt).not.toContain('original user prompt');
  });

  it('settles an automatically started original turn on normal completion', () => {
    const enqueue = vi.fn(() => 7);
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue,
      warn: vi.fn(),
      enabled: () => true,
      now: () => 2_000,
    });
    const automatic = state({ startMode: 'automatic' });
    coordinator.restore(automatic);

    expect(coordinator.onTerminal(automatic, {
      turnId: 'om_original',
      status: 'completed',
      workerGeneration: 1,
    })).toMatchObject({ status: 'completed', continuationsStarted: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not expire an automatic lease while its original turn is still running', () => {
    const timers: Array<{ delayMs: number; run: () => void }> = [];
    let now = 1_000;
    const warn = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (delayMs, run) => { timers.push({ delayMs, run }); return run; },
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => 1),
      warn,
      enabled: () => true,
      now: () => now,
    });

    const automatic = coordinator.start({
      turnId: 'om_original',
      workerGeneration: 1,
      authorizationMode: 'inherited',
      startMode: 'automatic',
      trustedCaller: TRUSTED_CALLER,
      ttlMs: 30_000,
    });

    expect(automatic).toMatchObject({ status: 'active', expiresAt: 31_000 });
    expect(timers).toHaveLength(0);
    now = 60_000;
    expect(warn).not.toHaveBeenCalled();
  });

  it('starts the automatic recovery TTL at the first allowlisted interruption', () => {
    const timers: Array<{ delayMs: number; run: () => void }> = [];
    let now = 1_000;
    const persist = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (delayMs, run) => { timers.push({ delayMs, run }); return run; },
      cancel: vi.fn(),
      persist,
      enqueue: vi.fn(() => 1),
      warn: vi.fn(),
      enabled: () => true,
      now: () => now,
      delayMs: 1_000,
    });
    const automatic = coordinator.start({
      turnId: 'om_original',
      workerGeneration: 1,
      authorizationMode: 'inherited',
      startMode: 'automatic',
      trustedCaller: TRUSTED_CALLER,
      ttlMs: 30_000,
    });

    now = 60_000;
    expect(coordinator.onTerminal(automatic, {
      turnId: 'om_original',
      status: 'failed',
      errorCode: TASK_CONTINUATION_RATE_LIMIT_CODE,
      workerGeneration: 1,
    })).toMatchObject({
      status: 'backoff',
      expiresAt: 90_000,
      continuationsStarted: 0,
    });
    expect(timers.at(-1)?.delayMs).toBe(15_000);
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'backoff',
      expiresAt: 90_000,
    }));
  });

  it('still expires an automatic lease after its recovery window starts', () => {
    const timers: Array<{ delayMs: number; run: () => void }> = [];
    let now = 1_000;
    const warn = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (delayMs, run) => { timers.push({ delayMs, run }); return run; },
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => 1),
      warn,
      enabled: () => true,
      now: () => now,
      delayMs: 1_000,
    });
    const automatic = coordinator.start({
      turnId: 'om_original',
      workerGeneration: 1,
      authorizationMode: 'inherited',
      startMode: 'automatic',
      trustedCaller: TRUSTED_CALLER,
      ttlMs: 5_000,
    });

    now = 60_000;
    coordinator.onTerminal(automatic, {
      turnId: 'om_original',
      status: 'failed',
      errorCode: TASK_CONTINUATION_CONNECTION_CODE,
      workerGeneration: 1,
    });
    now = 65_000;
    timers.at(-1)!.run();

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      status: 'expired',
      lastErrorCode: 'readonly_continuation_expired',
    }));
  });

  it('settles a persisted lease without a start mode fail-closed on normal completion', () => {
    const enqueue = vi.fn(() => 7);
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue,
      warn: vi.fn(),
      enabled: () => true,
      now: () => 2_000,
    });
    const persisted = state({ startMode: undefined });
    coordinator.restore(persisted);

    expect(coordinator.onTerminal(persisted, {
      turnId: 'om_original',
      status: 'completed',
      workerGeneration: 1,
    })).toMatchObject({ status: 'completed', continuationsStarted: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('keeps a persisted completed synthetic turn resumable without a start mode', () => {
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
    });
    const synthetic = state({
      startMode: undefined,
      currentTurnId: 'bmx-continuation-one',
      currentDispatchAttempt: 1,
      continuationsStarted: 1,
    });
    coordinator.restore(synthetic);

    expect(coordinator.onTerminal(synthetic, {
      turnId: 'bmx-continuation-one',
      dispatchAttempt: 1,
      status: 'completed',
      workerGeneration: 1,
    })).toMatchObject({ status: 'backoff', continuationsStarted: 1 });
    expect(timers.length).toBeGreaterThan(1);
  });

  it('promotes the matching automatic lease when the user explicitly starts continuation', () => {
    const timers: Array<{ delayMs: number; run: () => void }> = [];
    const persist = vi.fn();
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (delayMs, run) => { timers.push({ delayMs, run }); return run; },
      cancel: vi.fn(),
      persist,
      enqueue: vi.fn(() => 7),
      warn: vi.fn(),
      enabled: () => true,
      now: () => 2_000,
    });
    coordinator.restore(state({ startMode: undefined }));

    expect(coordinator.start({
      turnId: 'om_original',
      workerGeneration: 1,
      authorizationMode: 'inherited',
      startMode: 'explicit',
      trustedCaller: TRUSTED_CALLER,
      ttlMs: 120_000,
      maxContinuations: 4,
    })).toMatchObject({
      startMode: 'explicit',
      expiresAt: 122_000,
      maxContinuations: 4,
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(timers.at(-1)?.delayMs).toBe(120_000);

    const backoff = state({
      startMode: 'automatic',
      status: 'backoff',
      nextAttemptAt: 7_000,
      lastErrorCode: TASK_CONTINUATION_RATE_LIMIT_CODE,
    });
    coordinator.restore(backoff);
    expect(coordinator.start({
      turnId: 'om_original',
      workerGeneration: 1,
      authorizationMode: 'inherited',
      startMode: 'explicit',
      trustedCaller: TRUSTED_CALLER,
    })).toMatchObject({ startMode: 'explicit', lastErrorCode: undefined });
    expect(timers.at(-1)?.delayMs).toBe(5_000);
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
      errorCode: 'business_failure',
      workerGeneration: 1,
    }).status).toBe('failed');
    expect(timers).toHaveLength(3);
  });

  it.each([
    READONLY_TASK_CONTINUATION_OUTPUT_LIMIT_CODE,
    TASK_CONTINUATION_RATE_LIMIT_CODE,
    TASK_CONTINUATION_CONNECTION_CODE,
    TASK_CONTINUATION_UPSTREAM_CODE,
  ])('continues the allowlisted transient failure %s', errorCode => {
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => 1),
      warn: vi.fn(),
      enabled: () => true,
      now: () => 2_000,
    });
    coordinator.restore(state());

    expect(coordinator.onTerminal(state(), {
      turnId: 'om_original', status: 'failed', errorCode, workerGeneration: 1,
    }).status).toBe('backoff');
  });

  it.each([TASK_CONTINUATION_ENGINE_DEAD_CODE, TASK_CONTINUATION_CLI_EXIT_CODE])(
    'awaits user for the ambiguous runtime interruption %s',
    errorCode => {
      const schedule = vi.fn((_delayMs, run) => run);
      const enqueue = vi.fn(() => 1);
      const warn = vi.fn();
      const coordinator = new ReadonlyTaskContinuationCoordinator({
        schedule,
        cancel: vi.fn(),
        persist: vi.fn(),
        enqueue,
        warn,
        enabled: () => true,
        now: () => 2_000,
      });
      coordinator.restore(state());
      schedule.mockClear();

      expect(coordinator.onTerminal(state(), {
        turnId: 'om_original', status: 'ambiguous', errorCode, workerGeneration: 1,
      })).toMatchObject({ status: 'awaiting_user', lastErrorCode: errorCode });
      expect(schedule).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({
        status: 'awaiting_user',
        lastErrorCode: errorCode,
      }));
    },
  );

  it.each([TASK_CONTINUATION_ENGINE_DEAD_CODE, TASK_CONTINUATION_CLI_EXIT_CODE])(
    'migrates the persisted ambiguous backoff %s to awaiting user without replay',
    errorCode => {
      const schedule = vi.fn((_delayMs, run) => run);
      const enqueue = vi.fn(() => 1);
      const persist = vi.fn();
      const warn = vi.fn();
      const coordinator = new ReadonlyTaskContinuationCoordinator({
        schedule,
        cancel: vi.fn(),
        persist,
        enqueue,
        warn,
        enabled: () => true,
        now: () => 2_000,
      });

      coordinator.restore(state({
        status: 'backoff',
        nextAttemptAt: 3_000,
        lastErrorCode: errorCode,
      }));

      expect(schedule).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(persist).toHaveBeenCalledOnce();
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({
        status: 'awaiting_user',
        nextAttemptAt: undefined,
        lastErrorCode: errorCode,
        pendingWarning: expect.objectContaining({ deliveryAttempts: 0 }),
      }));
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({
        status: 'awaiting_user',
        lastErrorCode: errorCode,
      }));
    },
  );

  it.each([
    READONLY_TASK_CONTINUATION_OUTPUT_LIMIT_CODE,
    TASK_CONTINUATION_RATE_LIMIT_CODE,
    TASK_CONTINUATION_CONNECTION_CODE,
    TASK_CONTINUATION_UPSTREAM_CODE,
  ])('restores the allowlisted persisted backoff %s', errorCode => {
    const timers: Array<() => void> = [];
    const enqueue = vi.fn(() => 2);
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => { timers.push(run); return run; },
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue,
      warn: vi.fn(),
      enabled: () => true,
      now: () => 2_000,
      randomId: () => 'restored',
    });

    coordinator.restore(state({
      status: 'backoff',
      nextAttemptAt: 3_000,
      lastErrorCode: errorCode,
    }));
    timers.at(-1)!();

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'bmx-continuation-restored',
      continuation: 1,
    }));
  });

  it('fails closed for an ambiguous interrupted turn with unknown side effects', () => {
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => 1),
      warn: vi.fn(),
      enabled: () => true,
      now: () => 2_000,
    });
    coordinator.restore(state());

    expect(coordinator.onTerminal(state(), {
      turnId: 'om_original', status: 'ambiguous', errorCode: 'rpc_turn_aborted', workerGeneration: 1,
    })).toMatchObject({ status: 'failed', lastErrorCode: 'rpc_turn_aborted' });
  });

  it.each([
    [TASK_CONTINUATION_CONNECTION_CODE, 5_000],
    [TASK_CONTINUATION_UPSTREAM_CODE, 5_000],
    [TASK_CONTINUATION_RATE_LIMIT_CODE, 15_000],
  ] as const)('uses bounded backoff for %s', (errorCode, expectedDelayMs) => {
    const delays: number[] = [];
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (delayMs, run) => { delays.push(delayMs); return run; },
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => 1),
      warn: vi.fn(),
      enabled: () => true,
      now: () => 2_000,
      delayMs: 1_000,
    });
    coordinator.restore(state());
    coordinator.onTerminal(state(), {
      turnId: 'om_original',
      status: 'failed',
      errorCode,
      workerGeneration: 1,
    });

    expect(delays.at(-1)).toBe(expectedDelayMs);
  });

  it('fails visibly instead of widening a pre-upgrade live lease on restore', () => {
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

    coordinator.restore(state({ authorizationMode: undefined }));

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      lastErrorCode: 'continuation_legacy_lease_not_resumed',
    }));
  });

  it('requires a persisted authenticated caller for a new inherited-authority lease', () => {
    const coordinator = new ReadonlyTaskContinuationCoordinator({
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => 1),
      warn: vi.fn(),
      enabled: () => true,
      now: () => 2_000,
    });

    expect(() => coordinator.start({
      turnId: 'om_original',
      workerGeneration: 1,
      authorizationMode: 'inherited',
      trustedCaller: {} as any,
    })).toThrow('continuation_authority_required');
  });

  it('fails visibly when a restored inherited-authority lease lacks its caller', () => {
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

    coordinator.restore(state({ trustedCaller: undefined }));

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      lastErrorCode: 'continuation_authority_not_resumable',
    }));
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

    expect(() => coordinator.start({
      turnId: 'om_original',
      workerGeneration: 1,
      authorizationMode: 'inherited',
      trustedCaller: TRUSTED_CALLER,
    }))
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

    expect(coordinator.start({
      turnId: 'om_original',
      workerGeneration: 1,
      authorizationMode: 'inherited',
      trustedCaller: TRUSTED_CALLER,
      ttlMs: 5_000,
    }).status).toBe('active');
    expect(timers).toHaveLength(1);
    now = 6_000;
    timers.at(-1)!();
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'expired',
      lastErrorCode: 'readonly_continuation_expired',
    }));
    expect(warn).toHaveBeenCalledOnce();
  });

  it('marks a daemon-restored active turn awaiting user instead of delaying until TTL expiry', () => {
    const warn = vi.fn();
    const persist = vi.fn();
    const session: ReadonlyTaskContinuationSession = {
      sessionId: 'session',
      readonlyTaskContinuation: state({
        startMode: 'automatic',
        expiresAt: 61_000,
      }),
    };

    attachReadonlyTaskContinuation(session, {
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist,
      enqueue: vi.fn(() => 1),
      warn,
      enabled: () => true,
      now: () => 2_000,
    }, { activeTurnInterrupted: true });

    expect(session.readonlyTaskContinuation).toMatchObject({
      status: 'awaiting_user',
      lastErrorCode: 'daemon_restart',
      pendingWarning: { startedAt: 2_000, deliveryAttempts: 0 },
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      status: 'awaiting_user',
      lastErrorCode: 'daemon_restart',
    }));
  });

  it('marks a daemon-restored synthetic turn awaiting user without replaying it', () => {
    const warn = vi.fn();
    const enqueue = vi.fn(() => 1);
    const session: ReadonlyTaskContinuationSession = {
      sessionId: 'session',
      readonlyTaskContinuation: state({
        startMode: 'automatic',
        currentTurnId: 'bmx-continuation-before-restart',
        currentDispatchAttempt: 1,
        continuationsStarted: 1,
      }),
    };

    attachReadonlyTaskContinuation(session, {
      schedule: (_delayMs, run) => run,
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue,
      warn,
      enabled: () => true,
      now: () => 2_000,
    }, { activeTurnInterrupted: true });

    expect(session.readonlyTaskContinuation).toMatchObject({
      status: 'awaiting_user',
      currentTurnId: 'bmx-continuation-before-restart',
      continuationsStarted: 1,
      lastErrorCode: 'daemon_restart',
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps an explicit active lease unchanged across daemon restore', () => {
    const warn = vi.fn();
    const timers: Array<() => void> = [];
    const explicit = state({ startMode: 'explicit' });
    const session: ReadonlyTaskContinuationSession = {
      sessionId: 'session',
      readonlyTaskContinuation: explicit,
    };

    attachReadonlyTaskContinuation(session, {
      schedule: (_delayMs, run) => { timers.push(run); return run; },
      cancel: vi.fn(),
      persist: vi.fn(),
      enqueue: vi.fn(() => 1),
      warn,
      enabled: () => true,
      now: () => 2_000,
    }, { activeTurnInterrupted: true });

    expect(session.readonlyTaskContinuation).toEqual(explicit);
    expect(timers).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
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

describe('attached task continuation', () => {
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

    expect(startReadonlyTaskContinuation(session, {
      turnId: 'om_original', workerGeneration: 1, authorizationMode: 'inherited',
      trustedCaller: TRUSTED_CALLER,
    }))
      .toMatchObject({ leaseId: 'readonly-lease', status: 'active' });
    expect(handleReadonlyTaskContinuationTerminal(session, {
      turnId: 'om_original', status: 'completed', workerGeneration: 1,
    })?.status).toBe('backoff');
    timers.at(-1)!();
    expect(session.turnReplyContexts?.['bmx-continuation-next']).toEqual({ inThread: true });
    expect(session.replyTargets?.['bmx-continuation-next']).toEqual({ rootMessageId: 'om_root' });
    expect(enqueue).toHaveBeenCalledOnce();

    expect(awaitReadonlyTaskContinuationUser(session, 'bmx-continuation-next'))
      .toMatchObject({ status: 'awaiting_user' });

    startReadonlyTaskContinuation(session, {
      turnId: 'om_new', workerGeneration: 1, authorizationMode: 'inherited',
      trustedCaller: TRUSTED_CALLER,
    });
    expect(cancelReadonlyTaskContinuationForUserInput(session, 'om_interrupt'))
      .toMatchObject({ status: 'cancelled', cancelledByTurnId: 'om_interrupt' });

    startReadonlyTaskContinuation(session, {
      turnId: 'om_final', workerGeneration: 1, authorizationMode: 'inherited',
      trustedCaller: TRUSTED_CALLER,
    });
    expect(completeReadonlyTaskContinuation(session, 'om_final', undefined, 'om_reply', 1))
      .toMatchObject({ status: 'completed', completedMessageId: 'om_reply' });
  });
});
