import { describe, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

function unresolvedFinalHarness() {
  const h = workerSubmitHarness();
  const item = h.scope.pendingMessages[0];
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const unresolvedFinal = {
    turnId: 'om_A', responseKind: 'final', dispatchAttempt: undefined,
    sentAtMs: 1, messageId: 'om_A_final',
  };
  Object.assign(h.scope, {
    currentBotmuxTurnId: 'om_A',
    currentBotmuxDispatchAttempt: undefined,
    queuedTypeAheadTurns: [{
      turnId: 'om_B', inputConsumed: true,
      absorbedIntoTurnId: 'om_A', absorbedIntoDispatchAttempt: undefined,
    }],
    readSendMarkers: () => [unresolvedFinal],
    cliPidMarker: undefined,
    basename,
    finalTransitionRetryDelayMs: 100,
    finalTransitionRetryAttempts: 0,
    finalTransitionRetryTimer: undefined,
    finalTransitionRetryItem: undefined,
    finalTransitionRetryGeneration: undefined,
    FINAL_TRANSITION_RETRY_MAX_DELAY_MS: 5_000,
    setTimeout: (callback: () => void, delayMs: number) => {
      scheduled.push({ callback, delayMs });
      return { unref: () => {} };
    },
    clearTimeout: vi.fn(),
    send: vi.fn(),
    markTurnRetired: vi.fn(),
    t: (key: string) => key,
  });
  h.scope.scheduleFinalTransitionRetry = loadWorkerFunction('scheduleFinalTransitionRetry', h.scope);
  h.scope.resetFinalTransitionRetryBackoff = loadWorkerFunction('resetFinalTransitionRetryBackoff', h.scope);
  let lastRetry = Promise.resolve();
  const flushFromTimer = () => {
    lastRetry = h.flush();
    return lastRetry;
  };
  h.scope.flushPending = flushFromTimer;
  return {
    h, item, scheduled, flushFromTimer,
    awaitLastRetry: () => lastRetry,
    showUnresolvedFinal: () => { h.scope.readSendMarkers = () => [unresolvedFinal]; },
  };
}

describe('worker final-transition retry recovery', () => {
  it('deduplicates external flushes, advances only fired retries, notifies once, and resets after success', async () => {
    const f = unresolvedFinalHarness();
    const { h, item, scheduled } = f;

    // Repeated external triggers share the exact pending item + generation.
    // They must not create three independent retry chains.
    await h.flush();
    await h.flush();
    await h.flush();
    expect(scheduled.map(timer => timer.delayMs)).toEqual([100]);
    expect(h.scope.pendingMessages).toEqual([item]);

    // Fire the current timer and await the real flush it starts. Only these
    // actual retry executions advance the bounded exponential schedule.
    for (let attempt = 1; attempt < 8; attempt++) {
      scheduled.at(-1)!.callback();
      await f.awaitLastRetry();
    }
    expect(scheduled.map(timer => timer.delayMs)).toEqual([
      100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000,
    ]);
    expect(h.scope.pendingMessages).toEqual([item]);
    expect(h.scope.pendingMessages[0]).toBe(item);
    expect(h.scope.send.mock.calls.filter(([event]) =>
      event.type === 'user_notify' && event.turnId === item.turnId)).toEqual([
      [{ type: 'user_notify', turnId: item.turnId, message: 'worker.final_transition_retrying' }],
    ]);

    // Recovery executes the same successful write edge that owns the production
    // reset and cancels the still-pending timer.
    h.scope.readSendMarkers = () => [];
    h.scope.queuedTypeAheadTurns = [];
    h.scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: true }));
    await h.flush();
    expect(h.scope.pendingMessages).toEqual([]);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.finalTransitionRetryAttempts).toBe(0);
    expect(h.scope.finalTransitionRetryDelayMs).toBe(100);
    expect(h.scope.finalTransitionRetryTimer).toBeUndefined();
    expect(h.scope.clearTimeout).toHaveBeenCalled();

    // Timer fire must re-check the original write generation AND exact head;
    // scheduling-time checks alone would let a stale retry flush a replacement.
    const retryFlush = vi.fn();
    h.scope.flushPending = retryFlush;
    h.scope.pendingMessages.push(item);
    const originalGeneration = h.scope.cliSpawnGeneration;
    h.scope.cliSpawnGeneration++;
    scheduled[0].callback();
    expect(retryFlush).not.toHaveBeenCalled();
    h.scope.cliSpawnGeneration = originalGeneration;
    h.scope.pendingMessages.length = 0;
    scheduled[0].callback();
    expect(retryFlush).not.toHaveBeenCalled();
    h.scope.pendingMessages.push(item);
    scheduled[0].callback();
    expect(retryFlush).toHaveBeenCalledTimes(1);
    h.scope.flushPending = f.flushFromTimer;

    // A later, independent unresolved transition starts from the initial delay.
    h.scope.queuedTypeAheadTurns = [{
      turnId: 'om_B', inputConsumed: true,
      absorbedIntoTurnId: 'om_A', absorbedIntoDispatchAttempt: undefined,
    }];
    f.showUnresolvedFinal();
    await h.flush();
    expect(scheduled.at(-1)?.delayMs).toBe(100);
    expect(h.scope.pendingMessages).toEqual([item]);
  });

  it('does not duplicate a deferred-preparation pending item and submits it once after recovery', async () => {
    const f = unresolvedFinalHarness();
    const { h, item } = f;
    h.scope.cliAdapter.writeInputDefersPreparation = true;
    h.scope.cliAdapter.writeInput = vi.fn(async (
      _backend: unknown,
      _message: string,
      opts: { beforeSubmit?: () => boolean },
    ) => {
      opts.beforeSubmit?.();
      return { submitted: true };
    });

    await h.flush();
    expect(h.scope.pendingMessages).toEqual([item]);
    expect(h.scope.pendingMessages[0]).toBe(item);
    expect(f.scheduled).toHaveLength(1);

    h.scope.readSendMarkers = () => [];
    h.scope.queuedTypeAheadTurns = [];
    f.scheduled[0].callback();
    await f.awaitLastRetry();
    expect(h.scope.pendingMessages).toEqual([]);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(2);
  });
});
