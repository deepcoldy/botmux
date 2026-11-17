/**
 * The worker side of cutting a turn that failed without output: the real
 * startFailedTurnRewind / turnFailedWithoutOutput, wired to the real planning,
 * inspection and rewind modules and a real transcript, with the worker's
 * restart machinery stubbed (same harness as the image purge).
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { resolvePurgeResumeTarget } from '../src/services/transcript-image-purge.js';
import { waitForProcessQuiescence } from '../src/services/process-quiescence.js';
import { inspectLastClaudeTurn, restoreRewoundTranscript, rewindClaudeTranscript } from '../src/core/context-rewind.js';
import {
  planFailedTurnRewindRequest,
  rewindableErrorCode,
  rewoundContent,
  runFailedTurnRewindMaintenance,
  transcriptTurnFailedWithoutOutput,
} from '../src/core/failed-turn-rewind.js';
import type { FailedTurnRewindDirective } from '../src/types.js';

const SID = '858ca892-1234-4abc-9def-0123456789ab';

const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const prompt = (text: string, uuid: string) => line({ type: 'user', uuid, message: { role: 'user', content: text } });
const reply = (text: string) => line({ type: 'assistant', uuid: `a-${text}`, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
const apiError = line({
  type: 'assistant', uuid: 'err', isApiErrorMessage: true, error: 'server_error', apiErrorStatus: 503,
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 503 upstream unavailable' }], stop_reason: 'stop_sequence' },
});
const duration = line({ type: 'system', subtype: 'turn_duration', durationMs: 1200 });
const toolCall = line({ type: 'assistant', uuid: 'tool', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], stop_reason: 'tool_use' } });

const HISTORY = prompt('上一轮', 'u0') + reply('上一轮答复') + duration;
const FAILED_INPUT = '【决策看板 · 提示】巡检发现 1 项可以推进';
const failedTranscript = () => HISTORY + prompt(FAILED_INPUT, 'u1') + apiError + duration;

const MERGED = `${FAILED_INPUT}\n\n继续`;
const directive = (overrides: Partial<FailedTurnRewindDirective> = {}): FailedTurnRewindDirective => ({
  failedTurnId: 'board:app:hint-1', failedInput: FAILED_INPUT, mode: 'merge', content: MERGED, ...overrides,
});

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

type RestartOpts = {
  exactResumeSessionId?: string;
  skipRestartBudget?: boolean;
  preservePending?: boolean;
  preserveScratchTreeForRespawn?: boolean;
  beforeRespawn?: (retiring: { pid?: number; processScope: number[] }) => Promise<void>;
  onRespawnSettled?: (result: 'spawned' | 'failed' | 'superseded') => void;
};

function setup(transcript: string, overrides: Record<string, unknown> = {}, d = directive()) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-worker-rewind-'));
  roots.push(root);
  const jsonl = join(root, 'claude', 'projects', 'cwd-key', `${SID}.jsonl`);
  mkdirSync(dirname(jsonl), { recursive: true });
  writeFileSync(jsonl, transcript);
  const send = vi.fn();
  const pendingMessages: Array<{ content: string; turnId?: string }> = [];
  const written: string[] = [];
  const scope: Record<string, unknown> = {
    send,
    log: () => {},
    bridgeJsonlPath: jsonl,
    backend: { getChildPid: () => 4242 },
    lastInitConfig: { cliId: 'claude-code' },
    isRemoteBackendType: () => false,
    effectiveBackendType: 'tmux',
    cliRestartInProgress: false,
    lastResolvedSandboxMode: 'off',
    isPromptReady: true,
    isFlushing: false,
    injectionFlushing: false,
    commandLineWritesPending: 0,
    pendingMessages,
    pendingRawInputs: [],
    tuiPromptBlocking: false,
    sessionRenameInFlight: () => false,
    durableTurnInFlight: false,
    queuedTypeAheadTurns: [],
    activeTurnAuthority: { snapshot: () => undefined },
    failedTurnRewindInFlight: null,
    delay: async () => {},
    pidNotProvablyGone: () => false,
    dirname,
    resolvePurgeResumeTarget,
    waitForProcessQuiescence,
    inspectLastClaudeTurn,
    rewindClaudeTranscript,
    restoreRewoundTranscript,
    planFailedTurnRewindRequest,
    runFailedTurnRewindMaintenance,
    rewoundContent,
    saveUnsentInputsForSuccessor: vi.fn(),
    interruptRewoundInputOnceRecorded: null,
    handleTermAction: vi.fn(async () => {}),
    turnTerminalEmitted: vi.fn(() => false),
    ...overrides,
  };
  // The real restart fences input synchronously: from here on a message waits
  // in the queue for the replacement CLI.
  const restartCliProcess = vi.fn(async (_reason: string, _opts: RestartOpts) => { scope.cliRestartInProgress = true; });
  scope.restartCliProcess ??= restartCliProcess;
  const start = loadWorkerFunction<(turnId: string | undefined, d: FailedTurnRewindDirective, enqueue: () => void) => void>(
    'startFailedTurnRewind', scope,
  );
  const writeEdge = loadWorkerFunction<(item: unknown) => 'write' | 'stopped'>('failedTurnRewindWriteEdge', scope);
  const stopHeld = loadWorkerFunction<(key: string) => boolean>('stopHeldFailedTurnRewind', scope);
  const stop = () => stopHeld('ctrlc');
  const recorded = loadWorkerFunction<(turnId: string) => void>('interruptRewoundInputIfStopped', scope);
  // What the message case's enqueue does: queue behind a restart, write otherwise.
  const enqueue = vi.fn(() => {
    if (scope.cliRestartInProgress) pendingMessages.push({ content: '继续', turnId: 'trg_new' });
    else written.push('继续');
  });
  start('trg_new', d, enqueue);
  const reports = () => send.mock.calls.map(([m]) => m).filter(m => m.type === 'failed_turn_rewind');
  const restartOpts = () => restartCliProcess.mock.calls[0]![1];
  const cutAfterExit = () => restartOpts().beforeRespawn!({ pid: 4242, processScope: [4242] });
  const settle = (result: 'spawned' | 'failed' | 'superseded') => restartOpts().onRespawnSettled!(result);
  /** flushPending reaching the held message: what it writes, if anything. */
  const reachWriteEdge = () => writeEdge(pendingMessages[0]);
  return { jsonl, scope, pendingMessages, written, enqueue, restartCliProcess, reports, restartOpts, cutAfterExit, settle, reachWriteEdge, stop, recorded };
}

describe('startFailedTurnRewind', () => {
  it('cuts the failed turn after the CLI exit is proven and hands the CLI the failed input with the new one', async () => {
    const original = failedTranscript();
    const { jsonl, pendingMessages, written, restartCliProcess, restartOpts, cutAfterExit, settle, reachWriteEdge, reports } = setup(original);
    expect(restartCliProcess).toHaveBeenCalledTimes(1);
    expect(restartOpts()).toMatchObject({ exactResumeSessionId: SID, skipRestartBudget: true, preservePending: true });
    // Queued behind the restart, unchanged, and nothing cut while the CLI may still write.
    expect(written).toEqual([]);
    expect(pendingMessages).toEqual([{ content: '继续', turnId: 'trg_new' }]);
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    expect(reports()).toEqual([]);

    await cutAfterExit();
    expect(readFileSync(jsonl, 'utf8')).toBe(HISTORY);
    expect(pendingMessages).toEqual([{ content: MERGED, turnId: 'trg_new' }]);
    // Only the cut bytes are backed up.
    const backups = readdirSync(dirname(jsonl)).filter(name => name.endsWith('.removed.bak'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(jsonl), backups[0]!), 'utf8')).toBe(prompt(FAILED_INPUT, 'u1') + apiError + duration);

    // The daemon hears of it when the message reaches the CLI, not before:
    // until then its record of the failed turn is still the one to retry.
    settle('spawned');
    expect(reports()).toEqual([]);
    expect(reachWriteEdge()).toBe('write');
    expect(reports()).toEqual([expect.objectContaining({
      type: 'failed_turn_rewind', turnId: 'trg_new', failedTurnId: 'board:app:hint-1', outcome: 'rewound',
    })]);
  });

  it('carries on the skill catalog the worker appended to the cut turn when it wrote it', async () => {
    const refresh = '<botmux_skills_refresh>\n  <instruction>replaces</instruction>\n<botmux_skills mode="priority"></botmux_skills>\n</botmux_skills_refresh>';
    const transcript = HISTORY + prompt(`${FAILED_INPUT}\n\n${refresh}`, 'u1') + apiError + duration;
    const { jsonl, pendingMessages, cutAfterExit, reachWriteEdge, reports } = setup(transcript);
    await cutAfterExit();
    expect(readFileSync(jsonl, 'utf8')).toBe(HISTORY);
    expect(pendingMessages).toEqual([{ content: `${MERGED}\n\n${refresh}`, turnId: 'trg_new' }]);
    reachWriteEdge();
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'rewound' })]);
  });

  it('puts the cut turn back when the CLI cannot be started again, and leaves the message to the next worker', async () => {
    const original = failedTranscript();
    const { jsonl, scope, pendingMessages, cutAfterExit, settle, reports } = setup(original);
    await cutAfterExit();
    expect(readFileSync(jsonl, 'utf8')).toBe(HISTORY);
    settle('failed');
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    expect(pendingMessages).toEqual([{ content: '继续', turnId: 'trg_new' }]);
    // The worker exits after a failed spawn: the message must not die with it.
    expect(scope.saveUnsentInputsForSuccessor).toHaveBeenCalledTimes(1);
    expect(reports()).toEqual([{ type: 'failed_turn_rewind', turnId: 'trg_new', failedTurnId: 'board:app:hint-1', outcome: 'declined', reason: expect.stringMatching(/cut restored/) }]);
  });

  it('when the cut cannot be put back, the saved message keeps carrying the failed input', async () => {
    const { scope, pendingMessages, cutAfterExit, settle, reports } = setup(failedTranscript(), { restoreRewoundTranscript: () => false });
    await cutAfterExit();
    settle('failed');
    expect(pendingMessages).toEqual([{ content: MERGED, turnId: 'trg_new' }]);
    expect(scope.saveUnsentInputsForSuccessor).toHaveBeenCalledTimes(1);
    // Not reported as cut: the next worker delivers it merged, so a later
    // input must not bring the failed input back once more.
    expect(reports()).toEqual([{ type: 'failed_turn_rewind', turnId: 'trg_new', failedTurnId: 'board:app:hint-1', outcome: 'declined', reason: expect.stringMatching(/NOT restored/) }]);
  });

  it('a stop while the message is held before the cut: nothing is cut and the message never reaches the CLI', async () => {
    const original = failedTranscript();
    const { jsonl, cutAfterExit, settle, reachWriteEdge, stop, reports } = setup(original);
    expect(stop()).toBe(true);
    await cutAfterExit();
    settle('spawned');
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    expect(reachWriteEdge()).toBe('stopped');
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined' })]);
  });

  it('a stop after the cut lets the message in and interrupts it once recorded: the failed input stays in the conversation', async () => {
    const { scope, pendingMessages, cutAfterExit, settle, reachWriteEdge, stop, recorded, reports } = setup(failedTranscript());
    await cutAfterExit();
    settle('spawned');
    expect(stop()).toBe(true);
    // Not dropped: it carries the failed input, which is no longer in the transcript.
    expect(pendingMessages).toEqual([{ content: MERGED, turnId: 'trg_new' }]);
    expect(reachWriteEdge()).toBe('write');
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'rewound' })]);
    expect(scope.handleTermAction).not.toHaveBeenCalled();
    recorded('trg_other');
    recorded('trg_new');
    await Promise.resolve();
    expect(scope.handleTermAction).toHaveBeenCalledWith('ctrlc');
    recorded('trg_new');
    await Promise.resolve();
    expect(scope.handleTermAction).toHaveBeenCalledTimes(1);
  });

  it('a stopped message that ended as soon as it was recorded is not interrupted afterwards', async () => {
    const { scope, cutAfterExit, settle, reachWriteEdge, stop, recorded } = setup(failedTranscript());
    await cutAfterExit();
    settle('spawned');
    stop();
    reachWriteEdge();
    (scope.turnTerminalEmitted as ReturnType<typeof vi.fn>).mockReturnValue(true);
    recorded('trg_new');
    await Promise.resolve();
    expect(scope.handleTermAction).not.toHaveBeenCalled();
  });

  it('a stop once the message was written is an ordinary stop', async () => {
    const { pendingMessages, cutAfterExit, settle, reachWriteEdge, stop } = setup(failedTranscript());
    await cutAfterExit();
    settle('spawned');
    reachWriteEdge();
    pendingMessages.length = 0;
    expect(stop()).toBe(false);
  });

  it.each([
    ['made progress', HISTORY + prompt(FAILED_INPUT, 'u1') + toolCall + apiError + duration],
    ['holds another input', HISTORY + prompt('别的话', 'u1') + apiError + duration],
    ['ended normally', HISTORY + prompt(FAILED_INPUT, 'u1') + reply('好') + duration],
    ['is the first turn: nothing would be left to resume', prompt(FAILED_INPUT, 'u1') + apiError + duration],
  ])('leaves the CLI and the transcript alone when the last turn %s', (_label, transcript) => {
    const { jsonl, written, pendingMessages, restartCliProcess, reports } = setup(transcript);
    expect(restartCliProcess).not.toHaveBeenCalled();
    expect(written).toEqual(['继续']);
    expect(pendingMessages).toEqual([]);
    expect(readFileSync(jsonl, 'utf8')).toBe(transcript);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined' })]);
  });

  it.each([
    ['not at its prompt', { isPromptReady: false }],
    ['restarting already', { cliRestartInProgress: true }],
    ['holding queued input', { pendingMessages: [{ content: 'queued' }] }],
    ['running a turn', { activeTurnAuthority: { snapshot: () => ({ turnId: 'om_x' }) } }],
    ['another CLI', { lastInitConfig: { cliId: 'codex' } }],
    ['an adopted pane', { lastInitConfig: { cliId: 'claude-code', adoptMode: true } }],
    ['a remote backend', { isRemoteBackendType: () => true }],
  ])('declines without restarting when the CLI is %s', (_label, overrides) => {
    const original = failedTranscript();
    const { jsonl, restartCliProcess, enqueue, reports } = setup(original, overrides);
    expect(restartCliProcess).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined' })]);
  });

  it('keeps the transcript and the message as they were when the exit cannot be proven', async () => {
    const original = failedTranscript();
    const { jsonl, pendingMessages, cutAfterExit, reports } = setup(original, {
      waitForProcessQuiescence: () => Promise.reject(new Error('process 4242 did not exit')),
    });
    await cutAfterExit();
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    expect(pendingMessages).toEqual([{ content: '继续', turnId: 'trg_new' }]);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/exit unproven/) })]);
  });

  it('does not cut when the transcript changed between the plan and the exit', async () => {
    const { jsonl, pendingMessages, cutAfterExit, reports } = setup(failedTranscript());
    appendFileSync(jsonl, prompt('终端里又敲了一句', 'u2') + reply('回答'));
    const grown = readFileSync(jsonl, 'utf8');
    await cutAfterExit();
    expect(readFileSync(jsonl, 'utf8')).toBe(grown);
    expect(pendingMessages).toEqual([{ content: '继续', turnId: 'trg_new' }]);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined' })]);
  });

  it('does not cut when the failed turn was replaced by a look-alike between the plan and the exit', async () => {
    const { jsonl, cutAfterExit, reports } = setup(failedTranscript());
    // Same text and shape, another record: not the turn that was planned.
    writeFileSync(jsonl, HISTORY + prompt(FAILED_INPUT, 'u1-again') + apiError + duration);
    const replaced = readFileSync(jsonl, 'utf8');
    await cutAfterExit();
    expect(readFileSync(jsonl, 'utf8')).toBe(replaced);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/changed/) })]);
  });

  it('does not cut once the message is no longer waiting: its input would be lost', async () => {
    const original = failedTranscript();
    const { jsonl, pendingMessages, cutAfterExit, reports } = setup(original);
    pendingMessages.length = 0;
    await cutAfterExit();
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/no longer waiting/) })]);
  });

  it('reports a restart that died before the cut as declined, once', async () => {
    const original = failedTranscript();
    const { jsonl, settle, reports } = setup(original);
    settle('failed');
    settle('failed');
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined' })]);
  });

  it('re-sends the failed input alone for a retry', async () => {
    const { pendingMessages, cutAfterExit } = setup(failedTranscript(), {}, directive({ mode: 'resend', content: FAILED_INPUT }));
    await cutAfterExit();
    expect(pendingMessages).toEqual([{ content: FAILED_INPUT, turnId: 'trg_new' }]);
  });
});

describe('turnFailedWithoutOutput', () => {
  function check(transcript: string, overrides: Record<string, unknown> = {}, errorCode = 'provider_server_error', turnId = 'trg_1') {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-direct-'));
    roots.push(root);
    const jsonl = join(root, `${SID}.jsonl`);
    writeFileSync(jsonl, transcript);
    const fn = loadWorkerFunction<(turnId: string, errorCode: string | undefined) => boolean>('turnFailedWithoutOutput', {
      lastInitConfig: { cliId: 'claude-code' },
      isRemoteBackendType: () => false,
      effectiveBackendType: 'tmux',
      bridgeJsonlPath: jsonl,
      lastWrittenCliInput: { turnId: 'trg_1', content: FAILED_INPUT },
      rewindableErrorCode,
      transcriptTurnFailedWithoutOutput,
      ...overrides,
    });
    return fn(turnId, errorCode);
  }

  it('flags a provider failure whose turn holds only the error', () => {
    expect(check(failedTranscript())).toBe(true);
  });

  it('does not flag a turn that made progress, another turn, a stop, or another CLI', () => {
    expect(check(HISTORY + prompt(FAILED_INPUT, 'u1') + toolCall + apiError)).toBe(false);
    expect(check(failedTranscript(), {}, 'provider_server_error', 'trg_other')).toBe(false);
    expect(check(failedTranscript(), {}, 'provider_cancelled')).toBe(false);
    expect(check(failedTranscript(), {}, 'write_input_threw')).toBe(false);
    expect(check(failedTranscript(), { lastInitConfig: { cliId: 'codex' } })).toBe(false);
  });
});
