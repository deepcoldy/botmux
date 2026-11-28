import { describe, expect, it, vi } from 'vitest';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';

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

/** Replace the harness's turn-authority stubs with the worker's real ones, so
 * a started-but-unwritten turn would really block the next queued input. */
function useRealTurnAuthority(scope: Record<string, any>) {
  const authority = new ActiveTurnAuthority();
  Object.assign(scope, {
    activeTurnAuthority: authority,
    crossPrincipalIsolationOn: () => false,
    baselineAntigravityFooterTasksForActiveTurn: vi.fn(),
    currentBotmuxTurnId: undefined, currentBotmuxDispatchAttempt: undefined,
    captureIdentityAnnounced: false, captureRevision: 0, workerSessionEventScope: undefined,
  });
  for (const name of ['turnAuthorityIdentity', 'adoptActiveTurnWhenIsolationOff', 'activeTurnBlocks']) {
    scope[name] = loadWorkerFunction(name, scope);
  }
  scope.markActiveTurnStarted = vi.fn(loadWorkerFunction('markActiveTurnStarted', scope));
  scope.setCaptureIdentity = vi.fn(loadWorkerFunction('setCaptureIdentity', scope));
  return authority;
}

/** Every preparation side effect that would claim `turnId` as written. */
function preparedFor(scope: Record<string, any>, turnId: string) {
  const byItem = (calls: any[][]) => calls.filter(([item]) => item?.turnId === turnId).length;
  return {
    captureIdentity: scope.setCaptureIdentity.mock.calls.filter(([id]: [string]) => id === turnId).length,
    activeTurnStarted: byItem(scope.markActiveTurnStarted.mock.calls),
    inflight: byItem(scope.inflightInputs.onWrite.mock.calls),
    written: byItem(scope.noteCliInputWritten.mock.calls),
  };
}
const NOT_PREPARED = { captureIdentity: 0, activeTurnStarted: 0, inflight: 0, written: 0 };
const PREPARED_ONCE = { captureIdentity: 1, activeTurnStarted: 1, inflight: 1, written: 1 };

describe('deferred scheduled input retired while its write-edge admission is pending, then allowed late', () => {
  it('coalesce: the retired run is never prepared, and the newer run is written in the same flush', async () => {
    const edgeA = deferredAdmission();
    const { h, item: runA, rejections } = scheduledHarness(['allow', edgeA.answer, 'allow', 'allow'], true);
    const authority = useRealTurnAuthority(h.scope);
    const flushA = h.flush();
    await edgeA.asked;
    expect(h.scope.pendingMessages).toEqual([runA]);

    const turnB = scheduledTurnId('b');
    const runB = {
      content: 'run B', turnId: turnB, queueAfterActiveTurn: true,
      scheduledRun: { taskId: 'a1b2c3d4', runId: 'run-2', turnId: turnB, trigger: 'scheduler' },
    };
    h.scope.pendingMessages.push(runB);
    loadWorkerFunction<() => void>('coalescePendingScheduledInputs', h.scope)();
    expect(h.scope.pendingMessages).toEqual([runB]);
    expect(rejections(runA.turnId)).toBe(1);

    edgeA.settle('allow');
    await flushA;
    // A left no capture identity, started authority, in-flight or written mark.
    expect(preparedFor(h.scope, runA.turnId)).toEqual(NOT_PREPARED);
    expect(rejections(runA.turnId)).toBe(1);
    expect(h.scope.pendingMessages).not.toContain(runA);
    // The very same flush moved on: B owns the authority and is the only write.
    const written = h.scope.cliAdapter.writeInput.mock.calls.map(([, message]: [unknown, string]) => message);
    expect(written).toEqual(['run B']);
    expect(preparedFor(h.scope, turnB)).toEqual(PREPARED_ONCE);
    expect(authority.snapshot()).toMatchObject({ turnId: turnB, started: true });
    expect(h.scope.cliGenerationTurnWrites).toBe(1);
    expect(rejections(turnB)).toBe(0);
    expect(h.scope.pendingMessages).toEqual([]);
  });

  it('STOP: the retired run is never prepared and is rejected exactly once', async () => {
    const edgeA = deferredAdmission();
    const { h, item: runA, rejections } = scheduledHarness(['allow', edgeA.answer], true);
    const authority = useRealTurnAuthority(h.scope);
    const flushA = h.flush();
    await edgeA.asked;
    loadWorkerFunction<() => void>('discardScheduledBacklogForStop', h.scope)();
    expect(h.scope.pendingMessages).toEqual([]);
    expect(rejections(runA.turnId)).toBe(1);

    edgeA.settle('allow');
    await flushA;
    expect(preparedFor(h.scope, runA.turnId)).toEqual(NOT_PREPARED);
    expect(authority.snapshot()).toBeUndefined();
    expect(h.scope.cliGenerationTurnWrites).toBe(0);
    expect(rejections(runA.turnId)).toBe(1);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toEqual([]);
  });

  it.each(['coalesce', 'STOP'] as const)('%s during the adapter precheck: the retired run is never prepared and the queue moves on', async retire => {
    const { h, item: runA, rejections } = scheduledHarness(['allow', 'allow', 'allow', 'allow'], true);
    const authority = useRealTurnAuthority(h.scope);
    // Codex awaits its own transcript/terminal precheck before beforeSubmit.
    let releasePrecheck!: () => void;
    let markParked!: () => void;
    const parked = new Promise<void>(resolve => { markParked = resolve; });
    const precheck = new Promise<void>(resolve => { releasePrecheck = resolve; });
    const submit = h.scope.cliAdapter.writeInput.getMockImplementation()!;
    h.scope.cliAdapter.writeInput.mockImplementationOnce(async (...args: any[]) => {
      markParked();
      await precheck;
      return submit(...args);
    });
    const flushA = h.flush();
    await parked;
    expect(h.scope.pendingMessages).toEqual([runA]);

    const turnB = scheduledTurnId('b');
    const runB = {
      content: 'run B', turnId: turnB, queueAfterActiveTurn: true,
      scheduledRun: { taskId: 'a1b2c3d4', runId: 'run-2', turnId: turnB, trigger: 'scheduler' },
    };
    if (retire === 'coalesce') {
      h.scope.pendingMessages.push(runB);
      loadWorkerFunction<() => void>('coalescePendingScheduledInputs', h.scope)();
      expect(h.scope.pendingMessages).toEqual([runB]);
    } else {
      loadWorkerFunction<() => void>('discardScheduledBacklogForStop', h.scope)();
      expect(h.scope.pendingMessages).toEqual([]);
    }
    expect(rejections(runA.turnId)).toBe(1);
    // Still parked: nothing of A may have been committed yet.
    expect(preparedFor(h.scope, runA.turnId)).toEqual(NOT_PREPARED);

    releasePrecheck();
    await flushA;
    expect(preparedFor(h.scope, runA.turnId)).toEqual(NOT_PREPARED);
    expect(rejections(runA.turnId)).toBe(1);
    expect(h.scope.pendingMessages).toEqual([]);
    if (retire === 'coalesce') {
      // Same flush, no extra ready edge: B owns the authority and is written.
      expect(preparedFor(h.scope, turnB)).toEqual(PREPARED_ONCE);
      expect(authority.snapshot()).toMatchObject({ turnId: turnB, started: true });
      expect(h.scope.cliGenerationTurnWrites).toBe(1);
      expect(rejections(turnB)).toBe(0);
    } else {
      expect(authority.snapshot()).toBeUndefined();
      expect(h.scope.cliGenerationTurnWrites).toBe(0);
    }
  });

  it('an admitted deferred run that keeps its queue ownership is prepared once, at beforeSubmit', async () => {
    const { h, item: runA } = scheduledHarness(['allow', 'allow'], true);
    const authority = useRealTurnAuthority(h.scope);
    const submit = h.scope.cliAdapter.writeInput.getMockImplementation()!;
    let preparedBeforeSubmit: unknown;
    h.scope.cliAdapter.writeInput.mockImplementationOnce(async (...args: any[]) => {
      preparedBeforeSubmit = preparedFor(h.scope, runA.turnId);
      return submit(...args);
    });
    await h.flush();
    expect(preparedBeforeSubmit).toEqual(NOT_PREPARED);
    expect(preparedFor(h.scope, runA.turnId)).toEqual(PREPARED_ONCE);
    expect(authority.snapshot()).toMatchObject({ turnId: runA.turnId, started: true });
    expect(h.scope.cliGenerationTurnWrites).toBe(1);
    expect(h.scope.pendingMessages).toEqual([]);
  });
});
