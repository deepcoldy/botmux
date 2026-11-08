/**
 * Worker wiring of the Kimi activity observer: the real worker functions
 * (emitTurnTerminal, markPromptReady and the Kimi helpers), run through the
 * worker function harness with a fake observer.
 *
 * Kimi accepts no input while a turn runs, so whatever its log holds when a
 * turn ends belongs to that turn. The worker must read it synchronously at the
 * two edges below, BEFORE the edge is published, or the 1 s poll hands the
 * tail of turn A to turn B (and the card of A settles without it).
 */
import { describe, expect, it, vi } from 'vitest';
import type { CotEntry } from '../src/types.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { decideQueuedReadyTransition } from '../src/core/queued-ready-transition.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const tail: CotEntry = { kind: 'tool_call', id: 'tool_tail', name: 'Bash', args: '{}', subject: 'ls' };

/** Shared scope: a fake observer whose log holds `pending`, and an event
 *  trace of what the worker published, in order. */
function kimiScope(pending: CotEntry[] = [tail]) {
  const events: string[] = [];
  const scope: Record<string, any> = {
    kimiActivityObserver: { drain: vi.fn(() => pending.splice(0)) },
    thinkingTurn: undefined,
    observeCotEntries: vi.fn((entries: CotEntry[], turn: { turnId: string; dispatchAttempt?: number }) => {
      events.push(`activity:${turn.turnId}:${entries.map(e => (e.kind === 'tool_call' ? e.id : e.kind)).join(',')}`);
      scope.thinkingTurn = turn;
    }),
    flushThinkingUpdate: vi.fn(() => events.push('flush')),
    send: vi.fn((msg: { type: string; turnId?: string }) => events.push(msg.turnId ? `${msg.type}:${msg.turnId}` : msg.type)),
    log: vi.fn(),
  };
  scope.drainKimiActivityInto = loadWorkerFunction('drainKimiActivityInto', scope);
  scope.settleKimiActivityBeforeIdle = loadWorkerFunction('settleKimiActivityBeforeIdle', scope);
  return { scope, events };
}

describe('Kimi activity reaches the turn it belongs to', () => {
  it('publishes the ending turn\'s activity before its terminal', () => {
    const { scope, events } = kimiScope();
    Object.assign(scope, {
      sessionId: 'sid', currentBotmuxTurnId: 'om_A', currentBotmuxDispatchAttempt: 2,
      traexQuotaPending: undefined, traexModelAccessSwitchNotice: undefined,
      submitFailureChains: new Map(), cliSpawnGeneration: 1,
      cancelSubmitFailureChainForTerminal: vi.fn(),
      emittedTurnTerminals: { claim: () => true },
      lastTurnFailureSurfacedAtMs: undefined, traexAutoModelController: undefined,
      turnExecutionClock: { settle: () => undefined, forget: vi.fn() },
      codexBridgeQueue: { dropPendingTurn: () => false },
      releaseActiveTurnAuthority: () => true,
      retireTerminatedQueuedTurn: vi.fn(),
      terminalReleasesDurableTurn: () => false,
      remoteRunnerRecoveredTurnInFlight: false,
      sandboxRelayCapability: null,
      completeManagedTurnOriginRevocation: vi.fn(),
      flushPending: vi.fn(),
      queueMicrotask: (fn: () => void) => fn(),
    });
    loadWorkerFunction('emitTurnTerminal', scope)('om_A', 'completed', undefined, 2);
    expect(events.slice(0, 3)).toEqual(['activity:om_A:tool_tail', 'flush', 'turn_terminal:om_A']);
  });

  it('publishes the finished turn\'s activity before the prompt_ready that settles it', () => {
    const { scope, events } = kimiScope();
    const authority = new ActiveTurnAuthority();
    Object.assign(scope, {
      currentBotmuxTurnId: 'om_A', currentBotmuxDispatchAttempt: undefined,
      isPromptReady: false, isFlushing: false, durableTurnInFlight: false,
      preserveActiveTurnAuthorityForReady: false,
      lastInitConfig: { cliId: 'kimi' }, effectiveBackendType: 'tmux',
      activeTurnAuthority: authority, pendingMessages: [], pendingRawInputs: [],
      pendingAdoptMessages: [], pendingSessionRename: null, pendingInjections: [],
      isCodexAppCliId: () => false,
      hasStructuredLifecycleBlock: () => false,
      crossPrincipalIsolationOn: () => false,
      releaseActiveTurnAuthority: vi.fn(() => authority.clear()),
      idleDetector: { isStartupPending: () => false, adoptPromptReady: vi.fn() },
      backend: {}, cliAdapter: {},
      currentInputDeliveryQuarantine: () => false,
      holdForNativeSessionFork: () => false,
      probeStartupBlocker: () => false,
      readyGate: { shouldHold: () => false },
      queuedTurnAdvanceConsumedForPrompt: false,
      ptyOutputGeneration: { snapshot: () => 1 }, queuedTypeAheadTurns: [], promptReadyEdges: 0,
      decideQueuedReadyTransition, inflightInputs: { onTurnComplete: vi.fn() },
      backgroundTaskTracker: { pendingTurnAgents: () => 0 },
      freshnessInputQueue: { onPromptReady: vi.fn() },
      flushPending: vi.fn(),
      bridgeQueue: { cliQueueDrained: vi.fn() },
    });
    for (const name of ['traexFirstPromptViewportRejects', 'currentPostTerminalInputFence',
      'spawnArgvTurnStartGateHolds', 'syncQueuedTurnsFromMarkerDisk', 'shouldFlushInjectionsFirst']) scope[name] = () => false;
    for (const name of ['stopStructuredStartGraceRecheck', 'stopBusyPatternIdleProbe',
      'judgeClaudeBridgeTurn', 'settleSessionRenameOnPrompt', 'releaseRawInputRestartGate',
      'maybeEmitWorkflowTranscriptOutput', 'refreshBackgroundWait', 'settleRestartAttemptOnReady',
      'releaseInterruptedStructuredBridgeOnFirstPrompt']) scope[name] = vi.fn();
    loadWorkerFunction('markPromptReady', scope)();
    const ready = events.indexOf('prompt_ready');
    expect(ready).toBeGreaterThan(0);
    expect(events.slice(0, ready)).toEqual(['activity:om_A:tool_tail', 'flush']);
  });

  it('is inert for every other CLI (no observer)', () => {
    const { scope, events } = kimiScope();
    Object.assign(scope, { kimiActivityObserver: undefined, currentBotmuxTurnId: 'om_A' });
    scope.settleKimiActivityBeforeIdle();
    scope.drainKimiActivityInto({ turnId: 'om_A' });
    expect(events).toEqual([]);
    expect(scope.observeCotEntries).not.toHaveBeenCalled();
  });
});

describe('Kimi activity observer startup guards', () => {
  /** Records construction args instead of touching the filesystem. */
  function makeFakeObserverClass() {
    const instances: Array<{ opts: Record<string, unknown>; started: boolean; stops: number }> = [];
    class FakeObserver {
      started = false;
      stops = 0;
      constructor(public opts: Record<string, unknown>) { instances.push(this); }
      start() { this.started = true; }
      stop() { this.stops++; }
    }
    return { FakeObserver, instances };
  }

  function startupScope() {
    const scope: Record<string, any> = {
      kimiActivityObserver: undefined,
      lastResolvedSandboxMode: undefined,
      currentBotmuxTurnId: undefined,
      currentBotmuxDispatchAttempt: undefined,
      log: vi.fn(),
    };
    scope.stopKimiActivityObserver = loadWorkerFunction('stopKimiActivityObserver', scope);
    scope.startKimiActivityObserver = loadWorkerFunction('startKimiActivityObserver', scope);
    const start = (cfg: Record<string, unknown>) => scope.startKimiActivityObserver({
      cfg, resume: false, resumeLookupSessionId: 'adapter-sid',
      workingDir: '/work', env: { KIMI_CODE_HOME: '/home' },
    });
    return { scope, start };
  }

  it('never starts under the scratch COW sandbox (host cannot see the overlay log)', () => {
    const { scope, start } = startupScope();
    const { FakeObserver, instances } = makeFakeObserverClass();
    scope.KimiActivityObserver = FakeObserver;
    scope.lastResolvedSandboxMode = 'scratch';
    start({ cliId: 'kimi', adoptMode: false, sessionId: 'om_s' });
    expect(scope.kimiActivityObserver).toBeUndefined();
    expect(instances).toHaveLength(0);
  });

  it('never starts in adopt mode', () => {
    const { scope, start } = startupScope();
    const { FakeObserver, instances } = makeFakeObserverClass();
    scope.KimiActivityObserver = FakeObserver;
    start({ cliId: 'kimi', adoptMode: true, sessionId: 'om_s' });
    expect(scope.kimiActivityObserver).toBeUndefined();
    expect(instances).toHaveLength(0);
  });

  it('never starts for another CLI even with the sandbox resolved', () => {
    const { scope, start } = startupScope();
    const { FakeObserver, instances } = makeFakeObserverClass();
    scope.KimiActivityObserver = FakeObserver;
    scope.lastResolvedSandboxMode = 'off';
    start({ cliId: 'codex', adoptMode: false, sessionId: 'om_s' });
    expect(scope.kimiActivityObserver).toBeUndefined();
    expect(instances).toHaveLength(0);
  });

  it('starts for a normal kimi spawn with adapter-resolved ids/env, and restarts cleanly', () => {
    const { scope, start } = startupScope();
    const { FakeObserver, instances } = makeFakeObserverClass();
    scope.KimiActivityObserver = FakeObserver;
    start({ cliId: 'kimi', adoptMode: false, sessionId: 'om_marker' });
    expect(instances).toHaveLength(1);
    expect(instances[0].started).toBe(true);
    expect(instances[0].opts).toMatchObject({
      botmuxSessionId: 'adapter-sid',
      markerSessionId: 'om_marker',
      workingDir: '/work',
      env: { KIMI_CODE_HOME: '/home' },
      resume: false,
    });
    expect(scope.kimiActivityObserver).toBe(instances[0]);
    // A second spawn stops the previous observer before replacing it.
    start({ cliId: 'kimi', adoptMode: false, sessionId: 'om_marker2' });
    expect(instances[0].stops).toBe(1);
    expect(instances).toHaveLength(2);
    expect(scope.kimiActivityObserver).toBe(instances[1]);
  });
});
