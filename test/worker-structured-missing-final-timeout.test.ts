import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CodexBridgeQueue, type CodexPendingTurn } from '../src/services/codex-bridge-queue.js';
import { appendBridgeTurnJournalEntry, readBridgeTurnJournal, stageBridgeTurnNotice, acknowledgeBridgeTurnNotice } from '../src/services/bridge-turn-journal.js';
import { checkpointCodexAdoptTurns, restoreCodexAdoptTurns } from '../src/services/codex-adopt-recovery.js';
import { RECOVERY_NOTICE_MAX_AGE_MS } from '../src/services/ordinary-recovery-notice.js';
import { StructuredMissingFinalWatchdog } from '../src/services/structured-missing-final.js';
import { commitDoubaoExportMode, doubaoExportOwnsTerminals } from '../src/services/doubao-export-recovery.js';
import { PtyOutputGeneration } from '../src/utils/runtime-screen-status.js';
import {
  attributableBridgeReplyMarkers,
  bridgeGateInputForTurn,
  finalBridgeSendMarkerCoversOwnThread,
  type BridgeSendMarker,
} from '../src/services/bridge-fallback-gate.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const rigDirs: string[] = [];

function workerRig(cliId = 'codex', opts: { attempt?: number; delivery?: 'send' | 'transcript'; zeroPrompt?: boolean; nativeIdentity?: boolean; provisionalStart?: boolean; deferStart?: boolean; ack?: boolean } = {}) {
  let now = 0;
  const queue = new CodexBridgeQueue(() => now);
  queue.mark('om_turn', 'question', now, opts.attempt);
  const rigDir = mkdtempSync(join(tmpdir(), 'missing-final-rig-'));
  rigDirs.push(rigDir);
  const journalPath = join(rigDir, 'turns.structured');
  if (opts.provisionalStart) {
    queue.ingest([{ uuid: 'native-task-started', timestampMs: now, kind: 'turn_started', text: '',
      sourceSessionId: 'provider', sourceTurnId: 'native-provisional',
    }]);
  } else if (!opts.deferStart) {
    queue.ingest([{ uuid: 'native-user-1', timestampMs: now, kind: 'user', text: 'question',
      ...(opts.nativeIdentity ? {
        sourceSessionId: 'provider', sourceTurnId: 'native-turn', sourceMessageId: 'message-old',
      } : {}),
    }]);
  }
  const scope: Record<string, any> = {
    config: { session: { dataDir: rigDir } },
    commitDoubaoExportMode,
    lastInitConfig: { cliId, replyDelivery: opts.delivery ?? 'transcript', adoptMode: false, chatId: 'oc_own', rootMessageId: 'om_root', larkAppId: 'app-own', ...(opts.ack === false ? {} : { structuredNoticeAck: true as const }) },
    replyDeliveryMode: () => opts.delivery ?? 'transcript',
    zeroPromptTerminalSync: () => opts.zeroPrompt === true,
    codexAdoptJournalPath: () => undefined,
    structuredBridgeJournalPath: () => journalPath,
    pendingMissingFinalNotices: new Map(),
    closeRequested: false,
    stageBridgeTurnNotice,
    acknowledgeBridgeTurnNotice,
    readBridgeTurnJournal,
    RECOVERY_NOTICE_MAX_AGE_MS,
    createHash,
    codexBridgeQueue: queue,
    codexBridgeRolloutPath: 'live-transcript',
    codexBridgeBaselineDone: true,
    rpcTranscriptIngestBlockedByAwaitingActivation: () => false,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    backgroundTaskTracker: { pendingTurnAgents: () => 0 },
    structuredBridgeIs: (id: string) => id === cliId,
    antigravityPendingRebind: false,
    antigravityBridgeState: () => ({}),
    hasAntigravityPendingTasks: () => false,
    idleDetector: {
      programStatusHeldBusy: () => false,
      programStatusActive: () => false,
      programStatusBlock: () => null,
    },
    cliAdapter: { busyPattern: /busy/ },
    tuiPromptBlocking: false,
    hookReviewInputHold: false,
    heldStuckPage: () => undefined,
    traexQuestionHoldsHeldInput: () => false,
    codexBridgePendingTail: '',
    ompBridgeState: () => ({}),
    isPromptReady: true,
    hasStructuredLifecycleBlock: () => false,
    structuredRejectedReadyEvidenceGeneration: undefined,
    structuredRejectedReadyEvidenceStartUuid: undefined,
    ptyOutputGeneration: new PtyOutputGeneration(),
    lastStructuredBridgeActivityAtMs: 0,
    cliSpawnGeneration: 1,
    rpcTurnsAwaitingActivation: new Map(),
    rpcLifecycleFailClosedOwners: new Map(),
    rpcTerminalHydrationOwners: new Map(),
    rpcActiveOwners: new Map(),
    settlingRpcTerminalOwners: new Map(),
    structuredTurnsWithSubmitNotice: new Set<string>(),
    structuredMissingFinalWatchdog: new StructuredMissingFinalWatchdog(),
    codexBridgeIngest: vi.fn(() => true),
    checkpointCodexAdoptRecovery: vi.fn(),
    checkpointStructuredBridgeRecovery: vi.fn(),
    dropPendingTurn: undefined,
    log: vi.fn(),
    emitTurnTerminal: vi.fn(),
    retireStructuredTurnAttribution: vi.fn(),
    send: vi.fn(),
    t: (key: string) => key,
    cliName: () => cliId,
    emitReadyCodexTurns: vi.fn(),
    redriveRejectedStructuredReady: vi.fn(),
    sessionId: 'sid-own',
    readSendMarkers: vi.fn((): BridgeSendMarker[] => []),
    attributableBridgeReplyMarkers,
    bridgeGateInputForTurn,
    finalBridgeSendMarkerCoversOwnThread,
  };
  scope.structuredRpcLifecycleOwnerActive = loadWorkerFunction('structuredRpcLifecycleOwnerActive', scope);
  scope.structuredMissingFinalHasLifecycleSignals = loadWorkerFunction('structuredMissingFinalHasLifecycleSignals', scope);
  scope.structuredMissingFinalBlockedByPage = loadWorkerFunction('structuredMissingFinalBlockedByPage', scope);
  scope.structuredMissingFinalTarget = loadWorkerFunction('structuredMissingFinalTarget', scope);
  scope.transmitMissingFinalNotice = loadWorkerFunction('transmitMissingFinalNotice', scope);
  scope.notifyMissingFinalTurn = loadWorkerFunction('notifyMissingFinalTurn', scope);
  scope.missingFinalTurnDeliveredBySend = loadWorkerFunction('missingFinalTurnDeliveredBySend', scope);
  const settle = loadWorkerFunction<() => void>('maybeSettleMissingStructuredFinal', scope);
  return { scope, queue, settle, rigDir, advance: (ms: number) => { now += ms; } };
}

function restoreStartedTurn(r: ReturnType<typeof workerRig>, markTimeMs: number): CodexPendingTurn {
  r.queue.clearPending();
  r.queue.restorePendingTurns([{ turnId: 'om_turn', fingerprint: 'question', markTimeMs }]);
  r.queue.ingest([{ uuid: 'restored-native-user', timestampMs: markTimeMs, kind: 'user', text: 'question' }]);
  const restored = r.queue.peek()[0]!;
  expect(restored).toMatchObject({ turnId: 'om_turn', started: true, restoredFromJournal: true, markTimeMs });
  return restored;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of rigDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('worker: missing structured final timeout', () => {
  it('keeps the Doubao owner and retries when its terminal-source barrier cannot be persisted', () => {
    const r = workerRig('doubao');
    r.scope.structuredMissingFinalWatchdog = new StructuredMissingFinalWatchdog(0);
    const barrier = join(r.rigDir, 'doubao-export');
    writeFileSync(barrier, 'not a directory');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1);
    r.settle(); clock.mockReturnValue(2); r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.send).not.toHaveBeenCalled();
    expect(doubaoExportOwnsTerminals(r.rigDir, 'live-transcript')).toBe(false);

    rmSync(barrier);
    clock.mockReturnValue(3); r.settle(); clock.mockReturnValue(4); r.settle();
    expect(doubaoExportOwnsTerminals(r.rigDir, 'live-transcript')).toBe(true);
    expect(r.queue.peek()).toEqual([]);
    expect(r.scope.send).toHaveBeenCalledOnce();
    expect(r.scope.emitTurnTerminal).toHaveBeenCalledOnce();
    r.settle();
    expect(r.scope.send).toHaveBeenCalledOnce();
  });

  it('retains the committed Doubao barrier through a partial notice write and finishes once on retry', () => {
    const r = workerRig('doubao');
    r.scope.structuredMissingFinalWatchdog = new StructuredMissingFinalWatchdog(0);
    r.scope.stageBridgeTurnNotice = vi.fn().mockImplementationOnce(() => { throw new Error('notice write unavailable'); })
      .mockImplementation(stageBridgeTurnNotice);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1);
    r.settle(); clock.mockReturnValue(2); r.settle();
    expect(doubaoExportOwnsTerminals(r.rigDir, 'live-transcript')).toBe(true);
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.send).not.toHaveBeenCalled();

    clock.mockReturnValue(3); r.settle(); clock.mockReturnValue(4); r.settle();
    expect(r.queue.peek()).toEqual([]);
    expect(r.scope.send).toHaveBeenCalledOnce();
    expect(r.scope.emitTurnTerminal).toHaveBeenCalledOnce();
    expect(doubaoExportOwnsTerminals(r.rigDir, 'live-transcript')).toBe(true);
  });

  it.each(['codex', 'doubao', 'grok'])('retires the same idle started head for %s with a Web-terminal notice', cliId => {
    const r = workerRig(cliId);
    vi.spyOn(Date, 'now').mockImplementation(() => 0);
    r.settle();
    vi.spyOn(Date, 'now').mockImplementation(() => 19_999);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.send).not.toHaveBeenCalled();
    vi.spyOn(Date, 'now').mockImplementation(() => 20_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
    expect(r.scope.send.mock.calls.map(([msg]) => msg)).toEqual([expect.objectContaining({
      type: 'user_notify', message: 'worker.structured_final_not_collected',
      kind: 'structured_turn_not_collected', turnId: 'om_turn', noticeId: expect.stringMatching(/^[a-f0-9]{32}$/),
    })]);
    expect(r.scope.retireStructuredTurnAttribution).toHaveBeenCalledOnce();
    expect(r.scope.emitReadyCodexTurns).toHaveBeenCalledOnce();
    expect(r.scope.redriveRejectedStructuredReady).toHaveBeenCalledOnce();
  });

  it('uses an ambiguous exact-attempt terminal for durable delivery without a duplicate IM notice', () => {
    const r = workerRig('codex', { attempt: 2 });
    vi.spyOn(Date, 'now').mockReturnValue(0);
    r.settle();
    vi.spyOn(Date, 'now').mockReturnValue(20_000);
    r.settle();
    expect(r.scope.emitTurnTerminal.mock.calls).toEqual([['om_turn', 'ambiguous', 'structured_final_not_collected', 2]]);
    expect(r.scope.send).not.toHaveBeenCalled();
  });

  it('does not run in send mode, after stop, or after a native final', () => {
    const send = workerRig('codex', { delivery: 'send' });
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    send.settle();
    clock.mockReturnValue(20_000);
    send.settle();
    expect(send.queue.peek()).toHaveLength(1);
    expect(send.scope.send).not.toHaveBeenCalled();

    const stopped = workerRig('doubao');
    vi.spyOn(Date, 'now').mockReturnValue(0);
    stopped.settle();
    expect(stopped.queue.dropPendingTurn('om_turn', undefined, true)).not.toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    stopped.settle();
    expect(stopped.scope.send).not.toHaveBeenCalled();

    const finished = workerRig('doubao');
    vi.spyOn(Date, 'now').mockReturnValue(0);
    finished.settle();
    finished.queue.ingest([{ uuid: 'native-final', timestampMs: 5_000, kind: 'assistant_final', text: 'done' }]);
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    finished.settle();
    expect(finished.queue.peek()[0]?.finalText).toBe('done');
    expect(finished.scope.send).not.toHaveBeenCalled();
  });

  it('keeps the owner and retries a fresh window when the deadline drain fails', () => {
    const r = workerRig('codex', { attempt: 2 });
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    r.settle();
    r.scope.codexBridgeIngest.mockImplementationOnce(() => { throw new Error('transient transcript read failure'); });
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.emitTurnTerminal).not.toHaveBeenCalled();
    expect(r.scope.send).not.toHaveBeenCalled();

    // The failed drain is not a negative terminal verdict. A later tick starts
    // a new full wait; only a successful drain lets the same owner retire.
    clock.mockReturnValue(20_001);
    r.settle();
    clock.mockReturnValue(39_999);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    clock.mockReturnValue(40_001);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
    expect(r.scope.emitTurnTerminal.mock.calls).toEqual([['om_turn', 'ambiguous', 'structured_final_not_collected', 2]]);
  });

  it('atomically stages a notice-only recovery owner before IPC under universal handoff', () => {
    const root = mkdtempSync(join(tmpdir(), 'missing-final-journal-'));
    try {
      const rolloutPath = join(root, 'rollout.jsonl');
      const journalPath = join(root, 'turns.structured');
      writeFileSync(rolloutPath, '');
      const r = workerRig('codex');
      const marked = r.queue.peek()[0]!;
      appendBridgeTurnJournalEntry(journalPath, {
        turnId: 'om_turn', markTimeMs: 0, fingerprint: marked.contentFingerprint,
        wholeInputHash: marked.wholeInputHash, jsonlPath: rolloutPath, offsetAtMark: 0,
      });
      Object.assign(r.scope, {
        workerSessionEventScope: undefined,
        universalOutputHandoff: { present: true },
        checkpointCodexAdoptRecovery: vi.fn(),
        traexQuotaPending: undefined,
        structuredBridgeJournalPath: () => journalPath,
        codexBridgeRolloutPath: rolloutPath,
        structuredBridgeRecoveryAttempted: true,
        codexBridgeOffset: 0,
        checkpointCodexAdoptTurns,
      });
      r.scope.checkpointStructuredBridgeRecovery = loadWorkerFunction('checkpointStructuredBridgeRecovery', r.scope);
      // Real ready emission sees no ready rows and returns early under handoff.
      r.scope.emitReadyCodexTurns = loadWorkerFunction('emitReadyCodexTurns', r.scope);
      const persistedAtNotice: string[] = [];
      r.scope.send.mockImplementation((msg: any) => {
        if (msg.kind === 'structured_turn_not_collected') {
          const persisted = readBridgeTurnJournal(journalPath);
          expect(persisted).toHaveLength(1);
          expect(persisted[0]?.pendingNotice?.noticeId).toBe(msg.noticeId);
          persistedAtNotice.push(msg.noticeId);
        }
      });
      const clock = vi.spyOn(Date, 'now');
      clock.mockReturnValue(0);
      r.settle();
      clock.mockReturnValue(20_000);
      r.settle();
      expect(persistedAtNotice).toHaveLength(1);
      expect(readBridgeTurnJournal(journalPath)[0]?.pendingNotice?.noticeId).toBe(persistedAtNotice[0]);

      // Restart recovery replays only the exact notice, never the business owner.
      const restoredQueue = new CodexBridgeQueue(() => Date.now());
      const recovered = restoreCodexAdoptTurns(journalPath, rolloutPath, restoredQueue, [{
        uuid: 'native-user-1', timestampMs: 0, kind: 'user', text: 'question',
      }], -5_000, 20_000);
      restoredQueue.absorb(recovered.history);
      restoredQueue.ingest(recovered.live);
      expect(recovered.restored).toBe(0);
      expect(restoredQueue.peek()).toEqual([]);
      r.scope.restoreMissingFinalNotices = loadWorkerFunction('restoreMissingFinalNotices', r.scope);
      r.scope.restoreMissingFinalNotices();
      const replay = r.scope.send.mock.calls.at(-1)![0];
      expect(replay.noticeId).toBe(persistedAtNotice[0]);
      expect(readBridgeTurnJournal(journalPath)[0]?.pendingNotice?.noticeId).toBe(persistedAtNotice[0]);
      r.scope.acknowledgeMissingFinalNotice = loadWorkerFunction('acknowledgeMissingFinalNotice', r.scope);
      r.scope.acknowledgeMissingFinalNotice('om_turn', persistedAtNotice[0]);
      expect(readBridgeTurnJournal(journalPath)).toEqual([]);
      expect(r.scope.pendingMissingFinalNotices.size).toBe(0);
      r.scope.restoreMissingFinalNotices();
      expect(r.scope.send.mock.calls.filter(([msg]) => msg.kind === 'structured_turn_not_collected')).toHaveLength(2);
      r.scope.codexBridgeQueue = restoredQueue;
      r.scope.structuredMissingFinalWatchdog = new StructuredMissingFinalWatchdog();
      clock.mockReturnValue(40_000);
      r.settle();
      expect(r.scope.send.mock.calls.filter(([msg]) => msg.kind === 'structured_turn_not_collected')).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the owner and retries a full window when the durable notice write fails', () => {
    const r = workerRig('codex');
    const stage = r.scope.stageBridgeTurnNotice;
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.scope.stageBridgeTurnNotice = vi.fn(() => { throw new Error('journal write failed'); });
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.send).not.toHaveBeenCalled();

    r.scope.stageBridgeTurnNotice = stage;
    clock.mockReturnValue(20_001);
    r.settle();
    clock.mockReturnValue(40_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    clock.mockReturnValue(40_001);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
    expect(r.scope.send.mock.calls.filter(([msg]) => msg.kind === 'structured_turn_not_collected')).toHaveLength(1);
  });

  it.each(['before-ipc', 'ipc-unknown', 'checkpoint-write'] as const)('retains exactly one replayable notice across %s failure', failure => {
    const r = workerRig('codex');
    const journalPath = r.scope.structuredBridgeJournalPath();
    const rolloutPath = join(rigDirs.at(-1)!, 'rollout.jsonl');
    writeFileSync(rolloutPath, '');
    const marked = r.queue.peek()[0]!;
    appendBridgeTurnJournalEntry(journalPath, {
      turnId: 'om_turn', markTimeMs: 0, fingerprint: marked.contentFingerprint,
      wholeInputHash: marked.wholeInputHash, jsonlPath: rolloutPath, offsetAtMark: 0,
    });
    const originalTransmit = r.scope.transmitMissingFinalNotice;
    const wire: any[] = [];
    r.scope.send.mockImplementation((msg: any) => {
      if (msg.kind !== 'structured_turn_not_collected') return;
      wire.push(msg);
      if (failure === 'ipc-unknown' && wire.length === 1) throw new Error('IPC result unknown');
    });
    if (failure === 'before-ipc') {
      r.scope.transmitMissingFinalNotice = () => { throw new Error('process died before IPC'); };
    }
    if (failure === 'checkpoint-write') {
      Object.assign(r.scope, {
        codexBridgeRolloutPath: rolloutPath, structuredBridgeRecoveryAttempted: true,
        codexBridgeOffset: 0, traexQuotaPending: undefined,
        checkpointCodexAdoptTurns: () => { throw new Error('checkpoint write failed'); },
      });
      r.scope.checkpointStructuredBridgeRecovery = loadWorkerFunction('checkpointStructuredBridgeRecovery', r.scope);
    }
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    if (failure === 'checkpoint-write') expect(() => r.settle()).toThrow('checkpoint write failed');
    else r.settle();
    if (failure === 'before-ipc') expect(r.queue.peek()).toHaveLength(1);
    else expect(r.queue.peek()).toEqual([]);

    const persisted = readBridgeTurnJournal(journalPath);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.pendingNotice?.noticeId).toMatch(/^[a-f0-9]{32}$/);
    const noticeId = persisted[0]!.pendingNotice!.noticeId;
    const restoredQueue = new CodexBridgeQueue(() => Date.now());
    const recovered = restoreCodexAdoptTurns(journalPath, rolloutPath, restoredQueue, [{
      uuid: 'native-user-1', timestampMs: 0, kind: 'user', text: 'question',
    }], -5_000, 20_000);
    expect(recovered.restored).toBe(0);
    expect(restoredQueue.peek()).toEqual([]);

    // New worker generation: no in-memory pending map or business owner survives.
    r.scope.pendingMissingFinalNotices = new Map();
    r.scope.codexBridgeQueue = restoredQueue;
    r.scope.transmitMissingFinalNotice = originalTransmit;
    r.scope.restoreMissingFinalNotices = loadWorkerFunction('restoreMissingFinalNotices', r.scope);
    r.scope.restoreMissingFinalNotices();
    expect(wire.at(-1)?.noticeId).toBe(noticeId);
    expect(wire).toHaveLength(failure === 'before-ipc' ? 1 : 2);
    expect(readBridgeTurnJournal(journalPath)[0]?.pendingNotice?.noticeId).toBe(noticeId);

    r.scope.acknowledgeMissingFinalNotice = loadWorkerFunction('acknowledgeMissingFinalNotice', r.scope);
    r.scope.acknowledgeMissingFinalNotice('om_turn', noticeId);
    expect(readBridgeTurnJournal(journalPath)).toEqual([]);
    expect(r.scope.pendingMissingFinalNotices.size).toBe(0);
    r.scope.restoreMissingFinalNotices();
    expect(wire).toHaveLength(failure === 'before-ipc' ? 1 : 2);
  });

  it('retains the pending notice when ACK cleanup cannot persist', () => {
    const r = workerRig('codex');
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    const msg = r.scope.send.mock.calls.map(([msg]) => msg)
      .find(msg => msg.kind === 'structured_turn_not_collected');
    const journalPath = r.scope.structuredBridgeJournalPath();
    const acknowledge = r.scope.acknowledgeBridgeTurnNotice;
    r.scope.acknowledgeMissingFinalNotice = loadWorkerFunction('acknowledgeMissingFinalNotice', r.scope);
    r.scope.acknowledgeBridgeTurnNotice = () => { throw new Error('ACK cleanup write failed'); };
    r.scope.acknowledgeMissingFinalNotice('om_turn', msg.noticeId);
    expect(r.scope.pendingMissingFinalNotices.size).toBe(1);
    expect(readBridgeTurnJournal(journalPath)[0]?.pendingNotice?.noticeId).toBe(msg.noticeId);

    r.scope.acknowledgeBridgeTurnNotice = acknowledge;
    r.scope.acknowledgeMissingFinalNotice('om_turn', msg.noticeId);
    expect(r.scope.pendingMissingFinalNotices.size).toBe(0);
    expect(readBridgeTurnJournal(journalPath)).toEqual([]);
  });

  it('keeps silent retirement non-restoring and completes cleanup across a strict checkpoint failure', () => {
    const r = workerRig('doubao');
    const journalPath = r.scope.structuredBridgeJournalPath();
    const rolloutPath = join(rigDirs.at(-1)!, 'rollout.jsonl');
    writeFileSync(rolloutPath, '');
    const marked = r.queue.peek()[0]!;
    appendBridgeTurnJournalEntry(journalPath, {
      turnId: 'om_turn', markTimeMs: 0, fingerprint: marked.contentFingerprint,
      wholeInputHash: marked.wholeInputHash, jsonlPath: rolloutPath, offsetAtMark: 0,
    });
    r.scope.readSendMarkers.mockReturnValue([{
      sentAtMs: 1, sessionId: 'sid-own', turnId: 'om_turn', responseKind: 'final',
      deliveryKind: 'current_session_send', targetChatId: 'oc_own', targetRootMessageId: 'om_root',
    }]);
    Object.assign(r.scope, {
      codexBridgeRolloutPath: rolloutPath, structuredBridgeRecoveryAttempted: true,
      codexBridgeOffset: 0, traexQuotaPending: undefined,
      checkpointCodexAdoptTurns: () => { throw new Error('silent checkpoint failed'); },
    });
    r.scope.checkpointStructuredBridgeRecovery = loadWorkerFunction('checkpointStructuredBridgeRecovery', r.scope);
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    expect(() => r.settle()).toThrow('silent checkpoint failed');
    expect(r.scope.retireStructuredTurnAttribution).toHaveBeenCalledOnce();
    expect(r.scope.emitReadyCodexTurns).toHaveBeenCalledOnce();
    const retired = r.scope.send.mock.calls.map(([msg]) => msg)
      .find(msg => msg.type === 'turn_display_retired');
    const retiredNoticeId = retired.noticeId;
    expect(retired).toMatchObject({ silent: true, noticeId: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect(readBridgeTurnJournal(journalPath)[0]?.pendingNotice).toMatchObject({ noticeId: retiredNoticeId, silent: true });

    const restoredQueue = new CodexBridgeQueue(() => Date.now());
    const recovered = restoreCodexAdoptTurns(journalPath, rolloutPath, restoredQueue, [{
      uuid: 'native-user-1', timestampMs: 0, kind: 'user', text: 'question',
    }], -5_000, 20_000);
    expect(recovered.restored).toBe(0);
    expect(restoredQueue.peek()).toEqual([]);
    r.scope.pendingMissingFinalNotices = new Map();
    r.scope.restoreMissingFinalNotices = loadWorkerFunction('restoreMissingFinalNotices', r.scope);
    r.scope.restoreMissingFinalNotices();
    expect(r.scope.send.mock.calls.at(-1)![0]).toMatchObject({
      type: 'turn_display_retired', noticeId: retiredNoticeId, silent: true,
    });
    r.scope.acknowledgeMissingFinalNotice = loadWorkerFunction('acknowledgeMissingFinalNotice', r.scope);
    expect([...r.scope.pendingMissingFinalNotices.keys()]).toEqual([retiredNoticeId]);
    expect([...r.scope.pendingMissingFinalNotices.values()][0]).toMatchObject({ path: journalPath });
    r.scope.acknowledgeMissingFinalNotice('om_turn', retiredNoticeId);
    expect(r.scope.log.mock.calls.flat().filter((line: unknown) => String(line).includes('ACK cleanup'))).toEqual([]);
    expect(r.scope.pendingMissingFinalNotices.size).toBe(0);
    expect(readBridgeTurnJournal(journalPath)).toEqual([]);
  });

  it('does not retire when the deadline has no attached transcript to drain', () => {
    const r = workerRig('codex');
    Object.assign(r.scope, {
      codexBridgeWatcher: null, codexBridgeOffset: 0,
      codexSubagentLimitTracker: { clear: vi.fn() }, structuredBridgeDriverState: undefined,
      ompQuietCandidateKey: undefined, ompQuietCandidateCompleteOffset: undefined,
      antigravityQuietCandidateKey: undefined, antigravityQuietCandidateCompleteOffset: undefined,
      antigravityFullUpgradeAttemptKey: undefined,
    });
    r.scope.codexBridgeDetachFile = loadWorkerFunction('codexBridgeDetachFile', r.scope);
    r.scope.codexBridgeIngest = loadWorkerFunction('codexBridgeIngest', r.scope);
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(10_000);
    r.scope.codexBridgeDetachFile();
    expect(r.scope.codexBridgeRolloutPath).toBeUndefined();
    expect(r.scope.structuredMissingFinalTarget()).toBeUndefined();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.send).not.toHaveBeenCalled();

    // A same-path reattach still gets a fresh full wait because detach reset it.
    r.scope.codexBridgeRolloutPath = 'live-transcript';
    r.scope.codexBridgeBaselineDone = true;
    r.scope.codexBridgeIngest = vi.fn(() => true);
    r.settle();
    clock.mockReturnValue(39_999);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    clock.mockReturnValue(40_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
  });

  it('does not time out while an authoritative Antigravity rebind is pending', () => {
    const r = workerRig('antigravity');
    const clock = vi.spyOn(Date, 'now');
    r.scope.antigravityPendingRebind = true;
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(100_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.codexBridgeIngest).not.toHaveBeenCalled();
    expect(r.scope.send).not.toHaveBeenCalled();

    // Once the authoritative file is bound, the same owner gets a fresh full
    // window; clearing rebind does not inherit the frozen 100 seconds.
    r.scope.antigravityPendingRebind = false;
    r.settle();
    clock.mockReturnValue(120_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
  });

  it('suppresses a duplicate IM warning but retires the working display when a submit notice exists', () => {
    const r = workerRig('doubao');
    const clock = vi.spyOn(Date, 'now');
    r.scope.structuredTurnsWithSubmitNotice.add('om_turn');
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
    expect(r.scope.send.mock.calls.map(([msg]) => msg)).toEqual([expect.objectContaining({
      type: 'turn_display_retired', turnId: 'om_turn', message: '', silent: true, noticeId: expect.stringMatching(/^[a-f0-9]{32}$/),
    })]);
    expect(r.scope.structuredTurnsWithSubmitNotice.size).toBe(0);
  });

  it('uses one legacy warning without pendingNotice when ACK is not negotiated', () => {
    const r = workerRig('doubao', { ack: false });
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.scope.send.mock.calls.map(([msg]) => msg)).toEqual([{
      type: 'user_notify', message: 'worker.structured_final_not_collected',
      kind: 'structured_turn_not_collected', turnId: 'om_turn',
    }]);
    expect(r.scope.pendingMissingFinalNotices.size).toBe(0);
    expect(readBridgeTurnJournal(r.scope.structuredBridgeJournalPath())).toEqual([]);
  });

  it('does not send silent display retirement to a daemon without ACK capability', () => {
    const r = workerRig('doubao', { ack: false });
    r.scope.structuredTurnsWithSubmitNotice.add('om_turn');
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
    expect(r.scope.send).not.toHaveBeenCalled();
    expect(r.scope.pendingMissingFinalNotices.size).toBe(0);
  });

  it('retains pendingNotice on disk without replay while ACK is not negotiated', () => {
    const r = workerRig('doubao', { ack: false });
    const journalPath = r.scope.structuredBridgeJournalPath();
    stageBridgeTurnNotice(journalPath, {
      turnId: 'om_turn', noticeId: 'a'.repeat(32), message: 'warning', createdAtMs: 0,
    });
    r.scope.restoreMissingFinalNotices = loadWorkerFunction('restoreMissingFinalNotices', r.scope);
    r.scope.flushMissingFinalNotices = loadWorkerFunction('flushMissingFinalNotices', r.scope);
    r.scope.restoreMissingFinalNotices();
    r.scope.flushMissingFinalNotices();
    expect(r.scope.send).not.toHaveBeenCalled();
    expect(r.scope.pendingMissingFinalNotices.size).toBe(0);
    expect(readBridgeTurnJournal(journalPath)[0]?.pendingNotice?.noticeId).toBe('a'.repeat(32));
  });

  it.each([false, true])('cannot resurrect a legacy-daemon owner after strict checkpoint failure (silent=%s)', silent => {
    const r = workerRig('doubao', { ack: false });
    if (silent) r.scope.structuredTurnsWithSubmitNotice.add('om_turn');
    const journalPath = r.scope.structuredBridgeJournalPath();
    const rolloutPath = join(rigDirs.at(-1)!, 'rollout.jsonl');
    writeFileSync(rolloutPath, '');
    const marked = r.queue.peek()[0]!;
    appendBridgeTurnJournalEntry(journalPath, {
      turnId: 'om_turn', markTimeMs: 0, fingerprint: marked.contentFingerprint,
      wholeInputHash: marked.wholeInputHash, jsonlPath: rolloutPath, offsetAtMark: 0,
    });
    Object.assign(r.scope, {
      codexBridgeRolloutPath: rolloutPath, structuredBridgeRecoveryAttempted: true,
      codexBridgeOffset: 0, traexQuotaPending: undefined,
      checkpointCodexAdoptTurns: () => { throw new Error('legacy checkpoint failed'); },
    });
    r.scope.checkpointStructuredBridgeRecovery = loadWorkerFunction('checkpointStructuredBridgeRecovery', r.scope);
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    expect(() => r.settle()).toThrow('legacy checkpoint failed');
    expect(readBridgeTurnJournal(journalPath)).toEqual([]);
    const restoredQueue = new CodexBridgeQueue(() => Date.now());
    const recovered = restoreCodexAdoptTurns(journalPath, rolloutPath, restoredQueue, [{
      uuid: 'native-user-1', timestampMs: 0, kind: 'user', text: 'question',
    }], -5_000, 20_000);
    expect(recovered.restored).toBe(0);
    expect(restoredQueue.peek()).toEqual([]);
    expect(r.scope.send.mock.calls.filter(([msg]) => msg.kind === 'structured_turn_not_collected'))
      .toHaveLength(silent ? 0 : 1);
  });

  it('suppresses the warning when this exact turn already has botmux-send evidence', () => {
    const r = workerRig('doubao');
    const clock = vi.spyOn(Date, 'now');
    r.scope.readSendMarkers.mockReturnValue([{
      sentAtMs: 1, sessionId: 'sid-own', turnId: 'om_turn', responseKind: 'final',
      deliveryKind: 'current_session_send', targetChatId: 'oc_own', targetRootMessageId: 'om_root',
    }]);
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
    expect(r.scope.readSendMarkers).toHaveBeenCalled();
    expect(r.scope.send.mock.calls.map(([msg]) => msg)).toEqual([expect.objectContaining({
      type: 'turn_display_retired', turnId: 'om_turn', message: '', silent: true, noticeId: expect.stringMatching(/^[a-f0-9]{32}$/),
    })]);
  });

  it.each([
    ['progress', { responseKind: 'progress' }],
    ['auxiliary', { responseKind: 'auxiliary' }],
    ['a legacy marker with no response kind', { responseKind: undefined }],
    ['a terminal-independent send', { terminalIndependent: true as const }],
    ['another turn', { turnId: 'om_other' }],
    ['another attempt', { dispatchAttempt: 1 }],
    ['another chat', { targetChatId: 'oc_other' }],
    ['another topic', { deliveryKind: 'detoured_send' as const, targetRootMessageId: 'om_other_topic' }],
    ['an auxiliary reply card', { replyCardResponseKind: 'auxiliary' as const }],
  ] as const)('does not suppress the missing-final warning for %s', (_label, override) => {
    const r = workerRig('doubao');
    const clock = vi.spyOn(Date, 'now');
    r.scope.readSendMarkers.mockReturnValue([{
      sentAtMs: 1, sessionId: 'sid-own', turnId: 'om_turn', responseKind: 'final',
      deliveryKind: 'current_session_send', targetChatId: 'oc_own', targetRootMessageId: 'om_root',
      ...override,
    }]);
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.scope.send.mock.calls.map(([msg]) => msg)).toEqual([expect.objectContaining({
      type: 'user_notify', kind: 'structured_turn_not_collected', turnId: 'om_turn',
    })]);
  });

  it('uses the restored turn\'s persisted mark time instead of an absent in-memory write timestamp', () => {
    const r = workerRig('doubao');
    const clock = vi.spyOn(Date, 'now');
    restoreStartedTurn(r, 100);
    // Legacy marker without a turn id: only the persisted window admits it.
    // The old Date.now() fallback would discard this pre-restart final at 20s.
    r.scope.readSendMarkers.mockReturnValue([{
      sentAtMs: 100, sessionId: 'sid-own', responseKind: 'final',
      deliveryKind: 'current_session_send', targetChatId: 'oc_own', targetRootMessageId: 'om_root',
    }]);
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.scope.send.mock.calls.map(([msg]) => msg)).toEqual([expect.objectContaining({
      type: 'turn_display_retired', turnId: 'om_turn',
    })]);
  });

  it('does not admit a legacy final older than the restored turn\'s persisted mark', () => {
    const r = workerRig('doubao');
    const clock = vi.spyOn(Date, 'now');
    restoreStartedTurn(r, 100);
    r.scope.readSendMarkers.mockReturnValue([{
      sentAtMs: 99, sessionId: 'sid-own', responseKind: 'final',
      deliveryKind: 'current_session_send', targetChatId: 'oc_own', targetRootMessageId: 'om_root',
    }]);
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.scope.send.mock.calls.map(([msg]) => msg)).toEqual([expect.objectContaining({
      type: 'user_notify', kind: 'structured_turn_not_collected', turnId: 'om_turn',
    })]);
  });

  it.each([
    ['legacy successor marker', undefined, 'user_notify'],
    ['exact successor marker', 'om_successor', 'user_notify'],
    ['exact current-turn marker after the successor boundary', 'om_turn', 'turn_display_retired'],
  ] as const)('bounds send evidence correctly for a %s', (_label, markerTurnId, expectedType) => {
    const r = workerRig('doubao', { nativeIdentity: true });
    r.queue.mark('om_successor', 'successor question', 10_000);
    r.queue.ingest([
      { uuid: 'native-user-successor', timestampMs: 10_000, kind: 'user', text: 'successor question',
        sourceSessionId: 'provider', sourceTurnId: 'native-successor', sourceMessageId: 'message-new' },
      { uuid: 'native-final-successor', timestampMs: 15_000, kind: 'assistant_final', text: 'successor answer',
        sourceSessionId: 'provider', sourceTurnId: 'native-successor' },
    ]);
    expect(r.queue.peek()).toHaveLength(2);
    expect(r.queue.peek()[1]).toMatchObject({ started: true, finalText: 'successor answer', markTimeMs: 10_000 });
    r.scope.readSendMarkers.mockReturnValue([{
      sentAtMs: 15_000, sessionId: 'sid-own', responseKind: 'final',
      ...(markerTurnId ? { turnId: markerTurnId } : {}),
      deliveryKind: 'current_session_send', targetChatId: 'oc_own', targetRootMessageId: 'om_root',
    }]);
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(16_000);
    r.settle();
    clock.mockReturnValue(36_000);
    r.settle();
    expect(r.scope.send.mock.calls.map(([msg]) => msg)).toEqual([expect.objectContaining({
      type: expectedType, turnId: 'om_turn',
      ...(expectedType === 'user_notify' ? { kind: 'structured_turn_not_collected' } : { silent: true }),
    })]);
  });

  it('retires a merged predecessor together with the timed-out head after a real queue merge', () => {
    const r = workerRig('codex', { nativeIdentity: true });
    const clock = vi.spyOn(Date, 'now');
    r.queue.mark('om_merged', 'follow-up', 10);
    r.queue.ingest([{
      uuid: 'native-user-merged', timestampMs: 10, kind: 'user', text: 'follow-up',
      sourceSessionId: 'provider', sourceTurnId: 'native-turn', sourceMessageId: 'message-new',
    }]);
    const merged = r.queue.peek()[0]!;
    expect(merged.turnId).toBe('om_merged');
    expect(merged.supersededTurns).toEqual([{ turnId: 'om_turn', dispatchAttempt: undefined }]);
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.scope.retireStructuredTurnAttribution.mock.calls[0]![0].map(
      (turn: CodexPendingTurn) => turn.turnId,
    )).toEqual(['om_turn', 'om_merged']);
  });

  it.each([
    'background-tasks', 'program-busy', 'antigravity-tasks', 'local-turn', 'not-started',
  ] as const)('does not retire while the %s guard rejects the target', guard => {
    const r = workerRig(guard === 'antigravity-tasks' ? 'antigravity' : 'codex');
    const clock = vi.spyOn(Date, 'now');
    if (guard === 'background-tasks') r.scope.backgroundTaskTracker.pendingTurnAgents = () => 1;
    if (guard === 'program-busy') r.scope.idleDetector.programStatusHeldBusy = () => true;
    if (guard === 'antigravity-tasks') r.scope.hasAntigravityPendingTasks = () => true;
    if (guard === 'local-turn') r.queue.peek()[0]!.isLocal = true;
    if (guard === 'not-started') r.queue.peek()[0]!.started = false;
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(100_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.codexBridgeIngest).not.toHaveBeenCalled();
    expect(r.scope.send).not.toHaveBeenCalled();
  });

  it('revalidates after the deadline drain and keeps a final that really arrived', () => {
    const r = workerRig('codex');
    const clock = vi.spyOn(Date, 'now');
    r.scope.codexBridgeIngest.mockImplementation(() => {
      r.queue.ingest([{ uuid: 'late-final', timestampMs: 20_000, kind: 'assistant_final', text: 'arrived during drain' }]);
      return true;
    });
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.queue.peek()[0]?.finalText).toBe('arrived during drain');
    expect(r.scope.send).not.toHaveBeenCalled();
    expect(r.scope.emitTurnTerminal).not.toHaveBeenCalled();
    expect(r.scope.retireStructuredTurnAttribution).not.toHaveBeenCalled();
  });

  it('keeps zero-prompt terminal sync eligible even when delivery mode is send', () => {
    const r = workerRig('codex', { delivery: 'send', zeroPrompt: true });
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
    expect(r.scope.send.mock.calls.map(([msg]) => msg)).toEqual([expect.objectContaining({
      type: 'user_notify', kind: 'structured_turn_not_collected', turnId: 'om_turn',
    })]);
  });

  it('keeps a real task_started-only claim on its original corroboration lease', () => {
    const r = workerRig('codex', { provisionalStart: true });
    const clock = vi.spyOn(Date, 'now');
    expect(r.queue.peek()[0]).toMatchObject({ started: true, provisionalTaskStartedAtMs: 0 });
    expect(r.queue.peek()[0]?.transcriptStartTimeMs).toBeUndefined();
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(100_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.send).not.toHaveBeenCalled();
  });

  it.each(['codex', 'traex'])('uses native proof from task_started corroboration to arm %s', cliId => {
    const r = workerRig(cliId, { provisionalStart: true });
    r.queue.ingest([{ uuid: 'native-user-corroborated', timestampMs: 0, kind: 'user', text: 'question',
      sourceSessionId: 'provider', sourceTurnId: 'native-provisional', sourceMessageId: 'message-1' }]);
    const turn = r.queue.peek()[0]!;
    expect(turn).toMatchObject({
      provisionalTaskStartedAtMs: undefined,
      nativeUserProof: { uuid: 'native-user-corroborated', timestampMs: 0 },
    });
    r.scope.isPromptReady = false;
    r.scope.hasStructuredLifecycleBlock = () => true;
    r.scope.structuredRejectedReadyEvidenceGeneration = r.scope.ptyOutputGeneration.snapshot();
    r.scope.structuredRejectedReadyEvidenceStartUuid = turn.nativeUserProof!.uuid;
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
    expect(r.scope.send.mock.calls.filter(([msg]) => msg.kind === 'structured_turn_not_collected')).toHaveLength(1);
  });

  it.each(['omp-provisional', 'antigravity-provisional', 'pending-tail'] as const)('keeps a collectible terminal behind %s', guard => {
    const r = workerRig(guard === 'omp-provisional' ? 'oh-my-pi'
      : guard === 'antigravity-provisional' ? 'antigravity' : 'codex');
    const clock = vi.spyOn(Date, 'now');
    if (guard === 'omp-provisional') r.scope.ompBridgeState = () => ({ provisionalFinal: { uuid: 'omp-final' } });
    if (guard === 'antigravity-provisional') r.scope.antigravityBridgeState = () => ({ provisionalFinal: { uuid: 'agy-final' } });
    if (guard === 'pending-tail') r.scope.codexBridgePendingTail = '{"role":"assistant","content":"partial';
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(100_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.codexBridgeIngest).not.toHaveBeenCalled();
    expect(r.scope.send).not.toHaveBeenCalled();
  });

  it.each(['cursor', 'mtr', 'coco', 'hermes'])('does not arm the destructive timeout for %s without busy/OSC evidence', cliId => {
    const r = workerRig(cliId);
    const clock = vi.spyOn(Date, 'now');
    r.scope.cliAdapter = {};
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(100_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.send).not.toHaveBeenCalled();
  });

  it.each(['doubao', 'traex'])('requires authoritative screen evidence for %s unless OSC is active', cliId => {
    const r = workerRig(cliId);
    r.scope.backendScreenEvidenceIsAuthoritativeForMutation = () => false;
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(100_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.send).not.toHaveBeenCalled();

    r.scope.idleDetector.programStatusActive = () => true;
    r.settle();
    clock.mockReturnValue(119_999);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    clock.mockReturnValue(120_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
  });

  it('arms on isSessionBusy alone and waits for its actual busy-to-idle edge', () => {
    const r = workerRig('codex');
    const clock = vi.spyOn(Date, 'now');
    let busy = true;
    r.scope.cliAdapter = { isSessionBusy: () => busy };
    r.scope.isPromptReady = false;
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.send).not.toHaveBeenCalled();

    busy = false;
    r.scope.isPromptReady = true;
    r.settle();
    clock.mockReturnValue(39_999);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    clock.mockReturnValue(40_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
  });

  it('keeps an OSC-only CLI eligible without a screen busy pattern', () => {
    const r = workerRig('codex');
    const clock = vi.spyOn(Date, 'now');
    r.scope.cliAdapter = {};
    r.scope.idleDetector.programStatusActive = () => true;
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
  });

  it.each(['tui-prompt', 'hook-review', 'osc-blocked', 'stuck-page', 'traex-question'] as const)('does not retire an active %s wait', guard => {
    const r = workerRig(guard === 'traex-question' ? 'traex' : 'codex');
    const clock = vi.spyOn(Date, 'now');
    if (guard === 'tui-prompt') r.scope.tuiPromptBlocking = true;
    if (guard === 'hook-review') r.scope.hookReviewInputHold = true;
    if (guard === 'osc-blocked') r.scope.idleDetector.programStatusBlock = () => ({ kind: 'question' });
    if (guard === 'stuck-page') r.scope.heldStuckPage = () => ({ kind: 'permission' });
    if (guard === 'traex-question') r.scope.traexQuestionHoldsHeldInput = () => true;
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(100_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.send).not.toHaveBeenCalled();
  });

  it.each(['rpcTurnsAwaitingActivation', 'rpcLifecycleFailClosedOwners', 'rpcTerminalHydrationOwners'] as const)(
    'keeps the generic lifecycle gate blocked by its original %s barrier', guard => {
      const scope = {
        traexQuotaPending: undefined,
        rpcTurnsAwaitingActivation: new Map(),
        rpcLifecycleFailClosedOwners: new Map(),
        rpcTerminalHydrationOwners: new Map(),
        codexBridgeQueue: { peek: () => [], hasBlockingTurn: () => false },
        isStructuredBridgeLifecycleBlockingCli: () => false,
      };
      const blocked = loadWorkerFunction<() => boolean>('hasStructuredLifecycleBlock', scope);
      expect(blocked()).toBe(false);
      scope[guard].set('rpc-owner', { generation: 1 });
      expect(blocked()).toBe(true);
      scope[guard].clear();
      expect(blocked()).toBe(false);
    },
  );

  it('keeps active/settling owners out of the generic gate and releases a queued RPC owner at final', () => {
    const turns: Array<{ rpcActive?: boolean; finalText?: string }> = [];
    const scope = {
      traexQuotaPending: undefined,
      rpcTurnsAwaitingActivation: new Map(),
      rpcLifecycleFailClosedOwners: new Map(),
      rpcTerminalHydrationOwners: new Map(),
      // These two extra watchdog-only protections must not expand the shared gate.
      rpcActiveOwners: new Map([['active-owner', { generation: 1 }]]),
      settlingRpcTerminalOwners: new Map([['settling-owner', { generation: 1 }]]),
      codexBridgeQueue: { peek: () => turns, hasBlockingTurn: () => false },
      isStructuredBridgeLifecycleBlockingCli: () => false,
    };
    const blocked = loadWorkerFunction<() => boolean>('hasStructuredLifecycleBlock', scope);
    expect(blocked()).toBe(false);

    turns.push({ finalText: undefined }, { rpcActive: true, finalText: undefined });
    expect(blocked()).toBe(true); // an unfinished predecessor does not hide the RPC owner
    turns[1]!.finalText = 'ready';
    expect(blocked()).toBe(false);
    turns[1]!.finalText = undefined;
    expect(blocked()).toBe(true);
    turns.length = 0;
    expect(blocked()).toBe(false);
  });

  it.each([
    ['rpcActive', 'rpcActive'],
    ['awaiting activation', 'rpcTurnsAwaitingActivation'],
    ['fail-closed owner', 'rpcLifecycleFailClosedOwners'],
    ['terminal hydration', 'rpcTerminalHydrationOwners'],
    ['active owner', 'rpcActiveOwners'],
    ['terminal settlement', 'settlingRpcTerminalOwners'],
  ] as const)('does not retire while RPC %s is still owned', (_label, guard) => {
    const r = workerRig('codex');
    const clock = vi.spyOn(Date, 'now');
    if (guard === 'rpcActive') r.queue.peek()[0]!.rpcActive = true;
    else r.scope[guard].set('rpc-owner', { generation: 1 });
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(100_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.codexBridgeIngest).not.toHaveBeenCalled();
    expect(r.scope.send).not.toHaveBeenCalled();
  });

  it('starts a fresh full wait only after the RPC activation owner is released', () => {
    const r = workerRig('codex');
    const clock = vi.spyOn(Date, 'now');
    r.scope.rpcTurnsAwaitingActivation.set('rpc-owner', { generation: 1 });
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(100_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    r.scope.rpcTurnsAwaitingActivation.clear();
    r.settle();
    clock.mockReturnValue(119_999);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    clock.mockReturnValue(120_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
  });

  it('expires an unacknowledged retry before daemon tombstones are reclaimed', () => {
    const r = workerRig('codex');
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.scope.send.mock.calls.filter(([msg]) => msg.kind === 'structured_turn_not_collected')).toHaveLength(1);
    const journalPath = r.scope.structuredBridgeJournalPath();
    r.scope.acknowledgeMissingFinalNotice = loadWorkerFunction('acknowledgeMissingFinalNotice', r.scope);
    r.scope.flushMissingFinalNotices = loadWorkerFunction('flushMissingFinalNotices', r.scope);
    clock.mockReturnValue(2 * 24 * 60 * 60 * 1000);
    r.scope.send.mockClear();
    r.scope.flushMissingFinalNotices();
    expect(r.scope.send).not.toHaveBeenCalled();
    expect(r.scope.pendingMissingFinalNotices.size).toBe(0);
    expect(readBridgeTurnJournal(journalPath)).toEqual([]);
  });

  it('rebinds a still-current rejected idle edge to the started successor through the real redrive', () => {
    const r = workerRig('codex', { nativeIdentity: true });
    r.advance(10_000);
    r.queue.mark('om_successor', 'successor question', 10_000);
    r.queue.ingest([{ uuid: 'native-user-successor', timestampMs: 10_000, kind: 'user', text: 'successor question',
      sourceSessionId: 'provider', sourceTurnId: 'native-successor', sourceMessageId: 'message-new' }]);
    expect(r.queue.peek().map(turn => [turn.turnId, turn.started, turn.finalText])).toEqual([
      ['om_turn', true, undefined], ['om_successor', true, undefined],
    ]);
    const clock = vi.spyOn(Date, 'now');
    r.scope.isPromptReady = false;
    r.scope.backend = {};
    r.scope.hasStructuredLifecycleBlock = () => r.queue.peek().some(turn => turn.started && turn.finalText === undefined);
    r.scope.stopStructuredStartGraceRecheck = vi.fn();
    r.scope.pruneExpiredStructuredHeadsAndEmit = vi.fn();
    r.scope.idleDetector.fireIdle = vi.fn();
    r.scope.structuredRejectedReadyEvidenceGeneration = r.scope.ptyOutputGeneration.snapshot();
    r.scope.structuredRejectedReadyEvidenceStartUuid = r.queue.peek()[0]!.nativeUserProof!.uuid;
    r.scope.redriveRejectedStructuredReady = loadWorkerFunction('redriveRejectedStructuredReady', r.scope);

    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.queue.peek().map(turn => turn.turnId)).toEqual(['om_successor']);
    expect(r.scope.structuredRejectedReadyEvidenceStartUuid)
      .toBe(r.queue.peek()[0]!.nativeUserProof!.uuid);

    // The successor gets its own complete watchdog window after the rebinding.
    clock.mockReturnValue(20_001);
    r.settle();
    clock.mockReturnValue(40_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    clock.mockReturnValue(40_001);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
    expect(r.scope.send.mock.calls.filter(([msg]) => msg.kind === 'structured_turn_not_collected')).toHaveLength(2);
  });

  it('does not inherit a pre-start rejected ready edge as post-start idle evidence', () => {
    const r = workerRig('codex', { deferStart: true });
    const clock = vi.spyOn(Date, 'now');
    r.scope.isPromptReady = false;
    r.scope.hasStructuredLifecycleBlock = () => true;
    clock.mockReturnValue(0);
    // The composer/submit gate rejected idle before any transcript user record.
    r.scope.structuredRejectedReadyEvidenceGeneration = r.scope.ptyOutputGeneration.snapshot();
    r.scope.structuredRejectedReadyEvidenceStartUuid = undefined;
    r.settle();
    expect(r.queue.peek()[0]?.started).toBe(false);

    r.queue.ingest([{ uuid: 'native-user-after-rejected-ready', timestampMs: 0, kind: 'user', text: 'question' }]);
    expect(r.queue.peek()[0]?.started).toBe(true);
    r.settle();
    clock.mockReturnValue(20_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.send).not.toHaveBeenCalled();

    // A fresh rejection that observed this exact started owner is valid evidence.
    r.scope.structuredRejectedReadyEvidenceGeneration = r.scope.ptyOutputGeneration.snapshot();
    r.scope.structuredRejectedReadyEvidenceStartUuid = r.queue.peek()[0]!.nativeUserProof!.uuid;
    r.settle();
    clock.mockReturnValue(39_999);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    clock.mockReturnValue(40_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
  });

  it('resets the wait on output and supports a lifecycle-blocked rejected idle edge', () => {
    const r = workerRig('codex');
    r.scope.isPromptReady = false;
    r.scope.hasStructuredLifecycleBlock = () => true;
    r.scope.structuredRejectedReadyEvidenceGeneration = r.scope.ptyOutputGeneration.snapshot();
    r.scope.structuredRejectedReadyEvidenceStartUuid = r.queue.peek()[0]!.nativeUserProof!.uuid;
    vi.spyOn(Date, 'now').mockReturnValue(0);
    r.settle();
    expect(r.scope.structuredMissingFinalTarget()).toBeDefined();

    // New output invalidates that rejected idle edge and the old deadline.
    r.scope.ptyOutputGeneration.observe();
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.structuredMissingFinalTarget()).toBeUndefined();

    // A fresh idle edge for the same started owner gets its own full window.
    r.scope.structuredRejectedReadyEvidenceGeneration = r.scope.ptyOutputGeneration.snapshot();
    r.scope.structuredRejectedReadyEvidenceStartUuid = r.queue.peek()[0]!.nativeUserProof!.uuid;
    r.settle();
    vi.spyOn(Date, 'now').mockReturnValue(119_999);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    vi.spyOn(Date, 'now').mockReturnValue(120_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
  });
});
