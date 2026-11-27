import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { createAntigravityAdapter, isAntigravityInterruptedScreen, isAntigravityWorkingScreen, parseAntigravityFooterBackgroundTasks } from '../src/adapters/cli/antigravity.js';
import { bridgeSpecFor } from '../src/adapters/cli/registry.js';
import {
  antigravityRecoveryBindPath,
  decideAntigravityFullUpgrade,
  decideAntigravityNotifyAction,
  decideAntigravityTickerAction,
} from '../src/services/antigravity-bridge-decision.js';
import {
  drainAntigravityTranscript,
  hasAntigravityPendingTasks,
  mapAntigravityCompactOffsetToFull,
  resolveAntigravityTranscriptPath,
  type AntigravityTranscriptState,
} from '../src/services/antigravity-transcript.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { busyProbeRegion } from '../src/utils/busy-probe.js';
import { stripAnsiScreenText } from '../src/utils/idle-detector.js';
import { StructuredMissingFinalWatchdog } from '../src/services/structured-missing-final.js';
import { stripAnsiForLog, tailChars } from '../src/utils/crash-log.js';

const SIBLING_ID = '61fc8ef7-1886-40af-9bac-c6ee8f8d172e';
const REAL_ID = 'a4331552-f261-4f1f-a460-e15e7f2fe0ea';

function writeAntigravityUserStep(path: string, stepIndex: number, text: string): void {
  appendFileSync(path, JSON.stringify({
    step_index: stepIndex,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: new Date(Date.now()).toISOString(),
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
  }) + '\n');
}

function writeAntigravityFinalStep(path: string, stepIndex: number, text: string): void {
  appendFileSync(path, JSON.stringify({
    step_index: stepIndex,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: new Date(Date.now()).toISOString(),
    content: text,
  }) + '\n');
}

describe('Antigravity startup session discovery & zero-prompt bridge rebind', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bmx-agy-rebind-'));
    previousHome = process.env.HOME;
    process.env.HOME = root;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('withholds workspace summary hijack and startup ListConversations DB fallback until --log-file records Streaming conversation', async () => {
    vi.resetModules();
    const discovery = await import('../src/services/antigravity-discovery.js');
    const agyRoot = join(root, '.gemini', 'antigravity-cli');
    mkdirSync(agyRoot, { recursive: true });
    const summariesDbPath = join(agyRoot, 'conversation_summaries.db');
    const summariesDb = openDatabaseSyncOrThrow(summariesDbPath);
    summariesDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        workspace_uris TEXT NOT NULL,
        last_modified_time DATETIME NOT NULL
      );
    `);
    summariesDb.prepare(
      'INSERT INTO conversation_summaries (conversation_id, workspace_uris, last_modified_time) VALUES (?, ?, ?)',
    ).run(SIBLING_ID, JSON.stringify(['file:///workspace/shared']), '2026-11-12 12:10:00');
    summariesDb.close();

    const realFind = discovery.findAntigravityConversationId;
    let fakePidResult: string | null = SIBLING_ID;
    const findSpy = vi.spyOn(discovery, 'findAntigravityConversationId').mockImplementation((opts) => {
      if (opts.pid) return fakePidResult;
      return realFind({ ...opts, summariesDbPath });
    });

    const { createAntigravityAdapter } = await import('../src/adapters/cli/antigravity.js');
    const adapter = createAntigravityAdapter('/usr/local/bin/agy');
    const args = adapter.buildArgs({
      sessionId: '08fa7247-2db1-4bea-8b89-e7d4de8c5a1d',
      resume: false,
      reattach: false,
    });
    const logFlagIdx = args.indexOf('--log-file');
    expect(logFlagIdx).toBeGreaterThanOrEqual(0);
    const logPath = args[logFlagIdx + 1]!;

    // 1. Before cliPid is wired, managed sessions must NOT fall back to workspace summaries.
    expect(adapter.resolveActiveSessionId!({
      cliPid: undefined,
      cliCwd: '/workspace/shared',
    })).toBeUndefined();

    // 2. Once agy starts writing --log-file (e.g. startup ListConversations indexing),
    // transient open DB fds must NOT be claimed before Streaming conversation appears.
    findSpy.mockClear();
    writeFileSync(
      logPath,
      'I1112 12:10:53.869907 192 server.go:3092] ListConversations: cache miss for 62 conversations\n',
    );
    expect(adapter.resolveActiveSessionId!({
      cliPid: 2144783,
      cliCwd: '/workspace/shared',
    })).toBeUndefined();
    expect(findSpy).not.toHaveBeenCalled();

    // 3. As soon as --log-file emits Streaming conversation, resolveActiveSessionId returns it.
    appendFileSync(
      logPath,
      `I1112 12:11:00.848983 2322 conversation_manager.go:1044] Streaming conversation ${REAL_ID}\n`,
    );
    expect(adapter.resolveActiveSessionId!({
      cliPid: 2144783,
      cliCwd: '/workspace/shared',
    })).toBe(REAL_ID);

    // 4. Warm reattach (`reattach: true`) with a rotated log still permits PID discovery.
    const reattached = createAntigravityAdapter('/usr/local/bin/agy');
    const reattachArgs = reattached.buildArgs({
      sessionId: 'reattach-session',
      resume: true,
      reattach: true,
      resumeSessionId: REAL_ID,
    });
    const reattachLogPath = reattachArgs[reattachArgs.indexOf('--log-file') + 1]!;
    writeFileSync(reattachLogPath, 'ordinary output after 256KB rotation\n');
    fakePidResult = REAL_ID;
    expect(reattached.resolveActiveSessionId!({
      cliPid: 2144783,
      cliCwd: '/workspace/shared',
    })).toBe(REAL_ID);
  });

  it('rebinds codexBridgeNotifyCliSessionId away from an initially misbound sibling transcript without draining foreign turns', () => {
    const brainDir = join(root, '.gemini', 'antigravity-cli', 'brain');
    const makeTranscript = (cid: string): string => {
      const dir = join(brainDir, cid, '.system_generated', 'logs');
      mkdirSync(dir, { recursive: true });
      const fullPath = join(dir, 'transcript_full.jsonl');
      writeFileSync(fullPath, '');
      return fullPath;
    };

    const siblingPath = makeTranscript(SIBLING_ID);
    const realPath = makeTranscript(REAL_ID);

    const emittedFinals: Array<{ turnId: string; text: string }> = [];
    const queue = new CodexBridgeQueue(() => Date.now());

    const scope: Record<string, any> = {
      codexBridgeRolloutPath: undefined,
      codexBridgeOffset: 0,
      codexBridgePendingTail: '',
      codexBridgeBaselineDone: false,
      codexBridgeWatcher: null,
      codexBridgePendingSessionId: undefined,
      codexBridgeUnprovenSession: undefined,
      codexAdoptPendingPid: undefined,
      structuredBridgeRecoveryAttempted: false,
      structuredBridgeDriverState: undefined,
      ompQuietCandidateKey: undefined,
      ompQuietCandidateCompleteOffset: undefined,
      antigravityQuietCandidateKey: undefined,
      antigravityQuietCandidateCompleteOffset: undefined,
      antigravityFullUpgradeAttemptKey: undefined,
      antigravitySpawnStartMs: Date.now(),
      lastSpawnEffectiveResume: false,
      lastInitConfig: { cliId: 'antigravity', workingDir: root },
      cliAdapter: { id: 'antigravity', postTerminalPromptFence: false },
      codexBridgeQueue: queue,
      codexSubagentLimitTracker: { clear: () => {}, observe: () => {}, poll: () => [] },
      codexServiceTierTracker: { bind: () => {}, observe: () => {} },
      rpcTurnsAwaitingActivation: new Map(),
      rpcTranscriptIngestBlockedByAwaitingActivation: () => false,
      structuredBridgeIs: (id: string) => id === 'antigravity',
      bridgeSpecFor: (id?: string) => (id === 'antigravity' ? { stateCommit: 'ingest' } : undefined),
      codexBridgeFallbackActive: () => true,
      nativeSessionForkPending: () => false,
      resolveFileBridgePath: (_cliId: string, opts: { sessionId?: string }) =>
        resolveAntigravityTranscriptPath(opts.sessionId, { brainDir }) ?? undefined,
      structuredBridgeIngestPath: (path: string, offset: number, opts?: { flushAntigravityTrailingFinal?: boolean }) => {
        const res = drainAntigravityTranscript(
          path,
          offset,
          (scope.structuredBridgeDriverState as AntigravityTranscriptState | undefined) ?? {},
          {
            flushTrailingFinal: opts?.flushAntigravityTrailingFinal,
            adoptMode: scope.lastInitConfig?.adoptMode === true,
          },
        );
        return { ...res, state: res.state };
      },
      decideAntigravityNotifyAction,
      decideAntigravityTickerAction,
      decideAntigravityFullUpgrade,
      antigravityRecoveryBindPath,
      mapAntigravityCompactOffsetToFull,
      existsSync,
      statSync,
      fsWatch: () => ({ close: () => {} }),
      codexBridgeStartTimer: vi.fn(),
      checkpointStructuredBridgeRecovery: () => {},
      observeStructuredBackgroundTasks: () => {},
      noteSpawnArgvTurnStartTranscriptEvidence: () => {},
      pruneExpiredStructuredHeadsAndEmit: () => {},
      emitReadyCodexTurns: () => {
        for (const ready of queue.drainEmittable()) {
          if (ready.finalText !== undefined) {
            emittedFinals.push({ turnId: ready.turnId, text: ready.finalText });
          }
        }
      },
      idleDetector: { fireIdle: vi.fn() },
      OrcaBackend: class {},
      backend: null,
      log: vi.fn(),
    };

    scope.antigravityLateAttachMode = loadWorkerFunction('antigravityLateAttachMode', scope);
    scope.codexBridgeDetachFile = loadWorkerFunction('codexBridgeDetachFile', scope);
    scope.codexBridgeAttach = loadWorkerFunction('codexBridgeAttach', scope);
    scope.codexBridgeIngest = loadWorkerFunction('codexBridgeIngest', scope);
    const notifySessionId = loadWorkerFunction<(sid: string) => void>('codexBridgeNotifyCliSessionId', scope);

    // Step 1: Bridge is initially misbound to sibling conversation A.
    notifySessionId(SIBLING_ID);
    expect(scope.codexBridgeRolloutPath).toBe(siblingPath);

    // Step 2: Queue our session's real turn (`继续`), and simulate sibling A ALSO
    // receiving an identical prompt text (`继续`) + wrong answer on disk!
    const prompt = '继续';
    queue.mark('om_turn_real', prompt, Date.now());
    writeAntigravityUserStep(siblingPath, 1, prompt);
    writeAntigravityFinalStep(siblingPath, 2, 'WRONG_SIBLING_FINAL');

    // Real conversation B already logged our live USER_INPUT + provisional final.
    writeAntigravityUserStep(realPath, 1, prompt);
    writeAntigravityFinalStep(realPath, 2, 'CORRECT_REAL_FINAL');

    // Step 3: Authoritative session ID B arrives. Previously codexBridgeNotifyCliSessionId
    // returned early inside `if (codexBridgeRolloutPath)` and left siblingPath bound!
    notifySessionId(REAL_ID);
    expect(scope.codexBridgeRolloutPath).toBe(realPath);
    expect(queue.peek()[0]?.started).toBe(true);
    expect(emittedFinals).toEqual([]);

    // Step 4: Quiet tick flushes B's provisional final — delivers CORRECT_REAL_FINAL, never sibling's!
    scope.codexBridgeIngest({ flushAntigravityTrailingFinal: true });
    scope.emitReadyCodexTurns();
    expect(emittedFinals).toEqual([{ turnId: 'om_turn_real', text: 'CORRECT_REAL_FINAL' }]);
  });

  it('waits for a lazily-created brain transcript on rebind without ingesting foreign turns, while still flushing a started /new turn', () => {
    const brainDir = join(root, '.gemini', 'antigravity-cli', 'brain');
    const makeTranscript = (cid: string): string => {
      const dir = join(brainDir, cid, '.system_generated', 'logs');
      mkdirSync(dir, { recursive: true });
      const fullPath = join(dir, 'transcript_full.jsonl');
      writeFileSync(fullPath, '');
      return fullPath;
    };

    const firstPath = makeTranscript(SIBLING_ID);
    const emittedFinals: Array<{ turnId: string; text: string }> = [];
    const queue = new CodexBridgeQueue(() => Date.now());

    const scope: Record<string, any> = {
      codexBridgeRolloutPath: undefined,
      codexBridgeOffset: 0,
      codexBridgePendingTail: '',
      codexBridgeBaselineDone: false,
      codexBridgeWatcher: null,
      codexBridgePendingSessionId: undefined,
      codexBridgeUnprovenSession: undefined,
      codexAdoptPendingPid: undefined,
      structuredBridgeRecoveryAttempted: false,
      structuredBridgeDriverState: undefined,
      ompQuietCandidateKey: undefined,
      ompQuietCandidateCompleteOffset: undefined,
      antigravityQuietCandidateKey: undefined,
      antigravityQuietCandidateCompleteOffset: undefined,
      antigravityFullUpgradeAttemptKey: undefined,
      antigravitySpawnStartMs: Date.now(),
      lastSpawnEffectiveResume: false,
      lastInitConfig: { cliId: 'antigravity', workingDir: root },
      cliAdapter: { id: 'antigravity', postTerminalPromptFence: false },
      codexBridgeQueue: queue,
      codexSubagentLimitTracker: { clear: () => {}, observe: () => {}, poll: () => [] },
      codexServiceTierTracker: { bind: () => {}, observe: () => {} },
      rpcTurnsAwaitingActivation: new Map(),
      rpcTranscriptIngestBlockedByAwaitingActivation: () => false,
      structuredBridgeIs: (id: string) => id === 'antigravity',
      bridgeSpecFor: (id?: string) => (id === 'antigravity' ? { stateCommit: 'ingest' } : undefined),
      codexBridgeFallbackActive: () => true,
      nativeSessionForkPending: () => false,
      resolveFileBridgePath: (_cliId: string, opts: { sessionId?: string }) =>
        resolveAntigravityTranscriptPath(opts.sessionId, { brainDir }) ?? undefined,
      structuredBridgeIngestPath: (path: string, offset: number, opts?: { flushAntigravityTrailingFinal?: boolean }) => {
        const res = drainAntigravityTranscript(
          path,
          offset,
          (scope.structuredBridgeDriverState as AntigravityTranscriptState | undefined) ?? {},
          {
            flushTrailingFinal: opts?.flushAntigravityTrailingFinal,
            adoptMode: scope.lastInitConfig?.adoptMode === true,
          },
        );
        return { ...res, state: res.state };
      },
      decideAntigravityNotifyAction,
      decideAntigravityTickerAction,
      decideAntigravityFullUpgrade,
      antigravityRecoveryBindPath,
      mapAntigravityCompactOffsetToFull,
      existsSync,
      statSync,
      fsWatch: () => ({ close: () => {} }),
      codexBridgeStartTimer: vi.fn(),
      checkpointStructuredBridgeRecovery: () => {},
      observeStructuredBackgroundTasks: () => {},
      noteSpawnArgvTurnStartTranscriptEvidence: () => {},
      pruneExpiredStructuredHeadsAndEmit: () => {},
      emitReadyCodexTurns: () => {
        for (const ready of queue.drainEmittable()) {
          if (ready.finalText !== undefined) {
            emittedFinals.push({ turnId: ready.turnId, text: ready.finalText });
          }
        }
      },
      idleDetector: { fireIdle: vi.fn() },
      OrcaBackend: class {},
      backend: null,
      log: vi.fn(),
    };

    scope.antigravityLateAttachMode = loadWorkerFunction('antigravityLateAttachMode', scope);
    scope.codexBridgeDetachFile = loadWorkerFunction('codexBridgeDetachFile', scope);
    scope.codexBridgeAttach = loadWorkerFunction('codexBridgeAttach', scope);
    scope.codexBridgeIngest = loadWorkerFunction('codexBridgeIngest', scope);
    const notifySessionId = loadWorkerFunction<(sid: string) => void>('codexBridgeNotifyCliSessionId', scope);

    // Part A: Misbound firstPath + lazy-created REAL_ID (`wait-pending`).
    notifySessionId(SIBLING_ID);
    queue.mark('om_lazy_turn', 'same-prompt', Date.now());
    notifySessionId(REAL_ID);
    expect(scope.codexBridgePendingSessionId).toBe(REAL_ID);
    expect(scope.codexBridgeStartTimer).toHaveBeenCalled();

    // Foreign writes to firstPath while REAL_ID is pending must NOT start om_lazy_turn.
    writeAntigravityUserStep(firstPath, 1, 'same-prompt');
    writeAntigravityFinalStep(firstPath, 2, 'FOREIGN_LAZY_FINAL');
    scope.codexBridgeIngest();
    expect(queue.peek()[0]?.started).toBe(false);

    // Once REAL_ID's brain file appears, re-notifying (or ticker rotate) binds REAL_ID cleanly.
    const realPath = makeTranscript(REAL_ID);
    writeAntigravityUserStep(realPath, 1, 'same-prompt');
    writeAntigravityFinalStep(realPath, 2, 'OWNED_LAZY_FINAL');
    notifySessionId(REAL_ID);
    expect(scope.codexBridgeRolloutPath).toBe(realPath);
    expect(scope.codexBridgePendingSessionId).toBeUndefined();
    expect(queue.peek()[0]?.started).toBe(true);
    scope.codexBridgeIngest({ flushAntigravityTrailingFinal: true });
    scope.emitReadyCodexTurns();
    expect(emittedFinals).toEqual([{ turnId: 'om_lazy_turn', text: 'OWNED_LAZY_FINAL' }]);

    // Part B: Legitimate `/new` rotation where REAL_ID already started a turn with a held final.
    const thirdId = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    const thirdPath = makeTranscript(thirdId);
    queue.mark('om_before_new', 'before-new-prompt', Date.now());
    writeAntigravityUserStep(realPath, 3, 'before-new-prompt');
    writeAntigravityFinalStep(realPath, 4, 'HELD_BEFORE_NEW_FINAL');
    scope.codexBridgeIngest();
    expect(queue.peek()[0]?.started).toBe(true);
    expect(emittedFinals).toHaveLength(1);

    // User runs `/new` and submits `after-new-prompt` on thirdId.
    queue.mark('om_after_new', 'after-new-prompt', Date.now());
    writeAntigravityUserStep(thirdPath, 1, 'after-new-prompt');
    writeAntigravityFinalStep(thirdPath, 2, 'AFTER_NEW_FINAL');
    notifySessionId(thirdId);

    // The pre-/new held final was flushed before detaching realPath, and thirdPath started om_after_new!
    expect(emittedFinals).toEqual([
      { turnId: 'om_lazy_turn', text: 'OWNED_LAZY_FINAL' },
      { turnId: 'om_before_new', text: 'HELD_BEFORE_NEW_FINAL' },
    ]);
    expect(scope.codexBridgeRolloutPath).toBe(thirdPath);
    scope.codexBridgeIngest({ flushAntigravityTrailingFinal: true });
    scope.emitReadyCodexTurns();
    expect(emittedFinals).toEqual([
      { turnId: 'om_lazy_turn', text: 'OWNED_LAZY_FINAL' },
      { turnId: 'om_before_new', text: 'HELD_BEFORE_NEW_FINAL' },
      { turnId: 'om_after_new', text: 'AFTER_NEW_FINAL' },
    ]);
  });

  it('does not bypass cliAdapter.resolveActiveSessionId in armAntigravityCotForTurn when it intentionally returns undefined', () => {
    const pidFallback = vi.fn(() => SIBLING_ID);
    const persistCliSessionId = vi.fn();
    const ensureAntigravityCotReader = vi.fn();
    const resolveActiveSessionId = vi.fn(() => undefined);

    const scope: Record<string, any> = {
      cliAdapter: { id: 'antigravity', runnerFramedInput: false, resolveActiveSessionId },
      lastInitConfig: { cliId: 'antigravity', workingDir: root },
      lastSpawnEffectiveCliSessionId: undefined,
      backend: { cliPid: 2144783, getChildPid: () => 2144657 },
      codexAdoptPendingPid: undefined,
      nativeSessionForkPending: () => false,
      findLaunchedCliPid: () => 2144783,
      findAntigravityConversationIdByPid: pidFallback,
      persistCliSessionId,
      ensureAntigravityCotReader,
    };
    scope.currentAntigravityObservedPid = loadWorkerFunction('currentAntigravityObservedPid', scope);
    const armCot = loadWorkerFunction<() => void>('armAntigravityCotForTurn', scope);

    armCot();
    expect(resolveActiveSessionId).toHaveBeenCalledWith({ cliPid: 2144783, cliCwd: root });
    expect(pidFallback).not.toHaveBeenCalled();
    expect(persistCliSessionId).not.toHaveBeenCalled();
    expect(ensureAntigravityCotReader).not.toHaveBeenCalled();
  });
});

// A pid above Linux's pid_max: the real /proc scan behind it can never match a
// live process, so only the injected probes below decide what a "pid lookup" sees.
const AGY_PID = 2_147_483_000;
const STARTUP_LOG_LINE = 'I1112 12:10:53.869907 192 server.go:3092] ListConversations: cache miss for 62 conversations\n';
const streamingLine = (cid: string) => `I1112 12:11:00.848983 2322 conversation_manager.go:1044] Streaming conversation ${cid}\n`;

describe('Antigravity bridge ticker and spawn observer honor the adapter session authority', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bmx-agy-ticker-'));
    previousHome = process.env.HOME;
    process.env.HOME = root;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  /** Fresh-launch adapter whose native log is in agy's startup window: written,
   *  but no `Streaming conversation` yet (real agy 1.5.4 opens a sibling DB
   *  for ~25ms in exactly this window). */
  async function startupAdapter() {
    const { createAntigravityAdapter } = await import('../src/adapters/cli/antigravity.js');
    const adapter = createAntigravityAdapter('/usr/local/bin/agy');
    const args = adapter.buildArgs({ sessionId: 'b3f0c0de-0000-4000-8000-000000000001', resume: false, reattach: false });
    const logPath = args[args.indexOf('--log-file') + 1]!;
    writeFileSync(logPath, STARTUP_LOG_LINE);
    return { adapter, logPath };
  }

  /** The real worker bridge functions (notify, attach, detach, ingest and the
   *  1s ticker) against real transcript files and a real attribution queue.
   *  Only the clock source, the pid probe and the native-log authority are
   *  injected. */
  function bridgeHarness(cliAdapter: Record<string, any>, pidProbePath?: () => string | undefined) {
    const brainDir = join(root, '.gemini', 'antigravity-cli', 'brain');
    const makeTranscript = (cid: string): string => {
      const dir = join(brainDir, cid, '.system_generated', 'logs');
      mkdirSync(dir, { recursive: true });
      const fullPath = join(dir, 'transcript_full.jsonl');
      writeFileSync(fullPath, '');
      return fullPath;
    };
    const emittedFinals: Array<{ turnId: string; text: string }> = [];
    const pidLookups: number[] = [];
    const queue = new CodexBridgeQueue(() => Date.now());
    let tickCallback: (() => void) | undefined;
    const scope: Record<string, any> = {
      codexBridgeTimer: undefined,
      codexBridgeRolloutPath: undefined,
      codexBridgeOffset: 0,
      codexBridgePendingTail: '',
      codexBridgeBaselineDone: false,
      codexBridgeWatcher: null,
      codexBridgePendingSessionId: undefined,
      codexBridgeUnprovenSession: undefined,
      codexAdoptPendingPid: undefined,
      structuredBridgeRecoveryAttempted: false,
      structuredBridgeDriverState: undefined,
      ompQuietCandidateKey: undefined,
      ompQuietCandidateCompleteOffset: undefined,
      antigravityQuietCandidateKey: undefined,
      antigravityQuietCandidateCompleteOffset: undefined,
      antigravityFullUpgradeAttemptKey: undefined,
      antigravitySpawnStartMs: Date.now(),
      lastSpawnEffectiveResume: false,
      lastInitConfig: { cliId: 'antigravity', workingDir: root },
      cliAdapter,
      isPromptReady: true,
      codexBridgeQueue: queue,
      codexSubagentLimitTracker: { clear: () => {}, observe: () => {}, poll: () => [] },
      codexServiceTierTracker: { bind: () => {}, observe: () => {} },
      rpcTurnsAwaitingActivation: new Map(),
      rpcTranscriptIngestBlockedByAwaitingActivation: () => false,
      structuredBridgeIs: (id: string) => id === 'antigravity',
      bridgeSpecFor: (id?: string) => (id === 'antigravity' ? { stateCommit: 'ingest' } : undefined),
      codexBridgeFallbackActive: () => true,
      nativeSessionForkPending: () => false,
      currentAntigravityObservedPid: () => AGY_PID,
      resolveFileBridgePath: (_cliId: string, opts: { sessionId?: string; pid?: number }) => {
        if (opts.sessionId) return resolveAntigravityTranscriptPath(opts.sessionId, { brainDir }) ?? undefined;
        if (opts.pid) {
          pidLookups.push(opts.pid);
          return pidProbePath?.();
        }
        return undefined;
      },
      structuredBridgeIngestPath: (path: string, offset: number, opts?: { flushAntigravityTrailingFinal?: boolean }) => {
        const res = drainAntigravityTranscript(
          path,
          offset,
          (scope.structuredBridgeDriverState as AntigravityTranscriptState | undefined) ?? {},
          {
            flushTrailingFinal: opts?.flushAntigravityTrailingFinal,
            adoptMode: scope.lastInitConfig?.adoptMode === true,
          },
        );
        return { ...res, state: res.state };
      },
      decideAntigravityNotifyAction,
      decideAntigravityTickerAction,
      decideAntigravityFullUpgrade,
      antigravityRecoveryBindPath,
      mapAntigravityCompactOffsetToFull,
      existsSync,
      statSync,
      fsWatch: () => ({ close: () => {} }),
      setInterval: (callback: () => void, interval: number) => {
        expect(interval).toBe(1_000);
        tickCallback = callback;
        return 1;
      },
      // The quiet-tick flush and the compact→full upgrade are separate,
      // already-tested policies; the rebind decision under test runs before both.
      maybeUpgradeAntigravityBridgeToFull: () => {},
      holdStructuredStartLeasesWhileAntigravityViewportBusy: () => {},
      maybeFlushAntigravityTrailingFinalOnQuietTick: () => {},
      checkpointStructuredBridgeRecovery: () => {},
      observeStructuredBackgroundTasks: () => {},
      noteSpawnArgvTurnStartTranscriptEvidence: () => {},
      pruneExpiredStructuredHeadsAndEmit: () => false,
      emitReadyCodexTurns: () => {
        for (const ready of queue.drainEmittable()) {
          if (ready.finalText !== undefined) emittedFinals.push({ turnId: ready.turnId, text: ready.finalText });
        }
      },
      idleDetector: { fireIdle: vi.fn() },
      OrcaBackend: class {},
      backend: null,
      log: vi.fn(),
    };
    scope.antigravityLateAttachMode = loadWorkerFunction('antigravityLateAttachMode', scope);
    scope.codexBridgeDetachFile = loadWorkerFunction('codexBridgeDetachFile', scope);
    scope.codexBridgeAttach = loadWorkerFunction('codexBridgeAttach', scope);
    scope.codexBridgeIngest = loadWorkerFunction('codexBridgeIngest', scope);
    scope.codexBridgeStartTimer = loadWorkerFunction('codexBridgeStartTimer', scope);
    const notify = loadWorkerFunction<(sid: string, options?: { preserveLiveTurn?: boolean }) => void>('codexBridgeNotifyCliSessionId', scope);
    const tick = () => {
      if (!tickCallback) throw new Error('bridge ticker was not armed');
      tickCallback();
      expect(scope.log.mock.calls.filter(([message]: [string]) => /tick error/.test(message))).toEqual([]);
    };
    const flushQuietFinal = () => {
      scope.codexBridgeIngest({ flushAntigravityTrailingFinal: true });
      scope.emitReadyCodexTurns();
    };
    return { scope, queue, emittedFinals, pidLookups, makeTranscript, notify, tick, flushQuietFinal };
  }

  it.each([
    { via: 'notify', adoptMode: true },
    { via: 'notify', adoptMode: true, bufferedInput: true },
    { via: 'notify', adoptMode: true, skipOldIngest: true },
    { via: 'notify', adoptMode: true, failAfterIngest: true },
    { via: 'notify', adoptMode: false },
    { via: 'notify', adoptMode: false, bufferedInput: true },
    { via: 'notify', adoptMode: false, skipOldIngest: true },
    { via: 'notify', adoptMode: false, failAfterIngest: true },
    { via: 'ticker', adoptMode: false },
    { via: 'ticker', adoptMode: false, bufferedInput: true },
    { via: 'ticker', adoptMode: false, skipOldIngest: true },
  ])('settles a retired subagent wait before the new conversation reply ($via, adopt=$adoptMode, buffered=$bufferedInput, unread=$skipOldIngest, failure=$failAfterIngest)', ({ via, adoptMode, bufferedInput, skipOldIngest, failAfterIngest }) => {
    const h = bridgeHarness({ id: 'antigravity', postTerminalPromptFence: false });
    h.scope.lastInitConfig.adoptMode = adoptMode;
    const oldPath = h.makeTranscript(SIBLING_ID);
    h.notify(SIBLING_ID);
    h.queue.mark('old-turn', 'Old request', Date.now(), undefined, undefined, undefined, adoptMode);
    writeAntigravityUserStep(oldPath, 1, 'Old request');
    appendFileSync(oldPath, JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'Created the following subagent:\n{ "conversationId": "pending-agent" }' }) + '\n');
    writeAntigravityFinalStep(oldPath, 3, 'Waiting for subagent');
    if (skipOldIngest) {
      // /new can precede fs.watch/the next poll, so retirement must discover
      // and settle this owner in one drain before detaching the old file.
      expect(h.queue.peek()[0]).toMatchObject({ turnId: 'old-turn', started: false });
    } else {
      h.scope.codexBridgeIngest();
      expect(h.queue.peek()[0]).toMatchObject({ turnId: 'old-turn', started: true });
      expect(h.queue.peek()[0]?.finalText).toBeUndefined();
      expect(h.scope.structuredBridgeDriverState.pendingSubagentIds).toEqual(['pending-agent']);
    }
    if (bufferedInput) {
      h.queue.mark('intermediate-turn', 'Intermediate request', Date.now(), undefined, undefined, undefined, adoptMode);
      writeAntigravityUserStep(oldPath, 4, 'Intermediate request');
      appendFileSync(oldPath, JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'Created the following subagent:\n{ "conversationId": "pending-second-agent" }' }) + '\n');
      writeAntigravityFinalStep(oldPath, 6, 'Waiting for second subagent');
    }
    if (failAfterIngest) {
      // Fail after events/state are committed but before retirement selects
      // the old owner. The next ingest must not fail again during the probe.
      let failOnce = true;
      h.scope.observeStructuredBackgroundTasks = () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('injected post-ingest failure');
        }
      };
    }
    const nextPath = h.makeTranscript(REAL_ID);
    h.queue.mark('new-turn', 'New request', Date.now(), undefined, undefined, undefined, adoptMode);
    writeAntigravityUserStep(nextPath, 1, 'New request');
    writeAntigravityFinalStep(nextPath, 2, 'New answer');
    if (via === 'ticker') {
      h.scope.codexBridgePendingSessionId = REAL_ID;
      h.scope.codexBridgeStartTimer();
      h.tick();
    } else {
      h.notify(REAL_ID);
    }
    if (failAfterIngest) {
      expect(h.scope.log.mock.calls.some(([message]: [string]) =>
        /pre-rotation bridge drain failed: injected post-ingest failure/.test(message))).toBe(true);
    }
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([
      { turnId: 'old-turn', text: '' },
      ...(bufferedInput ? [{ turnId: 'intermediate-turn', text: '' }] : []),
      { turnId: 'new-turn', text: 'New answer' },
    ]);
    expect(h.queue.peek()).toEqual([]);
    expect(h.scope.codexBridgeRolloutPath).toBe(nextPath);
    // The retired transcript can still receive results; it is no longer read.
    appendFileSync(oldPath, JSON.stringify({ type: 'SYSTEM_MESSAGE', content: '[Message] sender=pending-agent content=late result' }) + '\n');
    writeAntigravityFinalStep(oldPath, 5, 'Old late final');
    h.flushQuietFinal();
    expect(h.emittedFinals).toHaveLength(bufferedInput ? 3 : 2);
  });

  it.each([
    { via: 'notify', adoptMode: false },
    { via: 'notify', adoptMode: true },
    { via: 'ticker', adoptMode: false },
    { via: 'ticker', adoptMode: true },
  ])('migrates an already-attributed live owner on authoritative rebind ($via, adopt=$adoptMode)', ({ via, adoptMode }) => {
    const h = bridgeHarness({ id: 'antigravity', postTerminalPromptFence: false });
    h.scope.lastInitConfig.adoptMode = adoptMode;
    if (adoptMode) h.queue.setLocalTurns(true, Date.now() - 1000);
    const siblingPath = h.makeTranscript(SIBLING_ID);
    h.notify(SIBLING_ID);
    h.queue.mark('live-turn', 'Same live request', Date.now(), undefined, undefined, undefined, adoptMode);
    writeAntigravityUserStep(siblingPath, 1, 'Same live request');
    appendFileSync(siblingPath, JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'Created the following subagent:\n{ "conversationId": "pending-agent" }' }) + '\n');
    writeAntigravityFinalStep(siblingPath, 3, 'Sibling waiting narration');
    h.scope.codexBridgeIngest();
    expect(h.queue.peek()[0]).toMatchObject({ turnId: 'live-turn', started: true });
    expect(h.queue.peek()[0]?.finalText).toBeUndefined();

    // No newer Lark mark exists: the authoritative file contains the SAME
    // turn's answer, not a replacement request.
    if (via === 'notify') {
      const realPath = h.makeTranscript(REAL_ID);
      writeAntigravityUserStep(realPath, 1, 'Same live request');
      writeAntigravityFinalStep(realPath, 2, 'REAL_LIVE_ANSWER');
      h.notify(REAL_ID, { preserveLiveTurn: true });
      expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    } else {
      h.notify(REAL_ID, { preserveLiveTurn: true });
      expect(h.scope.codexBridgePendingSessionId).toBe(REAL_ID);
      expect(h.scope.antigravityPendingRebind).toBe(true);
      // REAL is not readable yet. A sibling callback and quiet tick must not
      // settle the live owner with the wrong answer while rebind is pending.
      appendFileSync(siblingPath, JSON.stringify({ type: 'SYSTEM_MESSAGE', content: '[Message] sender=pending-agent content=sibling result' }) + '\n');
      writeAntigravityFinalStep(siblingPath, 4, 'WRONG_SIBLING_FINAL');
      h.flushQuietFinal();
      expect(h.emittedFinals).toEqual([]);
      expect(h.scope.codexBridgeRolloutPath).toBe(siblingPath);
      expect(h.queue.peek()[0]?.finalText).toBeUndefined();
      const realPath = h.makeTranscript(REAL_ID);
      writeAntigravityUserStep(realPath, 1, 'Same live request');
      writeAntigravityFinalStep(realPath, 2, 'REAL_LIVE_ANSWER');
      h.tick();
      expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
      expect(h.scope.antigravityPendingRebind).toBe(false);
    }
    expect(h.emittedFinals).toEqual([]);
    if (adoptMode) {
      expect(h.queue.peek()[0]?.sourceTurnId).toMatch(/^.*transcript_full\.jsonl:0$/);
      expect(h.queue.peek()[0]?.sourceTurnId).toContain(REAL_ID);
    }
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([{ turnId: 'live-turn', text: 'REAL_LIVE_ANSWER' }]);
    expect(h.queue.peek()).toEqual([]);
  });

  it.each([false, true])('deduplicates started users without absorbing same-text successors (adopt=%s)', adoptMode => {
    const h = bridgeHarness({ id: 'antigravity', postTerminalPromptFence: false });
    h.scope.lastInitConfig.adoptMode = adoptMode;
    if (adoptMode) h.queue.setLocalTurns(true, Date.now() - 1000);
    const siblingPath = h.makeTranscript(SIBLING_ID);
    h.notify(SIBLING_ID);
    h.queue.mark('turn-a', 'Repeat', Date.now(), undefined, undefined, undefined, adoptMode);
    writeAntigravityUserStep(siblingPath, 1, 'Repeat');
    appendFileSync(siblingPath, JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'Created the following subagent:\n{ "conversationId": "pending-agent" }' }) + '\n');
    writeAntigravityFinalStep(siblingPath, 3, 'Sibling waiting narration');
    h.scope.codexBridgeIngest();
    h.queue.mark('turn-b', 'Repeat', Date.now(), undefined, undefined, undefined, adoptMode);

    const realPath = h.makeTranscript(REAL_ID);
    writeAntigravityUserStep(realPath, 1, 'Repeat');
    writeAntigravityFinalStep(realPath, 2, 'REAL_A');
    h.notify(REAL_ID, { preserveLiveTurn: true });
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([{ turnId: 'turn-a', text: 'REAL_A' }]);
    expect(h.queue.peek()).toHaveLength(1);
    expect(h.queue.peek()[0]).toMatchObject({ turnId: 'turn-b', started: false });
    expect(h.queue.peek()[0]?.finalText).toBeUndefined();

    // Only A's already-owned user was absorbed. B's later record must still
    // start and settle its own same-text turn normally.
    writeAntigravityUserStep(realPath, 3, 'Repeat');
    writeAntigravityFinalStep(realPath, 4, 'REAL_B');
    h.scope.codexBridgeIngest();
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([
      { turnId: 'turn-a', text: 'REAL_A' },
      { turnId: 'turn-b', text: 'REAL_B' },
    ]);
    expect(h.queue.peek()).toEqual([]);
  });

  it.each([false, true])('reconciles REAL history instead of replaying it (adopt=%s)', adoptMode => {
    const h = bridgeHarness({ id: 'antigravity', postTerminalPromptFence: false });
    h.scope.lastInitConfig.adoptMode = adoptMode;
    if (adoptMode) h.queue.setLocalTurns(true, Date.now() - 1000);
    const siblingPath = h.makeTranscript(SIBLING_ID);
    h.notify(SIBLING_ID);

    h.queue.mark('turn-a', 'Request A', Date.now(), undefined, undefined, undefined, adoptMode);
    writeAntigravityUserStep(siblingPath, 1, 'Request A');
    writeAntigravityFinalStep(siblingPath, 2, 'ANSWER_A');
    h.scope.codexBridgeIngest();
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([{ turnId: 'turn-a', text: 'ANSWER_A' }]);

    h.queue.mark('turn-b', 'Request B', Date.now(), undefined, undefined, undefined, adoptMode);
    writeAntigravityUserStep(siblingPath, 3, 'Request B');
    appendFileSync(siblingPath, JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'Created the following subagent:\n{ "conversationId": "pending-agent" }' }) + '\n');
    writeAntigravityFinalStep(siblingPath, 5, 'Waiting for B');
    h.scope.codexBridgeIngest();
    expect(h.queue.peek()[0]).toMatchObject({ turnId: 'turn-b', started: true });

    const realPath = h.makeTranscript(REAL_ID);
    writeAntigravityUserStep(realPath, 1, 'Request A');
    writeAntigravityFinalStep(realPath, 2, 'ANSWER_A');
    writeAntigravityUserStep(realPath, 3, 'Request B');
    writeAntigravityFinalStep(realPath, 4, 'REAL_B');
    h.notify(REAL_ID, { preserveLiveTurn: true });
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([
      { turnId: 'turn-a', text: 'ANSWER_A' },
      { turnId: 'turn-b', text: 'REAL_B' },
    ]);
    expect(h.queue.peek()).toEqual([]);
  });

  it.each([
    { shape: 'different-text', adoptMode: false },
    { shape: 'different-text', adoptMode: true },
    { shape: 'old-same-text', adoptMode: false },
    { shape: 'old-same-text', adoptMode: true },
    { shape: 'ambiguous-same-text', adoptMode: false },
    { shape: 'ambiguous-same-text', adoptMode: true },
  ])('reconciles an unstarted live mark against REAL history ($shape, adopt=$adoptMode)', ({ shape, adoptMode }) => {
    const h = bridgeHarness({ id: 'antigravity', postTerminalPromptFence: false });
    h.scope.lastInitConfig.adoptMode = adoptMode;
    if (adoptMode) h.queue.setLocalTurns(true, Date.now() - 1000);
    const siblingPath = h.makeTranscript(SIBLING_ID);
    h.notify(SIBLING_ID);
    const sameText = shape !== 'different-text';
    const textA = sameText ? 'Same text' : 'Request A';
    const textB = sameText ? 'Same text' : 'Request B';

    h.queue.mark('turn-a', textA, Date.now(), undefined, undefined, undefined, adoptMode);
    writeAntigravityUserStep(siblingPath, 1, textA);
    writeAntigravityFinalStep(siblingPath, 2, 'ANSWER_A');
    h.scope.codexBridgeIngest();
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([{ turnId: 'turn-a', text: 'ANSWER_A' }]);
    h.queue.mark('turn-b', textB, Date.now(), undefined, undefined, undefined, adoptMode);

    const realPath = h.makeTranscript(REAL_ID);
    if (shape === 'old-same-text') {
      appendFileSync(realPath, JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', step_index: 1,
        created_at: new Date(Date.now() - 60_000).toISOString(), content: textA }) + '\n');
    } else {
      writeAntigravityUserStep(realPath, 1, textA);
    }
    writeAntigravityFinalStep(realPath, 2, 'ANSWER_A');
    writeAntigravityUserStep(realPath, 3, textB);
    writeAntigravityFinalStep(realPath, 4, 'REAL_B');
    h.notify(REAL_ID, { preserveLiveTurn: true });
    h.flushQuietFinal();

    if (shape === 'ambiguous-same-text') {
      // Two recent same-text users are ambiguous. Do not bind the first one or
      // replay it as a local turn; keep the old binding and retry later.
      expect(h.scope.antigravityPendingRebind).toBe(true);
      expect(h.scope.codexBridgeRolloutPath).toBe(siblingPath);
      expect(h.emittedFinals).toEqual([{ turnId: 'turn-a', text: 'ANSWER_A' }]);
      expect(h.queue.peek()[0]).toMatchObject({ turnId: 'turn-b', started: false });
    } else {
      expect(h.emittedFinals).toEqual([
        { turnId: 'turn-a', text: 'ANSWER_A' },
        { turnId: 'turn-b', text: 'REAL_B' },
      ]);
      expect(h.queue.peek()).toEqual([]);
    }
  });

  it.each([false, true])('refuses ambiguous same-text matches for a started owner (adopt=%s)', adoptMode => {
    const h = bridgeHarness({ id: 'antigravity', postTerminalPromptFence: false });
    h.scope.lastInitConfig.adoptMode = adoptMode;
    if (adoptMode) h.queue.setLocalTurns(true, Date.now() - 1000);
    const siblingPath = h.makeTranscript(SIBLING_ID);
    h.notify(SIBLING_ID);
    h.queue.mark('live-turn', 'Same text', Date.now(), undefined, undefined, undefined, adoptMode);
    writeAntigravityUserStep(siblingPath, 1, 'Same text');
    appendFileSync(siblingPath, JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'Created the following subagent:\n{ "conversationId": "pending-agent" }' }) + '\n');
    writeAntigravityFinalStep(siblingPath, 3, 'Waiting');
    h.scope.codexBridgeIngest();
    const previousSource = h.queue.peek()[0]?.sourceTurnId;

    const realPath = h.makeTranscript(REAL_ID);
    writeAntigravityUserStep(realPath, 1, 'Same text');
    writeAntigravityFinalStep(realPath, 2, 'ANSWER_A');
    writeAntigravityUserStep(realPath, 3, 'Same text');
    writeAntigravityFinalStep(realPath, 4, 'REAL_B');
    h.notify(REAL_ID, { preserveLiveTurn: true });
    h.flushQuietFinal();
    expect(h.scope.antigravityPendingRebind).toBe(true);
    expect(h.scope.codexBridgeRolloutPath).toBe(siblingPath);
    expect(h.queue.peek()[0]?.sourceTurnId).toBe(previousSource);
    expect(h.emittedFinals).toEqual([]);
    expect(h.queue.peek()[0]?.finalText).toBeUndefined();
  });

  it.each([false, true])('binds adopt/managed owners to the actual REAL user offset (adopt=%s)', adoptMode => {
    const h = bridgeHarness({ id: 'antigravity', postTerminalPromptFence: false });
    h.scope.lastInitConfig.adoptMode = adoptMode;
    if (adoptMode) h.queue.setLocalTurns(true, Date.now() - 1000);
    const siblingPath = h.makeTranscript(SIBLING_ID);
    h.notify(SIBLING_ID);
    h.queue.mark('live-turn', 'Same live request', Date.now(), undefined, undefined, undefined, adoptMode);
    writeAntigravityUserStep(siblingPath, 1, 'Same live request');
    appendFileSync(siblingPath, JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'Created the following subagent:\n{ "conversationId": "pending-agent" }' }) + '\n');
    writeAntigravityFinalStep(siblingPath, 3, 'Sibling waiting narration');
    h.scope.codexBridgeIngest();

    const realPath = h.makeTranscript(REAL_ID);
    appendFileSync(realPath, JSON.stringify({ type: 'CHECKPOINT', content: 'prefix shifts the real user offset' }) + '\n');
    writeAntigravityUserStep(realPath, 2, 'Same live request');
    writeAntigravityFinalStep(realPath, 3, 'REAL_LIVE_ANSWER');
    h.notify(REAL_ID, { preserveLiveTurn: true });
    if (adoptMode) expect(h.queue.peek()[0]?.sourceTurnId).not.toBe(`${realPath}:0`);
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([{ turnId: 'live-turn', text: 'REAL_LIVE_ANSWER' }]);
    expect(h.queue.peek()).toEqual([]);
  });

  it('discards waiting narration through the real ingest path when managed input supersedes a pending turn', () => {
    const path = join(root, 'managed-retirement.jsonl');
    writeFileSync(path, '');
    writeAntigravityUserStep(path, 1, 'Old request');
    appendFileSync(path, JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'Created the following subagent:\n{ "conversationId": "pending-agent" }' }) + '\n');
    writeAntigravityFinalStep(path, 3, 'Waiting for subagent');
    const first = drainAntigravityTranscript(path, 0);
    expect(first.state.pendingSubagentIds).toEqual(['pending-agent']);
    writeAntigravityUserStep(path, 4, 'Intermediate request');

    const scope: Record<string, any> = {
      lastInitConfig: { cliId: 'antigravity', adoptMode: false },
      structuredBridgeDriverState: first.state,
      bridgeSpecFor,
      structuredBridgeIs: (id: string) => id === 'antigravity',
      nativeGoalSourcePath: undefined,
      nativeGoalGeneration: -1,
      cliSpawnGeneration: 1,
      nativeGoalCardEnabled: () => false,
    };
    const ingest = loadWorkerFunction<(
      path: string,
      offset: number,
    ) => ReturnType<typeof drainAntigravityTranscript>>('structuredBridgeIngestPath', scope);
    const retired = ingest(path, first.newOffset);
    expect(retired.events.map(event => event.kind)).toEqual(['turn_aborted', 'user']);
    expect(retired.events[0]).toMatchObject({ text: '' });
    expect(retired.events[1]).toMatchObject({ text: 'Intermediate request' });
  });

  it.each(['held answer', 'running tool'])('retires an interrupted %s without publishing a reply', phase => {
    const path = join(root, 'interrupted.jsonl');
    const queue = new CodexBridgeQueue();
    queue.mark('om_first', 'First request', Date.now());
    writeAntigravityUserStep(path, 1, 'First request');
    if (phase === 'held answer') writeAntigravityFinalStep(path, 2, 'A provisional plan');
    const initial = drainAntigravityTranscript(path, 0);
    queue.ingest(initial.events);
    const interruptedScreen = [
      '● Bash(sleep 30)', '  ⎿  Interrupted · What should Antigravity CLI do instead?',
      '────────────────────────', '>', '────────────────────────', '? for shortcuts',
    ].join('\n');
    expect(isAntigravityInterruptedScreen(interruptedScreen)).toBe(true);
    let screen = 'Working…\nesc to cancel';
    const scope: Record<string, any> = {
      lastInitConfig: { cliId: 'antigravity', adoptMode: false },
      replyDeliveryMode: () => 'send',
      zeroPromptTerminalSync: () => false,
      cliSpawnGeneration: 1,
      codexBridgeRolloutPath: path,
      ptyOutputGeneration: { snapshot: () => 0 },
      structuredBridgeIs: (id: string) => id === 'antigravity',
      structuredBridgeDriverState: initial.state,
      antigravityBridgeState: () => scope.structuredBridgeDriverState,
      hasAntigravityPendingTasks,
      antigravityPendingRebind: false,
      antigravityQuietCandidateKey: undefined,
      antigravityQuietCandidateCompleteOffset: undefined,
      antigravityQuietCandidateFirstSeenAtMs: undefined,
      antigravityObservedWorkingOwner: undefined,
      antigravityInterruptedViewport: undefined,
      antigravityInterruptedFallbackWatchdog: new StructuredMissingFinalWatchdog(),
      codexBridgeOffset: initial.newOffset,
      codexBridgePendingTail: initial.pendingTail,
      backend: {},
      backendScreenEvidenceIsAuthoritativeForMutation: () => true,
      cliAdapter: createAntigravityAdapter(),
      idleDetector: undefined,
      shouldDeferAntigravityQuietFinalForProgramStatus: () => false,
      STALE_PROGRAM_STATUS_QUIET_MS: 1000,
      captureBackendScreen: () => screen,
      busyProbeRegion, stripAnsiScreenText, isAntigravityInterruptedScreen, parseAntigravityFooterBackgroundTasks,
      codexBridgeQueue: queue,
      emitReadyCodexTurns: () => {},
      codexBridgeIngest: () => { throw new Error('Interrupted text must not be flushed'); },
      log: () => {},
    };
    scope.noteAntigravityWorkingOwner = loadWorkerFunction('noteAntigravityWorkingOwner', scope);
    const tick = loadWorkerFunction<() => void>('maybeFlushAntigravityTrailingFinalOnQuietTick', scope);
    tick();
    screen = interruptedScreen;
    tick();
    expect(scope.structuredBridgeDriverState.provisionalFinal).toBeUndefined();
    expect(queue.drainEmittable()).toMatchObject([{
      turnId: 'om_first', finalText: '', terminalStatus: 'ambiguous',
      terminalErrorCode: 'antigravity_interrupted',
    }]);
    queue.mark('om_next', 'Next request', Date.now());
    writeAntigravityUserStep(path, 3, 'Next request');
    writeAntigravityFinalStep(path, 4, 'The next answer');
    const next = drainAntigravityTranscript(path, initial.newOffset, scope.structuredBridgeDriverState);
    scope.structuredBridgeDriverState = next.state;
    scope.codexBridgeOffset = next.newOffset;
    queue.ingest(next.events);
    tick();
    tick();
    expect(queue.drainEmittable()).toEqual([]);
    expect(scope.structuredBridgeDriverState.provisionalFinal?.text).toBe('The next answer');
  });

  function makeInterruptedWorkerRig(phase: string, opts: { deferStart?: boolean } = {}) {
    const dir = mkdtempSync(join(root, 'interrupt-rig-'));
    const path = join(dir, 'transcript.jsonl');
    const queue = new CodexBridgeQueue();
    queue.mark('om_first', 'First request', Date.now());
    writeAntigravityUserStep(path, 1, 'First request');
    if (phase === 'held answer') writeAntigravityFinalStep(path, 2, 'A provisional plan');
    const initial = drainAntigravityTranscript(path, 0);
    if (!opts.deferStart) queue.ingest(initial.events);
    const interruptedScreen = [
      '● Bash(sleep 30)', '  ⎿  Interrupted · What should Antigravity CLI do instead?',
      '────────────────────────', '>', '────────────────────────', '? for shortcuts',
    ].join('\n');
    let screen = interruptedScreen;
    const scope: Record<string, any> = {
      lastInitConfig: { cliId: 'antigravity', adoptMode: false },
      replyDeliveryMode: () => 'send',
      zeroPromptTerminalSync: () => false,
      cliSpawnGeneration: 1,
      codexBridgeRolloutPath: path,
      ptyOutputGeneration: { snapshot: () => 0 },
      structuredBridgeIs: (id: string) => id === 'antigravity',
      structuredBridgeDriverState: initial.state,
      antigravityBridgeState: () => scope.structuredBridgeDriverState,
      hasAntigravityPendingTasks,
      antigravityPendingRebind: false,
      antigravityQuietCandidateKey: undefined,
      antigravityQuietCandidateCompleteOffset: undefined,
      antigravityQuietCandidateFirstSeenAtMs: undefined,
      antigravityObservedWorkingOwner: undefined,
      antigravityWorkingScanTail: '',
      antigravityWorkingScanGeneration: 0,
      antigravityInterruptedViewport: undefined,
      antigravityInterruptedFallbackWatchdog: new StructuredMissingFinalWatchdog(),
      codexBridgeOffset: initial.newOffset,
      codexBridgePendingTail: initial.pendingTail,
      backend: {},
      backendScreenEvidenceIsAuthoritativeForMutation: () => true,
      cliAdapter: createAntigravityAdapter(),
      idleDetector: undefined,
      shouldDeferAntigravityQuietFinalForProgramStatus: () => false,
      STALE_PROGRAM_STATUS_QUIET_MS: 1000,
      captureBackendScreen: () => screen,
      busyProbeRegion, stripAnsiScreenText, isAntigravityInterruptedScreen, isAntigravityWorkingScreen, parseAntigravityFooterBackgroundTasks,
      tailChars, stripAnsiForLog,
      codexBridgeQueue: queue,
      emitReadyCodexTurns: () => {},
      codexBridgeIngest: () => { throw new Error('Interrupted text must not be flushed'); },
      log: () => {},
    };
    scope.noteAntigravityWorkingOwner = loadWorkerFunction('noteAntigravityWorkingOwner', scope);
    return {
      path, queue, scope, initial, interruptedScreen,
      start: () => queue.ingest(initial.events),
      tick: loadWorkerFunction<() => void>('maybeFlushAntigravityTrailingFinalOnQuietTick', scope),
      observeWorking: loadWorkerFunction<(data: string) => void>('observeAntigravityWorkingData', scope),
      setScreen: (next: string) => { screen = next; },
    };
  }

  it('binds split raw busy chunks to an unstarted owner before a fast Esc', () => {
    const rig = makeInterruptedWorkerRig('running tool', { deferStart: true });
    const owner = rig.queue.peek()[0]!;
    expect(owner.started).toBe(false);
    rig.observeWorking('console.log("esc to cancel")');
    expect(rig.scope.antigravityObservedWorkingOwner).toBeUndefined();
    rig.observeWorking('Working…\nesc to can');
    rig.observeWorking('cel\r');
    expect(rig.scope.antigravityObservedWorkingOwner).toBe(owner);
    rig.setScreen('Working…\nesc to cancel');
    rig.tick();
    expect(rig.scope.antigravityObservedWorkingOwner).toBe(owner);
    rig.setScreen(rig.interruptedScreen);
    rig.tick();

    // USER_INPUT starts the exact object that the raw stream armed. No viewport
    // busy tick is needed before the interrupted frame settles that owner.
    rig.start();
    expect(owner.started).toBe(true);
    rig.tick();
    expect(rig.queue.drainEmittable()).toMatchObject([{
      turnId: 'om_first', finalText: '', terminalStatus: 'ambiguous',
      terminalErrorCode: 'antigravity_interrupted',
    }]);
  });

  it('does not arm a successor from a finalized predecessor\'s trailing busy output', () => {
    const rig = makeInterruptedWorkerRig('running tool');
    rig.queue.ingest([{ uuid: 'a-final', timestampMs: Date.now(), kind: 'assistant_final', text: 'done' }]);
    rig.queue.mark('om_next', 'Next request', Date.now());
    const successor = rig.queue.peek()[1]!;
    expect(successor.started).toBe(false);
    rig.observeWorking('Working…\nesc to cancel\r');
    expect(rig.scope.antigravityObservedWorkingOwner).toBeUndefined();
  });

  it.each(['held answer', 'running tool'])('bounds an unobserved fast Esc without settling a successor from the old viewport: %s', phase => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const rig = makeInterruptedWorkerRig(phase);
    rig.tick();
    expect(rig.queue.drainEmittable()).toEqual([]);
    now += 19_999;
    rig.tick();
    expect(rig.queue.drainEmittable()).toEqual([]);
    now += 1;
    rig.tick();
    expect(rig.queue.drainEmittable()).toMatchObject([{
      turnId: 'om_first', finalText: '', terminalStatus: 'ambiguous',
      terminalErrorCode: 'antigravity_interrupted',
    }]);

    // The old interrupted viewport remains owned by the retired turn. Even a
    // full timeout cannot transfer it to the next owner, with or without a
    // newer provisional answer in the transcript.
    rig.queue.mark('om_next', 'Next request', now);
    writeAntigravityUserStep(rig.path, 3, 'Next request');
    writeAntigravityFinalStep(rig.path, 4, 'The next answer');
    const next = drainAntigravityTranscript(rig.path, rig.scope.codexBridgeOffset, rig.scope.structuredBridgeDriverState);
    rig.scope.structuredBridgeDriverState = next.state;
    rig.scope.codexBridgeOffset = next.newOffset;
    rig.queue.ingest(next.events);
    expect(rig.queue.peek()[0]?.started, JSON.stringify({ events: next.events, queue: rig.queue.peek() })).toBe(true);
    const changedFooter = rig.interruptedScreen.replace('? for shortcuts', '? for shortcuts accept-edits · Gemini 3.8 Pro · low');
    expect(isAntigravityInterruptedScreen(changedFooter)).toBe(true);
    rig.setScreen(changedFooter);
    rig.tick();
    expect(rig.queue.drainEmittable()).toEqual([]);
    now += 20_000;
    rig.tick();
    expect(rig.queue.drainEmittable()).toEqual([]);
    expect(rig.queue.peek()[0]?.finalText, JSON.stringify({
      queue: rig.queue.peek(), viewport: rig.scope.antigravityInterruptedViewport,
      workingOwner: rig.scope.antigravityObservedWorkingOwner,
    })).toBeUndefined();
    expect(rig.queue.peek()[0]).toMatchObject({ turnId: 'om_next', started: true });
    expect(rig.scope.structuredBridgeDriverState.provisionalFinal?.text).toBe('The next answer');
  });

  it('ticker stays unbound through the startup window instead of pid-probing a sibling DB, then binds the streamed conversation', async () => {
    const { adapter, logPath } = await startupAdapter();
    // What a /proc fd probe of agy sees in that window: one sibling DB.
    let siblingPath: string | undefined;
    const h = bridgeHarness(adapter, () => siblingPath);
    siblingPath = h.makeTranscript(SIBLING_ID);
    h.scope.codexBridgeStartTimer();

    // Our first turn is queued while a sibling agy in the same workspace
    // happens to record the identical prompt and its own answer.
    h.queue.mark('om_first', '继续', Date.now());
    writeAntigravityUserStep(siblingPath, 1, '继续');
    writeAntigravityFinalStep(siblingPath, 2, 'WRONG_SIBLING_FINAL');
    for (let i = 0; i < 3; i++) h.tick();
    expect(h.scope.codexBridgeRolloutPath).toBeUndefined();
    expect(h.pidLookups).toEqual([]);
    expect(h.queue.peek()[0]?.started).toBe(false);

    // agy creates our conversation on submit and logs it; the transcript follows.
    appendFileSync(logPath, streamingLine(REAL_ID));
    const realPath = h.makeTranscript(REAL_ID);
    writeAntigravityUserStep(realPath, 1, '继续');
    writeAntigravityFinalStep(realPath, 2, 'CORRECT_REAL_FINAL');
    h.tick();
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(h.queue.peek()[0]?.started).toBe(true);
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([{ turnId: 'om_first', text: 'CORRECT_REAL_FINAL' }]);
    expect(h.pidLookups).toEqual([]);
  });

  it('spawn observer neither persists nor binds a pid-probed sibling during the startup window', async () => {
    const { adapter, logPath } = await startupAdapter();
    const timers: Array<() => void> = [];
    const pidProbe = vi.fn(() => SIBLING_ID);
    const persistCliSessionId = vi.fn();
    const ensureAntigravityCotReader = vi.fn();
    const codexBridgeNotifyCliSessionId = vi.fn();
    const backend = { getChildPid: () => AGY_PID };
    const scope: Record<string, any> = {
      cliAdapter: adapter,
      lastInitConfig: { cliId: 'antigravity', workingDir: root },
      backend,
      lastSpawnEffectiveResume: false,
      lastSpawnEffectiveCliSessionId: undefined,
      nativeSessionForkPending: () => false,
      findLaunchedCliPid: () => AGY_PID,
      findAntigravityConversationIdByPid: pidProbe,
      persistCliSessionId,
      ensureAntigravityCotReader,
      codexBridgeFallbackActive: () => true,
      codexBridgeNotifyCliSessionId,
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
      log: vi.fn(),
    };
    const runNextTimer = () => {
      const next = timers.shift();
      if (!next) throw new Error('observer stopped polling');
      next();
    };
    loadWorkerFunction<(pid: number, label?: string) => void>('observeAntigravityCliSessionId', scope)(AGY_PID, 'spawn');

    for (let i = 0; i < 4; i++) runNextTimer();
    expect(pidProbe).not.toHaveBeenCalled();
    expect(persistCliSessionId).not.toHaveBeenCalled();
    expect(codexBridgeNotifyCliSessionId).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);

    appendFileSync(logPath, streamingLine(REAL_ID));
    runNextTimer();
    expect(persistCliSessionId.mock.calls).toEqual([[REAL_ID]]);
    expect(ensureAntigravityCotReader.mock.calls).toEqual([[REAL_ID]]);
    expect(codexBridgeNotifyCliSessionId.mock.calls).toEqual([[REAL_ID, { preserveLiveTurn: true }]]);
    expect(timers).toEqual([]);
    expect(pidProbe).not.toHaveBeenCalled();
  });

  it('spawn observer keeps the explicit target when cold-resume discovery sees a sibling', async () => {
    vi.resetModules();
    const discovery = await import('../src/services/antigravity-discovery.js');
    let discovered = SIBLING_ID;
    vi.spyOn(discovery, 'findAntigravityConversationId').mockImplementation(opts => (
      opts.pid === AGY_PID ? discovered : null
    ));
    const { createAntigravityAdapter } = await import('../src/adapters/cli/antigravity.js');
    const adapter = createAntigravityAdapter('/usr/local/bin/agy');
    adapter.buildArgs({
      sessionId: 'cold-observer-resume-target',
      resume: true,
      resumeSessionId: REAL_ID,
      reattach: false,
    });
    const timers: Array<() => void> = [];
    const persistCliSessionId = vi.fn();
    const ensureAntigravityCotReader = vi.fn();
    const codexBridgeNotifyCliSessionId = vi.fn();
    const scope: Record<string, any> = {
      cliAdapter: adapter,
      lastInitConfig: { cliId: 'antigravity', workingDir: root, cliSessionId: REAL_ID },
      backend: { getChildPid: () => AGY_PID },
      lastSpawnEffectiveResume: true,
      lastSpawnEffectiveCliSessionId: REAL_ID,
      lastSpawnPersistentReattach: false,
      nativeSessionForkPending: () => false,
      findLaunchedCliPid: () => AGY_PID,
      persistCliSessionId,
      ensureAntigravityCotReader,
      codexBridgeFallbackActive: () => true,
      codexBridgeNotifyCliSessionId,
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
      log: vi.fn(),
    };
    loadWorkerFunction<(pid: number) => void>('observeAntigravityCliSessionId', scope)(AGY_PID);
    expect(timers).toHaveLength(1);
    timers.shift()!();

    expect(persistCliSessionId).not.toHaveBeenCalled();
    expect(ensureAntigravityCotReader).not.toHaveBeenCalled();
    expect(codexBridgeNotifyCliSessionId).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);

    discovered = REAL_ID;
    timers.shift()!();
    expect(persistCliSessionId.mock.calls).toEqual([[REAL_ID]]);
    expect(ensureAntigravityCotReader.mock.calls).toEqual([[REAL_ID]]);
    expect(codexBridgeNotifyCliSessionId.mock.calls).toEqual([[REAL_ID, { preserveLiveTurn: true }]]);
    expect(timers).toEqual([]);
  });

  it('cold-resume observer canonicalizes UUID casing before persistence and transcript lookup', async () => {
    vi.resetModules();
    const discovery = await import('../src/services/antigravity-discovery.js');
    vi.spyOn(discovery, 'findAntigravityConversationId').mockImplementation(opts => (
      opts.pid === AGY_PID ? REAL_ID.toUpperCase() : null
    ));
    const { createAntigravityAdapter } = await import('../src/adapters/cli/antigravity.js');
    const adapter = createAntigravityAdapter('/usr/local/bin/agy');
    adapter.buildArgs({
      sessionId: 'cold-observer-canonical-uuid',
      resume: true,
      resumeSessionId: REAL_ID,
      reattach: false,
    });
    const h = bridgeHarness(adapter);
    h.scope.lastInitConfig = { cliId: 'antigravity', workingDir: root, cliSessionId: REAL_ID };
    h.scope.lastSpawnEffectiveResume = true;
    h.scope.lastSpawnPersistentReattach = false;
    h.scope.lastSpawnEffectiveCliSessionId = REAL_ID;
    h.scope.persistCliSessionId = vi.fn();
    h.scope.ensureAntigravityCotReader = vi.fn();
    h.scope.codexBridgeNotifyCliSessionId = h.notify;
    h.scope.backend = { getChildPid: () => AGY_PID };
    h.scope.findLaunchedCliPid = () => AGY_PID;
    const realPath = h.makeTranscript(REAL_ID);
    const timers: Array<() => void> = [];
    h.scope.setTimeout = (callback: () => void) => { timers.push(callback); return timers.length; };

    loadWorkerFunction<(pid: number) => void>('observeAntigravityCliSessionId', h.scope)(AGY_PID);
    expect(timers).toHaveLength(1);
    timers.shift()!();

    expect(h.scope.persistCliSessionId.mock.calls).toEqual([[REAL_ID]]);
    expect(h.scope.ensureAntigravityCotReader.mock.calls).toEqual([[REAL_ID]]);
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(h.scope.codexBridgePendingSessionId).toBeUndefined();
  });

  it('cold spawn ignores a previous-generation native log while warm reattach retains it', async () => {
    vi.resetModules();
    const discovery = await import('../src/services/antigravity-discovery.js');
    vi.spyOn(discovery, 'findAntigravityConversationId').mockReturnValue(null);
    const { createAntigravityAdapter } = await import('../src/adapters/cli/antigravity.js');
    const sessionId = 'two-generation-native-log';
    const first = createAntigravityAdapter('/usr/local/bin/agy');
    const firstArgs = first.buildArgs({ sessionId, resume: false, reattach: false });
    const logPath = firstArgs[firstArgs.indexOf('--log-file') + 1]!;
    writeFileSync(logPath, streamingLine(SIBLING_ID));

    const warm = createAntigravityAdapter('/usr/local/bin/agy');
    warm.buildArgs({ sessionId, resume: true, resumeSessionId: SIBLING_ID, reattach: true });
    expect(warm.resolveActiveSessionIdObservation?.({ cliPid: AGY_PID })).toEqual({
      sessionId: SIBLING_ID,
      source: 'native-log',
    });

    const cold = createAntigravityAdapter('/usr/local/bin/agy');
    cold.buildArgs({ sessionId, resume: true, resumeSessionId: REAL_ID, reattach: false });
    const h = bridgeHarness(cold);
    h.scope.lastInitConfig = { cliId: 'antigravity', workingDir: root, cliSessionId: REAL_ID };
    h.scope.lastSpawnEffectiveResume = true;
    h.scope.lastSpawnPersistentReattach = false;
    h.scope.lastSpawnEffectiveCliSessionId = REAL_ID;
    h.scope.persistCliSessionId = vi.fn();
    h.scope.ensureAntigravityCotReader = vi.fn();
    h.scope.codexBridgeNotifyCliSessionId = h.notify;
    h.scope.backend = { getChildPid: () => AGY_PID };
    h.scope.findLaunchedCliPid = () => AGY_PID;
    const realPath = h.makeTranscript(REAL_ID);
    const timers: Array<() => void> = [];
    h.scope.setTimeout = (callback: () => void) => { timers.push(callback); return timers.length; };
    loadWorkerFunction<(pid: number) => void>('observeAntigravityCliSessionId', h.scope)(AGY_PID);

    expect(timers).toHaveLength(1);
    timers.shift()!();
    expect(h.scope.persistCliSessionId).not.toHaveBeenCalled();
    expect(h.scope.codexBridgeRolloutPath).toBeUndefined();
    expect(timers).toHaveLength(1);

    appendFileSync(logPath, streamingLine(REAL_ID));
    timers.shift()!();
    expect(h.scope.persistCliSessionId.mock.calls).toEqual([[REAL_ID]]);
    expect(h.scope.ensureAntigravityCotReader.mock.calls).toEqual([[REAL_ID]]);
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(timers).toEqual([]);
  });

  it('spawn observer follows a native /new completed before persistent reattach', async () => {
    const { createAntigravityAdapter } = await import('../src/adapters/cli/antigravity.js');
    const adapter = createAntigravityAdapter('/usr/local/bin/agy');
    const args = adapter.buildArgs({
      sessionId: 'warm-observer-native-rotation',
      resume: true,
      resumeSessionId: SIBLING_ID,
      reattach: true,
    });
    const logPath = args[args.indexOf('--log-file') + 1]!;
    writeFileSync(logPath, streamingLine(REAL_ID));

    const timers: Array<() => void> = [];
    const persistCliSessionId = vi.fn();
    const ensureAntigravityCotReader = vi.fn();
    const codexBridgeNotifyCliSessionId = vi.fn();
    const scope: Record<string, any> = {
      cliAdapter: adapter,
      lastInitConfig: { cliId: 'antigravity', workingDir: root, cliSessionId: SIBLING_ID },
      backend: { getChildPid: () => AGY_PID },
      lastSpawnEffectiveResume: true,
      lastSpawnEffectiveCliSessionId: SIBLING_ID,
      lastSpawnPersistentReattach: true,
      nativeSessionForkPending: () => false,
      findLaunchedCliPid: () => AGY_PID,
      persistCliSessionId,
      ensureAntigravityCotReader,
      codexBridgeFallbackActive: () => true,
      codexBridgeNotifyCliSessionId,
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
      log: vi.fn(),
    };
    loadWorkerFunction<(pid: number) => void>('observeAntigravityCliSessionId', scope)(AGY_PID);
    expect(timers).toHaveLength(1);
    timers.shift()!();

    expect(persistCliSessionId.mock.calls).toEqual([[REAL_ID]]);
    expect(ensureAntigravityCotReader.mock.calls).toEqual([[REAL_ID]]);
    expect(codexBridgeNotifyCliSessionId.mock.calls).toEqual([[REAL_ID, { tryRebindLiveTurn: true }]]);
    expect(timers).toEqual([]);
  });

  it('persistent observer canonicalizes an uppercase newly rotated ID before binding its lowercase transcript', async () => {
    const { createAntigravityAdapter } = await import('../src/adapters/cli/antigravity.js');
    const adapter = createAntigravityAdapter('/usr/local/bin/agy');
    const args = adapter.buildArgs({
      sessionId: 'warm-observer-uppercase-new-id',
      resume: true,
      resumeSessionId: SIBLING_ID,
      reattach: true,
    });
    const logPath = args[args.indexOf('--log-file') + 1]!;
    writeFileSync(logPath, streamingLine(REAL_ID.toUpperCase()));
    expect(adapter.resolveActiveSessionIdObservation?.({ cliPid: AGY_PID })).toEqual({
      sessionId: REAL_ID,
      source: 'native-log',
    });
    const h = bridgeHarness(adapter);
    h.scope.lastInitConfig = { cliId: 'antigravity', workingDir: root, cliSessionId: SIBLING_ID };
    h.scope.lastSpawnEffectiveResume = true;
    h.scope.lastSpawnPersistentReattach = true;
    h.scope.lastSpawnEffectiveCliSessionId = SIBLING_ID;
    h.scope.persistCliSessionId = vi.fn();
    h.scope.ensureAntigravityCotReader = vi.fn();
    h.scope.codexBridgeNotifyCliSessionId = h.notify;
    h.scope.backend = { getChildPid: () => AGY_PID };
    h.scope.findLaunchedCliPid = () => AGY_PID;
    const realPath = h.makeTranscript(REAL_ID);
    const timers: Array<() => void> = [];
    h.scope.setTimeout = (callback: () => void) => { timers.push(callback); return timers.length; };

    loadWorkerFunction<(pid: number) => void>('observeAntigravityCliSessionId', h.scope)(AGY_PID);
    timers.shift()!();

    expect(h.scope.persistCliSessionId.mock.calls).toEqual([[REAL_ID]]);
    expect(h.scope.ensureAntigravityCotReader.mock.calls).toEqual([[REAL_ID]]);
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(h.scope.codexBridgePendingSessionId).toBeUndefined();
  });

  it.each([
    { persistentReattach: true, adoptMode: false, lazyTranscript: false },
    { persistentReattach: true, adoptMode: false, lazyTranscript: true },
    { persistentReattach: false, adoptMode: true, lazyTranscript: false },
    { persistentReattach: false, adoptMode: true, lazyTranscript: true },
  ])('native /new retires an unfinished old turn instead of sticking forever (persistent=$persistentReattach, adopt=$adoptMode, lazy=$lazyTranscript)', ({ persistentReattach, adoptMode, lazyTranscript }) => {
    const h = bridgeHarness({
      id: 'antigravity',
      runnerFramedInput: false,
      postTerminalPromptFence: false,
      resolveActiveSessionId: () => REAL_ID,
    });
    h.scope.persistCliSessionId = vi.fn();
    h.scope.ensureAntigravityCotReader = vi.fn();
    h.scope.codexBridgeNotifyCliSessionId = h.notify;
    h.scope.backend = { getChildPid: () => AGY_PID };
    h.scope.findLaunchedCliPid = () => AGY_PID;

    const oldPath = h.makeTranscript(SIBLING_ID);
    h.notify(SIBLING_ID);
    h.queue.mark('om_retired_native', 'old unfinished request', Date.now());
    writeAntigravityUserStep(oldPath, 1, 'old unfinished request');
    appendFileSync(oldPath, JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'Created the following subagent:\n{ "conversationId": "pending-agent" }' }) + '\n');
    writeAntigravityFinalStep(oldPath, 3, 'old unfinished waiting narration');
    h.scope.codexBridgeIngest();
    expect(h.queue.peek()[0]?.started).toBe(true);
    expect(h.queue.peek()[0]?.finalText).toBeUndefined();

    // Model an already-restored live owner; only then apply the next spawn's mode.
    h.scope.lastInitConfig = { cliId: 'antigravity', workingDir: root, adoptMode };
    h.scope.lastSpawnEffectiveResume = true;
    h.scope.lastSpawnPersistentReattach = persistentReattach;
    h.scope.lastSpawnEffectiveCliSessionId = SIBLING_ID;

    let realPath = lazyTranscript ? undefined : h.makeTranscript(REAL_ID);
    if (realPath) writeAntigravityUserStep(realPath, 1, 'different request after native new');
    const timers: Array<() => void> = [];
    h.scope.setTimeout = (callback: () => void) => { timers.push(callback); return timers.length; };
    loadWorkerFunction<(pid: number) => void>('observeAntigravityCliSessionId', h.scope)(AGY_PID);
    expect(timers).toHaveLength(1);
    timers.shift()!();

    if (lazyTranscript) {
      expect(h.scope.codexBridgeRolloutPath).toBe(oldPath);
      expect(h.scope.codexBridgePendingSessionId).toBe(REAL_ID);
      expect(h.scope.antigravityPendingRebind).toBe(false);
      const applyAuthoritative = loadWorkerFunction<(id: string) => void>('applyAuthoritativeAntigravitySessionId', h.scope);
      applyAuthoritative(SIBLING_ID);
      expect(h.scope.persistCliSessionId.mock.calls).toEqual([[REAL_ID]]);
      expect(h.scope.ensureAntigravityCotReader.mock.calls).toEqual([[REAL_ID]]);
      expect(h.scope.codexBridgePendingSessionId).toBe(REAL_ID);
      realPath = h.makeTranscript(REAL_ID);
      writeAntigravityUserStep(realPath, 1, 'different request after native new');
      h.tick();
    }
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(h.scope.codexBridgePendingSessionId).toBeUndefined();
    expect(h.scope.antigravityPendingRebind).toBe(false);
    expect(h.scope.persistCliSessionId).toHaveBeenCalledWith(REAL_ID);
  });

  it('ticker late-rotation to a lazily created transcript drops a misbound sibling without draining it', () => {
    let streamingId: string | undefined = SIBLING_ID;
    const h = bridgeHarness({ resolveActiveSessionId: () => streamingId });
    const siblingPath = h.makeTranscript(SIBLING_ID);
    h.notify(SIBLING_ID);
    expect(h.scope.codexBridgeRolloutPath).toBe(siblingPath);

    h.queue.mark('om_turn', '继续', Date.now());
    streamingId = REAL_ID;
    h.notify(REAL_ID);
    expect(h.scope.codexBridgePendingSessionId).toBe(REAL_ID);

    // While our brain file does not exist yet, the sibling keeps writing.
    writeAntigravityUserStep(siblingPath, 1, '继续');
    writeAntigravityFinalStep(siblingPath, 2, 'WRONG_SIBLING_FINAL');
    h.tick();
    expect(h.scope.codexBridgeRolloutPath).toBe(siblingPath);
    expect(h.queue.peek()[0]?.started).toBe(false);

    const realPath = h.makeTranscript(REAL_ID);
    writeAntigravityUserStep(realPath, 1, '继续');
    writeAntigravityFinalStep(realPath, 2, 'CORRECT_REAL_FINAL');
    h.tick();
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(h.scope.codexBridgePendingSessionId).toBeUndefined();
    expect(h.emittedFinals).toEqual([]);
    expect(h.queue.peek()[0]?.started).toBe(true);
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([{ turnId: 'om_turn', text: 'CORRECT_REAL_FINAL' }]);
  });

  it('ticker late-rotation after a real /new still releases the retired conversation\'s held final', () => {
    const OLD_ID = '0f6a2c1e-1111-4222-8333-444455556666';
    const NEW_ID = '7d1e9b30-aaaa-4bbb-8ccc-dddd00001111';
    let streamingId: string | undefined = OLD_ID;
    const h = bridgeHarness({ resolveActiveSessionId: () => streamingId });
    const oldPath = h.makeTranscript(OLD_ID);
    h.notify(OLD_ID);
    h.scope.codexBridgeStartTimer();
    expect(h.scope.codexBridgeRolloutPath).toBe(oldPath);

    // The previous turn's answer is on disk but still provisional (held in
    // driver state until a quiet tick) when the user runs /new.
    h.queue.mark('om_before_new', 'before-new-prompt', Date.now());
    writeAntigravityUserStep(oldPath, 1, 'before-new-prompt');
    writeAntigravityFinalStep(oldPath, 2, 'HELD_OLD_FINAL');
    h.tick();
    expect(h.queue.peek()[0]?.started).toBe(true);
    expect(h.emittedFinals).toEqual([]);

    // /new switches agy's stream immediately; the next Lark turn reports the
    // new id before its brain file exists.
    streamingId = NEW_ID;
    h.queue.mark('om_after_new', 'after-new-prompt', Date.now());
    h.notify(NEW_ID);
    expect(h.scope.codexBridgePendingSessionId).toBe(NEW_ID);
    h.tick();
    expect(h.scope.codexBridgeRolloutPath).toBe(oldPath);

    const newPath = h.makeTranscript(NEW_ID);
    writeAntigravityUserStep(newPath, 1, 'after-new-prompt');
    writeAntigravityFinalStep(newPath, 2, 'AFTER_NEW_FINAL');
    h.tick();
    expect(h.scope.codexBridgeRolloutPath).toBe(newPath);
    expect(h.emittedFinals).toEqual([{ turnId: 'om_before_new', text: 'HELD_OLD_FINAL' }]);
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([
      { turnId: 'om_before_new', text: 'HELD_OLD_FINAL' },
      { turnId: 'om_after_new', text: 'AFTER_NEW_FINAL' },
    ]);
  });

  it('withholds PID fd probing before --log-file exists or has non-empty bytes, while preserving resume, reattach, and adopt discovery', async () => {
    vi.resetModules();
    const discovery = await import('../src/services/antigravity-discovery.js');
    const findSpy = vi.spyOn(discovery, 'findAntigravityConversationId').mockImplementation((opts) => {
      if (opts.pid) return SIBLING_ID;
      if (opts.cwd) return SIBLING_ID;
      return null;
    });

    const { createAntigravityAdapter } = await import('../src/adapters/cli/antigravity.js');

    // 1. Fresh launch: before --log-file even exists AND while it is 0 bytes, never touch PID fd.
    const fresh = createAntigravityAdapter('/usr/local/bin/agy');
    const freshArgs = fresh.buildArgs({
      sessionId: 'fresh-cold-start',
      resume: false,
      reattach: false,
    });
    const freshLogPath = freshArgs[freshArgs.indexOf('--log-file') + 1]!;
    expect(existsSync(freshLogPath)).toBe(false);
    expect(fresh.resolveActiveSessionId!({ cliPid: AGY_PID, cliCwd: root })).toBeUndefined();
    expect(findSpy).not.toHaveBeenCalled();

    writeFileSync(freshLogPath, '');
    expect(statSync(freshLogPath).size).toBe(0);
    expect(fresh.resolveActiveSessionId!({ cliPid: AGY_PID, cliCwd: root })).toBeUndefined();
    expect(findSpy).not.toHaveBeenCalled();

    appendFileSync(freshLogPath, STARTUP_LOG_LINE);
    expect(fresh.resolveActiveSessionId!({ cliPid: AGY_PID, cliCwd: root })).toBeUndefined();
    expect(findSpy).not.toHaveBeenCalled();

    appendFileSync(freshLogPath, streamingLine(REAL_ID));
    expect(fresh.resolveActiveSessionId!({ cliPid: AGY_PID, cliCwd: root })).toBe(REAL_ID);
    expect(findSpy).not.toHaveBeenCalled();

    // 2. Resume without a stored resumeSessionId starts fresh without --conversation:
    // must also wait for --log-file and never penetrate to PID fd.
    const resumeFreshFallback = createAntigravityAdapter('/usr/local/bin/agy');
    const fallbackArgs = resumeFreshFallback.buildArgs({
      sessionId: 'resume-without-id',
      resume: true,
      reattach: false,
    });
    expect(fallbackArgs).not.toContain('--conversation');
    expect(resumeFreshFallback.resolveActiveSessionId!({ cliPid: AGY_PID, cliCwd: root })).toBeUndefined();
    expect(findSpy).not.toHaveBeenCalled();

    // 3. Cold resume WITH an explicit resumeSessionId preserves PID discovery when log has no stream yet.
    const coldResume = createAntigravityAdapter('/usr/local/bin/agy');
    coldResume.buildArgs({
      sessionId: 'cold-resume-with-id',
      resume: true,
      resumeSessionId: REAL_ID,
      reattach: false,
    });
    expect(coldResume.resolveActiveSessionId!({ cliPid: AGY_PID, cliCwd: root })).toBe(SIBLING_ID);
    expect(findSpy).toHaveBeenCalledWith({ pid: AGY_PID, cwd: undefined });

    // 4. Warm reattach (reattach: true) without --log-file stream line preserves PID discovery.
    findSpy.mockClear();
    const warmReattach = createAntigravityAdapter('/usr/local/bin/agy');
    warmReattach.buildArgs({
      sessionId: 'warm-reattach-no-log',
      resume: false,
      reattach: true,
    });
    expect(warmReattach.resolveActiveSessionId!({ cliPid: AGY_PID, cliCwd: root })).toBe(SIBLING_ID);
    expect(findSpy).toHaveBeenCalledWith({ pid: AGY_PID, cwd: undefined });

    // 5. Adopt / unmanaged adapter (buildArgs never called -> no --log-file) preserves PID + cwd discovery.
    findSpy.mockClear();
    const adopted = createAntigravityAdapter('/usr/local/bin/agy');
    expect(adopted.resolveActiveSessionId!({ cliPid: AGY_PID, cliCwd: root })).toBe(SIBLING_ID);
    expect(findSpy).toHaveBeenCalledWith({ pid: AGY_PID, cwd: root });
  });

  it('resolveLiveAntigravityTranscriptPath never bypasses resolveActiveSessionId or a lazy cid via locate.byPid', () => {
    const resolveFileBridgePath = vi.fn((_cliId: string, opts: { sessionId?: string; pid?: number }) => {
      if (opts.pid) return '/wrong/sibling/transcript_full.jsonl';
      return undefined;
    });
    let activeId: string | undefined;
    const scope: Record<string, any> = {
      cliAdapter: {
        id: 'antigravity',
        runnerFramedInput: false,
        resolveActiveSessionId: () => activeId,
      },
      lastInitConfig: { cliId: 'antigravity', workingDir: root },
      lastSpawnEffectiveCliSessionId: undefined,
      currentAntigravityObservedPid: () => AGY_PID,
      findAntigravityConversationIdByPid: vi.fn(() => SIBLING_ID),
      resolveAntigravityTranscriptPath,
      resolveFileBridgePath,
      join,
    };
    const resolveLive = loadWorkerFunction<() => string | undefined>('resolveLiveAntigravityTranscriptPath', scope);

    // Cold start before Streaming conversation: must return undefined without touching locate.byPid.
    expect(resolveLive()).toBeUndefined();
    expect(resolveFileBridgePath).not.toHaveBeenCalled();

    // Known cid whose brain transcript does not exist on disk yet: look up by sessionId only, never pid.
    activeId = REAL_ID;
    expect(resolveLive()).toBeUndefined();
    expect(resolveFileBridgePath).toHaveBeenCalledWith('antigravity', { sessionId: REAL_ID });
  });

  it('keeps ticker and spawn observer unbound while --log-file is absent/empty, and syncs persistence when ticker discovers the streamed id', async () => {
    vi.resetModules();
    const discovery = await import('../src/services/antigravity-discovery.js');
    const findSpy = vi.spyOn(discovery, 'findAntigravityConversationId').mockImplementation((opts) => {
      if (opts.pid === AGY_PID) return SIBLING_ID;
      return null;
    });
    const { createAntigravityAdapter } = await import('../src/adapters/cli/antigravity.js');
    const adapter = createAntigravityAdapter('/usr/local/bin/agy');
    const args = adapter.buildArgs({ sessionId: 'cold-empty-log-session', resume: false, reattach: false });
    const logPath = args[args.indexOf('--log-file') + 1]!;
    expect(existsSync(logPath)).toBe(false);

    let siblingPath: string | undefined;
    const h = bridgeHarness(adapter, () => siblingPath);
    const persistedIds: string[] = [];
    h.scope.persistCliSessionId = (cid: string) => persistedIds.push(cid);
    siblingPath = h.makeTranscript(SIBLING_ID);
    h.scope.codexBridgeStartTimer();

    h.queue.mark('om_cold', '你好', Date.now());
    writeAntigravityUserStep(siblingPath, 1, '你好');
    writeAntigravityFinalStep(siblingPath, 2, 'SIBLING_ANSWER');

    // Tick 1: --log-file does not exist yet; Tick 2: --log-file is 0 bytes.
    // Even though PID fd discovery would return SIBLING_ID, ticker must stay unbound.
    h.tick();
    writeFileSync(logPath, '');
    h.tick();
    expect(findSpy).not.toHaveBeenCalled();
    expect(h.scope.codexBridgeRolloutPath).toBeUndefined();
    expect(h.pidLookups).toEqual([]);
    expect(persistedIds).toEqual([]);
    expect(h.queue.peek()[0]?.started).toBe(false);

    // Once agy streams REAL_ID and creates its transcript, ticker binds AND persists REAL_ID.
    appendFileSync(logPath, streamingLine(REAL_ID));
    const realPath = h.makeTranscript(REAL_ID);
    writeAntigravityUserStep(realPath, 1, '你好');
    writeAntigravityFinalStep(realPath, 2, 'REAL_COLD_ANSWER');
    h.tick();
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(persistedIds).toEqual([REAL_ID]);
    expect(findSpy).not.toHaveBeenCalled();
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([{ turnId: 'om_cold', text: 'REAL_COLD_ANSWER' }]);
  });

  it('armAntigravityCotForTurn synchronously updates daemon, CoT reader, and Structured Bridge while preserving a live turn on old-id -> real-id switch', () => {
    let activeId: string | undefined = SIBLING_ID;
    const h = bridgeHarness({
      id: 'antigravity',
      runnerFramedInput: false,
      postTerminalPromptFence: false,
      resolveActiveSessionId: () => activeId,
    });
    const persisted: string[] = [];
    const cotBound: string[] = [];
    h.scope.persistCliSessionId = (cid: string) => persisted.push(cid);
    h.scope.ensureAntigravityCotReader = (cid: string) => cotBound.push(cid);
    h.scope.codexBridgeNotifyCliSessionId = h.notify;
    h.scope.lastSpawnEffectiveCliSessionId = undefined;

    const armCot = loadWorkerFunction<() => void>('armAntigravityCotForTurn', h.scope);

    // Initially bound to SIBLING_ID with NO pending session id (`codexBridgePendingSessionId === undefined`).
    const siblingPath = h.makeTranscript(SIBLING_ID);
    h.notify(SIBLING_ID);
    expect(h.scope.codexBridgeRolloutPath).toBe(siblingPath);
    expect(h.scope.codexBridgePendingSessionId).toBeUndefined();

    // Live turn is already started on the misbound sibling transcript (waiting on subagent).
    h.queue.mark('om_live_arm', '帮我查一下日志', Date.now());
    writeAntigravityUserStep(siblingPath, 1, '帮我查一下日志');
    appendFileSync(siblingPath, JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'Created the following subagent:\n{ "conversationId": "pending-agent" }' }) + '\n');
    writeAntigravityFinalStep(siblingPath, 3, 'Sibling waiting narration');
    h.scope.codexBridgeIngest();
    expect(h.queue.peek()[0]).toMatchObject({ turnId: 'om_live_arm', started: true });

    // Authoritative id switches to REAL_ID, whose transcript carries this exact live turn.
    const realPath = h.makeTranscript(REAL_ID);
    writeAntigravityUserStep(realPath, 1, '帮我查一下日志');
    writeAntigravityFinalStep(realPath, 2, 'REAL_ARM_ANSWER');
    activeId = REAL_ID;

    armCot();
    expect(persisted).toEqual([REAL_ID]);
    expect(cotBound).toEqual([REAL_ID]);
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(h.scope.codexBridgePendingSessionId).toBeUndefined();
    expect(h.scope.antigravityPendingRebind).toBe(false);
    expect(h.emittedFinals).toEqual([]);

    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([{ turnId: 'om_live_arm', text: 'REAL_ARM_ANSWER' }]);
    expect(h.queue.peek()).toEqual([]);
  });

  it('armAntigravityCotForTurn does not poison a normal /new rotation with antigravityPendingRebind (repeated text, writeInput timeout, and lazy duplicate prompts)', () => {
    const OLD_ID = '0f6a2c1e-1111-4222-8333-444455556666';
    const NEW_ID = '7d1e9b30-aaaa-4bbb-8ccc-dddd00001111';

    // Case 1a: /new with repeated prompt text ("继续") while OLD_ID holds OLD_HELD_FINAL.
    // Must flush OLD_HELD_FINAL to om_old and deliver NEW_CONVERSATION_ANSWER to om_new.
    {
      let activeId: string | undefined = OLD_ID;
      const h = bridgeHarness({
        id: 'antigravity',
        runnerFramedInput: false,
        postTerminalPromptFence: false,
        resolveActiveSessionId: () => activeId,
      });
      h.scope.persistCliSessionId = vi.fn();
      h.scope.ensureAntigravityCotReader = vi.fn();
      h.scope.codexBridgeNotifyCliSessionId = h.notify;
      h.scope.lastSpawnEffectiveCliSessionId = undefined;
      const armCot = loadWorkerFunction<() => void>('armAntigravityCotForTurn', h.scope);

      const oldPath = h.makeTranscript(OLD_ID);
      h.notify(OLD_ID);
      h.queue.mark('om_old', '继续', Date.now());
      writeAntigravityUserStep(oldPath, 1, '继续');
      writeAntigravityFinalStep(oldPath, 2, 'OLD_HELD_FINAL');
      h.scope.codexBridgeIngest();

      // User runs /new, then sends om_new ("继续") before NEW_ID's brain file exists.
      activeId = NEW_ID;
      h.queue.mark('om_new', '继续', Date.now());
      armCot();
      expect(h.scope.codexBridgePendingSessionId).toBe(NEW_ID);
      expect(h.scope.antigravityPendingRebind).toBe(false);

      // Even if writeInput timed out / never notified (Case 1b), the 1s ticker
      // rotates cleanly once NEW_ID's brain file appears — no deadlock!
      const newPath = h.makeTranscript(NEW_ID);
      writeAntigravityUserStep(newPath, 1, '继续');
      writeAntigravityFinalStep(newPath, 2, 'NEW_CONVERSATION_ANSWER');
      h.tick();
      expect(h.scope.codexBridgeRolloutPath).toBe(newPath);
      expect(h.scope.antigravityPendingRebind).toBe(false);
      expect(h.emittedFinals).toEqual([{ turnId: 'om_old', text: 'OLD_HELD_FINAL' }]);

      h.flushQuietFinal();
      expect(h.emittedFinals).toEqual([
        { turnId: 'om_old', text: 'OLD_HELD_FINAL' },
        { turnId: 'om_new', text: 'NEW_CONVERSATION_ANSWER' },
      ]);
      expect(h.queue.peek()).toEqual([]);
    }

    // Case 1c: Idle /new with lazy transcript + two identical prompts ("继续") before the 1s tick.
    // Must not arm antigravityPendingRebind (which would deadlock on duplicate same-text match).
    {
      const IDLE_OLD = '10000000-1111-4222-8333-444455556666';
      const IDLE_NEW = '20000000-aaaa-4bbb-8ccc-dddd00001111';
      let activeId: string | undefined = IDLE_OLD;
      const h = bridgeHarness({
        id: 'antigravity',
        runnerFramedInput: false,
        postTerminalPromptFence: false,
        resolveActiveSessionId: () => activeId,
      });
      h.scope.persistCliSessionId = vi.fn();
      h.scope.ensureAntigravityCotReader = vi.fn();
      h.scope.codexBridgeNotifyCliSessionId = h.notify;
      h.scope.lastSpawnEffectiveCliSessionId = undefined;
      const armCot = loadWorkerFunction<() => void>('armAntigravityCotForTurn', h.scope);

      h.makeTranscript(IDLE_OLD);
      h.notify(IDLE_OLD);
      activeId = IDLE_NEW;
      h.queue.mark('om_dup_1', '继续', Date.now());
      armCot();
      h.notify(IDLE_NEW); // post-submit confirm while IDLE_NEW is still lazy
      expect(h.scope.antigravityPendingRebind).toBe(false);

      h.queue.mark('om_dup_2', '继续', Date.now());
      const newPath = h.makeTranscript(IDLE_NEW);
      writeAntigravityUserStep(newPath, 1, '继续');
      writeAntigravityFinalStep(newPath, 2, 'FIRST_DUP_ANSWER');
      writeAntigravityUserStep(newPath, 3, '继续');
      writeAntigravityFinalStep(newPath, 4, 'SECOND_DUP_ANSWER');
      h.tick();
      h.flushQuietFinal();
      expect(h.scope.codexBridgeRolloutPath).toBe(newPath);
      expect(h.emittedFinals).toEqual([
        { turnId: 'om_dup_1', text: 'FIRST_DUP_ANSWER' },
        { turnId: 'om_dup_2', text: 'SECOND_DUP_ANSWER' },
      ]);
    }
  });

  it('clears a stale pending rebind for another id before retiring on a new /new rotation so held finals are flushed', () => {
    const OLD_ID = '0f6a2c1e-1111-4222-8333-444455556666';
    const OTHER_PENDING_ID = '55555555-aaaa-4bbb-8ccc-dddd00001111';
    const NEW_ID = '7d1e9b30-aaaa-4bbb-8ccc-dddd00001111';
    const h = bridgeHarness({
      id: 'antigravity',
      runnerFramedInput: false,
      postTerminalPromptFence: false,
    });

    const oldPath = h.makeTranscript(OLD_ID);
    h.notify(OLD_ID);
    h.queue.mark('om_old_turn', 'old question', Date.now());
    writeAntigravityUserStep(oldPath, 1, 'old question');
    writeAntigravityFinalStep(oldPath, 2, 'OLD_HELD_FINAL');
    h.scope.codexBridgeIngest();
    expect(h.emittedFinals).toEqual([]);

    // Earlier preserveLiveTurn for OTHER_PENDING_ID left antigravityPendingRebind = true.
    h.notify(OTHER_PENDING_ID, { preserveLiveTurn: true });
    expect(h.scope.antigravityPendingRebind).toBe(true);

    // Now a real /new arrives for NEW_ID: must clear antigravityPendingRebind BEFORE
    // retireAntigravityBridgeTurn so OLD_HELD_FINAL is flushed, not dropped!
    h.queue.mark('om_new_turn', 'new question', Date.now());
    const newPath = h.makeTranscript(NEW_ID);
    writeAntigravityUserStep(newPath, 1, 'new question');
    writeAntigravityFinalStep(newPath, 2, 'NEW_ANSWER');
    h.notify(NEW_ID);

    expect(h.scope.codexBridgeRolloutPath).toBe(newPath);
    expect(h.scope.antigravityPendingRebind).toBe(false);
    expect(h.emittedFinals).toEqual([{ turnId: 'om_old_turn', text: 'OLD_HELD_FINAL' }]);

    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([
      { turnId: 'om_old_turn', text: 'OLD_HELD_FINAL' },
      { turnId: 'om_new_turn', text: 'NEW_ANSWER' },
    ]);
  });

  it('preserves an armed lazy-transcript misbind rebind across a type-ahead follow-up confirming the same REAL_ID', () => {
    let activeId: string | undefined = SIBLING_ID;
    const h = bridgeHarness({
      id: 'antigravity',
      runnerFramedInput: false,
      postTerminalPromptFence: false,
      resolveActiveSessionId: () => activeId,
    });
    h.scope.persistCliSessionId = vi.fn();
    h.scope.ensureAntigravityCotReader = vi.fn();
    h.scope.codexBridgeNotifyCliSessionId = h.notify;
    h.scope.lastSpawnEffectiveCliSessionId = undefined;
    const armCot = loadWorkerFunction<() => void>('armAntigravityCotForTurn', h.scope);

    // Bridge early-misbound to SIBLING_ID with live turn om_1 started on sibling.
    const siblingPath = h.makeTranscript(SIBLING_ID);
    h.notify(SIBLING_ID);
    h.queue.mark('om_1', 'first prompt', Date.now());
    writeAntigravityUserStep(siblingPath, 1, 'first prompt');
    writeAntigravityFinalStep(siblingPath, 2, 'WRONG_SIBLING_FINAL');
    h.scope.codexBridgeIngest();

    // Spawn observer discovers REAL_ID before REAL_ID's brain file exists -> arms pending rebind.
    activeId = REAL_ID;
    h.notify(REAL_ID, { preserveLiveTurn: true });
    expect(h.scope.codexBridgePendingSessionId).toBe(REAL_ID);
    expect(h.scope.antigravityPendingRebind).toBe(true);

    // Type-ahead follow-up om_2 arrives while REAL_ID's transcript is STILL lazy:
    // both armCot() and post-submit writeInput notify(REAL_ID) must KEEP antigravityPendingRebind = true!
    h.queue.mark('om_2', 'second prompt', Date.now());
    armCot();
    expect(h.scope.antigravityPendingRebind).toBe(true);
    h.notify(REAL_ID);
    expect(h.scope.antigravityPendingRebind).toBe(true);

    // Once REAL_ID's transcript appears with both turns, ticker migrates om_1 and delivers REAL answers (never sibling's!).
    const realPath = h.makeTranscript(REAL_ID);
    writeAntigravityUserStep(realPath, 1, 'first prompt');
    writeAntigravityFinalStep(realPath, 2, 'REAL_FIRST_ANSWER');
    writeAntigravityUserStep(realPath, 3, 'second prompt');
    writeAntigravityFinalStep(realPath, 4, 'REAL_SECOND_ANSWER');
    h.tick();
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(h.scope.antigravityPendingRebind).toBe(false);
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([
      { turnId: 'om_1', text: 'REAL_FIRST_ANSWER' },
      { turnId: 'om_2', text: 'REAL_SECOND_ANSWER' },
    ]);
  });

  it('resets antigravityPendingRebind on codexBridgeDetachFile and stopCodexBridge so restarts never stay permanently frozen', () => {
    const h = bridgeHarness({ id: 'antigravity', postTerminalPromptFence: false });
    const siblingPath = h.makeTranscript(SIBLING_ID);
    h.notify(SIBLING_ID);
    h.notify(REAL_ID, { preserveLiveTurn: true });
    expect(h.scope.antigravityPendingRebind).toBe(true);

    // Detaching clears antigravityPendingRebind.
    h.scope.codexBridgeDetachFile();
    expect(h.scope.antigravityPendingRebind).toBe(false);

    // Re-arm and verify stopCodexBridge also clears antigravityPendingRebind so a new CLI generation ingests normally.
    h.notify(SIBLING_ID);
    h.notify(REAL_ID, { preserveLiveTurn: true });
    expect(h.scope.antigravityPendingRebind).toBe(true);

    const stopScope: Record<string, any> = {
      ...h.scope,
      pendingStructuredCaptureRetirement: undefined,
      codexBridgeTimer: null,
      codexServiceTierTracker: { detach: vi.fn() },
      activeRuntimePublished: false,
      publishedActiveRuntimeSeeded: false,
      publishedAutoModelVariant: undefined,
      publishedActiveRuntime: {},
      ompRetiredTranscriptPaths: new Set(),
      ebsdRetiredTranscriptPaths: new Set(),
      hermesBridgeOffset: 0,
      hermesBridgeBaselineDone: false,
      hermesBridgeSourceSessionId: undefined,
      mtrBridgeSource: undefined,
      mtrBridgeOffset: 0,
      mtrBridgeBaselineDone: false,
      structuredMissingFinalWatchdog: { observe: vi.fn() },
      resetThinkingChannel: vi.fn(),
      stopAllCursorCot: vi.fn(),
      cursorCotReaderChatId: undefined,
      stopAllAntigravityCot: vi.fn(),
      antigravityCotReaderSessionId: undefined,
      stopKimiActivityObserver: vi.fn(),
      codexAdoptStartMs: undefined,
      lastResolvedSandboxMode: undefined,
      grokBridgePidProbeLastMs: 0,
      traexBridgePidProbeLastMs: 0,
      traexFileSourceLogKey: undefined,
    };
    loadWorkerFunction<() => void>('stopCodexBridge', stopScope)();
    expect(stopScope.antigravityPendingRebind).toBe(false);
    expect(stopScope.codexBridgeRolloutPath).toBeUndefined();
    expect(stopScope.codexBridgePendingSessionId).toBeUndefined();

    // New generation attaches directly and ingests cleanly.
    h.scope.antigravityPendingRebind = stopScope.antigravityPendingRebind;
    h.scope.codexBridgeRolloutPath = undefined;
    h.scope.codexBridgePendingSessionId = undefined;
    const freshPath = h.makeTranscript('30000000-aaaa-4bbb-8ccc-dddd00001111');
    h.queue.mark('om_after_restart', 'after restart', Date.now());
    writeAntigravityUserStep(freshPath, 1, 'after restart');
    writeAntigravityFinalStep(freshPath, 2, 'AFTER_RESTART_ANSWER');
    h.scope.codexBridgeAttach(freshPath, 'fresh-empty');
    expect(h.scope.codexBridgeIngest()).toBe(true);
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([{ turnId: 'om_after_restart', text: 'AFTER_RESTART_ANSWER' }]);
    void siblingPath;
  });

  it('does not hijack stale lastInitConfig.cliSessionId after fresh demotion in armAntigravityCotForTurn or resolveLiveAntigravityTranscriptPath', () => {
    const ABANDONED_ID = '40000000-1111-4222-8333-444455556666';
    const h = bridgeHarness({
      id: 'antigravity',
      runnerFramedInput: false,
      postTerminalPromptFence: false,
      resolveActiveSessionId: () => undefined,
    });
    const abandonedPath = h.makeTranscript(ABANDONED_ID);
    writeAntigravityUserStep(abandonedPath, 1, 'carried prompt');
    writeAntigravityFinalStep(abandonedPath, 2, 'ABANDONED_OLD_ANSWER');

    // Simulate Tier-1/Tier-2 fresh demotion: lastInitConfig.cliSessionId still holds
    // ABANDONED_ID, while lastSpawnEffectiveResume=false, lastSpawnEffectiveCliSessionId=undefined,
    // and inputDeliveryObservedCliSessionId=undefined.
    h.scope.lastInitConfig = { cliId: 'antigravity', workingDir: root, cliSessionId: ABANDONED_ID };
    h.scope.lastSpawnEffectiveResume = false;
    h.scope.lastSpawnEffectiveCliSessionId = undefined;
    h.scope.inputDeliveryObservedCliSessionId = undefined;
    const persistSpy = vi.fn();
    const cotSpy = vi.fn();
    h.scope.persistCliSessionId = persistSpy;
    h.scope.ensureAntigravityCotReader = cotSpy;
    h.scope.codexBridgeNotifyCliSessionId = h.notify;
    h.scope.resolveAntigravityTranscriptPath = resolveAntigravityTranscriptPath;
    h.scope.join = join;

    const armCot = loadWorkerFunction<() => void>('armAntigravityCotForTurn', h.scope);
    const resolveLive = loadWorkerFunction<() => string | undefined>('resolveLiveAntigravityTranscriptPath', h.scope);

    h.queue.mark('om_fresh_1', 'carried prompt', Date.now());
    armCot();
    expect(persistSpy).not.toHaveBeenCalled();
    expect(cotSpy).not.toHaveBeenCalled();
    expect(h.scope.codexBridgeRolloutPath).toBeUndefined();
    expect(resolveLive()).toBeUndefined();
    expect(h.emittedFinals).toEqual([]);
  });

  it('cold-resume arm and live-path reject a transient sibling and retain the explicit target', async () => {
    vi.resetModules();
    const discovery = await import('../src/services/antigravity-discovery.js');
    vi.spyOn(discovery, 'findAntigravityConversationId').mockImplementation(opts => (
      opts.pid === AGY_PID ? SIBLING_ID : null
    ));
    const { createAntigravityAdapter } = await import('../src/adapters/cli/antigravity.js');
    const adapter = createAntigravityAdapter('/usr/local/bin/agy');
    adapter.buildArgs({
      sessionId: 'cold-arm-resume-target',
      resume: true,
      resumeSessionId: REAL_ID,
      reattach: false,
    });
    const h = bridgeHarness(adapter);
    h.scope.lastSpawnEffectiveResume = true;
    h.scope.lastSpawnPersistentReattach = false;
    h.scope.lastSpawnEffectiveCliSessionId = REAL_ID;
    h.scope.inputDeliveryObservedCliSessionId = undefined;
    h.scope.persistCliSessionId = vi.fn();
    h.scope.ensureAntigravityCotReader = vi.fn();
    h.scope.codexBridgeNotifyCliSessionId = h.notify;
    h.scope.resolveAntigravityTranscriptPath = resolveAntigravityTranscriptPath;
    h.scope.join = join;
    const siblingPath = h.makeTranscript(SIBLING_ID);

    const armCot = loadWorkerFunction<() => void>('armAntigravityCotForTurn', h.scope);
    const resolveLive = loadWorkerFunction<() => string | undefined>('resolveLiveAntigravityTranscriptPath', h.scope);
    armCot();

    expect(h.scope.persistCliSessionId).toHaveBeenCalledWith(REAL_ID);
    expect(h.scope.ensureAntigravityCotReader).toHaveBeenCalledWith(REAL_ID);
    expect(h.scope.persistCliSessionId).not.toHaveBeenCalledWith(SIBLING_ID);
    expect(h.scope.codexBridgeRolloutPath).not.toBe(siblingPath);
    expect(h.scope.codexBridgePendingSessionId).toBe(REAL_ID);
    expect(resolveLive()).toBeUndefined();

    const realPath = h.makeTranscript(REAL_ID);
    h.tick();
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
  });

  it('cold-resume native log accepts a later authoritative rotation after the requested target', async () => {
    const { createAntigravityAdapter } = await import('../src/adapters/cli/antigravity.js');
    const adapter = createAntigravityAdapter('/usr/local/bin/agy');
    const args = adapter.buildArgs({
      sessionId: 'cold-native-log-later-rotation',
      resume: true,
      resumeSessionId: SIBLING_ID,
      reattach: false,
    });
    const logPath = args[args.indexOf('--log-file') + 1]!;
    writeFileSync(logPath, streamingLine(SIBLING_ID));
    const h = bridgeHarness(adapter);
    h.scope.lastSpawnEffectiveResume = true;
    h.scope.lastSpawnPersistentReattach = false;
    h.scope.lastSpawnEffectiveCliSessionId = SIBLING_ID;
    h.scope.inputDeliveryObservedCliSessionId = undefined;
    h.scope.persistCliSessionId = vi.fn();
    h.scope.ensureAntigravityCotReader = vi.fn();
    h.scope.codexBridgeNotifyCliSessionId = h.notify;
    h.scope.resolveAntigravityTranscriptPath = resolveAntigravityTranscriptPath;
    h.scope.join = join;
    const oldPath = h.makeTranscript(SIBLING_ID);
    const realPath = h.makeTranscript(REAL_ID);
    const armCot = loadWorkerFunction<() => void>('armAntigravityCotForTurn', h.scope);
    const resolveLive = loadWorkerFunction<() => string | undefined>('resolveLiveAntigravityTranscriptPath', h.scope);

    armCot();
    expect(h.scope.codexBridgeRolloutPath).toBe(oldPath);
    appendFileSync(logPath, streamingLine(REAL_ID));
    armCot();

    expect(h.scope.persistCliSessionId).toHaveBeenCalledWith(REAL_ID);
    expect(h.scope.ensureAntigravityCotReader).toHaveBeenCalledWith(REAL_ID);
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(resolveLive()).toBe(realPath);
  });

  it('cold-resume ticker ignores a transient sibling fd that disagrees with the explicit resume target', () => {
    const RESUME_TARGET = REAL_ID;
    const h = bridgeHarness({
      id: 'antigravity',
      runnerFramedInput: false,
      postTerminalPromptFence: false,
      resolveActiveSessionId: () => SIBLING_ID,
    });
    const persistedIds: string[] = [];
    h.scope.persistCliSessionId = (cid: string) => persistedIds.push(cid);
    h.scope.lastSpawnEffectiveResume = true;
    h.scope.lastSpawnEffectiveCliSessionId = RESUME_TARGET;
    h.scope.codexBridgePendingSessionId = RESUME_TARGET;
    h.makeTranscript(SIBLING_ID);
    h.scope.codexBridgeStartTimer();

    h.tick();
    expect(h.scope.codexBridgeRolloutPath).toBeUndefined();
    expect(persistedIds).toEqual([]);
    expect(h.scope.codexBridgePendingSessionId).toBe(RESUME_TARGET);
  });

  it('persistent-reattach ticker binds and persists a native /new completed while the worker was down', async () => {
    const { createAntigravityAdapter } = await import('../src/adapters/cli/antigravity.js');
    const adapter = createAntigravityAdapter('/usr/local/bin/agy');
    const args = adapter.buildArgs({
      sessionId: 'warm-ticker-native-rotation',
      resume: true,
      resumeSessionId: SIBLING_ID,
      reattach: true,
    });
    const logPath = args[args.indexOf('--log-file') + 1]!;
    writeFileSync(logPath, streamingLine(REAL_ID));
    const h = bridgeHarness(adapter);
    h.scope.lastSpawnEffectiveResume = true;
    h.scope.lastSpawnPersistentReattach = true;
    h.scope.lastSpawnEffectiveCliSessionId = SIBLING_ID;
    h.scope.persistCliSessionId = vi.fn();
    const realPath = h.makeTranscript(REAL_ID);
    h.scope.codexBridgeStartTimer();

    h.tick();
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(h.scope.persistCliSessionId).toHaveBeenCalledWith(REAL_ID);
    expect(h.scope.codexBridgePendingSessionId).toBeUndefined();
  });

  it('preserves a submitted turn that was prematurely misattributed to a sibling during writeInput and avoids setting pendingRebind when unbound', () => {
    const h = bridgeHarness({
      id: 'antigravity',
      runnerFramedInput: false,
      postTerminalPromptFence: false,
    });
    const preserveSubmitted = loadWorkerFunction<(id: string | undefined) => boolean>('shouldPreserveAntigravitySubmittedTurn', h.scope);

    // Unbound + lazy REAL_ID with preserveLiveTurn: true must NOT leave antigravityPendingRebind = true.
    h.notify(REAL_ID, { preserveLiveTurn: true });
    expect(h.scope.codexBridgePendingSessionId).toBe(REAL_ID);
    expect(h.scope.antigravityPendingRebind).toBe(false);

    // Now test the misbind-during-submit race: bridge bound to SIBLING_ID, submitted turn starts on SIBLING_ID.
    const siblingPath = h.makeTranscript(SIBLING_ID);
    h.notify(SIBLING_ID);
    h.queue.mark('om_submitted', '继续', Date.now());
    writeAntigravityUserStep(siblingPath, 1, '继续');
    appendFileSync(siblingPath, JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'Created the following subagent:\n{ "conversationId": "pending-agent" }' }) + '\n');
    writeAntigravityFinalStep(siblingPath, 3, 'Sibling waiting');
    h.scope.codexBridgeIngest();
    expect(preserveSubmitted('om_submitted')).toBe(true);

    // Post-submit confirmation receives REAL_ID before REAL_ID's transcript exists (wait-pending):
    // preserveLiveTurn keeps antigravityPendingRebind = true across a second non-preserve confirm too.
    h.notify(REAL_ID, { preserveLiveTurn: true });
    expect(h.scope.antigravityPendingRebind).toBe(true);
    h.notify(REAL_ID);
    expect(h.scope.antigravityPendingRebind).toBe(true);

    const realPath = h.makeTranscript(REAL_ID);
    writeAntigravityUserStep(realPath, 1, '继续');
    writeAntigravityFinalStep(realPath, 2, 'REAL_SUBMITTED_ANSWER');
    h.tick();
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(h.scope.antigravityPendingRebind).toBe(false);
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([{ turnId: 'om_submitted', text: 'REAL_SUBMITTED_ANSWER' }]);
  });

  it('applyAuthoritative canonicalizes direct write-result UUID casing before bridge lookup', () => {
    const h = bridgeHarness({ id: 'antigravity', postTerminalPromptFence: false });
    h.scope.persistCliSessionId = vi.fn();
    h.scope.ensureAntigravityCotReader = vi.fn();
    h.scope.codexBridgeNotifyCliSessionId = h.notify;
    const realPath = h.makeTranscript(REAL_ID);
    const applyAuthoritative = loadWorkerFunction<(id: string) => void>('applyAuthoritativeAntigravitySessionId', h.scope);

    applyAuthoritative(REAL_ID.toUpperCase());

    expect(h.scope.persistCliSessionId.mock.calls).toEqual([[REAL_ID]]);
    expect(h.scope.ensureAntigravityCotReader.mock.calls).toEqual([[REAL_ID]]);
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(h.scope.codexBridgePendingSessionId).toBeUndefined();
  });

  it('stale pre-write arm keeps a different REAL pending rebind frozen until the real transcript arrives', () => {
    let activeId: string | undefined = SIBLING_ID;
    const h = bridgeHarness({
      id: 'antigravity',
      runnerFramedInput: false,
      postTerminalPromptFence: false,
      resolveActiveSessionId: () => activeId,
    });
    h.scope.persistCliSessionId = vi.fn();
    h.scope.ensureAntigravityCotReader = vi.fn();
    h.scope.codexBridgeNotifyCliSessionId = h.notify;
    h.scope.lastSpawnEffectiveCliSessionId = undefined;
    const armCot = loadWorkerFunction<() => void>('armAntigravityCotForTurn', h.scope);
    const applyAuthoritative = loadWorkerFunction<(
      id: string,
      options?: { preserveLiveTurn?: boolean },
    ) => void>('applyAuthoritativeAntigravitySessionId', h.scope);

    const siblingPath = h.makeTranscript(SIBLING_ID);
    h.notify(SIBLING_ID);
    h.queue.mark('om_stale_1', 'first prompt', Date.now());
    writeAntigravityUserStep(siblingPath, 1, 'first prompt');
    appendFileSync(siblingPath, JSON.stringify({ type: 'GENERIC', status: 'DONE', content: 'Created the following subagent:\n{ "conversationId": "pending-agent" }' }) + '\n');
    writeAntigravityFinalStep(siblingPath, 3, 'WRONG_SIBLING_WAIT');
    h.scope.codexBridgeIngest();

    applyAuthoritative(REAL_ID, { preserveLiveTurn: true });
    expect(h.scope.codexBridgePendingSessionId).toBe(REAL_ID);
    expect(h.scope.antigravityPendingRebind).toBe(true);

    // A late direct confirmation for the bound old ID must not cancel REAL.
    h.notify(SIBLING_ID);
    expect(h.scope.codexBridgePendingSessionId).toBe(REAL_ID);
    expect(h.scope.antigravityPendingRebind).toBe(true);

    applyAuthoritative(SIBLING_ID);
    expect(h.scope.persistCliSessionId.mock.calls).toEqual([[REAL_ID]]);
    expect(h.scope.ensureAntigravityCotReader.mock.calls).toEqual([[REAL_ID]]);
    expect(h.scope.codexBridgePendingSessionId).toBe(REAL_ID);
    expect(h.scope.antigravityPendingRebind).toBe(true);

    h.queue.mark('om_stale_2', 'second prompt', Date.now());
    activeId = SIBLING_ID;
    armCot();
    expect(h.scope.persistCliSessionId).not.toHaveBeenCalledWith(SIBLING_ID);
    expect(h.scope.ensureAntigravityCotReader).not.toHaveBeenCalledWith(SIBLING_ID);
    expect(h.scope.codexBridgePendingSessionId).toBe(REAL_ID);
    expect(h.scope.antigravityPendingRebind).toBe(true);
    h.flushQuietFinal();
    expect(h.emittedFinals).toEqual([]);

    activeId = REAL_ID;
    const realPath = h.makeTranscript(REAL_ID);
    writeAntigravityUserStep(realPath, 1, 'first prompt');
    writeAntigravityFinalStep(realPath, 2, 'REAL_FIRST_ANSWER');
    h.tick();
    h.flushQuietFinal();
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(h.emittedFinals).toEqual([{ turnId: 'om_stale_1', text: 'REAL_FIRST_ANSWER' }]);
  });

  it('rebinds an idle bridge immediately when authoritative id switches with preserveLiveTurn: true', () => {
    const h = bridgeHarness({ id: 'antigravity', postTerminalPromptFence: false });
    const siblingPath = h.makeTranscript(SIBLING_ID);
    const realPath = h.makeTranscript(REAL_ID);
    h.notify(SIBLING_ID);
    expect(h.scope.codexBridgeRolloutPath).toBe(siblingPath);
    expect(h.queue.peek()).toEqual([]);

    h.notify(REAL_ID, { preserveLiveTurn: true });
    expect(h.scope.codexBridgeRolloutPath).toBe(realPath);
    expect(h.scope.codexBridgePendingSessionId).toBeUndefined();
    expect(h.scope.antigravityPendingRebind).toBe(false);
  });
});
