import { describe, expect, it, vi } from 'vitest';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
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
  ) => (deferred && opts.beforeSubmit?.() === false
    // The Codex adapter's own answer to a beforeSubmit veto.
    ? { submitted: false, submissionDisposition: 'untouched', failureReason: 'vetoed before submission' }
    : { submitted: true }));
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

/** Park the next adapter writeInput in its own (Codex transcript/terminal)
 * precheck, before it reaches beforeSubmit; `parked` resolves exactly then. */
function parkPrecheck(scope: Record<string, any>) {
  let release!: () => void;
  let markParked!: () => void;
  const parked = new Promise<void>(resolve => { markParked = resolve; });
  const precheck = new Promise<void>(resolve => { release = resolve; });
  const submit = scope.cliAdapter.writeInput.getMockImplementation()!;
  scope.cliAdapter.writeInput.mockImplementationOnce(async (...args: any[]) => {
    markParked();
    await precheck;
    return submit(...args);
  });
  return { parked, release };
}

/** The real interrupt_turn IPC case. The exact-turn key delivery itself only
 * concerns the running turn, never the queue, so it is stubbed. */
async function interruptCli(scope: Record<string, any>) {
  scope.handleExactTurnInterrupt = vi.fn(async () => {});
  await loadWorkerMessageHandler('interrupt_turn', scope)({ type: 'interrupt_turn', requestId: 'r', turnId: 'running' });
}

/** The real term_action IPC case for /stop's ctrlc; of handleTermAction only
 * its queue step (the scheduled-backlog STOP) runs, not the key delivery. */
async function stopCli(scope: Record<string, any>) {
  const stop = loadWorkerFunction<() => void>('discardScheduledBacklogForStop', scope);
  scope.handleTermAction = vi.fn(async (key: string) => { if (key === 'ctrlc') stop(); });
  await loadWorkerMessageHandler('term_action', scope)({ type: 'term_action', key: 'ctrlc' });
}

const liveIdleDetector = {
  isStartupPending: () => false, programStatusHeldWorking: () => false, programStatusHeldBusy: () => false,
  adoptPromptReady: vi.fn(), reset: vi.fn(), dispose: vi.fn(),
};

/** The real killCli({ preservePending: true }). Its teardown of process
 * services the harness does not model (watchers, sandbox, RPC, timers) runs
 * against inert stand-ins; the worker state the queue and generation live in
 * is the harness's own. */
function killCliPreservingQueue(scope: Record<string, any>) {
  const inert: any = new Proxy(function inertService() {}, {
    get: (_target, key) => (key === Symbol.toPrimitive ? () => 0 : inert),
    apply: () => inert,
  });
  const services = new Set(['codexAppTurnLiveness', 'codexAppReadyAuthority', 'idleDetector']);
  const teardownScope = new Proxy(scope, {
    // Language globals (undefined, Date, ...) stay real.
    has: (target, key) => typeof key === 'string' && (key in target || !(key in globalThis)),
    get: (target, key) => (typeof key !== 'string' ? (target as any)[key]
      : key in target && !services.has(key) ? target[key] : inert),
  });
  loadWorkerFunction<(opts: { preservePending: boolean }) => void>('killCli', teardownScope)({ preservePending: true });
  // No stand-in leaked into the worker state the next flush reads.
  expect(Object.values(scope)).not.toContain(inert);
}

describe('deferred scheduled input interrupted during the adapter precheck', () => {
  function interruptibleHarness(decisions: Admission[]) {
    const harness = scheduledHarness(decisions, true);
    harness.h.scope.cliInterruptGeneration = 0;
    // An untouched Codex refusal hard-blocks native input; an interrupt hold must not.
    harness.h.scope.holdNativeInputForHardBlock = vi.fn();
    const authority = useRealTurnAuthority(harness.h.scope);
    return { ...harness, authority };
  }

  it('is held unprepared in the queue, then written exactly once on the next ready edge', async () => {
    const { h, item: runA, rejections, authority } = interruptibleHarness(['allow', 'allow', 'allow', 'allow']);
    const { parked, release } = parkPrecheck(h.scope);
    const flushA = h.flush();
    await parked;
    await interruptCli(h.scope);
    expect(h.scope.cliInterruptGeneration).toBe(1);
    release();
    await flushA;

    // The precheck reached beforeSubmit and was vetoed: nothing committed.
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(preparedFor(h.scope, runA.turnId)).toEqual(NOT_PREPARED);
    expect(authority.snapshot()).toBeUndefined();
    expect(h.scope.cliGenerationTurnWrites).toBe(0);
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(rejections(runA.turnId)).toBe(0);
    expect(h.scope.holdNativeInputForHardBlock).not.toHaveBeenCalled();

    // The next ready edge captures the post-interrupt generation and writes it.
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(2);
    expect(preparedFor(h.scope, runA.turnId)).toEqual(PREPARED_ONCE);
    expect(authority.snapshot()).toMatchObject({ turnId: runA.turnId, started: true });
    expect(h.scope.cliGenerationTurnWrites).toBe(1);
    expect(h.scope.pendingMessages).toEqual([]);
    expect(rejections(runA.turnId)).toBe(0);
  });

  it('a retained hold arms the admission retry, which writes it once', async () => {
    const { h, item: runA, fireRetry } = interruptibleHarness(['allow', 'allow', 'allow', 'allow']);
    const { parked, release } = parkPrecheck(h.scope);
    const flushA = h.flush();
    await parked;
    await interruptCli(h.scope);
    release();
    await flushA;
    expect(h.scope.pendingMessages).toEqual([runA]);

    await fireRetry();
    expect(preparedFor(h.scope, runA.turnId)).toEqual(PREPARED_ONCE);
    expect(h.scope.pendingMessages).toEqual([]);
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(2);
  });

  it('a write marked cancelled is rejected exactly once and never written', async () => {
    const { h, item: runA, rejections } = interruptibleHarness(['allow', 'allow', 'allow', 'allow']);
    const { parked, release } = parkPrecheck(h.scope);
    const flushA = h.flush();
    await parked;
    await interruptCli(h.scope);
    h.scope.cliSubmissionInFlight.scheduledWriteCancelled = true;
    release();
    await flushA;

    expect(preparedFor(h.scope, runA.turnId)).toEqual(NOT_PREPARED);
    expect(rejections(runA.turnId)).toBe(1);
    expect(h.scope.pendingMessages).toEqual([]);
    await h.flush();
    expect(rejections(runA.turnId)).toBe(1);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(preparedFor(h.scope, runA.turnId)).toEqual(NOT_PREPARED);
  });

  it.each(['coalesce', 'STOP'] as const)('interrupt + %s in the same window: the retired run settles once and the queue moves on', async retire => {
    const { h, item: runA, rejections, authority } = interruptibleHarness(['allow', 'allow', 'allow', 'allow']);
    const { parked, release } = parkPrecheck(h.scope);
    const flushA = h.flush();
    await parked;
    const turnB = scheduledTurnId('b');
    if (retire === 'coalesce') {
      await interruptCli(h.scope);
      h.scope.pendingMessages.push({
        content: 'run B', turnId: turnB, queueAfterActiveTurn: true,
        scheduledRun: { taskId: 'a1b2c3d4', runId: 'run-2', turnId: turnB, trigger: 'scheduler' },
      });
      loadWorkerFunction<() => void>('coalescePendingScheduledInputs', h.scope)();
    } else {
      await stopCli(h.scope);
    }
    expect(h.scope.cliInterruptGeneration).toBe(1);
    expect(rejections(runA.turnId)).toBe(1);
    release();
    await flushA;

    expect(preparedFor(h.scope, runA.turnId)).toEqual(NOT_PREPARED);
    expect(rejections(runA.turnId)).toBe(1);
    expect(h.scope.pendingMessages).toEqual([]);
    if (retire === 'coalesce') {
      // Same flush, fresh generation: B is written, not held by A's interrupt.
      expect(preparedFor(h.scope, turnB)).toEqual(PREPARED_ONCE);
      expect(authority.snapshot()).toMatchObject({ turnId: turnB, started: true });
      expect(h.scope.cliGenerationTurnWrites).toBe(1);
      expect(rejections(turnB)).toBe(0);
    } else {
      expect(authority.snapshot()).toBeUndefined();
      expect(h.scope.cliGenerationTurnWrites).toBe(0);
    }
    await h.flush();
    expect(rejections(runA.turnId)).toBe(1);
    expect(preparedFor(h.scope, runA.turnId)).toEqual(NOT_PREPARED);
  });

  it('a Web wire dirtied during the precheck holds it until the CLI is rebuilt, then it is written once', async () => {
    const { h, item: runA, rejections, fireRetry } = interruptibleHarness(['allow', 'allow', 'allow', 'allow']);
    h.scope.cliLifetimeNonce = 'dirty-runtime';
    const dirtyBackend = h.scope.backend;
    dirtyBackend.kill = vi.fn();
    const { parked, release } = parkPrecheck(h.scope);
    const flushA = h.flush();
    await parked;
    // The real partial-paste path pins the dirty mark to this exact CLI.
    loadWorkerFunction<(ws: unknown, target: unknown) => void>('markWebTerminalInputWireUncertain', h.scope)(
      { close: vi.fn() },
      { backend: h.scope.backend, lifetime: h.scope.cliLifetimeNonce, generation: h.scope.cliSpawnGeneration },
    );
    release();
    await flushA;
    expect(preparedFor(h.scope, runA.turnId)).toEqual(NOT_PREPARED);
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(rejections(runA.turnId)).toBe(0);
    expect(h.scope.holdNativeInputForHardBlock).not.toHaveBeenCalled();

    // The retry fires against the same, still dirty CLI: nothing is written.
    await fireRetry();
    expect(h.scope.pendingMessages[0]).toBe(runA);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(preparedFor(h.scope, runA.turnId)).toEqual(NOT_PREPARED);

    // Only rebuilding the CLI lifts the mark: the real queue-preserving
    // killCli ends this generation, then the replacement CLI comes up.
    killCliPreservingQueue(h.scope);
    expect(dirtyBackend.kill).toHaveBeenCalledTimes(1);
    expect(h.scope.cliSpawnGeneration).toBe(8);
    expect(h.scope.pendingMessages).toEqual([runA]);
    Object.assign(h.scope, {
      backend: {}, cliLifetimeNonce: 'replacement-runtime', isPromptReady: true, idleDetector: liveIdleDetector,
    });
    await h.flush();
    expect(preparedFor(h.scope, runA.turnId)).toEqual(PREPARED_ONCE);
    expect(h.scope.pendingMessages).toEqual([]);
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(2);
    expect(preparedFor(h.scope, runA.turnId)).toEqual(PREPARED_ONCE);
    expect(rejections(runA.turnId)).toBe(0);
  });

  it('a non-scheduled input is still written when the interrupt lands in its precheck', async () => {
    const { h, item, authority } = interruptibleHarness([]);
    Object.assign(item, { turnId: 'human-turn', scheduledRun: undefined, queueAfterActiveTurn: undefined });
    const { parked, release } = parkPrecheck(h.scope);
    const flushA = h.flush();
    await parked;
    await interruptCli(h.scope);
    release();
    await flushA;

    expect(h.scope.requestScheduledInputAdmission).not.toHaveBeenCalled();
    expect(preparedFor(h.scope, 'human-turn')).toEqual(PREPARED_ONCE);
    expect(authority.snapshot()).toMatchObject({ turnId: 'human-turn', started: true });
    expect(h.scope.pendingMessages).toEqual([]);
  });
});

describe('STOP after a held scheduled write armed its retry, before the retry fires', () => {
  it.each([
    ['deferred', true],
    ['non-deferred', false],
  ] as const)('%s write-edge retain: STOP retires it once and the retry writes nothing', async (_mode, deferred) => {
    const { h, item: runA, rejections, fireRetry } = scheduledHarness(['allow', 'retain', 'allow', 'allow'], deferred);
    // STOP's ctrlc bumps the interrupt generation; give it a number to bump.
    h.scope.cliInterruptGeneration = 0;
    await h.flush();
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(h.scope.scheduledAdmissionRetry?.item).toBe(runA);

    await stopCli(h.scope);
    expect(h.scope.pendingMessages).toEqual([]);
    expect(rejections(runA.turnId)).toBe(1);
    expect(h.scope.scheduledAdmissionRetry).toBeUndefined();

    await fireRetry();
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.requestScheduledInputAdmission).toHaveBeenCalledTimes(2);
    expect(rejections(runA.turnId)).toBe(1);
    expect(h.scope.pendingMessages).toEqual([]);
  });

  it('precheck interrupt retain: STOP retires it once, unprepared, and the retry writes nothing', async () => {
    const harness = scheduledHarness(['allow', 'allow', 'allow', 'allow'], true);
    const { h, item: runA, rejections, fireRetry } = harness;
    h.scope.cliInterruptGeneration = 0;
    h.scope.holdNativeInputForHardBlock = vi.fn();
    const authority = useRealTurnAuthority(h.scope);
    const { parked, release } = parkPrecheck(h.scope);
    const flushA = h.flush();
    await parked;
    await interruptCli(h.scope);
    release();
    await flushA;
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(h.scope.scheduledAdmissionRetry?.item).toBe(runA);
    expect(rejections(runA.turnId)).toBe(0);

    await stopCli(h.scope);
    expect(h.scope.pendingMessages).toEqual([]);
    expect(rejections(runA.turnId)).toBe(1);
    expect(h.scope.scheduledAdmissionRetry).toBeUndefined();

    await fireRetry();
    await h.flush();
    // Only the vetoed precheck ever reached the adapter.
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(preparedFor(h.scope, runA.turnId)).toEqual(NOT_PREPARED);
    expect(authority.snapshot()).toBeUndefined();
    expect(h.scope.cliGenerationTurnWrites).toBe(0);
    expect(rejections(runA.turnId)).toBe(1);
    expect(h.scope.pendingMessages).toEqual([]);
  });

  it('a retry that passes the head gate but is blocked before writing stays STOP-owned', async () => {
    const { h, item: runA, rejections, fireRetry } = scheduledHarness(['allow', 'retain', 'allow', 'allow'], true);
    h.scope.cliInterruptGeneration = 0;
    await h.flush();
    expect(h.scope.pendingMessages).toEqual([runA]);

    // Another turn takes the CLI while the retry's head gate awaits admission:
    // the gate admits it, consumes the retry slot, then is blocked.
    let blocked = false;
    h.scope.activeTurnBlocks = () => blocked;
    const admit = h.scope.requestScheduledInputAdmission.getMockImplementation()!;
    h.scope.requestScheduledInputAdmission.mockImplementationOnce(async (...args: any[]) => {
      blocked = true;
      return admit(...args);
    });
    await fireRetry();
    expect(h.scope.requestScheduledInputAdmission).toHaveBeenCalledTimes(3);
    expect(h.scope.scheduledAdmissionRetry).toBeUndefined();
    expect(h.scope.pendingMessages).toEqual([runA]);

    await stopCli(h.scope);
    expect(h.scope.pendingMessages).toEqual([]);
    expect(rejections(runA.turnId)).toBe(1);

    blocked = false;
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(rejections(runA.turnId)).toBe(1);
  });

  it('a write whose edge settles only after its CLI was replaced is not STOP-owned by the replacement CLI', async () => {
    const edgeA = deferredAdmission();
    const { h, item: runA, rejections } = scheduledHarness(['allow', edgeA.answer, 'allow', 'allow'], true);
    h.scope.cliInterruptGeneration = 0;
    h.scope.holdNativeInputForHardBlock = vi.fn();
    useRealTurnAuthority(h.scope);
    h.scope.cliLifetimeNonce = 'old-runtime';
    h.scope.backend.kill = vi.fn();
    const flushA = h.flush();
    await edgeA.asked;
    // The old CLI is rebuilt, queue preserved, while its write edge awaits.
    killCliPreservingQueue(h.scope);
    Object.assign(h.scope, {
      backend: {}, cliLifetimeNonce: 'replacement-runtime', isPromptReady: true, idleDetector: liveIdleDetector,
    });
    edgeA.settle('allow');
    await flushA;
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();

    // STOP on the replacement CLI, before it ever began writing A: A stays.
    await stopCli(h.scope);
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(rejections(runA.turnId)).toBe(0);

    await h.flush();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages).toEqual([]);
    expect(rejections(runA.turnId)).toBe(0);
  });

  it('a write held on a CLI that was since replaced is not STOP-owned by the replacement CLI', async () => {
    const { h, item: runA, rejections } = scheduledHarness(['allow', 'retain', 'allow', 'allow'], true);
    h.scope.cliInterruptGeneration = 0;
    useRealTurnAuthority(h.scope);
    h.scope.cliLifetimeNonce = 'old-runtime';
    h.scope.backend.kill = vi.fn();
    await h.flush();
    expect(h.scope.pendingMessages).toEqual([runA]);

    killCliPreservingQueue(h.scope);
    Object.assign(h.scope, {
      backend: {}, cliLifetimeNonce: 'replacement-runtime', isPromptReady: true, idleDetector: liveIdleDetector,
    });
    await stopCli(h.scope);
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(rejections(runA.turnId)).toBe(0);

    await h.flush();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages).toEqual([]);
    expect(rejections(runA.turnId)).toBe(0);
  });

  it.each([
    ['a human turn', 'human-turn'],
    ['an input without a turn id', undefined],
  ] as const)('STOP after %s jumped ahead of the held write and took the CLI leaves the held write queued', async (_label, humanTurnId) => {
    const { h, item: runA, rejections } = scheduledHarness(['allow', 'retain'], true);
    h.scope.cliInterruptGeneration = 0;
    useRealTurnAuthority(h.scope);
    // The real shared write record every writer (queue, TraeX native answer) calls.
    h.scope.writtenInputs = { noteWritten: vi.fn() };
    h.scope.noteCliInputWritten = vi.fn(loadWorkerFunction('noteCliInputWritten', h.scope));
    await h.flush();
    expect(h.scope.pendingMessages).toEqual([runA]);

    // The human input overtakes A (as promotePendingHumanInterruption would)
    // and is written; A waits behind it without ever reaching the writer.
    h.scope.pendingMessages.unshift({ content: 'human', ...(humanTurnId ? { turnId: humanTurnId } : {}) });
    h.scope.pendingInputAllowsTypeAhead = () => false;
    await h.flush();
    const written = h.scope.cliAdapter.writeInput.mock.calls.map(([, message]: [unknown, string]) => message);
    expect(written).toEqual(['human']);
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(h.scope.currentBotmuxTurnId).toBe(humanTurnId);

    // This STOP is the human's: A was not its writer.
    await stopCli(h.scope);
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(rejections(runA.turnId)).toBe(0);
  });

  it('STOP after another turn became current leaves the held write queued', async () => {
    const { h, item: runA, rejections } = scheduledHarness(['allow', 'retain'], true);
    h.scope.cliInterruptGeneration = 0;
    useRealTurnAuthority(h.scope);
    await h.flush();
    expect(h.scope.pendingMessages).toEqual([runA]);

    // A turn handed to the CLI outside this queue's writer slot.
    h.scope.setCaptureIdentity('human-turn', undefined);
    await stopCli(h.scope);
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(rejections(runA.turnId)).toBe(0);
  });

  it.each([
    ['a Web terminal submit', 'webTerminalSubmitGeneration'],
    ['a raw passthrough write', 'rawInputWriteGeneration'],
  ] as const)('STOP after %s took the CLI leaves the held write queued', async (_label, generation) => {
    const { h, item: runA, rejections } = scheduledHarness(['allow', 'retain'], true);
    Object.assign(h.scope, { cliInterruptGeneration: 0, webTerminalSubmitGeneration: 0, rawInputWriteGeneration: 0 });
    await h.flush();
    expect(h.scope.pendingMessages).toEqual([runA]);

    // noteWebTerminalInput / the raw command-line writer advance these when
    // operator bytes reach the CLI outside the queue.
    h.scope[generation] += 1;
    await stopCli(h.scope);
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(rejections(runA.turnId)).toBe(0);
  });

  it('STOP while another input is mid-write leaves the held write queued', async () => {
    const { h, item: runA, rejections } = scheduledHarness(['allow', 'retain', 'retain'], true);
    h.scope.cliInterruptGeneration = 0;
    await h.flush();
    expect(h.scope.pendingMessages).toEqual([runA]);

    h.scope.pendingMessages.unshift({ content: 'human' });
    const { parked, release } = parkPrecheck(h.scope);
    const flushHuman = h.flush();
    await parked;
    expect(h.scope.cliSubmissionInFlight?.item?.content).toBe('human');
    await stopCli(h.scope);
    expect(h.scope.pendingMessages).toContain(runA);
    expect(rejections(runA.turnId)).toBe(0);
    release();
    await flushHuman;
  });

  it('a retried write refused before it reached the CLI stays STOP-owned', async () => {
    const { h, item: runA, rejections, fireRetry } = scheduledHarness(['allow', 'retain', 'allow', 'allow'], false);
    h.scope.cliInterruptGeneration = 0;
    await h.flush();
    expect(h.scope.pendingMessages).toEqual([runA]);

    // The retry is admitted, but the prior turn's absorbed final is still
    // unresolved: preparation refuses the write and keeps A at the head.
    Object.assign(h.scope, {
      currentTurnHasFinalEvidence: () => true,
      advanceQueuedTypeAheadTurnAfterFinal: vi.fn(),
      queuedTypeAheadTurns: [{ turnId: 'absorbed', inputConsumed: true }],
    });
    await fireRetry();
    expect(h.scope.requestScheduledInputAdmission).toHaveBeenCalledTimes(4);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toEqual([runA]);

    await stopCli(h.scope);
    expect(h.scope.pendingMessages).toEqual([]);
    expect(rejections(runA.turnId)).toBe(1);
  });

  it('STOP emptying the queue while a retry awaits the post-terminal prompt fence ends that flush cleanly', async () => {
    const { h, item: runA, rejections, fireRetry } = scheduledHarness(['allow', 'retain', 'allow', 'allow'], true);
    h.scope.cliInterruptGeneration = 0;
    await h.flush();
    expect(h.scope.pendingMessages).toEqual([runA]);

    // TraeX/ZCode await their post-terminal surface before each queued write.
    h.scope.cliAdapter.postTerminalPromptFence = true;
    // The first await is flushPending's entry fence; STOP lands in the
    // per-item fence inside the drain loop.
    let fenceChecks = 0;
    h.scope.postTerminalInputIsBlocked = vi.fn(async () => {
      if (++fenceChecks === 2) await stopCli(h.scope);
      return false;
    });
    await fireRetry();
    expect(fenceChecks).toBe(2);
    expect(h.scope.pendingMessages).toEqual([]);
    expect(rejections(runA.turnId)).toBe(1);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.isFlushing).toBe(false);
  });

  it('a head-gate retain never became the writer: STOP leaves it queued and the retry writes it once', async () => {
    // The pre-dequeue gate retains; STOP with no scheduled turn or writer has
    // no target, exactly as it would have had it arrived during that gate.
    const { h, item: runA, rejections, fireRetry } = scheduledHarness(['retain', 'allow', 'allow'], true);
    h.scope.cliInterruptGeneration = 0;
    await h.flush();
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(h.scope.scheduledAdmissionRetry?.item).toBe(runA);

    await stopCli(h.scope);
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(rejections(runA.turnId)).toBe(0);

    await fireRetry();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages).toEqual([]);
    expect(rejections(runA.turnId)).toBe(0);
  });
});

describe('STOP after another input channel took the CLI while the scheduled write was held', () => {
  /** Wire the REAL flushPendingInjections against a stubbed physical command
   *  writer; the stub still runs the before-write callback exactly at the write
   *  edge, where the held slot must be invalidated. */
  function armInjectionFlush(scope: Record<string, any>) {
    const rawWrites: string[] = [];
    Object.assign(scope, {
      injectionFlushing: false,
      commandLineWritesPending: 0,
      bareShellLaunchBlocked: false,
      canStartInjectionFlush: () => true,
      awaitPtyQuiescence: vi.fn(async () => {}),
      fingerprintPromptText: (cmd: string) => cmd,
    });
    scope.idleDetector.reset = vi.fn();
    scope.sendRawCommandLineWithRecoveryFence = vi.fn(async (
      _backend: unknown, cmd: string, beforeWrite?: () => void,
    ) => { beforeWrite?.(); rawWrites.push(cmd); });
    return rawWrites;
  }

  it('a non-keepalive slash injection after the hold takes the CLI: STOP leaves the held write queued', async () => {
    const { h, item: runA, rejections } = scheduledHarness(['allow', 'retain'], true);
    h.scope.cliInterruptGeneration = 0;
    const rawWrites = armInjectionFlush(h.scope);
    await h.flush();
    expect(h.scope.pendingMessages).toEqual([runA]);

    h.scope.pendingInjections.push({ command: '/compact', barrier: false });
    await loadWorkerFunction<() => Promise<void>>('flushPendingInjections', h.scope)();
    expect(rawWrites).toEqual(['/compact']);

    await stopCli(h.scope);
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(rejections(runA.turnId)).toBe(0);
  });

  it('a keepalive injection is bot-generated and does not take the CLI: STOP still retires the held write', async () => {
    const { h, item: runA, rejections } = scheduledHarness(['allow', 'retain'], true);
    h.scope.cliInterruptGeneration = 0;
    const rawWrites = armInjectionFlush(h.scope);
    await h.flush();
    expect(h.scope.pendingMessages).toEqual([runA]);

    h.scope.pendingInjections.push({ command: '/compact', barrier: false, kind: 'keepalive' });
    await loadWorkerFunction<() => Promise<void>>('flushPendingInjections', h.scope)();
    expect(rawWrites).toEqual(['/compact']);

    await stopCli(h.scope);
    expect(h.scope.pendingMessages).toEqual([]);
    expect(rejections(runA.turnId)).toBe(1);
  });

  it('an Antigravity /btw side question after the hold opens its own conversation: STOP leaves the held write queued', async () => {
    const { h, item: runA, rejections } = scheduledHarness(['allow', 'retain'], true);
    h.scope.cliInterruptGeneration = 0;
    await h.flush();
    expect(h.scope.pendingMessages).toEqual([runA]);

    const rawWrites: string[] = [];
    Object.assign(h.scope, {
      lastInitConfig: { cliId: 'antigravity' },
      cliLifetimeNonce: 'life-1',
      inputDeliveryObservedCliSessionId: 'native-1',
      effectiveBackendType: 'pty',
      isRemoteBackendType: () => false,
      nativeSessionForkPending: () => false,
      antigravitySideQuestionPending: false,
      rawInputRestartGate: false,
      startupCommandsInProgress: false,
      startupCommandAckHold: false,
      hasRunStartupCommands: true,
      firstWriteLivenessConfirmed: true,
      hasPendingInputForFlush: () => h.scope.pendingMessages.length > 0,
      AntigravitySessionLog: class { read() { return { currentId: 'native-1', sideQuestion: undefined }; } },
      btwOverlayScreen: () => ({}),
      heldStuckPage: () => false,
      hasAntigravitySideQuestionComposer: () => true,
      firstWriteMayProceed: () => true,
      // Expire the answer poll immediately: this case only asserts the write edge.
      BTW_ANSWER_WINDOW_MS: -1,
      readAntigravitySideAnswer: () => undefined,
      delay: vi.fn(async () => {}),
    });
    h.scope.cliAdapter.runnerFramedInput = false;
    h.scope.sendRawCommandLineWithRecoveryFence = vi.fn(async (
      _backend: unknown, cmd: string, beforeWrite?: () => void,
    ) => { beforeWrite?.(); rawWrites.push(cmd); });

    await loadWorkerFunction<(msg: unknown) => Promise<void>>('handleAntigravitySideQuestion', h.scope)({
      type: 'antigravity_btw', messageId: 'm1', question: 'side question?', nativeSessionId: 'native-1',
    });
    expect(rawWrites).toEqual(['/btw side question?']);

    await stopCli(h.scope);
    expect(h.scope.pendingMessages).toEqual([runA]);
    expect(rejections(runA.turnId)).toBe(0);
  });
});
