import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { RestoredObserverGrantWait, RESTORED_OBSERVER_GRANT_WAIT_MS } from '../src/services/restored-observer-grant-wait.js';
import { sameWorker } from '../src/services/session-contract.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import * as realSessions from '../src/services/session-store.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';

const cfg = vi.hoisted(() => ({ dir: '' }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return cfg.dir; } } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
const cleanup: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const fn of cleanup.splice(0).reverse()) fn(); });

interface Shape { cli: string; backend: string; workerLost?: boolean; operation?: boolean; nativeNeverBound?: boolean }

/**
 * A replacement worker restored a predecessor turn whose terminal is already in
 * the transcript, followed by its own completed turn. Everything between the
 * worker's bridge queue and the host contract is production code: the real
 * emitter, metadata stamp, host message handler and assignment handler.
 */
function restoredReplacement(shape: Shape) {
  const dir = mkdtempSync(join(tmpdir(), 'observer-release-')); cfg.dir = dir;
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const appId = 'cli_observer_release'; realSessions.init(appId);
  const session: any = realSessions.createSession('oc_release', 'om_release', 'release', 'group', 'thread');
  session.cliId = shape.cli; session.backendType = shape.backend;
  const ref = { appId, sessionId: session.sessionId };
  const store = new SessionContractStore(dir, appId); cleanup.push(() => store.close());
  const ds: any = { larkAppId: appId, chatId: 'oc_release', session, cliReadyGeneration: 0 };
  let controller = new SessionController(ds, store); const oldWorker = controller.bindWorker(1).worker;
  const old = controller.reserveBinding('predecessor', oldWorker);
  const identity: any = { backend: shape.backend, proof: 'process_start', physicalId: '111:start111', nativeSessionId: 'native-original' };
  controller.bindRuntime('predecessor', oldWorker, identity);
  const predecessor = controller.admitInput('turn-old'); store.bindQueuedExecution(ref, predecessor, old);
  store.apply(ref, { type: 'execution_phase', runtime: old, execution: predecessor, phase: 'accepted' });
  // workerLost=false: the host died with the worker and never observed its loss.
  if (shape.workerLost !== false) controller.workerLost(oldWorker); else controller = new SessionController(ds, store);
  const boot = controller.bindWorker(2); const worker = boot.worker;
  const scope = new WorkerSessionEventScope(ref, worker);
  for (const state of boot.executions ?? []) scope.noteAdmission(state);
  const binding = scope.beginRuntime(); binding.identity = { ...identity }; delete binding.identity.nativeSessionId;
  controller.reserveBinding(binding.bindingId, worker);
  const current = controller.bindRuntime(binding.bindingId, worker, binding.identity).ref; scope.assign(binding.bindingId, current);
  const successor = controller.admitInput('turn-successor'); store.bindQueuedExecution(ref, successor, current);
  store.apply(ref, { type: 'execution_phase', runtime: current, execution: successor, phase: 'accepted' });
  scope.noteAdmission({ ref: successor, runtime: current, phase: 'accepted' }); scope.rememberExecution(successor, binding);
  if (shape.operation) controller.controlStarted(controller.beginControl('cancel', undefined, predecessor).operation.operationId);

  const queue = new CodexBridgeQueue(() => 1_000);
  queue.restoreDrained(['turn-old', 'turn-successor'].map(turnId => ({ turnId, started: true, finalText: `${turnId} final`, terminalStatus: 'completed' as const })) as any);
  const pending: Promise<void>[] = []; const sent: string[] = [];
  const hostEnv: any = { sessionController: controller, contractWorker: worker, ds, sameWorker, isCodexAppCliId,
    logger: { warn: vi.fn(), debug: vi.fn() }, t: 'release', handleLegacyWorkerMessage: vi.fn(),
    managedAuxUiSuppressed: () => true, ownsWorkerSession: () => true, isSessionTransferring: () => false,
    finalizeCotMessage: vi.fn(), cb: {}, reportUndeliveredFinal: vi.fn() };
  const wait = new RestoredObserverGrantWait();
  const workerEnv: any = { workerSessionEventScope: scope, restoredObserverGrantWait: wait };
  const stamp = loadWorkerFunction<any>('sessionEventMetadata', workerEnv);
  const send = (message: any) => { sent.push(`${message.type}:${message.turnId}`); pending.push(hostEnv.handleWorkerMessage(stamp(message))); };
  const emit = loadWorkerFunction<() => void>('emitReadyCodexTurns', {
    codexBridgeQueue: queue, workerSessionEventScope: scope, recoverTraexQuotaTurn: () => false,
    restoredObserverGrantWait: wait, lastInitConfig: { adoptMode: true, cliId: shape.cli },
    effectiveBackendType: shape.backend, log: vi.fn(), codexBridgeDrainAndMaybeEmit: () => scope.run(binding, emit),
    universalOutputHandoff: undefined, checkpointCodexAdoptRecovery: vi.fn(), checkpointStructuredBridgeRecovery: vi.fn(),
    armPostTerminalInputFence: vi.fn(), sessionId: ref.sessionId,
    isExistingAppServerSharedBridge: () => false, structuredBridgeIs: () => false, zeroPromptTerminalSync: () => false,
    bridgeGateInputForTurn: () => ({}), structuredFallbackKind: () => 'final', bridgeTurnOutcome: () => 'answered',
    traexModelAccessSwitchNotice: undefined, notifyExplicitRepliesObserved: vi.fn(), attributableExplicitReplyMarkersForTurnWindow: () => [],
    shouldSuppressStructuredFallback: () => false, replyDeliveryMode: () => 'unified', deliveredFinalFailureNoticeSuppressed: () => false,
    usageLimitTracker: { noteTurnCompleted: vi.fn() }, bridgePostText: (text: string) => text, send,
    releaseInputDeliveryQuarantineForStructuredTerminal: vi.fn(), retireRpcLifecycleFromStructuredTerminal: vi.fn(),
    emitTurnTerminal: (turnId: string, status: string) => send({ type: 'turn_terminal', turnId, status }),
    retireStructuredTurnAttribution: vi.fn(),
  });
  workerEnv.codexBridgeDrainAndMaybeEmit = () => scope.run(binding, emit);
  const assign = loadWorkerMessageHandler('runtime_contract_assigned', workerEnv);
  ds.worker = { send: (message: any) => { if (message.type === 'runtime_contract_assigned') pending.push(assign(message)); } };
  hostEnv.worker = ds.worker;
  hostEnv.handleWorkerMessage = loadWorkerPoolClosure<any>('handleWorkerMessage', hostEnv);
  const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  return {
    store, ref, predecessor, successor, old, current, sent, settle,
    drain: async () => { scope.run(binding, emit); await settle(); },
    // The live CLI's native session id reaches this binding.
    enrich: async () => { await hostEnv.handleWorkerMessage(scope.run(binding, () => stamp({ type: 'runtime_binding', bindingId: binding.bindingId, identity }))); await settle(); },
    phase: (execution: { executionId: string }) => store.execution(ref, execution.executionId)?.phase,
  };
}

describe('restored predecessor turns never hold their successors indefinitely', () => {
  it('waits for the grant on Codex tmux and then settles both exact attempts', async () => {
    const h = restoredReplacement({ cli: 'codex', backend: 'tmux' });
    await h.drain();
    expect(h.sent).toEqual([]);
    await h.enrich();
    expect(h.phase(h.predecessor)).toBe('succeeded');
    expect(h.store.execution(h.ref, h.predecessor.executionId)?.runtime).toEqual(h.old);
    expect(h.phase(h.successor)).toBe('succeeded');
  });

  it.each([
    { cli: 'antigravity', backend: 'tmux' },
    { cli: 'traex', backend: 'tmux' },
    { cli: 'codex', backend: 'herdr' },
  ])('does not wait where the host never grants observers ($cli on $backend)', async shape => {
    const h = restoredReplacement(shape);
    await h.drain();
    expect(h.phase(h.successor)).toBe('succeeded');
    // Ordinary admission still refuses the unproven cross-runtime terminal.
    expect(h.phase(h.predecessor)).toBe('reconciling');
  });

  it.each([
    { name: 'the host never saw the old worker exit', shape: { cli: 'codex', backend: 'tmux', workerLost: false }, predecessor: 'accepted' },
    { name: 'a control operation blocks the grant', shape: { cli: 'codex', backend: 'tmux', operation: true }, predecessor: 'reconciling' },
  ])('releases successors once the host decided without a grant: $name', async ({ shape, predecessor }) => {
    const h = restoredReplacement(shape);
    await h.drain();
    expect(h.sent).toEqual([]);
    await h.enrich();
    expect(h.phase(h.successor)).toBe('succeeded');
    expect(h.phase(h.predecessor)).toBe(predecessor);
  });

  it('releases successors after the bounded wait when no native identity is ever bound', async () => {
    vi.useFakeTimers();
    const h = restoredReplacement({ cli: 'codex', backend: 'tmux' });
    await h.drain();
    await vi.advanceTimersByTimeAsync(RESTORED_OBSERVER_GRANT_WAIT_MS - 1); await h.settle();
    expect(h.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await h.settle();
    expect(h.phase(h.successor)).toBe('succeeded');
    expect(h.phase(h.predecessor)).toBe('reconciling');
  });
});

describe('RestoredObserverGrantWait', () => {
  it('never waits where the host cannot grant or after its decision for that binding', () => {
    const wait = new RestoredObserverGrantWait(1_000); const redrive = vi.fn();
    expect(wait.hold('binding-a', false, redrive)).toBe(false);
    expect(wait.hold(undefined, true, redrive)).toBe(false);
    expect(wait.hold('binding-a', true, redrive)).toBe(true);
    expect(wait.decide('binding-a')).toBe(true);
    expect(wait.hold('binding-a', true, redrive)).toBe(false);
    // A replacement binding is a new chance for a grant.
    expect(wait.hold('binding-b', true, redrive)).toBe(true);
  });

  it('redrives once when the wait expires and does not wait again for that binding', async () => {
    vi.useFakeTimers();
    const wait = new RestoredObserverGrantWait(1_000); const redrive = vi.fn();
    expect(wait.hold('binding-a', true, redrive)).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(wait.hold('binding-a', true, redrive)).toBe(true); expect(redrive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(redrive).toHaveBeenCalledOnce();
    expect(wait.hold('binding-a', true, redrive)).toBe(false);
    expect(wait.decide('binding-a')).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000); expect(redrive).toHaveBeenCalledOnce();
  });
});

describe('worker loss reconciliation', () => {
  it('moves every unsettled attempt of the lost process to reconciling exactly once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-lost-')); cfg.dir = dir;
    cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
    const appId = 'cli_worker_lost'; const ref = { appId, sessionId: 'session-lost' };
    const store = new SessionContractStore(dir, appId); cleanup.push(() => store.close());
    const ds: any = { larkAppId: appId, chatId: 'oc_lost', session: { sessionId: ref.sessionId, larkAppId: appId, status: 'active' }, cliReadyGeneration: 0 };
    const controller = new SessionController(ds, store); const worker = controller.bindWorker(1).worker;
    const identity = { backend: 'tmux', physicalId: '111:start', nativeSessionId: 'native', proof: 'process_start' as const };
    const first = controller.reserveBinding('first', worker); controller.bindRuntime('first', worker, identity);
    const attempt = (turnId: string, runtime: typeof first, phase?: 'accepted') => {
      const execution = controller.admitInput(turnId); store.bindQueuedExecution(ref, execution, runtime);
      if (phase) store.apply(ref, { type: 'execution_phase', execution, runtime, phase });
      else store.apply(ref, { type: 'execution_terminal', execution, runtime, status: 'succeeded', evidence: 'native_terminal' });
      return execution;
    };
    for (let index = 0; index < 20; index++) attempt(`settled-first-${index}`, first);
    const carried = attempt('carried', first, 'accepted');
    // The same live CLI continued into a new runtime of this worker.
    const second = controller.reserveBinding('second', worker);
    controller.bindRuntime('second', worker, { ...identity, physicalId: '222:start' }, undefined, 'first');
    for (let index = 0; index < 20; index++) attempt(`settled-second-${index}`, second);
    const open = [attempt('open-a', second, 'accepted'), attempt('open-b', second, 'accepted')];
    const before = new Map([carried, ...open].map(execution => [execution.executionId, store.execution(ref, execution.executionId)!.revision]));
    controller.workerLost(worker);
    for (const execution of [carried, ...open]) {
      expect(store.execution(ref, execution.executionId)).toMatchObject({ phase: 'reconciling', revision: before.get(execution.executionId)! + 1 });
    }
    expect(store.runtime(ref, second.runtimeId)?.phase).toBe('unresolved');
  });
});
