import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { rewrapSubmissionFailure } from '../src/core/raw-dispatch-failure.js';

/**
 * Behavior guard for framed stdin runner raw passthrough (PR #2202):
 * a raw passthrough line must be delivered through the
 * adapter's writeInput submit transaction (pre-flush / retry / disposition),
 * never typed literally — and an unconfirmed frame must quarantine the
 * generation instead of being reported as accepted.
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

interface SendRawDeps {
  runnerFramedInput?: boolean;
  writeInput?: ReturnType<typeof vi.fn>;
}

function loadSender(deps: SendRawDeps) {
  const writeInput = deps.writeInput ?? vi.fn(async () => {});
  const cliAdapter = {
    ...(deps.runnerFramedInput !== undefined ? { runnerFramedInput: deps.runnerFramedInput } : {}),
    writeInput,
  };
  const scope: Record<string, unknown> = {
    cliAdapter,
    SubmissionWriteError,
    // Framed branch must never reach the generic literal writer.
    writeRawCommandLine: vi.fn(async () => { throw new Error('generic writer must not be used'); }),
    rawCommandWriteOptionsFor: vi.fn(() => { throw new Error('raw options must not be used'); }),
    lastInitConfig: { cliId: 'minimax' },
    isWorkflowWorker: vi.fn(() => false),
    send: vi.fn(),
    log: vi.fn(),
  };
  return {
    sendRaw: loadWorkerFunction<(be: unknown, content: string, opts?: { submit?: boolean; turnId?: string }) => Promise<void>>(
      'sendRawCommandLine',
      scope,
    ),
    writeInput,
    genericWrite: scope.writeRawCommandLine as ReturnType<typeof vi.fn>,
  };
}

describe('sendRawCommandLine — framed stdin runner isolation', () => {
  it('preserves the MiniMax compact turn ID in the submitted frame context', async () => {
    const { sendRaw, writeInput } = loadSender({ runnerFramedInput: true });
    const backend = { id: 'pane' };
    await sendRaw(backend, '/compact', { turnId: 'compact-click' });
    expect(writeInput).toHaveBeenCalledWith(backend, '/compact', { turnId: 'compact-click' });
  });
  it('frames through adapter.writeInput and never types the line literally', async () => {
    const { sendRaw, writeInput, genericWrite } = loadSender({ runnerFramedInput: true });
    const backend = { id: 'pane' };
    const objective = 'Read $BOTMUX_GOAL_PATH. Complete it.';

    await sendRaw(backend, objective);

    expect(writeInput).toHaveBeenCalledTimes(1);
    expect(writeInput).toHaveBeenCalledWith(backend, objective);
    expect(genericWrite).not.toHaveBeenCalled();
  });

  it('dirty_unknown submit: throws an ambiguous, generation-unsafe error that fences the runner', async () => {
    const writeInput = vi.fn(async () => ({
      submitted: false,
      submissionDisposition: 'dirty_unknown',
    }));
    const { sendRaw } = loadSender({ runnerFramedInput: true, writeInput });

    await expect(sendRaw({}, 'x')).rejects.toMatchObject({
      name: 'SubmissionWriteError',
      recoveryFailureReason: 'runner_frame_submit_ambiguous',
      submissionStarted: true,
      runnerGenerationUnsafe: true,
    });
  });

  it('clean pre-buffer reject: non-ambiguous, known-not-started, generation still safe', async () => {
    const writeInput = vi.fn(async () => ({
      submitted: false,
      submissionDisposition: 'untouched',
    }));
    const { sendRaw } = loadSender({ runnerFramedInput: true, writeInput });

    const error = await sendRaw({}, 'x').then(() => null, (e) => e);
    expect(error).toMatchObject({
      name: 'SubmissionWriteError',
      submissionStarted: false,
      runnerGenerationUnsafe: false,
    });
    expect(error.recoveryFailureReason).toBeUndefined();
  });

  it('non-framed adapters keep the generic literal writer path', async () => {
    const writeInput = vi.fn(async () => {});
    const genericWrite = vi.fn(async () => true);
    const scope: Record<string, unknown> = {
      cliAdapter: { runnerFramedInput: undefined, writeInput },
      SubmissionWriteError,
      writeRawCommandLine: genericWrite,
      rawCommandWriteOptionsFor: vi.fn(() => ({ submitBeatMs: 0 })),
      lastInitConfig: { cliId: 'claude-code' },
    };
    const sendRaw = loadWorkerFunction<(be: unknown, content: string) => Promise<void>>(
      'sendRawCommandLine',
      scope,
    );
    await sendRaw({ id: 'pane' }, '/goal hi');
    expect(genericWrite).toHaveBeenCalledTimes(1);
    expect(writeInput).not.toHaveBeenCalled();
  });
});

describe('P2-3: runnerGenerationUnsafe survives the ambiguous-submission WAL rewrap', () => {
  it('real sendRawCommandLineWithRecoveryFence preserves the marker on a fence-capable (ZMX-like) backend', async () => {
    // Load the REAL functions together so the shared module globals (the raw
    // tail lock) behave as in production.
    const shared: Record<string, unknown> = {};
    const load = <T extends (...a: any[]) => any>(name: string): T =>
      loadWorkerFunction<T>(name, shared);
    const sendRaw = load<(be: unknown, c: string) => Promise<void>>('sendRawCommandLine');
    const runTxn = load<(be: unknown, w: () => Promise<unknown>) => Promise<{result: unknown}>>(
      'runAmbiguousSubmissionTransaction',
    );
    const withFence = load<(be: unknown, c: string) => Promise<void>>(
      'sendRawCommandLineWithRecoveryFence',
    );

    // The writer throws a framed-dirty error.
    const writeInput = vi.fn(async () => ({
      submitted: false, submissionDisposition: 'dirty_unknown',
    }));
    // Fake fence-capable backend: captureAmbiguousSubmissionFence exists, so the
    // transaction takes the WAL branch and re-wraps the writer's throw.
    const backend = { id: 'zmx-like', captureAmbiguousSubmissionFence: vi.fn(() => 1) };
    Object.assign(shared, {
      SubmissionWriteError,
      rewrapSubmissionFailure,
      commandLineWriteTail: Promise.resolve(),
      commandLineWritesPending: 0,
      cliAdapter: { runnerFramedInput: true, writeInput },
      isUnsafeRawWriteFenced: vi.fn(() => false),
      sendRawCommandLine: sendRaw,
      runAmbiguousSubmissionTransaction: runTxn,
      // Real globals the WAL transaction branch reads.
      get backend() { return backend; },
      ambiguousSubmissionWriteTail: Promise.resolve(),
      captureAmbiguousSubmissionFence: vi.fn(() => 1),
      AmbiguousSubmissionBlockedError: class AmbiguousSubmissionBlockedError extends Error {},
      cancelAmbiguousSubmissionAfterFailure: vi.fn(() => undefined),
      confirmAmbiguousSubmissionAfterSuccess: vi.fn(() => undefined),
    });

    await expect(withFence(backend as never, 'first')).rejects.toMatchObject({
      name: 'SubmissionWriteError',
      // The marker must survive rewrap — this is the P2-3 regression guard.
      runnerGenerationUnsafe: true,
    });
    expect(writeInput).toHaveBeenCalledTimes(1);
  });
});

describe('sendRawCommandLine — submit:false routes to the typing-only writer', () => {
  it('types without submitting when the caller keeps the Enter', async () => {
    // The Codex effort controller passes `{ submit: false }` and presses Enter
    // itself after re-checking the screen. If this option were ignored the
    // /model line would be submitted before that re-check ever ran.
    const typed = vi.fn(async () => true);
    const submitted = vi.fn(async () => true);
    const scope: Record<string, unknown> = {
      cliAdapter: { writeInput: vi.fn() },
      SubmissionWriteError,
      writeRawCommandLine: submitted,
      typeRawCommandLine: typed,
      rawCommandWriteOptionsFor: vi.fn(() => ({ submitBeatMs: 200 })),
      lastInitConfig: { cliId: 'codex' },
      isWorkflowWorker: vi.fn(() => false),
      send: vi.fn(),
      log: vi.fn(),
    };
    const sendRaw = loadWorkerFunction<(be: unknown, c: string, o?: unknown) => Promise<void>>(
      'sendRawCommandLine', scope,
    );
    const backend = { id: 'pane' };

    await sendRaw(backend, '/model', { submit: false });
    expect(typed).toHaveBeenCalledWith(backend, '/model', expect.anything());
    expect(submitted).not.toHaveBeenCalled();

    await sendRaw(backend, '/model');
    expect(submitted).toHaveBeenCalledWith(backend, '/model', expect.anything());
  });
});

describe('typeCodexEffortModelCommand — types /model without submitting', () => {
  it('never presses the submitting Enter, so the controller owns it', async () => {
    // `{ submit: false }` is what makes the pre-Enter modal re-check meaningful.
    // Pinned on the named helper so dropping the flag at the call site fails here.
    const typed = vi.fn(async () => true);
    const submitted = vi.fn(async () => true);
    const scope: Record<string, unknown> = {
      cliAdapter: { writeInput: vi.fn() },
      SubmissionWriteError,
      writeRawCommandLine: submitted,
      typeRawCommandLine: typed,
      rawCommandWriteOptionsFor: vi.fn(() => ({ submitBeatMs: 200 })),
      lastInitConfig: { cliId: 'codex' },
      isWorkflowWorker: vi.fn(() => false),
      send: vi.fn(),
      log: vi.fn(),
    };
    // The helper calls sendRawCommandLine, so provide the REAL one from the
    // same scope shape (it is what routes on `submit: false`).
    scope.sendRawCommandLine = loadWorkerFunction<(be: unknown, c: string, o?: unknown) => Promise<void>>(
      'sendRawCommandLine', scope,
    );
    const command = loadWorkerFunction<(be: unknown) => Promise<void>>(
      'typeCodexEffortModelCommand', scope,
    );
    const backend = { id: 'pane' };
    await command(backend);
    expect(typed).toHaveBeenCalledWith(backend, '/model', expect.anything());
    expect(submitted).not.toHaveBeenCalled();
  });
});
