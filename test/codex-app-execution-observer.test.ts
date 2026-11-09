import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { sameWorker } from '../src/services/session-contract.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import * as realSessions from '../src/services/session-store.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';
const cfg = vi.hoisted(() => ({ dir: '' }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return cfg.dir; } } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
const cleanup: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(options: { native?: string; ledgerState?: string; ledgerAttempt?: number; cli?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'observer-probe-')); cfg.dir = dir;
  cleanup.push(() => rmSync(dir, { force: true, recursive: true }));
  const appId = 'cli_observer_probe'; realSessions.init(appId);
  const session: any = realSessions.createSession('oc_probe', 'om_probe', 'probe', 'group', 'thread');
  session.cliId = options.cli ?? 'codex-app';
  const ref = { appId, sessionId: session.sessionId };
  const store = new SessionContractStore(dir, appId); cleanup.push(() => store.close());
  const ds: any = { larkAppId: appId, chatId: 'oc_probe', session, cliReadyGeneration: 0 };
  const controller = new SessionController(ds, store); const oldWorker = controller.bindWorker(1).worker;
  const old = controller.reserveBinding('historical', oldWorker);
  const identity: any = { backend: 'tmux', proof: 'process_start', physicalId: '111:start111', nativeSessionId: 'native-original' };
  controller.bindRuntime('historical', oldWorker, identity);
  const historical = controller.admitInput('turn-old', 1); store.bindQueuedExecution(ref, historical, old);
  store.apply(ref, { type: 'execution_phase', runtime: old, execution: historical, phase: 'submitting' });
  controller.workerLost(oldWorker);
  const worker = controller.bindWorker(2).worker; const scope = new WorkerSessionEventScope(ref, worker);
  const binding = scope.beginRuntime(); binding.identity = { ...identity }; delete binding.identity.nativeSessionId;
  controller.reserveBinding(binding.bindingId, worker);
  const current = controller.bindRuntime(binding.bindingId, worker, binding.identity); scope.assign(binding.bindingId, current.ref);
  const middle = controller.admitInput('turn-middle', 2); store.bindQueuedExecution(ref, middle, current.ref);
  store.apply(ref, { type: 'execution_phase', runtime: current.ref, execution: middle, phase: 'submitting' });
  scope.noteAdmission({ ref: historical, runtime: old, phase: 'reconciling' });
  scope.noteAdmission({ ref: middle, runtime: current.ref, phase: 'submitting' }); scope.rememberExecution(middle, binding);
  session.codexAppDispatchLedger = [{ dispatchId: 'dispatch-old', turnId: historical.turnId,
    dispatchAttempt: options.ledgerAttempt ?? historical.dispatchAttempt, state: options.ledgerState ?? 'prepared', content: 'old prompt' }];
  realSessions.updateSession(session);
  const pending: Promise<void>[] = []; const assignments: any[] = [];
  const workerEnv: any = { workerSessionEventScope: scope };
  const assign = loadWorkerMessageHandler('runtime_contract_assigned', workerEnv);
  const ipcWorker: any = { send: (message: any) => { assignments.push(message); if (message.type === 'runtime_contract_assigned') pending.push(assign(message)); } }; ds.worker = ipcWorker;
  const hostEnv: any = { sessionController: controller, contractWorker: worker, ds, worker: ipcWorker,
    sameWorker, isCodexAppCliId, logger: { warn: vi.fn(), debug: vi.fn() }, t: 'observer', handleLegacyWorkerMessage: vi.fn() };
  const host = loadWorkerPoolClosure<any>('handleWorkerMessage', hostEnv); hostEnv.handleWorkerMessage = host;
  const stamp = loadWorkerFunction<any>('sessionEventMetadata', workerEnv);
  const enrich = async () => {
    const message = scope.run(binding, () => stamp({ type: 'runtime_binding', bindingId: binding.bindingId,
      identity: { ...identity, nativeSessionId: options.native ?? identity.nativeSessionId } }));
    await host(message); while (pending.length) await Promise.all(pending.splice(0));
  };
  let sequence = 100;
  const context = (execution: any = historical, runtime: any = old, producer: any = worker) => ({ version: 2 as const,
    session: ref, producer, sequence: ++sequence, eventId: `${producer.workerId}:${sequence}`, scope: { runtime, execution } });
  const message = (type: string, execution: any = historical, runtime: any = old, producer: any = worker) => ({ type,
    turnId: execution.turnId, dispatchAttempt: execution.dispatchAttempt, content: 'historical answer', status: 'completed',
    sessionContract: context(execution, runtime, producer) });
  return { dir, ref, store, controller, ds, worker, oldWorker, old, historical, middle, current: current.ref, scope, binding, assignments, enrich, context, message, identity };
}
describe('historical execution observation across occupied bare runtime', () => {
  it('grants exact historical output and terminal observation while preserving the active runtime and its unfinished input', async () => {
    vi.useFakeTimers(); const h = fixture(); await h.enrich();
    expect(h.store.authorizedProducer(h.ref, h.old, h.worker)).toBe(false);
    expect(h.store.authorizedExecutionObserver(h.ref, h.old, h.worker, h.historical)).toBe(true);
    expect(h.assignments.at(-1).observedExecutions).toEqual([{ runtime: h.old, execution: h.historical }]);
    expect(h.scope.currentBinding()).toBe(h.binding); expect(h.controller.currentRuntime()).toEqual(h.current);
    const emit = h.scope.run(h.binding, () => h.scope.bindExecutionEvent((type: string) => {
      const origin = h.scope.envelope();
      return h.controller.ingest({ ...h.message(type), sessionContract: origin }, h.worker);
    }, () => ({ turnId: h.historical.turnId, dispatchAttempt: h.historical.dispatchAttempt })));
    expect(emit('final_output').kind).toBe('historical'); expect(emit('turn_terminal').kind).toBe('historical');
    expect(h.store.execution(h.ref, h.historical.executionId)).toMatchObject({ phase: 'succeeded', runtime: h.old, output: { content: 'historical answer' } });
    expect(h.store.execution(h.ref, h.middle.executionId)).toMatchObject({ phase: 'submitting', runtime: h.current });
    expect(h.controller.currentRuntime()).toEqual(h.current); expect(h.scope.currentBinding()).toBe(h.binding);
  });
  it.each(['prompt_ready', 'screen_update', 'managed_turn_origin', 'managed_turn_origin_revoked', 'codex_app_dispatch_transition',
    'final_output_offer', 'turn_interrupt_result', 'codex_app_dispatch_persisted', 'restart_result'])(
    'does not turn observer authority into %s authority', async type => {
      const h = fixture(); await h.enrich(); const before = h.store.read(h.ref)!.revision;
      expect(h.controller.ingest(h.message(type), h.worker).kind).toBe('reject');
      expect(h.store.read(h.ref)!.revision).toBe(before); expect(h.controller.currentRuntime()).toEqual(h.current);
    });
  it.each(['wrong-attempt', 'unknown-execution', 'wrong-runtime', 'stale-worker'])(
    'rejects a mismatched observer envelope: %s', async failure => {
      const h = fixture(); await h.enrich();
      const execution = failure === 'wrong-attempt' ? { ...h.historical, dispatchAttempt: 9 }
        : failure === 'unknown-execution' ? { ...h.historical, executionId: 'unadmitted' } : h.historical;
      if (failure === 'stale-worker') h.controller.bindWorker(3);
      expect(h.controller.ingest(h.message('final_output', execution, failure === 'wrong-runtime' ? h.current : h.old), h.worker).kind).toBe('reject');
      expect(h.store.execution(h.ref, h.historical.executionId)?.phase).toBe('reconciling');
    });
  it.each([{ native: 'another-native' }, { ledgerState: 'accepted' }, { ledgerAttempt: 99 }, { cli: 'claude-code' }])(
    'requires matching native proof and exact prepared Codex App admission: %j', async options => {
      const h = fixture(options); await h.enrich();
      expect(h.store.authorizedExecutionObserver(h.ref, h.old, h.worker, h.historical)).toBe(false);
      expect(h.assignments.at(-1).observedExecutions).toBeUndefined();
      expect(h.controller.currentRuntime()).toEqual(h.current);
    });
  it('persists an idempotent grant in the SQLite snapshot and advances the contract revision', async () => {
    const h = fixture(); await h.enrich(); const before = h.store.read(h.ref)!.revision;
    expect(h.store.authorizeExecutionObserver(h.ref, h.worker, h.historical)).toBe(true);
    expect(h.store.read(h.ref)!.revision).toBe(before);
    const reopened = new SessionContractStore(h.dir, h.ref.appId); cleanup.push(() => reopened.close());
    expect(reopened.authorizedExecutionObserver(h.ref, h.old, h.worker, h.historical)).toBe(true);
    const projection: any = openDatabaseSyncOrThrow(join(h.dir, 'session-stores', h.ref.appId, 'sessions.db'));
    try {
      const row = projection.prepare('SELECT row FROM sessions WHERE session_id=?').get(h.ref.sessionId);
      expect(JSON.parse(row.row).sessionContractRevision).toBe(h.store.read(h.ref)!.revision);
    } finally { projection.close(); }
  });
  it('accepts a frozen observer-origin final from a later carrier without granting the carrier executor control', async () => {
    const h = fixture(); await h.enrich();
    const origin = h.context();
    expect(h.controller.ingest({ ...h.message('turn_terminal'), sessionContract: origin }, h.worker).kind).toBe('historical');
    const carrier = h.controller.bindWorker(3).worker;
    const proven = h.controller.outputOrigin(origin); expect(proven).toBeDefined();
    const admission = h.controller.ingest({ ...h.message('final_output', h.historical, h.old, carrier), sessionOutputOrigin: proven }, carrier, proven);
    expect(admission.kind).toBe('historical');
    expect(h.store.authorizedProducer(h.ref, h.old, carrier)).toBe(false);
    expect(h.store.authorizedExecutionObserver(h.ref, h.old, carrier, h.historical)).toBe(false);
    expect(h.controller.currentRuntime()).toEqual(h.current);
  });
});

describe('observer durable commit failure boundaries', () => {
  it('rolls back the observer grant when the compatible Session row cannot persist, then retries idempotently', async () => {
    vi.useFakeTimers(); const h = fixture(); const before = h.store.read(h.ref)!.revision;
    const db = openDatabaseSyncOrThrow(join(h.dir, 'session-stores', h.ref.appId, 'sessions.db'));
    try {
      db.exec(`CREATE TRIGGER fail_observer_projection BEFORE UPDATE ON sessions
        WHEN json_extract(NEW.row, '$.sessionContractRevision') = ${before + 2}
        BEGIN SELECT RAISE(ABORT, 'observer_projection_failed'); END`);
      await h.enrich();
      expect(h.store.authorizedExecutionObserver(h.ref, h.old, h.worker, h.historical)).toBe(false);
      expect(h.store.read(h.ref)!.revision).toBe(before + 1);
      expect(h.controller.currentRuntime()).toEqual(h.current);
      expect(h.store.execution(h.ref, h.middle.executionId)?.runtime).toEqual(h.current);
      db.exec('DROP TRIGGER fail_observer_projection');
      await h.enrich();
      expect(h.store.authorizedExecutionObserver(h.ref, h.old, h.worker, h.historical)).toBe(true);
      expect(h.store.read(h.ref)!.revision).toBe(before + 2);
      const row: any = db.prepare('SELECT row FROM sessions WHERE session_id=?').get(h.ref.sessionId);
      expect(JSON.parse(row.row).sessionContractRevision).toBe(before + 2);
      expect(h.ds.session.sessionContractRevision).toBe(before + 2);
    } finally { db.close(); }
  });
  it('refuses a restored execution reference whose runtime epoch is inconsistent with its source entity', async () => {
    const h = fixture(); const snapshot = h.store.snapshot(h.ref);
    const row: any = snapshot.tables.entities.find(e => e.kind === 'execution' && e.id === h.historical.executionId);
    const value = JSON.parse(row.value); value.runtime.epoch += 1; row.value = JSON.stringify(value);
    h.store.restore(snapshot); await h.enrich();
    expect(h.store.authorizedExecutionObserver(h.ref, h.old, h.worker, h.historical)).toBe(false);
    expect(h.controller.currentRuntime()).toEqual(h.current);
  });
});
