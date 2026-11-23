import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionContractStore, SessionContractConflict, sessionContractStore } from '../src/services/session-contract-store.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { contractReadiness, reduceSessionContract, type ContractTransitionInput, type RuntimeIdentity } from '../src/services/session-contract.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
const ref = { appId: 'cli_contract_test', sessionId: 'session_test' };
const worker = { workerId: 'worker_one', generation: 1 };
const identity = { backend: 'tmux', physicalId: 'pid:123:start:100', proof: 'process_start' as const, nativeSessionId: 'native_one' };
const directories: string[] = []; const stores: SessionContractStore[] = [];
function open(directory = mkdtempSync(join(tmpdir(), 'session-contract-'))) { if (!directories.includes(directory)) directories.push(directory); const store = new SessionContractStore(directory, ref.appId); stores.push(store); store.ensure(ref); return store; }
function bind(store: SessionContractStore, owner = worker, physical = identity) { store.bindWorker(ref, owner); const runtime = store.reserveRuntime(ref, owner); return store.bindRuntime(ref, runtime, owner, physical); }
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) try { store.close(); } catch {} for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('session identity and state contract', () => {
  function settledRestart() {
    const store = open(); store.bindWorker(ref, worker); store.apply(ref, { type: 'worker_online', worker });
    const operation = store.beginOperation(ref, 'restart').operation;
    const reserved = store.reserveRuntime(ref, worker, 'native-binding');
    const { nativeSessionId, ...physical } = identity;
    const runtime = store.bindRuntime(ref, reserved, worker, physical, operation.operationId);
    store.apply(ref, { type: 'runtime_ready', runtime: runtime.ref });
    store.apply(ref, { type: 'control_result', operationId: operation.operationId, phase: 'confirmed', runtime: runtime.ref });
    return { store, operation, reserved, runtime, nativeSessionId, physical };
  }
  it.each(['restart', 'resume'] as const)('enriches the current native identity after %s has already completed', kind => {
    const store = open(); store.bindWorker(ref, worker);
    const operation = store.beginOperation(ref, kind).operation;
    const reserved = store.reserveRuntime(ref, worker);
    const { nativeSessionId, ...physical } = identity;
    const runtime = store.bindRuntime(ref, reserved, worker, physical, operation.operationId);
    store.apply(ref, { type: 'runtime_ready', runtime: runtime.ref });
    store.apply(ref, { type: 'control_result', operationId: operation.operationId, phase: 'confirmed', runtime: runtime.ref });
    expect(store.read(ref)?.activeOperationId).toBeUndefined();
    const enriched = store.bindRuntime(ref, reserved, worker, { ...physical, nativeSessionId }, operation.operationId);
    expect(enriched.phase).toBe('ready');
    expect(enriched.promptReady).toBe(true);
    expect(enriched.identity?.nativeSessionId).toBe(nativeSessionId);
    expect(store.read(ref)?.activeRuntime).toEqual(runtime.ref);
    expect(() => store.bindRuntime(ref, reserved, worker, { ...identity, physicalId: 'another-process' }, operation.operationId)).toThrow('runtime_identity_changed');
  });
  it('keeps a completed-operation replacement and a closing runtime fenced', () => {
    const store = open(); store.bindWorker(ref, worker);
    const operation = store.beginOperation(ref, 'restart').operation;
    const { nativeSessionId, ...physical } = identity;
    const reserved = store.reserveRuntime(ref, worker);
    const runtime = store.bindRuntime(ref, reserved, worker, physical, operation.operationId);
    store.apply(ref, { type: 'control_result', operationId: operation.operationId, phase: 'confirmed', runtime: runtime.ref });
    const stale = store.reserveRuntime(ref, worker);
    expect(store.bindRuntime(ref, stale, worker, { ...identity, physicalId: 'new-process' }, operation.operationId).phase).toBe('retiring');
    store.beginOperation(ref, 'close');
    store.bindRuntime(ref, reserved, worker, { ...physical, nativeSessionId }, operation.operationId);
    expect(store.read(ref)?.lifecycle).toBe('closing');
    expect(contractReadiness(store.read(ref)!, store.runtime(ref)).cliReady).toBe(false);
  });
  it.each(['suspend', 'cancel', 'close'] as const)('keeps the current executor usable when %s rejects after late identity enrichment', kind => {
    vi.useFakeTimers();
    const { store, operation, reserved, runtime } = settledRestart();
    const execution = store.admitExecution(ref, 'running-turn');
    const control = store.beginOperation(ref, kind, { execution: kind === 'cancel' ? execution.ref : undefined }).operation;
    setTimeout(() => store.bindRuntime(ref, reserved, worker, identity, operation.operationId), 100);
    setTimeout(() => store.apply(ref, { type: 'control_result', operationId: control.operationId, phase: 'rejected' }), 200);
    vi.advanceTimersByTime(100);
    expect(store.runtime(ref)?.phase).toBe('ready');
    expect(store.read(ref)?.activeOperationId).toBe(control.operationId);
    expect(contractReadiness(store.read(ref)!, store.runtime(ref)).cliReady).toBe(false);
    vi.advanceTimersByTime(100);
    expect(store.read(ref)?.lifecycle).toBe('active');
    expect(store.read(ref)?.activeOperationId).toBeUndefined();
    expect(store.apply(ref, { type: 'runtime_ready', runtime: runtime.ref }).decision).toBe('applied');
    expect(contractReadiness(store.read(ref)!, store.runtime(ref)).cliReady).toBe(true);
  });
  it.each(['confirmed', 'uncertain'] as const)('retains a %s suspend fence when the old identity callback arrives', phase => {
    const { store, operation, reserved } = settledRestart();
    const control = store.beginOperation(ref, 'suspend').operation;
    store.apply(ref, { type: 'control_result', operationId: control.operationId, phase });
    store.bindRuntime(ref, reserved, worker, identity, operation.operationId);
    expect(store.read(ref)?.lifecycle).toBe(phase === 'confirmed' ? 'suspended' : 'suspending');
    expect(store.read(ref)?.activeOperationId).toBe(phase === 'confirmed' ? undefined : control.operationId);
    expect(contractReadiness(store.read(ref)!, store.runtime(ref)).cliReady).toBe(false);
  });
  it('rolls back identity publication atomically and retries after reopening', () => {
    const { store, operation, reserved } = settledRestart();
    const before = store.snapshot(ref); const writer = openDatabaseSyncOrThrow(store.filename);
    writer.exec("CREATE TRIGGER reject_binding_update BEFORE UPDATE ON runtime_bindings BEGIN SELECT RAISE(ABORT,'binding publication failed'); END");
    expect(() => store.bindRuntime(ref, reserved, worker, identity, operation.operationId)).toThrow('binding publication failed');
    expect(store.snapshot(ref)).toEqual(before);
    writer.exec('DROP TRIGGER reject_binding_update'); writer.close(); store.close();
    const reopened = open(directories[0]);
    expect(reopened.snapshot(ref)).toEqual(before);
    expect(reopened.bindRuntime(ref, reserved, worker, identity, operation.operationId)).toMatchObject({ phase: 'ready', identity });
  });
  it('keeps readiness ticks and a later replacement independent of identity enrichment', () => {
    vi.useFakeTimers(); const { store, operation, reserved, runtime } = settledRestart(); let tick = 0;
    const timer = setInterval(() => store.apply(ref, { type: ++tick % 2 ? 'runtime_busy' : 'runtime_ready', runtime: runtime.ref }), 100);
    setTimeout(() => store.bindRuntime(ref, reserved, worker, identity, operation.operationId), 450);
    vi.advanceTimersByTime(450); clearInterval(timer);
    expect(store.runtime(ref)).toMatchObject({ phase: 'ready', promptReady: true, promptReadySequence: 3, identity });
    const replacement = store.beginOperation(ref, 'restart').operation;
    const next = store.reserveRuntime(ref, worker);
    store.bindRuntime(ref, next, worker, { ...identity, physicalId: 'new-process' }, replacement.operationId);
    store.apply(ref, { type: 'control_result', operationId: replacement.operationId, phase: 'confirmed', runtime: next });
    store.bindRuntime(ref, reserved, worker, { ...identity, nativeGeneration: 'next' }, operation.operationId);
    expect(store.read(ref)?.activeRuntime).toEqual(next);
    expect(store.runtime(ref, reserved.runtimeId)?.phase).toBe('retiring');
  });
  it.each([
    'not_selected', 'other_runtime', 'other_worker', 'retiring', 'stopped', 'unresolved',
    'suspended', 'resuming', 'closed', 'opaque', 'other_physical', 'native_session_changed', 'native_generation_changed',
  ] as const)('does not accept late identity enrichment across the %s reducer fence', fence => {
    const { store, operation } = settledRestart();
    const input: ContractTransitionInput = { session: store.read(ref)!, runtime: store.runtime(ref)! };
    // Call the reducer directly: store.bindRuntime's validation must not mask
    // a missing guard in the state machine itself.
    if (fence === 'not_selected') input.session.activeRuntime = { runtimeId: 'selected_elsewhere', epoch: 9 };
    if (fence === 'other_runtime') {
      input.runtime!.ref = { runtimeId: 'previous_runtime', epoch: 8 };
      input.session.activeRuntime = input.runtime!.ref;
    }
    if (fence === 'other_worker') input.runtime!.worker = { workerId: 'old_worker', generation: 0 };
    if (fence === 'retiring' || fence === 'stopped' || fence === 'unresolved') input.runtime!.phase = fence;
    if (fence === 'suspended' || fence === 'resuming' || fence === 'closed') input.session.lifecycle = fence;
    if (fence === 'opaque') input.runtime!.identity!.proof = 'opaque';
    if (fence === 'native_session_changed') input.runtime!.identity!.nativeSessionId = 'already_known';
    if (fence === 'native_generation_changed') input.runtime!.identity!.nativeGeneration = 'already_known';
    const nextIdentity: RuntimeIdentity = { ...input.runtime!.identity!, nativeSessionId: identity.nativeSessionId, nativeGeneration: 'next' };
    if (fence === 'other_physical') nextIdentity.physicalId = 'different_process';
    const incoming = { ...store.runtime(ref)!, identity: nextIdentity, phase: 'ready' as const };
    const result = reduceSessionContract(input, { type: 'runtime_bound', runtime: incoming, operationId: operation.operationId });
    expect(result.decision).toBe('historical');
    expect(result.runtime?.phase).toBe('retiring');
    expect(result.session.activeRuntime).toEqual(input.session.activeRuntime);
    expect(result.session.lifecycle).toBe(input.session.lifecycle);
  });
  it('preserves explicit retirement when a binding repeats exactly the same identity', () => {
    const { store, runtime } = settledRestart();
    const input = { session: store.read(ref)!, runtime };
    const result = reduceSessionContract(input, { type: 'runtime_bound', runtime: { ...runtime, phase: 'retiring' } });
    expect(result.decision).toBe('applied');
    expect(result.runtime?.phase).toBe('retiring');
    expect(contractReadiness(result.session, result.runtime).cliReady).toBe(false);
  });
  it.each(['suspend', 'cancel'] as const)('retains an uncertain %s record while a reopened store starts one recovery restart', kind => {
    const store = open(); bind(store);
    const execution = store.admitExecution(ref, 'old-turn');
    const old = store.beginOperation(ref, kind, { execution: kind === 'cancel' ? execution.ref : undefined }).operation;
    store.apply(ref, { type: 'control_started', operationId: old.operationId });
    store.apply(ref, { type: 'control_result', operationId: old.operationId, phase: 'uncertain' });
    const data = directories[0]; store.close(); const restored = open(data);
    const next = restored.beginOperation(ref, 'restart', { operationId: 'recovery' });
    expect(next.joined).toBe(false); expect(restored.beginOperation(ref, 'restart').joined).toBe(true);
    expect(restored.operation(ref, old.operationId)).toMatchObject({ phase: 'uncertain', error: 'superseded_by_restart' });
    expect(restored.read(ref)?.lifecycle).toBe('active');
    restored.apply(ref, { type: 'control_result', operationId: old.operationId, phase: 'confirmed' });
    expect(restored.read(ref)?.activeOperationId).toBe('recovery');
  });
  it('carries allocated epoch floors when an older checkpoint replaces the database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-replacement-')); directories.push(dir);
    const original = sessionContractStore(dir, ref.appId); stores.push(original); original.ensure(ref);
    const first = bind(original); const checkpoint = original.snapshot(ref);
    expect(original.reserveRuntime(ref, worker).epoch).toBe(2);
    const backupDir = mkdtempSync(join(tmpdir(), 'contract-checkpoint-')); directories.push(backupDir);
    const backup = open(backupDir); backup.restore(checkpoint);
    const backupWriter = openDatabaseSyncOrThrow(backup.filename);
    backupWriter.exec('PRAGMA wal_checkpoint(TRUNCATE)'); backupWriter.close(); backup.close();
    const writer = openDatabaseSyncOrThrow(original.filename);
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)'); writer.close();
    copyFileSync(backup.filename, original.filename + '.replacement');
    renameSync(original.filename + '.replacement', original.filename);
    const current = sessionContractStore(dir, ref.appId); stores.push(current);
    expect(current.read(ref)?.runtimeEpoch).toBe(2);
    expect(current.runtime(ref)?.ref).toEqual(first.ref);
    expect(current.reserveRuntime(ref, worker).epoch).toBe(3);
    current.close();
    const reopened = sessionContractStore(dir, ref.appId); stores.push(reopened);
    expect(reopened.read(ref)?.runtimeEpoch).toBe(3);
    expect(reopened.reserveRuntime(ref, worker).epoch).toBe(4);
  });
  it('retains the predecessor high watermark when replacement persistence fails before cache publication', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-floor-retry-')); directories.push(dir);
    const original = sessionContractStore(dir, ref.appId); stores.push(original); original.ensure(ref);
    bind(original); const checkpoint = original.snapshot(ref); original.reserveRuntime(ref, worker);
    const backupDir = mkdtempSync(join(tmpdir(), 'contract-floor-backup-')); directories.push(backupDir);
    const backup = open(backupDir); backup.restore(checkpoint);
    const trigger = openDatabaseSyncOrThrow(backup.filename);
    trigger.exec("CREATE TRIGGER reject_floor BEFORE UPDATE ON contracts BEGIN SELECT RAISE(ABORT,'floor blocked'); END");
    trigger.exec('PRAGMA wal_checkpoint(TRUNCATE)'); trigger.close(); backup.close();
    const writer = openDatabaseSyncOrThrow(original.filename);
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)'); writer.close();
    copyFileSync(backup.filename, original.filename + '.replacement');
    renameSync(original.filename + '.replacement', original.filename);
    expect(() => sessionContractStore(dir, ref.appId)).toThrow('floor blocked');
    const retry = openDatabaseSyncOrThrow(original.filename); retry.exec('DROP TRIGGER reject_floor'); retry.close();
    const current = sessionContractStore(dir, ref.appId); stores.push(current);
    expect(current.read(ref)?.runtimeEpoch).toBe(2);
    expect(current.reserveRuntime(ref, worker).epoch).toBe(3);
  });
  it('reopens a cached store after close and fences an instance whose database was replaced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-cache-')); directories.push(dir);
    const first = sessionContractStore(dir, ref.appId); stores.push(first); first.ensure(ref);
    first.close();
    const reopened = sessionContractStore(dir, ref.appId); stores.push(reopened);
    expect(reopened).not.toBe(first); expect(reopened.read(ref)?.lifecycle).toBe('active');
    rmSync(dir, { recursive: true, force: true });
    expect(() => reopened.read(ref)).toThrow('session_contract_database_replaced');
    const replacement = sessionContractStore(dir, ref.appId); stores.push(replacement);
    expect(replacement).not.toBe(reopened); expect(replacement.read(ref)).toBeUndefined();
    expect(() => reopened.read(ref)).toThrow('session_contract_store_closed');
    replacement.ensure(ref); expect(replacement.read(ref)?.revision).toBe(0);
  });
  it('creates borrowed schema inside the owned transaction and retries after schema rollback', () => {
    const store = open(); const target = openDatabaseSyncOrThrow(join(directories[0], 'borrowed.db'));
    try {
      target.exec('CREATE TABLE sessions(session_id TEXT PRIMARY KEY,status TEXT,row TEXT)');
      target.prepare('INSERT INTO sessions VALUES(?,?,?)').run(ref.sessionId, 'active', JSON.stringify({ sessionId: ref.sessionId, status: 'active' }));
      const close = () => store.usingDatabase(target, () => {
        store.ensure(ref);
        const { operation } = store.beginOperation(ref, 'close');
        store.apply(ref, { type: 'control_started', operationId: operation.operationId });
        store.apply(ref, { type: 'control_result', operationId: operation.operationId, phase: 'confirmed' });
      });
      target.exec('BEGIN IMMEDIATE'); close(); target.exec('ROLLBACK');
      expect(target.prepare("SELECT count(*) AS total FROM sqlite_master WHERE name='contracts'").get()).toMatchObject({ total: 0 });
      expect(target.prepare('SELECT status FROM sessions').get()).toMatchObject({ status: 'active' });
      target.exec('BEGIN IMMEDIATE'); close(); target.exec('COMMIT');
      expect(target.prepare('SELECT status FROM sessions').get()).toMatchObject({ status: 'closed' });
      expect(store.read(ref)?.lifecycle).toBe('active');
    } finally { target.close(); }
  });
  it('ignores old ready while retaining the old runtime exit fact', () => {
    const store = open(); const old = bind(store); const candidate = store.reserveRuntime(ref, worker); const current = store.bindRuntime(ref, candidate, worker, { ...identity, physicalId: 'pid:456:start:200' });
    store.apply(ref, { type: 'runtime_ready', runtime: current.ref });
    const before = store.read(ref)!;
    expect(store.apply(ref, { type: 'runtime_ready', runtime: old.ref }).decision).toBe('stale');
    expect(store.read(ref)!.revision).toBe(before.revision);
    expect(store.apply(ref, { type: 'runtime_lost', runtime: old.ref, confirmed: true }).decision).toBe('historical');
    expect(store.runtime(ref)!.ref).toEqual(current.ref); expect(store.runtime(ref)!.promptReady).toBe(true);
  });
  it('reattaches the same process with a new worker and keeps readiness sequence monotonic', () => {
    const store = open(); const old = bind(store); store.apply(ref, { type: 'runtime_ready', runtime: old.ref }); store.apply(ref, { type: 'worker_online', worker });
    const nextWorker = { workerId: 'worker_two', generation: 2 }; store.bindWorker(ref, nextWorker);
    expect(contractReadiness(store.read(ref)!, store.runtime(ref)).cliReady).toBe(false);
    const candidate = store.reserveRuntime(ref, nextWorker); const same = store.bindRuntime(ref, candidate, nextWorker, identity);
    expect(same.ref).toEqual(old.ref); store.apply(ref, { type: 'worker_online', worker: nextWorker }); store.apply(ref, { type: 'runtime_ready', runtime: same.ref });
    expect(contractReadiness(store.read(ref)!, store.runtime(ref)).cliReadyGeneration).toBe(2);
  });
  it('does not turn observer loss into a terminal and retains failed-attempt output', () => {
    const store = open(); const runtime = bind(store); const execution = store.admitExecution(ref, 'om_turn'); store.bindQueuedExecution(ref, execution.ref, runtime.ref);
    store.apply(ref, { type: 'execution_terminal', runtime: runtime.ref, execution: execution.ref, status: 'reconciling', evidence: 'observer_loss' });
    store.apply(ref, { type: 'execution_output', execution: execution.ref, output: { availability: 'available', content: 'partial answer', completeness: 'partial' } });
    store.apply(ref, { type: 'execution_terminal', runtime: runtime.ref, execution: execution.ref, status: 'failed', evidence: 'native_terminal', errorCode: 'provider_failed' });
    expect(store.execution(ref, execution.ref.executionId)).toMatchObject({ phase: 'failed', output: { content: 'partial answer' } });
  });
  it('keeps uncertain restart and permits close to supersede without late revival', () => {
    const store = open(); const runtime = bind(store); const first = store.beginOperation(ref, 'restart'); store.apply(ref, { type: 'control_started', operationId: first.operation.operationId });
    store.apply(ref, { type: 'control_result', operationId: first.operation.operationId, phase: 'uncertain' });
    expect(store.beginOperation(ref, 'restart').joined).toBe(true);
    const close = store.beginOperation(ref, 'close'); store.apply(ref, { type: 'control_result', operationId: close.operation.operationId, phase: 'confirmed' });
    store.apply(ref, { type: 'control_result', operationId: first.operation.operationId, phase: 'confirmed', runtime: runtime.ref });
    expect(store.read(ref)!.lifecycle).toBe('closed');
  });
  it('survives reopen and refuses a stale state revision', () => {
    const store = open(); bind(store); const dir = directories[0]; const revision = store.read(ref)!.revision; store.close(); const other = open(dir);
    other.apply(ref, { type: 'worker_online', worker }, 'one', revision);
    expect(() => other.apply(ref, { type: 'worker_lost', worker }, 'two', revision)).toThrow(SessionContractConflict);
    expect(other.read(ref)!.workerOnline).toBe(true);
  });
  it('freezes callback origins across an in-worker execution replacement', async () => {
    vi.useFakeTimers(); const scope = new WorkerSessionEventScope(ref, worker); const first = scope.beginRuntime(); scope.assign(first.bindingId, { runtimeId: 'runtime_one', epoch: 1 });
    const received: any[] = [];
    scope.run(first, () => { setTimeout(scope.bind(() => received.push(scope.envelope())), 10); });
    const next = scope.beginRuntime(); scope.assign(next.bindingId, { runtimeId: 'runtime_two', epoch: 2 });
    await vi.advanceTimersByTimeAsync(11);
    expect(received[0].scope.runtime).toEqual({ runtimeId: 'runtime_one', epoch: 1 });
  });
});
