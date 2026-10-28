import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

/**
 * Caller-level guards for framed stdin runner raw passthrough (PR #2202).
 * throwing an error from the raw writer is not isolation by itself. The two
 * REAL dispatch callers must fence the runner generation (exit) on an unsafe
 * framed submit instead of merely notifying / moving on to the next command.
 */
class SubmissionWriteError extends Error {
  constructor(
    message: string,
    readonly recoveryFailureReason?: string,
    readonly submissionStarted = true,
    readonly runnerGenerationUnsafe = false,
  ) {
    super(message);
    this.name = 'SubmissionWriteError';
  }
}

const unsafe = () => new SubmissionWriteError('dirty', 'runner_frame_submit_ambiguous', true, true);

describe('runStartupCommands — framed dirty submit fences the generation', () => {
  function load(deps: { fenceThrows: 'unsafe' | 'clean' }) {
    const fatalExit = vi.fn(async () => {});
    const commands = ['/a', '/b'];
    let cursor = 0;
    const scope: Record<string, unknown> = {
      SubmissionWriteError,
      classifyRawDispatchFailure: (e: unknown) => {
        if (e instanceof SubmissionWriteError && e.runnerGenerationUnsafe) return 'fence-generation';
        return 'notify';
      },
      lastInitConfig: { startupCommands: commands, adoptMode: false },
      backend: { id: 'pane' },
      isRemoteBackendType: () => false,
      effectiveBackendType: 'pty',
      startupCommandAckHold: null,
      clearStartupCommandAckHold: vi.fn(),
      cliAdapter: undefined,
      cliRestartInProgress: false,
      ptyOutputGeneration: { snapshot: () => 1 },
      awaitPtyQuiescence: vi.fn(async () => {}),
      delay: vi.fn(async () => {}),
      isPromptReady: false,
      idleDetector: { reset: vi.fn() },
      sendFatalWorkerErrorAndExit: fatalExit,
      log: vi.fn(),
      sendRawCommandLineWithRecoveryFence: vi.fn(async () => {
        if (deps.fenceThrows === 'unsafe') throw unsafe();
        // clean failure on first command, success on the next
        if (cursor === 0) { cursor++; throw new Error('backend rejected'); }
      }),
      startupCommandExecuted: vi.fn(() => true),
      holdForStartupCommandAck: vi.fn(),
      STARTUP_CMD_ACK_POLL_MS: 1,
      STARTUP_CMD_ACK_TIMEOUT_MS: 5,
    };
    Object.defineProperty(scope, 'startupCommandCursor', {
      get: () => cursor,
      set: (v: number) => { cursor = v; },
    });
    Object.defineProperty(scope, 'startupCommandsInProgress', {
      get: () => false,
      set: () => {},
    });
    let generation = 1;
    Object.defineProperty(scope, 'cliSpawnGeneration', { get: () => generation });
    const run = loadWorkerFunction<() => Promise<boolean>>('runStartupCommands', scope);
    return { run, fatalExit, getCursor: () => cursor };
  }

  it('aborts the command list and exits the worker on an unsafe framed submit', async () => {
    const { run, fatalExit, getCursor } = load({ fenceThrows: 'unsafe' });
    const ok = await run();
    expect(ok).toBe(false);
    expect(fatalExit).toHaveBeenCalledTimes(1);
    expect(fatalExit.mock.calls[0]![0]).toBeInstanceOf(SubmissionWriteError);
    // Never advanced to /b.
    expect(getCursor()).toBe(0);
  });

  it('a clean (safe) failure keeps the legacy skip-and-continue behavior', async () => {
    const { run, fatalExit, getCursor } = load({ fenceThrows: 'clean' });
    const ok = await run();
    expect(ok).toBe(true);
    expect(fatalExit).not.toHaveBeenCalled();
    expect(getCursor()).toBe(2);
  });
});

describe('deliverRawInput — framed dirty submit fences before any further dispatch', () => {
  it('calls sendFatalWorkerErrorAndExit and stops dispatch before further scheduling', async () => {
    // sendFatalWorkerErrorAndExit ends with process.exit in production; it
    // never returns. Simulate that so code after it cannot run.
    const fatalExit = vi.fn(async () => { throw new Error('__worker_exits__'); });
    const send = vi.fn();
    const scope: Record<string, unknown> = {
      SubmissionWriteError,
      classifyRawDispatchFailure: (e: unknown) =>
        (e instanceof SubmissionWriteError && e.runnerGenerationUnsafe)
          ? 'fence-generation'
          : 'notify',
      isWorkflowWorker: vi.fn(() => false),
      sendFatalWorkerErrorAndExit: fatalExit,
      send,
      log: vi.fn(),
      disarmEffortConfirm: vi.fn(),
      disarmBtwCapture: vi.fn(),
      emitTurnTerminal: vi.fn(),
      t: vi.fn((key: string) => key),
      scheduleSubmitFailureNotify: vi.fn(),
      backend: { id: 'pane' },
      lastInitConfig: { adoptMode: false },
      pendingRawInputs: [],
      sendRawCommandLineWithRecoveryFence: vi.fn(async () => { throw unsafe(); }),
      finalizeRawCommandDelivery: vi.fn(() => { throw new Error('must not finalize after fence'); }),
      flushPending: vi.fn(),
      activeTurnAuthority: { inheritOrStartControl: vi.fn(() => true) },
      setCaptureIdentity: vi.fn(),
      markTurnExecutionStart: vi.fn(),
      stampMojoTurnMark: vi.fn(),
      writeCliPidMarker: vi.fn(),
      publishSandboxRelayCapability: vi.fn(),
      markNewTurn: vi.fn(),
      usageLimitTracker: { beginTurn: vi.fn() },
    };
    const deliver = loadWorkerFunction<(msg: unknown) => Promise<void>>('deliverRawInput', scope);
    await expect(deliver({ content: '/goal hi' })).rejects.toThrow('__worker_exits__');

    expect(fatalExit).toHaveBeenCalledTimes(1);
    expect(fatalExit.mock.calls[0]![0]).toBeInstanceOf(SubmissionWriteError);
    // Dispatch stops at the fence: no card, no terminal, no delivery finalize,
    // no post-dispatch queue flush.
    expect(send).not.toHaveBeenCalled();
    expect(scope.emitTurnTerminal).not.toHaveBeenCalled();
    expect(scope.finalizeRawCommandDelivery).not.toHaveBeenCalled();
    expect(scope.flushPending).not.toHaveBeenCalled();
  });

  // P2-2: a goal-input write failure inside a v3 workflow worker must fail the
  // node immediately (error IPC) instead of hanging until the wall deadline.
  function buildWorkflowScope(isWorkflow: boolean, errorToThrow: unknown) {
    const fatalExit = vi.fn(async () => { throw new Error('__worker_exits__'); });
    const send = vi.fn();
    const finalize = vi.fn(() => true);
    const classifier = vi.fn((e: unknown) => {
      if (e instanceof SubmissionWriteError && e.runnerGenerationUnsafe) return 'fence-generation';
      if (e instanceof SubmissionWriteError && e.generationAlreadyFenced) return 'generation-fenced';
      return isWorkflow ? 'workflow-node-fail' : 'notify';
    });
    const scope: Record<string, unknown> = {
      SubmissionWriteError,
      cliName: () => 'minimax',
      classifyRawDispatchFailure: classifier,
      isWorkflowWorker: vi.fn(() => isWorkflow),
      sendFatalWorkerErrorAndExit: fatalExit,
      send,
      log: vi.fn(),
      disarmEffortConfirm: vi.fn(),
      disarmBtwCapture: vi.fn(),
      emitTurnTerminal: vi.fn(),
      t: vi.fn((key: string) => key),
      scheduleSubmitFailureNotify: vi.fn(),
      recoveryFailureReason: undefined,
      backend: { id: 'pane' },
      lastInitConfig: { adoptMode: false },
      pendingRawInputs: [],
      sendRawCommandLineWithRecoveryFence: vi.fn(async () => { throw errorToThrow; }),
      finalizeRawCommandDelivery: finalize,
      flushPending: vi.fn(),
      activeTurnAuthority: { inheritOrStartControl: vi.fn(() => true) },
      setCaptureIdentity: vi.fn(),
      markTurnExecutionStart: vi.fn(),
      stampMojoTurnMark: vi.fn(),
      writeCliPidMarker: vi.fn(),
      publishSandboxRelayCapability: vi.fn(),
      markNewTurn: vi.fn(),
      inflightInputs: { forget: vi.fn(), retrieve: vi.fn() },
      usageLimitTracker: { beginTurn: vi.fn() },
    };
    return { scope, fatalExit, send, classifier };
  }

  it('P2-2: workflow worker goal-input write failure → immediate error IPC, no hang, no user card', async () => {
    // A CLEAN (non-unsafe) failure: the line never typed (untouched pre-flush),
    // so no generation fence — but in a workflow node it must still fail fast.
    const cleanError = new SubmissionWriteError('clean reject', undefined, false);
    const { scope, fatalExit, send } = buildWorkflowScope(true, cleanError);
    const deliver = loadWorkerFunction<(msg: unknown) => Promise<void>>('deliverRawInput', scope);
    await deliver({ content: '/goal hi' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ type: 'error' });
    expect(String(send.mock.calls[0]![0].message)).toContain('workflow goal input dispatch failed');
    // No fatal generation exit (clean failure, runner is not unsafe)…
    expect(fatalExit).not.toHaveBeenCalled();
    // …no user-facing terminal/card, no finalize, no ordinary queue flush.
    expect(scope.emitTurnTerminal).not.toHaveBeenCalled();
    expect(scope.finalizeRawCommandDelivery).not.toHaveBeenCalled();
    expect(scope.flushPending).not.toHaveBeenCalled();
  });

  it('P2-2 对照：非 workflow worker 的同样干净失败走通知路径，不发 workflow error IPC', async () => {
    const cleanError = new SubmissionWriteError('clean reject', undefined, false);
    const { scope, send } = buildWorkflowScope(false, cleanError);
    const deliver = loadWorkerFunction<(msg: unknown) => Promise<void>>('deliverRawInput', scope);
    await deliver({ content: '/goal hi' });

    const errorIpc = send.mock.calls.map(c => c![0]).some(m => m?.type === 'error');
    expect(errorIpc).toBe(false);
    // Ordinary interactive path surfaces a user_notify.
    const userNotify = send.mock.calls.map(c => c![0]).some(m => m?.type === 'user_notify');
    expect(userNotify).toBe(true);
  });
});
