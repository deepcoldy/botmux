import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

/**
 * Behavior guard for review finding
 * om_x100b6284c51fc0b4b1e57cbf7ef2b60/cli_aaacc9cb7f39dce4/02:
 * a framed stdin runner's raw passthrough line must be delivered through the
 * adapter's writeInput submit transaction (pre-flush / retry / disposition),
 * never typed literally — and an unconfirmed frame must quarantine the
 * generation instead of being reported as accepted.
 */
class SubmissionWriteError extends Error {
  constructor(
    message: string,
    readonly recoveryFailureReason?: string,
    readonly submissionStarted = true,
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
    sendRaw: loadWorkerFunction<(be: unknown, content: string) => Promise<void>>(
      'sendRawCommandLine',
      scope,
    ),
    writeInput,
    genericWrite: scope.writeRawCommandLine as ReturnType<typeof vi.fn>,
  };
}

describe('sendRawCommandLine — framed stdin runner isolation', () => {
  it('frames through adapter.writeInput and never types the line literally', async () => {
    const { sendRaw, writeInput, genericWrite } = loadSender({ runnerFramedInput: true });
    const backend = { id: 'pane' };
    const objective = 'Read $BOTMUX_GOAL_PATH. Complete it.';

    await sendRaw(backend, objective);

    expect(writeInput).toHaveBeenCalledTimes(1);
    expect(writeInput).toHaveBeenCalledWith(backend, objective);
    expect(genericWrite).not.toHaveBeenCalled();
  });

  it('dirty_unknown submit: throws an ambiguous, in-flight SubmissionWriteError (no replay)', async () => {
    const writeInput = vi.fn(async () => ({
      submitted: false,
      submissionDisposition: 'dirty_unknown',
    }));
    const { sendRaw } = loadSender({ runnerFramedInput: true, writeInput });

    await expect(sendRaw({}, 'x')).rejects.toMatchObject({
      name: 'SubmissionWriteError',
      recoveryFailureReason: 'runner_frame_submit_ambiguous',
      submissionStarted: true,
    });
  });

  it('clean pre-buffer reject: throws non-ambiguous, known-not-started so retry is safe', async () => {
    const writeInput = vi.fn(async () => ({
      submitted: false,
      submissionDisposition: 'untouched',
    }));
    const { sendRaw } = loadSender({ runnerFramedInput: true, writeInput });

    await expect(sendRaw({}, 'x')).rejects.toMatchObject({
      name: 'SubmissionWriteError',
      submissionStarted: false,
    });
    await expect(sendRaw({}, 'x')).rejects.not.toMatchObject({
      recoveryFailureReason: expect.any(String),
    });
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
