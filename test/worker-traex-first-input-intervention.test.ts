import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS } from '../src/utils/codex-app-control.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { WebTerminalInputController } from '../src/core/web-terminal-input-controller.js';

const SHORTCUT = [
  '  █ ◆ ◆ █  TRAE CLI (v0.214.1)',
  '  /tmp/native-control',
  '  permissions: YOLO mode',
  '──────────────────────────────────────────────────────────',
  '❯ Ask TRAE CLI to do anything',
  '──────────────────────────────────────────────────────────',
  '  ? for shortcuts',
].join('\n');

const RESOLVED = SHORTCUT.replace(
  '  ? for shortcuts',
  [
    '  GPT-6-Astra · /tmp/native-control · Context —',
    '  ☢ Full Access · ? for shortcuts · ← for agents',
  ].join('\n'),
);

const readyPattern = createTraexAdapter('/bin/true').readyPattern;

function makeFence(screen = RESOLVED) {
  const h = workerSubmitHarness();

  Object.assign(h.scope, {
    traexNativeStartupInputPending: true,
    traexFirstInputAdmissionPending: true,
    traexNativeStartupHoldLogged: false,

    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    screen,
    nativeState: undefined,

    renderer: {
      // Deliberately models a renderer that still exposes the previous frame.
      rawSnapshot: () => h.scope.screen,
      markNewTurn: vi.fn(),
    },

    cliAdapter: {
      ...h.scope.cliAdapter,
      readyPattern,
    },

    idleDetector: {
      isStartupPending: () => false,
      programStatusHeldWorking: () => false,
      lastProgramStatusReport: () => h.scope.nativeState,
      reset: vi.fn(),
    },

    webTerminalInputGeneration: 0,
    webTerminalInputGenerationAtSpawn: 0,
    webTerminalInputGenerationAtBoundary: 0,
    READY_FLUSH_SETTLE_MS: 1_000,
    webTerminalSubmitGeneration: 0,
    lastWebTerminalInputAtMs: 0,
    lastWebTerminalSubmitAtMs: 0,

    hookReviewInputHold: false,
    heldStuckPage: () => undefined,
    traexQuestionBridgeActive: () => false,

    // Explicit inert implementation for the unrelated submit classifier.
    terminalInputSubmits: () => false,
  });

  h.scope.requeueUnsubmittedQueuedActivation = loadWorkerFunction(
    'requeueUnsubmittedQueuedActivation',
    h.scope,
  );
  h.scope.maybeQueuePostSubmitNativeSessionTitle = loadWorkerFunction(
    'maybeQueuePostSubmitNativeSessionTitle',
    h.scope,
  );
  h.scope.deferTurnInputCommitUntilSubmission = loadWorkerFunction(
    'deferTurnInputCommitUntilSubmission',
    h.scope,
  );

  const pending = loadWorkerFunction<(screen?: string) => boolean>(
    'traexNativeStartupInputIsPending',
    h.scope,
  );

  const noteWebInput = loadWorkerFunction<(data: string, submits?: boolean) => void>(
    'noteWebTerminalInput',
    h.scope,
  );

  return { ...h, pending, noteWebInput };
}

function makeStartupSampler(screen = '') {
  const h = makeFence(screen);
  let admissions = 0;
  Object.assign(h.scope, {
    lastInitConfig: { cliId: 'traex' },
    awaitingFirstPrompt: true,
    FIRST_PROMPT_HARD_TIMEOUT_MS: 90_000,
    traexFirstPromptDeadlineAt: Date.now() + 90_000,
    lastPtyOutputAtMs: 0,
    backendScreenRevision: 100,
    webTerminalInputBackendScreenRevision: 0,
    ptyOutputGeneration: { snapshot: () => 0, isCurrent: () => true },
    traexStartupRendererWebInputGeneration: -1,
    traexStartupRendererScreenRevision: -1,
    traexStartupRendererDrain: undefined,
    traexStartupWebRecheck: undefined,
    TmuxPipeBackend: class {},
    cliName: () => 'TRAE',
    traexNativeStartupInputIsPending: h.pending,
  });
  h.scope.inflightInputs.hasUnacked = () => false;
  h.scope.renderer.writeAndFlush = vi.fn(async () => {});
  h.scope.cliAdapter.startupReadyFromHistory = (value: string) => value === RESOLVED;
  h.scope.idleDetector.observeStartupHistory = vi.fn(() => true);
  const admit = () => {
    if (!h.pending() && h.scope.awaitingFirstPrompt) {
      admissions++;
      h.scope.awaitingFirstPrompt = false;
    }
  };
  h.scope.idleDetector.seedReadyEvidence = admit;
  h.scope.markPromptReady = admit;
  h.scope.flushPending = vi.fn(async () => {});
  const sample = loadWorkerFunction<(backend: unknown) => void>(
    'scheduleTraexFirstPromptReadiness', h.scope,
  );
  const input = new WebTerminalInputController({
    capture: () => h.scope.backend,
    isCurrent: target => target === h.scope.backend,
    beforeUserInput: async () => true,
    write: () => true,
    onUserInput: (_target, data, submits) => h.noteWebInput(data, submits),
  });
  h.scope.pendingWebTerminalInput = () => input.pending;
  return { ...h, sample, input, admissions: () => admissions };
}

describe('Web startup protocol activity and recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not count a complete terminal background-color reply as human activity', async () => {
    const h = makeStartupSampler(RESOLVED);
    await h.input.accept('\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\');
    expect(h.scope.webTerminalInputGeneration).toBe(0);
    expect(h.scope.lastWebTerminalInputAtMs).toBe(0);
    expect(h.scope.webTerminalSubmitGeneration).toBe(0);
  });

  it('holds first-input admission while a web socket still buffers an undecided prefix', async () => {
    const h = makeStartupSampler(RESOLVED);
    h.scope.nativeState = 'idle';
    expect(h.pending()).toBe(false);
    await h.input.accept('\x1b');
    expect(h.input.pending).toBe(true);
    expect(h.pending()).toBe(true);
  });

  it('continues sampling a late initialized composer after one no-op human key', async () => {
    const h = makeStartupSampler();
    h.sample(h.scope.backend);
    h.noteWebInput('\x1b[A');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.admissions()).toBe(0);
    h.scope.screen = RESOLVED;
    h.scope.nativeState = 'idle';
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.admissions()).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.admissions()).toBe(1);
  });

  it('admits once when initialized while automatic color replies keep arriving', async () => {
    const h = makeStartupSampler(RESOLVED);
    h.scope.nativeState = 'idle';
    h.sample(h.scope.backend);
    for (let i = 0; i < 12; i++) {
      await h.input.accept('\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\');
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(h.admissions()).toBe(1);
    expect(h.scope.webTerminalInputGeneration).toBe(0);
  });

  it('rechecks after a transient renderer drain rejection without releasing stale evidence', async () => {
    const h = makeStartupSampler(RESOLVED);
    h.scope.nativeState = 'idle';
    h.noteWebInput('\x1b[A');
    await vi.advanceTimersByTimeAsync(4_000);
    h.scope.renderer.writeAndFlush = vi.fn()
      .mockRejectedValueOnce(new Error('transient fixture drain'))
      .mockResolvedValue(undefined);
    expect(h.pending()).toBe(true);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(h.admissions()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.scope.renderer.writeAndFlush).toHaveBeenCalledTimes(2);
    expect(h.admissions()).toBe(1);
  });

  it('stops failed renderer drain recovery at the original startup deadline despite Web input at 89 seconds', async () => {
    const h = makeStartupSampler(RESOLVED);
    const startedAt = Date.now();
    const deadline = h.scope.traexFirstPromptDeadlineAt;
    const drainTimes: number[] = [];
    const head = h.scope.pendingMessages[0];
    h.scope.nativeState = 'idle';
    h.scope.renderer.writeAndFlush = vi.fn(async () => {
      drainTimes.push(Date.now());
      throw new Error('fixture renderer remains unavailable');
    });

    // First fail inside this spawn's fixed window. Later Web activity must
    // invalidate evidence, not grant another 90 seconds to renderer recovery.
    await vi.advanceTimersByTimeAsync(80_000);
    h.noteWebInput('\x1b[A');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.pending()).toBe(true);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(h.scope.renderer.writeAndFlush).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(Date.now() - startedAt).toBe(89_000);
    h.noteWebInput('\x1b[A');
    expect(h.pending()).toBe(true);
    expect(h.scope.traexFirstPromptDeadlineAt).toBe(deadline);
    await vi.advanceTimersByTimeAsync(1_000);
    const drainsAtDeadline = h.scope.renderer.writeAndFlush.mock.calls.length;

    expect(vi.getTimerCount()).toBe(0);
    expect(h.scope.traexStartupWebRecheck).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.scope.renderer.writeAndFlush).toHaveBeenCalledTimes(drainsAtDeadline);
    expect(drainTimes.every(at => at < deadline)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.admissions()).toBe(0);
    expect(h.scope.pendingMessages[0]).toBe(head);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
  });

  // A drain that settles after the 90s notice still carries current evidence
  // (same screen revision, same Web epoch) and the admission re-reads the
  // screen right then. Refusing it would strand the queued first input for
  // good once anyone touched the terminal the notice points them to.
  it.each([false, true])('admits on current evidence when a drain resolves after the deadline (firstSubmitConfirmed=%s)', async confirmed => {
    const h = makeStartupSampler(RESOLVED);
    const head = h.scope.pendingMessages[0];
    h.scope.nativeState = 'idle';
    h.scope.traexFirstSubmitConfirmed = confirmed;
    h.scope.traexFirstPromptDeadlineAt = 90_000;
    let finish!: () => void;
    h.scope.renderer.writeAndFlush = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    h.scope.markPromptReady = vi.fn();
    h.scope.flushPending = vi.fn(() => h.flush());

    vi.setSystemTime(88_000);
    h.noteWebInput('\x1b[A');
    h.scope.backendScreenRevision += 1;
    vi.setSystemTime(89_000);
    expect(h.pending()).toBe(true);
    expect(h.scope.renderer.writeAndFlush).toHaveBeenCalledTimes(1);

    vi.setSystemTime(91_000);
    finish();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await h.flush();

    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages).toHaveLength(0);
    expect(h.scope.pendingMessages).not.toContain(head);
    // This harness's write stays unconfirmed: its first-input lease remains.
    expect(h.scope.traexFirstInputAdmissionPending).toBe(!confirmed);
    expect(h.scope.traexStartupWebRecheck).toBeUndefined();
  });

  it('does not admit or keep retrying past the deadline when the screen moved during a late drain', async () => {
    const h = makeStartupSampler(RESOLVED);
    const head = h.scope.pendingMessages[0];
    h.scope.nativeState = 'idle';
    h.scope.traexFirstSubmitConfirmed = false;
    h.scope.traexFirstPromptDeadlineAt = 90_000;
    let finish!: () => void;
    h.scope.renderer.writeAndFlush = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    h.scope.markPromptReady = vi.fn();
    h.scope.flushPending = vi.fn(() => h.flush());

    vi.setSystemTime(88_000);
    h.noteWebInput('\x1b[A');
    h.scope.backendScreenRevision += 1;
    vi.setSystemTime(89_000);
    expect(h.pending()).toBe(true);
    vi.setSystemTime(91_000);
    h.scope.backendScreenRevision += 1;
    finish();
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages[0]).toBe(head);
    expect(h.scope.traexStartupWebRecheck).toBeUndefined();
  });

  it('re-drives a stale late drain after an owned receipt extends its already-captured deadline', async () => {
    const h = makeStartupSampler(RESOLVED);
    h.scope.nativeState = 'idle';
    h.scope.traexFirstSubmitConfirmed = false;
    h.scope.traexFirstPromptDeadlineAt = 90_000;
    let finish!: () => void;
    h.scope.renderer.writeAndFlush = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
      .mockResolvedValue(undefined);
    h.scope.flushPending = vi.fn(async () => { h.pending(); });

    vi.setSystemTime(88_000);
    h.noteWebInput('\x1b[A');
    h.scope.backendScreenRevision += 1;
    vi.setSystemTime(89_000);
    expect(h.pending()).toBe(true);
    expect(h.scope.renderer.writeAndFlush).toHaveBeenCalledTimes(1);

    vi.setSystemTime(89_500);
    const quarantine = {
      backend: h.scope.backend,
      generation: h.scope.cliSpawnGeneration,
      draftContent: 'first', turnId: 'first', dispatchAttempt: 1,
    };
    h.scope.inputDeliveryQuarantine = quarantine;
    const release = loadWorkerFunction<(q: unknown, reason: string, opts: { redriveTerminal: boolean }) => boolean>(
      'releaseInputDeliveryQuarantine', h.scope);
    expect(release(quarantine, 'owned late submit receipt', { redriveTerminal: true })).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    // The old frame changes during the drain and is correctly rejected. The
    // receipt must nevertheless let the finally arm a fresh post-90s retry.
    vi.setSystemTime(91_000);
    h.scope.backendScreenRevision += 1;
    finish();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(h.scope.traexStartupWebRecheck).toBeDefined();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.scope.renderer.writeAndFlush).toHaveBeenCalledTimes(2);
    expect(h.admissions()).toBe(1);
    expect(h.scope.traexStartupWebRecheck).toBeUndefined();
  });

  it('recovers a transient renderer drain within the fixed startup deadline', async () => {
    const h = makeStartupSampler(RESOLVED);
    const deadline = h.scope.traexFirstPromptDeadlineAt;
    const drainTimes: number[] = [];
    h.scope.nativeState = 'idle';
    h.scope.renderer.writeAndFlush = vi.fn()
      .mockImplementationOnce(async () => {
        drainTimes.push(Date.now());
        throw new Error('fixture transient renderer failure');
      })
      .mockImplementation(async () => { drainTimes.push(Date.now()); });

    await vi.advanceTimersByTimeAsync(80_000);
    h.noteWebInput('\x1b[A');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.pending()).toBe(true);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(h.admissions()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.scope.renderer.writeAndFlush).toHaveBeenCalledTimes(2);
    expect(drainTimes.every(at => at < deadline)).toBe(true);
    expect(h.admissions()).toBe(1);
    expect(h.scope.traexFirstPromptDeadlineAt).toBe(deadline);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.admissions()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks a new frame after the screen changes during the renderer drain', async () => {
    const h = makeStartupSampler(RESOLVED);
    h.scope.nativeState = 'idle';
    h.noteWebInput('\x1b[A');
    await vi.advanceTimersByTimeAsync(4_000);
    let finish!: () => void;
    h.scope.renderer.writeAndFlush = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
      .mockResolvedValue(undefined);
    expect(h.pending()).toBe(true);
    h.scope.backendScreenRevision++;
    finish();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(h.admissions()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.scope.renderer.writeAndFlush).toHaveBeenCalledTimes(2);
    expect(h.admissions()).toBe(1);
  });

  it('does not let a stale sampler admit a replacement backend', async () => {
    const h = makeStartupSampler();
    h.sample(h.scope.backend);
    h.scope.backend = {};
    h.scope.cliSpawnGeneration++;
    h.scope.screen = RESOLVED;
    h.scope.nativeState = 'idle';
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.admissions()).toBe(0);
    expect(h.scope.renderer.writeAndFlush).not.toHaveBeenCalled();
  });

  it('discards a drained sample if human input arrives across its await, then resamples', async () => {
    const h = makeStartupSampler(RESOLVED);
    h.scope.nativeState = 'idle';
    let finish!: () => void;
    h.scope.renderer.writeAndFlush = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
      .mockResolvedValue(undefined);
    h.sample(h.scope.backend);
    await vi.advanceTimersByTimeAsync(1_000);
    h.noteWebInput('\x1b[A');
    finish();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(h.admissions()).toBe(0);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.admissions()).toBe(1);
  });

  it('does not run a drain retry against a renderer replacement', async () => {
    const h = makeStartupSampler(RESOLVED);
    h.scope.nativeState = 'idle';
    h.noteWebInput('\x1b[A');
    await vi.advanceTimersByTimeAsync(4_000);
    h.scope.renderer.writeAndFlush = vi.fn().mockRejectedValue(new Error('transient fixture'));
    expect(h.pending()).toBe(true);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const replacement = { rawSnapshot: () => RESOLVED, writeAndFlush: vi.fn(async () => {}) };
    h.scope.renderer = replacement;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.admissions()).toBe(0);
    expect(replacement.writeAndFlush).not.toHaveBeenCalled();
  });

  it('retains a human draft after recovering a failed drain', async () => {
    const h = makeStartupSampler(RESOLVED);
    h.scope.nativeState = 'idle';
    h.noteWebInput('human draft');
    await vi.advanceTimersByTimeAsync(4_000);
    h.scope.renderer.writeAndFlush = vi.fn()
      .mockRejectedValueOnce(new Error('transient fixture'))
      .mockResolvedValue(undefined);
    expect(h.pending()).toBe(true);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    h.scope.screen = RESOLVED.replace('❯ Ask TRAE CLI to do anything', '❯ human draft');
    h.scope.backendScreenRevision++;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.admissions()).toBe(0);
    expect(h.pending()).toBe(true);
  });

  it('rechecks released input ownership without creating another startup poller', async () => {
    const h = makeStartupSampler();
    h.scope.scheduleTraexFirstPromptReadiness = h.sample;
    h.scope.webTerminalInputTargetCurrent = () => true;
    const recheck = loadWorkerFunction<(target: unknown, ws: unknown) => void>(
      'recheckAfterWebInput', h.scope,
    );
    const target = { backend: h.scope.backend };
    h.sample(h.scope.backend);
    expect(vi.getTimerCount()).toBe(1);
    for (let i = 0; i < 20; i++) recheck(target, {});
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100_000);
    // Past the 90s warning deadline the single observation poller slows down
    // rather than stopping permanently, and drops to zero once retired.
    expect(vi.getTimerCount()).toBe(1);
    expect(h.admissions()).toBe(0);
    h.scope.closeRequested = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('fresh TraeX startup input ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not retire the fence from an old empty resolved footer after Web input changed', () => {
    const h = makeFence(RESOLVED);

    // Human input is newer than the renderer frame.
    h.noteWebInput('human draft');

    expect(h.scope.webTerminalInputGeneration).toBe(1);

    // Safety invariant: a pre-input empty frame must not retire ownership.
    //
    expect(h.pending()).toBe(true);
    expect(h.scope.traexNativeStartupInputPending).toBe(true);
  });

  it('revalidates Web ownership after settleInputBox awaits', async () => {
    const h = makeFence(RESOLVED);

    let releaseSettle!: () => void;
    const settleWait = new Promise<void>(resolve => {
      releaseSettle = resolve;
    });

    h.scope.openingInputBoxSettled = false;
    h.scope.inputBoxJudgeable = () => true;
    h.scope.cliAdapter.settleInputBox = vi.fn(async () => {
      await settleWait;
      return false;
    });
    h.scope.cliAdapter.writeInput = vi.fn(async () => ({
      submitted: true,
    }));

    const running = h.flush();

    // flushPending passed the startup check and is now across a real await.
    expect(h.scope.cliAdapter.settleInputBox).toHaveBeenCalledTimes(1);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();

    // A human takes the composer while settleInputBox is outstanding.
    h.noteWebInput('human owns composer now');
    releaseSettle();

    await running;

    // Safety invariant: the changed generation must force a fresh admission,
    // leaving the queued BotMux item untouched.
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toHaveLength(1);
  });

  it('isolates the remaining queue when Web input arrives during the first batched write', async () => {
    const h = makeFence(RESOLVED);

    h.scope.pendingMessages.push({
      turnId: 'delivery-2',
      dispatchAttempt: 2,
      content: 'second payload',
    });

    // Permit the production batching loop to consider a second item.
    h.scope.shouldStopPendingBatch = () => false;
    h.scope.runtimePtyInputPolicy = () => ({
      supportsTypeAhead: true,
      allowBackToBackWrites: true,
    });

    let releaseFirstWrite!: () => void;
    const firstWriteWait = new Promise<void>(resolve => {
      releaseFirstWrite = resolve;
    });

    let writes = 0;
    h.scope.cliAdapter.writeInput = vi.fn(async () => {
      writes++;
      if (writes === 1) await firstWriteWait;
      return { submitted: true };
    });

    const running = h.flush();

    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);

    // Manual intervention occurs while the first adapter write is unsettled.
    h.noteWebInput('manual terminal intervention');
    releaseFirstWrite();

    await running;

    // Safety invariant: manual input terminates this batch. The second queued
    // item must wait for a fresh empty-composer admission.
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages.map(
      (item: { content: string }) => item.content,
    )).toEqual(['second payload']);
    await vi.advanceTimersByTimeAsync(h.scope.READY_FLUSH_SETTLE_MS);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages).toHaveLength(1);
  });

  it('does not continue an old startup timeout chain during generation restart', async () => {
    const h = makeFence(SHORTCUT);
    const hardCap = CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS;

    Object.assign(h.scope, {
      awaitingFirstPrompt: true,
      firstPromptBackend: h.scope.backend,
      firstPromptGeneration: h.scope.cliSpawnGeneration,
      cfg: {
        cliId: 'traex',
        resume: false,
      },

      holdFirstPromptForStartupBlocker: () => false,
      FIRST_PROMPT_HARD_TIMEOUT_MS: hardCap,
      FIRST_PROMPT_STARTUP_RECHECK_MS: 1_000,

      adapterInputBoxReady: () => true,
      shouldReleaseFirstPromptTimeout: () => true,
      awaitingPostSessionStartPromptEvidence: false,

      clearPostHookEvidenceFallback: vi.fn(),
      cancelFirstFlushSettle: vi.fn(),
      decideHardTimeoutAction: () => 'flush',
      shouldArmFirstPromptTimeoutPromptSeed: () => false,
      flushPending: vi.fn(),
    });

    const timeout = loadWorkerFunction<
      (elapsedMs: number, forced: boolean) => void
    >('releaseFirstPromptTimeout', h.scope);

    timeout(0, false);
    expect(vi.getTimerCount()).toBe(1);

    // Model asynchronous teardown: restart is active while the old backend
    // reference and awaiting-first-prompt state have not yet been retired.
    h.scope.cliRestartInProgress = true;

    await vi.advanceTimersByTimeAsync(hardCap);

    // An old-generation timer must neither flush nor issue a current-session
    // initialization warning while restart owns the lifecycle.
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    expect(
      h.scope.send.mock.calls.filter(
        ([event]: [{ type: string }]) => event.type === 'user_notify',
      ),
    ).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the queue intact when restart begins during settleInputBox', async () => {
    const h = makeFence(RESOLVED);

    let releaseSettle!: () => void;
    const settleWait = new Promise<void>(resolve => {
      releaseSettle = resolve;
    });

    h.scope.openingInputBoxSettled = false;
    h.scope.inputBoxJudgeable = () => true;
    h.scope.cliAdapter.settleInputBox = vi.fn(async () => {
      await settleWait;
      return false;
    });
    h.scope.cliAdapter.writeInput = vi.fn(async () => ({
      submitted: true,
    }));

    const running = h.flush();
    expect(h.scope.cliAdapter.settleInputBox).toHaveBeenCalledTimes(1);

    h.scope.cliRestartInProgress = true;
    h.scope.cliSpawnGeneration++;
    releaseSettle();

    await running;

    // This probes the existing post-settle backend/generation fence. It is
    // included to prevent a repair of the Web-input race from regressing the
    // restart boundary.
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toHaveLength(1);
  });
});
