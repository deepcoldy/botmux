import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionContractStore, SessionContractConflict } from '../src/services/session-contract-store.js';
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
