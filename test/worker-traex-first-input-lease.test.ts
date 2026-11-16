import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const RESOLVED = [
  '  █ ◆ ◆ █  TRAE CLI (v0.214.1)',
  '  /tmp/native-control',
  '  permissions: YOLO mode',
  '──────────────────────────────────────────────────────────',
  '❯ Ask TRAE CLI to do anything',
  '──────────────────────────────────────────────────────────',
  '  GPT-6-Astra · /tmp/native-control · Context —',
  '  ☢ Full Access · ? for shortcuts · ← for agents',
].join('\n');

// xterm.js forwards these once TraeX 0.214.1 enables focus reporting (?1004h).
// They own no composer text, and a quiet TraeX frame may draw nothing for them.
const FOCUS_OUT = '\x1b[O';
const FOCUS_IN = '\x1b[I';

/** Real flushPending / startup fence / Web input recorder over a fresh,
 * already initialized TraeX composer whose first-write lease is still armed. */
function leaseHarness() {
  const h = workerSubmitHarness();
  Object.assign(h.scope, {
    traexNativeStartupInputPending: true,
    traexFirstInputAdmissionPending: true,
    traexFirstSubmitConfirmed: false,
    traexStartupWebRecheck: undefined,
    traexNativeStartupHoldLogged: false,
    traexStartupRendererWebInputGeneration: -1,
    traexStartupRendererScreenRevision: -1,
    traexStartupRendererDrain: undefined,
    replacementSpawnInProgress: false,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    backendScreenRevision: 100,
    webTerminalInputBackendScreenRevision: 0,
    screen: RESOLVED,
    nativeState: 'idle',
    renderer: {
      rawSnapshot: () => h.scope.screen,
      markNewTurn: vi.fn(),
      writeAndFlush: vi.fn(async () => {}),
    },
    cliAdapter: { ...h.scope.cliAdapter, readyPattern: createTraexAdapter('/bin/true').readyPattern },
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
    terminalInputSubmits: (data: string) => /[\r\n]/.test(data),
    // Prompt-ready itself is not under test; its only job here is that a
    // re-drive reaches the real flushPending below.
    markPromptReady: vi.fn(),
  });
  for (const name of ['requeueUnsubmittedQueuedActivation', 'maybeQueuePostSubmitNativeSessionTitle', 'deferTurnInputCommitUntilSubmission']) {
    h.scope[name] = loadWorkerFunction(name, h.scope);
  }
  const pending = loadWorkerFunction<(screen?: string) => boolean>('traexNativeStartupInputIsPending', h.scope);
  const noteWebInput = loadWorkerFunction<(data: string) => void>('noteWebTerminalInput', h.scope);
  h.scope.flushPending = vi.fn(() => h.flush());
  h.scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: true }));
  return { ...h, pending, noteWebInput };
}

describe('TraeX first-write lease after Web terminal input', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z')); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('writes the first message and ends the lease when no Web input happened', async () => {
    const h = leaseHarness();
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.traexFirstInputAdmissionPending).toBe(false);
  });

  it('admits after a renderer drain once a focus report is followed by screen data', async () => {
    const h = leaseHarness();
    h.noteWebInput(FOCUS_OUT);
    h.scope.backendScreenRevision += 1;
    await vi.advanceTimersByTimeAsync(1_001);
    await h.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
  });

  it('re-drives a hold after Web input that draws nothing', async () => {
    const h = leaseHarness();
    // Startup was verified; the queued first write has not happened yet.
    expect(h.pending()).toBe(false);
    expect(h.scope.traexFirstInputAdmissionPending).toBe(true);

    h.noteWebInput(FOCUS_OUT);
    await h.flush();
    // The input still gets its settle window before any write.
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    // No later PTY data and no other trigger: the hold must re-drive itself.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages).toHaveLength(0);
  });

  it('re-drives a flush that arrived inside the settle window while the screen keeps changing', async () => {
    const h = leaseHarness();
    expect(h.pending()).toBe(false);
    // TraeX's startup banner animates its logo while visible. Under OSC
    // authority those bytes do not re-run idle, so they cannot re-drive.
    const animation = setInterval(() => { h.scope.backendScreenRevision += 1; }, 1_400);
    h.noteWebInput(FOCUS_OUT);
    await vi.advanceTimersByTimeAsync(300);
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    clearInterval(animation);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages).toHaveLength(0);
  });

  it('ends the lease after a confirmed first submit even when a focus report raced the write', async () => {
    const h = leaseHarness();
    let writes = 0;
    h.scope.cliAdapter.writeInput = vi.fn(async () => {
      writes++;
      if (writes === 1) h.noteWebInput(FOCUS_IN);
      return { submitted: true };
    });
    await h.flush();
    expect(writes).toBe(1);
    // The racing input still requires one fresh admission before the next write.
    expect(h.scope.traexFirstInputAdmissionPending).toBe(true);

    // The first turn runs and finishes with plenty of screen output.
    h.scope.backendScreenRevision += 500;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.pending()).toBe(true); // drains the renderer behind the Web epoch
    await vi.advanceTimersByTimeAsync(0);
    expect(h.pending()).toBe(false);
    expect(h.scope.traexFirstInputAdmissionPending).toBe(false);

    // Later focus changes no longer gate ordinary follow-ups.
    h.noteWebInput(FOCUS_OUT);
    h.scope.pendingMessages.push({ turnId: 'delivery-2', dispatchAttempt: 1, content: 'follow-up' });
    await h.flush();
    expect(writes).toBe(2);
    expect(h.scope.pendingMessages).toHaveLength(0);
  });

  it('ends the lease after a deferred recheck confirms the first submit', async () => {
    const h = leaseHarness();
    h.scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: false, recheck: h.recheck }));
    h.recheck.mockImplementation(async () => true);
    await h.flush();
    expect(h.scope.traexFirstInputAdmissionPending).toBe(true);
    await vi.advanceTimersByTimeAsync(h.scope.SUBMIT_DEFERRED_RECHECK_MS * 3);
    expect(h.settlements[0]?.lifecycle).toBe('confirmed');
    // The next passing admission retires the lease instead of every later turn
    // staying behind the first-input fence.
    expect(h.pending()).toBe(false);
    expect(h.scope.traexFirstInputAdmissionPending).toBe(false);
  });

  it('never re-drives a held input from a recheck timer whose spawn generation was replaced', async () => {
    const h = leaseHarness();
    h.noteWebInput(FOCUS_OUT);
    await h.flush();
    expect(h.scope.traexStartupWebRecheck).toBeDefined();
    // A restart installs a new CLI generation before the quiet window elapses.
    h.scope.cliSpawnGeneration++;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scope.markPromptReady).not.toHaveBeenCalled();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
  });

  it('never re-drives a held input from a recheck timer during teardown without a replacement', async () => {
    const h = leaseHarness();
    h.noteWebInput(FOCUS_OUT);
    await h.flush();
    expect(h.scope.traexStartupWebRecheck).toBeDefined();
    h.scope.cliRestartInProgress = true;
    h.scope.replacementSpawnInProgress = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scope.markPromptReady).not.toHaveBeenCalled();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
  });
});
