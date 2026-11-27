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
});
