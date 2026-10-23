import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

/**
 * Caller-level guards for review finding
 * om_x100b6284c51fc0b4b1e57cbf7ef2b60/cli_aaacc9cb7f39dce4/02:
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
});
