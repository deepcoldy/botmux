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

  const noteWebInput = loadWorkerFunction<(data: string) => void>(
    'noteWebTerminalInput',
    h.scope,
  );

  return { ...h, pending, noteWebInput };
}

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
