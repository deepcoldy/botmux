/**
 * A worker that re-attached to a surviving Claude CLI rebuilds its background
 * tasks from the transcript, and its turn_terminal reports how many still run.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { BackgroundTaskTracker, drainTranscript, type TranscriptEvent } from '../src/services/claude-transcript.js';
import { baselineJsonlCursor, scanJsonlFromOffset, type JsonlCursor } from '../src/services/jsonl-cursor.js';
import {
  normalizeBackgroundTranscriptPath,
  normalizeBackgroundTranscriptSegments,
  readBackgroundTranscriptChain,
  writeBackgroundTranscriptChain,
  type BackgroundTranscriptSegment,
} from '../src/services/background-transcript-chain.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const dir = mkdtempSync(join(tmpdir(), 'bmx-bgseed-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CLI_STARTED = Date.parse('2026-11-24T10:00:00.000Z');
const iso = (offsetMs: number) => new Date(CLI_STARTED + offsetMs).toISOString();

const prompt = (offsetMs: number): TranscriptEvent => ({
  type: 'user', uuid: `p${offsetMs}`, timestamp: iso(offsetMs), isSidechain: false,
  message: { role: 'user', content: 'run the workflow' },
} as TranscriptEvent);
const workflowLaunch = (offsetMs: number): TranscriptEvent => ({
  type: 'user', uuid: `l${offsetMs}`, timestamp: iso(offsetMs), isSidechain: false,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'launched' }] },
  toolUseResult: { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow', runId: 'run1' },
} as TranscriptEvent);
const finalAnswer = (offsetMs: number): TranscriptEvent => ({
  type: 'assistant', uuid: `a${offsetMs}`, timestamp: iso(offsetMs), isSidechain: false,
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'started' }] },
} as TranscriptEvent);
const turnDuration = (offsetMs: number): TranscriptEvent => ({
  type: 'system', subtype: 'turn_duration', uuid: `d${offsetMs}`, timestamp: iso(offsetMs), isSidechain: false,
} as TranscriptEvent);
const workflowDone = (offsetMs: number): TranscriptEvent => ({
  type: 'queue-operation', operation: 'enqueue', timestamp: iso(offsetMs),
  content: '<task-notification>\n<task-id>wf1</task-id>\n<status>completed</status>\n<summary>s</summary>\n</task-notification>',
} as TranscriptEvent);
const clearTranscript = (offsetMs: number): TranscriptEvent => ({
  type: 'user', uuid: `clear${offsetMs}`, timestamp: iso(offsetMs), isSidechain: false,
  message: { role: 'user', content: '<command-name>/clear</command-name>' },
} as TranscriptEvent);

function seedDetailed(events: TranscriptEvent[], liveCliStartedAtMs: number | undefined, opts: {
  previousPaths?: readonly (string | BackgroundTranscriptSegment)[];
  onCurrentScanned?: (path: string) => void;
  scan?: typeof scanJsonlFromOffset;
} = {}) {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, events.map(ev => JSON.stringify(ev)).join('\n') + '\n');
  const tracker = new BackgroundTaskTracker();
  const scope: Record<string, any> = {
    lastInitConfig: { cliId: 'claude-code' },
    bridgeLiveCliStartedAtMs: liveCliStartedAtMs,
    bridgeJsonlPath: path,
    existsSyncSafe: () => true,
    scanJsonlFromOffset: (scanPath: string, fromOffset: number, scanOpts: any) => {
      const cursor = (opts.scan ?? scanJsonlFromOffset)(scanPath, fromOffset, scanOpts);
      if (normalizeBackgroundTranscriptPath(scanPath) === normalizeBackgroundTranscriptPath(path)) {
        opts.onCurrentScanned?.(scanPath);
      }
      return cursor;
    },
    backgroundTaskTracker: tracker,
    normalizeBackgroundTranscriptPath,
    normalizeBackgroundTranscriptSegments,
    refreshBackgroundWait: () => {},
    log: vi.fn(),
  };
  const cursor = loadWorkerFunction<(paths?: readonly (string | BackgroundTranscriptSegment)[]) => JsonlCursor | null | undefined>(
    'seedBackgroundTasksFromTranscript', scope,
  )(opts.previousPaths);
  return { tracker, cursor, path, scope };
}

function seed(events: TranscriptEvent[], liveCliStartedAtMs: number | undefined) {
  return seedDetailed(events, liveCliStartedAtMs).tracker;
}

function startBridgeWatcherForTest(attachPath: string, currentPath: string, tracker: BackgroundTaskTracker, liveCliStartedAtMs?: number) {
  const scope: Record<string, any> = {
    lastInitConfig: { cliId: 'claude-code' },
    sessionId: 'sid-bgseed',
    bridgeJsonlPath: undefined,
    bridgeJsonlDir: undefined,
    bridgeOffset: 0,
    bridgeBaselineDone: false,
    bridgeWatcher: null,
    bridgeFallbackTimer: null,
    backgroundTaskTracker: tracker,
    backgroundTranscriptPaths: [],
    backgroundTranscriptChainLoaded: false,
    refreshBackgroundWait: () => {},
    scanJsonlFromOffset,
    baselineJsonlCursor,
    readBackgroundTranscriptChain,
    writeBackgroundTranscriptChain,
    normalizeBackgroundTranscriptPath,
    normalizeBackgroundTranscriptSegments,
    existsSyncSafe: () => true,
    dirname: (path: string) => path.slice(0, path.lastIndexOf('/')),
    resolveJsonlFromPid: () => ({ path: currentPath, cliSessionId: 'post-clear' }),
    findOpenClaudeSessionIds: () => [],
    bridgeRememberSessionIdForPath: () => {},
    bridgeMarkStalePidStateForAcceptedSid: () => {},
    beginNewBridgeTranscriptGeneration: () => {},
    seedModelRequestClockFromTranscript: () => {},
    seedModelFallbackFromTranscript: () => {},
    restoreScheduledTaskAnchorsOnce: () => {},
    scanRestartInterruption: () => {},
    transcriptShowsTurnDurationMarker: () => false,
    tryRestoreInterruptedBridgeTurns: () => false,
    drainPathInto: (path: string, offset: number) => {
      const result = drainTranscript(path, offset);
      return { offset: result.newOffset, tail: result.pendingTail };
    },
    retainSecondaryPathIfStillReferenced: () => {},
    bindModelRequestClockToTranscript: () => {},
    drainTranscript,
    splitTranscriptEventsByCutoff: () => ({ history: [], live: [] }),
    bridgeQueue: { absorb: () => {} },
    ingestClaudeSwitchLiveAndSettleUnreadTurn: () => {},
    observeModelFallbackEvents: () => {},
    observeClaudeBackgroundTasks: () => {},
    modelRequestClock: { observe: () => {} },
    fsWatch: () => ({ close: () => {} }),
    setInterval: () => 0,
    log: vi.fn(),
  };
  for (const name of [
    'backgroundTranscriptChainFilePath', 'persistBackgroundTranscriptChain',
    'prepareBackgroundTranscriptReplay', 'recordBackgroundTranscriptRotation',
    'seedBackgroundTasksFromTranscript', 'bridgeAbsorbBaseline',
  ]) scope[name] = loadWorkerFunction(name, scope);
  loadWorkerFunction<(path: string, opts?: any) => void>('startBridgeWatcher', scope)(attachPath, {
    cliPid: 4242, cliCwd: '/proj', dataDir: dir, mode: 'baseline-existing',
    ...(liveCliStartedAtMs !== undefined ? { liveCliStartedAtMs } : {}),
  });
  return scope;
}

function absorbBaselineForTest(path: string, cursor?: JsonlCursor | null) {
  const scope: Record<string, any> = {
    bridgeJsonlPath: path,
    lastInitConfig: { cliId: 'claude-code' },
    bridgeOffset: 0,
    bridgeBaselineDone: false,
    restoreScheduledTaskAnchorsOnce: () => {},
    scanRestartInterruption: () => {},
    transcriptShowsTurnDurationMarker: () => false,
    tryRestoreInterruptedBridgeTurns: () => false,
    baselineJsonlCursor,
  };
  loadWorkerFunction<(cursor?: JsonlCursor | null) => void>('bridgeAbsorbBaseline', scope)(cursor);
  return scope;
}

describe('re-attach background task seed', () => {
  const launchedAndEnded = [prompt(1_000), workflowLaunch(2_000), finalAnswer(3_000), turnDuration(3_100)];

  it('finds a Workflow launched after the CLI started, which is still running', () => {
    const tracker = seed(launchedAndEnded, CLI_STARTED);
    expect(tracker.pending(CLI_STARTED + 10_000)).toBe(1);
    expect(tracker.backgroundWait(CLI_STARTED + 10_000)).toBe(1);
  });

  it('finds a launch followed by many megabytes of later conversation', () => {
    const filler = Array.from({ length: 40 }, (_, i) => ({
      ...finalAnswer(2_100 + i),
      message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }] },
    } as TranscriptEvent));
    const tracker = seed([prompt(1_000), workflowLaunch(2_000), ...filler, finalAnswer(3_000), turnDuration(3_100)], CLI_STARTED);
    expect(tracker.backgroundWait(CLI_STARTED + 10_000)).toBe(1);
  });

  it('ignores a launch that predates the CLI process', () => {
    expect(seed(launchedAndEnded, CLI_STARTED + 2_500).pending(CLI_STARTED + 10_000)).toBe(0);
  });

  it('finds nothing once the Workflow reported its completion', () => {
    expect(seed([...launchedAndEnded, workflowDone(5_000)], CLI_STARTED).pending(CLI_STARTED + 10_000)).toBe(0);
  });

  it('leaves records appended between seed and baseline for the live drain', () => {
    const firstTurn = [prompt(1_000), finalAnswer(2_000), turnDuration(2_100)];
    const appendedTurn = [prompt(6_000), workflowLaunch(7_000), finalAnswer(8_000), turnDuration(8_100)];
    const seeded = seedDetailed(firstTurn, CLI_STARTED, {
      onCurrentScanned(path) {
        appendFileSync(path, appendedTurn.map(ev => JSON.stringify(ev)).join('\n') + '\n');
      },
    });
    expect(seeded.cursor).toBeDefined();
    const baselineScope = absorbBaselineForTest(seeded.path, seeded.cursor);
    expect(baselineScope.bridgeOffset).toBe(seeded.cursor!.newOffset);
    const later = drainTranscript(seeded.path, baselineScope.bridgeOffset);
    expect(later.events).toHaveLength(appendedTurn.length);
    for (const event of later.events) seeded.tracker.observe(event);
    expect(seeded.tracker.backgroundWait(CLI_STARTED + 10_000)).toBe(1);
  });

  it('caps journal recovery at the same frontier when records arrive after seed', () => {
    const firstTurn = [prompt(1_000), finalAnswer(2_000), turnDuration(2_100)];
    const appendedTurn = [prompt(6_000), workflowLaunch(7_000), finalAnswer(8_000), turnDuration(8_100)];
    const seeded = seedDetailed(firstTurn, CLI_STARTED, {
      onCurrentScanned(path) {
        appendFileSync(path, appendedTurn.map(ev => JSON.stringify(ev)).join('\n') + '\n');
      },
    });
    const entry = {
      turnId: 'om_restored', markTimeMs: CLI_STARTED, fingerprint: 'f', contentNormalized: 'run',
      jsonlPath: seeded.path, offsetAtMark: 0,
    };
    const ingested: TranscriptEvent[][] = [];
    const scope: Record<string, any> = {
      bridgeRestoreGate: { mayRestoreOnThisBaseline: () => true },
      bridgeTurnJournalFilePath: () => 'journal',
      bridgeJsonlPath: seeded.path,
      bridgeLiveCliStartedAtMs: CLI_STARTED,
      readBridgeTurnJournal: () => [entry],
      selectRestorableBridgeTurns: (entries: unknown[]) => entries,
      writeBridgeTurnJournal: () => {},
      planBridgeTurnRecovery: () => ({ kind: 'recover', fromOffset: 0, recoveryBytes: 1 }),
      drainTranscript,
      scanJsonlFromOffset,
      rememberTurnLinkRefMode: () => {},
      bridgeQueue: {
        mark: () => {}, absorb: () => {}, ingest: (events: TranscriptEvent[]) => ingested.push(events),
        forgetCliQueue: () => {},
      },
      splitTranscriptEventsByCutoff: (events: TranscriptEvent[]) => ({ history: [], live: events }),
      bridgeOffset: 0,
      bridgeBaselineDone: false,
      observeModelFallbackEvents: () => {},
      log: () => {},
    };
    expect(loadWorkerFunction<(cursor?: JsonlCursor) => boolean>(
      'tryRestoreInterruptedBridgeTurns', scope,
    )(seeded.cursor)).toBe(true);
    expect(scope.bridgeOffset).toBe(seeded.cursor!.newOffset);
    expect(ingested.flat()).toHaveLength(firstTurn.length);
    expect(drainTranscript(seeded.path, scope.bridgeOffset).events).toHaveLength(appendedTurn.length);
  });

  it('rebuilds a pre-clear task through the real startBridgeWatcher path adjustment', () => {
    const fixture = (name: string) => readFileSync(
      new URL(`./fixtures/claude-background-tasks/${name}`, import.meta.url), 'utf8',
    ).split('\n').filter(Boolean).map(line => JSON.parse(line) as TranscriptEvent);
    const before = fixture('before-clear.jsonl');
    const current = fixture('after-clear.jsonl').slice(0, 3);
    const previousPath = join(dir, 'before-clear.jsonl');
    const currentPath = join(dir, 'after-clear.jsonl');
    writeFileSync(previousPath, before.map(ev => JSON.stringify(ev)).join('\n') + '\n');
    writeFileSync(currentPath, current.map(ev => JSON.stringify(ev)).join('\n') + '\n');
    const tracker = new BackgroundTaskTracker();
    startBridgeWatcherForTest(previousPath, currentPath, tracker, Date.parse('2026-10-20T17:00:00.000Z'));
    expect(tracker.backgroundWait(Date.parse('2026-10-20T17:25:50.000Z'))).toBe(1);
  });

  it.each([
    {
      name: 'launch in the middle transcript', expected: 1,
      first: [prompt(1_000), finalAnswer(2_000), turnDuration(2_100)],
      middle: [prompt(6_000), workflowLaunch(7_000), finalAnswer(8_000), turnDuration(8_100)],
    },
    {
      name: 'stop in the middle transcript', expected: 0,
      first: [prompt(1_000), workflowLaunch(2_000), finalAnswer(3_000), turnDuration(3_100)],
      middle: [workflowDone(5_000)],
    },
  ])('replays two clears: $name', ({ first, middle, expected }) => {
    const dataDir = join(dir, `data-${Math.random().toString(36).slice(2)}`);
    const previousDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dataDir;
    try {
      const firstPath = join(dir, `first-${Math.random().toString(36).slice(2)}.jsonl`);
      const middlePath = join(dir, `middle-${Math.random().toString(36).slice(2)}.jsonl`);
      const currentPath = join(dir, `current-${Math.random().toString(36).slice(2)}.jsonl`);
      writeFileSync(firstPath, first.map(ev => JSON.stringify(ev)).join('\n') + '\n');
      writeFileSync(middlePath, middle.map(ev => JSON.stringify(ev)).join('\n') + '\n');
      writeFileSync(currentPath, JSON.stringify(clearTranscript(9_000)) + '\n');
      const firstWorker = startBridgeWatcherForTest(firstPath, firstPath, new BackgroundTaskTracker());
      for (const path of [middlePath, currentPath]) {
        loadWorkerFunction<(path: string, cutoff: number, reason: string) => void>(
          'performRotationSwitch', firstWorker,
        )(path, 0, 'test');
      }
      const storePath = join(dataDir, 'turn-marks', 'sid-bgseed.background-transcripts.json');
      expect(readBackgroundTranscriptChain(storePath).map(segment => segment.path))
        .toEqual([firstPath, middlePath, currentPath].map(normalizeBackgroundTranscriptPath));

      const reattachedTracker = new BackgroundTaskTracker();
      startBridgeWatcherForTest(firstPath, currentPath, reattachedTracker, CLI_STARTED);
      expect(reattachedTracker.backgroundWait(CLI_STARTED + 10_000)).toBe(expected);
    } finally {
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
    }
  });

  it('preserves chronological byte ranges when a later turn revisits an earlier transcript', () => {
    const dataDir = join(dir, `data-${Math.random().toString(36).slice(2)}`);
    const previousDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dataDir;
    try {
      const firstPath = join(dir, 'revisit-a.jsonl');
      const middlePath = join(dir, 'revisit-b.jsonl');
      const firstText = launchedAndEnded.map(ev => JSON.stringify(ev)).join('\n') + '\n';
      const firstBytes = Buffer.byteLength(firstText);
      writeFileSync(firstPath, firstText);
      writeFileSync(middlePath, JSON.stringify(prompt(4_000)) + '\n');
      const firstWorker = startBridgeWatcherForTest(firstPath, firstPath, new BackgroundTaskTracker());
      const rotate = loadWorkerFunction<(path: string, cutoff: number, reason: string) => void>(
        'performRotationSwitch', firstWorker,
      );
      rotate(middlePath, 0, 'test');
      appendFileSync(firstPath, [prompt(5_000), finalAnswer(6_000), turnDuration(6_100)]
        .map(ev => JSON.stringify(ev)).join('\n') + '\n');
      rotate(firstPath, 0, 'test');

      const storePath = join(dataDir, 'turn-marks', 'sid-bgseed.background-transcripts.json');
      const segments = readBackgroundTranscriptChain(storePath);
      expect(segments.map(segment => segment.path))
        .toEqual([firstPath, middlePath, firstPath].map(normalizeBackgroundTranscriptPath));
      expect(segments[0]).toMatchObject({ fromOffset: 0, toOffset: firstBytes });
      expect(segments[2]).toMatchObject({ fromOffset: firstBytes });

      const tracker = new BackgroundTaskTracker();
      startBridgeWatcherForTest(firstPath, firstPath, tracker, CLI_STARTED);
      expect(tracker.backgroundWait(CLI_STARTED + 10_000)).toBe(1);
    } finally {
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
    }
  });

  it.each(['dot', 'symlink'] as const)('does not replay the same file twice through a %s alias', kind => {
    const dataDir = join(dir, `data-${Math.random().toString(36).slice(2)}`);
    const previousDataDir = process.env.SESSION_DATA_DIR;
    process.env.SESSION_DATA_DIR = dataDir;
    try {
      const currentPath = join(dir, 'alias-target.jsonl');
      writeFileSync(currentPath, [prompt(1_000), workflowLaunch(2_000)].map(ev => JSON.stringify(ev)).join('\n') + '\n');
      const attachPath = kind === 'dot' ? `${dir}/./alias-target.jsonl` : join(dir, 'alias-link.jsonl');
      if (kind === 'symlink') symlinkSync(currentPath, attachPath);
      const tracker = new BackgroundTaskTracker();
      startBridgeWatcherForTest(attachPath, currentPath, tracker, CLI_STARTED);
      expect(tracker.pendingTurnAgents()).toBe(1);
      const storePath = join(dataDir, 'turn-marks', 'sid-bgseed.background-transcripts.json');
      expect(readBackgroundTranscriptChain(storePath)).toHaveLength(1);
    } finally {
      if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = previousDataDir;
    }
  });

  it('does not retain a partial replay when scanning fails', () => {
    const seeded = seedDetailed(launchedAndEnded, CLI_STARTED, {
      scan: (_path, _offset, opts) => {
        opts.onLine?.(JSON.stringify(workflowLaunch(2_000)), 0);
        opts.onError?.(new Error('injected EIO'));
        return null;
      },
    });
    expect(seeded.cursor).toBeNull();
    expect(seeded.tracker.pending(CLI_STARTED + 10_000)).toBe(0);
  });

  it('holds baseline after a failed seed so a later retry cannot skip appended records', () => {
    const appendedTurn = [prompt(6_000), workflowLaunch(7_000), finalAnswer(8_000), turnDuration(8_100)];
    let fail = true;
    const seeded = seedDetailed([prompt(1_000), finalAnswer(2_000), turnDuration(2_100)], CLI_STARTED, {
      onCurrentScanned(path) {
        appendFileSync(path, appendedTurn.map(ev => JSON.stringify(ev)).join('\n') + '\n');
      },
      scan: (path, offset, opts) => {
        if (!fail) return scanJsonlFromOffset(path, offset, opts);
        opts.onError?.(new Error('injected EIO'));
        return null;
      },
    });
    expect(seeded.cursor).toBeNull();
    const failedBaseline = absorbBaselineForTest(seeded.path, seeded.cursor);
    expect(failedBaseline.bridgeBaselineDone).toBe(false);
    expect(failedBaseline.bridgeOffset).toBe(0);

    fail = false;
    const retryCursor = loadWorkerFunction<(paths?: readonly string[]) => JsonlCursor | null | undefined>(
      'seedBackgroundTasksFromTranscript', seeded.scope,
    )();
    expect(retryCursor).toMatchObject({ newOffset: expect.any(Number) });
    const retriedBaseline = absorbBaselineForTest(seeded.path, retryCursor);
    expect(retriedBaseline.bridgeBaselineDone).toBe(true);
    expect(retriedBaseline.bridgeOffset).toBe(retryCursor!.newOffset);
    expect(seeded.tracker.backgroundWait(CLI_STARTED + 10_000)).toBe(1);
  });
});

describe('turn_terminal background task count', () => {
  function terminalFor(status: 'completed' | 'failed', running: number) {
    const scope: Record<string, any> = {
      sessionId: 'sid',
      currentBotmuxTurnId: undefined,
      currentBotmuxDispatchAttempt: undefined,
      queuedTypeAheadTurns: [],
      retiredTurnIds: new Set<string>(),
      activeTurnAuthority: new ActiveTurnAuthority(),
      emittedTurnTerminals: new TurnTerminalDeduper(),
      submitFailureChains: new Map(),
      cliSpawnGeneration: 1,
      cancelSubmitFailureChainForTerminal: vi.fn(),
      turnExecutionClock: { settle: () => ({ completedAtMs: 1000, durationMs: 5 }), forget: vi.fn() },
      codexBridgeQueue: { dropPendingTurn: () => false },
      terminalReleasesDurableTurn: () => false,
      remoteRunnerRecoveredTurnInFlight: false,
      flushPending: vi.fn(),
      queueMicrotask: (fn: () => void) => fn(),
      syncQueuedTurnsFromMarkerDisk: () => false,
      crossPrincipalIsolationOn: () => false,
      backgroundTaskTracker: { backgroundWait: () => running },
      send: vi.fn(),
      log: vi.fn(),
    };
    scope.markTurnRetired = (turnId?: string) => { if (turnId) scope.retiredTurnIds.add(turnId); };
    for (const name of [
      'turnAuthorityIdentity', 'adoptActiveTurnWhenIsolationOff', 'activeTurnBlocks', 'markActiveTurnStarted',
      'releaseActiveTurnAuthority', 'releaseTerminatedActiveTurnAuthority', 'retireTerminatedQueuedTurn',
      'advanceQueuedTypeAheadTurn', 'emitTurnTerminal', 'dropQueuedTurnRecord', 'turnTerminalEmitted',
      'retireTerminatedMarkerTurn',
    ]) scope[name] = loadWorkerFunction(name, scope);
    scope.emitTurnTerminal('om_t', status, status === 'failed' ? 'provider_x' : undefined, 1);
    return scope.send.mock.calls.map((call: any[]) => call[0]).find((m: any) => m.type === 'turn_terminal');
  }

  it('reports the running background tasks on a completed turn', () => {
    expect(terminalFor('completed', 2)).toMatchObject({ status: 'completed', backgroundTasks: 2 });
  });

  it('omits the count when nothing runs or the turn did not complete', () => {
    expect(terminalFor('completed', 0)).not.toHaveProperty('backgroundTasks');
    expect(terminalFor('failed', 2)).not.toHaveProperty('backgroundTasks');
  });
});
