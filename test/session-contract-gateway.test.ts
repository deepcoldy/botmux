import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController, controllerForSession } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { admitSessionCommand } from '../src/services/session-command-gateway.js';
import { PersistentTurnResultStore } from '../src/services/persistent-turn-result-store.js';
import { outputSnapshot, UniversalOutputHandoff, type OutputSnapshot } from '../src/services/universal-output-handoff.js';
import { OutputDeliveryJournal } from '../src/services/output-delivery-journal.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure, loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerToDaemon } from '../src/types.js';
import type { RuntimeEventBinding } from '../src/services/session-event-scope.js';
import { sameWorker, sameRuntime } from '../src/services/session-contract.js';
import { RestartCoordinator } from '../src/core/restart-coordinator.js';
import { RUNTIME_RESERVATION_DEADLINE_MS, RuntimeReservationExpiredError } from '../src/services/runtime-reservation.js';
import { prepareCodexAppDispatch, hasUnsettledCodexAppDispatch } from '../src/utils/codex-app-dispatch-ledger.js';

const fixtureConfig = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return fixtureConfig.dataDir; } } } }));

const directories: string[] = [];
const handles: Array<{ close(): void }> = [];
function fixture() {
  const data = mkdtempSync(join(tmpdir(), 'contract-gateway-')); directories.push(data);
  fixtureConfig.dataDir = data;
  const appId = 'cli_gateway_test'; const ref = { appId, sessionId: 'session-test' };
  const store = new SessionContractStore(data, appId); handles.push(store);
  const ds = { larkAppId: appId, chatId: 'oc_test', session: { sessionId: ref.sessionId, larkAppId: appId, status: 'active' }, cliReadyGeneration: 0 } as DaemonSession;
  const controller = new SessionController(ds, store); const worker = controller.bindWorker(1).worker;
  const runtime = controller.reserveBinding('binding-old', worker);
  controller.bindRuntime('binding-old', worker, { backend: 'tmux', physicalId: '111:start1', nativeSessionId: 'native1', proof: 'process_start' });
  const context = (sequence: number, scope: any = { runtime }) => ({ version: 2 as const, session: ref, producer: worker, eventId: `${worker.workerId}:${sequence}`, sequence, scope });
  return { data, appId, ref, store, ds, controller, worker, runtime, context };
}
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  for (const handle of handles.splice(0)) try { handle.close(); } catch { /* already closed */ }
  for (const data of directories.splice(0)) rmSync(data, { recursive: true, force: true });
});

describe('contract gateway and real worker boundaries', () => {
  it.each([
    { turnId: undefined, retry: false },
    { turnId: 'om_initial_capture', retry: false },
    { turnId: undefined, retry: true },
    { turnId: 'om_initial_capture', retry: true },
  ])('publishes the initial capture tuple inside its runtime before rendering (turn=$turnId, retry=$retry)', async ({ turnId, retry }) => {
    vi.useFakeTimers();
    const s = fixture();
    const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const reservations = new Map<string, (allowed: boolean) => void>();
    const sent: WorkerToDaemon[] = [];
    const admitted: string[] = [];
    let starts = 0;
    const env: Record<string, unknown> = {
      workerSessionEventScope: scope, pendingRuntimeReservations: reservations,
      currentBotmuxTurnId: undefined, currentBotmuxDispatchAttempt: undefined,
      currentBotmuxCallerOpenId: undefined, captureRevision: 0, captureIdentityAnnounced: false,
      activeRestartAttemptId: undefined, closeRequested: false,
      spawnCliBody: vi.fn(async () => {
        starts += 1;
        expect(sent.filter(message => message.type === 'capture_identity')).toHaveLength(starts);
        if (retry && starts === 1) throw new Error('Preparation failed before runtime publication');
      }),
      publishRuntimeContract: async (binding: RuntimeEventBinding) => {
        const runtime = s.controller.bindRuntime(binding.bindingId, s.worker, {
          backend: 'tmux', physicalId: '222:start', nativeSessionId: 'restored-adopt', proof: 'process_start',
        });
        scope.assign(binding.bindingId, runtime.ref);
        for (const message of s.store.deferredEvents<WorkerToDaemon>(s.ref, binding.bindingId)) {
          admitted.push(s.controller.ingest(message, s.worker).kind);
        }
      },
      log: vi.fn(),
    };
    const metadata = loadWorkerFunction<(message: WorkerToDaemon) => WorkerToDaemon>('sessionEventMetadata', env);
    env.send = (raw: WorkerToDaemon) => {
      const message = metadata(raw);
      sent.push(message);
      if (message.type === 'runtime_binding_started') {
        s.controller.reserveBinding(message.bindingId, s.worker);
        reservations.get(message.bindingId)?.(true);
      } else if (message.type === 'runtime_binding_aborted') {
        if (!message.sessionContract) throw new Error('Missing abort metadata');
        s.controller.abandonBinding(message.bindingId, s.worker, message.sessionContract.eventId);
        scope.confirmAbortedStart(message.bindingId);
      } else if (message.type === 'capture_identity') {
        expect(s.controller.ingest(message, s.worker).kind).toBe('defer');
      }
    };
    const capture = loadWorkerFunction<(turnId?: string, attempt?: number, caller?: string) => void>('setCaptureIdentity', env);
    capture(turnId, undefined, 'ou_owner');
    expect(sent).toEqual([]);
    expect(env.currentBotmuxTurnId).toBe(turnId);

    const spawn = loadWorkerFunction<(cfg: { prompt: string }) => Promise<void>>('spawnCli', env);
    if (retry) {
      await expect(spawn({ prompt: '' })).rejects.toThrow('Preparation failed before runtime publication');
      expect(scope.currentBinding()).toBeUndefined();
    }
    await spawn({ prompt: '' });
    expect(admitted).toEqual(['current']);
    expect(sent.filter(message => message.type === 'capture_identity').at(-1)).toMatchObject({
      revision: 0,
      sessionContract: { bindingId: scope.currentBinding()?.bindingId },
      ...(turnId ? { turnId } : {}),
    });
  });

  it('accepts capture identity before the worker reports execution start', () => {
    const s = fixture();
    const turnId = 'om_adopt_screenshot';
    const capture = {
      type: 'capture_identity', turnId, revision: 1,
      sessionContract: s.context(1),
    };
    expect(s.controller.ingest(capture, s.worker)).toMatchObject({ kind: 'current' });
    const execution = s.store.executions(s.ref, turnId)[0];
    expect(execution).toMatchObject({ phase: 'queued' });
    expect(execution.runtime).toBeUndefined();
  });

  it('does not upgrade an old runtime scope through a newer pending binding', () => {
    const s = fixture(); const execution = s.controller.admitInput('known-turn'); s.controller.reserveBinding('new-pending', s.worker);
    const before = s.store.read(s.ref)!.revision;
    const message = { type: 'managed_turn_origin', turnId: 'known-turn', sessionContract: { ...s.context(1, { runtime: s.runtime, execution }), bindingId: 'new-pending' } };
    expect(s.controller.ingest(message, s.worker)).toMatchObject({ kind: 'reject', reason: 'runtime_binding_scope_mismatch' });
    expect(s.store.deferredEvents(s.ref, 'new-pending')).toEqual([]); expect(s.store.read(s.ref)!.revision).toBe(before);
  });
  it.each([false, true])('restores the surviving runtime when overlapping starts abort in either order (newestFirst=%s)', newestFirst => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const old = scope.beginRuntime(); scope.assign(old.bindingId, s.runtime);
    const a = scope.beginRuntime(); const b = scope.beginRuntime();
    for (const binding of newestFirst ? [b, a] : [a, b]) scope.restoreAfterAbortedStart(binding);
    expect(scope.currentBinding()).toBe(old);
    expect(admitSessionCommand('restart', { version: 2, runtime: s.runtime, operationId: 'restart' }, scope.currentBinding()?.runtime, 'restart').allowed).toBe(true);
  });
  it.each(['transaction_failure', 'lost_ack'] as const)('retries no-spawn evidence until the host confirms durable abandonment (%s)', condition => {
    vi.useFakeTimers(); const s = fixture(); const workerScope = new WorkerSessionEventScope(s.ref, s.worker);
    const old = workerScope.beginRuntime(); workerScope.assign(old.bindingId, s.runtime);
    const aborted = workerScope.beginRuntime(); s.controller.reserveBinding(aborted.bindingId, s.worker);
    workerScope.restoreAfterAbortedStart(aborted);
    const env: any = { workerSessionEventScope: workerScope };
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
    const receive = loadWorkerFunction<(message: any) => Promise<void>>('handleContractDaemonMessage', env);
    let dropAck = condition === 'lost_ack';
    const worker = { send: vi.fn((message: any) => { if (dropAck) { dropAck = false; return; } void receive(message); }) }; s.ds.worker = worker as any;
    const hostScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: vi.fn() };
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostScope);
    const db = openDatabaseSyncOrThrow(s.store.filename); handles.push(db);
    if (condition === 'transaction_failure') db.exec("CREATE TRIGGER fail_abort BEFORE INSERT ON events WHEN NEW.type='runtime_lost' BEGIN SELECT RAISE(ABORT,'abort_failed'); END");
    const pending: Promise<void>[] = []; const report = vi.fn(() => { pending.push(host(metadata({ type: 'runtime_binding_aborted', bindingId: aborted.bindingId }))); });
    workerScope.reportAbortedStart(aborted, report);
    return (async () => {
      await Promise.all(pending);
      if (condition === 'transaction_failure') {
        expect(s.store.binding(s.ref, aborted.bindingId)?.phase).toBe('starting');
        expect(s.controller.bindingMayStart(aborted.bindingId)).toBe(false);
        expect(worker.send).not.toHaveBeenCalled();
        db.exec('DROP TRIGGER fail_abort');
        s.ds = { ...s.ds, session: structuredClone(s.ds.session) }; s.store.close();
        const reopened = new SessionContractStore(s.data, s.appId); handles.push(reopened);
        hostScope.sessionController = new SessionController(s.ds, reopened); hostScope.ds = s.ds;
      }
      await vi.advanceTimersByTimeAsync(1_001); await Promise.all(pending);
      expect(report).toHaveBeenCalledTimes(2);
      expect(hostScope.sessionController.store.binding(s.ref, aborted.bindingId)?.phase).toBe('stopped');
      expect(hostScope.sessionController.store.hasPendingRuntimeReplacement(s.ref, s.runtime)).toBe(false);
      const sent = report.mock.calls.length; await vi.advanceTimersByTimeAsync(5_000); expect(report).toHaveBeenCalledTimes(sent);
      await host(workerScope.run(old, () => metadata({ type: 'claude_exit', code: 1 })));
      expect(hostScope.handleLegacyWorkerMessage).toHaveBeenCalledOnce();
    })();
  });
  it.each(['managed_turn_origin', 'managed_turn_origin_revoked'])('rejects an unadmitted %s before persisting a deferred event', type => {
    const s = fixture(); s.controller.reserveBinding('unbound-start', s.worker);
    const execution = { executionId: 'not-admitted', turnId: 'unknown-turn', dispatchAttempt: 1 };
    const before = s.store.read(s.ref)!.revision;
    const admission = s.controller.ingest({ type, turnId: execution.turnId, dispatchAttempt: 1,
      sessionContract: { ...s.context(1, { execution }), bindingId: 'unbound-start' } }, s.worker);
    expect(admission.kind).toBe('reject');
    expect(s.store.deferredEvents(s.ref, 'unbound-start')).toEqual([]);
    expect(s.store.executions(s.ref)).toEqual([]); expect(s.store.read(s.ref)!.revision).toBe(before);
  });
  it('removes a rejected deferred authority record left by an earlier boot', async () => {
    const s = fixture(); s.controller.reserveBinding('old-poison', s.worker);
    const context = { ...s.context(1, { execution: { executionId: 'not-admitted', turnId: 'unknown-turn' } }), bindingId: 'old-poison' };
    s.store.deferEvent(s.ref, 'old-poison', context.eventId, context.sequence, { type: 'managed_turn_origin_revoked', turnId: 'unknown-turn', sessionContract: context });
    const worker = { send: vi.fn() }; s.ds.worker = worker as any;
    const scope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: vi.fn() };
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', scope); scope.handleWorkerMessage = handler;
    await handler({ type: 'runtime_binding', bindingId: 'old-poison', identity: { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' },
      sessionContract: { ...s.context(2, {}), bindingId: 'old-poison' } });
    expect(s.store.deferredEvents(s.ref, 'old-poison')).toEqual([]); expect(s.store.executions(s.ref)).toEqual([]);
    expect(scope.handleLegacyWorkerMessage).not.toHaveBeenCalled();
  });
  it('does not let a rejected message discard another deferred event with the same id', async () => {
    const s = fixture(); const execution = s.controller.admitInput('known-turn'); s.controller.reserveBinding('legitimate-pending', s.worker);
    const context = { ...s.context(1, { execution }), bindingId: 'legitimate-pending' };
    const message = { type: 'managed_turn_origin', turnId: 'known-turn', sessionContract: context };
    expect(s.controller.ingest(message, s.worker).kind).toBe('defer');
    const worker = { send: vi.fn() }; s.ds.worker = worker as any;
    const scope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: vi.fn() };
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', scope);
    await handler({ ...message, sessionContract: { ...context, producer: { workerId: 'unproven-worker', generation: 1 } } });
    expect(s.store.deferredEvents(s.ref, 'legitimate-pending')).toEqual([message]);
  });
  it.each(['refused', 'unanswered'] as const)('settles a %s spawn reservation and restores the surviving binding before a genuine crash', async condition => {
    vi.useFakeTimers(); const s = fixture();
    const workerScope = new WorkerSessionEventScope(s.ref, s.worker); const previous = workerScope.beginRuntime(); workerScope.assign(previous.bindingId, s.runtime);
    const reservations = new Map(); const pending: Promise<void>[] = [];
    const env: any = { workerSessionEventScope: workerScope, pendingRuntimeReservations: reservations,
      activeRestartAttemptId: undefined, closeRequested: false, initialInputOwnershipPending: false,
      spawnCliBody: vi.fn(), publishRuntimeContract: vi.fn(), CliSpawnSupersededError: class extends Error {}, log: vi.fn() };
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
    s.controller.ingest(workerScope.run(previous, () => metadata({ type: 'ready' })), s.worker);
    s.controller.ingest(workerScope.run(previous, () => metadata({ type: 'prompt_ready' })), s.worker);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let flushes = 0;
    vi.spyOn(s.controller, 'flushPrimary').mockImplementation(() => flushes++ === 0 ? gate : Promise.resolve());
    const receive = loadWorkerFunction<(message: any) => Promise<void>>('handleContractDaemonMessage', env);
    const worker = { send: vi.fn((message: any) => { void receive(message); }) }; s.ds.worker = worker as any;
    const legacy = vi.fn(); const hostScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: legacy };
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostScope); hostScope.handleWorkerMessage = host;
    env.send = (message: any) => { pending.push(host(metadata(message))); };
    const spawn = loadWorkerFunction<(cfg: any) => Promise<void>>('spawnCli', env);
    const started = spawn({ prompt: '' });
    const rejected = expect(started).rejects.toBeInstanceOf(condition === 'refused' ? env.CliSpawnSupersededError : RuntimeReservationExpiredError);
    const abandoned = workerScope.currentBinding()!;
    if (condition === 'refused') { s.controller.beginControl('close', 'close-during-start'); release(); }
    else { await vi.advanceTimersByTimeAsync(RUNTIME_RESERVATION_DEADLINE_MS + 1); release(); }
    await rejected; await Promise.all(pending); await Promise.all(pending);
    if (condition === 'refused') s.controller.controlResult('close-during-start', 'rejected');
    expect(env.spawnCliBody).not.toHaveBeenCalled(); expect(workerScope.currentBinding()).toBe(previous);
    expect(worker.send.mock.calls.some(([message]) => message.type === 'runtime_contract_reserved' && message.mayStart)).toBe(false);
    expect(s.store.binding(s.ref, abandoned.bindingId)?.phase).toBe('stopped');
    expect(s.store.hasPendingRuntimeReplacement(s.ref, s.runtime)).toBe(false);
    expect(() => s.controller.bindRuntime(abandoned.bindingId, s.worker, { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' })).toThrow('runtime_reservation_abandoned');
    await host(workerScope.run(previous, () => metadata({ type: 'claude_exit', code: 1 })));
    expect(legacy).toHaveBeenCalledOnce();
  });
  it('allows restart retry after persistence of the start claim fails before any physical effect', () => {
    const s = fixture(); let ds = { ...s.ds, session: structuredClone(s.ds.session), worker: null } as DaemonSession;
    let controller = s.controller; const db = openDatabaseSyncOrThrow(s.store.filename); handles.push(db);
    db.exec("CREATE TRIGGER fail_start_claim BEFORE INSERT ON events WHEN NEW.type='control_started' BEGIN SELECT RAISE(ABORT,'start_claim_failed'); END");
    const scope: any = { RestartCoordinator, findActiveBySessionId: () => ds, controllerForSession: () => controller,
      isSessionTransferring: () => false, sessionContractPrimary: () => false,
      destroyLivePaneBeforeRestart: vi.fn(), forkWorker: vi.fn(), logger: { warn: vi.fn() }, tag: () => 'test' };
    scope.restartCoordinator = loadWorkerPoolClosure('restartCoordinator', scope);
    const restart = loadWorkerPoolFunction<(ds: DaemonSession, observer: any) => any>('requestSessionRestart', scope);
    try {
      const first = restart(ds, { source: 'slash', notify: vi.fn() });
      expect(scope.forkWorker).not.toHaveBeenCalled();
      expect(controller.operation(first.attemptId)?.phase).toBe('failed_before_effect');
      expect(controller.allowsInput()).toBe(true);
      db.exec('DROP TRIGGER fail_start_claim'); s.store.close();
      const reopened = new SessionContractStore(s.data, s.appId); handles.push(reopened); controller = new SessionController(ds, reopened);
      const next = restart(ds, { source: 'slash', notify: vi.fn() });
      expect(next.joined).toBe(false); expect(next.attemptId).not.toBe(first.attemptId);
      expect(scope.forkWorker).toHaveBeenCalledOnce();
    } finally { scope.restartCoordinator.reset(); }
  });
  it.each([false, true])('reverifies the original uncertain suspend, including after reopen (primary=%s)', async primary => {
    const s = fixture(); let controller = s.controller;
    const worker = { killed: false, send: vi.fn(), kill: vi.fn() }; s.ds.worker = worker as any;
    s.ds.initConfig = { backendType: 'tmux' } as any;
    const verifier = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const scope: any = { controllerForSession: () => controller, sessionContractPrimary: () => primary,
      primarySuspendInFlight: new WeakMap(), primarySuspendApplying: new WeakSet(), sameRuntime,
      hasProtectedSessionMutationOwnership: () => false, isSessionTransferring: () => false,
      isSuspendableBackendType: () => true, suspendBackingVerifier: verifier,
      trackLifecycleRetirement: vi.fn(), clearLifecycleRetirement: vi.fn(), armWorkerKillBackstop: vi.fn(),
      invalidateStuckWarning: vi.fn(), invalidateTuiPrompt: vi.fn(), clearIdleAutoCompactStretch: vi.fn(),
      clearPendingSuspendClaim: vi.fn(), clearAcceptedInputTurns: vi.fn(),
      takeSessionPreviewTarget: () => undefined, sessionStore: { updateSessionPid: vi.fn(), updateSession: vi.fn() },
      dashboardEventBus: { publish: vi.fn() }, restartCoordinator: { cancelSession: vi.fn() }, logger: { warn: vi.fn(), info: vi.fn() }, tag: () => 'test' };
    scope.suspendWorker = loadWorkerPoolFunction('suspendWorker', scope);
    const suspend = loadWorkerPoolFunction<(ds: DaemonSession) => Promise<boolean>>('suspendWorkerAsync', scope);
    expect(await suspend(s.ds)).toBe(false);
    const operation = controller.operation()!;
    expect(operation).toMatchObject({ kind: 'suspend', phase: 'uncertain' });
    expect(controller.allowsInput()).toBe(false); expect(worker.send).not.toHaveBeenCalled();
    s.ds = { ...s.ds, session: structuredClone(s.ds.session) };
    s.store.close(); const reopened = new SessionContractStore(s.data, s.appId); handles.push(reopened);
    controller = new SessionController(s.ds, reopened);
    expect(await suspend(s.ds)).toBe(true);
    expect(verifier).toHaveBeenCalledTimes(2);
    expect(controller.operation(operation.operationId)?.phase).toBe('confirmed');
    expect(reopened.read(s.ref)?.lifecycle).toBe('suspended');
    expect(reopened.read(s.ref)?.activeOperationId).toBeUndefined();
    expect(worker.send).toHaveBeenCalledTimes(1); expect(s.ds.worker).toBeNull();
    expect(controller.prepareResume()).toBeDefined();
  });
  it.each(['suspend', 'cancel'] as const)('recovers persisted uncertain %s through restart without granting late callbacks authority', kind => {
    const s = fixture(); const execution = s.controller.admitInput('old-turn');
    s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.controller.beginControl(kind, 'old-control', kind === 'cancel' ? execution : undefined);
    s.controller.controlStarted('old-control'); s.controller.controlResult('old-control', 'uncertain');
    s.ds = { ...s.ds, session: structuredClone(s.ds.session) };
    s.store.close(); const reopened = new SessionContractStore(s.data, s.appId); handles.push(reopened);
    const controller = new SessionController(s.ds, reopened);
    const restart = controller.beginControl('restart', 'recovery-restart');
    expect(restart.joined).toBe(false); expect(restart.operation.previousLifecycle).toBe('active');
    controller.controlStarted('recovery-restart');
    expect(controller.allowsInput()).toBe(false);
    expect(reopened.operation(s.ref, 'old-control')).toMatchObject({ phase: 'uncertain', error: 'superseded_by_restart' });
    controller.controlResult('old-control', 'confirmed');
    expect(reopened.read(s.ref)).toMatchObject({ lifecycle: 'active', activeOperationId: 'recovery-restart' });
    expect(controller.allowsInput()).toBe(false);
    const next = controller.reserveBinding('recovery-runtime', s.worker);
    controller.bindRuntime('recovery-runtime', s.worker, { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' }, 'recovery-restart');
    controller.ingest({ type: 'ready', sessionContract: s.context(1, {}) }, s.worker);
    controller.ingest({ type: 'prompt_ready', sessionContract: s.context(2, { runtime: next }) }, s.worker);
    controller.ingest({ type: 'restart_result', attemptId: 'recovery-restart', status: 'succeeded', sessionContract: s.context(3, { runtime: next, operationId: 'recovery-restart' }) }, s.worker);
    expect(controller.allowsInput()).toBe(true); expect(s.ds.cliReady).toBe(true);
    controller.ingest({ type: 'turn_terminal', turnId: 'old-turn', status: 'completed', sessionContract: s.context(4, { runtime: s.runtime, execution }) }, s.worker);
    expect(controller.currentRuntime()).toEqual(next); expect(s.ds.cliReady).toBe(true);
    expect(reopened.execution(s.ref, execution.executionId)?.phase).toBe('succeeded');
  });
  it.each(['suspend', 'cancel'] as const)('does not restart over an applying %s or lift its fence on ordinary readiness', kind => {
    const s = fixture(); const execution = s.controller.admitInput('old-turn'); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.controller.beginControl(kind, 'active-control', kind === 'cancel' ? execution : undefined); s.controller.controlStarted('active-control');
    expect(() => s.controller.beginControl('restart')).toThrow('control_operation_in_progress');
    s.controller.controlResult('active-control', 'uncertain');
    s.controller.ingest({ type: 'ready', sessionContract: s.context(1, {}) }, s.worker);
    s.controller.ingest({ type: 'prompt_ready', sessionContract: s.context(2) }, s.worker);
    expect(s.controller.allowsInput()).toBe(false); expect(s.controller.operation()?.operationId).toBe('active-control');
  });
  it.each(['suspend', 'cancel'] as const)('starts physical recovery for persisted uncertain %s through the actual restart route', kind => {
    const s = fixture(); const execution = s.controller.admitInput('old-turn'); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.controller.beginControl(kind, 'uncertain-control', kind === 'cancel' ? execution : undefined);
    s.controller.controlStarted('uncertain-control'); s.controller.controlResult('uncertain-control', 'uncertain');
    const ds = { ...s.ds, session: structuredClone(s.ds.session), worker: null } as DaemonSession;
    s.store.close(); const reopened = new SessionContractStore(s.data, s.appId); handles.push(reopened);
    const controller = new SessionController(ds, reopened);
    const scope: any = { RestartCoordinator, findActiveBySessionId: () => ds, controllerForSession: () => controller,
      isSessionTransferring: () => false, sessionContractPrimary: () => false,
      destroyLivePaneBeforeRestart: vi.fn(), forkWorker: vi.fn(), logger: { warn: vi.fn() }, tag: () => 'test' };
    scope.restartCoordinator = loadWorkerPoolClosure('restartCoordinator', scope);
    const restart = loadWorkerPoolFunction<(ds: DaemonSession, observer: any) => any>('requestSessionRestart', scope);
    try {
      const request = restart(ds, { source: 'slash', notify: vi.fn() });
      expect(request).toMatchObject({ joined: false }); expect(request.startFailure).toBeUndefined();
      expect(scope.destroyLivePaneBeforeRestart).toHaveBeenCalledWith(ds);
      expect(scope.forkWorker).toHaveBeenCalledWith(ds, '', expect.objectContaining({ restartAttemptId: request.attemptId }));
      expect(controller.operation()).toMatchObject({ operationId: request.attemptId, kind: 'restart', phase: 'applying' });
      expect(controller.allowsInput()).toBe(false);
    } finally { scope.restartCoordinator.reset(); }
  });
  it('records predecessor loss as history in the reserve-only window and still handles the later current crash', async () => {
    const s = fixture(); const execution = s.controller.admitInput('old-turn'); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.controller.ingest({ type: 'ready', sessionContract: s.context(1, {}) }, s.worker);
    s.controller.ingest({ type: 'prompt_ready', sessionContract: s.context(2) }, s.worker);
    const next = s.controller.reserveBinding('pending-next', s.worker);
    const legacy = vi.fn(); const worker = { send: vi.fn() }; s.ds.worker = worker as any;
    const scope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: legacy };
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', scope);
    expect(s.controller.gateway.admit('claude_exit', s.context(3), s.worker).kind).toBe('historical');
    await handler({ type: 'claude_exit', code: 0, sessionContract: s.context(3) });
    expect(legacy).not.toHaveBeenCalled();
    expect(s.store.runtime(s.ref, s.runtime.runtimeId)?.phase).toBe('stopped');
    expect(s.store.execution(s.ref, execution.executionId)?.phase).toBe('reconciling');
    expect(s.store.runtime(s.ref, next.runtimeId)?.phase).toBe('starting');
    s.controller.bindRuntime('pending-next', s.worker, { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' });
    s.controller.ingest({ type: 'prompt_ready', sessionContract: s.context(4, { runtime: next }) }, s.worker);
    expect(s.ds.cliReady).toBe(true);
    await handler({ type: 'claude_exit', code: 1, sessionContract: s.context(5, { runtime: next }) });
    expect(legacy).toHaveBeenCalledOnce();
    expect(s.ds.cliReady).toBe(false);
  });
  it('does not mistake allocator high water or an orphaned reused reservation for an outstanding replacement', () => {
    const s = fixture(); const old = s.store.runtime(s.ref)!;
    const next = s.controller.reserveBinding('reuse-same-process', s.worker);
    const reused = s.controller.bindRuntime('reuse-same-process', s.worker, old.identity!);
    expect(reused.ref).toEqual(s.runtime); expect(next.epoch).toBeGreaterThan(s.runtime.epoch);
    expect(s.store.runtime(s.ref, next.runtimeId)?.phase).toBe('starting');
    expect(s.store.runtime(s.ref, next.runtimeId)?.identity).toBeUndefined();
    expect(s.store.hasPendingRuntimeReplacement(s.ref, s.runtime)).toBe(false);
    expect(s.controller.ingest({ type: 'claude_exit', code: 1, sessionContract: s.context(1) }, s.worker).kind).toBe('current');
    expect(s.store.runtime(s.ref)?.phase).toBe('stopped');
  });
  it('ignores reservations left by an older worker when classifying the current physical exit', () => {
    const s = fixture(); const identity = s.store.runtime(s.ref)!.identity!;
    s.controller.reserveBinding('abandoned-reservation', s.worker);
    const worker = s.controller.bindWorker(2).worker;
    s.controller.reserveBinding('reattach', worker); s.controller.bindRuntime('reattach', worker, identity);
    const context = { ...s.context(1), producer: worker, eventId: `${worker.workerId}:1` };
    expect(s.store.hasPendingRuntimeReplacement(s.ref, s.runtime)).toBe(false);
    expect(s.controller.ingest({ type: 'claude_exit', code: 1, sessionContract: context }, worker).kind).toBe('current');
  });
  it.each([false, true])('handles a physical exit across semantic bindings without overriding a pending replacement (pending=%s)', pending => {
    const s = fixture();
    const semantic = s.controller.reserveBinding('same-physical-new-conversation', s.worker);
    s.controller.bindRuntime('same-physical-new-conversation', s.worker, { ...s.store.runtime(s.ref)!.identity!, nativeSessionId: 'native2' });
    const next = pending ? s.controller.reserveBinding('pending-replacement', s.worker) : undefined;
    const admission = s.controller.ingest({ type: 'claude_exit', code: 1, sessionContract: s.context(1) }, s.worker);
    expect(admission.kind).toBe(pending ? 'historical' : 'current');
    expect(s.store.runtime(s.ref, semantic.runtimeId)?.phase).toBe('stopped');
    if (next) expect(s.store.runtime(s.ref, next.runtimeId)?.phase).toBe('starting');
  });
  it.each(['recover', 'stopped', 'retiring', 'different_pid', 'different_sid', 'middle_attempt', 'confirmed_binding', 'foreign_binding', 'history_gap', 'historical_switch', 'candidate_switch'] as const)(
    'repairs only a proven uninterrupted unresolved runtime through a bare observation: %s', condition => {
    const s = fixture(); const old = s.store.runtime(s.ref)!;
    const execution = s.controller.admitInput('old-active'); s.store.bindQueuedExecution(s.ref, execution, old.ref);
    s.store.apply(s.ref, { type: 'execution_terminal', execution, runtime: old.ref, status: 'reconciling', evidence: 'observer_loss' });
    if (condition !== 'retiring') s.store.apply(s.ref, { type: 'runtime_lost', runtime: old.ref, confirmed: condition === 'stopped' });
    if (condition === 'candidate_switch') {
      const current = s.store.runtime(s.ref)!;
      s.store.apply(s.ref, { type: 'runtime_bound', runtime: { ...current, identity: { ...current.identity!, nativeSessionId: 'native-other' } } });
      s.store.apply(s.ref, { type: 'runtime_bound', runtime: current });
    }
    let worker = s.controller.bindWorker(2).worker;
    if (condition === 'different_sid') {
      s.controller.reserveBinding('known-transition', worker);
      s.controller.bindRuntime('known-transition', worker, { ...old.identity!, nativeSessionId: 'native-other' });
    }
    const middle = s.controller.reserveBinding('middle-bare', worker);
    s.controller.bindRuntime('middle-bare', worker, { backend: 'tmux', physicalId: condition === 'different_pid' ? '222:start2' : '111:start1', proof: 'process_start' });
    if (condition === 'historical_switch') {
      const current = s.store.runtime(s.ref)!;
      s.store.apply(s.ref, { type: 'runtime_bound', runtime: { ...current, identity: { ...current.identity!, nativeSessionId: 'native-other' } } });
      s.store.apply(s.ref, { type: 'runtime_bound', runtime: current });
    }
    if (condition === 'history_gap') {
      const checkpoint = s.store.snapshot(s.ref);
      checkpoint.tables.events = checkpoint.tables.events.filter(row => row.type !== 'runtime_reserved'
        || JSON.parse(row.value as string).runtime.ref.runtimeId !== middle.runtimeId);
      s.store.restore(checkpoint);
    }
    if (condition === 'middle_attempt') {
      const active = s.controller.admitInput('middle-active'); s.store.bindQueuedExecution(s.ref, active, middle);
    }
    if (condition === 'foreign_binding') worker = s.controller.bindWorker(3).worker;
    const bindingId = ['confirmed_binding', 'foreign_binding'].includes(condition) ? 'middle-bare' : 'new-proof';
    if (!['confirmed_binding', 'foreign_binding'].includes(condition)) s.controller.reserveBinding(bindingId, worker);
    if (condition === 'middle_attempt' || condition === 'foreign_binding') {
      expect(() => s.controller.bindRuntime(bindingId, worker, old.identity!)).toThrow(condition === 'middle_attempt' ? 'runtime_recovery_has_active_execution' : 'runtime_binding_producer_mismatch');
      expect(s.store.runtime(s.ref)?.ref).toEqual(middle);
      expect(s.store.binding(s.ref, 'middle-bare')?.ref).toEqual(middle);
      return;
    }
    const result = s.controller.bindRuntime(bindingId, worker, old.identity!);
    if (condition === 'recover') expect(result.ref).toEqual(old.ref);
    else expect(result.ref).not.toEqual(old.ref);
    if (condition === 'confirmed_binding') expect(result.ref).toEqual(middle);
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ phase: 'reconciling', runtime: old.ref });
    expect(s.store.binding(s.ref, 'middle-bare')?.ref).toEqual(middle);
    if (condition === 'recover') expect(s.store.read(s.ref)?.runtimeEpoch).toBe(3);
  });
  it('uses fresh unambiguous PID-owned native identity on a busy reattach before granting the binding', () => {
    const s = fixture(); const old = s.store.runtime(s.ref)!;
    const replacementWorker = s.controller.bindWorker(2).worker;
    const scope = new WorkerSessionEventScope(s.ref, replacementWorker); const binding = scope.beginRuntime();
    const env: any = { backend: { cliPid: 111 }, codexRpcEngine: undefined, effectiveBackendType: 'tmux',
      lastInitConfig: { cliId: 'traex', cliSessionId: 'untrusted-config-id' },
      readProcessStartIdentity: () => 'start1', findTraexRolloutSetByPid: () => new Set(['native1']),
      findTraexRolloutByPid: () => ({ path: '/owned', cliSessionId: 'native1' }) };
    const identity = loadWorkerFunction<(binding: any) => any>('runtimeIdentityForContract', env);
    s.controller.reserveBinding(binding.bindingId, replacementWorker);
    const restored = s.controller.bindRuntime(binding.bindingId, replacementWorker, identity(binding));
    expect(restored.ref).toEqual(old.ref); expect(restored.identity?.nativeSessionId).toBe('native1');
    env.findTraexRolloutSetByPid = () => new Set(['native1', 'native2']);
    expect(identity(scope.beginRuntime()).nativeSessionId).toBeUndefined();
    env.findTraexRolloutSetByPid = () => new Set(['native2']);
    env.findTraexRolloutByPid = () => ({ path: '/new-owned', cliSessionId: 'native2' });
    const rotated = scope.beginRuntime(); s.controller.reserveBinding(rotated.bindingId, replacementWorker);
    expect(s.controller.bindRuntime(rotated.bindingId, replacementWorker, identity(rotated)).ref).not.toEqual(old.ref);
    env.findTraexRolloutByPid = () => { env.backend = { cliPid: 222 }; return { path: '/new-owned', cliSessionId: 'native2' }; };
    expect(identity(scope.beginRuntime()).proof).toBe('opaque');
    env.backend = { cliPid: 111 }; env.workerSessionEventScope = scope;
    env.findTraexRolloutByPid = () => { scope.beginRuntime(); return { path: '/new-owned', cliSessionId: 'native2' }; };
    expect(identity(scope.beginRuntime()).proof).toBe('opaque');
    env.findTraexRolloutByPid = () => ({ path: '/new-owned', cliSessionId: 'native2' });
    env.readProcessStartIdentity = vi.fn().mockReturnValueOnce('start1').mockReturnValueOnce('start2');
    expect(identity(scope.beginRuntime()).proof).toBe('opaque');
  });
  it('keeps delayed predecessor exits out of legacy consumers while preserving scoped runtime evidence', () => {
    const s = fixture(); const original = { write: vi.fn() }; const replacement = { write: vi.fn() };
    const callback = vi.fn(); const wire: any[] = [];
    const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = scope.beginRuntime(); scope.assign(binding.bindingId, s.runtime);
    const env: any = { backend: original, workerSessionEventScope: undefined, intentionalRestartBackend: original,
      fenceContractBackendWrites: vi.fn(), send: (message: any) => wire.push(message) };
    env.bindSessionRuntimeCallback = loadWorkerFunction('bindSessionRuntimeCallback', env);
    const bindExit = loadWorkerFunction<(callback: (...args: any[]) => void) => (...args: any[]) => void>('bindSessionBackendExit', env);
    const legacyExit = bindExit(callback); env.backend = replacement; legacyExit(0, null);
    expect(wire).toHaveLength(0); expect(callback).not.toHaveBeenCalled();
    expect(env.intentionalRestartBackend).toBeNull();
    env.backend = original; env.workerSessionEventScope = scope;
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
    env.send = (message: any) => wire.push(metadata(message));
    const scopedExit = scope.run(binding, () => bindExit(callback));
    const nextBinding = scope.beginRuntime();
    const next = s.controller.reserveBinding(nextBinding.bindingId, s.worker); scope.assign(nextBinding.bindingId, next);
    s.controller.bindRuntime(nextBinding.bindingId, s.worker, { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' });
    env.backend = replacement; scopedExit(0, null);
    expect(wire).toHaveLength(1); expect(wire[0].sessionContract.scope.runtime).toEqual(s.runtime);
    expect(s.controller.ingest(wire[0], s.worker).kind).toBe('historical');
    expect(s.store.runtime(s.ref, next.runtimeId)?.phase).toBe('starting');
    expect(callback).not.toHaveBeenCalled();
  });
  it('rejects an invalid old event before it can bind a queued attempt', () => {
    const s = fixture(); const execution = s.controller.admitInput('turnA');
    const next = s.controller.reserveBinding('binding-next', s.worker);
    s.controller.bindRuntime('binding-next', s.worker, { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' });
    expect(s.controller.ingest({ type: 'turn_execution_started', turnId: 'turnA', sessionContract: s.context(1, { runtime: s.runtime, execution }) }, s.worker).kind).toBe('reject');
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined();
    expect(s.controller.ingest({ type: 'turn_execution_started', turnId: 'turnA', sessionContract: s.context(2, { runtime: next, execution }) }, s.worker).kind).toBe('current');
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toEqual(next);
  });
  it('does not let an older screen observation revoke newer prompt readiness', () => {
    const s = fixture(); s.controller.ingest({ type: 'ready', sessionContract: s.context(1, {}) }, s.worker);
    s.controller.ingest({ type: 'prompt_ready', sessionContract: s.context(3) }, s.worker);
    expect(s.ds.cliReady).toBe(true);
    expect(s.controller.ingest({ type: 'screen_update', status: 'working', sessionContract: s.context(2) }, s.worker).kind).toBe('reject');
    expect(s.ds.cliReady).toBe(true);
  });
  it('requires the admitted full attempt even for a worker-scoped queued ACK', () => {
    const s = fixture(); const execution = s.controller.admitInput('turnA', 1);
    const ack = { type: 'turn_input_committed', turnId: 'turnA', dispatchAttempt: 1, sessionContract: s.context(1, { execution: { ...execution, executionId: 'never-admitted' } }) };
    expect(s.controller.ingest(ack, s.worker).kind).toBe('reject');
    expect(s.controller.ingest({ ...ack, sessionContract: s.context(2, { execution }) }, s.worker).kind).toBe('worker');
  });
  it('restores managed turn authority before a queued attempt has execution evidence', async () => {
    const s = fixture(); const execution = s.controller.admitInput('restored-turn', 1);
    const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = scope.beginRuntime(); scope.assign(binding.bindingId, s.runtime);
    scope.noteAdmission({ ref: execution, phase: 'queued' });
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: scope });
    const worker: any = { send: vi.fn() }; s.ds.worker = worker;
    const handlerScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker,
      logger: { debug: vi.fn(), warn: vi.fn() }, t: 'test', botCfg: {}, sessionCliId: () => 'claude-code',
      currentGatewayCallerOpenId: () => 'ou_requester', currentTurnProcessIdentities: () => ['111:start1'],
      noteTurnDispatchAttempt: vi.fn(), ensureAutomaticTaskContinuationLease: vi.fn() };
    const legacy = vi.fn(loadWorkerPoolClosure<(message: any) => Promise<void>>('handleLegacyWorkerMessage', handlerScope));
    handlerScope.handleLegacyWorkerMessage = legacy;
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', handlerScope);
    const publish = scope.run(binding, () => metadata({ type: 'managed_turn_origin', sessionId: s.ref.sessionId,
      turnId: 'restored-turn', dispatchAttempt: 1, capability: 'restored-capability' }));
    await handler(publish);
    expect(legacy).toHaveBeenCalledWith(publish);
    expect(s.ds.managedTurnOrigin).toMatchObject({ capability: 'restored-capability', turnId: 'restored-turn', dispatchAttempt: 1 });
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ phase: 'queued' });
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined();
    const revoke = scope.run(binding, () => metadata({ type: 'managed_turn_origin_revoked', sessionId: s.ref.sessionId,
      turnId: 'restored-turn', dispatchAttempt: 1, capability: 'restored-capability' }));
    await handler(revoke);
    expect(legacy).toHaveBeenCalledWith(revoke);
    expect(s.ds.managedTurnOrigin).toBeUndefined();
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined();
  });
  it('rejects queued turn authority from unproven attempts and superseded runtimes or workers', () => {
    const s = fixture(); const execution = s.controller.admitInput('queued-turn', 1);
    let sequence = 0;
    const event = (type: string, runtime = s.runtime, admitted = execution) => ({ type, turnId: 'queued-turn', dispatchAttempt: 1,
      sessionContract: s.context(++sequence, { runtime, execution: admitted }) });
    for (const type of ['managed_turn_origin', 'managed_turn_origin_revoked']) {
      expect(s.controller.ingest(event(type, s.runtime, { ...execution, executionId: 'unadmitted' }), s.worker).kind).toBe('reject');
      expect(s.controller.ingest({ ...event(type), dispatchAttempt: 2 }, s.worker).kind).toBe('reject');
    }
    const next = s.controller.reserveBinding('authority-next', s.worker);
    s.controller.bindRuntime('authority-next', s.worker, { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' });
    for (const type of ['managed_turn_origin', 'managed_turn_origin_revoked']) {
      expect(s.controller.ingest(event(type), s.worker).kind).toBe('reject');
      expect(s.controller.ingest(event(type, next), s.worker).kind).toBe('current');
    }
    s.controller.bindWorker(2);
    for (const type of ['managed_turn_origin', 'managed_turn_origin_revoked']) {
      expect(s.controller.ingest(event(type, next), s.worker).kind).toBe('reject');
    }
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ phase: 'queued' });
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined();
  });
  it('does not grant managed authority to an unbound attempt that is reconciling or terminal', () => {
    const s = fixture(); const execution = s.controller.admitInput('lost-turn', 1);
    s.store.apply(s.ref, { type: 'execution_terminal', execution, runtime: s.runtime, status: 'reconciling', evidence: 'observer_loss' });
    let sequence = 0;
    const event = (type: string) => ({ type, turnId: 'lost-turn', dispatchAttempt: 1,
      sessionContract: s.context(++sequence, { runtime: s.runtime, execution }) });
    for (const type of ['managed_turn_origin', 'managed_turn_origin_revoked']) {
      expect(s.controller.ingest(event(type), s.worker).kind).toBe('reject');
    }
    s.store.apply(s.ref, { type: 'execution_terminal', execution, runtime: s.runtime, status: 'succeeded', evidence: 'native_terminal' });
    for (const type of ['managed_turn_origin', 'managed_turn_origin_revoked']) {
      expect(s.controller.ingest(event(type), s.worker).kind).toBe('reject');
    }
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ phase: 'succeeded' });
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined();
  });
  it('rejects managed authority without an ExecutionRef before creating an unknown attempt', async () => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = scope.beginRuntime(); scope.assign(binding.bindingId, s.runtime);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: scope });
    const worker: any = { send: vi.fn() }; s.ds.worker = worker;
    const legacy = vi.fn();
    const handlerScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker,
      logger: { debug: vi.fn(), warn: vi.fn() }, t: 'test', handleLegacyWorkerMessage: legacy };
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', handlerScope);
    const revision = s.store.read(s.ref)?.revision;
    for (const type of ['managed_turn_origin', 'managed_turn_origin_revoked']) {
      const wire = scope.run(binding, () => metadata({ type, sessionId: s.ref.sessionId, turnId: 'never-admitted', capability: 'unknown-capability' }));
      expect(wire.sessionContract.scope.execution).toBeUndefined();
      await handler(wire);
      expect(handlerScope.logger.warn).toHaveBeenLastCalledWith(
        `[test] Dropped ${type} from current worker turn=never-admitted reason=execution_scope_missing`);
    }
    expect(legacy).not.toHaveBeenCalled();
    expect(s.ds.managedTurnOrigin).toBeUndefined();
    expect(s.store.executions(s.ref)).toHaveLength(0);
    expect(s.store.read(s.ref)?.revision).toBe(revision);
  });
  it('publishes process attestation while the opening attempt is still unbound', async () => {
    const s = fixture(); const execution = s.controller.admitInput('opening-turn', 1);
    const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = scope.beginRuntime(); scope.assign(binding.bindingId, s.runtime);
    scope.rememberExecution(execution, binding);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: scope });
    const wire = scope.run(binding, () => metadata({ type: 'local_process_attestation', backendType: 'tmux',
      credentialIsolated: false, cliPid: 111, cliProcStart: 'start1' }), execution);
    const worker: any = { send: vi.fn() }; s.ds.worker = worker; s.ds.workerGeneration = 1;
    const handlerScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker,
      workerGeneration: 1,
      logger: { debug: vi.fn(), warn: vi.fn() }, t: 'test', botCfg: {}, sessionCliId: () => 'claude-code' };
    handlerScope.handleLegacyWorkerMessage = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleLegacyWorkerMessage', handlerScope);
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', handlerScope);
    await handler(wire);
    expect(s.ds.localProcessAttestation).toMatchObject({ cliPid: 111, cliProcStart: 'start1', workerGeneration: 1 });
    expect(wire.sessionContract.scope).toEqual({ runtime: s.runtime });
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ phase: 'queued' });
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined();
  });
  it('keeps a frozen callback origin through the actual metadata wrapper', async () => {
    vi.useFakeTimers(); const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const old = scope.beginRuntime('restart-old'); scope.assign(old.bindingId, s.runtime);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: scope });
    const sent: any[] = [];
    scope.run(old, () => { setTimeout(scope.bind(() => sent.push(metadata({ type: 'restart_result', attemptId: 'restart-new', status: 'succeeded' }))), 10); }, undefined, 'restart-old');
    scope.beginRuntime('restart-new'); await vi.advanceTimersByTimeAsync(11);
    expect(sent[0].sessionContract.scope).toMatchObject({ runtime: s.runtime, operationId: 'restart-old' });
    expect(s.controller.ingest(sent[0], s.worker).kind).toBe('reject');
  });
  it('uses the current cancel operation on a runtime born under a previous restart', () => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = scope.beginRuntime('completed-restart'); scope.assign(binding.bindingId, s.runtime);
    const execution = s.controller.admitInput('turnA', 1); scope.rememberExecution(execution, binding);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: scope });
    const reply = scope.run(binding, () => metadata({ type: 'turn_interrupt_result', turnId: 'turnA', requestId: 'cancel-current', delivered: true }), execution, 'cancel-current');
    expect(reply.sessionContract.scope.operationId).toBe('cancel-current');
    expect(reply.sessionContract.scope.execution).toEqual(execution);
  });
  it('does not issue a start permit when the worker changes during the reservation await', async () => {
    const s = fixture(); const send = vi.fn(); const worker: any = { send }; s.ds.worker = worker;
    const scope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: vi.fn() };
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', scope); scope.handleWorkerMessage = handler;
    const pending = handler({ type: 'runtime_binding_started', bindingId: 'binding-start', sessionContract: { ...s.context(1, {}), bindingId: 'binding-start' } });
    s.controller.bindWorker(2); s.ds.worker = { send: vi.fn() } as any; await pending;
    expect(send.mock.calls.some(([message]) => message.type === 'runtime_contract_reserved' && message.mayStart)).toBe(false);
  });
  it('reconciles a timed-out cancellation from native completion and leaves output intact', () => {
    const s = fixture(); const execution = s.controller.admitInput('turnA', 1); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.controller.beginControl('cancel', 'cancel1', execution); s.controller.controlStarted('cancel1'); s.controller.controlResult('cancel1', 'uncertain');
    s.controller.ingest({ type: 'turn_terminal', turnId: 'turnA', dispatchAttempt: 1, status: 'completed', sessionContract: s.context(1, { runtime: s.runtime, execution }) }, s.worker);
    expect(s.controller.allowsInput()).toBe(true); expect(s.store.execution(s.ref, execution.executionId)?.phase).toBe('succeeded');
  });
  it('preserves suspend intent after a rejected close and never reuses an allocated epoch on restore', () => {
    const s = fixture(); s.controller.beginControl('suspend', 'suspend1'); s.controller.controlResult('suspend1', 'confirmed');
    s.controller.beginControl('close', 'close1'); s.controller.controlResult('close1', 'rejected');
    expect(s.store.read(s.ref)?.lifecycle).toBe('suspended');
    const snapshot = s.store.snapshot(s.ref); const unused = s.store.reserveRuntime(s.ref, s.worker);
    s.store.restore(snapshot); expect(s.store.reserveRuntime(s.ref, s.worker).epoch).toBeGreaterThan(unused.epoch);
  });
  it('does not let an already confirmed binding change physical identity', () => {
    const s = fixture(); expect(() => s.controller.bindRuntime('binding-old', s.worker, { backend: 'tmux', physicalId: 'other-process', nativeSessionId: 'other-native', proof: 'process_start' })).toThrow('runtime_identity_changed');
    expect(s.store.runtime(s.ref)?.identity?.physicalId).toBe('111:start1');
  });
  it.each([
    { name: 'launcher PID resolves to the CLI', initialPid: 111, resolvedPid: 222, initialNative: undefined, nextNative: 'native-cli', replaces: true },
    { name: 'native session becomes known', initialPid: 111, resolvedPid: 111, initialNative: undefined, nextNative: 'native-cli', replaces: false },
    { name: 'native session rotates', initialPid: 111, resolvedPid: 111, initialNative: 'native-old', nextNative: 'native-cli', replaces: true },
    { name: 'PID changes with the same native session', initialPid: 111, resolvedPid: 222, initialNative: 'native-cli', nextNative: 'native-cli', replaces: true },
    { name: 'the native session is observed again', initialPid: 111, resolvedPid: 111, initialNative: 'native-cli', nextNative: 'native-cli', replaces: false },
    { name: 'a Claude session becomes known', cliId: 'claude-code', initialPid: 111, resolvedPid: 111, initialNative: undefined, nextNative: 'native-cli', replaces: false },
    { name: 'a PTY launcher resolves to the CLI', backendType: 'pty', initialPid: 111, resolvedPid: 222, initialNative: undefined, nextNative: 'native-cli', replaces: true },
  ])('admits dispatch after $name without changing the proven predecessor', async ({ initialPid, resolvedPid, initialNative, nextNative, replaces, cliId = 'codex-app', backendType = 'tmux' }) => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = scope.beginRuntime();
    const identity = { backend: backendType, physicalId: `${initialPid}:start${initialPid}`, proof: 'process_start' as const,
      ...(initialNative ? { nativeSessionId: initialNative } : {}) };
    binding.identity = identity;
    s.controller.reserveBinding(binding.bindingId, s.worker);
    const first = s.controller.bindRuntime(binding.bindingId, s.worker, identity);
    scope.assign(binding.bindingId, first.ref);
    const pending: Promise<void>[] = [];
    const env: any = { workerSessionEventScope: scope, backend: { cliPid: resolvedPid }, effectiveBackendType: backendType,
      lastInitConfig: { cliId }, readProcessStartIdentity: (pid: number) => `start${pid}` };
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
    env.runtimeIdentityForContract = loadWorkerFunction('runtimeIdentityForContract', env);
    env.publishRuntimeContract = loadWorkerFunction('publishRuntimeContract', env);
    const observe = loadWorkerFunction<(nativeSessionId: string) => void>('observeContractNativeSession', env);
    const execution = s.controller.admitInput('turnA');
    scope.noteAdmission({ ref: execution, phase: 'queued' });
    const worker: any = { send: vi.fn((message: any) => {
      if (message.type === 'runtime_contract_assigned') scope.assign(message.bindingId, message.runtime);
    }) }; s.ds.worker = worker;
    const legacy = vi.fn(); const logger = { warn: vi.fn(), debug: vi.fn() };
    const hostScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger, t: 'test', handleLegacyWorkerMessage: legacy };
    s.ds.session.codexAppDispatchLedger = [{ dispatchId: 'dispatch', turnId: 'turnA', content: 'prompt', state: 'accepted' }];
    hostScope.botCfg = {}; hostScope.sessionCliId = () => 'codex-app';
    hostScope.prepareCodexAppDispatch = prepareCodexAppDispatch; hostScope.hasUnsettledCodexAppDispatch = hasUnsettledCodexAppDispatch;
    hostScope.sessionStore = { updateSession: vi.fn() };
    const legacyHandler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleLegacyWorkerMessage', hostScope);
    legacy.mockImplementation(legacyHandler);
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostScope); hostScope.handleWorkerMessage = host;
    env.send = (message: any) => { pending.push(host(metadata(message))); };
    let dispatch: any;
    scope.run(binding, () => {
      observe(nextNative);
      scope.enterTurn('turnA');
      dispatch = metadata({ type: 'codex_app_dispatch_transition', sessionId: s.ref.sessionId,
        requestId: 'prepare-request', operation: 'submit', entries: [{ dispatchId: 'dispatch', turnId: 'turnA' }] });
    });
    await Promise.all(pending);
    await host(dispatch);
    const current = scope.currentBinding()!;
    expect(logger.warn).not.toHaveBeenCalled();
    expect(current.bindingId === binding.bindingId).toBe(!replaces);
    expect(s.store.runtime(s.ref)?.identity).toMatchObject({ physicalId: `${resolvedPid}:start${resolvedPid}`, nativeSessionId: nextNative });
    expect(current.runtime).toEqual(s.store.runtime(s.ref)?.ref);
    if (replaces) expect(s.store.runtime(s.ref, first.ref.runtimeId)?.identity).toEqual(identity);
    expect(legacy).toHaveBeenCalledWith(dispatch);
    expect(hostScope.sessionStore.updateSession).toHaveBeenCalledWith(s.ds.session);
    expect(s.ds.session.codexAppDispatchLedger[0].state).toBe('prepared');
    expect(worker.send).toHaveBeenCalledWith({ type: 'codex_app_dispatch_persisted', requestId: 'prepare-request', ok: true });
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ phase: 'queued' });
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined();
    // A delayed callback captured before replacement cannot take executor control.
    if (replaces) {
      expect(s.controller.ingest(scope.run(binding, () => metadata({ type: 'prompt_ready' })), s.worker).kind).toBe('reject');
      const revision = s.store.read(s.ref)!.revision;
      scope.run(binding, () => observe('stale-native'));
      expect(scope.currentBinding()).toBe(current);
      expect(s.store.read(s.ref)!.revision).toBe(revision);
    }
  });
  it.each(['native1', 'late-native'])('retains the proven binding for its captured exit after a late %s observation loses PID proof', async nativeSessionId => {
    vi.useFakeTimers(); const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const binding = scope.beginRuntime(); binding.identity = s.store.runtime(s.ref)!.identity;
    scope.assign(binding.bindingId, s.runtime);
    let processAlive = true;
    const env: any = { workerSessionEventScope: scope, backend: { cliPid: 111 }, effectiveBackendType: 'tmux',
      lastInitConfig: { cliId: 'claude-code' }, readProcessStartIdentity: () => processAlive ? 'start1' : undefined };
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
    env.runtimeIdentityForContract = loadWorkerFunction('runtimeIdentityForContract', env);
    env.publishRuntimeContract = loadWorkerFunction('publishRuntimeContract', env);
    const observe = loadWorkerFunction<(id: string) => void>('observeContractNativeSession', env);
    const pending: Promise<void>[] = [];
    const worker: any = { send: vi.fn() }; s.ds.worker = worker;
    const hostScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: vi.fn() };
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostScope); hostScope.handleWorkerMessage = host;
    env.send = vi.fn((message: any) => { pending.push(host(metadata(message))); });
    scope.run(binding, () => {
      setTimeout(() => { processAlive = false; }, 5);
      setTimeout(scope.bind(() => observe(nativeSessionId)), 10);
    });
    await vi.advanceTimersByTimeAsync(15); await Promise.all(pending);
    expect(scope.currentBinding()).toBe(binding);
    expect(env.send).not.toHaveBeenCalled();
    const exit = scope.run(binding, () => metadata({ type: 'claude_exit', code: 0 }));
    expect(s.controller.ingest(exit, s.worker).kind).toBe('current');
    expect(s.store.runtime(s.ref)).toMatchObject({ ref: s.runtime, phase: 'stopped', identity: { proof: 'process_start', nativeSessionId: 'native1' } });
  });
  it('rejects a conflicting output sidecar before any output or attempt write', () => {
    const s = fixture(); const a = s.controller.admitInput('turnA'); const b = s.controller.admitInput('turnB');
    const before = s.store.execution(s.ref, a.executionId)!;
    const admission = s.controller.ingest({ type: 'final_output', turnId: 'turnA', content: 'body from B',
      sessionContract: s.context(1, { runtime: s.runtime, execution: a }),
      sessionOutputOrigin: s.context(2, { runtime: s.runtime, execution: b }) }, s.worker);
    expect(admission.kind).toBe('reject'); expect(s.store.execution(s.ref, a.executionId)).toEqual(before);
  });
  it.each(['unadmitted_execution', 'wrong_attempt', 'stale_runtime', 'stale_worker', 'execution_bound_elsewhere'])(
    'refuses dispatch preparation with %s', condition => {
      const s = fixture(); const execution = s.controller.admitInput('turnA', 1);
      let runtime = s.runtime;
      if (condition === 'execution_bound_elsewhere') s.store.bindQueuedExecution(s.ref, execution, runtime);
      if (condition === 'stale_runtime' || condition === 'execution_bound_elsewhere') {
        s.controller.reserveBinding('replacement', s.worker);
        const next = s.controller.bindRuntime('replacement', s.worker, { backend: 'tmux', physicalId: '222:start2', proof: 'process_start' });
        if (condition === 'execution_bound_elsewhere') runtime = next.ref;
      }
      if (condition === 'stale_worker') s.controller.bindWorker(2);
      const scoped = condition === 'unadmitted_execution' ? { ...execution, executionId: 'unknown' }
        : condition === 'wrong_attempt' ? { ...execution, dispatchAttempt: 2 } : execution;
      const message = { type: 'codex_app_dispatch_transition', operation: 'submit',
        entries: [{ dispatchId: 'dispatch', turnId: 'turnA', dispatchAttempt: 1 }],
        sessionContract: s.context(1, { runtime, execution: scoped }) };
      const before = s.store.read(s.ref)!.revision;
      expect(s.controller.ingest(message, s.worker).kind).toBe('reject');
      expect(s.store.read(s.ref)!.revision).toBe(before);
    },
  );
  it('does not treat different native generations as one physical executor', () => {
    const s = fixture(); const old = s.controller.reserveBinding('remote-old', s.worker);
    s.controller.bindRuntime('remote-old', s.worker, { backend: 'remote-runner', physicalId: 'remote1', proof: 'native_generation', nativeGeneration: '1', nativeSessionId: 'thread1' });
    const next = s.controller.reserveBinding('remote-next', s.worker);
    s.controller.bindRuntime('remote-next', s.worker, { backend: 'remote-runner', physicalId: 'remote1', proof: 'native_generation', nativeGeneration: '2', nativeSessionId: 'thread2' });
    s.controller.ingest({ type: 'ready', sessionContract: s.context(1, {}) }, s.worker);
    s.controller.ingest({ type: 'prompt_ready', sessionContract: s.context(2, { runtime: next }) }, s.worker);
    s.controller.ingest({ type: 'claude_exit', code: 1, sessionContract: s.context(3, { runtime: old }) }, s.worker);
    expect(s.store.runtime(s.ref)?.phase).toBe('ready'); expect(s.ds.cliReady).toBe(true);
    expect(s.controller.nativeSignal('remote-old', 'thread2')).toBeUndefined();
  });
  it('restores the real reservation-only wire scope without binding or resubmitting its original attempt', () => {
    const s = fixture(); const execution = s.controller.admitInput('turnQ');
    const original = new WorkerSessionEventScope(s.ref, s.worker); const binding = original.beginRuntime();
    s.controller.reserveBinding(binding.bindingId, s.worker); original.rememberExecution(execution, binding);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: original });
    const wire = original.run(binding, () => metadata({ type: 'final_output', sessionId: s.ref.sessionId, turnId: 'turnQ', content: 'saved answer', lastUuid: 'nativeQ' }), execution);
    expect(wire.sessionContract.scope.runtime).toBeUndefined();
    const stored = outputSnapshot(s.appId, wire); const nextWorker = s.controller.bindWorker(2).worker;
    const carrier = new WorkerSessionEventScope(s.ref, nextWorker); const sent: any[] = [];
    const recovery = new UniversalOutputHandoff({ appId: s.appId, sessionId: s.ref.sessionId, token: 'new', persist: vi.fn(), remove: vi.fn(), restore: () => [stored], send: value => sent.push(value), context: value => carrier.replayEnvelope(value), error: error => { throw error; } });
    recovery.start(); recovery.stop(); const origin = s.controller.outputOrigin(sent[0].sessionOutputOrigin)!;
    expect(s.controller.ingest(sent[0], nextWorker, origin).kind).toBe('historical');
    expect(s.store.execution(s.ref, execution.executionId)).toMatchObject({ phase: 'queued', output: { content: 'saved answer' } });
    expect(s.store.execution(s.ref, execution.executionId)?.runtime).toBeUndefined(); expect(s.store.executions(s.ref)).toHaveLength(1);
  });
  it('uses each native turn origin on a long-lived subscription and freezes work after event admission', async () => {
    vi.useFakeTimers(); const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const first = scope.beginRuntime(); scope.assign(first.bindingId, s.runtime);
    const a = s.controller.admitInput('turnA'); scope.rememberExecution(a, first);
    const received: any[] = [];
    const callback = scope.run(first, () => scope.bindExecutionEvent((turnId: string) => {
      setTimeout(scope.bind(() => received.push(scope.envelope())), 10);
    }, args => ({ turnId: args[0] })), a);
    const next = scope.beginRuntime(undefined, first.physicalId); scope.assign(next.bindingId, { runtimeId: 'semantic2', epoch: 2 });
    const b = s.controller.admitInput('turnB'); scope.rememberExecution(b, next);
    callback('turnB'); scope.beginRuntime(undefined, first.physicalId); await vi.advanceTimersByTimeAsync(11);
    expect(received[0].scope.runtime).toEqual(next.runtime); expect(received[0].scope.execution).toEqual(b);
  });
  it('keeps old timer observations separate from timers created by the new live data scope', async () => {
    vi.useFakeTimers(); const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const first = scope.beginRuntime(); scope.assign(first.bindingId, s.runtime); const received: any[] = [];
    const callback = scope.run(first, () => scope.bindObservation(() => received.push(scope.envelope())));
    scope.run(first, () => setTimeout(scope.bind(callback), 10));
    const next = scope.beginRuntime(undefined, first.physicalId); scope.assign(next.bindingId, { runtimeId: 'semantic2', epoch: 2 });
    scope.run(next, () => setTimeout(scope.bind(callback), 10)); await vi.advanceTimersByTimeAsync(11);
    expect(received.map(value => value.scope.runtime)).toEqual([first.runtime, next.runtime]);
  });
  it('prevents a literal submission from becoming a second submission after runtime replacement', () => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker); const first = scope.beginRuntime(); scope.assign(first.bindingId, s.runtime);
    const execution = s.controller.admitInput('turnA'); scope.rememberExecution(execution, first); expect(scope.canSubmit('turnA')).toBe(true);
    const mark = loadWorkerFunction<(turnId: string) => void>('markTurnExecutionStart', { workerSessionEventScope: scope,
      turnExecutionClock: { start: vi.fn() }, inputDeliveryEvidence: { start: vi.fn() }, cliSpawnGeneration: 1, send: vi.fn() });
    scope.run(first, () => mark('turnA'), execution); const next = scope.beginRuntime(); scope.assign(next.bindingId, { runtimeId: 'replacement', epoch: 2 });
    expect(scope.canSubmit('turnA')).toBe(false);
    const restored = new WorkerSessionEventScope(s.ref, s.worker); restored.noteAdmission({ ref: execution, runtime: s.runtime, phase: 'reconciling' });
    expect(restored.canSubmit('turnA')).toBe(false);
  });
  it('does not treat an ambiguous compact lookup as a fresh submission', async () => {
    const s = fixture(); const scope = new WorkerSessionEventScope(s.ref, s.worker);
    const a = s.controller.admitInput('turnA', 1); const b = s.controller.admitInput('turnA', 2);
    scope.noteAdmission({ ref: a, runtime: s.runtime, phase: 'succeeded' }); scope.noteAdmission({ ref: b, runtime: s.runtime, phase: 'reconciling' });
    expect(scope.canSubmit('turnA')).toBe(false); expect(scope.canSubmit('turnA', undefined, b)).toBe(false);
    const starts: string[] = []; const reservations = new Map();
    const spawn = loadWorkerFunction<(cfg: any) => Promise<void>>('spawnCli', { workerSessionEventScope: scope, pendingRuntimeReservations: reservations,
      activeRestartAttemptId: undefined, closeRequested: false, initialInputOwnershipPending: true,
      send: (message: any) => { if (message.type === 'runtime_binding_started') reservations.get(message.bindingId)(true); },
      spawnCliBody: async (cfg: any) => { starts.push(cfg.prompt); }, publishRuntimeContract: async () => {}, CliSpawnSupersededError: Error });
    await spawn({ turnId: 'turnA', prompt: 'must not replay', sessionCommand: { version: 2, execution: b } });
    expect(starts).toEqual(['']);
  });
  it('commits lifecycle, revision and dedup together or rolls the entire write back', () => {
    const s = fixture(); const db = openDatabaseSyncOrThrow(s.store.filename); handles.push(db);
    db.exec("CREATE TABLE sessions(session_id TEXT PRIMARY KEY,status TEXT,row TEXT); CREATE TRIGGER fail_projection BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'projection_failed'); END;");
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(s.ref.sessionId, 'active', JSON.stringify(s.ds.session));
    const before = s.store.read(s.ref)!; const operation = { operationId: 'close-atomic', kind: 'close' as const, phase: 'planned' as const, targetRuntime: s.runtime, expectedRevision: before.revision };
    expect(() => s.store.apply(s.ref, { type: 'control_requested', operation }, 'close-event')).toThrow('projection_failed');
    expect(s.store.read(s.ref)).toEqual(before); expect(s.store.operation(s.ref, operation.operationId)).toBeUndefined();
    db.exec('DROP TRIGGER fail_projection'); expect(s.store.apply(s.ref, { type: 'control_requested', operation }, 'close-event').decision).toBe('applied');
    const row = JSON.parse((db.prepare('SELECT row FROM sessions').get() as any).row);
    expect(row.sessionContractRevision).toBe(s.store.read(s.ref)?.revision); expect(row.sessionLifecycle).toBe('closing');
  });
  it('keeps output hashes and the original attempt while a new producer replays', () => {
    const s = fixture(); const execution = s.controller.admitInput('turnA'); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    const origin = s.context(1, { runtime: s.runtime, execution }); const plain = { type: 'final_output' as const, sessionId: s.ref.sessionId, turnId: 'turnA', content: 'answer', lastUuid: 'native-final' };
    const stored: OutputSnapshot = outputSnapshot(s.appId, { ...plain, sessionContract: origin });
    expect(stored.fingerprint).toBe(outputSnapshot(s.appId, plain).fingerprint); expect(stored.id).toBe(outputSnapshot(s.appId, plain).id);
    const carrier = new WorkerSessionEventScope(s.ref, { workerId: 'new-worker', generation: 2 }); const sent: any[] = [];
    const handoff = new UniversalOutputHandoff({ appId: s.appId, sessionId: s.ref.sessionId, token: 'token2', persist: vi.fn(), remove: vi.fn(), restore: () => [stored], send: output => sent.push(output), context: value => carrier.replayEnvelope(value), error: error => { throw error; } });
    handoff.start(); handoff.stop();
    expect(sent[0].sessionOutputOrigin.scope.execution).toEqual(execution); expect(sent[0].sessionContract.producer).toEqual(carrier.worker);
    expect(s.controller.gateway.admit('final_output', sent[0].sessionContract, carrier.worker, s.controller.outputOrigin(sent[0].sessionOutputOrigin)).kind).toBe('historical');
  });
  it('rebuilds a versioned result from persistent facts and retains the earlier snapshot', () => {
    const s = fixture(); const execution = s.controller.admitInput('turnA'); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.store.apply(s.ref, { type: 'execution_terminal', execution, runtime: s.runtime, status: 'reconciling', evidence: 'observer_loss' });
    s.store.apply(s.ref, { type: 'execution_output', execution, output: { availability: 'available', content: 'partial', completeness: 'partial' } });
    const ref = { botId: s.appId, sessionId: s.ref.sessionId, turnId: 'turnA' };
    const first = new PersistentTurnResultStore(s.data).readContract(ref)!;
    const reopened = new SessionContractStore(s.data, s.appId); handles.push(reopened);
    reopened.apply(s.ref, { type: 'execution_terminal', execution, runtime: s.runtime, status: 'failed', evidence: 'native_terminal', errorCode: 'provider_failed' });
    const next = new PersistentTurnResultStore(s.data).readContract(ref)!;
    expect(next.execution).toMatchObject({ phase: 'failed', output: { content: 'partial', completeness: 'partial' } });
    expect(next.resultRevision).toBeGreaterThan(first.resultRevision); expect(first.execution.phase).toBe('reconciling');
    expect(new PersistentTurnResultStore(s.data).read(ref)).toMatchObject({ status: 'ready', result: { execution: { status: 'failed' }, output: { status: 'available', content: 'partial' } } });
  });
  it('advances result revision when the delivery journal changes without changing execution truth', () => {
    const s = fixture(); const execution = s.controller.admitInput('turnA'); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.store.apply(s.ref, { type: 'execution_terminal', execution, runtime: s.runtime, status: 'succeeded', evidence: 'native_terminal' });
    const journal = new OutputDeliveryJournal(s.data, s.appId); handles.push(journal);
    const output = { type: 'final_output' as const, sessionId: s.ref.sessionId, turnId: 'turnA', content: 'answer', lastUuid: 'final1', sessionContract: s.context(1, { runtime: s.runtime, execution }) };
    const snapshot = outputSnapshot(s.appId, output); const record = journal.accept(snapshot, { kind: 'managed' });
    const reader = new PersistentTurnResultStore(s.data); const ref = { botId: s.appId, sessionId: s.ref.sessionId, turnId: 'turnA' };
    const first = reader.readContract(ref)!; expect(journal.claim(record.id, 'owner')).toBe(true);
    const next = reader.readContract(ref)!;
    expect(first.outputs[0].state).toBe('pending'); expect(next.outputs[0].state).toBe('processing');
    expect(next.execution.phase).toBe('succeeded'); expect(next.resultRevision).toBeGreaterThan(first.resultRevision);
  });
  it.each(['restart', 'interrupt_turn', 'suspend', 'close_commit', 'raw_input', 'term_action', 'inject_command', 'session_ready', 'turn_idle'])('requires a frozen RuntimeRef for %s', type => {
    const s = fixture(); expect(admitSessionCommand(type, { version: 2, operationId: 'op' }, s.runtime, 'op').allowed).toBe(false);
  });
  it('keeps contract enforcement active even with a legacy environment switch', () => {
    vi.stubEnv('BOTMUX_SESSION_CONTRACT_V2', '0'); const s = fixture();
    const controller = controllerForSession(s.ds, true)!;
    expect(controller).toBeDefined(); expect(controller.ingest({ type: 'ready' }, s.worker).kind).toBe('reject');
  });
});
