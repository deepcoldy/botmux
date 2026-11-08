import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { sameWorker, type WorkerRef } from '../src/services/session-contract.js';
import { RestartCoordinator } from '../src/core/restart-coordinator.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure, loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import type { DaemonSession } from '../src/core/types.js';

const fixtureConfig = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return fixtureConfig.dataDir; } } } }));

const directories: string[] = [];
const handles: Array<{ close(): void }> = [];
const identity = { backend: 'tmux', physicalId: '111:start1', nativeSessionId: 'native-1', proof: 'process_start' as const };
function fixture() {
  const data = mkdtempSync(join(tmpdir(), 'contract-recovery-')); directories.push(data);
  fixtureConfig.dataDir = data;
  const appId = 'cli_recovery_test'; const ref = { appId, sessionId: 'session-recovery' };
  const store = new SessionContractStore(data, appId); handles.push(store);
  const ds = { larkAppId: appId, chatId: 'oc_test', session: { sessionId: ref.sessionId, larkAppId: appId, status: 'active' }, cliReadyGeneration: 0 } as DaemonSession;
  const controller = new SessionController(ds, store); const worker = controller.bindWorker(1).worker;
  const runtime = controller.reserveBinding('binding-current', worker);
  controller.bindRuntime('binding-current', worker, identity);
  const context = (sequence: number, scope: any = { runtime }, producer: WorkerRef = worker) => ({ version: 2 as const, session: ref, producer, eventId: `${producer.workerId}:${sequence}`, sequence, scope });
  controller.ingest({ type: 'ready', sessionContract: context(1, {}) }, worker);
  controller.ingest({ type: 'prompt_ready', sessionContract: context(2) }, worker);
  return { data, appId, ref, store, ds, controller, worker, runtime, context };
}
function rows(store: SessionContractStore, sql: string): number {
  const db = openDatabaseSyncOrThrow(store.filename); handles.push(db);
  return Number((db.prepare(sql).get() as { count: number }).count);
}
function inputScope(controller: SessionController) {
  return {
    controllerForSession: () => controller,
    cancelDeploymentContinuation: vi.fn(), sessionStore: { updateDeploymentContinuation: vi.fn() },
    deploymentContinuationAuthority: () => undefined,
    getBot: () => ({ config: {} }), sessionCliId: () => 'claude-code', codexCapacityRecoveryCli: () => false,
    cancelOrdinaryRecoveryForUserInput: vi.fn(), cancelOrdinaryTurnRecoveryForStop: vi.fn(),
    withTurnCaller: (_ds: unknown, message: unknown) => message, bufferTransferInput: () => false,
    afterWorkerIpcBootstrap: (_worker: unknown, send: () => boolean) => send(),
  };
}
function restartHarness(s: ReturnType<typeof fixture>) {
  const worker = { killed: false, send: vi.fn((_message: any) => true) }; s.ds.worker = worker as any;
  const scope: any = { RestartCoordinator, findActiveBySessionId: () => s.ds, controllerForSession: () => s.controller,
    isSessionTransferring: () => false, sessionContractPrimary: () => false, isSessionRestartInFlight: () => false,
    topicEffortRestartReadiness: new Map(), restartIpcReason: () => ({}), restartSessionEnvFields: () => ({}),
    latestModelForRespawn: () => undefined, latestTraexAutoModelForRespawn: () => undefined,
    latestCodexRpcInputForRespawn: () => undefined, latestLarkToolBindingForRespawn: () => undefined,
    latestPinEffortForRespawn: () => ({}), latestLaunchCommandsForRespawn: () => ({}),
    destroyLivePaneBeforeRestart: vi.fn(), forkWorker: vi.fn(), logger: { warn: vi.fn(), info: vi.fn() }, tag: () => 'test' };
  scope.restartCoordinator = loadWorkerPoolClosure('restartCoordinator', scope);
  const restart = loadWorkerPoolFunction<(ds: DaemonSession, observer: any) => { attemptId: string; joined: boolean }>('requestSessionRestart', scope);
  const restartIpc = () => worker.send.mock.calls.map(([message]) => message).filter(message => message?.type === 'restart').map(message => message.attemptId);
  return { worker, coordinator: scope.restartCoordinator as RestartCoordinator, restart, restartIpc };
}
/** Real worker spawnCli/receipt handlers wired to the real host handler. */
function workerHostPair(s: ReturnType<typeof fixture>, spawnCliBody: () => Promise<void> = vi.fn(async () => {})) {
  const workerScope = new WorkerSessionEventScope(s.ref, s.worker);
  const previous = workerScope.beginRuntime(); workerScope.assign(previous.bindingId, s.runtime);
  workerScope.envelope(); workerScope.envelope(); // the fixture's ready/prompt_ready used sequences 1 and 2
  const pending: Promise<void>[] = [];
  const env: any = { workerSessionEventScope: workerScope, pendingRuntimeReservations: new Map(),
    activeRestartAttemptId: undefined, closeRequested: false, initialInputOwnershipPending: false,
    spawnCliBody, publishRuntimeContract: vi.fn(), CliSpawnSupersededError: class extends Error {} };
  const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', env);
  const receive = loadWorkerFunction<(message: any) => Promise<void>>('handleContractDaemonMessage', env);
  const worker = { send: vi.fn((message: any) => { void receive(message); return true; }) }; s.ds.worker = worker as any;
  const legacy = vi.fn();
  const hostScope: any = { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
    logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: legacy };
  const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostScope); hostScope.handleWorkerMessage = host;
  env.send = (message: any) => { pending.push(host(metadata(message))); };
  const drain = async () => { for (let settled = 0; settled < pending.length;) { const batch = pending.slice(settled); settled = pending.length; await Promise.all(batch); } };
  const spawn = loadWorkerFunction<(cfg: any) => Promise<void>>('spawnCli', env);
  return { workerScope, previous, worker, legacy, host, metadata, drain, spawn, env };
}
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const handle of handles.splice(0)) try { handle.close(); } catch { /* already closed */ }
  for (const data of directories.splice(0)) rmSync(data, { recursive: true, force: true });
});

describe('user input during control operations', () => {
  const cases: Array<[string, (s: ReturnType<typeof fixture>) => void]> = [
    ['a restart is applying', s => { const { operation } = s.controller.beginControl('restart'); s.controller.controlStarted(operation.operationId); }],
    ['a restart outcome is uncertain', s => {
      const { operation } = s.controller.beginControl('restart'); s.controller.controlStarted(operation.operationId);
      s.controller.controlResult(operation.operationId, 'uncertain');
    }],
    ['a suspended session is resuming', s => {
      const { operation } = s.controller.beginControl('suspend'); s.controller.controlStarted(operation.operationId);
      s.controller.controlResult(operation.operationId, 'confirmed'); s.controller.prepareResume(); s.controller.bindWorker(2);
    }],
    ['a suspend could not be verified', s => {
      const { operation } = s.controller.beginControl('suspend'); s.controller.controlStarted(operation.operationId);
      s.controller.controlResult(operation.operationId, 'uncertain', undefined, 'suspend_backing_not_proven');
    }],
    ['a cancel is in flight', s => {
      const execution = s.controller.admitInput('turn-running');
      const { operation } = s.controller.beginControl('cancel', undefined, execution); s.controller.controlStarted(operation.operationId);
    }],
  ];
  it.each(cases)('forwards the message and Stop to the live worker while %s', (_name, setup) => {
    const s = fixture(); setup(s);
    const worker = { killed: false, send: vi.fn((_message: any) => true) }; s.ds.worker = worker as any;
    const send = loadWorkerPoolFunction<(ds: DaemonSession, message: any) => boolean>('sendWorkerSessionInput', inputScope(s.controller));
    expect(send(s.ds, { type: 'message', content: 'follow-up', turnId: 'om_follow_up' })).toBe(true);
    expect(send(s.ds, { type: 'term_action', key: 'ctrlc' })).toBe(true);
    expect(worker.send.mock.calls.map(([message]) => message.type)).toEqual(['message', 'term_action']);
    expect(s.store.executions(s.ref, 'om_follow_up')).toHaveLength(1);
  });
  it('still refuses input to a session that is closing', () => {
    const s = fixture(); s.controller.beginControl('close');
    const worker = { killed: false, send: vi.fn() }; s.ds.worker = worker as any;
    const send = loadWorkerPoolFunction<(ds: DaemonSession, message: any) => boolean>('sendWorkerSessionInput', inputScope(s.controller));
    expect(send(s.ds, { type: 'message', content: 'late', turnId: 'om_late' })).toBe(false);
    expect(worker.send).not.toHaveBeenCalled();
  });
});

describe('restart outcomes', () => {
  it('settles a worker-reported restart failure so the next restart sends a new attempt', async () => {
    const s = fixture(); const h = restartHarness(s);
    try {
      const notify = vi.fn();
      const first = h.restart(s.ds, { source: 'slash', notify });
      s.controller.ingest({ type: 'restart_result', attemptId: first.attemptId, status: 'failed', category: 'spawn_failed', sessionContract: s.context(3, { operationId: first.attemptId }) }, s.worker);
      h.coordinator.resolve(s.ds.session.sessionId, first.attemptId, 'failed');
      await vi.waitFor(() => expect(notify.mock.calls.map(([status]) => status)).toEqual(['in_progress', 'failed']));
      expect(s.controller.operation(first.attemptId)).toMatchObject({ phase: 'rejected', error: 'spawn_failed' });
      expect(s.store.read(s.ref)!.lifecycle).toBe('active');
      expect(s.store.read(s.ref)!.activeOperationId).toBeUndefined();
      const retry = h.restart(s.ds, { source: 'slash', notify: vi.fn() });
      expect(retry.joined).toBe(false);
      expect(h.restartIpc()).toEqual([first.attemptId, retry.attemptId]);
    } finally { h.coordinator.reset(); }
  });
  it('settles a failure the coordinator learns before any contract receipt', () => {
    const s = fixture(); const h = restartHarness(s);
    try {
      const first = h.restart(s.ds, { source: 'slash', notify: vi.fn() });
      h.coordinator.resolve(s.ds.session.sessionId, first.attemptId, 'failed');
      expect(s.controller.operation(first.attemptId)?.phase).toBe('rejected');
      expect(s.store.read(s.ref)!.activeOperationId).toBeUndefined();
      const retry = h.restart(s.ds, { source: 'slash', notify: vi.fn() });
      expect(retry.joined).toBe(false);
      expect(h.restartIpc()).toEqual([first.attemptId, retry.attemptId]);
    } finally { h.coordinator.reset(); }
  });
  it('settles a worker-reported failure from the receipt alone when no attempt is held in memory', () => {
    const s = fixture(); const { operation } = s.controller.beginControl('restart'); s.controller.controlStarted(operation.operationId);
    s.controller.ingest({ type: 'restart_result', attemptId: operation.operationId, status: 'failed', category: 'runner_exited', sessionContract: s.context(3, { operationId: operation.operationId }) }, s.worker);
    expect(s.controller.operation(operation.operationId)?.phase).toBe('rejected');
    expect(s.controller.beginControl('restart').joined).toBe(false);
  });
  it('keeps a timed-out restart joinable and settles it from the late receipt', async () => {
    vi.useFakeTimers(); const s = fixture(); const h = restartHarness(s);
    try {
      const first = h.restart(s.ds, { source: 'cli_crash', notify: vi.fn() });
      await vi.advanceTimersByTimeAsync(40_001);
      expect(s.controller.operation()).toMatchObject({ operationId: first.attemptId, phase: 'uncertain' });
      const joinedNotify = vi.fn();
      expect(h.restart(s.ds, { source: 'slash', notify: joinedNotify })).toEqual({ attemptId: first.attemptId, joined: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.restartIpc()).toEqual([first.attemptId]);
      expect(s.controller.operation()).toMatchObject({ operationId: first.attemptId, phase: 'uncertain' });
      const replacement = s.controller.reserveBinding('replacement', s.worker);
      s.controller.bindRuntime('replacement', s.worker, { ...identity, physicalId: '222:start2' }, first.attemptId);
      s.controller.ingest({ type: 'restart_result', attemptId: first.attemptId, status: 'succeeded', category: 'prompt_ready',
        sessionContract: { ...s.context(3, { operationId: first.attemptId }), bindingId: 'replacement' } }, s.worker);
      h.coordinator.resolve(s.ds.session.sessionId, first.attemptId, 'succeeded');
      await vi.advanceTimersByTimeAsync(0);
      expect(joinedNotify.mock.calls.map(([status]) => status)).toEqual(['timed_out', 'succeeded']);
      expect(s.controller.operation(first.attemptId)?.phase).toBe('confirmed');
      expect(s.store.read(s.ref)).toMatchObject({ activeRuntime: replacement, lifecycle: 'active' });
      expect(s.store.read(s.ref)!.activeOperationId).toBeUndefined();
      const next = h.restart(s.ds, { source: 'slash', notify: vi.fn() });
      expect(next.joined).toBe(false);
      expect(h.restartIpc()).toEqual([first.attemptId, next.attemptId]);
    } finally { h.coordinator.reset(); }
  });
  it.each(['suspend', 'cancel'] as const)('lets a new worker start over an unverified %s instead of refusing its first runtime', async kind => {
    const s = fixture(); const execution = kind === 'cancel' ? s.controller.admitInput('turn-cancelled') : undefined;
    const old = s.controller.beginControl(kind, undefined, execution).operation; s.controller.controlStarted(old.operationId);
    s.controller.controlResult(old.operationId, 'uncertain');
    const attempt = s.controller.prepareWorkerStart();
    expect(s.controller.operation()).toMatchObject({ operationId: attempt, kind: 'restart' });
    const next = s.controller.bindWorker(2).worker;
    const workerScope = new WorkerSessionEventScope(s.ref, next); const binding = workerScope.beginRuntime(attempt);
    const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: workerScope });
    const worker = { send: vi.fn() }; s.ds.worker = worker as any;
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', { sessionController: s.controller, contractWorker: next, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: vi.fn() });
    await host(workerScope.run(binding, () => metadata({ type: 'runtime_binding_started', bindingId: binding.bindingId, operationId: attempt })));
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'runtime_contract_reserved', bindingId: binding.bindingId, mayStart: true }));
    expect(s.controller.operation(old.operationId)).toMatchObject({ phase: 'uncertain', error: 'superseded_by_restart' });
  });
});

describe('replacement reservations are always settled', () => {
  it('releases a permitted reservation whose spawn fails, so the surviving runtime crash stays current', async () => {
    const s = fixture(); const p = workerHostPair(s, vi.fn(async () => { throw new Error('cli_missing'); }));
    const started = p.spawn({ prompt: '' }); const replacement = p.workerScope.currentBinding()!;
    await expect(started).rejects.toThrow('cli_missing'); await p.drain();
    expect(p.env.spawnCliBody).toHaveBeenCalledOnce();
    expect(s.store.binding(s.ref, replacement.bindingId)?.phase).toBe('stopped');
    expect(s.store.hasPendingRuntimeReplacement(s.ref, s.runtime)).toBe(false);
    expect(p.workerScope.currentBinding()).toBe(p.previous);
    await p.host(p.workerScope.run(p.previous, () => p.metadata({ type: 'claude_exit', code: 1 })));
    expect(p.legacy).toHaveBeenCalledWith(expect.objectContaining({ type: 'claude_exit' }));
  });
  it('releases a binding the host refuses and returns the worker to the surviving runtime', async () => {
    const s = fixture(); const p = workerHostPair(s);
    const execution = s.controller.admitInput('turn-running'); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    s.controller.beginControl('cancel', undefined, execution);
    const replacement = p.workerScope.beginRuntime();
    await p.host(p.workerScope.run(replacement, () => p.metadata({ type: 'runtime_binding_started', bindingId: replacement.bindingId })));
    await p.host(p.workerScope.run(replacement, () => p.metadata({ type: 'runtime_binding', bindingId: replacement.bindingId, identity: { ...identity, nativeSessionId: 'native-2' } })));
    await p.drain();
    expect(s.store.binding(s.ref, replacement.bindingId)).toMatchObject({ phase: 'stopped', reason: 'runtime_binding_refused' });
    expect(p.worker.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'runtime_binding_refused', bindingId: replacement.bindingId }));
    expect(p.workerScope.currentBinding()).toBe(p.previous);
    expect(s.store.hasPendingRuntimeReplacement(s.ref, s.runtime)).toBe(false);
    await p.host(p.workerScope.run(p.previous, () => p.metadata({ type: 'claude_exit', code: 1 })));
    expect(p.legacy).toHaveBeenCalledWith(expect.objectContaining({ type: 'claude_exit' }));
  });
  it('drops events of an abandoned reservation instead of deferring them forever', () => {
    const s = fixture(); s.controller.reserveBinding('abandoned', s.worker);
    const event = (sequence: number) => ({ type: 'screen_update', status: 'working', content: '', sessionContract: { ...s.context(sequence, {}), bindingId: 'abandoned' } });
    expect(s.controller.ingest(event(3), s.worker).kind).toBe('defer');
    expect(s.store.deferredEvents(s.ref, 'abandoned')).toHaveLength(1);
    s.controller.abandonBinding('abandoned', s.worker, 'abort-abandoned');
    expect(s.store.deferredEvents(s.ref, 'abandoned')).toEqual([]);
    expect(s.controller.ingest(event(4), s.worker)).toMatchObject({ kind: 'reject', reason: 'runtime_reservation_abandoned' });
    expect(s.store.deferredEvents(s.ref, 'abandoned')).toEqual([]);
  });
  it('still accepts why a start failed, before and after its reservation is released', async () => {
    const s = fixture(); const { operation } = s.controller.beginControl('restart'); s.controller.controlStarted(operation.operationId);
    s.controller.reserveBinding('failed-start', s.worker);
    const scoped = (sequence: number, scope: any = {}) => ({ ...s.context(sequence, scope), bindingId: 'failed-start' });
    const legacy = vi.fn(); const worker = { send: vi.fn() }; s.ds.worker = worker as any;
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', { sessionController: s.controller, contractWorker: s.worker, ds: s.ds, worker, sameWorker,
      logger: { warn: vi.fn(), debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: legacy });
    await host({ type: 'error', message: 'cli_missing', sessionContract: scoped(3) });
    expect(legacy).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'cli_missing' }));
    s.controller.abandonBinding('failed-start', s.worker, 'abort-failed-start');
    await host({ type: 'error', message: 'cli_missing_again', sessionContract: scoped(4) });
    expect(legacy).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'cli_missing_again' }));
    await host({ type: 'restart_result', attemptId: operation.operationId, status: 'failed', category: 'spawn_failed', sessionContract: scoped(5, { operationId: operation.operationId }) });
    expect(s.controller.operation(operation.operationId)).toMatchObject({ phase: 'rejected', error: 'spawn_failed' });
    expect(s.store.read(s.ref)!.activeOperationId).toBeUndefined();
    expect(s.controller.ingest({ type: 'restart_result', attemptId: operation.operationId, status: 'succeeded', category: 'prompt_ready', sessionContract: scoped(6, { operationId: operation.operationId }) }, s.worker))
      .toMatchObject({ kind: 'reject', reason: 'runtime_reservation_abandoned' });
  });
});

describe('hook signals from a CLI launched without a binding ID', () => {
  it('adopts the sole settled current runtime when the native session agrees', () => {
    const s = fixture();
    expect(s.controller.nativeSignal(undefined, 'native-1')).toEqual({ version: 2, runtime: s.runtime });
    expect(s.controller.nativeSignal(undefined, undefined)).toEqual({ version: 2, runtime: s.runtime });
    expect(s.controller.nativeSignal(undefined, 'native-other')).toBeUndefined();
  });
  it('attributes a turn-idle signal only to an attempt on the current runtime', () => {
    const s = fixture(); const execution = s.controller.admitInput('turn-live'); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
    expect(s.controller.nativeSignal(undefined, undefined, 'turn-live')).toEqual({ version: 2, runtime: s.runtime, execution });
    s.controller.reserveBinding('binding-next', s.worker);
    s.controller.bindRuntime('binding-next', s.worker, { ...identity, physicalId: '222:start2', nativeSessionId: 'native-2' });
    expect(s.controller.nativeSignal(undefined, undefined, 'turn-live')).toBeUndefined();
  });
  it('refuses to guess while a replacement or control operation is pending', () => {
    const s = fixture(); s.controller.reserveBinding('pending', s.worker);
    expect(s.controller.nativeSignal(undefined, 'native-1')).toBeUndefined();
    s.controller.abandonBinding('pending', s.worker, 'abort-pending');
    expect(s.controller.nativeSignal(undefined, 'native-1')).toBeDefined();
    const { operation } = s.controller.beginControl('restart'); s.controller.controlStarted(operation.operationId);
    expect(s.controller.nativeSignal(undefined, 'native-1')).toBeUndefined();
  });
});

describe('contract history stays bounded', () => {
  it('records one busy edge per turn rather than every working screen sample', () => {
    const s = fixture(); const count = () => rows(s.store, 'SELECT COUNT(*) AS count FROM events');
    const before = count(); const revision = s.store.read(s.ref)!.revision;
    for (let sequence = 3; sequence < 33; sequence++) {
      s.controller.ingest({ type: 'screen_update', status: 'working', content: `frame ${sequence}`, sessionContract: s.context(sequence) }, s.worker);
    }
    expect(count() - before).toBe(1);
    expect(s.store.read(s.ref)!.revision).toBe(revision + 1);
  });
  it('prunes settled history while keeping recent results and recovery records', () => {
    const s = fixture(); const output = 'x'.repeat(4096);
    s.controller.admitInput('turn-unsettled');
    for (let batch = 0; batch < 10; batch++) s.store.atomic(() => {
      for (let turn = batch * 50; turn < batch * 50 + 50; turn++) {
        const execution = s.controller.admitInput(`turn-${turn}`); s.store.bindQueuedExecution(s.ref, execution, s.runtime);
        s.store.apply(s.ref, { type: 'runtime_busy', runtime: s.runtime });
        s.store.apply(s.ref, { type: 'execution_terminal', runtime: s.runtime, execution, status: 'succeeded', evidence: 'native_terminal' });
        s.store.apply(s.ref, { type: 'execution_output', execution, output: { availability: 'available', content: output, completeness: 'final' } });
        s.store.apply(s.ref, { type: 'runtime_ready', runtime: s.runtime });
      }
    });
    expect(rows(s.store, "SELECT COUNT(*) AS count FROM events WHERE type NOT IN ('runtime_bound','runtime_reserved')")).toBeLessThanOrEqual(1024 + 128);
    expect(rows(s.store, "SELECT COUNT(*) AS count FROM events WHERE type IN ('runtime_bound','runtime_reserved')")).toBe(2);
    expect(rows(s.store, 'SELECT COUNT(*) AS count FROM events WHERE length(value) > 512')).toBe(0);
    expect(rows(s.store, "SELECT COUNT(*) AS count FROM entities WHERE kind='execution'")).toBeLessThanOrEqual(256 + 128);
    expect(rows(s.store, "SELECT COUNT(*) AS count FROM entities WHERE kind='result_binding'")).toBeLessThanOrEqual(256 + 128);
    expect(s.store.executions(s.ref, 'turn-499')[0]).toMatchObject({ phase: 'succeeded', output: { content: output } });
    expect(s.store.resultBinding(s.ref, 'turn-499')).toBeDefined();
    expect(s.store.resultBinding(s.ref, 'turn-unsettled')).toBeDefined();
    expect(s.store.resultBinding(s.ref, 'turn-0')).toBeUndefined();
    expect(s.store.executions(s.ref, 'turn-0')).toEqual([]);
  });
  it('looks up one turn without deserializing unrelated attempts', () => {
    const s = fixture();
    s.store.atomic(() => { for (let turn = 0; turn < 64; turn++) s.controller.admitInput(`turn-${turn}`); });
    const parse = vi.spyOn(JSON, 'parse');
    expect(s.store.executions(s.ref, 'turn-32')).toHaveLength(1);
    expect(parse.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it('still refuses a different event under a recorded id after storing only its digest', () => {
    const s = fixture();
    expect(s.store.apply(s.ref, { type: 'worker_lost', worker: s.worker }, 'event-once').decision).toBe('applied');
    expect(s.store.apply(s.ref, { type: 'worker_lost', worker: s.worker }, 'event-once').decision).toBe('duplicate');
    expect(() => s.store.apply(s.ref, { type: 'worker_online', worker: s.worker }, 'event-once')).toThrow('contract_event_conflict');
  });
});
