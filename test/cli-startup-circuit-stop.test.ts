/**
 * Executes the real worker stop / restart / terminal functions, with real
 * input carry-over, terminal dedupe and turn clocks. Only OS/backend, IPC and
 * unrelated UI boundaries are injected. No worker process or live services.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isCliStartupFailure } from '../src/core/cli-startup-failure.js';
import { InflightInputTracker, type InflightItem } from '../src/core/inflight-input-tracker.js';
import { classifyRestartTeardown } from '../src/adapters/backend/destroy-result.js';
import { isRemoteBackendType } from '../src/core/persistent-backend.js';
import { decideRestartFollowup, restartLaunchSettings } from '../src/core/restart-followup-policy.js';
import { exitMarksServerReplaced, restartSpendsFreshBudget } from '../src/core/restart-fresh-budget.js';
import { InputDeliveryEvidenceTracker } from '../src/services/input-delivery-evidence.js';
import { TurnExecutionClock } from '../src/services/turn-execution-clock.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { isStructuredBridgeLifecycleBlockingCli } from '../src/services/structured-bridge-clis.js';
import { isOrdinaryImTurnId } from '../src/core/ordinary-im-turn.js';
import { InputTurnDeduper } from '../src/core/input-turn-dedupe.js';
import { TraexNativeContinuationTracker } from '../src/core/traex-native-continuation.js';
import { dropNoReplayPendingInputsOnBackendExit, handoffQueuedDurableInputsOnBackendExit, terminalReleasesDurableTurn } from '../src/utils/pending-input-queue.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

type Terminal = { type: string; turnId: string; status: string; errorCode?: string; retryable?: boolean; durationMs?: number };
type Restart = (reason: string, opts?: {
  immediate?: boolean;
  preservePending?: boolean;
  onRespawnSettled?: (result: 'spawned' | 'failed' | 'superseded') => void;
}) => Promise<void>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const item = (turnId: string, dispatchAttempt?: number): InflightItem => ({ content: `input:${turnId}`, turnId, dispatchAttempt });

function harness(cliId = 'pi', backendType = 'pty') {
  const terminals: Terminal[] = [];
  const scope: Record<string, any> = {
    sessionId: 'startup-test', lastInitConfig: { cliId, sessionId: 'startup-test', workingDir: '/fixture/project' },
    backend: null, effectiveBackendType: backendType,
    cliSpawnGeneration: 1, cliRestartEpoch: 0, cliRestartInProgress: false, replacementSpawnInProgress: false,
    rawInputRestartGate: false, tmuxRestartTimer: null, consecutiveInWorkerRestarts: 0,
    lastCliExitServerReplaced: false, intentionallyRetiredBackends: new WeakSet(),
    awaitingFirstPrompt: true, isPromptReady: false, crashDiagnosticStopped: false,
    pendingMessages: [] as InflightItem[], pendingRawInputs: [] as unknown[],
    inflightInputs: new InflightInputTracker(), emittedTurnTerminals: new TurnTerminalDeduper(),
    turnExecutionClock: new TurnExecutionClock(), inputDeliveryEvidence: new InputDeliveryEvidenceTracker(),
    submitFailureChains: new Map(), queuedActivationReceipts: new Map(), codexBridgeQueue: new CodexBridgeQueue(),
    classifyRestartTeardown, isRemoteBackendType, decideRestartFollowup, restartLaunchSettings, restartSpendsFreshBudget,
    terminalReleasesDurableTurn,
    // Jitter is an injected scheduling boundary, not a production constant.
    tmuxRestartJitterMs: () => 137,
    stopScreenUpdates: vi.fn(), stopStuckDetector: vi.fn(), stopSpawnArgvTurnStartFailOpen: vi.fn(),
    startScreenUpdates: vi.fn(), startStuckDetector: vi.fn(), stopOwnedSessionScope: vi.fn(),
    revokeManagedTurnOriginForRestart: vi.fn(), adoptPendingLaunchConvergence: vi.fn(),
    codexRpcEligible: () => false, sandboxEnabled: () => false, traexAutoModelRuntimeEligible: () => false,
    prepareCodexNativeTitleGeneration: vi.fn(async () => {}), settleRestartAttemptOnReady: vi.fn(),
    releaseRawInputRestartGate: vi.fn(), flushPending: vi.fn(async () => {}),
    sendFatalWorkerErrorAndExit: vi.fn(async () => {}), CliSpawnSupersededError: class extends Error {},
    cancelSubmitFailureChainForTerminal: vi.fn(), releaseActiveTurnAuthority: () => true,
    scheduleConsumedQueuedTurnAdvance: vi.fn(), retireTerminatedQueuedTurn: vi.fn(),
    turnFailedWithoutOutput: () => false, recoverDeferredPromptReadyAtTurnTerminal: vi.fn(),
    log: vi.fn(), send: vi.fn((terminal: Terminal) => terminals.push(terminal)),
    parkCrashDiagnosticTerminal: vi.fn(),
    applyWorkerLaunchModel: vi.fn(), respawnConfigPatchFromMessage: vi.fn(() => ({})),
    applyRespawnConfigPatch: vi.fn(), isOrdinaryImTurnId,
    activeTurnBlocks: () => false,
    activeTurnAuthority: { snapshot: () => undefined, beginTurn: vi.fn() },
    usageLimitTracker: { beginTurn: () => 0 },
    currentUsageLimitSnapshot: () => ({}),
    rememberTurnLinkRefMode: vi.fn(),
    traexRuntimeLeaseContext: undefined, traexSpawnLeaseContext: undefined,
    traexLeaseSettlements: new Set(),
    turnInputCommitDeferredForMaterialization: new WeakSet(),
    pendingTraexSpawnAbandon: undefined, stopTraexLeaseHeartbeat: vi.fn(),
    settleTraexLeasesForShutdown: vi.fn(async () => {}),
  };
  scope.killCli = vi.fn(() => { scope.backend = null; scope.isPromptReady = false; });
  scope.ordinaryImTurnDedupe = new InputTurnDeduper(256);
  scope.acknowledgeTurnInputReceived = vi.fn();
  scope.receiveOrdinaryImTurn = loadWorkerFunction('receiveOrdinaryImTurn', scope);
  scope.acknowledgeTurnInputCommitted = loadWorkerFunction('acknowledgeTurnInputCommitted', scope);
  scope.sendToPty = loadWorkerFunction('sendToPty', scope);
  scope.spawnCli = vi.fn(async () => { scope.backend = { destroySession: vi.fn() }; });
  scope.emitTurnTerminal = loadWorkerFunction('emitTurnTerminal', scope);
  scope.stopStartupFailedInputs = loadWorkerFunction('stopStartupFailedInputs', scope);
  scope.restartCliProcess = loadWorkerFunction<Restart>('restartCliProcess', scope);
  const park = loadWorkerMessageHandler('park_diagnostic', scope);
  const stop = () => park({ type: 'park_diagnostic', terminal: false, failPending: true });
  const restart = (onRespawnSettled?: (result: 'spawned' | 'failed' | 'superseded') => void) =>
    (scope.restartCliProcess as Restart)('test recovery', { preservePending: true, onRespawnSettled });
  return { scope, terminals, stop, restart };
}

describe('startup circuit stops the exact failed input batch', () => {
  it.each(['pi', 'claude-code', 'codex'])('terminalizes queued, unstarted and started carry-over once for %s', async cliId => {
    const h = harness(cliId);
    h.scope.pendingMessages.push(item('queued'), item('durable', 2));
    h.scope.pendingRawInputs.push({ content: '/help', turnId: 'raw' });
    h.scope.inflightInputs.onWrite(item('unstarted'));
    h.scope.turnExecutionClock.start('unstarted');
    h.scope.inflightInputs.onWrite(item('started'));
    h.scope.turnExecutionClock.start('started');
    h.scope.inflightInputs.onTurnStarted('started');
    await vi.advanceTimersByTimeAsync(250);
    h.scope.inflightInputs.onCliExit();
    await h.stop();
    await h.stop();
    expect(h.terminals.map(t => t.turnId)).toEqual(['queued', 'unstarted', 'started']);
    for (const terminal of h.terminals) {
      expect(terminal).toMatchObject({ type: 'turn_terminal', status: 'failed', errorCode: 'cli_startup_failed', retryable: false });
    }
    expect(h.terminals[0].durationMs).toBeUndefined();
    expect(h.terminals.slice(1).map(t => t.durationMs)).toEqual([250, 250]);
    expect(h.scope.pendingMessages).toEqual([]);
    expect(h.scope.pendingRawInputs).toEqual([]);
    expect(h.scope.inflightInputs.takeCarryOver()).toEqual([]);
    expect(h.scope.inflightInputs.takeStartedCarryOver()).toEqual([]);
    expect(h.scope.parkCrashDiagnosticTerminal).not.toHaveBeenCalled();
    expect(h.scope.crashDiagnosticStopped).toBe(true);
  });

  it('retains unsubmitted tokened activation inputs across the circuit and the next coordinated restart', async () => {
    const h = harness();
    const raw = { content: '/goal original', turnId: 'opening', queuedActivationToken: 'raw-token' };
    const opening = { ...item('text-opening'), queuedActivationToken: 'text-token' };
    h.scope.pendingRawInputs.push(raw, { content: '/help', turnId: 'ordinary-raw' });
    h.scope.pendingMessages.push(opening, item('ordinary'));
    await h.stop();
    expect(h.scope.pendingRawInputs).toEqual([raw]);
    expect(h.scope.pendingMessages).toEqual([opening]);
    expect(h.terminals.map(t => t.turnId)).toEqual(['ordinary']);
    expect(h.scope.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queued_activation_submitted' }));
    await h.restart();
    await vi.runAllTimersAsync();
    expect(h.scope.spawnCli).toHaveBeenCalledOnce();
    expect(h.scope.pendingRawInputs).toEqual([raw]);
    expect(h.scope.pendingMessages).toEqual([opening]);
  });

  it('keeps an acknowledged manual cancellation terminal, without replaying or failing that turn again', async () => {
    const h = harness();
    h.scope.inflightInputs.onWrite(item('cancelled'));
    h.scope.inflightInputs.onWrite(item('other'));
    h.scope.inflightInputs.onCliExit();
    await vi.advanceTimersByTimeAsync(50);
    h.scope.inflightInputs.retireTurn('cancelled');
    h.scope.emitTurnTerminal('cancelled', 'cancelled', 'stopped_before_start');
    await h.stop();
    expect(h.terminals.map(t => [t.turnId, t.status])).toEqual([['cancelled', 'cancelled'], ['other', 'failed']]);
  });

  it('does not stop a slow but still living CLI or consume its queued inputs', async () => {
    const h = harness();
    const live = { destroySession: vi.fn() };
    h.scope.backend = live;
    h.scope.pendingMessages.push(item('waiting'));
    h.scope.inflightInputs.onWrite(item('written'));
    const timer = vi.fn();
    h.scope.tmuxRestartTimer = setTimeout(timer, 100);
    h.scope.stopStartupFailedInputs();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.scope.backend).toBe(live);
    expect(h.scope.pendingMessages.map((i: InflightItem) => i.turnId)).toEqual(['waiting']);
    expect(h.scope.inflightInputs.hasUnacked()).toBe(true);
    expect(h.terminals).toEqual([]);
    expect(timer).toHaveBeenCalledOnce();
    expect(h.scope.stopScreenUpdates).not.toHaveBeenCalled();
  });

  it('finishes the batch and requests fatal reconciliation after a commit-unknown terminal send', async () => {
    const h = harness();
    h.scope.pendingMessages.push(item('first'), item('second'), item('third'));
    h.scope.pendingRawInputs.push({ content: '/help' });
    const wireFailure = new Error('injected terminal transport failure');
    h.scope.send.mockImplementationOnce((terminal: Terminal) => h.terminals.push(terminal))
      .mockImplementationOnce(() => { throw wireFailure; });
    let atFatal: unknown;
    h.scope.sendFatalWorkerErrorAndExit.mockImplementationOnce(async () => {
      atFatal = {
        pending: h.scope.pendingMessages.length,
        raw: h.scope.pendingRawInputs.length,
        delivered: h.terminals.map(t => t.turnId),
      };
    });
    await h.stop();
    await vi.runAllTimersAsync();
    expect(h.scope.sendFatalWorkerErrorAndExit).toHaveBeenCalledOnce();
    expect(atFatal).toEqual({ pending: 0, raw: 0, delivered: ['first', 'third'] });
    expect(h.scope.send).toHaveBeenCalledTimes(3);
    // Fatal recovery belongs to daemon worker-exit reconciliation. Do NOT
    // retry stop in this generation or roll back the commit-unknown claim.
    for (const turnId of ['first', 'second', 'third']) {
      expect(h.scope.emittedTurnTerminals.statusOf('startup-test', turnId)).toBe('failed');
    }
    expect(h.scope.inflightInputs.takeCarryOver()).toEqual([]);
    expect(h.scope.inflightInputs.takeStartedCarryOver()).toEqual([]);
  });

  it('ignores delayed park IPC after a human has already installed a living replacement', async () => {
    const h = harness();
    const replacement = { destroySession: vi.fn() };
    h.scope.backend = replacement;
    h.scope.pendingMessages.push(item('new-batch'));
    await h.stop();
    expect(h.scope.crashDiagnosticStopped).toBe(false);
    expect(h.scope.backend).toBe(replacement);
    expect(h.scope.pendingMessages.map((i: InflightItem) => i.turnId)).toEqual(['new-batch']);
    expect(h.terminals).toEqual([]);
  });
});

describe('startup circuit versus delayed / in-flight restart continuations', () => {
  it.each(['tmux', 'hc'])('cancels the %s jitter before teardown or respawn', async backendType => {
    const h = harness('pi', backendType);
    await h.restart();
    await h.stop();
    await vi.runAllTimersAsync();
    expect(h.scope.killCli).not.toHaveBeenCalled();
    expect(h.scope.spawnCli).not.toHaveBeenCalled();
  });

  it('invalidates the respawn timer after teardown, and leaves a later manual launch usable', async () => {
    const h = harness();
    await h.restart();
    expect(h.scope.killCli).toHaveBeenCalledOnce();
    await h.stop();
    await vi.runAllTimersAsync();
    expect(h.scope.spawnCli).not.toHaveBeenCalled();
    await h.restart();
    await vi.runAllTimersAsync();
    expect(h.scope.spawnCli).toHaveBeenCalledOnce();
    expect(h.scope.backend).not.toBeNull();
    expect(h.scope.cliRestartInProgress).toBe(false);
    expect(h.scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();
  });

  it.each([false, true])('replacement exits during title initialization: stopped=%s prevents only the stopped follow-up', async stopped => {
    const h = harness('codex');
    const title = deferred();
    h.scope.prepareCodexNativeTitleGeneration.mockImplementationOnce(() => title.promise);
    await h.restart();
    await vi.advanceTimersToNextTimerAsync();
    expect(h.scope.spawnCli).toHaveBeenCalledOnce();
    expect(h.scope.cliRestartInProgress).toBe(true);
    h.scope.backend = null; // synchronous backend onExit boundary
    if (stopped) await h.stop();
    title.resolve();
    // Let the title continuation enqueue its follow-up before draining timers.
    // Bun's runAllTimersAsync shim does not recursively drain new microtasks.
    await title.promise;
    await vi.runAllTimersAsync();
    expect(h.scope.spawnCli).toHaveBeenCalledTimes(stopped ? 1 : 2);
    expect(h.scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();
  });

  it.each(['pty', 'tmux', 'hc'])('settles a %s restart cancelled in the delay instead of abandoning its completion callback', async backendType => {
    const h = harness('pi', backendType);
    const settled = vi.fn();
    await h.restart(settled);
    await h.stop();
    await vi.runAllTimersAsync();
    expect(h.scope.spawnCli).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith(expect.stringMatching(/^(failed|superseded)$/));
  });

  it.each(['plugin', 'rpc'])('does not launch from an old callback when the circuit opens during awaited %s preparation', async stage => {
    const h = harness('codex');
    const plugin = deferred();
    h.scope.codexRpcEligible = () => true;
    h.scope.createCliAdapterSync = vi.fn(() => ({}));
    h.scope.prepareCliPluginGenerationAndGateway = vi.fn(() => stage === 'plugin' ? plugin.promise : Promise.resolve());
    h.scope.engageCodexRpc = vi.fn(() => stage === 'rpc' ? plugin.promise : Promise.resolve());
    await h.restart();
    await vi.advanceTimersToNextTimerAsync();
    expect(h.scope.prepareCliPluginGenerationAndGateway).toHaveBeenCalledOnce();
    expect(h.scope.spawnCli).not.toHaveBeenCalled();
    await h.stop();
    plugin.resolve();
    await vi.runAllTimersAsync();
    if (stage === 'plugin') expect(h.scope.engageCodexRpc).not.toHaveBeenCalled();
    expect(h.scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();
    expect(h.scope.spawnCli).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'])('does not clear a newer manual replacement fence when the stopped title promise ends with %s', async completion => {
    const h = harness('codex');
    const oldTitle = deferred();
    const newSpawn = deferred();
    h.scope.prepareCodexNativeTitleGeneration.mockImplementationOnce(() => oldTitle.promise);
    await h.restart();
    await vi.advanceTimersToNextTimerAsync();
    expect(h.scope.spawnCli).toHaveBeenCalledOnce();
    h.scope.backend = null;
    await h.stop();
    h.scope.spawnCli.mockImplementationOnce(() => newSpawn.promise);
    await h.restart(); // explicit user retry, not the old restart's follow-up
    await vi.advanceTimersToNextTimerAsync();
    expect(h.scope.replacementSpawnInProgress).toBe(true);
    if (completion === 'resolve') oldTitle.resolve();
    else oldTitle.reject(new Error('retired title request failed'));
    await vi.advanceTimersByTimeAsync(1);
    const whileNewSpawnPending = {
      replacementFence: h.scope.replacementSpawnInProgress,
      restartFence: h.scope.cliRestartInProgress,
      fatalCalls: h.scope.sendFatalWorkerErrorAndExit.mock.calls.length,
    };
    // Always finish controlled promises before asserting, including red probes.
    h.scope.backend = { destroySession: vi.fn() };
    newSpawn.resolve();
    await vi.runAllTimersAsync();
    expect(whileNewSpawnPending).toEqual({ replacementFence: true, restartFence: true, fatalCalls: 0 });
    expect(h.scope.spawnCli).toHaveBeenCalledTimes(2);
    expect(h.scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();
  });
  it('cancels an old restart continuation before parent-exit waits for RPC teardown', async () => {
    const h = harness('codex');
    const title = deferred();
    const rpcStop = deferred();
    h.scope.prepareCodexNativeTitleGeneration.mockImplementationOnce(() => title.promise);
    await h.restart();
    await vi.advanceTimersToNextTimerAsync();
    expect(h.scope.spawnCli).toHaveBeenCalledOnce();
    expect(h.scope.cliRestartInProgress).toBe(true);
    h.scope.backend = null; // replacement's second startup failure
    const rpcEngine = { stopAndWait: vi.fn(() => rpcStop.promise) };
    Object.assign(h.scope, {
      stopScreenshotLoop: vi.fn(),
      codexRpcEngine: rpcEngine,
      clearRpcEnginePidMarker: vi.fn(),
      stopStructuredStartGraceRecheck: vi.fn(),
      armRpcStartupDialogDismiss: vi.fn(),
      saveUnsentInputsForSuccessor: vi.fn(),
      sandboxTreeOutlivesWorker: false,
      cliOutlivesWorker: false,
      currentBotmuxTurnId: null,
      isCodexAppCliId: () => false,
      handsCliPidMarkerToSuccessor: () => false,
      cleanup: vi.fn(),
      process: { exit: vi.fn() },
    });
    const shutdown = loadWorkerFunction<(reason: string, code: number) => Promise<void>>(
      'shutdownWorkerForParentExitImpl', h.scope,
    );
    const stopped = shutdown('SIGTERM', 0);
    const killCallsBeforeShutdown = h.scope.killCli.mock.calls.length;
    expect(rpcEngine.stopAndWait).toHaveBeenCalledOnce();
    expect(h.scope.process.exit).not.toHaveBeenCalled();

    title.resolve();
    await title.promise;
    await vi.runAllTimersAsync();
    expect(h.scope.spawnCli).toHaveBeenCalledOnce();
    expect(h.scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();

    rpcStop.resolve();
    await stopped;
    expect(h.scope.killCli).toHaveBeenCalledTimes(killCallsBeforeShutdown + 1);
    expect(h.scope.process.exit).toHaveBeenCalledWith(0);
  });
});


/** Anonymous callback counterpart of worker-function-harness. Execute the WHOLE
 * real onExit closure, not a copied startup predicate. Only its registration
 * expression is located in the AST; no assertion reads source text. This stays
 * local because this assignment only permits editing these two test files. */
let exitCallbackCode: string | undefined;
function loadBackendExit(scope: Record<string, any>): (code: number | null, signal?: number) => void {
  if (!exitCallbackCode) {
    const source = ts.createSourceFile('worker.ts', readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const callbacks: ts.ArrowFunction[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'bindSessionBackendExit' && node.arguments[0]
        && ts.isArrowFunction(node.arguments[0])) callbacks.push(node.arguments[0]);
      ts.forEachChild(node, visit);
    };
    const spawn = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'spawnCliBody');
    // Remote/adopt branches register different nested callbacks. This is the
    // fresh local backend's direct registration in spawnCliBody.
    for (const statement of spawn?.body?.statements ?? []) {
      if (ts.isExpressionStatement(statement)) visit(statement);
    }
    if (callbacks.length !== 1) throw new Error(`Expected one backend exit callback, found ${callbacks.length}`);
    exitCallbackCode = ts.transpileModule(`const exit = ${callbacks[0].getText(source)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
  }
  const proxy = new Proxy(scope, {
    has: (_target, key) => key !== Symbol.unscopables,
    get: (target, key) => key in target ? target[key as string] : (globalThis as any)[key],
    set: (target, key, value) => { target[key as string] = value; return true; },
  });
  return new Function('scope', `with (scope) { ${exitCallbackCode}; return exit; }`)(proxy);
}

function exitHarness(cliId = 'pi') {
  const h = harness(cliId);
  Object.assign(h.scope, {
    backend: {}, actuallyReattachedPersistent: false,
    spawnStartedAtMs: Date.now(), startupNativeInputSeen: false,
    // The quiet screen was heuristically accepted as ready, but has not
    // produced a single native user/final record.
    isPromptReady: true, promptReadyEdgesAtFreshCliStart: 0, promptReadyEdges: 1,
    spawnArgvNeedsWorkingSeed: false, spawnArgvTurnStartEvidenceSeen: false,
    isCliStartupFailure, isStructuredBridgeLifecycleBlockingCli, exitMarksServerReplaced, handoffQueuedDurableInputsOnBackendExit,
    dropNoReplayPendingInputsOnBackendExit,
    isCodexAppCliId: () => false, cliName: () => cliId,
    stopSessionMcpGatewayHost: vi.fn(), completeManagedTurnOriginRevocation: vi.fn(),
    cleanupCodexAppControlBootstrap: vi.fn(), stopCodexAppControlChannel: vi.fn(),
    codexAppTurnLiveness: { clear: vi.fn() }, codexAppReadyAuthority: { reset: vi.fn() },
    recentTerminalLogTail: () => '', postRejectedArgumentHint: vi.fn(), canParkCrashDiagnostic: () => false,
    revokePromptReadiness: () => { h.scope.isPromptReady = false; },
    setCaptureIdentity: vi.fn(), retiredTurnIds: new Set(), activeTurnAuthority: { clear: vi.fn() },
    // The locally-built exit-callback proxy (loadBackendExit) resolves only
    // explicit scope keys; spawnCliBody's exit path now resets the tracker.
    traexNativeContinuation: new TraexNativeContinuationTracker(),
    freshnessInputQueue: { onReplacementFailed: vi.fn() }, sandboxNamespaceDiagnosis: () => undefined,
    structuredBridgeIs: (id: string) => id === cliId, flushQueuedInputAfterTurnStartEvidence: vi.fn(),
    markReplyInputConsumed: vi.fn(),
  });
  h.scope.observedBackend = h.scope.backend;
  h.scope.freshCliNeverReady = loadWorkerFunction('freshCliNeverReady', h.scope);
  const transcript = loadWorkerFunction<(events: { kind: string }[]) => void>('noteSpawnArgvTurnStartTranscriptEvidence', h.scope);
  const consumed = loadWorkerFunction<(turnId: string, proof: string) => void>('acknowledgeNativeInputConsumed', h.scope);
  const onExit = loadBackendExit(h.scope);
  const classification = (code: number | null = 1) => {
    onExit(code);
    const exits = h.scope.send.mock.calls.map(([m]: any[]) => m).filter((m: any) => m.type === 'claude_exit');
    expect(exits).toHaveLength(1);
    return exits[0].startupFailure;
  };
  return { ...h, transcript, consumed, onExit, classification };
}

describe('native startup evidence and real backend exit classification', () => {
  it.each(['pi', 'grok', 'traex', 'codex'])('recognizes false-ready short exits with queued input for %s', async cliId => {
    const h = exitHarness(cliId);
    h.scope.pendingMessages.push(item('waiting'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.classification()).toBe(true);
    expect(h.scope.backend).toBeNull();
    expect(h.scope.pendingMessages.map((i: InflightItem) => i.turnId)).toEqual(['waiting']);
  });

  it('recognizes an input written before the short exit even after it left the pending queue', async () => {
    const h = exitHarness();
    h.scope.inflightInputs.onWrite(item('writing'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.classification()).toBe(true);
    await h.stop();
    expect(h.terminals.filter(m => m.type === 'turn_terminal').map(m => m.turnId)).toEqual(['writing']);
  });

  it.each(['user', 'assistant_final', 'native_input_consumed'])('accepts native %s evidence rather than calling a real turn a false-ready startup', async proof => {
    const h = exitHarness();
    h.scope.pendingMessages.push(item('waiting'));
    h.scope.inflightInputs.onWrite(item('working'));
    if (proof === 'native_input_consumed') h.consumed('working', 'claude_transcript_user_record');
    else h.transcript([{ kind: proof }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.classification()).toBe(false);
  });

  it('does not treat tool/thinking output as native user/final evidence', async () => {
    const h = exitHarness();
    h.scope.pendingMessages.push(item('waiting'));
    h.transcript([{ kind: 'thinking' }, { kind: 'tool_call' }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.classification()).toBe(true);
  });

  it.each([0, null])('does not call a clean/signal exit (%s) a startup failure', code => {
    const h = exitHarness();
    h.scope.pendingMessages.push(item('waiting'));
    expect(h.classification(code)).toBe(false);
  });

  it.each(['warm', 'adopt', 'no-input', 'long-running'])('does not misclassify %s as a fresh startup failure', async kind => {
    const h = exitHarness();
    if (kind !== 'no-input') h.scope.pendingMessages.push(item('waiting'));
    if (kind === 'warm') h.scope.actuallyReattachedPersistent = true;
    if (kind === 'adopt') h.scope.lastInitConfig.adoptMode = true;
    await vi.advanceTimersByTimeAsync(kind === 'long-running' ? 60_000 : 1_000);
    expect(h.classification()).toBe(false);
  });

  it('keeps startup evidence for a gone last-pane socket so daemon can decide whether shared loss is corroborated', async () => {
    const h = exitHarness();
    h.scope.pendingMessages.push(item('waiting'));
    h.scope.backend.exitedBecauseServerLost = () => ({ kind: 'gone', backend: 'tmux' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.classification()).toBe(true);
  });

  it('leaves a still-running, never-ready CLI alone across a long startup', async () => {
    const h = exitHarness();
    h.scope.isPromptReady = false;
    h.scope.promptReadyEdges = 0;
    h.scope.pendingMessages.push(item('waiting'));
    const backend = h.scope.backend;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.scope.backend).toBe(backend);
    expect(h.terminals).toEqual([]);
    // Only a real nonzero exit after that wait supplies failure evidence.
    expect(h.classification()).toBe(true);
  });

  it.each(['user', 'assistant_final'])('does not count an argv turn with native %s evidence as never-started merely because no idle prompt appeared', async proof => {
    const h = exitHarness();
    h.scope.isPromptReady = false;
    h.scope.promptReadyEdges = 0;
    h.scope.spawnArgvNeedsWorkingSeed = true;
    h.scope.inflightInputs.onWrite(item('opening'));
    h.transcript([{ kind: proof }]);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.classification()).toBe(false);
  });
});

describe('pre-ready input receipts', () => {
  it('does not acknowledge a queued message as committed before init materializes', async () => {
    const h = harness('traex');
    h.scope.initPromptMaterialized = false;
    await loadWorkerMessageHandler('message', h.scope)({
      type: 'message', content: 'pre-ready', turnId: 'om_pre_ready',
    });
    expect(h.scope.pendingMessages).toHaveLength(1);
    expect(h.scope.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'turn_input_committed', turnId: 'om_pre_ready',
    }));
  });

  it('retains a native RPC follow-up for the materialization ACK drain even before the engine exists', async () => {
    const h = harness('codex');
    h.scope.initPromptMaterialized = false;
    h.scope.deferTurnInputCommitUntilSubmission = () => true;
    await loadWorkerMessageHandler('message', h.scope)({
      type: 'message', content: 'RPC follow-up', turnId: 'om_rpc_followup',
    });
    expect(h.scope.pendingMessages).toHaveLength(1);
    expect(h.scope.turnInputCommitDeferredForMaterialization.has(h.scope.pendingMessages[0])).toBe(true);
  });

  it('cancels an exact pre-ready opening without replay and preserves human queued work', async () => {
    const h = harness('traex');
    h.scope.initPromptMaterialized = false;
    h.scope.lastInitConfig.turnId = 'schedule:cancelled';
    h.scope.cliAdapter = { passesInitialPromptViaArgs: false };
    h.scope.currentBotmuxTurnId = 'schedule:cancelled';
    h.scope.backend = null;
    h.scope.pendingMessages.push(item('schedule:cancelled'), item('om_human'));
    const cancel = loadWorkerFunction('handleQueuedTurnCancel', h.scope);
    cancel('cancel-request', 'schedule:cancelled');

    expect(h.scope.pendingMessages.map((entry: InflightItem) => entry.turnId)).toEqual(['om_human']);
    expect(h.scope.send).toHaveBeenCalledWith({
      type: 'queued_turn_cancel_result', requestId: 'cancel-request',
      turnId: 'schedule:cancelled', status: 'queued_removed',
    });
    const before = h.scope.pendingMessages.length;
    expect(h.scope.sendToPty('must not reinsert', 'schedule:cancelled')).toBe(true);
    expect(h.scope.pendingMessages).toHaveLength(before);
    expect(h.scope.pendingMessages[0].turnId).toBe('om_human');
  });

  it('reports restart_required instead of claiming a written turn was only queued', () => {
    const h = harness('traex');
    h.scope.initPromptMaterialized = true;
    h.scope.currentBotmuxTurnId = 'schedule:written';
    h.scope.backend = {};
    h.scope.inflightInputs.onWrite(item('schedule:written'));
    const cancel = loadWorkerFunction('handleQueuedTurnCancel', h.scope);
    cancel('cancel-written', 'schedule:written');
    expect(h.scope.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'queued_turn_cancel_result', turnId: 'schedule:written', status: 'restart_required',
    }));
  });

  it('never claims an argv-baked opening was removed from a pre-ready queue', () => {
    const h = harness('pi');
    h.scope.initPromptMaterialized = false;
    h.scope.lastInitConfig.turnId = 'schedule:argv';
    h.scope.cliAdapter = { passesInitialPromptViaArgs: true };
    h.scope.backend = null;
    const cancel = loadWorkerFunction('handleQueuedTurnCancel', h.scope);
    cancel('cancel-argv', 'schedule:argv');
    expect(h.scope.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'queued_turn_cancel_result', turnId: 'schedule:argv', status: 'restart_required',
    }));
  });

  it('never reports an RPC turn with submission ownership as queued_removed', () => {
    const h = harness('traex');
    h.scope.initPromptMaterialized = false;
    h.scope.lastInitConfig.turnId = 'schedule:rpc';
    h.scope.backend = null;
    h.scope.cliAdapter = { passesInitialPromptViaArgs: false };
    h.scope.rpcTurnsAwaitingActivation = new Map([['schedule:rpc\0', {}]]);
    const cancel = loadWorkerFunction('handleQueuedTurnCancel', h.scope);
    cancel('cancel-rpc', 'schedule:rpc');
    expect(h.scope.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'queued_turn_cancel_result', turnId: 'schedule:rpc', status: 'restart_required',
    }));
  });

  it('never treats a fresh RPC-eligible opening as an ordinary queued removal', () => {
    const h = harness('traex');
    h.scope.initPromptMaterialized = false;
    h.scope.lastInitConfig.turnId = 'schedule:fresh-rpc';
    h.scope.cliAdapter = { passesInitialPromptViaArgs: false };
    h.scope.codexRpcEligible = () => true;
    const cancel = loadWorkerFunction('handleQueuedTurnCancel', h.scope);
    cancel('cancel-fresh-rpc', 'schedule:fresh-rpc');
    expect(h.scope.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'queued_turn_cancel_result', turnId: 'schedule:fresh-rpc', status: 'restart_required',
    }));
  });

  it.each(['reconcile', 'remote'])('never claims a %s recovered opening was only queued', proof => {
    const h = harness('traex');
    h.scope.initPromptMaterialized = false;
    h.scope.lastInitConfig.turnId = 'schedule:recovered';
    h.scope.cliAdapter = { passesInitialPromptViaArgs: false };
    h.scope.backend = null;
    if (proof === 'reconcile') {
      h.scope.lastInitConfig.reconcileQueuedActivation = {
        turnId: 'schedule:recovered', phase: 'succeeded',
      };
    } else {
      h.scope.remoteRunnerRecoveredTurnIdentity = { turnId: 'schedule:recovered' };
    }
    const cancel = loadWorkerFunction('handleQueuedTurnCancel', h.scope);
    cancel('cancel-recovered', 'schedule:recovered');
    expect(h.scope.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'queued_turn_cancel_result', turnId: 'schedule:recovered', status: 'restart_required',
    }));
  });

  it('answers a rejected stale cancellation instead of leaving the daemon to time out', () => {
    const binding = { runtime: { runtimeId: 'runtime-current' } };
    const scope = {
      workerSessionEventScope: {
        currentBinding: () => binding,
        bindingForRuntime: () => binding,
        run: (_target: unknown, fn: () => void) => fn(),
      },
      admitSessionCommand: () => ({ allowed: false, reason: 'stale_runtime_target' }),
      send: vi.fn(), log: vi.fn(),
    };
    const dispatch = loadWorkerFunction('dispatchDaemonMessage', scope);
    dispatch({
      type: 'cancel_queued_turn', requestId: 'cancel-stale-runtime', turnId: 'schedule:stale-runtime',
      sessionCommand: { version: 2, runtime: { runtimeId: 'runtime-old' } },
    });
    expect(scope.send).toHaveBeenCalledWith({
      type: 'queued_turn_cancel_result', requestId: 'cancel-stale-runtime',
      turnId: 'schedule:stale-runtime', status: 'restart_required',
    });
  });

  it.each([false, true])('settles only the exiting backend lease when a replacement is current (running=%s)', running => {
    const h = exitHarness('traex');
    const oldLease = { release: vi.fn(async () => {}), abandon: vi.fn(async () => {}) };
    const newLease = { release: vi.fn(async () => {}), abandon: vi.fn(async () => {}) };
    const oldContext = { lease: oldLease, running, settled: false, heartbeat: undefined, abandon: vi.fn() };
    const newContext = { lease: newLease, running: false, settled: false, heartbeat: undefined, abandon: vi.fn() };
    h.scope.traexSpawnLeaseContext = oldContext;
    h.scope.traexRuntimeLeaseContext = newContext;
    h.scope.pendingTraexSpawnAbandon = newContext.abandon;
    h.scope.settleTraexSpawnLease = loadWorkerFunction('settleTraexSpawnLease', h.scope);
    const replacement = { name: 'replacement' };
    h.scope.observedBackend = { name: 'old' };
    h.scope.backend = replacement;

    h.onExit(0);
    expect(oldLease.release).toHaveBeenCalledTimes(running ? 1 : 0);
    expect(oldLease.abandon).toHaveBeenCalledTimes(running ? 0 : 1);
    expect(newLease.release).not.toHaveBeenCalled();
    expect(newLease.abandon).not.toHaveBeenCalled();
    expect(h.scope.traexRuntimeLeaseContext).toBe(newContext);
    expect(h.scope.pendingTraexSpawnAbandon).toBe(newContext.abandon);
    expect(h.scope.backend).toBe(replacement);
  });
});
