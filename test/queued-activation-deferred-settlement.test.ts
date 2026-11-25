import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as bots from '../src/bot-registry.js';
import { BridgeTurnQueue } from '../src/services/bridge-turn-queue.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { unwrapCursorUserInput } from '../src/services/cursor-transcript.js';
import { extractMessageContentForFingerprint } from '../src/adapters/cli/claude-code.js';
import { Aggregator } from '../src/dashboard/aggregator.js';
import { publishClosedSessionPatch } from '../src/core/session-activity.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import {
  claudeNativeSessionIdFromJsonlPath,
  createQueuedActivationReceiptObserver,
  matchesQueuedActivationTurn,
  proofFromSubmitRecheckResult,
  recheckResultFromProof,
} from '../src/services/queued-activation-receipts.js';
import {
  decideSubmitConfirmationAction,
  isAuthoritativeClaudeTranscriptTurn,
  isAuthoritativeStructuredTranscriptTurn,
  isAuthoritativeSubmitSendMarker,
  selectSubmitActivityEvidence,
  settleDeferredSubmitConfirmation,
} from '../src/services/submit-confirmation.js';
import { cancelSubmitFailureChainForTerminal } from '../src/services/submit-failure-chain.js';
import * as sessionStore from '../src/services/session-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import type { BridgeSendMarker } from '../src/services/bridge-fallback-gate.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

const APP = 'cli_test_3748';
const originalDataDir = config.session.dataDir;
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStore.__testOnly_setBeforeRowPersist(undefined);
  if (tempDirs.length > 0) {
    config.session.dataDir = originalDataDir;
    sessionStore.init(APP);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function createActivationSubmitHarness(opts: {
  cliId?: string;
  item?: Record<string, unknown>;
  writeResult?: Record<string, unknown>;
  quarantine?: boolean;
  sendMarkers?: BridgeSendMarker[];
} = {}) {
  const h = workerSubmitHarness();
  const { scope } = h;
  const bridgeQueue = new BridgeTurnQueue(undefined, undefined, (turn, evidence) => {
    scope.observeAuthoritativeClaudeTurnStart(turn, evidence);
  });
  const codexQueue = new CodexBridgeQueue();
  codexQueue.setTurnStartObserver((turn, evidence) => {
    scope.observeAuthoritativeStructuredTurnStart(turn, evidence);
  });

  const cliId = opts.cliId ?? 'claude-code';
  const isClaude = cliId === 'claude-code';
  const sendMarkers = opts.sendMarkers ?? [];
  const item = {
    turnId: 'om_turn_1',
    content: '[来自 协作机器人 的 @mention]\n@Claude\n请帮我检查登录回调是否遗漏了 token 结算',
    queuedActivationToken: 'tok-act-001',
    nativeSessionTitle: '检查回调',
    ...(opts.item ?? {}),
  };
  scope.pendingMessages.splice(0, scope.pendingMessages.length, item);

  const recheck = vi.fn(async () => false);
  const writeResult = opts.writeResult ?? { submitted: false, recheck };
  Object.assign(scope, {
    sessionId: 'sess-3748',
    lastInitConfig: { cliId },
    cliAdapter: {
      reliableTurnTerminal: true,
      quarantineUnconfirmedSubmits: opts.quarantine === true,
      writeInput: vi.fn(async () => writeResult),
    },
    bridgeJsonlPath: isClaude ? '/tmp/claude-proj/11111111-2222-3333-4444-555555555555.jsonl' : null,
    bridgeQueue,
    bridgeSecondaryPaths: new Map<string, number>(),
    bridgeIngest: vi.fn(),
    bridgeMarkPendingTurn: (
      content: string,
      turnId?: string,
      dispatchAttempt?: number,
      _linkRefMode?: 'observe' | 'enabled',
      submittedMessage?: string,
    ) => {
      const id = turnId ?? 'bridge-synth-1';
      const normalised = content.trim().replace(/\s+/g, ' ');
      const extraExactContents = submittedMessage && submittedMessage !== content
        ? [submittedMessage.trim().replace(/\s+/g, ' ')]
        : undefined;
      bridgeQueue.mark(id, normalised.slice(0, 30), Date.now(), normalised, dispatchAttempt, {
        ...(extraExactContents ? { extraExactContents } : {}),
      });
      return id;
    },
    codexBridgeActive: !isClaude,
    codexBridgeFallbackActive: () => !isClaude,
    codexBridgeQueue: codexQueue,
    codexBridgeMarkPendingTurn: (
      content: string,
      turnId: string | undefined,
      dispatchAttempt: number | undefined,
      atMs: number,
      _linkRefMode?: 'observe' | 'enabled',
      submittedMessage?: string,
    ) => {
      const id = turnId ?? 'codex-synth-1';
      codexQueue.mark(id, content, atMs, dispatchAttempt, undefined, undefined, false, submittedMessage);
      return id;
    },
    codexBridgeNotifyCliSessionId: vi.fn(),
    codexBridgeNoteUnprovenCliSessionId: vi.fn(),
    currentCodexObservedPid: () => undefined,
    recordStructuredInput: vi.fn(),
    readSendMarkers: () => sendMarkers,
    lastPtyActivityAtMs: 0,
    lastStructuredBridgeActivityAtMs: 0,
    inputDeliveryObservedCliSessionId: undefined,
    inflightInputs: {
      onWrite: vi.fn(),
      forget: vi.fn(),
      retire: vi.fn(),
      onTurnStarted: vi.fn(),
      onTurnComplete: vi.fn(),
      retireTurn: vi.fn(),
    },
    startupNativeInputSeen: false,
    cliGenerationTurnWrites: 0,
    dropFailedBridgeMark: vi.fn(),
    decideSubmitConfirmationAction,
    selectSubmitActivityEvidence,
    cancelSubmitFailureChainForTerminal,
    terminalReleasesDurableTurn: () => true,
    submitUnconfirmedNotice: vi.fn((arg: Record<string, unknown>) => ({ type: 'user_notify', ...arg })),
    captureBackendScreen: vi.fn(() => ''),
    diagnoseBackendSubmitFailure: vi.fn(() => ({ reason: 'unknown', evidence: 'none' })),
    claudeComposerHoldsInput: () => false,
    shouldWaitThroughBusyTurn: () => false,
    SUBMIT_DIAG_ACTIVE_SILENCE_MAX_EXTRA: 3,
    SUBMIT_DIAG_BUSY_SILENCE_MAX_EXTRA: 12,
    effectiveBackendType: 'pty',
    structuredTurnsWithSubmitNotice: new Set<string>(),
    traexFirstSubmitConfirmed: false,
    traexAutoModelController: undefined,
    backgroundTaskTracker: { backgroundWait: () => 0 },
    turnExecutionClock: { settle: () => undefined, forget: vi.fn() },
    emittedTurnTerminals: { claim: vi.fn(() => true) },
    releaseActiveTurnAuthority: () => true,
    releaseTerminatedActiveTurnAuthority: vi.fn(),
    scheduleConsumedQueuedTurnAdvance: vi.fn(),
    retireTerminatedQueuedTurn: vi.fn(),
    kimiActivityObserver: null,
    thinkingTurn: null,
    captureTurnFailureDiagnostics: false,
    turnFailedWithoutOutput: () => false,
    workerSessionEventScope: null,
    publishCliInputBacklog: vi.fn(),
  });

  scope.submitActivityEvidenceSince = loadWorkerFunction('submitActivityEvidenceSince', scope);
  scope.probeAuthoritativeQueuedActivationEvidence = loadWorkerFunction('probeAuthoritativeQueuedActivationEvidence', scope);
  scope.observeAuthoritativeClaudeTurnStart = loadWorkerFunction('observeAuthoritativeClaudeTurnStart', scope);
  scope.observeAuthoritativeStructuredTurnStart = loadWorkerFunction('observeAuthoritativeStructuredTurnStart', scope);
  scope.acknowledgeQueuedActivationToken = loadWorkerFunction('acknowledgeQueuedActivationToken', scope);
  scope.acknowledgeQueuedActivation = loadWorkerFunction('acknowledgeQueuedActivation', scope);
  scope.observeQueuedActivationReceipt = vi.fn(loadWorkerFunction('observeQueuedActivationReceipt', scope));
  scope.scheduleSubmitFailureNotify = loadWorkerFunction('scheduleSubmitFailureNotify', scope);
  scope.emitTurnTerminal = loadWorkerFunction('emitTurnTerminal', scope);
  scope.cliInputBacklog = loadWorkerFunction('cliInputBacklog', scope);
  const flush = loadWorkerFunction<() => Promise<void>>('flushPending', scope);
  scope.flushPending = flush;

  const ackMessages = () => scope.send.mock.calls
    .map(([m]: [any]) => m)
    .filter((m: any) => m?.type === 'queued_activation_submitted');
  const notifyMessages = () => scope.send.mock.calls
    .map(([m]: [any]) => m)
    .filter((m: any) => m?.type === 'user_notify');

  return {
    ...h,
    bridgeQueue,
    codexQueue,
    recheck,
    item,
    sendMarkers,
    flush,
    ackMessages,
    notifyMessages,
  };
}

function createDaemonActivationHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-3748-daemon-'));
  tempDirs.push(dir);
  config.session.dataDir = dir;
  const bot = {
    config: { larkAppId: APP, larkAppSecret: 'fixture-only', cliId: 'claude-code' },
    botName: 'TestBot',
    resolvedAllowedUsers: [],
  } as unknown as ReturnType<typeof bots.getBot>;
  vi.spyOn(bots, 'getBot').mockImplementation(() => bot);
  sessionStore.init(APP);
  workerPool.initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => dir,
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
  const session = sessionStore.createSession('oc_chat', 'om_root', '测试会话', 'group', 'thread', { source: 'external' });
  Object.assign(session, {
    cliId: 'claude-code',
    backendType: 'pty',
    workerGeneration: 1,
    queued: false,
    queuedActivationPending: true,
    queuedActivationToken: 'tok-act-001',
    queuedActivationTurnId: 'om_turn_1',
    queuedActivationInput: { content: 'opening turn' },
  });
  sessionStore.updateSession(session);
  const worker: any = new EventEmitter();
  Object.assign(worker, {
    pid: 12345,
    killed: false,
    connected: true,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    send: vi.fn(() => true),
    kill: vi.fn(),
  });
  const ds = {
    session,
    larkAppId: APP,
    chatId: session.chatId,
    chatType: 'group',
    scope: 'thread',
    workingDir: dir,
    worker,
    workerGeneration: 1,
    workerReady: true,
    initialStartPending: true,
    initialStartClaimToken: 'claim-1',
    hasHistory: false,
    spawnedAt: Date.now(),
    lastMessageAt: Date.now(),
    pendingFollowUps: undefined,
  } as unknown as DaemonSession;
  const disk = () => sessionStore.readSessionRowFromDisk(session.sessionId, APP)!;
  return { dir, session, worker, ds, disk };
}

describe('queued-activation-receipts pure coordinator seams', () => {
  it('normalizes recheck proofs, enforces generation/turn/attempt/session matching, and claims each token once', () => {
    expect(proofFromSubmitRecheckResult(false)).toBeUndefined();
    expect(proofFromSubmitRecheckResult({ submitted: false })).toBeUndefined();
    expect(proofFromSubmitRecheckResult(true, 'deferred-recheck')).toEqual({
      source: 'deferred-recheck',
      rawRecheckResult: true,
    });
    const rich = proofFromSubmitRecheckResult({
      submitted: true,
      cliSessionId: 'sid-1',
      ownershipProven: true,
    });
    expect(rich).toEqual({
      source: 'adapter-recheck',
      cliSessionId: 'sid-1',
      ownershipProven: true,
      rawRecheckResult: { submitted: true, cliSessionId: 'sid-1', ownershipProven: true },
    });
    expect(recheckResultFromProof({ source: 'structured-transcript', cliSessionId: 'sid-2' })).toEqual({
      submitted: true,
      cliSessionId: 'sid-2',
    });
    expect(claudeNativeSessionIdFromJsonlPath('/a/b/11111111-2222-3333-4444-555555555555.jsonl'))
      .toBe('11111111-2222-3333-4444-555555555555');
    expect(claudeNativeSessionIdFromJsonlPath('/a/b/short.jsonl')).toBeUndefined();

    expect(matchesQueuedActivationTurn(
      { sessionId: 's1', generation: 3, turnId: 'om_1', dispatchAttempt: 1 },
      { sessionId: 's1', generation: 3, turnId: 'om_1', dispatchAttempt: 1 },
    )).toBe(true);
    expect(matchesQueuedActivationTurn(
      { sessionId: 's1', generation: 3, turnId: 'om_1', dispatchAttempt: 1 },
      { sessionId: 's1', generation: 4, turnId: 'om_1', dispatchAttempt: 1 },
    )).toBe(false);
    expect(matchesQueuedActivationTurn(
      { sessionId: 's1', generation: 3, turnId: 'om_1', dispatchAttempt: 1 },
      { sessionId: 's1', generation: 3, turnId: 'om_1', dispatchAttempt: 2 },
    )).toBe(false);
    expect(matchesQueuedActivationTurn(
      { sessionId: 's1', generation: 3, turnId: 'om_1', dispatchAttempt: 1 },
      { sessionId: 's2', generation: 3, turnId: 'om_1', dispatchAttempt: 1 },
    )).toBe(false);

    const observer = createQueuedActivationReceiptObserver(20);
    expect(observer.claimOnce('tok-1')).toBe(true);
    expect(observer.claimOnce('tok-1')).toBe(false);
    expect(observer.isSettled('tok-1')).toBe(true);
    // Settled token stays permanently suppressed even after clear() on restart.
    observer.clear();
    expect(observer.watch('tok-1', { isCurrent: () => true, onSettled: vi.fn() })).toBe(false);
    expect(observer.claimOnce('tok-1')).toBe(false);
  });

  it('rejects partial/provisional/stale/cross-session/terminalIndependent evidence in submit-confirmation predicates', () => {
    expect(isAuthoritativeClaudeTranscriptTurn({ started: true, fullContentMatch: true })).toBe(true);
    expect(isAuthoritativeClaudeTranscriptTurn({ started: true, fullContentMatch: false })).toBe(false);
    expect(isAuthoritativeClaudeTranscriptTurn({ started: true, fullContentMatch: true, isLocal: true })).toBe(false);
    expect(isAuthoritativeClaudeTranscriptTurn({ started: true, fullContentMatch: true, restoredFromJournal: true })).toBe(false);

    expect(isAuthoritativeStructuredTranscriptTurn({
      started: true, exactUserInputMatch: true, provisionalTaskStartedAtMs: undefined,
    })).toBe(true);
    expect(isAuthoritativeStructuredTranscriptTurn({
      started: true, exactUserInputMatch: true, provisionalTaskStartedAtMs: 1_000,
    })).toBe(false);
    expect(isAuthoritativeStructuredTranscriptTurn({
      started: true, exactUserInputMatch: false,
    })).toBe(false);

    const target = { turnId: 'om_1', dispatchAttempt: 1 };
    expect(isAuthoritativeSubmitSendMarker(
      { sessionId: 's1', turnId: 'om_1', dispatchAttempt: 1, sentAtMs: 5_000 },
      target,
      { sessionId: 's1', sinceMs: 4_000 },
    )).toBe(true);
    expect(isAuthoritativeSubmitSendMarker(
      { sessionId: 's1', turnId: 'om_1', dispatchAttempt: 1, sentAtMs: 3_999 },
      target,
      { sessionId: 's1', sinceMs: 4_000 },
    )).toBe(false);
    expect(isAuthoritativeSubmitSendMarker(
      { sessionId: 's2', turnId: 'om_1', dispatchAttempt: 1, sentAtMs: 5_000 },
      target,
      { sessionId: 's1', sinceMs: 4_000 },
    )).toBe(false);
    expect(isAuthoritativeSubmitSendMarker(
      { sessionId: 's1', turnId: 'om_1', dispatchAttempt: 1, sentAtMs: 5_000, terminalIndependent: true },
      target,
      { sessionId: 's1', sinceMs: 4_000 },
    )).toBe(false);
    expect(selectSubmitActivityEvidence({
      target,
      ptyActive: false,
      structuredTurns: [{ turnId: 'om_1', dispatchAttempt: 1, fullInputMatch: false }],
      sendMarkers: [],
    })).toBeUndefined();
  });
});

describe('#3748 Scenario 1: recheck=false + authoritative structured-transcript / botmux-send settles once and releases FIFO tail', () => {
  it('settles Claude queuedActivationPending via full structured-transcript when adapter recheck stays false, and releases daemon tail M2->M3 in FIFO order at most once', async () => {
    vi.useFakeTimers();
    const d = createDaemonActivationHarness();
    const h = createActivationSubmitHarness({ cliId: 'claude-code' });
    h.scope.sessionId = d.session.sessionId;
    await h.flush();

    expect(h.ackMessages()).toEqual([]);
    expect(h.queuedActivationReceipts.size()).toBe(1);
    expect(h.submitFailureChains.size()).toBe(1);

    // Adapter recheck stays false forever, while Claude's BridgeTurnQueue sees
    // the full user record for om_turn_1.
    h.bridgeQueue.ingest([{
      type: 'user',
      uuid: 'u-full-1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: h.item.content },
    }], '/tmp/claude-proj/11111111-2222-3333-4444-555555555555.jsonl');

    // Settled immediately on authoritative transcript start — no 20s wait, no warning, no duplicate ACK.
    expect(h.ackMessages()).toEqual([{
      type: 'queued_activation_submitted',
      sessionId: d.session.sessionId,
      activationToken: 'tok-act-001',
    }]);
    expect(h.queuedActivationReceipts.size()).toBe(0);
    expect(h.submitFailureChains.size()).toBe(0);
    expect(h.scope.recordStructuredInput).toHaveBeenCalledTimes(1);
    expect(h.scope.persistCliSessionId).toHaveBeenCalledWith('11111111-2222-3333-4444-555555555555');

    // Advancing timers well past deferred recheck never emits a warning or second ACK.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.ackMessages()).toHaveLength(1);
    expect(h.notifyMessages()).toEqual([]);

    // Feed the single worker ACK into daemon + real SQLite with 2 buffered same-anchor turns (M2, M3).
    const r2 = workerPool.reserveQueuedActivationTailAdmission(d.ds);
    const r3 = workerPool.reserveQueuedActivationTailAdmission(d.ds);
    workerPool.admitQueuedActivationTail(d.ds, {
      userPrompt: 'second message M2',
      cliInput: { content: 'second message M2' },
      turnId: 'om_turn_2',
    }, r2);
    workerPool.admitQueuedActivationTail(d.ds, {
      userPrompt: 'third message M3',
      cliInput: { content: 'third message M3' },
      turnId: 'om_turn_3',
    }, r3);
    expect(d.disk().queuedActivationTail?.map(e => e.turnId))
      .toEqual(['om_turn_2', 'om_turn_3']);

    const releaseNext = () => {
      if (!d.ds.session.queuedActivationTail?.length && !d.ds.session.queuedActivationPending) {
        d.ds.initialStartPending = false;
        return true;
      }
      return workerPool.promoteQueuedActivationTail(d.ds);
    };

    const ack1 = h.ackMessages()[0];
    const ok1 = await workerPool.handleQueuedActivationSubmittedAck({
      ds: d.ds,
      msg: ack1,
      tag: d.session.sessionId.slice(0, 8),
      ownsLifecycleMutation: () => d.ds.worker === d.worker
        && d.ds.workerGeneration === d.ds.session.workerGeneration
        && d.ds.session.status === 'active',
      updateSession: s => sessionStore.updateSession(s),
      onQueuedActivationSubmitted: releaseNext,
    });
    expect(ok1).toBe(true);
    // M2 promoted first with a fresh token; M3 still waiting in FIFO tail.
    expect(d.worker.send).toHaveBeenCalledTimes(1);
    expect(d.worker.send.mock.calls[0][0]).toMatchObject({
      type: 'message',
      turnId: 'om_turn_2',
      content: 'second message M2',
    });
    const tok2 = d.worker.send.mock.calls[0][0].queuedActivationToken as string;
    expect(tok2).toBeTruthy();
    expect(tok2).not.toBe('tok-act-001');
    expect(d.disk().queuedActivationTail?.map(e => e.turnId)).toEqual(['om_turn_3']);

    // Duplicate delivery of ACK1 is ignored and never double-releases M2 or skips ahead to M3.
    const dup1 = await workerPool.handleQueuedActivationSubmittedAck({
      ds: d.ds,
      msg: ack1,
      tag: d.session.sessionId.slice(0, 8),
      ownsLifecycleMutation: () => true,
      updateSession: s => sessionStore.updateSession(s),
      onQueuedActivationSubmitted: releaseNext,
    });
    expect(dup1).toBe(false);
    expect(d.worker.send).toHaveBeenCalledTimes(1);

    // ACK2 promotes M3; ACK3 clears queuedActivationPending & opens the gate.
    await workerPool.handleQueuedActivationSubmittedAck({
      ds: d.ds,
      msg: { sessionId: d.session.sessionId, activationToken: tok2 },
      tag: d.session.sessionId.slice(0, 8),
      ownsLifecycleMutation: () => true,
      updateSession: s => sessionStore.updateSession(s),
      onQueuedActivationSubmitted: releaseNext,
    });
    expect(d.worker.send).toHaveBeenCalledTimes(2);
    expect(d.worker.send.mock.calls[1][0]).toMatchObject({
      type: 'message',
      turnId: 'om_turn_3',
      content: 'third message M3',
    });
    const tok3 = d.worker.send.mock.calls[1][0].queuedActivationToken as string;
    await workerPool.handleQueuedActivationSubmittedAck({
      ds: d.ds,
      msg: { sessionId: d.session.sessionId, activationToken: tok3 },
      tag: d.session.sessionId.slice(0, 8),
      ownsLifecycleMutation: () => true,
      updateSession: s => sessionStore.updateSession(s),
      onQueuedActivationSubmitted: releaseNext,
    });
    const finalRow = d.disk();
    expect(finalRow.queuedActivationPending).toBeUndefined();
    expect(finalRow.queuedActivationToken).toBeUndefined();
    expect(finalRow.queuedActivationTail).toBeUndefined();
    expect(d.ds.initialStartPending).toBe(false);
  });

  it('settles deferred recheck suppress-active on authoritative botmux-send marker when recheck() stays false', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-25T10:00:00.000Z');
    vi.setSystemTime(now);
    const h = createActivationSubmitHarness({ cliId: 'claude-code' });
    await h.flush();

    expect(h.ackMessages()).toEqual([]);
    // CLI runs `botmux send` after write started, tagging the exact turn & session.
    h.sendMarkers.push({
      sentAtMs: now + 5_000,
      sessionId: 'sess-3748',
      turnId: 'om_turn_1',
      deliveryKind: 'direct',
      responseKind: 'final',
      contentHash: 'hash',
      contentPreview: 'done',
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.ackMessages()).toEqual([{
      type: 'queued_activation_submitted',
      sessionId: 'sess-3748',
      activationToken: 'tok-act-001',
    }]);
    expect(h.queuedActivationReceipts.size()).toBe(0);
    expect(h.submitFailureChains.size()).toBe(0);
    expect(h.notifyMessages()).toEqual([]);

    // Also prove scheduleSubmitFailureNotify's own suppress-active -> confirmToken
    // branch settles an active recheck-only watch directly (even if the observer
    // watch itself has no probeEvidence configured).
    const hDirect = createActivationSubmitHarness({ cliId: 'claude-code' });
    const directStart = Date.now();
    hDirect.inputDeliveryEvidence.start(
      { turnId: 'om_turn_direct', cliGeneration: hDirect.scope.cliSpawnGeneration },
      directStart,
    );
    hDirect.scope.cliGenerationTurnWrites = 1;
    hDirect.observeQueuedActivationReceipt?.mockClear?.();
    const directItem = {
      turnId: 'om_turn_direct',
      content: 'direct suppress-active settlement',
      queuedActivationToken: 'tok-direct-1',
    };
    hDirect.scope.observeQueuedActivationReceipt(directItem, async () => false, directItem.content);
    hDirect.scope.scheduleSubmitFailureNotify(
      directItem.content,
      async () => false,
      'transcript',
      'om_turn_direct',
      undefined,
      1,
      directItem,
      'failed',
      false,
    );
    hDirect.sendMarkers.push({
      sentAtMs: directStart + 1_000,
      sessionId: 'sess-3748',
      turnId: 'om_turn_direct',
      deliveryKind: 'direct',
      responseKind: 'final',
      contentHash: 'hd',
      contentPreview: 'direct done',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hDirect.ackMessages()).toEqual([{
      type: 'queued_activation_submitted',
      sessionId: 'sess-3748',
      activationToken: 'tok-direct-1',
    }]);
    expect(hDirect.queuedActivationReceipts.size()).toBe(0);
    expect(hDirect.notifyMessages()).toEqual([]);
  });

  it('settles Codex/TraeX activation on exact structured-transcript match with correlation trailer and catalog-appended msg !== logicalMsg', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-25T10:00:00.000Z');
    vi.setSystemTime(now);
    const h = createActivationSubmitHarness({
      cliId: 'codex',
      item: {
        turnId: 'om_codex_1',
        dispatchAttempt: 1,
        logicalContent: '检查订单同步队列的死锁原因并修复',
        content: '检查订单同步队列的死锁原因并修复\n\n<botmux_builtin_skills>catalog</botmux_builtin_skills>',
        queuedActivationToken: 'tok-codex-1',
      },
    });
    await h.flush();
    expect(h.ackMessages()).toEqual([]);

    // Transcript writes full submitted text + adapter correlation trailer while recheck stays false.
    h.codexQueue.ingest([{
      kind: 'user',
      uuid: 'codex-u1',
      timestampMs: now + 2_000,
      sourceSessionId: 'rollout-sid-99',
      sourceTurnId: 'native-t1',
      text: '检查订单同步队列的死锁原因并修复\n\n<botmux_builtin_skills>catalog</botmux_builtin_skills>\n\n<botmux_routing>\nbotmux_input_id: 0123456789abcdef0123456789abcdef\n</botmux_routing>',
    }]);

    expect(h.ackMessages()).toEqual([{
      type: 'queued_activation_submitted',
      sessionId: 'sess-3748',
      activationToken: 'tok-codex-1',
    }]);
    expect(h.scope.persistCliSessionId).toHaveBeenCalledWith('rollout-sid-99');
    expect(h.queuedActivationReceipts.size()).toBe(0);
    expect(h.submitFailureChains.size()).toBe(0);
  });

  it('settles fast (<20s) completed turn with botmux-send via emitTurnTerminal probe, and never settles bare completion without proof', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-25T10:00:00.000Z');
    vi.setSystemTime(now);

    // Case A: fast <20s completion WITHOUT any authoritative proof -> must NOT settle.
    const hBare = createActivationSubmitHarness({ cliId: 'claude-code' });
    await hBare.flush();
    hBare.scope.emitTurnTerminal('om_turn_1', 'completed');
    expect(hBare.ackMessages()).toEqual([]);
    expect(hBare.queuedActivationReceipts.size()).toBe(1);

    // Case B: fast <20s completion WITH authoritative botmux-send marker -> settles synchronously.
    const hFast = createActivationSubmitHarness({ cliId: 'claude-code' });
    await hFast.flush();
    hFast.sendMarkers.push({
      sentAtMs: now + 3_000,
      sessionId: 'sess-3748',
      turnId: 'om_turn_1',
      deliveryKind: 'direct',
      responseKind: 'final',
      contentHash: 'h',
      contentPreview: 'fast reply',
    });
    hFast.scope.emitTurnTerminal('om_turn_1', 'completed');
    expect(hFast.ackMessages()).toEqual([{
      type: 'queued_activation_submitted',
      sessionId: 'sess-3748',
      activationToken: 'tok-act-001',
    }]);
    expect(hFast.queuedActivationReceipts.size()).toBe(0);
    expect(hFast.submitFailureChains.size()).toBe(0);
  });

  it('settles bare { submitted: false } without recheck when authoritative transcript arrives, and deduplicates racing poll vs transcript', async () => {
    vi.useFakeTimers();
    const hNoRecheck = createActivationSubmitHarness({
      cliId: 'claude-code',
      writeResult: { submitted: false },
    });
    await hNoRecheck.flush();
    expect(hNoRecheck.queuedActivationReceipts.size()).toBe(1);

    hNoRecheck.bridgeQueue.ingest([{
      type: 'user',
      uuid: 'u-bare-1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: hNoRecheck.item.content },
    }], '/tmp/claude-proj/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
    expect(hNoRecheck.ackMessages()).toHaveLength(1);

    // Concurrent overlap: observer poll awaits recheck() while transcript confirms first.
    let resolveRecheck!: (val: boolean) => void;
    const slowRecheck = vi.fn(() => new Promise<boolean>(resolve => { resolveRecheck = resolve; }));
    const hRace = createActivationSubmitHarness({
      cliId: 'claude-code',
      writeResult: { submitted: false, recheck: slowRecheck },
    });
    await hRace.flush();
    // Advance to 20s so poll/deferred recheck enters awaited recheck().
    await vi.advanceTimersByTimeAsync(20_000);
    expect(slowRecheck).toHaveBeenCalled();

    // Transcript proves receipt while recheck() is still pending.
    hRace.bridgeQueue.ingest([{
      type: 'user',
      uuid: 'u-race-1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: hRace.item.content },
    }], '/tmp/claude-proj/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
    expect(hRace.ackMessages()).toHaveLength(1);

    // Late recheck resolution must NOT duplicate ACK or recordStructuredInput.
    resolveRecheck(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hRace.ackMessages()).toHaveLength(1);
    expect(hRace.scope.recordStructuredInput).toHaveBeenCalledTimes(1);
  });
});

describe('#3748 Scenario 2: partial submission, short fingerprint, provisional start, and mismatched evidence do NOT clear journal', () => {
  it('refuses to settle on Claude #3747 partial split (30-char prefix match, fullContentMatch=false) and emits visible activation warning', async () => {
    vi.useFakeTimers();
    // Leading prefix >= 30 normalised chars so BridgeTurnQueue matches the 30-char
    // prefix fingerprint (turn.started = true) while fullContentMatch stays false.
    const splitPrefix = '[来自 automation-dispatcher 的 @mention]\n@Claude\\';
    const fullPrompt = `${splitPrefix}\n请帮我检查登录回调是否遗漏了 token 结算并补齐回归测试`;
    const h = createActivationSubmitHarness({
      cliId: 'claude-code',
      item: {
        turnId: 'om_split_1',
        content: fullPrompt,
        queuedActivationToken: 'tok-split-1',
      },
    });
    await h.flush();

    // Only the truncated prefix landed in transcript (body stayed parked in composer).
    h.bridgeQueue.ingest([{
      type: 'user',
      uuid: 'u-partial-1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: splitPrefix },
    }], '/tmp/claude-proj/11111111-2222-3333-4444-555555555555.jsonl');

    // Bridge attributes the partial turn for display, but fullContentMatch is false.
    expect(h.bridgeQueue.peek()[0]).toMatchObject({
      turnId: 'om_split_1',
      started: true,
      fullContentMatch: false,
    });
    expect(h.ackMessages()).toEqual([]);

    // Deferred recheck runs: must NOT treat partial match as structured-transcript success,
    // must NOT settle queuedActivationPending, must NOT replay writeInput, and MUST warn user.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.ackMessages()).toEqual([]);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.queuedActivationReceipts.size()).toBe(1);
    expect(h.notifyMessages()).toHaveLength(1);
    expect(h.notifyMessages()[0].message).toBe('worker.activation_submit_unconfirmed');
  });

  it('refuses to settle on Codex provisional task_started or 30-char prefix-only match or closed provisional terminal', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-25T10:00:00.000Z');
    vi.setSystemTime(now);
    const fullPrompt = '这是一个超过三十个字符的完整测试指令，后面还有非常重要的具体要求：不要只看前半句';
    const h = createActivationSubmitHarness({
      cliId: 'codex',
      item: {
        turnId: 'om_codex_partial',
        dispatchAttempt: 1,
        content: fullPrompt,
        queuedActivationToken: 'tok-codex-partial',
      },
    });
    await h.flush();

    // 1. Provisional task_started (no user record at all) must NOT settle or suppress.
    h.codexQueue.ingest([{
      kind: 'turn_started',
      uuid: 'ts-1',
      timestampMs: now + 1_000,
      sourceSessionId: 'rollout-1',
      sourceTurnId: 'nt-1',
      text: '',
    }]);
    expect(h.codexQueue.peek()[0].started).toBe(true);
    expect(h.codexQueue.peek()[0].provisionalTaskStartedAtMs).toBeDefined();
    expect(h.ackMessages()).toEqual([]);
    expect(h.scope.submitActivityEvidenceSince(now, { turnId: 'om_codex_partial', dispatchAttempt: 1 }))
      .toBeUndefined();

    // 2. Prefix-only user corroboration (passes 30-char fingerprint, missing the tail) must NOT settle.
    h.codexQueue.ingest([{
      kind: 'user',
      uuid: 'u-prefix-only',
      timestampMs: now + 2_000,
      sourceSessionId: 'rollout-1',
      sourceTurnId: 'nt-1',
      text: '这是一个超过三十个字符的完整测试指令，后面还有非常重要的具体要求',
    }]);
    expect(h.codexQueue.peek()[0].exactUserInputMatch).toBe(false);
    expect(h.ackMessages()).toEqual([]);
    expect(h.scope.submitActivityEvidenceSince(now, { turnId: 'om_codex_partial', dispatchAttempt: 1 }))
      .toBeUndefined();

    // Even if that partial turn produces a native final, hasExactTerminalTurn stays false!
    h.codexQueue.ingest([{
      kind: 'assistant_final',
      uuid: 'af-1',
      timestampMs: now + 3_000,
      sourceSessionId: 'rollout-1',
      sourceTurnId: 'nt-1',
      text: 'I only saw half of your message.',
    }]);
    expect(h.codexQueue.hasTerminalTurn('om_codex_partial', 1)).toBe(true);
    expect(h.codexQueue.hasExactTerminalTurn('om_codex_partial', 1)).toBe(false);
    const settlement = await settleDeferredSubmitConfirmation(h.codexQueue, {
      turnId: 'om_codex_partial',
      dispatchAttempt: 1,
      structuredTarget: true,
      recheck: () => false,
      usageLimitDetected: () => false,
      activityEvidence: () => undefined,
      isCurrent: () => true,
    });
    expect(settlement.stale).toBe(false);
    if (!settlement.stale) expect(settlement.action).toEqual({ kind: 'notify-stuck' });
    expect(h.ackMessages()).toEqual([]);
  });

  it('refuses to settle on bare pty-output, wrong turnId/dispatchAttempt, stale or cross-session or terminalIndependent botmux-send markers', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-25T10:00:00.000Z');
    vi.setSystemTime(now);
    const h = createActivationSubmitHarness({
      cliId: 'claude-code',
      item: {
        turnId: 'om_turn_exact',
        dispatchAttempt: 2,
        content: 'strict matching content',
        queuedActivationToken: 'tok-strict',
      },
    });
    await h.flush();

    // Populate every kind of invalid / weak signal.
    h.scope.lastPtyActivityAtMs = now + 10_000;
    h.scope.lastStructuredBridgeActivityAtMs = now + 10_000;
    h.sendMarkers.push(
      { sentAtMs: now - 100, sessionId: 'sess-3748', turnId: 'om_turn_exact', dispatchAttempt: 2, deliveryKind: 'direct', contentHash: 'a', contentPreview: 'stale' },
      { sentAtMs: now + 1_000, sessionId: 'other-session', turnId: 'om_turn_exact', dispatchAttempt: 2, deliveryKind: 'direct', contentHash: 'b', contentPreview: 'other-session' },
      { sentAtMs: now + 1_000, sessionId: 'sess-3748', turnId: 'om_other_turn', dispatchAttempt: 2, deliveryKind: 'direct', contentHash: 'c', contentPreview: 'other-turn' },
      { sentAtMs: now + 1_000, sessionId: 'sess-3748', turnId: 'om_turn_exact', dispatchAttempt: 1, deliveryKind: 'direct', contentHash: 'd', contentPreview: 'old-attempt' },
      { sentAtMs: now + 1_000, sessionId: 'sess-3748', turnId: 'om_turn_exact', dispatchAttempt: 2, terminalIndependent: true, deliveryKind: 'direct', contentHash: 'e', contentPreview: 'independent' },
    );

    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.ackMessages()).toEqual([]);
    expect(h.queuedActivationReceipts.size()).toBe(1);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
  });

  it('keeps untouched safe non-submission requeued without arming observer or sending ACK, and preserves TRAE quarantine on unattributed recheck', async () => {
    vi.useFakeTimers();
    const hUntouched = createActivationSubmitHarness({
      cliId: 'codex',
      writeResult: { submitted: false, submissionDisposition: 'untouched' },
    });
    await hUntouched.flush();
    expect(hUntouched.ackMessages()).toEqual([]);
    expect(hUntouched.queuedActivationReceipts.size()).toBe(0);
    expect(hUntouched.scope.pendingMessages.map((m: any) => m.queuedActivationToken))
      .toContain('tok-act-001');

    // TRAE quarantined draft with unattributed recheck (cliSessionId=undefined):
    // activation ACK still settles once (for daemon tail), while worker quarantine
    // remains held until an owned cliSessionId arrives (without duplicating ACK).
    const quarantine = { turnId: 'om_traex_q', generation: 7 };
    const traexRecheck = vi.fn()
      .mockResolvedValueOnce({ submitted: true })
      .mockResolvedValueOnce({ submitted: true })
      .mockResolvedValue({ submitted: true, cliSessionId: 'owned-traex-sid' });
    const hTraex = createActivationSubmitHarness({
      cliId: 'traex',
      quarantine: true,
      item: {
        turnId: 'om_traex_q',
        content: 'traex quarantined opening',
        queuedActivationToken: 'tok-traex-q',
      },
      writeResult: { submitted: false, recheck: traexRecheck },
    });
    let activeQuarantine: typeof quarantine | null = null;
    hTraex.scope.armInputDeliveryQuarantine = vi.fn(() => {
      activeQuarantine = quarantine;
      return quarantine;
    });
    hTraex.scope.currentInputDeliveryQuarantine = () => activeQuarantine;
    await hTraex.flush();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(hTraex.ackMessages()).toEqual([{
      type: 'queued_activation_submitted',
      sessionId: 'sess-3748',
      activationToken: 'tok-traex-q',
    }]);
    // Quarantine MUST NOT be released by the unattributed receipt yet.
    expect(hTraex.scope.releaseInputDeliveryQuarantine).not.toHaveBeenCalled();

    // Next poll brings owned cliSessionId -> releases quarantine, still only 1 ACK total
    // and recordStructuredInput ran ONCE (skipped on the earlier unattributed poll)!
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hTraex.scope.releaseInputDeliveryQuarantine).toHaveBeenCalledTimes(1);
    expect(hTraex.scope.persistCliSessionId).toHaveBeenCalledWith('owned-traex-sid');
    expect(hTraex.scope.recordStructuredInput).toHaveBeenCalledTimes(1);
    expect(hTraex.ackMessages()).toHaveLength(1);
  });

  it('rejects short Claude substring matches ("ok"), foreign-session closed terminals, non-opening standalone botmux-send, and durable TRAE unattributed receipts', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-25T10:00:00.000Z');
    vi.setSystemTime(now);

    // 1. Short prompt "ok" must NOT settle when unrelated terminal input contains "ok".
    const hShort = createActivationSubmitHarness({
      cliId: 'claude-code',
      item: { turnId: 'om_short', content: 'ok', queuedActivationToken: 'tok-short' },
    });
    await hShort.flush();
    hShort.bridgeQueue.ingest([{
      type: 'user',
      uuid: 'u-unrelated-ok',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'do not click ok yet, abort deployment first' },
    }], '/tmp/claude-proj/11111111-2222-3333-4444-555555555555.jsonl');
    expect(hShort.bridgeQueue.peek()[0]).toMatchObject({ fullContentMatch: true, exactContentMatch: false });
    expect(hShort.ackMessages()).toEqual([]);

    // 2. Foreign-session closed terminal in CodexBridgeQueue is rejected by hasExactTerminalTurn.
    const hForeign = createActivationSubmitHarness({
      cliId: 'codex',
      item: { turnId: 'om_foreign', dispatchAttempt: 1, content: 'check foreign session isolation', queuedActivationToken: 'tok-foreign' },
    });
    hForeign.scope.inputDeliveryObservedCliSessionId = 'owned-sid';
    await hForeign.flush();
    hForeign.codexQueue.ingest([
      { kind: 'user', uuid: 'fu1', timestampMs: now + 100, sourceSessionId: 'sibling-sid', sourceTurnId: 'nt-f', text: 'check foreign session isolation' },
      { kind: 'assistant_final', uuid: 'ff1', timestampMs: now + 200, sourceSessionId: 'sibling-sid', sourceTurnId: 'nt-f', text: 'done' },
    ]);
    expect(hForeign.codexQueue.hasExactTerminalTurn('om_foreign', 1, 'owned-sid')).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hForeign.ackMessages()).toEqual([]);

    // 3. Promoted tail Turn 2 (cliGenerationTurnWrites >= 2) cannot settle via standalone botmux-send.
    const hTurn2 = createActivationSubmitHarness({
      cliId: 'claude-code',
      item: { turnId: 'om_turn_2', content: 'second promoted turn body', queuedActivationToken: 'tok-turn-2' },
    });
    hTurn2.scope.cliGenerationTurnWrites = 1; // Turn 1 already wrote in this CLI generation
    await hTurn2.flush();
    hTurn2.sendMarkers.push({
      sentAtMs: Date.now() + 500,
      sessionId: 'sess-3748',
      turnId: 'om_turn_2',
      deliveryKind: 'direct',
      responseKind: 'final',
      contentHash: 'h',
      contentPreview: 'leaked from turn 1',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hTurn2.ackMessages()).toEqual([]);
    expect(hTurn2.notifyMessages()).toHaveLength(1);

    // 4. Durable TRAE quarantine (dispatchAttempt=1) rejects unattributed sibling recheck completely.
    const durableQ = { turnId: 'om_traex_durable', generation: 7 };
    let activeDurableQ: typeof durableQ | null = null;
    const durableRecheck = vi.fn().mockResolvedValue({ submitted: true }); // no cliSessionId / ownershipProven
    const hDurableTraex = createActivationSubmitHarness({
      cliId: 'traex',
      quarantine: true,
      item: {
        turnId: 'om_traex_durable',
        dispatchAttempt: 1,
        content: 'durable traex opening',
        queuedActivationToken: 'tok-traex-durable',
      },
      writeResult: { submitted: false, recheck: durableRecheck },
    });
    hDurableTraex.scope.armInputDeliveryQuarantine = vi.fn(() => { activeDurableQ = durableQ; return durableQ; });
    hDurableTraex.scope.currentInputDeliveryQuarantine = () => activeDurableQ;
    await hDurableTraex.flush();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(hDurableTraex.ackMessages()).toEqual([]);
    expect(hDurableTraex.scope.releaseInputDeliveryQuarantine).not.toHaveBeenCalled();
  });
});

describe('#3748 Hardened Boundaries: Dashboard turnId=undefined, late >20s manual submit, recheck priority, Cursor/TraeX/Claude wrappers, dirty_unknown, throw, and daemon close/detach', () => {
  it('settles Dashboard queued activation (item.turnId=undefined) via synthesized bridgeTurnId, keeps bridge mark past 20s warning for late submit, and prefers recheck() over probeEvidence()', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-25T10:00:00.000Z');
    vi.setSystemTime(now);

    // Dashboard activation omits item.turnId; bridgeMarkPendingTurn synthesizes bridgeTurnId.
    const hDash = createActivationSubmitHarness({
      cliId: 'claude-code',
      item: {
        turnId: undefined,
        content: 'dashboard queued backlog opening prompt',
        queuedActivationToken: 'tok-dash-1',
      },
      writeResult: { submitted: false },
    });
    await hDash.flush();
    expect(hDash.queuedActivationReceipts.size()).toBe(1);
    expect(hDash.scope.cliInputBacklog()).toEqual({ pending: true });

    // At 20s, warning fires, but bridge mark MUST stay alive while queuedActivationReceipts watches!
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hDash.notifyMessages()).toHaveLength(1);
    expect(hDash.scope.dropFailedBridgeMark).not.toHaveBeenCalled();
    expect(hDash.bridgeQueue.peek()).toHaveLength(1);

    // At 25s, user manually presses Enter in Web terminal -> full user record settles ACK once!
    hDash.bridgeQueue.ingest([{
      type: 'user',
      uuid: 'u-dash-late',
      timestamp: new Date(now + 25_000).toISOString(),
      message: { role: 'user', content: 'dashboard queued backlog opening prompt' },
    }], '/tmp/claude-proj/22222222-3333-4444-5555-666666666666.jsonl');
    expect(hDash.ackMessages()).toEqual([{
      type: 'queued_activation_submitted',
      sessionId: 'sess-3748',
      activationToken: 'tok-dash-1',
    }]);
    expect(hDash.scope.cliInputBacklog()).toEqual({ pending: false });

    // Observer poll() must call recheck() BEFORE probeEvidence() so cliSessionId is never dropped.
    const observer = createQueuedActivationReceiptObserver(20);
    const recheck = vi.fn(async () => ({ submitted: true, cliSessionId: 'recheck-sid', ownershipProven: true }));
    const probeEvidence = vi.fn(() => ({ source: 'botmux-send' as const }));
    const onSettled = vi.fn();
    observer.watch('tok-prio', { recheck, probeEvidence, isCurrent: () => true, onSettled });
    await vi.advanceTimersByTimeAsync(20);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(probeEvidence).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({
      source: 'adapter-recheck',
      cliSessionId: 'recheck-sid',
      ownershipProven: true,
    }));
  });

  it('handles dirty_unknown, post-write throw without blind replay, bookkeeping exception resilience, Cursor <user_query>, Claude <botmux_task>, and TraeX /skill catalog hash', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-25T10:00:00.000Z');
    vi.setSystemTime(now);

    // 1. dirty_unknown arms read-only observer + warning instead of silently wedging.
    const hDirty = createActivationSubmitHarness({
      cliId: 'dsh',
      item: { turnId: 'om_dirty', content: 'dsh runner opening', queuedActivationToken: 'tok-dirty' },
      writeResult: { submitted: false, submissionDisposition: 'dirty_unknown' },
    });
    await hDirty.flush();
    expect(hDirty.queuedActivationReceipts.size()).toBe(1);
    hDirty.sendMarkers.push({
      sentAtMs: now + 1_000,
      sessionId: 'sess-3748',
      turnId: 'om_dirty',
      deliveryKind: 'direct',
      responseKind: 'final',
      contentHash: 'h',
      contentPreview: 'dsh ran',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hDirty.ackMessages()).toEqual([{
      type: 'queued_activation_submitted',
      sessionId: 'sess-3748',
      activationToken: 'tok-dirty',
    }]);

    // 2. Post-prepareNormalWrite writeInput throw does NOT blind-replay into pendingMessages.
    const hThrow = createActivationSubmitHarness({
      cliId: 'claude-code',
      item: { turnId: 'om_throw', content: 'throw after write start', queuedActivationToken: 'tok-throw' },
    });
    hThrow.scope.cliAdapter.writeInput = vi.fn(async () => { throw new Error('EIO mid-write'); });
    await hThrow.flush();
    expect(hThrow.scope.pendingMessages).toEqual([]);
    expect(hThrow.queuedActivationReceipts.size()).toBe(1);

    // 3. Exception inside recordStructuredInput still emits queued_activation_submitted via finally.
    const hErr = createActivationSubmitHarness({
      cliId: 'claude-code',
      item: { turnId: 'om_err', content: 'bookkeeping error resilience', queuedActivationToken: 'tok-err' },
    });
    hErr.scope.recordStructuredInput = vi.fn(() => { throw new Error('disk full'); });
    await hErr.flush();
    hErr.bridgeQueue.ingest([{
      type: 'user',
      uuid: 'u-err',
      timestamp: new Date(now + 500).toISOString(),
      message: { role: 'user', content: 'bookkeeping error resilience' },
    }], '/tmp/claude-proj/33333333-4444-5555-6666-777777777777.jsonl');
    expect(hErr.ackMessages()).toEqual([{
      type: 'queued_activation_submitted',
      sessionId: 'sess-3748',
      activationToken: 'tok-err',
    }]);

    // 4. Cursor <user_query> unwrap, Claude <botmux_task> fingerprint, TraeX /skill catalog hash, and rebind observer.
    expect(unwrapCursorUserInput('<user_query>\nhello\n<user_query>literal</user_query>\n</user_query>'))
      .toBe('hello\n<user_query>literal</user_query>');
    expect(extractMessageContentForFingerprint(
      '<user_message>\n<botmux_task trusted="true">\nDeploy service A\n</botmux_task>\n</user_message>',
    )).toBe('Deploy service A');

    const traexQ = new CodexBridgeQueue();
    const observed: Array<{ turnId: string; exact?: boolean }> = [];
    traexQ.setTurnStartObserver((t, ev) => observed.push({ turnId: t.turnId, exact: ev?.exactUserInputMatch }));
    traexQ.mark(
      'om_skill',
      '/review src/worker.ts',
      now,
      undefined,
      undefined,
      undefined,
      false,
      '/review src/worker.ts\n\n<botmux_builtin_skills>catalog</botmux_builtin_skills>',
    );
    traexQ.ingest([{
      kind: 'user',
      uuid: 'skill-u1',
      timestampMs: now + 100,
      sourceSessionId: 'traex-s1',
      text: 'expanded prompt body',
      inputTextAliases: ['/review src/worker.ts\n\n<botmux_builtin_skills>catalog</botmux_builtin_skills>'],
    }]);
    expect(traexQ.peek()[0]).toMatchObject({ started: true, exactUserInputMatch: true });
    expect(observed).toEqual([{ turnId: 'om_skill', exact: true }]);
  });

  it('reconciles two-step half-completed daemon ACK on worker detach, blocks post-close tail mutation, and clears stale Aggregator fields across close+resume', () => {
    // 1. Half-completed ACK: queuedActivationPending=undefined, tail=[M2], worker detaches.
    const d = createDaemonActivationHarness();
    const r2 = workerPool.reserveQueuedActivationTailAdmission(d.ds);
    workerPool.admitQueuedActivationTail(d.ds, {
      userPrompt: 'tail M2',
      cliInput: { content: 'tail M2' },
      turnId: 'om_half_m2',
    }, r2);
    d.ds.session.queuedActivationPending = undefined;
    d.ds.session.queuedActivationToken = undefined;
    sessionStore.updateSession(d.ds.session);

    workerPool.reconcileQueuedActivationOnWorkerDetach(d.ds);
    expect(d.ds.initialStartPending).toBe(false);
    expect(d.disk().queuedActivationPending).toBe(true);
    expect(d.disk().queuedActivationTurnId).toBe('om_half_m2');
    expect(d.disk().queuedActivationTail).toBeUndefined();

    // 2. Closed session refuses admitQueuedActivationTail & promoteQueuedActivationTail.
    d.ds.session.status = 'closed';
    expect(workerPool.admitQueuedActivationTail(d.ds, {
      userPrompt: 'post-close',
      cliInput: { content: 'post-close' },
      turnId: 'om_post_close',
    })).toBeUndefined();
    expect(workerPool.promoteQueuedActivationTail(d.ds, { send: false })).toBe(false);

    // 3. Aggregator clears queuedActivationPending & queuedActivationTailCount on publishClosedSessionPatch and session.exited.
    const agg = new Aggregator();
    agg.applyEvent('cli_a', {
      type: 'session.spawned',
      body: {
        session: {
          sessionId: 's-agg-1',
          status: 'idle',
          queued: false,
          queuedActivationPending: true,
          queuedActivationTailCount: 2,
        } as any,
      },
    });
    const events: any[] = [];
    const unsub = dashboardEventBus.subscribe(ev => events.push(ev));
    publishClosedSessionPatch('s-agg-1', 123456);
    unsub();
    expect(events).toHaveLength(1);
    agg.applyEvent('cli_a', events[0]);
    const afterClose = agg.getSessions().find(s => s.sessionId === 's-agg-1') as any;
    expect(afterClose.queuedActivationPending).toBeNull();
    expect(afterClose.queuedActivationTailCount).toBeNull();

    agg.applyEvent('cli_a', {
      type: 'session.spawned',
      body: {
        session: {
          sessionId: 's-agg-2',
          status: 'idle',
          queued: false,
          queuedActivationPending: true,
          queuedActivationTailCount: 1,
        } as any,
      },
    });
    agg.applyEvent('cli_a', { type: 'session.exited', body: { sessionId: 's-agg-2' } });
    const afterExit = agg.getSessions().find(s => s.sessionId === 's-agg-2') as any;
    expect(afterExit.queuedActivationPending).toBeNull();
    expect(afterExit.queuedActivationTailCount).toBeNull();

    // 4. hasQueuedActivationAdmissionGate respects ds.pendingFollowUps.
    const dFollow = createDaemonActivationHarness();
    dFollow.ds.session.queuedActivationPending = undefined;
    dFollow.ds.session.queuedActivationToken = undefined;
    dFollow.ds.session.queuedActivationTail = undefined;
    dFollow.ds.pendingFollowUps = ['buffered follow-up'];
    expect(workerPool.hasQueuedActivationAdmissionGate(dFollow.ds)).toBe(true);
  });
});

describe('#3748 Scenario 3: hard failure branch settles refused activation once and unblocks tail', () => {
  it('notifies user and settles queued_activation_submitted once on explicit failureReason without recording structured input', async () => {
    const h = createActivationSubmitHarness({
      cliId: 'codex',
      item: {
        turnId: 'om_refused_1',
        content: 'opening blocked by draft',
        queuedActivationToken: 'tok-refused-1',
      },
      writeResult: {
        submitted: false,
        failureReason: 'Codex has an existing draft; no message was written.',
      },
    });
    await h.flush();

    expect(h.notifyMessages()).toHaveLength(1);
    expect(h.notifyMessages()[0].message).toBe('worker.submit_impossible');
    expect(h.scope.recordStructuredInput).not.toHaveBeenCalled();
    expect(h.queuedActivationReceipts.size()).toBe(0);
    expect(h.ackMessages()).toEqual([{
      type: 'queued_activation_submitted',
      sessionId: 'sess-3748',
      activationToken: 'tok-refused-1',
    }]);
  });
});

describe('#3748 Scenario 4: late ACK after worker generation swap / close / killWorker is safely fenced', () => {
  it('worker fences cross-generation transcript/deferred confirmations and discards late rechecks after generation bump', async () => {
    vi.useFakeTimers();
    let resolveOld!: (v: boolean) => void;
    const h = createActivationSubmitHarness({
      cliId: 'claude-code',
      writeResult: {
        submitted: false,
        recheck: vi.fn(() => new Promise<boolean>(resolve => { resolveOld = resolve; })),
      },
    });
    await h.flush();
    await vi.advanceTimersByTimeAsync(20_000);

    // Simulate in-worker CLI restart: bump generation and clear observers.
    h.scope.cliSpawnGeneration += 1;
    h.queuedActivationReceipts.clear();
    h.submitFailureChains.clear();

    // Old recheck resolves true AND stale confirmToken arrives for old generation.
    resolveOld(true);
    expect(h.queuedActivationReceipts.confirmToken(
      'tok-act-001',
      { source: 'structured-transcript' },
      { generation: 7, turnId: 'om_turn_1' },
    )).toBe(false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.ackMessages()).toEqual([]);

    // Token was NOT settled in old generation, so new generation can still watch & settle it.
    const onNewSettled = vi.fn();
    expect(h.queuedActivationReceipts.watch('tok-act-001', {
      sessionId: 'sess-3748',
      generation: h.scope.cliSpawnGeneration,
      turnId: 'om_turn_1',
      isCurrent: () => true,
      onSettled: onNewSettled,
    })).toBe(true);
    expect(h.queuedActivationReceipts.confirmByTurn(
      { sessionId: 'sess-3748', generation: h.scope.cliSpawnGeneration - 1, turnId: 'om_turn_1' },
      { source: 'structured-transcript' },
    )).toBe(0);
    expect(h.queuedActivationReceipts.confirmByTurn(
      { sessionId: 'sess-3748', generation: h.scope.cliSpawnGeneration, turnId: 'om_turn_1' },
      { source: 'structured-transcript' },
    )).toBe(1);
    expect(onNewSettled).toHaveBeenCalledTimes(1);
  });

  it('daemon ignores late queued_activation_submitted from an older worker generation (even with the SAME activationToken) and aborts sleeping retry timers on generation swap or close', async () => {
    vi.useFakeTimers();
    const d = createDaemonActivationHarness();
    const r2 = workerPool.reserveQueuedActivationTailAdmission(d.ds);
    workerPool.admitQueuedActivationTail(d.ds, {
      userPrompt: 'tail turn after respawn',
      cliInput: { content: 'tail turn after respawn' },
      turnId: 'om_tail_after_respawn',
    }, r2);

    // Replacement worker spawns at generation 2 reusing the SAME queuedActivationToken.
    const gen1Worker = d.worker;
    const gen1 = 1;
    const gen2Worker: any = new EventEmitter();
    Object.assign(gen2Worker, { pid: 54321, killed: false, connected: true, send: vi.fn(() => true), kill: vi.fn() });
    d.ds.worker = gen2Worker;
    d.ds.workerGeneration = 2;
    d.ds.session.workerGeneration = 2;
    sessionStore.updateSession(d.ds.session);

    const ownsGen1 = () => d.ds.worker === gen1Worker
      && d.ds.workerGeneration === gen1
      && d.ds.session.workerGeneration === gen1
      && d.ds.session.status === 'active';

    // Late ACK from gen1 carrying the exact same token is safely ignored.
    const accepted = await workerPool.handleQueuedActivationSubmittedAck({
      ds: d.ds,
      msg: { sessionId: d.session.sessionId, activationToken: 'tok-act-001' },
      tag: d.session.sessionId.slice(0, 8),
      ownsLifecycleMutation: ownsGen1,
      updateSession: s => sessionStore.updateSession(s),
      onQueuedActivationSubmitted: vi.fn(() => true),
    });
    expect(accepted).toBe(false);
    expect(d.disk().queuedActivationPending).toBe(true);
    expect(d.disk().queuedActivationTail?.map(e => e.turnId))
      .toEqual(['om_tail_after_respawn']);
    expect(d.ds.initialStartPending).toBe(true);

    // Sleeping SQLite persistActivationAck retry from gen2 must abort cleanly if session is closed or generation bumps mid-backoff.
    let failFirstPersist = true;
    sessionStore.__testOnly_setBeforeRowPersist(() => {
      if (failFirstPersist) {
        failFirstPersist = false;
        throw new Error('transient SQLITE_BUSY');
      }
    });
    let gen2Alive = true;
    const onSubmitted = vi.fn(() => true);
    const firstAttempt = await workerPool.handleQueuedActivationSubmittedAck({
      ds: d.ds,
      msg: { sessionId: d.session.sessionId, activationToken: 'tok-act-001' },
      tag: d.session.sessionId.slice(0, 8),
      ownsLifecycleMutation: () => gen2Alive && d.ds.session.status === 'active',
      updateSession: s => sessionStore.updateSession(s),
      onQueuedActivationSubmitted: onSubmitted,
    });
    expect(firstAttempt).toBe(false);
    expect(d.disk().queuedActivationPending).toBe(true);

    // Generation swaps before the 100ms retry fires.
    gen2Alive = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(d.disk().queuedActivationPending).toBe(true);
    expect(d.ds.initialStartPending).toBe(true);
  });

  it('killWorker and retireWorkerProcessOnly release initialStartPending when queuedActivationPending is true so recovery refork is never wedged', () => {
    const d1 = createDaemonActivationHarness();
    workerPool.killWorker(d1.ds);
    expect(d1.ds.worker).toBeNull();
    expect(d1.ds.initialStartPending).toBe(false);
    expect(d1.ds.initialStartClaimToken).toBeUndefined();
    expect(d1.ds.session.queuedActivationPending).toBe(true);

    const d2 = createDaemonActivationHarness();
    workerPool.retireWorkerProcessOnly(d2.ds, 'test_retire');
    expect(d2.ds.worker).toBeNull();
    expect(d2.ds.initialStartPending).toBe(false);
    expect(d2.ds.initialStartClaimToken).toBeUndefined();
    expect(d2.ds.session.queuedActivationPending).toBe(true);
  });
});

describe('queued activation review fixes: detach recovery and evidence provenance', () => {
  function tailOnlyAfterAck() {
    const d = createDaemonActivationHarness();
    workerPool.admitQueuedActivationTail(d.ds, {
      userPrompt: 'tail M2', cliInput: { content: 'tail M2' }, turnId: 'om_tail_m2',
    }, workerPool.reserveQueuedActivationTailAdmission(d.ds));
    Object.assign(d.ds.session, {
      queuedActivationPending: undefined,
      queuedActivationToken: undefined,
      queuedActivationInput: undefined,
      queuedActivationTurnId: undefined,
      queuedActivationDispatchAttempt: undefined,
      queuedActivationResume: undefined,
      queued: false,
    });
    sessionStore.updateSession(d.ds.session);
    d.ds.initialStartPending = true;
    d.ds.initialStartClaimToken = 'claim-before-detach';
    return d;
  }

  it('keeps the initial-start recovery gate after a transient detach promotion failure', () => {
    const d = tailOnlyAfterAck();
    let failOnce = true;
    sessionStore.__testOnly_setBeforeRowPersist(() => {
      if (failOnce) { failOnce = false; throw new Error('transient promotion failure'); }
    });
    expect(() => workerPool.reconcileQueuedActivationOnWorkerDetach(d.ds)).not.toThrow();
    expect(d.ds.initialStartPending).toBe(true);
    expect(d.ds.initialStartClaimToken).toBe('claim-before-detach');
    expect(d.ds.quarantinedActivationTailPromotion).toBe(true);
    expect(d.disk().queuedActivationTail?.map(entry => entry.turnId)).toEqual(['om_tail_m2']);

    // The next inbound uses blank recovery after staging its own tail entry.
    // A healthy store must now promote the retained old head exactly once.
    const plan = workerPool.resolveQuarantinedForkPlan(d.ds, '', true);
    expect(plan.fork).toBe(true);
    expect(d.ds.quarantinedActivationTailPromotion).toBeUndefined();
    expect(d.ds.session.queuedActivationPending).toBe(true);
    expect(d.ds.session.queuedActivationInput?.content).toBe('tail M2');
  });

  it('contains a detach promotion exception without losing the retryable tail or gate', () => {
    const d = tailOnlyAfterAck();
    vi.mocked(bots.getBot).mockImplementation(() => { throw new Error('transient registry reload'); });
    expect(() => workerPool.reconcileQueuedActivationOnWorkerDetach(d.ds)).not.toThrow();
    expect(d.ds.initialStartPending).toBe(true);
    expect(d.ds.initialStartClaimToken).toBe('claim-before-detach');
    expect(d.ds.quarantinedActivationTailPromotion).toBe(true);
    expect(d.ds.session.queuedActivationTail?.map(entry => entry.turnId)).toEqual(['om_tail_m2']);
  });

  it('uses the corrected owned session id when rebind lands before the adapter write returns', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-25T12:00:00.000Z');
    vi.setSystemTime(now);
    let resolveWrite!: (value: Record<string, unknown>) => void;
    const writeResult = new Promise<Record<string, unknown>>(resolve => { resolveWrite = resolve; });
    const h = createActivationSubmitHarness({
      cliId: 'antigravity',
      item: {
        turnId: 'om_rebind_before_watch', dispatchAttempt: 1,
        content: 'exact rebind input', queuedActivationToken: 'tok-rebind-before-watch',
      },
    });
    h.scope.cliAdapter.writeInput = vi.fn(() => writeResult);
    h.scope.armAntigravityCotForTurn = vi.fn();
    const flushing = h.flush();
    for (let i = 0; i < 50 && h.codexQueue.peek().length === 0; i++) await Promise.resolve();
    expect(h.codexQueue.peek()).toHaveLength(1);

    h.codexQueue.ingest([{
      kind: 'user', uuid: 'sibling-user', timestampMs: now + 100,
      sourceSessionId: 'sibling-session', sourceTurnId: 'native-turn', text: 'exact rebind input',
    }]);
    // The startup observer publishes the corrected identity before rebind.
    h.scope.persistCliSessionId('owned-session');
    h.scope.inputDeliveryObservedCliSessionId = 'owned-session';
    expect(h.codexQueue.rebindStartedTurnToUser('om_rebind_before_watch', {
      kind: 'user', uuid: 'owned-user', timestampMs: now + 200,
      sourceSessionId: 'owned-session', sourceTurnId: 'native-turn', text: 'exact rebind input',
    })).toBe(true);

    for (let i = 0; i < 50 && h.scope.cliAdapter.writeInput.mock.calls.length === 0; i++) await Promise.resolve();
    resolveWrite({ submitted: false, recheck: async () => false });
    await flushing;
    expect(h.ackMessages()).toHaveLength(1);
    expect(h.scope.persistCliSessionId.mock.calls.at(-1)?.[0]).toBe('owned-session');
  });

  it('keeps standalone send proof eligible after a proven untouched opening write', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-25T13:00:00.000Z');
    vi.setSystemTime(now);
    const h = createActivationSubmitHarness({
      cliId: 'dsh',
      item: {
        turnId: 'om_untouched_retry', content: 'retry after a clean refusal',
        queuedActivationToken: 'tok-untouched-retry',
      },
      writeResult: { submitted: false, submissionDisposition: 'untouched' },
    });
    await h.flush();
    expect(h.scope.pendingMessages).toHaveLength(1);
    expect(h.queuedActivationReceipts.size()).toBe(0);

    h.scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: false }));
    await h.flush();
    expect(h.queuedActivationReceipts.size()).toBe(1);
    h.sendMarkers.push({
      sentAtMs: now + 1_000, sessionId: 'sess-3748', turnId: 'om_untouched_retry',
      deliveryKind: 'direct', responseKind: 'final', contentHash: 'h', contentPreview: 'done',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.ackMessages()).toHaveLength(1);
    expect(h.queuedActivationReceipts.size()).toBe(0);
  });

  it('rejects an exact user record drained from an already-retired secondary transcript', async () => {
    vi.useFakeTimers();
    const h = createActivationSubmitHarness({
      cliId: 'claude-code',
      item: {
        turnId: 'om_new_activation', content: 'repeat the same exact request',
        queuedActivationToken: 'tok-retired-path',
      },
    });
    await h.flush();
    h.scope.bridgeSecondaryPaths.set('/tmp/claude-proj/retired-secondary.jsonl', 123);
    h.scope.bridgeJsonlPath = '/tmp/claude-proj/current-owned.jsonl';
    h.bridgeQueue.ingest([{
      type: 'user', uuid: 'delayed-old-user', timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'repeat the same exact request' },
    }], '/tmp/claude-proj/retired-secondary.jsonl');
    expect(h.ackMessages()).toEqual([]);
    expect(h.queuedActivationReceipts.size()).toBe(1);
    expect(h.inputDeliveryEvidence.authoritativeReceipt({
      turnId: 'om_new_activation', cliGeneration: h.scope.cliSpawnGeneration,
    })).toBeUndefined();
  });

  it('keeps retained Claude evidence valid when rotation happens after observation', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-11-25T14:00:00.000Z');
    vi.setSystemTime(now);
    let resolveWrite!: (value: Record<string, unknown>) => void;
    const writeResult = new Promise<Record<string, unknown>>(resolve => { resolveWrite = resolve; });
    const oldPath = '/tmp/claude-proj/retired-retained.jsonl';
    const h = createActivationSubmitHarness({
      cliId: 'claude-code',
      item: {
        turnId: 'om_retained_rotation', content: 'exact retained input',
        queuedActivationToken: 'tok-retained-rotation',
      },
    });
    h.scope.bridgeJsonlPath = oldPath;
    h.scope.cliAdapter.writeInput = vi.fn(() => writeResult);
    const flushing = h.flush();
    for (let i = 0; i < 50 && h.bridgeQueue.peek().length === 0; i++) await Promise.resolve();
    h.bridgeQueue.ingest([{
      type: 'user', uuid: 'retained-user', timestamp: new Date(now + 100).toISOString(),
      message: { role: 'user', content: 'exact retained input' },
    }], oldPath);
    expect(h.inputDeliveryEvidence.authoritativeReceipt({
      turnId: 'om_retained_rotation', cliGeneration: h.scope.cliSpawnGeneration,
    })?.sourceJsonlPath).toBe(oldPath);

    h.scope.bridgeSecondaryPaths.set(oldPath, 123);
    h.scope.bridgeJsonlPath = '/tmp/claude-proj/current-after-rotation.jsonl';
    for (let i = 0; i < 50 && h.scope.cliAdapter.writeInput.mock.calls.length === 0; i++) await Promise.resolve();
    resolveWrite({ submitted: false, recheck: async () => false });
    await flushing;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.ackMessages()).toHaveLength(1);
    expect(h.queuedActivationReceipts.size()).toBe(0);
  });
});
