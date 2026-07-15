import { describe, expect, it, vi } from 'vitest';
import type { WorkerToDaemon } from '../src/types.js';
import {
  VcMeetingTerminalReconciler,
  deriveVcMeetingTerminalReconcileKey,
  isRetryableVcMeetingTerminalSettleReason,
  type VcMeetingTerminalRetryScheduler,
  type VcMeetingTerminalRetryTimer,
} from '../src/services/vc-meeting-terminal-reconciler.js';

type Terminal = Extract<WorkerToDaemon, { type: 'turn_terminal' }>;

function terminal(overrides: Partial<Terminal> = {}): Terminal {
  return {
    type: 'turn_terminal',
    sessionId: 'session_1',
    turnId: 'delivery_1',
    dispatchAttempt: 1,
    status: 'completed',
    ...overrides,
  };
}

interface FakeTimer extends VcMeetingTerminalRetryTimer {
  id: number;
  unref: ReturnType<typeof vi.fn>;
}

class FakeScheduler implements VcMeetingTerminalRetryScheduler {
  private nextId = 1;
  readonly tasks = new Map<number, { callback: () => void; delayMs: number; timer: FakeTimer }>();
  readonly scheduledDelays: number[] = [];
  readonly cleared: number[] = [];

  setTimeout(callback: () => void, delayMs: number): FakeTimer {
    const timer: FakeTimer = { id: this.nextId++, unref: vi.fn() };
    this.tasks.set(timer.id, { callback, delayMs, timer });
    this.scheduledDelays.push(delayMs);
    return timer;
  }

  clearTimeout(timer: VcMeetingTerminalRetryTimer): void {
    const id = (timer as FakeTimer).id;
    this.cleared.push(id);
    this.tasks.delete(id);
  }

  runNext(): FakeTimer {
    const task = this.tasks.values().next().value as {
      callback: () => void;
      delayMs: number;
      timer: FakeTimer;
    } | undefined;
    if (!task) throw new Error('no scheduled timer');
    this.tasks.delete(task.timer.id);
    task.callback();
    return task.timer;
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('VcMeetingTerminalReconciler', () => {
  it('settles immediately and deduplicates both pending and recently finalized keys', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const settle = vi.fn(async () => {
      await gate;
      return { handled: true };
    });
    const reconciler = new VcMeetingTerminalReconciler({ settle });
    const message = terminal();

    expect(reconciler.enqueue(message, { workerGeneration: 4 }).accepted).toBe(true);
    expect(reconciler.enqueue(message, { workerGeneration: 4 })).toMatchObject({
      accepted: false,
      reason: 'duplicate',
    });
    expect(reconciler.pendingCount).toBe(1);

    release();
    await flushPromises();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(reconciler.pendingCount).toBe(0);
    expect(reconciler.enqueue(message, { workerGeneration: 4 })).toMatchObject({
      accepted: false,
      reason: 'duplicate',
    });
  });

  it('retries thrown and retryable false results with bounded exponential backoff', async () => {
    const scheduler = new FakeScheduler();
    const finalized = vi.fn();
    let call = 0;
    const settle = vi.fn(() => {
      call += 1;
      if (call === 1) throw new Error('temporary lock failure');
      if (call === 2) return { handled: false, reason: 'receipt_lost' };
      return { handled: true };
    });
    const reconciler = new VcMeetingTerminalReconciler({
      settle,
      scheduler,
      maxAttempts: 4,
      initialDelayMs: 10,
      backoffMultiplier: 2,
      maxDelayMs: 100,
      onFinalized: finalized,
    });

    reconciler.enqueue(terminal(), { workerGeneration: 7 });
    await flushPromises();
    expect(scheduler.scheduledDelays).toEqual([10]);
    const firstTimer = scheduler.runNext();
    await flushPromises();
    expect(firstTimer.unref).toHaveBeenCalledTimes(1);
    expect(scheduler.scheduledDelays).toEqual([10, 20]);
    const secondTimer = scheduler.runNext();
    await flushPromises();

    expect(secondTimer.unref).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(3);
    expect(reconciler.pendingCount).toBe(0);
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      attempts: 3,
      state: 'handled',
    }));
  });

  it.each([
    'stale_terminal',
    'stale_dispatch_attempt',
    'stale_worker_generation',
    'dispatch_attempt_missing',
    'receipt_not_found',
    'invalid_transition',
  ])('does not retry permanent receiver reason %s', async (reason) => {
    const scheduler = new FakeScheduler();
    const finalized = vi.fn();
    const settle = vi.fn(() => ({ handled: false, reason }));
    const reconciler = new VcMeetingTerminalReconciler({
      settle,
      scheduler,
      onFinalized: finalized,
    });

    reconciler.enqueue(terminal(), { workerGeneration: 3 });
    await flushPromises();

    expect(settle).toHaveBeenCalledTimes(1);
    expect(scheduler.tasks.size).toBe(0);
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      attempts: 1,
      reason,
      state: 'permanent_failure',
    }));
  });

  it('tries an ordinary terminal without dispatchAttempt exactly once even on throw', async () => {
    const scheduler = new FakeScheduler();
    const finalized = vi.fn();
    const settle = vi.fn(() => { throw new Error('store unavailable'); });
    const reconciler = new VcMeetingTerminalReconciler({
      settle,
      scheduler,
      onFinalized: finalized,
    });

    reconciler.enqueue(terminal({ dispatchAttempt: undefined }), { workerGeneration: 1 });
    await flushPromises();

    expect(settle).toHaveBeenCalledTimes(1);
    expect(scheduler.tasks.size).toBe(0);
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      attempts: 1,
      state: 'one_shot_failure',
      error: expect.any(Error),
    }));
  });

  it('stops after the configured total attempt budget', async () => {
    const scheduler = new FakeScheduler();
    const finalized = vi.fn();
    const settle = vi.fn(() => ({ handled: false, reason: 'receipt_lost' }));
    const reconciler = new VcMeetingTerminalReconciler({
      settle,
      scheduler,
      maxAttempts: 3,
      initialDelayMs: 5,
      onFinalized: finalized,
    });

    reconciler.enqueue(terminal(), { workerGeneration: 2 });
    await flushPromises();
    scheduler.runNext();
    await flushPromises();
    scheduler.runNext();
    await flushPromises();

    expect(settle).toHaveBeenCalledTimes(3);
    expect(scheduler.tasks.size).toBe(0);
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      attempts: 3,
      reason: 'receipt_lost',
      state: 'retry_exhausted',
    }));
  });

  it('caps exponential delays at maxDelayMs', async () => {
    const scheduler = new FakeScheduler();
    const reconciler = new VcMeetingTerminalReconciler({
      settle: () => ({ handled: false, reason: 'receipt_lost' }),
      scheduler,
      maxAttempts: 5,
      initialDelayMs: 10,
      backoffMultiplier: 3,
      maxDelayMs: 25,
    });

    reconciler.enqueue(terminal(), { workerGeneration: 2 });
    await flushPromises();
    scheduler.runNext();
    await flushPromises();
    scheduler.runNext();
    await flushPromises();
    scheduler.runNext();
    await flushPromises();

    expect(scheduler.scheduledDelays).toEqual([10, 25, 25, 25]);
  });

  it('stop clears pending timers and ignores an in-progress settle result', async () => {
    const scheduler = new FakeScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const settle = vi.fn(async () => {
      await gate;
      return { handled: false, reason: 'receipt_lost' };
    });
    const reconciler = new VcMeetingTerminalReconciler({ settle, scheduler });

    reconciler.enqueue(terminal(), { workerGeneration: 3 });
    reconciler.stop();
    release();
    await flushPromises();

    expect(reconciler.isStopped).toBe(true);
    expect(reconciler.pendingCount).toBe(0);
    expect(scheduler.tasks.size).toBe(0);
    expect(reconciler.enqueue(terminal(), { workerGeneration: 3 })).toMatchObject({
      accepted: false,
      reason: 'stopped',
    });
  });

  it('stop clears an already scheduled retry timer', async () => {
    const scheduler = new FakeScheduler();
    const reconciler = new VcMeetingTerminalReconciler({
      settle: () => ({ handled: false, reason: 'receipt_lost' }),
      scheduler,
    });

    reconciler.enqueue(terminal(), { workerGeneration: 3 });
    await flushPromises();
    expect(scheduler.tasks.size).toBe(1);
    reconciler.stop();

    expect(scheduler.tasks.size).toBe(0);
    expect(scheduler.cleared).toHaveLength(1);
  });

  it('uses attempt and worker generation in the key but not terminal outcome', () => {
    const completed = terminal({ status: 'completed' });
    const failed = terminal({ status: 'failed', errorCode: 'x' });
    const key = deriveVcMeetingTerminalReconcileKey(completed, { workerGeneration: 8 });

    expect(deriveVcMeetingTerminalReconcileKey(failed, { workerGeneration: 8 })).toBe(key);
    expect(deriveVcMeetingTerminalReconcileKey(completed, { workerGeneration: 9 })).not.toBe(key);
    expect(deriveVcMeetingTerminalReconcileKey(
      terminal({ dispatchAttempt: 2 }),
      { workerGeneration: 8 },
    )).not.toBe(key);
  });

  it('bounds finalized tombstones while preserving in-flight deduplication', async () => {
    const settle = vi.fn(() => ({ handled: true }));
    const reconciler = new VcMeetingTerminalReconciler({ settle, maxRememberedKeys: 1 });

    reconciler.enqueue(terminal({ turnId: 'one' }), { workerGeneration: 1 });
    await flushPromises();
    reconciler.enqueue(terminal({ turnId: 'two' }), { workerGeneration: 1 });
    await flushPromises();
    expect(reconciler.enqueue(terminal({ turnId: 'two' }), { workerGeneration: 1 }))
      .toMatchObject({ accepted: false, reason: 'duplicate' });
    expect(reconciler.enqueue(terminal({ turnId: 'one' }), { workerGeneration: 1 }).accepted)
      .toBe(true);
  });
});

describe('isRetryableVcMeetingTerminalSettleReason', () => {
  it('retries unknown reasons boundedly but never stale or missing-attempt evidence', () => {
    expect(isRetryableVcMeetingTerminalSettleReason(undefined)).toBe(true);
    expect(isRetryableVcMeetingTerminalSettleReason('future_transient_store_error')).toBe(true);
    expect(isRetryableVcMeetingTerminalSettleReason('stale_future_token')).toBe(false);
    expect(isRetryableVcMeetingTerminalSettleReason('dispatch_attempt_missing')).toBe(false);
    expect(isRetryableVcMeetingTerminalSettleReason('receipt_not_found')).toBe(false);
  });
});
