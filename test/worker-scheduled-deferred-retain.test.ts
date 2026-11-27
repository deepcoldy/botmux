import { describe, expect, it, vi } from 'vitest';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

type Admission = 'allow' | 'retain' | 'reject';

/**
 * Codex defers its write preparation: flushPending keeps the dequeued item in
 * pendingMessages while the adapter prechecks, and only removes it at
 * beforeSubmit. A scheduled item whose late (write-edge) admission answers
 * `retain` therefore reaches the catch branch while it is still queued.
 */
function scheduledHarness(decisions: Admission[], deferred: boolean) {
  const h = workerSubmitHarness();
  const item = h.scope.pendingMessages[0];
  const turnId = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
  Object.assign(item, {
    turnId, dispatchAttempt: undefined, queueAfterActiveTurn: true,
    scheduledRun: { taskId: 'a1b2c3d4', runId: 'run-1', turnId, trigger: 'scheduler' },
  });
  const timers: Array<() => void> = [];
  let lastRetry: Promise<void> = Promise.resolve();
  Object.assign(h.scope, {
    lastInitConfig: { cliId: deferred ? 'codex' : 'traex' },
    currentCodexObservedPid: () => undefined,
    // Admission retry timers are fired by the test, never by the wall clock.
    setTimeout: (callback: () => void) => { timers.push(callback); return { unref: () => {} }; },
    clearTimeout: vi.fn(),
    requestScheduledInputAdmission: vi.fn(async () => decisions.shift() ?? 'allow'),
    flushPending: () => { lastRetry = h.flush(); return lastRetry; },
  });
  h.scope.cliAdapter.writeInputDefersPreparation = deferred;
  h.scope.cliAdapter.writeInput = vi.fn(async (
    _backend: unknown,
    _message: string,
    opts: { beforeSubmit?: () => boolean },
  ) => ({ submitted: deferred ? opts.beforeSubmit?.() !== false : true }));
  const fireRetry = async () => {
    const timer = timers.pop();
    expect(timer, 'a retained admission must arm a retry timer').toBeDefined();
    timer!();
    await lastRetry;
  };
  return { h, item, fireRetry };
}

describe('scheduled input retained at the write edge', () => {
  it('deferred preparation: stays queued once across repeated late retains and is written exactly once when admitted', async () => {
    // Each flush asks twice: the pre-dequeue head gate, then the write edge.
    const { h, item, fireRetry } = scheduledHarness([
      'allow', 'retain',
      'allow', 'retain',
      'allow', 'allow',
    ], true);

    await h.flush();
    expect(h.scope.pendingMessages).toEqual([item]);
    expect(h.scope.pendingMessages[0]).toBe(item);

    await fireRetry();
    expect(h.scope.pendingMessages).toEqual([item]);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();

    await fireRetry();
    expect(h.scope.requestScheduledInputAdmission).toHaveBeenCalledTimes(6);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages).toEqual([]);

    // Nothing left behind for a later ready edge to write a second time.
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
  });

  it('non-deferred preparation: the dequeued item is restored on retain and still written exactly once', async () => {
    // The dedupe guard must not swallow the restore for adapters whose dequeue
    // really removed the item from pendingMessages.
    const { h, item, fireRetry } = scheduledHarness(['allow', 'retain', 'allow', 'allow'], false);

    await h.flush();
    expect(h.scope.pendingMessages).toEqual([item]);
    expect(h.scope.pendingMessages[0]).toBe(item);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();

    await fireRetry();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages).toEqual([]);
  });
});
