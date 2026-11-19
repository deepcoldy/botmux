import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import {
  antigravityRecoveryBindPath,
  decideAntigravityFullUpgrade,
  decideAntigravityNotifyAction,
  decideAntigravityTickerAction,
} from '../src/services/antigravity-bridge-decision.js';
import {
  drainAntigravityTranscript,
  mapAntigravityCompactOffsetToFull,
  resolveAntigravityTranscriptPath,
  type AntigravityTranscriptState,
} from '../src/services/antigravity-transcript.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const SIBLING_ID = '61fc8ef7-1886-40af-9bac-c6ee8f8d172e';
const REAL_ID = 'a4331552-f261-4f1f-a460-e15e7f2fe0ea';

function writeAntigravityUserStep(path: string, stepIndex: number, text: string): void {
  appendFileSync(path, JSON.stringify({
    step_index: stepIndex,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: new Date().toISOString(),
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
  }) + '\n');
}

function writeAntigravityFinalStep(path: string, stepIndex: number, text: string): void {
  appendFileSync(path, JSON.stringify({
    step_index: stepIndex,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: new Date().toISOString(),
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
          { flushTrailingFinal: opts?.flushAntigravityTrailingFinal },
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
          { flushTrailingFinal: opts?.flushAntigravityTrailingFinal },
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
          { flushTrailingFinal: opts?.flushAntigravityTrailingFinal },
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
    const notify = loadWorkerFunction<(sid: string) => void>('codexBridgeNotifyCliSessionId', scope);
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
    expect(codexBridgeNotifyCliSessionId.mock.calls).toEqual([[REAL_ID]]);
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
