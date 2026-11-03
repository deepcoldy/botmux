import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import type { CodexPendingTurn } from '../src/services/codex-bridge-queue.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { isValidMarkerIdentityTurnId } from '../src/core/turn-id-shape.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';

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
