import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeTurnQueue } from '../src/services/bridge-turn-queue.js';
import { settleStaleWriteContinuation } from '../src/services/submit-confirmation.js';
import { saveUnsentInputs, settleTakenUnsentInputs, takeUnsentInputs } from '../src/services/unsent-input-journal.js';
import { claudeTranscriptLatestTurnState } from '../src/utils/stale-program-status.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

const WAKE_TURN = 'om_wake_message';
const BRIDGE_TTL_MS = 120_000;

type WriteResult = { submitted: boolean; recheck?: () => Promise<boolean> };

/** A Claude worker just woken by one message, at an idle prompt, about to type
 *  it into the composer. The adapter write is held open so the test controls
 *  what happens while it is still being typed. */
function wokenClaudeWorker(opts: { promptReady?: boolean; transcriptPath?: string } = {}) {
  const h = workerSubmitHarness();
  const { scope } = h;
  let finishWrite!: (result: WriteResult) => void;
  const write = new Promise<WriteResult>(resolve => { finishWrite = resolve; });
  const bridgeQueue = new BridgeTurnQueue();
  const ipc: Array<{ type: string; [key: string]: unknown }> = [];
  /** The hidden prompt evidence each re-drive found; undefined re-drives nothing. */
  const redriven: unknown[] = [];
  scope.pendingMessages.splice(0, scope.pendingMessages.length, { turnId: WAKE_TURN, content: 'look at the failing deploy' });
  Object.assign(scope, {
    isPromptReady: opts.promptReady ?? true,
    lastInitConfig: { cliId: 'claude-code' },
    cliAdapter: { reliableTurnTerminal: true, writeInput: vi.fn(() => write) },
    // Gates the transcript bridge on; the mark and ingest are faked below.
    bridgeJsonlPath: opts.transcriptPath ?? '/nonexistent/botmux-test-transcript.jsonl',
    claudeTranscriptLatestTurnState,
    codexBridgeActive: false,
    bridgeQueue,
    bridgeIngest: vi.fn(),
    bridgeMarkPendingTurn: (content: string, turnId: string, dispatchAttempt?: number) =>
      bridgeQueue.mark(turnId, undefined, Date.now(), content, dispatchAttempt),
    idleDetector: { isStartupPending: () => false, reset: vi.fn(), feed: vi.fn(), fireIdle: vi.fn() },
    traexFirstPromptViewportRejects: () => false,
    remoteRunnerRecoveredTurnInFlight: false,
    bareShellLaunchBlocked: false,
    currentPostTerminalInputFence: () => null,
    stopStructuredStartGraceRecheck: vi.fn(),
    replacementSpawnInProgress: false,
    ptyOutputGeneration: { snapshot: () => 41 },
    // The first gate past the composer-write check: reaching it means the
    // prompt was taken as a real ready edge.
    holdForNativeSessionFork: vi.fn(() => true),
    closeRequested: false,
    universalOutputHandoff: null,
    isWorkflowWorker: () => false,
    process: { send: vi.fn((msg: { type: string }) => { ipc.push(msg); }) },
    beginCliWriteCycle: vi.fn(() => { scope.isPromptReady = false; }),
    maybeQueuePostSubmitNativeSessionTitle: () => false,
    settleStaleWriteContinuation,
    redriveRejectedStructuredReady: vi.fn(() => { redriven.push(scope.structuredRejectedReadyEvidenceGeneration); }),
    renderer: { snapshot: () => ({ content: 'claude composer', changed: false }), markNewTurn: vi.fn() },
    backgroundWaitPayload: () => ({}),
  });
  scope.deferTurnInputCommitUntilSubmission = loadWorkerFunction('deferTurnInputCommitUntilSubmission', scope);
  scope.markPromptReady = loadWorkerFunction('markPromptReady', scope);
  scope.publishScreenStatus = loadWorkerFunction('publishScreenStatus', scope);
  scope.cliInputBacklogKey = loadWorkerFunction('cliInputBacklogKey', scope);
  scope.cliInputBacklog = loadWorkerFunction('cliInputBacklog', scope);
  scope.publishCliInputBacklog = loadWorkerFunction('publishCliInputBacklog', scope);
  scope.workerIpcPayload = loadWorkerFunction('workerIpcPayload', scope);
  const send = loadWorkerFunction<(msg: { type: string; [key: string]: unknown }) => void>('send', scope);
  scope.send = send;
  return { ...h, bridgeQueue, finishWrite, ipc, redriven, send };
}

async function untilWriting(h: ReturnType<typeof wokenClaudeWorker>): Promise<void> {
  await vi.waitFor(() => expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a woken worker typing its first message into the CLI', () => {
  it('holds back a prompt-ready that fires mid-write and re-drives it once the input is submitted', async () => {
    const h = wokenClaudeWorker();
    const flushing = h.flush();
    await untilWriting(h);

    h.scope.markPromptReady();
    expect(h.scope.isPromptReady).toBe(false);
    expect(h.scope.holdForNativeSessionFork).not.toHaveBeenCalled();
    // The prompt it saw is what the re-drive re-checks once the write settles.
    expect(h.scope.structuredRejectedReadyEvidenceGeneration).toBe(41);
    expect(h.scope.redriveRejectedStructuredReady).not.toHaveBeenCalled();

    h.finishWrite({ submitted: true });
    await flushing;
    expect(h.redriven).toContain(41);
    h.scope.markPromptReady();
    expect(h.scope.holdForNativeSessionFork).toHaveBeenCalledOnce();
    h.submitFailureChains.clear();
  });

  it('reports the input as not yet taken while it is queued, typed, and awaiting submit confirmation', async () => {
    vi.useFakeTimers();
    const h = wokenClaudeWorker();
    h.scope.publishedCliInputBacklog = h.scope.cliInputBacklogKey({ pending: false });
    try {
      expect(h.scope.cliInputBacklog()).toEqual({ pending: true });
      const flushing = h.flush();
      await untilWriting(h);
      expect(h.scope.cliInputBacklog()).toEqual({ pending: true, writingTurnId: WAKE_TURN });

      h.finishWrite({ submitted: false, recheck: vi.fn(async () => true) });
      await flushing;
      expect(h.submitFailureChains.size()).toBe(1);
      expect(h.scope.cliInputBacklog()).toEqual({ pending: true });

      await vi.advanceTimersByTimeAsync(20_000 * 3);
      expect(h.submitFailureChains.size()).toBe(0);
      expect(h.scope.cliInputBacklog()).toEqual({ pending: false });
    } finally {
      h.submitFailureChains.clear();
    }
  });

  it('sends the backlog ahead of whatever message reports on it', async () => {
    const h = wokenClaudeWorker();
    h.scope.publishedCliInputBacklog = h.scope.cliInputBacklogKey({ pending: false });
    const flushing = h.flush();
    await untilWriting(h);

    h.send({ type: 'turn_input_committed', turnId: WAKE_TURN });
    h.send({ type: 'prompt_ready' });
    expect(h.ipc.map(m => m.type)).toEqual(['cli_input_backlog', 'turn_input_committed', 'prompt_ready']);
    expect(h.ipc[0]).toEqual({ type: 'cli_input_backlog', pending: true, writingTurnId: WAKE_TURN });

    h.ipc.length = 0;
    h.finishWrite({ submitted: true });
    await flushing;
    // Reported as soon as the write settles, not with whatever is sent next,
    // and behind the turn the CLI just took: until then the daemon holds the
    // idle this write started from, which a queued suspend reads as settled.
    expect(h.ipc).toEqual([
      expect.objectContaining({ type: 'screen_update', status: 'working' }),
      { type: 'cli_input_backlog', pending: false },
    ]);
    h.send({ type: 'prompt_ready' });
    expect(h.ipc.at(-1)).toEqual({ type: 'prompt_ready' });
    h.submitFailureChains.clear();
  });

  it('reports no turn for a write the CLI did not take', async () => {
    const h = wokenClaudeWorker();
    h.scope.publishedCliInputBacklog = h.scope.cliInputBacklogKey({ pending: false });
    const flushing = h.flush();
    await untilWriting(h);

    h.finishWrite({ submitted: false, recheck: vi.fn(async () => false) });
    await flushing;
    expect(h.ipc.filter(m => m.type === 'screen_update')).toEqual([]);
    h.submitFailureChains.clear();
  });

  describe('once the write settles', () => {
    let dir: string;
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
    const record = (role: 'user' | 'assistant') => `${JSON.stringify(role === 'user'
      ? { type: 'user', uuid: `u${Math.random()}`, message: { role: 'user', content: 'look at the failing deploy' } }
      : { type: 'assistant', uuid: `a${Math.random()}`, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } })}\n`;

    it('leaves readiness to the end of the turn the write opened, not to a re-drive of the hidden prompt', async () => {
      dir = mkdtempSync(join(tmpdir(), 'bmx-composer-write-'));
      const transcript = join(dir, 'session.jsonl');
      writeFileSync(transcript, record('user') + record('assistant'));
      const h = wokenClaudeWorker({ transcriptPath: transcript });
      const flushing = h.flush();
      await untilWriting(h);
      h.scope.markPromptReady();

      appendFileSync(transcript, record('user'));
      h.finishWrite({ submitted: true });
      await flushing;

      expect(h.redriven.every(evidence => evidence === undefined)).toBe(true);
      expect(h.scope.structuredRejectedReadyEvidenceGeneration).toBeUndefined();
      h.submitFailureChains.clear();
    });

    it('still re-drives the hidden prompt when the transcript turn was already open before it', async () => {
      dir = mkdtempSync(join(tmpdir(), 'bmx-composer-write-'));
      const transcript = join(dir, 'session.jsonl');
      writeFileSync(transcript, record('user'));
      const h = wokenClaudeWorker({ transcriptPath: transcript });
      const flushing = h.flush();
      await untilWriting(h);
      h.scope.markPromptReady();

      h.finishWrite({ submitted: false });
      await flushing;

      expect(h.redriven).toContain(41);
      h.submitFailureChains.clear();
    });
  });

  it('stays silent about the backlog until worker init has published its baseline', () => {
    const h = wokenClaudeWorker();
    h.send({ type: 'prompt_ready' });
    expect(h.ipc.map(m => m.type)).toEqual(['prompt_ready']);
  });

  it('keeps its bridge mark past the TTL while the write is still running, then runs the TTL from submit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-11-07T12:30:52.000Z'));
    const h = wokenClaudeWorker();
    try {
      const flushing = h.flush();
      await untilWriting(h);

      expect(h.bridgeQueue.peek().map(t => t.turnId)).toEqual([WAKE_TURN]);
      vi.setSystemTime(Date.now() + BRIDGE_TTL_MS + 30_000);
      expect(h.bridgeQueue.pruneExpired(BRIDGE_TTL_MS)).toEqual([]);

      h.finishWrite({ submitted: true });
      await flushing;
      const submittedAt = Date.now();
      expect(h.bridgeQueue.pruneExpired(BRIDGE_TTL_MS, submittedAt + BRIDGE_TTL_MS)).toEqual([]);
      expect(h.bridgeQueue.pruneExpired(BRIDGE_TTL_MS, submittedAt + BRIDGE_TTL_MS + 1).map(t => t.turnId))
        .toEqual([WAKE_TURN]);
    } finally {
      h.submitFailureChains.clear();
    }
  });

  it('does not hold back the ready edge of a turn that was already running when type-ahead began', async () => {
    const h = wokenClaudeWorker({ promptReady: false });
    const flushing = h.flush();
    await untilWriting(h);

    h.scope.markPromptReady();
    expect(h.scope.holdForNativeSessionFork).toHaveBeenCalledOnce();

    h.finishWrite({ submitted: true });
    await flushing;
    h.submitFailureChains.clear();
  });

  it('does not hold back the prompt of a replacement CLI started mid-write', async () => {
    const h = wokenClaudeWorker();
    const flushing = h.flush();
    await untilWriting(h);

    h.scope.cliSpawnGeneration += 1;
    h.scope.markPromptReady();
    expect(h.scope.holdForNativeSessionFork).toHaveBeenCalledOnce();

    h.finishWrite({ submitted: true });
    await flushing;
    h.submitFailureChains.clear();
  });
});

describe('a worker asked to suspend', () => {
  let dir: string;
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('hands the inputs it has not written to the CLI yet to the session\'s next worker', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bmx-suspend-journal-'));
    const journal = join(dir, 'unsent-inputs.json');
    const log = vi.fn();
    const queued = { turnId: 'om_queued_follow_up', content: 'and check the rollback too' };
    const pendingMessages = [queued];
    const scope: Record<string, any> = {
      effectiveBackendType: 'tmux',
      log,
      pendingMessages,
      restoredUnsentInputs: new Set(),
      predecessorUnsentInputsTaken: true,
      lastInitConfig: { cliId: 'claude-code' },
      unsentInputJournalPath: () => journal,
      isCodexAppCliId: () => false,
      saveUnsentInputs,
      settleTakenUnsentInputs,
      stopScreenshotLoop: vi.fn(),
      stopBridgeWatcher: vi.fn(),
      destroyCrashDiagnosticTerminal: vi.fn(),
      revokeManagedTurnOriginForRestart: vi.fn(),
      isRemoteBackendType: () => false,
      backend: { destroySession: vi.fn(), kill: vi.fn() },
      stopOwnedSessionScope: vi.fn(),
      sandboxStopWatcher: null,
      cleanup: vi.fn(),
      process: { exit: vi.fn() },
    };
    scope.saveUnsentInputsForSuccessor = loadWorkerFunction('saveUnsentInputsForSuccessor', scope);

    await loadWorkerMessageHandler('suspend', scope)({ type: 'suspend' });

    expect(scope.process.exit).toHaveBeenCalledWith(0);
    expect(takeUnsentInputs(journal).inputs).toEqual([queued]);
  });
});
