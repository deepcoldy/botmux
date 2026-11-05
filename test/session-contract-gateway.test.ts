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
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';
import type { DaemonSession } from '../src/core/types.js';
import { sameWorker } from '../src/services/session-contract.js';

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
      logger: { debug: vi.fn() }, t: 'test', handleLegacyWorkerMessage: legacy };
    const handler = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', handlerScope);
    const revision = s.store.read(s.ref)?.revision;
    for (const type of ['managed_turn_origin', 'managed_turn_origin_revoked']) {
      const wire = scope.run(binding, () => metadata({ type, sessionId: s.ref.sessionId, turnId: 'never-admitted', capability: 'unknown-capability' }));
      expect(wire.sessionContract.scope.execution).toBeUndefined();
      await handler(wire);
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
      logger: { debug: vi.fn() }, t: 'test', botCfg: {}, sessionCliId: () => 'claude-code' };
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
  it('rejects a conflicting output sidecar before any output or attempt write', () => {
    const s = fixture(); const a = s.controller.admitInput('turnA'); const b = s.controller.admitInput('turnB');
    const before = s.store.execution(s.ref, a.executionId)!;
    const admission = s.controller.ingest({ type: 'final_output', turnId: 'turnA', content: 'body from B',
      sessionContract: s.context(1, { runtime: s.runtime, execution: a }),
      sessionOutputOrigin: s.context(2, { runtime: s.runtime, execution: b }) }, s.worker);
    expect(admission.kind).toBe('reject'); expect(s.store.execution(s.ref, a.executionId)).toEqual(before);
  });
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
