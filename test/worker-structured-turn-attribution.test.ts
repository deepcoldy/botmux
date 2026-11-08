import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import type { CodexPendingTurn } from '../src/services/codex-bridge-queue.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { isValidMarkerIdentityTurnId } from '../src/core/turn-id-shape.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { advanceAncestorSessionTurn, readProcessStartIdentity, resolveSessionContext } from '../src/core/session-marker.js';
import { recordBridgeReplyMarker } from '../src/services/bridge-reply-marker.js';
import { bridgeGateInputForTurn, structuredFallbackKind } from '../src/services/bridge-fallback-gate.js';

function harness() {
  const scope: Record<string, any> = {
    currentBotmuxTurnId: 'extra', currentBotmuxDispatchAttempt: undefined,
    currentBotmuxCallerOpenId: 'caller', currentBotmuxLinkRefMode: 'observe',
    currentVcMeetingImTurnOrigin: {}, currentTurnSteerPromoted: true,
    queuedTypeAheadTurns: [{ turnId: 'first' }, { turnId: 'extra' }, { turnId: 'next' }],
    retiredTurnIds: new Set<string>(),
    turnExecutionClock: { forget: vi.fn() }, releaseActiveTurnAuthority: vi.fn(),
    codexBridgeQueue: { peek: () => [] }, pendingStructuredCaptureRetirement: undefined,
  };
  scope.markTurnRetired = (turnId: string) => scope.retiredTurnIds.add(turnId);
  scope.setCaptureIdentity = (turnId?: string, dispatchAttempt?: number, caller?: string) => {
    scope.currentBotmuxTurnId = turnId; scope.currentBotmuxDispatchAttempt = dispatchAttempt;
    scope.currentBotmuxCallerOpenId = caller;
  };
  scope.writeCliPidMarker = vi.fn(() => {
    // A stale disk entry must already be tombstoned at the synchronization boundary.
    expect(scope.retiredTurnIds.has('first')).toBe(true);
    expect(scope.queuedTypeAheadTurns.some((t: any) => t.turnId === 'first')).toBe(false);
  });
  scope.retireStructuredTurnAttribution = loadWorkerFunction('retireStructuredTurnAttribution', scope);
  return scope;
}

describe('structured turn send attribution retirement', () => {
  it('retires folded PID markers before subsequent CLI sends, including an unsteered third execution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merged-send-attribution-'));
    try {
      const h = harness();
      const queue = new CodexBridgeQueue(() => 10_000);
      const marker = join(dir, '.botmux-cli-pids', String(process.pid));
      mkdirSync(join(dir, '.botmux-cli-pids'));
      Object.assign(h, {
        sessionId: 'sid', cliPidMarker: marker, rpcEnginePidMarker: undefined,
        codexBridgeQueue: queue, queuedTypeAheadTurns: [], currentBotmuxTurnId: undefined,
        existsSync, readFileSync, basename, atomicWriteFileSync, readProcessStartIdentity,
        activeTurnAuthority: new ActiveTurnAuthority(), sandboxRelayCapability: null,
        captureIdentityAnnounced: false, captureRevision: 0, send: vi.fn(),
        publishActiveTurn: vi.fn(), log: vi.fn(),
        withPidMarkerLock: (_path: string, fn: () => void) => fn(),
        markerIdentityTurnId: loadWorkerFunction('markerIdentityTurnId', { isValidMarkerIdentityTurnId }),
        emittedTurnTerminals: new TurnTerminalDeduper(),
      });
      for (const name of ['setCaptureIdentity', 'adoptInitialActiveTurn', 'writeCliPidMarker',
        'turnTerminalEmitted', 'dropQueuedTurnRecord', 'retireTerminatedMarkerTurn', 'markerQueuedTurnStillLive']) {
        h[name] = loadWorkerFunction(name, h);
      }
      for (const [execution, count] of [4, 3, 1].entries()) {
        const base = (execution + 1) * 1_000;
        const first = `execution-${execution}-input-0`;
        h.adoptInitialActiveTurn({ turnId: first });
        for (let i = 0; i < count; i++) {
          const id = `execution-${execution}-input-${i}`;
          queue.mark(id, id, base + i * 10);
          if (i > 0) h.queuedTypeAheadTurns.push({ turnId: id });
          h.writeCliPidMarker();
          queue.ingest([{ uuid: `${id}-user`, kind: 'user', text: id,
            timestampMs: base + i * 10 + 1, sourceSessionId: 'provider',
            sourceTurnId: `native-${execution}`, sourceMessageId: id }]);
        }
        // Resolve and record the send using the actual CLI process-tree path,
        // rather than supplying the expected turn identity to the receipt.
        const context = resolveSessionContext(dir, 'sid', process.pid)!;
        expect(context.turnId).toBe(first);
        recordBridgeReplyMarker({ dataDir: dir, ...context, sentAtMs: base + 90,
          content: 'Delivered answer', responseKind: 'final', deliveryKind: 'current_session_send' });
        // A successful final advances the disk marker before the native
        // completion arrives, exactly where stale type-ahead used to survive.
        advanceAncestorSessionTurn(dir, process.pid, context.turnId);
        queue.ingest([{ uuid: `final-${execution}`, kind: 'assistant_final', text: '',
          timestampMs: base + 100, sourceSessionId: 'provider', sourceTurnId: `native-${execution}` }]);
        const [ready] = queue.drainEmittable();
        const receipts = readFileSync(join(dir, 'turn-sends', 'sid.jsonl'), 'utf8')
          .trim().split('\n').map(line => JSON.parse(line));
        const input = bridgeGateInputForTurn('sid', ready, {
          markTimeMs: ready.markTimeMs, isLocal: ready.isLocal,
          finalText: ready.finalText, terminalStatus: ready.terminalStatus,
        });
        expect(structuredFallbackKind(input, undefined, receipts, false, true)).toBe('none');
        h.retireStructuredTurnAttribution([...(ready.supersededTurns ?? []), ready]);
        expect(h.currentBotmuxTurnId).toBeUndefined();
        expect(h.queuedTypeAheadTurns).toEqual([]);
        expect(h.pendingStructuredCaptureRetirement).toBeUndefined();
        expect(resolveSessionContext(dir, 'sid', process.pid)?.turnId).toBeUndefined();
        expect(queue.size()).toBe(0);
        for (let i = 0; i < count; i++) {
          expect(h.retiredTurnIds.has(`execution-${execution}-input-${i}`)).toBe(true);
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps type-ahead context until an already-started native successor ends', () => {
    const h = harness();
    h.currentBotmuxTurnId = 'first';
    h.codexBridgeQueue.peek = () => [{ turnId: 'extra', started: true }];
    h.retireStructuredTurnAttribution([{ turnId: 'first' }]);
    expect(h.currentBotmuxTurnId).toBe('first');
    expect(h.pendingStructuredCaptureRetirement).toEqual({ turnId: 'first', dispatchAttempt: undefined });
    h.codexBridgeQueue.peek = () => [];
    h.retireStructuredTurnAttribution([{ turnId: 'extra' }]);
    expect(h.currentBotmuxTurnId).toBeUndefined();
    expect(h.pendingStructuredCaptureRetirement).toBeUndefined();
    expect(h.queuedTypeAheadTurns).toEqual([{ turnId: 'next' }]);
  });

  it('does not clear a fresh turn when an older deferred retirement completes', () => {
    const h = harness();
    h.currentBotmuxTurnId = 'first';
    h.currentBotmuxDispatchAttempt = 2;
    h.pendingStructuredCaptureRetirement = { turnId: 'first', dispatchAttempt: 1 };
    h.writeCliPidMarker = vi.fn();
    h.retireStructuredTurnAttribution([{ turnId: 'extra' }]);
    expect(h.currentBotmuxTurnId).toBe('first');
    expect(h.currentBotmuxDispatchAttempt).toBe(2);
    expect(h.pendingStructuredCaptureRetirement).toBeUndefined();
  });

  it('removes stale on-disk queue entries before they can be adopted again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'retired-marker-'));
    try {
      const h = harness();
      const marker = join(dir, 'marker');
      writeFileSync(marker, JSON.stringify({ sessionId: 'sid', turnId: 'first',
        queuedTurns: [{ turnId: 'extra' }, { turnId: 'next' }] }));
      Object.assign(h, {
        sessionId: 'sid', cliPidMarker: marker, rpcEnginePidMarker: undefined,
        existsSync, readFileSync, basename, atomicWriteFileSync,
        readProcessStartIdentity: () => undefined, publishActiveTurn: vi.fn(),
        markerIdentityTurnId: loadWorkerFunction('markerIdentityTurnId', { isValidMarkerIdentityTurnId }),
        activeTurnAuthority: { snapshot: () => undefined }, sandboxRelayCapability: null,
        withPidMarkerLock: (_path: string, fn: () => void) => fn(), log: vi.fn(),
        adoptInitialActiveTurn: vi.fn(), adoptDisplacedActiveTurn: vi.fn(),
        emittedTurnTerminals: new TurnTerminalDeduper(),
      });
      for (const name of ['turnTerminalEmitted', 'dropQueuedTurnRecord', 'retireTerminatedMarkerTurn', 'markerQueuedTurnStillLive']) {
        h[name] = loadWorkerFunction(name, h);
      }
      h.writeCliPidMarker = loadWorkerFunction('writeCliPidMarker', h);
      h.retireStructuredTurnAttribution([{ turnId: 'first' }, { turnId: 'extra' }]);
      const saved = JSON.parse(readFileSync(marker, 'utf8'));
      expect(saved.turnId).toBeNull();
      expect(saved.queuedTurns).toEqual([{ turnId: 'next' }]);
      expect(h.adoptInitialActiveTurn).not.toHaveBeenCalled();
      expect(h.adoptDisplacedActiveTurn).not.toHaveBeenCalled();
      expect(h.log).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('clears a completed host and its merged inputs while preserving a later queued input', () => {
    const h = harness();
    h.retireStructuredTurnAttribution([{ turnId: 'first' }, { turnId: 'extra' }]);
    expect(h.currentBotmuxTurnId).toBeUndefined();
    expect(h.currentBotmuxCallerOpenId).toBeUndefined();
    expect(h.queuedTypeAheadTurns).toEqual([{ turnId: 'next' }]);
    expect([...h.retiredTurnIds]).toEqual(['first', 'extra']);
    expect(h.writeCliPidMarker).toHaveBeenCalledOnce();
    expect(h.turnExecutionClock.forget.mock.calls).toEqual([
      ['first', undefined], ['extra', undefined],
    ]);
    expect(h.releaseActiveTurnAuthority.mock.calls).toEqual([
      ['structured_turn_retired', { turnId: 'first' }],
      ['structured_turn_retired', { turnId: 'extra' }],
    ]);
  });

  it('does not retire a newer execution attempt or its caller', () => {
    const h = harness();
    h.currentBotmuxTurnId = 'first'; h.currentBotmuxDispatchAttempt = 2;
    h.queuedTypeAheadTurns = [{ turnId: 'first', dispatchAttempt: 1 }, { turnId: 'extra' }];
    h.writeCliPidMarker = vi.fn();
    h.retireStructuredTurnAttribution([{ turnId: 'first', dispatchAttempt: 1 }]);
    expect(h.currentBotmuxTurnId).toBe('first');
    expect(h.currentBotmuxDispatchAttempt).toBe(2);
    expect(h.currentBotmuxCallerOpenId).toBe('caller');
    expect(h.retiredTurnIds.has('first')).toBe(false);
    expect(h.queuedTypeAheadTurns).toEqual([{ turnId: 'extra' }]);
  });

  it('retires superseded send attribution after the single native terminal', () => {
    const h = harness();
    const extra: CodexPendingTurn = { turnId: 'extra', started: true, finalText: 'answer',
      supersededTurns: [{ turnId: 'first' }], markTimeMs: 200 };
    Object.assign(h, {
      sessionId: 'sid', bridgeGateInputForTurn: (_sid: unknown, _turn: unknown, gate: unknown) => gate,
      codexBridgeQueue: { drainEmittable: () => [extra], peek: () => [] },
      checkpointCodexAdoptRecovery: vi.fn(), checkpointStructuredBridgeRecovery: vi.fn(),
      // Ordinary structured terminals are not owned by quota recovery.
      recoverTraexQuotaTurn: () => false,
      armPostTerminalInputFence: vi.fn(), lastInitConfig: { adoptMode: false },
      isExistingAppServerSharedBridge: () => false, readSendMarkers: () => [],
      zeroPromptTerminalSync: () => false,
      structuredBridgeIs: () => false, structuredFallbackKind: () => 'none',
      replyDeliveryMode: () => 'explicit', bridgeTurnOutcome: () => 'completed',
      notifyExplicitRepliesObserved: vi.fn(), attributableExplicitReplyMarkersForTurnWindow: () => [],
      usageLimitTracker: { noteTurnCompleted: vi.fn() },
      releaseInputDeliveryQuarantineForStructuredTerminal: vi.fn(),
      retireRpcLifecycleFromStructuredTerminal: vi.fn(), emitTurnTerminal: vi.fn(),
    });
    loadWorkerFunction('emitReadyCodexTurns', h)();
    expect(h.notifyExplicitRepliesObserved).toHaveBeenCalledTimes(1);
    expect(h.emitTurnTerminal.mock.calls.map((args: any[]) => args[0])).toEqual(['extra']);
    expect(h.queuedTypeAheadTurns).toEqual([{ turnId: 'next' }]);
    expect(h.currentBotmuxTurnId).toBeUndefined();
  });
});

describe('structured bridge terminal: the provider error summary goes with a failed turn', () => {
  function emitOne(turn: CodexPendingTurn) {
    const scope: Record<string, any> = {
      sessionId: 'sid', universalOutputHandoff: false,
      bridgeGateInputForTurn: (_sid: unknown, _turn: unknown, gate: unknown) => gate,
      codexBridgeQueue: { drainEmittable: () => [turn], peek: () => [], restoreDrained: vi.fn() },
      checkpointCodexAdoptRecovery: vi.fn(), checkpointStructuredBridgeRecovery: vi.fn(),
      recoverTraexQuotaTurn: () => false,
      armPostTerminalInputFence: vi.fn(), lastInitConfig: { adoptMode: false },
      isExistingAppServerSharedBridge: () => false, readSendMarkers: () => [],
      zeroPromptTerminalSync: () => false,
      structuredBridgeIs: () => false, structuredFallbackKind: () => 'none',
      replyDeliveryMode: () => 'explicit', bridgeTurnOutcome: () => 'completed',
      notifyExplicitRepliesObserved: vi.fn(), attributableExplicitReplyMarkersForTurnWindow: () => [],
      attributableBridgeReplyMarkers: () => [],
      usageLimitTracker: { noteTurnCompleted: vi.fn() },
      releaseInputDeliveryQuarantineForStructuredTerminal: vi.fn(),
      retireRpcLifecycleFromStructuredTerminal: vi.fn(), emitTurnTerminal: vi.fn(),
      retireStructuredTurnAttribution: vi.fn(), send: vi.fn(), log: vi.fn(),
    };
    loadWorkerFunction('emitReadyCodexTurns', scope)();
    return scope.emitTurnTerminal.mock.calls as unknown[][];
  }

  it('failed with a summary: the summary is the terminal\'s error text (its 8th argument)', () => {
    const calls = emitOne({ turnId: 'om_failed', started: true, finalText: '', markTimeMs: 200,
      terminalStatus: 'failed', terminalErrorCode: 'provider_server_error', terminalErrorSummary: 'upstream 502 from the gateway' });
    expect(calls).toEqual([['om_failed', 'failed', 'provider_server_error', undefined, undefined, undefined, undefined, 'upstream 502 from the gateway']]);
  });

  it.each([
    ['completed', { terminalStatus: 'completed' as const, terminalErrorSummary: 'not an error' }],
    ['failed without a summary', { terminalStatus: 'failed' as const, terminalErrorCode: 'provider_server_error' }],
  ])('%s: the terminal is emitted as before, with no error text', (_name, fields) => {
    const calls = emitOne({ turnId: 'om_x', started: true, finalText: 'answer', markTimeMs: 200, ...fields });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.length).toBeLessThanOrEqual(5);
    expect(calls[0]![7]).toBeUndefined();
  });
});
