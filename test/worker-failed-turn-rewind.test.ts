/**
 * The worker side of cutting a turn that failed without output: the real
 * startFailedTurnRewind / turnFailedWithoutOutput, wired to the real planning,
 * inspection and rewind modules and a real transcript, with the worker's
 * restart machinery stubbed (same harness as the image purge).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { appendUnsentInputs, isUnsentInputReplayable, saveUnsentInputs, settleTakenUnsentInputs, takeUnsentInputs } from '../src/services/unsent-input-journal.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { resolvePurgeResumeTarget } from '../src/services/transcript-image-purge.js';
import { waitForProcessQuiescence } from '../src/services/process-quiescence.js';
import { pinClaudeProjectsRoot } from '../src/services/claude-projects-root.js';
import { restoreRewoundTranscript } from '../src/core/context-rewind.js';
import { pruneRewindBackupsBeside, rewindBackupDirForSession, rewindBackupSuffix, sweepRewindBackups } from '../src/core/rewind-backup-retention.js';
import {
  assertTranscriptInProjectsRoot,
  inspectLastTurnInProjectsRoot,
  planFailedTurnRewindRequest,
  withFailedTurnTranscript,
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

function setup(transcript: string, overrides: Record<string, unknown> = {}, d = directive(), { tree = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-worker-rewind-'));
  roots.push(root);
  const jsonl = join(root, 'claude', 'projects', 'cwd-key', `${SID}.jsonl`);
  mkdirSync(dirname(jsonl), { recursive: true });
  writeFileSync(jsonl, transcript);
  const send = vi.fn();
  const journal = join(root, 'unsent.json');
  const pendingMessages: Array<{ content: string; turnId?: string; noReplay?: true }> = [];
  const written: string[] = [];
  const scope: Record<string, unknown> = {
    send,
    log: () => {},
    bridgeJsonlPath: jsonl,
    // Pinned when the CLI was launched, from its config dir.
    claudeProjectsRoot: pinClaudeProjectsRoot(join(root, 'claude')),
    // A sandboxed session's config dir is a tree its CLI can write.
    claudeTranscriptTreeRoot: tree ? join(root, 'claude') : undefined,
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
    join,
    resolvePurgeResumeTarget,
    waitForProcessQuiescence,
    inspectLastTurnInProjectsRoot,
    withFailedTurnTranscript,
    assertTranscriptInProjectsRoot,
    mkdirSync,
    sessionId: 'sess-rewind',
    restoreRewoundTranscript,
    planFailedTurnRewindRequest,
    runFailedTurnRewindMaintenance,
    rewoundContent,
    // The real hand-over to the next worker, on a journal of its own.
    unsentInputJournalPath: () => journal,
    appendUnsentInputs,
    isUnsentInputReplayable,
    saveUnsentInputs,
    settleTakenUnsentInputs,
    predecessorUnsentInputsTaken: false,
    appendedUnsentInputs: new WeakSet(),
    restoredUnsentInputs: new Set(),
    isCodexAppCliId: () => false,
    emitTurnTerminal: vi.fn(),
    // A worker const, not a function: the harness only loads functions.
    FAILED_TURN_REWIND_STOPPED: 'stopped_before_start',
    ...overrides,
  };
  // The real restart fences input synchronously: from here on a message waits
  // in the queue for the replacement CLI.
  const restartCliProcess = vi.fn(async (_reason: string, _opts: RestartOpts) => { scope.cliRestartInProgress = true; });
  scope.restartCliProcess ??= restartCliProcess;
  scope.saveUnsentInputsForSuccessor ??= loadWorkerFunction('saveUnsentInputsForSuccessor', scope);
  const start = loadWorkerFunction<(turnId: string | undefined, d: FailedTurnRewindDirective, enqueue: () => void) => void>(
    'startFailedTurnRewind', scope,
  );
  const writeEdge = loadWorkerFunction<(item: unknown) => 'write' | 'stopped'>('failedTurnRewindWriteEdge', scope);
  const stop = loadWorkerFunction<() => boolean>('stopHeldFailedTurnRewind', scope);
  const putBackBeforeWrites = loadWorkerFunction<() => boolean>('putBackStoppedRewindCutBeforeWrites', scope);
  const offQueue = loadWorkerFunction<(reason: string, cliGone: boolean) => void>('settleFailedTurnRewindOffQueue', scope);
  const goAway = () => (scope.saveUnsentInputsForSuccessor as (reason: string) => void)('shutdown');
  /** What the session's next worker would type in. */
  const successorInputs = () => takeUnsentInputs(journal).inputs.map(({ content, turnId }) => ({ content, turnId }));
  // What the message case's enqueue does: queue behind a restart, write otherwise.
  const enqueue = vi.fn(() => {
    if (scope.cliRestartInProgress) pendingMessages.push({ content: '继续', turnId: 'trg_new' });
    else written.push('继续');
  });
  start('trg_new', d, enqueue);
  const reports = () => send.mock.calls.map(([m]) => m).filter(m => m.type === 'failed_turn_rewind');
  const restartOpts = (call = 0) => restartCliProcess.mock.calls[call]![1];
  const cutAfterExit = () => restartOpts().beforeRespawn!({ pid: 4242, processScope: [4242] });
  const settle = (result: 'spawned' | 'failed' | 'superseded') => restartOpts().onRespawnSettled!(result);
  /** flushPending reaching the held message: what it writes, if anything. */
  const reachWriteEdge = () => writeEdge(pendingMessages[0]);
  return {
    jsonl, scope, pendingMessages, written, enqueue, restartCliProcess, reports, restartOpts, cutAfterExit, settle,
    reachWriteEdge, stop, putBackBeforeWrites, offQueue, goAway, successorInputs,
  };
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
    const { jsonl, cutAfterExit, settle, reports, successorInputs } = setup(original);
    await cutAfterExit();
    expect(readFileSync(jsonl, 'utf8')).toBe(HISTORY);
    settle('failed');
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    // The worker exits after a failed spawn: the message must not die with it.
    expect(successorInputs()).toEqual([{ content: '继续', turnId: 'trg_new' }]);
    expect(reports()).toEqual([{ type: 'failed_turn_rewind', turnId: 'trg_new', failedTurnId: 'board:app:hint-1', outcome: 'declined', reason: expect.stringMatching(/cut restored/) }]);
  });

  it('when the cut cannot be put back, the saved message keeps carrying the failed input, and the daemon hears it was cut', async () => {
    const { cutAfterExit, settle, reports, successorInputs } = setup(failedTranscript(), { restoreRewoundTranscript: () => false });
    await cutAfterExit();
    settle('failed');
    expect(successorInputs()).toEqual([{ content: MERGED, turnId: 'trg_new' }]);
    // As at the write edge: the input now carrying the failed one is the
    // session's last input, and a later input must not bring it back again.
    expect(reports()).toEqual([{ type: 'failed_turn_rewind', turnId: 'trg_new', failedTurnId: 'board:app:hint-1', outcome: 'rewound', reason: expect.stringMatching(/handed to the next worker/) }]);
  });

  it('a worker going away hands a held message on — merged once cut, as it came before — and reports it', async () => {
    const cut = setup(failedTranscript());
    await cut.cutAfterExit();
    cut.goAway();
    expect(cut.successorInputs()).toEqual([{ content: MERGED, turnId: 'trg_new' }]);
    expect(cut.reports()).toEqual([expect.objectContaining({ outcome: 'rewound' })]);

    const early = setup(failedTranscript());
    early.goAway();
    expect(early.successorInputs()).toEqual([{ content: '继续', turnId: 'trg_new' }]);
    expect(early.reports()).toEqual([expect.objectContaining({ outcome: 'declined' })]);
    // Nothing cut afterwards: the message no longer waits for this CLI.
    await early.cutAfterExit();
    expect(readFileSync(early.jsonl, 'utf8')).toBe(failedTranscript());
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

  it('a stop after the cut keeps the message from the CLI and puts the failed turn back once the resumed CLI is gone', async () => {
    const original = failedTranscript();
    const { jsonl, scope, pendingMessages, restartCliProcess, restartOpts, cutAfterExit, settle, reachWriteEdge, stop, reports } = setup(original);
    await cutAfterExit();
    settle('spawned');
    // Arrived behind it while the CLI restarted: still runs afterwards.
    pendingMessages.push({ content: '还在吗', turnId: 'om_later' });
    expect(stop()).toBe(true);
    expect(reachWriteEdge()).toBe('stopped');
    // Never written, merged or plain: nothing of it can have run.
    expect(scope.cliRestartInProgress).toBe(true);
    // The resumed CLI holds the conversation without the failed turn: it is
    // restarted around the restore, the rest of the queue kept for it.
    expect(restartCliProcess).toHaveBeenCalledTimes(2);
    expect(restartOpts(1)).toMatchObject({ exactResumeSessionId: SID, preservePending: true, skipRestartBudget: true, immediate: true });
    // Still in flight for the daemon until the restore ran.
    expect(reports()).toEqual([]);
    // Claude Code writes its cost state when it exits, resumed or not.
    const exitRecord = line({ type: 'cost-state', sessionId: SID, totalCostUsd: 0 });
    appendFileSync(jsonl, exitRecord);
    await restartOpts(1).beforeRespawn!({ pid: 4243, processScope: [4243] });
    expect(readFileSync(jsonl, 'utf8')).toBe(HISTORY + exitRecord + original.slice(HISTORY.length));
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/stopped after the cut; cut restored/) })]);
    expect(pendingMessages.map(item => item.turnId)).toEqual(['trg_new', 'om_later']);
  });

  it('a stop after the cut once the CLI is back restarts at once: a flush under way (startup commands) writes nothing more', async () => {
    const original = failedTranscript();
    const { jsonl, scope, pendingMessages, restartCliProcess, restartOpts, cutAfterExit, settle, stop } = setup(original);
    await cutAfterExit();
    settle('spawned');
    // The restart that resumed the CLI is over.
    scope.cliRestartInProgress = false;
    expect(stop()).toBe(true);
    expect(restartCliProcess).toHaveBeenCalledTimes(2);
    expect(scope.cliRestartInProgress).toBe(true);
    expect(pendingMessages).toEqual([]);
    expect(scope.emitTurnTerminal).toHaveBeenCalledWith('trg_new', 'cancelled', 'stopped_before_start', undefined);
    await restartOpts(1).beforeRespawn!({ pid: 4243, processScope: [4243] });
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
  });

  it('a stop after the cut while no CLI is up (it exited) waits for the next one: its restart can prove that one gone', async () => {
    const { scope, pendingMessages, restartCliProcess, cutAfterExit, settle, stop, putBackBeforeWrites } = setup(failedTranscript());
    await cutAfterExit();
    settle('spawned');
    scope.cliRestartInProgress = false;
    scope.backend = null;
    expect(stop()).toBe(true);
    expect(restartCliProcess).toHaveBeenCalledTimes(1);
    expect(pendingMessages.map(item => item.turnId)).toEqual(['trg_new']);
    // The CLI is back: its first flush puts the cut back.
    scope.backend = { getChildPid: () => 4244 };
    expect(putBackBeforeWrites()).toBe(true);
    expect(restartCliProcess).toHaveBeenCalledTimes(2);
  });

  it('a stop after the cut is acted on before the resumed CLI gets anything, startup commands included', async () => {
    const original = failedTranscript();
    const { jsonl, scope, pendingMessages, restartCliProcess, restartOpts, cutAfterExit, settle, stop, putBackBeforeWrites, reports } = setup(original);
    await cutAfterExit();
    settle('spawned');
    pendingMessages.push({ content: '还在吗', turnId: 'om_later' });
    // Nothing to do while nothing was stopped.
    expect(putBackBeforeWrites()).toBe(false);
    stop();
    expect(putBackBeforeWrites()).toBe(true);
    expect(pendingMessages).toEqual([{ content: '还在吗', turnId: 'om_later' }]);
    expect(scope.emitTurnTerminal).toHaveBeenCalledWith('trg_new', 'cancelled', 'stopped_before_start', undefined);
    expect(restartCliProcess).toHaveBeenCalledTimes(2);
    await restartOpts(1).beforeRespawn!({ pid: 4243, processScope: [4243] });
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/cut restored/) })]);
    // Once only.
    expect(putBackBeforeWrites()).toBe(false);
  });

  it('a stop after the cut while the replacement is still coming up: the restore waits for the CLI to have exited', async () => {
    const { jsonl, restartOpts, cutAfterExit, settle, reachWriteEdge, stop, reports } = setup(failedTranscript(), {
      waitForProcessQuiescence: vi.fn()
        .mockImplementationOnce(() => Promise.resolve())
        .mockImplementationOnce(() => Promise.reject(new Error('process 4243 did not exit'))),
    });
    await cutAfterExit();
    stop();
    settle('superseded');
    reachWriteEdge();
    await restartOpts(1).beforeRespawn!({ pid: 4243, processScope: [4243] });
    // Not rewritten under a CLI that may still write: the failed turn stays
    // in the daemon's record only.
    expect(readFileSync(jsonl, 'utf8')).toBe(HISTORY);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/NOT restored, CLI exit unproven/) })]);
  });

  it('a stop after the cut, then the restart fails: the cut is put back and the stopped message does not reach the next worker', async () => {
    const original = failedTranscript();
    const { jsonl, scope, pendingMessages, cutAfterExit, settle, stop, reports, successorInputs } = setup(original);
    await cutAfterExit();
    pendingMessages.push({ content: '还在吗', turnId: 'om_later' });
    expect(stop()).toBe(true);
    settle('failed');
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    expect(successorInputs()).toEqual([{ content: '还在吗', turnId: 'om_later' }]);
    expect(scope.emitTurnTerminal).toHaveBeenCalledWith('trg_new', 'cancelled', 'stopped_before_start', undefined);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/cut restored/) })]);
  });

  it('a stop before the cut, then the restart fails: the stopped message does not reach the next worker', async () => {
    const original = failedTranscript();
    const { jsonl, scope, cutAfterExit, settle, stop, successorInputs } = setup(original);
    stop();
    await cutAfterExit();
    settle('failed');
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    expect(successorInputs()).toEqual([]);
    expect(scope.emitTurnTerminal).toHaveBeenCalledWith('trg_new', 'cancelled', 'stopped_before_start', undefined);
  });

  it('a cut message the next worker cannot get (at-most-once) is not reported as handed on', async () => {
    const { pendingMessages, cutAfterExit, goAway, reports, successorInputs } = setup(failedTranscript());
    await cutAfterExit();
    pendingMessages[0]!.noReplay = true;
    goAway();
    expect(successorInputs()).toEqual([]);
    // The daemon keeps its record of the failed turn: its card still retries it.
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/not saved for the next worker/) })]);
  });

  it('a held message already gone from the queue when the worker goes away is still reported', async () => {
    const { pendingMessages, cutAfterExit, goAway, reports } = setup(failedTranscript());
    await cutAfterExit();
    // A retired runtime's queue is cleared before the worker exits.
    pendingMessages.length = 0;
    goAway();
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/left the queue before the worker went away/) })]);
  });

  it.each([['before', false], ['after', true]] as const)('a message stopped %s the cut does not reach the next worker when this one goes away', async (_when, cutFirst) => {
    const { scope, pendingMessages, cutAfterExit, settle, stop, goAway, reports, successorInputs } = setup(failedTranscript());
    if (cutFirst) {
      await cutAfterExit();
      settle('spawned');
    }
    pendingMessages.push({ content: '还在吗', turnId: 'om_later' });
    stop();
    goAway();
    expect(successorInputs()).toEqual([{ content: '还在吗', turnId: 'om_later' }]);
    expect(scope.emitTurnTerminal).toHaveBeenCalledWith('trg_new', 'cancelled', 'stopped_before_start', undefined);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined' })]);
  });

  it('a held message dropped off the queue is settled: the cut is put back once the CLI is gone, the daemon told either way', async () => {
    const original = failedTranscript();
    const exited = setup(original);
    await exited.cutAfterExit();
    exited.settle('spawned');
    // Still queued: nothing to settle yet.
    exited.offQueue('dropped on a CLI exit', true);
    expect(exited.reports()).toEqual([]);
    // An at-most-once input is not replayed after a CLI exit.
    exited.pendingMessages.length = 0;
    exited.offQueue('dropped on a CLI exit', true);
    expect(readFileSync(exited.jsonl, 'utf8')).toBe(original);
    expect(exited.reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/cut restored/) })]);

    // Dropped while a CLI may still run on the transcript: left as it is.
    const running = setup(original);
    await running.cutAfterExit();
    running.pendingMessages.length = 0;
    running.offQueue('dropped by a restart', false);
    expect(readFileSync(running.jsonl, 'utf8')).toBe(HISTORY);
    expect(running.reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/NOT restored/) })]);
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

  it('does not cut a file put at the path between the last-turn read and the cut', async () => {
    const original = failedTranscript();
    const { jsonl, cutAfterExit, reports } = setup(original, {
      withFailedTurnTranscript: (path: string, root: Parameters<typeof withFailedTurnTranscript>[1], scope: object, use: Parameters<typeof withFailedTurnTranscript>[3]) =>
        withFailedTurnTranscript(path, root, scope, transcript => use({
          lastTurn: () => {
            const turn = transcript.lastTurn();
            renameSync(path, `${path}.held`);
            writeFileSync(path, original);
            return turn;
          },
          cut: offset => transcript.cut(offset),
        })),
    });
    await cutAfterExit();
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    expect(readFileSync(`${jsonl}.held`, 'utf8')).toBe(original);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/cut failed/) })]);
  });

  describe('a transcript in a tree its CLI can write', () => {
    let previousDataDir: string | undefined;
    afterEach(() => {
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
    });

    it('is backed up into the daemon\'s rewind-backups directory, not next to the transcript', async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'botmux-worker-rewind-data-'));
      roots.push(dataDir);
      previousDataDir = process.env.SESSION_DATA_DIR;
      process.env.SESSION_DATA_DIR = dataDir;
      const { jsonl, cutAfterExit, reports } = setup(failedTranscript(), {}, directive(), { tree: true });
      await cutAfterExit();
      expect(readFileSync(jsonl, 'utf8')).toBe(HISTORY);
      expect(readdirSync(dirname(jsonl))).toEqual([`${SID}.jsonl`]);
      const backups = readdirSync(join(dataDir, 'rewind-backups', 'sess-rewind'));
      expect(backups).toEqual([expect.stringMatching(/\.removed\.bak$/)]);
      expect(reports()).toEqual([]);
    });

    it('is left alone, without restarting the CLI, when there is no backup directory outside the tree', () => {
      previousDataDir = process.env.SESSION_DATA_DIR;
      delete process.env.SESSION_DATA_DIR;
      const original = failedTranscript();
      const { jsonl, restartCliProcess, written, reports } = setup(original, {}, directive(), { tree: true });
      expect(restartCliProcess).not.toHaveBeenCalled();
      expect(written).toEqual(['继续']);
      expect(readFileSync(jsonl, 'utf8')).toBe(original);
      expect(readdirSync(dirname(jsonl))).toEqual([`${SID}.jsonl`]);
      expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/no backup directory/) })]);
    });
  });

  it('does not cut a transcript whose project directory became a link to somewhere else', async () => {
    const original = failedTranscript();
    const { jsonl, cutAfterExit, reports } = setup(original);
    // Planned on the real directory; by the cut it points elsewhere.
    const projectDir = dirname(jsonl);
    const elsewhere = join(dirname(dirname(dirname(projectDir))), 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    renameSync(projectDir, join(elsewhere, 'cwd-key'));
    symlinkSync(join(elsewhere, 'cwd-key'), projectDir);
    await cutAfterExit();
    expect(readFileSync(join(elsewhere, 'cwd-key', `${SID}.jsonl`), 'utf8')).toBe(original);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/outside its projects directory/) })]);
  });

  it('does not cut once the projects directory itself became a link: the root stays the one pinned at launch', async () => {
    const original = failedTranscript();
    const { jsonl, cutAfterExit, reports } = setup(original);
    const projects = dirname(dirname(jsonl));
    const elsewhere = join(dirname(dirname(projects)), 'elsewhere-projects');
    renameSync(projects, elsewhere);
    symlinkSync(elsewhere, projects);
    await cutAfterExit();
    expect(readFileSync(join(elsewhere, 'cwd-key', `${SID}.jsonl`), 'utf8')).toBe(original);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/outside its projects directory/) })]);
  });

  it('trusts no transcript without a projects root pinned at launch', () => {
    const original = failedTranscript();
    const { jsonl, restartCliProcess, written, reports } = setup(original, { claudeProjectsRoot: undefined });
    expect(restartCliProcess).not.toHaveBeenCalled();
    expect(written).toEqual(['继续']);
    expect(readFileSync(jsonl, 'utf8')).toBe(original);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined' })]);
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

  describe('the backups cuts leave behind (#3572)', () => {
    const DAY = 24 * 60 * 60_000;
    let previousDataDir: string | undefined;
    afterEach(() => {
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
      previousDataDir = undefined;
    });

    /** The real pruning, each run collected so a test can await it. */
    function collectPrunes() {
      const runs: Promise<void>[] = [];
      const prune = (...args: Parameters<typeof pruneRewindBackupsBeside>) => {
        const pruning = pruneRewindBackupsBeside(...args);
        runs.push(pruning);
        return pruning;
      };
      return { runs, prune };
    }
    /** A backup an earlier cut made `ageMs` ago, last written then. */
    const seedBackup = (dir: string, ageMs: number, kind: 'full' | 'removed' = 'removed') => {
      const at = Date.now() - ageMs;
      const path = join(dir, `${SID}.jsonl${rewindBackupSuffix(at, kind)}`);
      writeFileSync(path, 'old backup');
      utimesSync(path, at / 1000, at / 1000);
      return path;
    };

    it('next to the transcript: pruned once the rewind settled, not before; the new backup and the young ones stay', async () => {
      const { runs, prune } = collectPrunes();
      const { jsonl, cutAfterExit, settle, reachWriteEdge, reports } = setup(failedTranscript(), { pruneRewindBackupsBeside: prune });
      const dir = dirname(jsonl);
      const expired = seedBackup(dir, 30 * DAY);
      const expiredFull = seedBackup(dir, 8 * DAY, 'full');
      const young = seedBackup(dir, 2 * DAY);
      const purgeBackup = join(dir, `${SID}.jsonl.botmux-purge-bak-2026-01-01T00-00-00-000Z`);
      writeFileSync(purgeBackup, 'image purge backup');
      utimesSync(purgeBackup, (Date.now() - 30 * DAY) / 1000, (Date.now() - 30 * DAY) / 1000);

      await cutAfterExit();
      settle('spawned');
      // Cut, and the CLI is back, but the message has not reached it: the
      // rewind is not settled yet.
      expect(runs).toHaveLength(0);
      expect(existsSync(expired)).toBe(true);
      expect(reachWriteEdge()).toBe('write');
      expect(reports()).toEqual([expect.objectContaining({ outcome: 'rewound' })]);
      expect(runs).toHaveLength(1);
      await Promise.all(runs);

      expect(existsSync(expired)).toBe(false);
      expect(existsSync(expiredFull)).toBe(false);
      expect(existsSync(young)).toBe(true);
      expect(existsSync(purgeBackup)).toBe(true);
      const fresh = readdirSync(dir).filter(name => name.endsWith('.removed.bak') && name !== basename(young));
      expect(fresh).toHaveLength(1);
      expect(readFileSync(join(dir, fresh[0]!), 'utf8')).toBe(prompt(FAILED_INPUT, 'u1') + apiError + duration);
    });

    it('a cut put back after a failed restart: pruned as it settles, its own backup kept', async () => {
      const { runs, prune } = collectPrunes();
      const original = failedTranscript();
      const { jsonl, cutAfterExit, settle, reports } = setup(original, { pruneRewindBackupsBeside: prune });
      const expired = seedBackup(dirname(jsonl), 30 * DAY);
      await cutAfterExit();
      settle('failed');
      expect(readFileSync(jsonl, 'utf8')).toBe(original);
      expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined', reason: expect.stringMatching(/cut restored/) })]);
      await Promise.all(runs);
      expect(existsSync(expired)).toBe(false);
      expect(readdirSync(dirname(jsonl)).filter(name => name.endsWith('.bak'))).toEqual([expect.stringMatching(/\.removed\.bak$/)]);
    });

    it('next to the transcript: registered as soon as the cut lands, so the periodic sweep reaches it even if the rewind never settles', async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'botmux-worker-rewind-data-'));
      roots.push(dataDir);
      previousDataDir = process.env.SESSION_DATA_DIR;
      process.env.SESSION_DATA_DIR = dataDir;
      const { runs, prune } = collectPrunes();
      const { jsonl, cutAfterExit, reports } = setup(failedTranscript(), { pruneRewindBackupsBeside: prune });
      await cutAfterExit();
      // The worker goes away here: nothing settles, nothing is pruned.
      expect(reports()).toEqual([]);
      expect(runs).toHaveLength(0);
      const backup = readdirSync(dirname(jsonl)).find(name => name.endsWith('.removed.bak'))!;
      expect(await sweepRewindBackups(dataDir)).toEqual([]);
      expect(await sweepRewindBackups(dataDir, { now: Date.now() + 30 * DAY })).toEqual([join(dirname(jsonl), backup)]);
      expect(readdirSync(dirname(jsonl))).toEqual([`${SID}.jsonl`]);
    });

    it('nothing cut, nothing pruned', async () => {
      const { runs, prune } = collectPrunes();
      const { jsonl, pendingMessages, cutAfterExit, reports } = setup(failedTranscript(), { pruneRewindBackupsBeside: prune });
      const expired = seedBackup(dirname(jsonl), 30 * DAY);
      pendingMessages.length = 0;
      await cutAfterExit();
      expect(reports()).toEqual([expect.objectContaining({ outcome: 'declined' })]);
      expect(runs).toHaveLength(0);
      expect(existsSync(expired)).toBe(true);
    });

    it('in a tree its CLI can write: this session\'s directory in the daemon data dir is pruned', async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'botmux-worker-rewind-data-'));
      roots.push(dataDir);
      previousDataDir = process.env.SESSION_DATA_DIR;
      process.env.SESSION_DATA_DIR = dataDir;
      const backupDir = rewindBackupDirForSession(dataDir, 'sess-rewind');
      mkdirSync(backupDir, { recursive: true });
      const expired = seedBackup(backupDir, 30 * DAY);
      const { runs, prune } = collectPrunes();
      const { jsonl, cutAfterExit, settle, reachWriteEdge } = setup(failedTranscript(), { pruneRewindBackupsBeside: prune }, directive(), { tree: true });
      await cutAfterExit();
      settle('spawned');
      expect(reachWriteEdge()).toBe('write');
      await Promise.all(runs);
      expect(existsSync(expired)).toBe(false);
      expect(readdirSync(backupDir)).toEqual([expect.stringMatching(/\.removed\.bak$/)]);
      expect(readdirSync(dirname(jsonl))).toEqual([`${SID}.jsonl`]);
    });
  });
});

describe('flushPending at a stopped message whose cut must be put back', () => {
  const CUT = { path: '/nonexistent', offset: 0, backupPath: '/nonexistent.bak', sessionId: SID, preserveScratchTree: false, plainContent: '继续', reason: 'cut' };
  function flushWithHeld(held: { stopped: boolean }) {
    const harness = workerSubmitHarness();
    const { scope } = harness;
    const stopped = { turnId: 'trg_new', content: MERGED };
    const later = { turnId: 'om_later', content: '还在吗' };
    scope.pendingMessages.splice(0, scope.pendingMessages.length, stopped, later);
    scope.FAILED_TURN_REWIND_STOPPED = 'stopped_before_start';
    scope.failedTurnRewindInFlight = { queued: stopped, cut: CUT, report: vi.fn(), ...held };
    // A tmux teardown is asynchronous: the backend is still there when the
    // restart has fenced input.
    scope.restartCliProcess = vi.fn(async () => { scope.cliRestartInProgress = true; });
    // The resumed CLI's first flush runs the bot's startup commands, which
    // Claude Code records as turns: they would keep the cut from going back.
    scope.hasRunStartupCommands = false;
    scope.runStartupCommands = vi.fn(async () => true);
    scope.runInitialNativeRename = vi.fn(async () => {});
    return { ...harness, later };
  }

  it('puts the cut back before the resumed CLI gets anything, startup commands included', async () => {
    const { scope, flush, later } = flushWithHeld({ stopped: true });
    await flush();
    expect(scope.runStartupCommands).not.toHaveBeenCalled();
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.restartCliProcess).toHaveBeenCalledTimes(1);
    expect(scope.emitTurnTerminal).toHaveBeenCalledWith('trg_new', 'cancelled', 'stopped_before_start', undefined);
    expect(scope.pendingMessages).toEqual([later]);
  });

  it('settles a held message that left the queue without reaching the CLI: the daemon is not left waiting for it', async () => {
    // Dropped meanwhile (a restart that keeps no queued input): seen by the next flush.
    const dropped = flushWithHeld({ stopped: false });
    dropped.scope.pendingMessages.shift();
    const droppedHeld = dropped.scope.failedTurnRewindInFlight;
    await dropped.flush();
    expect(droppedHeld.report).toHaveBeenCalledWith('declined', expect.stringMatching(/left the queue.*cut NOT restored/));
    expect(dropped.scope.failedTurnRewindInFlight).toBeNull();

    // Refused at the write gate: settled as the flush ends.
    const refused = flushWithHeld({ stopped: false });
    const refusedHeld = refused.scope.failedTurnRewindInFlight;
    refused.scope.workerSessionEventScope = {
      canSubmit: (turnId: string) => turnId !== 'trg_new', enterTurn: () => {},
    };
    await refused.flush().catch(() => {});
    expect(refused.scope.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_input_rejected', turnId: 'trg_new' }));
    expect(refusedHeld.report).toHaveBeenCalledWith('declined', expect.stringMatching(/refused before it reached the CLI/));
  });

  it('a stop that lands while the flush is under way: nothing more is written once the restore restart started', async () => {
    const { scope, flush, later } = flushWithHeld({ stopped: false });
    scope.runStartupCommands = vi.fn(async () => { scope.failedTurnRewindInFlight.stopped = true; return true; });
    await flush();
    expect(scope.restartCliProcess).toHaveBeenCalledTimes(1);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.emitTurnTerminal).toHaveBeenCalledWith('trg_new', 'cancelled', 'stopped_before_start', undefined);
    expect(scope.pendingMessages).toEqual([later]);
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
