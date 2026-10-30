import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';

/**
 * Live wedge (Claude, chat-scope session + 10-minute silent schedule):
 * a Lark message typed ahead while turn A ran was folded into A as a
 * `queued_command` attachment, so its bridge turn B ended together with A.
 * The worker still held B as a queued type-ahead record and advanced the
 * active turn authority to it AFTER both terminals had gone out. Nothing could
 * release B any more, and every later `queueAfterActiveTurn` schedule fire
 * queued as "Claude is busy" for 13 hours while the CLI sat at its prompt.
 */
function harness() {
  const scope: Record<string, any> = {
    sessionId: 'sid',
    currentBotmuxTurnId: undefined,
    currentBotmuxDispatchAttempt: undefined,
    currentBotmuxCallerOpenId: undefined,
    currentBotmuxLinkRefMode: undefined,
    currentVcMeetingImTurnOrigin: undefined,
    currentTurnSteerPromoted: false,
    queuedTurnAdvanceConsumedForPrompt: false,
    queuedTypeAheadTurns: [],
    retiredTurnIds: new Set<string>(),
    activeTurnAuthority: new ActiveTurnAuthority(),
    emittedTurnTerminals: new TurnTerminalDeduper(),
    submitFailureChains: new Map(),
    cliSpawnGeneration: 1,
    cancelSubmitFailureChainForTerminal: vi.fn(),
    turnExecutionClock: { settle: () => undefined, forget: vi.fn() },
    traexAutoModelController: undefined,
    lastTurnFailureSurfacedAtMs: undefined,
    codexBridgeQueue: { dropPendingTurn: () => false },
    thinkingTurn: undefined,
    sandboxRelayCapability: null,
    completeManagedTurnOriginRevocation: vi.fn(),
    terminalReleasesDurableTurn: () => false,
    remoteRunnerRecoveredTurnInFlight: false,
    flushPending: vi.fn(),
    queueMicrotask: (fn: () => void) => fn(),
    writeCliPidMarker: vi.fn(),
    publishSandboxRelayCapability: vi.fn(),
    syncQueuedTurnsFromMarkerDisk: () => false,
    crossPrincipalIsolationOn: () => false,
    send: vi.fn(),
    log: vi.fn(),
  };
  scope.markTurnRetired = (turnId?: string) => { if (turnId) scope.retiredTurnIds.add(turnId); };
  scope.setCaptureIdentity = (turnId?: string, dispatchAttempt?: number, caller?: string) => {
    scope.currentBotmuxTurnId = turnId;
    scope.currentBotmuxDispatchAttempt = dispatchAttempt;
    scope.currentBotmuxCallerOpenId = caller;
  };
  for (const name of [
    'turnAuthorityIdentity',
    'adoptActiveTurnWhenIsolationOff',
    'activeTurnBlocks',
    'markActiveTurnStarted',
    'releaseActiveTurnAuthority',
    'releaseTerminatedActiveTurnAuthority',
    'retireTerminatedQueuedTurn',
    'advanceQueuedTypeAheadTurn',
    'emitTurnTerminal',
  ]) {
    scope[name] = loadWorkerFunction(name, scope);
  }
  return scope;
}

function startTurn(h: Record<string, any>, turnId: string): void {
  h.setCaptureIdentity(turnId);
  h.markActiveTurnStarted({ turnId });
}

describe('turn terminal releases the active turn authority', () => {
  it('does not advance authority to a type-ahead turn that ended inside its host turn', () => {
    const h = harness();
    startTurn(h, 'om_host');
    // Typed ahead while the host ran; Claude absorbed it into the host turn.
    h.queuedTypeAheadTurns.push({ turnId: 'om_absorbed' });

    h.emitTurnTerminal('om_host', 'completed');
    h.emitTurnTerminal('om_absorbed', 'completed');
    // The prompt-ready edge that follows tries to advance queued attribution.
    h.advanceQueuedTypeAheadTurn('prompt_ready');

    expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
    expect(h.queuedTypeAheadTurns).toEqual([]);
    expect(h.retiredTurnIds.has('om_absorbed')).toBe(true);
    // A silent scheduled fire must be deliverable again.
    expect(h.activeTurnBlocks({ turnId: 'schedule:task:1', queueAfterActiveTurn: true })).toBe(false);
  });

  it('frees an authority still held by a turn whose terminal already went out', () => {
    const h = harness();
    startTurn(h, 'schedule:task:1');
    h.emitTurnTerminal('schedule:task:1', 'completed');
    // Wedged state: a lagging advance re-attached the finished turn.
    startTurn(h, 'schedule:task:1');
    expect(h.activeTurnBlocks({ turnId: 'schedule:task:2', queueAfterActiveTurn: true })).toBe(true);

    // The next real turn's terminal does not match the stale holder exactly.
    h.emitTurnTerminal('om_next', 'completed');

    expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
    expect(h.activeTurnBlocks({ turnId: 'schedule:task:2', queueAfterActiveTurn: true })).toBe(false);
  });

  it('keeps a live authority when an unrelated terminal arrives', () => {
    const h = harness();
    startTurn(h, 'om_running');
    h.emitTurnTerminal('om_superseded', 'completed');
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('om_running');
  });

  it('keeps a queued retry of the same turn under another dispatch attempt', () => {
    const h = harness();
    startTurn(h, 'om_running');
    h.queuedTypeAheadTurns.push({ turnId: 'om_retry', dispatchAttempt: 2 });
    h.emitTurnTerminal('om_retry', 'failed', 'x', 1);
    expect(h.queuedTypeAheadTurns).toEqual([{ turnId: 'om_retry', dispatchAttempt: 2 }]);
    expect(h.retiredTurnIds.has('om_retry')).toBe(false);
  });
});
