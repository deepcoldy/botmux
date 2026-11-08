import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionContractStore, SessionContractConflict, sessionContractStore } from '../src/services/session-contract-store.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { contractReadiness } from '../src/services/session-contract.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
const ref = { appId: 'cli_contract_test', sessionId: 'session_test' };
const worker = { workerId: 'worker_one', generation: 1 };
const identity = { backend: 'tmux', physicalId: 'pid:123:start:100', proof: 'process_start' as const, nativeSessionId: 'native_one' };
const directories: string[] = []; const stores: SessionContractStore[] = [];
function open(directory = mkdtempSync(join(tmpdir(), 'session-contract-'))) { if (!directories.includes(directory)) directories.push(directory); const store = new SessionContractStore(directory, ref.appId); stores.push(store); store.ensure(ref); return store; }
function bind(store: SessionContractStore, owner = worker, physical = identity) { store.bindWorker(ref, owner); const runtime = store.reserveRuntime(ref, owner); return store.bindRuntime(ref, runtime, owner, physical); }
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) try { store.close(); } catch {} for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('session identity and state contract', () => {
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
