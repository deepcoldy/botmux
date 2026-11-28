import { describe, expect, it, vi } from 'vitest';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

type Admission = 'allow' | 'retain' | 'reject';

const scheduledTurnId = (runId: string) => `schedule:a1b2c3d4:12345678-1234-1234-1234-${runId.padStart(12, '0')}`;

/**
 * Codex defers its write preparation: flushPending keeps the dequeued item in
 * pendingMessages while the adapter prechecks, and only removes it at
 * beforeSubmit. A scheduled item whose late (write-edge) admission answers
 * `retain` therefore reaches the catch branch while it is still queued.
 */
function scheduledHarness(decisions: Array<Admission | (() => Promise<Admission>)>, deferred: boolean) {
  const h = workerSubmitHarness();
  const item = h.scope.pendingMessages[0];
  const turnId = scheduledTurnId('123456789abc');
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
    requestScheduledInputAdmission: vi.fn(async () => {
      const decision = decisions.shift() ?? 'allow';
      return typeof decision === 'function' ? decision() : decision;
    }),
    flushPending: () => { lastRetry = h.flush(); return lastRetry; },
  });
  h.scope.cliAdapter.writeInputDefersPreparation = deferred;
  h.scope.cliAdapter.writeInput = vi.fn(async (
    _backend: unknown,
    _message: string,
    opts: { beforeSubmit?: () => boolean },
  ) => ({ submitted: deferred ? opts.beforeSubmit?.() !== false : true }));
  const rejections = (turnId: string) => h.scope.send.mock.calls
    .filter(([message]: [any]) => message.type === 'turn_input_rejected' && message.turnId === turnId).length;
  const fireRetry = async () => {
    const timer = timers.pop();
    expect(timer, 'a retained admission must arm a retry timer').toBeDefined();
    timer!();
    await lastRetry;
  };
  return { h, item, fireRetry, rejections };
}

/** Admission answer the test settles while flushPending is awaiting it;
 * `asked` resolves exactly when flushPending starts that await. */
function deferredAdmission() {
  let settle!: (decision: Admission) => void;
  let markAsked!: () => void;
  const decision = new Promise<Admission>(resolve => { settle = resolve; });
  const asked = new Promise<void>(resolve => { markAsked = resolve; });
  return { answer: () => { markAsked(); return decision; }, asked, settle };
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

describe('scheduled input rejected at the write edge', () => {
  it.each([
    ['deferred', 'allow'],
    ['deferred', 'reject'],
    ['non-deferred', 'allow'],
    ['non-deferred', 'reject'],
  ] as const)('%s preparation: rejected exactly once and never written when later admissions answer %s', async (mode, later) => {
    // Head gate allows, the write edge rejects; any further admission of the
    // same run would answer `later`.
    const { h, item, rejections } = scheduledHarness(['allow', 'reject', later, later, later, later], mode === 'deferred');

    await h.flush();
    expect(h.scope.pendingMessages).toEqual([]);
    expect(rejections(item.turnId)).toBe(1);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();

    // A later ready edge has nothing of the rejected run left to write.
    await h.flush();
    expect(rejections(item.turnId)).toBe(1);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
  });
});

describe('deferred scheduled input retired by coalesce while its write-edge admission is pending', () => {
  it.each(['retain', 'reject'] as const)('a late %s neither revives nor re-rejects it, and the newer run is written', async late => {
    const edgeA = deferredAdmission();
    const { h, item: runA, rejections } = scheduledHarness(['allow', edgeA.answer, 'allow', 'allow'], true);
    const flushA = h.flush();
    // A has been parked back in the queue and is awaiting its write edge.
    await edgeA.asked;
    expect(h.scope.pendingMessages).toEqual([runA]);

    // Same task, newer run: the real enqueue-time coalesce keeps B, retires A.
    const turnB = scheduledTurnId('b');
    const runB = {
      content: 'run B', turnId: turnB, queueAfterActiveTurn: true,
      scheduledRun: { taskId: 'a1b2c3d4', runId: 'run-2', turnId: turnB, trigger: 'scheduler' },
    };
    h.scope.pendingMessages.push(runB);
    loadWorkerFunction<() => void>('coalescePendingScheduledInputs', h.scope)();
    expect(h.scope.pendingMessages).toEqual([runB]);
    expect(rejections(runA.turnId)).toBe(1);

    edgeA.settle(late);
    await flushA;
    // A stays retired: not queued again, not rejected twice, never written.
    expect(h.scope.pendingMessages).not.toContain(runA);
    expect(rejections(runA.turnId)).toBe(1);
    // The same flush moves on to B: no further ready edge is needed.
    const written = h.scope.cliAdapter.writeInput.mock.calls.map(([, message]: [unknown, string]) => message);
    expect(written).toEqual(['run B']);
    expect(rejections(turnB)).toBe(0);
    expect(h.scope.pendingMessages).toEqual([]);
  });

  it('STOP retiring it mid-admission settles it once: the cancelled write edge does not reject it again', async () => {
    const edgeA = deferredAdmission();
    const { h, item: runA, rejections } = scheduledHarness(['allow', edgeA.answer], true);
    const flushA = h.flush();
    await edgeA.asked;
    loadWorkerFunction<() => void>('discardScheduledBacklogForStop', h.scope)();
    expect(h.scope.pendingMessages).toEqual([]);
    expect(rejections(runA.turnId)).toBe(1);

    // The in-flight write was cancelled, so its edge answers reject whatever
    // the daemon said; the queue had already retired and rejected the item.
    edgeA.settle('allow');
    await flushA;
    await h.flush();
    expect(rejections(runA.turnId)).toBe(1);
    expect(h.scope.pendingMessages).toEqual([]);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
  });
});
