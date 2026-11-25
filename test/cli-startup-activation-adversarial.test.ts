/**
 * Real admission/restart coordinator + SQLite, and real worker stop/restart/raw
 * delivery functions. Fake clocks control every wait; OS, IPC and UI are seams.
 * Run only via scripts/fenced-run.ts. No daemon or external CLI is started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bots from '../src/bot-registry.js';
import * as store from '../src/services/session-store.js';
import * as pool from '../src/core/worker-pool.js';
import { controllerForSession } from '../src/core/session-controller.js';
import * as primary from '../src/core/session-contract-primary.js';
import { activeSessionKey } from '../src/core/types.js';
import { InflightInputTracker, type InflightItem } from '../src/core/inflight-input-tracker.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { TurnExecutionClock } from '../src/services/turn-execution-clock.js';
import { InputDeliveryEvidenceTracker } from '../src/services/input-delivery-evidence.js';
import { createQueuedActivationReceiptObserver } from '../src/services/queued-activation-receipts.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { classifyRestartTeardown } from '../src/adapters/backend/destroy-result.js';
import { isRemoteBackendType } from '../src/core/persistent-backend.js';
import { decideRestartFollowup, restartLaunchSettings } from '../src/core/restart-followup-policy.js';
import { restartSpendsFreshBudget } from '../src/core/restart-fresh-budget.js';
import { terminalReleasesDurableTurn } from '../src/utils/pending-input-queue.js';
import { finalizeRawCommandDelivery } from '../src/core/raw-command-writer.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

const APP = 'cli_activation_adversarial';
let sequence = 0;
let botConfig: Record<string, unknown>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-24T00:00:00Z'));
  botConfig = { cliId: 'pi', backendType: 'pty', larkAppId: APP, env: { FIXTURE: 'before' } };
  vi.spyOn(bots, 'getBot').mockImplementation(() => ({ config: botConfig, resolvedAllowedUsers: [] }) as any);
  store.init(APP);
  pool.__testOnly_resetRestartCoordinator();
});
afterEach(() => {
  store.__testOnly_setBeforeRowPersist(undefined);
  pool.__testOnly_resetRestartCoordinator();
  pool.setActiveSessionsRegistry(new Map());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function parked() {
  const session = store.createSession('oc_probe', `om_probe_${++sequence}`, 'raw activation');
  Object.assign(session, { cliId: 'pi', backendType: 'pty', queued: false,
    queuedActivationPending: true, queuedActivationToken: `token_${sequence}`,
    queuedActivationInput: { content: '' }, queuedActivationTurnId: 'om_opening', queuedActivationResume: false,
  });
  store.updateSession(session);
  const send = vi.fn();
  const ds: any = { session, larkAppId: APP, worker: { killed: false, send },
    workerReady: false, cliReady: false, crashDiagnosticParked: true,
    cliStartupFailureReason: 'startup failed', initialStartPending: true,
    pendingRawInput: '/goal exact raw opening', hasHistory: true,
  };
  const admit = (turnId: string) => pool.admitQueuedActivationTail(ds, {
    turnId, cliInput: { content: `input:${turnId}` }, userPrompt: `input:${turnId}`,
  });
  const disk = () => store.getSessionFresh(session.sessionId)!;
  return { ds, send, admit, disk };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function worker(cliId = 'pi', backendType = 'pty') {
  const scope: Record<string, any> = {
    sessionId: 'raw-worker', lastInitConfig: { cliId, sessionId: 'raw-worker', workingDir: '/fixture/project' },
    backend: null, effectiveBackendType: backendType, cliSpawnGeneration: 1, cliRestartEpoch: 0,
    cliRestartInProgress: false, replacementSpawnInProgress: false, rawInputRestartGate: false,
    tmuxRestartTimer: null, consecutiveInWorkerRestarts: 0, lastCliExitServerReplaced: false,
    intentionallyRetiredBackends: new WeakSet(), awaitingFirstPrompt: true, isPromptReady: false,
    crashDiagnosticStopped: false, pendingMessages: [], pendingRawInputs: [],
    inflightInputs: new InflightInputTracker(), emittedTurnTerminals: new TurnTerminalDeduper(),
    turnExecutionClock: new TurnExecutionClock(), inputDeliveryEvidence: new InputDeliveryEvidenceTracker(),
    submitFailureChains: new Map(), queuedActivationReceipts: new Map(), codexBridgeQueue: new CodexBridgeQueue(),
    classifyRestartTeardown, isRemoteBackendType, decideRestartFollowup, restartLaunchSettings,
    restartSpendsFreshBudget, terminalReleasesDurableTurn, finalizeRawCommandDelivery,
    tmuxRestartJitterMs: () => 137, stopScreenUpdates: vi.fn(), stopStuckDetector: vi.fn(),
    stopSpawnArgvTurnStartFailOpen: vi.fn(), startScreenUpdates: vi.fn(), startStuckDetector: vi.fn(),
    stopOwnedSessionScope: vi.fn(), revokeManagedTurnOriginForRestart: vi.fn(), adoptPendingLaunchConvergence: vi.fn(),
    codexRpcEligible: () => false, sandboxEnabled: () => false, traexAutoModelRuntimeEligible: () => false,
    prepareCodexNativeTitleGeneration: vi.fn(async () => {}), settleRestartAttemptOnReady: vi.fn(),
    releaseRawInputRestartGate: vi.fn(), flushPending: vi.fn(async () => {}),
    sendFatalWorkerErrorAndExit: vi.fn(async () => {}), CliSpawnSupersededError: class extends Error {},
    cancelSubmitFailureChainForTerminal: vi.fn(), releaseActiveTurnAuthority: () => true,
    scheduleConsumedQueuedTurnAdvance: vi.fn(), retireTerminatedQueuedTurn: vi.fn(),
    turnFailedWithoutOutput: () => false, recoverDeferredPromptReadyAtTurnTerminal: vi.fn(),
    log: vi.fn(), send: vi.fn(), parkCrashDiagnosticTerminal: vi.fn(),
    revokePromptReadiness: () => { scope.isPromptReady = false; },
    // The raw writer is the OS boundary: it records a command only AFTER its
    // controlled acceptance promise settles. No copy of the ACK logic here.
    sendRawCommandLineWithRecoveryFence: vi.fn(async () => {}),
  };
  scope.killCli = vi.fn(() => { scope.backend = null; scope.isPromptReady = false; });
  scope.spawnCli = vi.fn(async () => { scope.backend = { destroySession: vi.fn() }; });
  scope.emitTurnTerminal = loadWorkerFunction('emitTurnTerminal', scope);
  scope.stopStartupFailedInputs = loadWorkerFunction('stopStartupFailedInputs', scope);
  scope.restartCliProcess = loadWorkerFunction('restartCliProcess', scope);
  const park = loadWorkerMessageHandler('park_diagnostic', scope);
  const raw = { type: 'raw_input', content: '/goal exact raw opening', turnId: 'om_opening', queuedActivationToken: 'token_worker' };
  scope.pendingRawInputs.push(raw);
  return { scope, raw,
    stop: () => park({ type: 'park_diagnostic', terminal: false, failPending: true }),
    restart: () => scope.restartCliProcess('adversarial recovery', { preservePending: true }),
    deliver: loadWorkerFunction<(msg: unknown) => Promise<void>>('deliverRawInput', scope),
    acks: () => scope.send.mock.calls.map(([m]: any[]) => m).filter((m: any) => m.type === 'queued_activation_submitted'),
  };
}

describe('raw activation admission: SQLite boundaries and human intervention', () => {
  it('commits the successor before waking the parked worker and keeps the exact opening ACK gate', async () => {
    const h = parked();
    h.send.mockImplementation(() => {
      expect(h.disk().queuedActivationTail?.map(t => t.turnId)).toEqual(['om_after_fix']);
    });
    await vi.advanceTimersByTimeAsync(5_000);
    botConfig.env = { FIXTURE: 'after-config-edit' };
    botConfig.startupCommands = ['/fixture-new-config'];
    h.admit('om_after_fix');
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'restart', reason: 'cli_crash',
      env: { FIXTURE: 'after-config-edit' }, startupCommands: ['/fixture-new-config'] }));
    expect(h.ds.pendingRawInput).toBe('/goal exact raw opening');
    expect(h.disk().queuedActivationPending).toBe(true);
    expect(h.disk().queuedActivationToken).toBe(h.ds.session.queuedActivationToken);
    expect(pool.hasQueuedActivationAdmissionGate(h.ds)).toBe(true);
    expect(h.ds.cliStartupFailureReason).toBeUndefined();
  });

  it('a rejected tail commit neither wakes the process nor leaves a ghost successor', async () => {
    const h = parked();
    store.__testOnly_setBeforeRowPersist(() => { throw new Error('injected SQLITE_IOERR before tail commit'); });
    expect(() => h.admit('om_uncommitted')).toThrow(/SQLITE_IOERR/);
    store.__testOnly_setBeforeRowPersist(undefined);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.ds.session.queuedActivationTail).toBeUndefined();
    expect(h.disk().queuedActivationTail).toBeUndefined();
    expect(h.ds.cliStartupFailureReason).toBeDefined();
    h.admit('om_committed');
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.disk().queuedActivationTail?.map(t => t.turnId)).toEqual(['om_committed']);
  });

  it('a committed tail survives rejected restart IPC; a later new message retries with the latest config', async () => {
    const h = parked();
    h.send.mockImplementationOnce(() => { throw new Error('injected IPC channel rejected'); });
    h.admit('om_first');
    expect(h.disk().queuedActivationTail?.map(t => t.turnId)).toEqual(['om_first']);
    expect(h.ds.cliStartupFailureReason).toBeDefined();
    expect(pool.isSessionRestartInFlight(h.ds)).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.send).toHaveBeenCalledTimes(1);
    botConfig.env = { FIXTURE: 'corrected' };
    h.admit('om_second');
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1][0]).toMatchObject({ type: 'restart', env: { FIXTURE: 'corrected' } });
    expect(h.disk().queuedActivationTail?.map(t => t.turnId)).toEqual(['om_first', 'om_second']);
    expect(h.ds.cliStartupFailureReason).toBeUndefined();
  });

  it.each(['closed', 'killed'] as const)('does not wake after human intervention: %s', async action => {
    const h = parked();
    setTimeout(() => {
      if (action === 'closed') { store.closeSession(h.ds.session.sessionId); }
      else h.ds.worker.killed = true;
    }, 10);
    await vi.advanceTimersByTimeAsync(20);
    h.admit('om_racing_arrival');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.ds.cliStartupFailureReason).toBeDefined();
    expect(h.disk().queuedActivationToken).toBe(h.ds.session.queuedActivationToken);
  });

  it('long restart silence and repeated successor arrivals never send N+1 or create a restart storm', async () => {
    const h = parked();
    h.admit('om_first');
    for (let n = 0; n < 5; n++) {
      await vi.advanceTimersByTimeAsync(30_000);
      h.admit(`om_later_${n}`);
    }
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.send.mock.calls[0][0].type).toBe('restart');
    expect(h.disk().queuedActivationTail?.map(t => t.turnId)).toEqual([
      'om_first', 'om_later_0', 'om_later_1', 'om_later_2', 'om_later_3', 'om_later_4',
    ]);
    expect(pool.hasQueuedActivationAdmissionGate(h.ds)).toBe(true);
    expect(h.ds.pendingRawInput).toBe('/goal exact raw opening');
  });
});

describe('worker raw activation: circuit, cancellation and asynchronous boundaries', () => {
  it.each(['pi', 'claude-code', 'codex'])('retains exact raw payload through repeated stops and acknowledges only after native acceptance: %s', async cliId => {
    const h = worker(cliId);
    h.scope.pendingRawInputs.push({ content: '/help', turnId: 'ordinary' });
    h.scope.pendingMessages.push({ content: 'ordinary', turnId: 'ordinary' });
    await h.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    await h.stop();
    expect(h.scope.pendingRawInputs).toEqual([h.raw]);
    expect(h.acks()).toEqual([]);
    expect(h.scope.spawnCli).not.toHaveBeenCalled();
    await h.restart();
    await vi.runAllTimersAsync();
    expect(h.scope.spawnCli).toHaveBeenCalledOnce();
    const accepted = deferred();
    h.scope.sendRawCommandLineWithRecoveryFence.mockImplementationOnce(() => accepted.promise);
    const msg = h.scope.pendingRawInputs.shift();
    const delivering = h.deliver(msg);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.acks()).toEqual([]);
    accepted.resolve();
    await delivering;
    expect(h.acks()).toEqual([{ type: 'queued_activation_submitted', sessionId: 'raw-worker', activationToken: h.raw.queuedActivationToken }]);
    expect(h.scope.sendRawCommandLineWithRecoveryFence).toHaveBeenCalledOnce();
  });

  it('half-published ordinary failure requests reconciliation but neither discards nor ACKs the raw journal owner', async () => {
    const h = worker();
    h.scope.pendingMessages.push({ content: 'first', turnId: 'first' }, { content: 'second', turnId: 'second' });
    h.scope.send.mockImplementationOnce(() => { throw new Error('injected commit-unknown IPC outcome'); });
    await h.stop();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.scope.sendFatalWorkerErrorAndExit).toHaveBeenCalledOnce();
    expect(h.scope.pendingRawInputs).toEqual([h.raw]);
    expect(h.acks()).toEqual([]);
    expect(h.scope.emittedTurnTerminals.statusOf('raw-worker', 'first')).toBe('failed');
    expect(h.scope.emittedTurnTerminals.statusOf('raw-worker', 'second')).toBe('failed');
    await h.stop();
    expect(h.scope.send).toHaveBeenCalledTimes(2);
    expect(h.scope.spawnCli).not.toHaveBeenCalled();
  });

  it.each(['pty', 'tmux', 'hc'])('human cancellation during %s restart delay keeps raw ownership but prevents delayed respawn', async backendType => {
    const h = worker('pi', backendType);
    await h.restart();
    await h.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.scope.spawnCli).not.toHaveBeenCalled();
    expect(h.scope.pendingRawInputs).toEqual([h.raw]);
    expect(h.acks()).toEqual([]);
    await h.restart();
    await vi.runAllTimersAsync();
    expect(h.scope.spawnCli).toHaveBeenCalledOnce();
    expect(h.scope.pendingRawInputs).toEqual([h.raw]);
  });

  it.each(['resolve', 'reject'])('cancelled long preparation cannot relaunch or fail a newer raw recovery: %s', async completion => {
    const h = worker('codex');
    const oldTitle = deferred();
    const newSpawn = deferred();
    h.scope.prepareCodexNativeTitleGeneration.mockImplementationOnce(() => oldTitle.promise);
    await h.restart();
    await vi.advanceTimersToNextTimerAsync();
    h.scope.backend = null;
    await h.stop();
    h.scope.spawnCli.mockImplementationOnce(() => newSpawn.promise);
    await h.restart();
    await vi.advanceTimersToNextTimerAsync();
    await vi.advanceTimersByTimeAsync(90_000);
    if (completion === 'resolve') oldTitle.resolve(); else oldTitle.reject(new Error('old generation title failed'));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.scope.replacementSpawnInProgress).toBe(true);
    expect(h.scope.cliRestartInProgress).toBe(true);
    expect(h.scope.sendFatalWorkerErrorAndExit).not.toHaveBeenCalled();
    expect(h.scope.pendingRawInputs).toEqual([h.raw]);
    h.scope.backend = {};
    newSpawn.resolve();
    await vi.runAllTimersAsync();
    expect(h.scope.spawnCli).toHaveBeenCalledTimes(2);
    expect(h.acks()).toEqual([]);
  });
});


describe('raw activation recovery against the real durable control-operation journal', () => {
  function controlled() {
    const h = parked();
    const controller = controllerForSession(h.ds, true)!;
    h.ds.initConfig = { sessionContract: controller.bindWorker(1) };
    pool.setActiveSessionsRegistry(new Map([[activeSessionKey(h.ds), h.ds]]));
    return { ...h, controller };
  }

  it.each(['suspend', 'cancel'] as const)('does not supersede a human %s awaiting confirmation; retries after its rejection', async kind => {
    const h = controlled();
    const { operation } = h.controller.beginControl(kind);
    h.controller.controlStarted(operation.operationId);
    h.admit('om_while_control_pending');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.controller.operation()?.operationId).toBe(operation.operationId);
    expect(h.disk().queuedActivationTail?.map(t => t.turnId)).toEqual(['om_while_control_pending']);
    h.controller.controlResult(operation.operationId, 'rejected');
    h.admit('om_after_control_rejected');
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.disk().queuedActivationPending).toBe(true);
  });

  it('human close wins over a restart waiting for the durable checkpoint, without a late IPC resurrection', async () => {
    const h = controlled();
    const checkpoint = deferred();
    // Only the external primary write is held; beginControl/controlStarted and
    // the cancellation winner are committed by the real SQLite controller.
    vi.spyOn(primary, 'sessionContractPrimary').mockReturnValue({} as any);
    vi.spyOn(h.controller, 'flushPrimary').mockImplementation(() => checkpoint.promise);
    h.admit('om_before_close');
    const restarting = h.controller.operation()!;
    expect(restarting.kind).toBe('restart');
    expect(h.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    const closing = h.controller.beginControl('close').operation;
    h.controller.controlStarted(closing.operationId);
    h.controller.controlResult(closing.operationId, 'confirmed');
    store.updateSession(h.ds.session);
    checkpoint.resolve();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.disk().status).toBe('closed');
    expect(h.disk().queuedActivationTail?.map(t => t.turnId)).toEqual(['om_before_close']);
    expect(h.controller.operation(restarting.operationId)?.phase).toBe('uncertain');
  });

  it('a failed primary checkpoint preserves the accepted tail and permits a later exact recovery', async () => {
    const h = controlled();
    const checkpoint = deferred();
    vi.spyOn(primary, 'sessionContractPrimary').mockReturnValue({} as any);
    vi.spyOn(h.controller, 'flushPrimary').mockImplementationOnce(() => checkpoint.promise).mockResolvedValue();
    h.admit('om_before_checkpoint_failure');
    const firstAttempt = h.controller.operation()!.operationId;
    await vi.advanceTimersByTimeAsync(5_000);
    checkpoint.reject(new Error('injected primary persistence failure'));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.controller.operation(firstAttempt)?.phase).toBe('rejected');
    expect(h.ds.cliStartupFailureReason).toBeDefined();
    expect(pool.isSessionRestartInFlight(h.ds)).toBe(false);
    h.admit('om_retry_after_checkpoint_failure');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.controller.operation()!.operationId).not.toBe(firstAttempt);
    expect(h.disk().queuedActivationTail?.map(t => t.turnId)).toEqual([
      'om_before_checkpoint_failure', 'om_retry_after_checkpoint_failure',
    ]);
  });
});

describe('tokened opening at the in-flight/circuit boundary', () => {
  it('keeps an unacknowledged tokened opening recoverable when adapter failure settles after the circuit', async () => {
    const h = worker('codex');
    h.scope.pendingRawInputs.length = 0;
    const opening = { content: 'exact opening before exit', turnId: 'om_opening', queuedActivationToken: 'token_unacked' };
    // flushPending registers the attempt before awaiting its adapter. The
    // backend exits during that await, so the real tracker hands it to carry.
    h.scope.inflightInputs.onWrite(opening);
    const adapterSettled = deferred();
    const requeue = loadWorkerFunction<(item: typeof opening) => void>('requeueUnsubmittedQueuedActivation', h.scope);
    const settling = adapterSettled.promise.then(() => requeue(opening));
    await vi.advanceTimersByTimeAsync(50);
    h.scope.inflightInputs.onCliExit((item: InflightItem) => item.dispatchAttempt === undefined && !item.noReplay);
    await h.stop();
    await vi.advanceTimersByTimeAsync(50);
    adapterSettled.resolve();
    await settling;
    // Either a worker replay owner or explicit worker-exit reconciliation is
    // required. A daemon journal alone cannot feed the surviving worker: its
    // recovery IPC is restart(prompt:'') and its tail is held behind this ACK.
    const retained = [...h.scope.pendingMessages,
      ...h.scope.inflightInputs.takeCarryOver(), ...h.scope.inflightInputs.takeStartedCarryOver()];
    expect(h.acks()).toEqual([]);
    expect({ retained: retained.map(item => item.queuedActivationToken),
      exits: h.scope.sendFatalWorkerErrorAndExit.mock.calls.length }).not.toEqual({ retained: [], exits: 0 });
  });

  it('fails closed instead of clearing an unsettled activation during an in-worker restart', async () => {
    const h = worker('codex');
    const receipts = createQueuedActivationReceiptObserver(20_000);
    h.scope.queuedActivationReceipts = receipts;
    expect(receipts.watch('token_unsettled_restart', { isCurrent: () => true })).toBe(true);
    const onRespawnSettled = vi.fn();

    await h.scope.restartCliProcess('restart with unsettled receipt', {
      preservePending: true,
      onRespawnSettled,
    });

    expect(onRespawnSettled).toHaveBeenCalledExactlyOnceWith('failed');
    expect(h.scope.sendFatalWorkerErrorAndExit).toHaveBeenCalledOnce();
    expect(h.scope.sendFatalWorkerErrorAndExit.mock.calls[0][0].message)
      .toContain('requires daemon journal recovery');
    expect(h.scope.spawnCli).not.toHaveBeenCalled();
    expect(receipts.size()).toBe(0);
    expect(h.acks()).toEqual([]);
  });
});
