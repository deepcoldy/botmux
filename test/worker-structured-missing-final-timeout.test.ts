import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexBridgeQueue, type CodexPendingTurn } from '../src/services/codex-bridge-queue.js';
import { StructuredMissingFinalWatchdog } from '../src/services/structured-missing-final.js';
import { PtyOutputGeneration } from '../src/utils/runtime-screen-status.js';
import {
  attributableBridgeReplyMarkers,
  bridgeGateInputForTurn,
  finalBridgeSendMarkerCoversOwnThread,
  type BridgeSendMarker,
} from '../src/services/bridge-fallback-gate.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

function workerRig(cliId = 'codex', opts: { attempt?: number; delivery?: 'send' | 'transcript'; zeroPrompt?: boolean; nativeIdentity?: boolean; provisionalStart?: boolean } = {}) {
  let now = 0;
  const queue = new CodexBridgeQueue(() => now);
  queue.mark('om_turn', 'question', now, opts.attempt);
  if (opts.provisionalStart) {
    queue.ingest([{ uuid: 'native-task-started', timestampMs: now, kind: 'turn_started', text: '',
      sourceSessionId: 'provider', sourceTurnId: 'native-provisional',
    }]);
  } else {
    queue.ingest([{ uuid: 'native-user-1', timestampMs: now, kind: 'user', text: 'question',
      ...(opts.nativeIdentity ? {
        sourceSessionId: 'provider', sourceTurnId: 'native-turn', sourceMessageId: 'message-old',
      } : {}),
    }]);
  }
  const scope: Record<string, any> = {
    lastInitConfig: { cliId, replyDelivery: opts.delivery ?? 'transcript', adoptMode: false, chatId: 'oc_own', rootMessageId: 'om_root' },
    replyDeliveryMode: () => opts.delivery ?? 'transcript',
    zeroPromptTerminalSync: () => opts.zeroPrompt === true,
    codexBridgeQueue: queue,
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
    codexBridgeIngest: vi.fn(),
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
  scope.notifyMissingFinalTurn = loadWorkerFunction('notifyMissingFinalTurn', scope);
  scope.missingFinalTurnDeliveredBySend = loadWorkerFunction('missingFinalTurnDeliveredBySend', scope);
  const settle = loadWorkerFunction<() => void>('maybeSettleMissingStructuredFinal', scope);
  return { scope, queue, settle, advance: (ms: number) => { now += ms; } };
}

function restoreStartedTurn(r: ReturnType<typeof workerRig>, markTimeMs: number): CodexPendingTurn {
  r.queue.clearPending();
  r.queue.restorePendingTurns([{ turnId: 'om_turn', fingerprint: 'question', markTimeMs }]);
  r.queue.ingest([{ uuid: 'restored-native-user', timestampMs: markTimeMs, kind: 'user', text: 'question' }]);
  const restored = r.queue.peek()[0]!;
  expect(restored).toMatchObject({ turnId: 'om_turn', started: true, restoredFromJournal: true, markTimeMs });
  return restored;
}

afterEach(() => vi.restoreAllMocks());

describe('worker: missing structured final timeout', () => {
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
    expect(r.scope.send.mock.calls.map(([msg]) => msg)).toEqual([{
      type: 'user_notify', message: 'worker.structured_final_not_collected',
      kind: 'structured_turn_not_collected', turnId: 'om_turn',
    }]);
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
    expect(r.scope.send.mock.calls.map(([msg]) => msg)).toEqual([{
      type: 'turn_display_retired', turnId: 'om_turn', message: '', silent: true,
    }]);
    expect(r.scope.structuredTurnsWithSubmitNotice.size).toBe(0);
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
    expect(r.scope.send.mock.calls.map(([msg]) => msg)).toEqual([{
      type: 'turn_display_retired', turnId: 'om_turn', message: '', silent: true,
    }]);
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

  it.each(['tui-prompt', 'hook-review', 'osc-blocked', 'traex-question'] as const)('does not retire an active %s wait', guard => {
    const r = workerRig(guard === 'traex-question' ? 'traex' : 'codex');
    const clock = vi.spyOn(Date, 'now');
    if (guard === 'tui-prompt') r.scope.tuiPromptBlocking = true;
    if (guard === 'hook-review') r.scope.hookReviewInputHold = true;
    if (guard === 'osc-blocked') r.scope.idleDetector.programStatusBlock = () => ({ kind: 'question' });
    if (guard === 'traex-question') r.scope.traexQuestionHoldsHeldInput = () => true;
    clock.mockReturnValue(0);
    r.settle();
    clock.mockReturnValue(100_000);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    expect(r.scope.send).not.toHaveBeenCalled();
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

  it('resets the wait on output and supports a lifecycle-blocked rejected idle edge', () => {
    const r = workerRig('codex');
    r.scope.isPromptReady = false;
    r.scope.hasStructuredLifecycleBlock = () => true;
    r.scope.structuredRejectedReadyEvidenceGeneration = r.scope.ptyOutputGeneration.snapshot();
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
    r.settle();
    vi.spyOn(Date, 'now').mockReturnValue(119_999);
    r.settle();
    expect(r.queue.peek()).toHaveLength(1);
    vi.spyOn(Date, 'now').mockReturnValue(120_000);
    r.settle();
    expect(r.queue.peek()).toEqual([]);
  });
});
