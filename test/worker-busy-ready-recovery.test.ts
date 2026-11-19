import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { BusyReadyDeferralTracker, shouldRearmBusyProbeAfterSettleAbort } from '../src/utils/busy-ready-deferral.js';
import { BusyReadyFallbackGate } from '../src/utils/busy-ready-fallback.js';
import { busyProbeRegion } from '../src/utils/busy-probe.js';

/** Real recovery, probe loop, async settle continuation and bounded fallback.
 * Only screen/backend I/O and the final publication are injected. */
function harness(options: { settle?: boolean; dbOnly?: boolean } = {}) {
  const be = options.settle ? { settleCurrentScreen() {} } : {};
  const scope: Record<string, any> = {
    backend: be, cliSpawnGeneration: 1, backendScreenRevision: 1,
    currentBotmuxTurnId: 'turn-1', currentBotmuxDispatchAttempt: 1,
    isPromptReady: false, awaitingFirstPrompt: true,
    busyReadyDeferral: new BusyReadyDeferralTracker(),
    busyReadyFallbackGate: new BusyReadyFallbackGate(() => ({ fallbackMs: 2_000, stableScreenMs: 1_000 })),
    busyPatternIdleProbeTimer: null, turnTerminalReadyRecovery: null,
    forceReadyAfterTurnTerminal: false, IDLE_PROBE_INTERVAL_MS: 500,
    sessionId: 'sid', lastInitConfig: {},
    cliAdapter: { busyPattern: options.dbOnly ? undefined : /BUSY/, readyPattern: /COMPOSER/, isSessionBusy: () => scope.dbBusy },
    dbBusy: false, screen: 'COMPOSER BUSY',
    cliProcessAliveProbe: () => () => true, cliProcessAliveFromBackend: () => true,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    canCaptureBusyPatternScreen: () => true,
    captureBackendScreen: () => scope.screen,
    busyProbeRegion, stripAnsiScreenText: (text: string) => text,
    traexQuestionHoldsIdle: () => false, reattachedTurnStillOpen: () => false,
    settleBackendScreenBeforeIdle: vi.fn(async () => ({ proceed: true })),
    shouldRearmBusyProbeAfterSettleAbort,
    warnPromptReadySkipped: vi.fn(), log: vi.fn(), cliName: () => 'test-cli',
    markPromptReady: vi.fn(() => {
      scope.isPromptReady = true;
      scope.busyReadyDeferral.clear('prompt-ready');
      scope.cancelTurnTerminalReadyRecovery();
      scope.stopBusyPatternIdleProbe();
    }),
  };
  scope.busyReadyDeferral.defer({ reason: 'busy-marker', source: 'initial', turnId: 'turn-1', dispatchAttempt: 1 });
  for (const name of ['cancelTurnTerminalReadyRecovery', 'markPromptReadyFromBusyProbe',
    'handleBusyProbeSettleAbort', 'probeBusyPatternIdle', 'stopBusyPatternIdleProbe',
    'scheduleBusyPatternIdleProbe', 'maybeForceReadyOnStaleBusyMarker',
    'recoverDeferredPromptReadyAtTurnTerminal']) scope[name] = loadWorkerFunction(name, scope);
  const recover = () => scope.recoverDeferredPromptReadyAtTurnTerminal({ turnId: 'turn-1', dispatchAttempt: 1 });
  return { scope, recover };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('terminal prompt-ready recovery', () => {
  it('requires the first composer even after an exact terminal with no prior busy episode', async () => {
    const h = harness({ settle: true }); h.scope.busyReadyDeferral.reset();
    h.scope.screen = 'Booting model...'; h.recover();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.scope.markPromptReady).not.toHaveBeenCalled();
    h.scope.screen = 'COMPOSER';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.scope.markPromptReady).toHaveBeenCalledTimes(1);
  });

  it('releases a frozen busy marker only through the bounded positive-composer probe', async () => {
    const h = harness(); h.recover();
    expect(h.scope.markPromptReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.scope.markPromptReady).toHaveBeenCalledTimes(1);
    expect(h.scope.isPromptReady).toBe(true);
    expect(h.scope.busyReadyDeferral.active).toBe(false);
  });

  it.each(['DB busy', 'no composer', 'changing screen', 'open transcript'])('does not override %s after a terminal', async kind => {
    const h = harness();
    if (kind === 'DB busy') h.scope.dbBusy = true;
    if (kind === 'no composer') h.scope.screen = 'BUSY';
    if (kind === 'open transcript') {
      h.scope.bridgeJsonlPath = 'inert'; h.scope.claudeTranscriptLatestTurnState = () => 'open';
    }
    h.recover();
    for (let i = 0; i < 30; i++) {
      if (kind === 'changing screen') h.scope.backendScreenRevision++;
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(h.scope.markPromptReady).not.toHaveBeenCalled();
    expect(h.scope.isPromptReady).toBe(false);
  });

  it.each(['turn', 'attempt', 'backend', 'generation'])('stops the old recovery when its %s changes', async identity => {
    const h = harness(); h.recover();
    if (identity === 'turn') h.scope.currentBotmuxTurnId = 'turn-2';
    if (identity === 'attempt') h.scope.currentBotmuxDispatchAttempt = 2;
    if (identity === 'backend') h.scope.backend = {};
    if (identity === 'generation') h.scope.cliSpawnGeneration++;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.scope.markPromptReady).not.toHaveBeenCalled();
    expect(h.scope.busyPatternIdleProbeTimer).toBeNull();
  });

  it.each([false, true])('retries repeated declined async settles (DB-only=%s) until an actual ready edge', async dbOnly => {
    const h = harness({ settle: true, dbOnly }); h.scope.screen = 'COMPOSER';
    for (let i = 0; i < 5; i++) h.scope.settleBackendScreenBeforeIdle.mockResolvedValueOnce({ proceed: false });
    h.recover();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.scope.settleBackendScreenBeforeIdle).toHaveBeenCalledTimes(6);
    expect(h.scope.markPromptReady).toHaveBeenCalledTimes(1);
    expect(h.scope.busyReadyDeferral.active).toBe(false);
  });

  it('retries when the authoritative screen revision changes during settle', async () => {
    const h = harness({ settle: true }); h.scope.screen = 'COMPOSER';
    h.scope.settleBackendScreenBeforeIdle.mockImplementationOnce(async () => {
      h.scope.backendScreenRevision++; return { proceed: true };
    });
    h.recover(); await vi.advanceTimersByTimeAsync(2_000);
    expect(h.scope.settleBackendScreenBeforeIdle).toHaveBeenCalledTimes(2);
    expect(h.scope.markPromptReady).toHaveBeenCalledTimes(1);
  });

  it('a late async settle cannot publish ready for a newer attempt', async () => {
    const h = harness({ settle: true }); h.scope.screen = 'COMPOSER';
    let finish!: (value: { proceed: boolean }) => void;
    h.scope.settleBackendScreenBeforeIdle.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.recover(); h.scope.currentBotmuxDispatchAttempt = 2;
    finish({ proceed: true }); await vi.advanceTimersByTimeAsync(2_000);
    expect(h.scope.markPromptReady).not.toHaveBeenCalled();
  });

  it('retries a stable probe whose ready publication was blocked by an input-safety gate', async () => {
    const h = harness({ settle: true }); h.scope.screen = 'COMPOSER';
    h.scope.markPromptReady.mockImplementationOnce(() => {});
    h.recover(); await vi.advanceTimersByTimeAsync(2_000);
    expect(h.scope.markPromptReady).toHaveBeenCalledTimes(2);
    expect(h.scope.isPromptReady).toBe(true);
  });

  it('does not bypass the structured-lifecycle gate even with exact terminal recovery', () => {
    const h = harness();
    Object.assign(h.scope, {
      idleDetector: { isStartupPending: () => false, reset: vi.fn() },
      traexFirstPromptViewportRejects: () => false,
      currentInputDeliveryQuarantine: () => false, currentPostTerminalInputFence: () => false,
      probeStartupBlocker: () => false, holdForNativeSessionFork: () => false,
      stopStructuredStartGraceRecheck: vi.fn(), isCodexAppCliId: () => false,
      readyGate: { shouldHold: () => false }, freshnessInputQueue: { onPromptReady: () => undefined },
      spawnArgvTurnStartGateHolds: () => true, hasStructuredLifecycleBlock: () => true,
      releaseInterruptedStructuredBridgeOnFirstPrompt: vi.fn(),
      codexBridgeQueue: { preStartLeaseRemainingMs: () => undefined }, ptyOutputGeneration: { snapshot: () => 1 },
      flushQueuedInputAfterTurnStartEvidence: vi.fn(),
    });
    h.scope.markPromptReady = loadWorkerFunction('markPromptReady', h.scope);
    h.scope.turnTerminalReadyRecovery = { turnId: 'turn-1', dispatchAttempt: 1, backend: h.scope.backend, generation: 1 };
    h.scope.markPromptReadyFromBusyProbe(h.scope.backend);
    expect(h.scope.idleDetector.reset).toHaveBeenCalled();
    expect(h.scope.isPromptReady).toBe(false);
    expect(h.scope.forceReadyAfterTurnTerminal).toBe(false);
  });
});
