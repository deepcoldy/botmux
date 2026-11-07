/**
 * The worker's half of a failed turn's diagnostics (design 2026-11-03 §12 E14):
 * only a session whose init asked for them (the draft clarifier's) reads the
 * screen, only for a failed or ambiguous terminal, and masks both fields
 * before the IPC; every other worker's turn_terminal keeps master's shape. The
 * first init decides: a later init (a queued turn's handoff) cannot flip it.
 */
import { describe, expect, it, vi } from 'vitest';

import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { isOrdinaryImTurnId } from '../src/core/ordinary-im-turn.js';
import { turnFailureDiagnostics } from '../src/services/turn-failure-diagnostics.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

const PLAIN_TERMINAL_KEYS = new Set([
  'type', 'sessionId', 'turnId', 'status', 'dispatchAttempt', 'errorCode',
  'outputDisposition', 'retryable', 'completedAtMs', 'durationMs',
]);
const RAW_ERROR = 'API Error: Authorization: Bearer abcdefghij0123456789';
const SCREEN = '$ cli\n  API Error: 403 api_key=zyxwvut98765 denied\n> ';

function worker(capture: boolean | undefined) {
  const scope: Record<string, any> = {
    sessionId: 'sid',
    currentBotmuxTurnId: undefined,
    currentBotmuxDispatchAttempt: undefined,
    currentBotmuxCallerOpenId: undefined,
    currentBotmuxLinkRefMode: undefined,
    currentVcMeetingImTurnOrigin: undefined,
    currentTurnSteerPromoted: false,
    queuedTurnAdvanceConsumedForPrompt: false,
    rememberQueuedTurnAdvanceForPendingReady: vi.fn(),
    queuedTypeAheadTurns: [],
    retiredTurnIds: new Set<string>(),
    activeTurnAuthority: new ActiveTurnAuthority(),
    emittedTurnTerminals: new TurnTerminalDeduper(),
    submitFailureChains: new Map(),
    cliSpawnGeneration: 1,
    cancelSubmitFailureChainForTerminal: vi.fn(),
    turnExecutionClock: { settle: () => ({ completedAtMs: 1000, durationMs: 5 }), forget: vi.fn() },
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
    turnFailureScreen: vi.fn(() => SCREEN),
    turnFailureDiagnostics,
  };
  if (capture !== undefined) scope.captureTurnFailureDiagnostics = capture;
  scope.markTurnRetired = (turnId?: string) => { if (turnId) scope.retiredTurnIds.add(turnId); };
  for (const name of [
    'turnAuthorityIdentity', 'adoptActiveTurnWhenIsolationOff', 'activeTurnBlocks', 'markActiveTurnStarted',
    'releaseActiveTurnAuthority', 'releaseTerminatedActiveTurnAuthority', 'retireTerminatedQueuedTurn',
    'advanceQueuedTypeAheadTurn', 'emitTurnTerminal', 'dropQueuedTurnRecord', 'turnTerminalEmitted',
    'retireTerminatedMarkerTurn',
  ]) scope[name] = loadWorkerFunction(name, scope);
  return scope;
}

const terminals = (scope: Record<string, any>) =>
  scope.send.mock.calls.map((call: any[]) => call[0]).filter((m: any) => m.type === 'turn_terminal');

describe('a session that did not ask for diagnostics', () => {
  it.each([[false], [undefined]] as const)('(flag %s) never reads the screen; its terminals keep the plain shape', (flag) => {
    const w = worker(flag);
    (['failed', 'ambiguous', 'cancelled', 'completed'] as const).forEach((status, i) => {
      const failing = status !== 'completed';
      w.emitTurnTerminal(`om_t${i}`, status, failing ? 'provider_x' : undefined, 2, undefined,
        failing ? true : undefined, undefined, RAW_ERROR);
    });
    expect(w.turnFailureScreen).not.toHaveBeenCalled();
    const sent = terminals(w);
    expect(sent).toHaveLength(4);
    for (const message of sent) {
      for (const key of Object.keys(message)) expect(PLAIN_TERMINAL_KEYS.has(key)).toBe(true);
    }
  });
});

describe('the draft clarifier\'s session', () => {
  it('reads the screen only for failed and ambiguous, and sends both fields masked', () => {
    const w = worker(true);
    w.emitTurnTerminal('om_c', 'completed');
    w.emitTurnTerminal('om_x', 'cancelled', 'cancelled');
    expect(w.turnFailureScreen).not.toHaveBeenCalled();
    w.emitTurnTerminal('om_f', 'failed', 'provider_permission_denied', undefined, undefined, false, undefined, RAW_ERROR);
    w.emitTurnTerminal('om_a', 'ambiguous', 'write_input_threw');
    expect(w.turnFailureScreen).toHaveBeenCalledTimes(2);

    const [completed, cancelled, failed, ambiguous] = terminals(w);
    for (const plain of [completed, cancelled]) {
      expect(plain).not.toHaveProperty('errorDetail');
      expect(plain).not.toHaveProperty('screenTail');
    }
    expect(failed.errorDetail).toContain('API Error');
    expect(failed.screenTail).toContain('API Error: 403');
    expect(ambiguous.screenTail).toContain('API Error: 403');
    expect(ambiguous).not.toHaveProperty('errorDetail');
    expect(JSON.stringify([failed, ambiguous])).not.toMatch(/abcdefghij0123456789|zyxwvut98765/);
  });
});

describe('the first init decides', () => {
  function initialized(flag: boolean) {
    return {
      lastInitConfig: { type: 'init', turnId: 'om_first' } as any,
      initHandoffRejectedTurnId: undefined,
      isOrdinaryImTurnId,
      receiveOrdinaryImTurn: vi.fn(() => 'inflight'),
      acknowledgeTurnInputCommitted: vi.fn(),
      send: vi.fn(),
      log: vi.fn(),
      captureTurnFailureDiagnostics: flag,
    } as Record<string, any>;
  }

  it('off stays off when a later init asks for diagnostics', async () => {
    const scope = initialized(false);
    const handle = loadWorkerMessageHandler('init', scope);
    await handle({ type: 'init', captureTurnFailureDiagnostics: true, turnId: 'om_second', prompt: 'hi' });
    await handle({ type: 'init', captureTurnFailureDiagnostics: true, turnId: 'om_first', prompt: 'hi' });
    expect(scope.captureTurnFailureDiagnostics).toBe(false);
  });

  it('on stays on when a later init omits it', async () => {
    const scope = initialized(true);
    const handle = loadWorkerMessageHandler('init', scope);
    await handle({ type: 'init', turnId: 'om_second', prompt: 'hi' });
    expect(scope.captureTurnFailureDiagnostics).toBe(true);
  });
});
