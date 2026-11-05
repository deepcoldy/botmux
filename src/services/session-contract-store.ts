import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';
import { isOutputJournalAppId } from './universal-output-handoff.js';
import type { TurnResultBinding, TurnResult, TurnDeliveryReceipt } from './turn-result.js';
import {
  reduceSessionContract, reusableRuntimeIdentity, sameRuntime, samePhysicalRuntimeIdentity,
  type ContractSessionRef, type SessionContract, type RuntimeContract, type RuntimeIdentity, type RuntimeRef,
  type ExecutionContract, type ExecutionRef, type ControlOperation, type ControlKind, type ContractEvent,
  type ContractTransition, type ContractTransitionInput, type WorkerRef,
} from './session-contract.js';

export class SessionContractConflict extends Error {
  constructor(readonly currentRevision: number) { super('session_contract_revision_conflict'); }
}
export interface SessionContractSnapshot {
  version: 2;
  session: SessionContract;
  tables: Record<string, Array<Record<string, unknown>>>;
}
const snapshotTables = ['entities', 'events', 'runtime_bindings', 'runtime_producers', 'deferred_events', 'observation_watermarks'] as const;
function sessionKey(ref: ContractSessionRef): string {
  if (!isOutputJournalAppId(ref.appId) || !ref.sessionId || /[\0\r\n]/.test(ref.sessionId)) throw new Error('invalid_contract_session');
  return JSON.stringify([ref.appId, ref.sessionId]);
}
function eventExecution(event: ContractEvent): ExecutionRef | undefined {
  if (event.type === 'execution_admitted') return event.execution.ref;
  if (event.type === 'execution_phase' || event.type === 'execution_terminal' || event.type === 'execution_output') return event.execution;
  if (event.type === 'control_requested') return event.operation.targetExecution;
  return undefined;
}
function eventRuntime(event: ContractEvent): RuntimeRef | undefined {
  if (event.type === 'runtime_reserved' || event.type === 'runtime_bound') return event.runtime.ref;
  if ('runtime' in event && event.runtime) return event.runtime;
  if (event.type === 'control_requested') return event.operation.targetRuntime;
  return undefined;
}
function terminalPhase(phase: string): boolean { return ['succeeded', 'failed', 'cancelled'].includes(phase); }

/** One transaction commits identity/state facts and the compatible read model.
 * Historic entities remain separate from the current runtime selection. */
export class SessionContractStore {
  readonly filename: string;
  private db: DatabaseSyncLike;
  private transactionDepth = 0;
  constructor(dataDir: string, readonly appId: string) {
    sessionKey({ appId, sessionId: 'check' });
    const dir = join(dataDir, 'session-stores', appId); mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.filename = join(dir, 'sessions.db'); this.db = openDatabaseSyncOrThrow(this.filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS contracts(session_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities(session_key TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,phase TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(session_key,kind,id));
      CREATE INDEX IF NOT EXISTS contract_entities_phase ON entities(session_key,kind,phase);
      CREATE TABLE IF NOT EXISTS deferred_events(session_key TEXT NOT NULL,binding_id TEXT NOT NULL,event_id TEXT NOT NULL,sequence INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(session_key,event_id));
      CREATE TABLE IF NOT EXISTS observation_watermarks(session_key TEXT NOT NULL,producer TEXT NOT NULL,runtime_id TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(session_key,producer,runtime_id));
      CREATE TABLE IF NOT EXISTS events(session_key TEXT NOT NULL,event_id TEXT NOT NULL,type TEXT NOT NULL,decision TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(session_key,event_id));
      CREATE TABLE IF NOT EXISTS runtime_bindings(session_key TEXT NOT NULL,binding_id TEXT NOT NULL,runtime_id TEXT NOT NULL,worker_id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(session_key,binding_id));
      CREATE TABLE IF NOT EXISTS runtime_producers(session_key TEXT NOT NULL,runtime_id TEXT NOT NULL,worker_id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(session_key,runtime_id,worker_id,generation));`);
    chmodSync(this.filename, 0o600);
  }
  close(): void { this.db.close(); }
  /** Borrow the owned Session transaction so row, event, revision and intent
   * commit together. The callback is synchronous and never crosses an await. */
  usingDatabase<T>(db: DatabaseSyncLike, work: () => T): T {
    const previous = this.db; this.db = db; this.transactionDepth++;
    try { return work(); } finally { this.transactionDepth--; this.db = previous; }
  }
  atomic<T>(work: () => T): T { return this.transaction(work); }
  snapshot(ref: ContractSessionRef): SessionContractSnapshot {
    return this.transaction(() => {
      const session = this.read(ref); if (!session) throw new Error('contract_session_missing');
      const tables = Object.fromEntries(snapshotTables.map(table => [table,
        this.db.prepare(`SELECT * FROM ${table} WHERE session_key=?`).all(sessionKey(ref)) as Array<Record<string, unknown>>]));
      return structuredClone({ version: 2, session, tables });
    });
  }
  restore(snapshot: SessionContractSnapshot): void {
    const ref = snapshot.session.ref; const key = sessionKey(ref);
    if (snapshot.version !== 2 || ref.appId !== this.appId) throw new Error('invalid_contract_checkpoint');
    this.transaction(() => {
      const allocatedEpoch = this.read(ref)?.runtimeEpoch ?? 0;
      for (const table of snapshotTables) {
        this.db.prepare(`DELETE FROM ${table} WHERE session_key=?`).run(key);
        for (const row of snapshot.tables[table] ?? []) {
          if (row.session_key !== key) throw new Error('contract_checkpoint_scope_mismatch');
          const columns = Object.keys(row);
          if (columns.some(column => !/^[a-z_]+$/.test(column))) throw new Error('invalid_checkpoint_column');
          this.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column] as string));
        }
      }
      const restored = { ...snapshot.session, runtimeEpoch: Math.max(allocatedEpoch, snapshot.session.runtimeEpoch) };
      this.db.prepare('INSERT INTO contracts VALUES(?,?,?) ON CONFLICT(session_key) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(key, restored.revision, JSON.stringify(restored));
    });
  }
  resultRevision(ref: ContractSessionRef, turnId: string, dispatchAttempt: number | undefined, value: unknown): number {
    return this.transaction(() => {
      const id = JSON.stringify([turnId, dispatchAttempt ?? null]);
      const signature = createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const previous = this.entity<{ signature: string; revision: number }>(ref, 'result_revision', id);
      if (previous?.signature === signature) return previous.revision;
      const revision = (previous?.revision ?? 0) + 1;
      this.saveEntity(ref, 'result_revision', id, 'snapshot', { signature, revision }); return revision;
    });
  }
  private transaction<T>(work: () => T): T {
    if (this.transactionDepth) return work();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionDepth--; }
  }
  read(ref: ContractSessionRef): SessionContract | undefined {
    const row = this.db.prepare('SELECT value,revision FROM contracts WHERE session_key=?').get(sessionKey(ref)) as { value: string; revision: number } | undefined;
    return row ? { ...JSON.parse(row.value), revision: Number(row.revision) } : undefined;
  }
  ensure(ref: ContractSessionRef, legacy?: { closed?: boolean; suspended?: boolean; readinessSequence?: number }): SessionContract {
    if (ref.appId !== this.appId) throw new Error('contract_app_mismatch');
    return this.transaction(() => {
      const current = this.read(ref); if (current) return current;
      const state: SessionContract = { ref, revision: 0, lifecycle: legacy?.closed ? 'closed' : legacy?.suspended ? 'suspended' : 'active', workerOnline: false, runtimeEpoch: 0, readinessSequence: legacy?.readinessSequence ?? 0 };
      this.db.prepare('INSERT INTO contracts(session_key,revision,value) VALUES(?,?,?)').run(sessionKey(ref), 0, JSON.stringify(state)); return state;
    });
  }
  private entity<T>(ref: ContractSessionRef, kind: string, id?: string): T | undefined {
    if (!id) return undefined;
    const row = this.db.prepare('SELECT value FROM entities WHERE session_key=? AND kind=? AND id=?').get(sessionKey(ref), kind, id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  runtime(ref: ContractSessionRef, runtimeId?: string): RuntimeContract | undefined { return this.entity(ref, 'runtime', runtimeId ?? this.read(ref)?.activeRuntime?.runtimeId); }
  physicalRuntimes(ref: ContractSessionRef, origin: RuntimeRef): RuntimeContract[] {
    const source = this.runtime(ref, origin.runtimeId);
    if (!source?.identity) return [];
    return (this.db.prepare("SELECT value FROM entities WHERE session_key=? AND kind='runtime'").all(sessionKey(ref)) as Array<{ value: string }>)
      .map(row => JSON.parse(row.value) as RuntimeContract).filter(runtime => samePhysicalRuntimeIdentity(runtime.identity, source.identity)
        && (source.identity!.proof !== 'opaque' || runtime.worker.workerId === source.worker.workerId));
  }
  execution(ref: ContractSessionRef, executionId: string): ExecutionContract | undefined { return this.entity(ref, 'execution', executionId); }
  operation(ref: ContractSessionRef, operationId?: string): ControlOperation | undefined { return this.entity(ref, 'operation', operationId ?? this.read(ref)?.activeOperationId); }
  latestCancel(ref: ContractSessionRef, executionId: string): ControlOperation | undefined {
    return (this.db.prepare("SELECT value FROM entities WHERE session_key=? AND kind='operation'").all(sessionKey(ref)) as Array<{ value: string }>)
      .map(row => JSON.parse(row.value) as ControlOperation).filter(operation => operation.kind === 'cancel' && operation.targetExecution?.executionId === executionId)
      .sort((left, right) => right.expectedRevision - left.expectedRevision)[0];
  }
  rememberResultBinding(ref: ContractSessionRef, binding: TurnResultBinding): void {
    this.transaction(() => {
      const id = JSON.stringify([binding.ref.turnId, binding.ref.dispatchAttempt ?? null]);
      if (!this.entity(ref, 'result_binding', id)) this.saveEntity(ref, 'result_binding', id, 'bound', binding);
    });
  }
  resultBinding(ref: ContractSessionRef, turnId: string, dispatchAttempt?: number): TurnResultBinding | undefined {
    return this.entity(ref, 'result_binding', JSON.stringify([turnId, dispatchAttempt ?? null]));
  }
  rememberResultDelivery(ref: ContractSessionRef, turnId: string, dispatchAttempt: number | undefined,
    output: TurnResult['output'], receipt: TurnDeliveryReceipt): void {
    this.transaction(() => {
      const id = JSON.stringify([turnId, dispatchAttempt ?? null]);
      const previous = this.entity<{ output: TurnResult['output']; receipt: TurnDeliveryReceipt }>(ref, 'result_delivery', id);
      if (previous?.receipt.status === 'delivered') return;
      this.saveEntity(ref, 'result_delivery', id, receipt.status, { output, receipt });
      const execution = this.executions(ref, turnId, dispatchAttempt)[0];
      if (execution) this.applyInside(ref, { type: 'execution_output', execution: execution.ref,
        output: { availability: output.status, ...(output.content !== undefined ? { content: output.content } : {}), completeness: execution.terminal?.status === 'succeeded' ? 'final' : 'partial' },
        delivery: { outputId: `result:${id}`, status: receipt.status, ...(receipt.messages[0] ? { messageId: receipt.messages[0].messageId } : {}) } }, randomUUID());
    });
  }
  resultDelivery(ref: ContractSessionRef, turnId: string, dispatchAttempt?: number): { output: TurnResult['output']; receipt: TurnDeliveryReceipt } | undefined {
    return this.entity(ref, 'result_delivery', JSON.stringify([turnId, dispatchAttempt ?? null]));
  }
  executions(ref: ContractSessionRef, turnId?: string, dispatchAttempt?: number): ExecutionContract[] {
    const rows = this.db.prepare("SELECT value FROM entities WHERE session_key=? AND kind='execution'").all(sessionKey(ref)) as Array<{ value: string }>;
    return rows.map(row => JSON.parse(row.value) as ExecutionContract).filter(value => !turnId || (value.ref.turnId === turnId && value.ref.dispatchAttempt === dispatchAttempt));
  }
  pendingOperations(ref: ContractSessionRef): ControlOperation[] {
    return (this.db.prepare("SELECT value FROM entities WHERE session_key=? AND kind='operation' AND phase IN ('planned','applying','uncertain')").all(sessionKey(ref)) as Array<{ value: string }>).map(row => JSON.parse(row.value));
  }
  private saveEntity(ref: ContractSessionRef, kind: string, id: string, phase: string, value: unknown): void {
    this.db.prepare('INSERT INTO entities(session_key,kind,id,phase,value) VALUES(?,?,?,?,?) ON CONFLICT(session_key,kind,id) DO UPDATE SET phase=excluded.phase,value=excluded.value').run(sessionKey(ref), kind, id, phase, JSON.stringify(value));
  }
  apply(ref: ContractSessionRef, event: ContractEvent, eventId: string = randomUUID(), expectedRevision?: number): ContractTransition {
    return this.transaction(() => this.applyInside(ref, event, eventId, expectedRevision));
  }
  private applyInside(ref: ContractSessionRef, event: ContractEvent, eventId: string, expectedRevision?: number): ContractTransition {
    const session = this.read(ref); if (!session) throw new Error('contract_session_missing');
    const seen = this.db.prepare('SELECT value FROM events WHERE session_key=? AND event_id=?').get(sessionKey(ref), eventId) as { value: string } | undefined;
    if (seen) {
      if (seen.value !== JSON.stringify(event)) throw new Error('contract_event_conflict');
      return { session, decision: 'duplicate' };
    }
    if (expectedRevision !== undefined && session.revision !== expectedRevision) throw new SessionContractConflict(session.revision);
    const runtimeRef = eventRuntime(event); const executionRef = eventExecution(event);
    const operationId = event.type === 'control_requested' ? event.operation.operationId : 'operationId' in event ? event.operationId : undefined;
    const input: ContractTransitionInput = { session,
      runtime: this.runtime(ref, runtimeRef?.runtimeId),
      execution: executionRef ? this.execution(ref, executionRef.executionId) : undefined,
      operation: event.type === 'control_requested' || event.type === 'runtime_ready' || event.type === 'runtime_busy' || event.type === 'execution_terminal' ? this.operation(ref) : this.operation(ref, operationId),
    };
    const result = reduceSessionContract(input, event);
    const changed = result.decision === 'applied' || result.decision === 'historical';
    if (changed) {
      result.session.revision = session.revision + 1;
      this.db.prepare('UPDATE contracts SET revision=?,value=? WHERE session_key=? AND revision=?').run(result.session.revision, JSON.stringify(result.session), sessionKey(ref), session.revision);
      if (result.runtime) this.saveEntity(ref, 'runtime', result.runtime.ref.runtimeId, result.runtime.phase, result.runtime);
      if (result.execution) this.saveEntity(ref, 'execution', result.execution.ref.executionId, result.execution.phase, result.execution);
      if (result.retiredOperation) this.saveEntity(ref, 'operation', result.retiredOperation.operationId, result.retiredOperation.phase, result.retiredOperation);
      if (result.operation) this.saveEntity(ref, 'operation', result.operation.operationId, result.operation.phase, result.operation);
      // Session is the compatible projection of this contract. Metadata writers
      // use the same database and preserve the terminal lifecycle/revision.
      if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get()) {
        const hit = this.db.prepare('SELECT row FROM sessions WHERE session_id=?').get(ref.sessionId) as { row: string } | undefined;
        if (hit) {
          const row = JSON.parse(hit.row);
          // The opened app-scoped database is the owner. Legacy annotation
          // fields on the Session row are not an authorization boundary.
          row.sessionContractRevision = result.session.revision;
          row.sessionLifecycle = result.session.lifecycle;
          row.status = result.session.lifecycle === 'closed' ? 'closed' : 'active';
          if (row.status === 'closed') row.closedAt ??= new Date().toISOString();
          this.db.prepare('UPDATE sessions SET status=?,row=? WHERE session_id=?').run(row.status, JSON.stringify(row), ref.sessionId);
        }
      }
    }
    this.db.prepare('INSERT INTO events(session_key,event_id,type,decision,value,revision) VALUES(?,?,?,?,?,?)').run(sessionKey(ref), eventId, event.type, result.decision, JSON.stringify(event), result.session.revision);
    return result;
  }
  bindWorker(ref: ContractSessionRef, worker: WorkerRef): SessionContract {
    this.ensure(ref); return this.apply(ref, { type: 'worker_bound', worker }).session;
  }
  acceptObservation(ref: ContractSessionRef, worker: WorkerRef, runtime: RuntimeRef, sequence: number): boolean {
    return this.transaction(() => {
      const producer = JSON.stringify(worker);
      const hit = this.db.prepare('SELECT sequence FROM observation_watermarks WHERE session_key=? AND producer=? AND runtime_id=?').get(sessionKey(ref), producer, runtime.runtimeId) as { sequence: number } | undefined;
      if (hit && hit.sequence >= sequence) return false;
      this.db.prepare('INSERT INTO observation_watermarks VALUES(?,?,?,?) ON CONFLICT(session_key,producer,runtime_id) DO UPDATE SET sequence=excluded.sequence').run(sessionKey(ref), producer, runtime.runtimeId, sequence);
      return true;
    });
  }
  reserveRuntime(ref: ContractSessionRef, worker: WorkerRef, bindingId?: string): RuntimeRef {
    return this.transaction(() => {
      const bound = bindingId ? this.binding(ref, bindingId) : undefined;
      if (bound) return bound.ref;
      const state = this.read(ref); if (!state) throw new Error('contract_session_missing');
      const runtime: RuntimeContract = { ref: { runtimeId: randomUUID(), epoch: state.runtimeEpoch + 1 }, worker, phase: 'starting', promptReady: false, promptReadySequence: 0 };
      const result = this.applyInside(ref, { type: 'runtime_reserved', runtime }, randomUUID(), state.revision);
      if (result.decision !== 'applied') throw new Error('runtime_reservation_failed');
      if (bindingId) this.db.prepare('INSERT INTO runtime_bindings(session_key,binding_id,runtime_id,worker_id,generation) VALUES(?,?,?,?,?)').run(sessionKey(ref), bindingId, runtime.ref.runtimeId, worker.workerId, worker.generation);
      return runtime.ref;
    });
  }
  bindRuntime(ref: ContractSessionRef, proposed: RuntimeRef, worker: WorkerRef, identity: RuntimeIdentity, operationId?: string): RuntimeContract {
    return this.transaction(() => {
      const previous = this.runtime(ref);
      const reserved = this.runtime(ref, proposed.runtimeId);
      if (!reserved || !sameRuntime(reserved.ref, proposed)) throw new Error('runtime_reservation_missing');
      if (reserved.identity && reusableRuntimeIdentity(reserved.identity, identity) && reserved.worker.workerId === worker.workerId) return reserved;
      if (reserved.identity && reserved.worker.workerId === worker.workerId && reserved.identity.proof !== 'opaque') {
        const old = reserved.identity;
        if (old.backend !== identity.backend || old.physicalId !== identity.physicalId || old.proof !== identity.proof
          || (old.nativeSessionId !== undefined && old.nativeSessionId !== identity.nativeSessionId)
          || (old.nativeGeneration !== undefined && old.nativeGeneration !== identity.nativeGeneration)) throw new Error('runtime_identity_changed');
      }
      const reuse = previous && !['retiring', 'stopped'].includes(previous.phase) && reusableRuntimeIdentity(previous.identity, identity);
      const enriching = !!reserved.identity && reserved.worker.workerId === worker.workerId;
      const runtime: RuntimeContract = { ...(reuse ? previous : reserved), worker, identity,
        ...(!enriching ? { phase: 'starting' as const, promptReady: false } : {}) };
      const result = this.applyInside(ref, { type: 'runtime_bound', runtime, ...(operationId ? { operationId } : {}) }, randomUUID());
      if (!['applied', 'historical'].includes(result.decision)) throw new Error(`runtime_binding_${result.decision}`);
      if (result.decision === 'applied' && previous && !sameRuntime(previous.ref, runtime.ref) && !['stopped', 'unresolved'].includes(previous.phase)) {
        this.saveEntity(ref, 'runtime', previous.ref.runtimeId, 'retiring', { ...previous, phase: 'retiring', promptReady: false });
      }
      this.db.prepare('UPDATE runtime_bindings SET runtime_id=? WHERE session_key=? AND runtime_id=? AND worker_id=? AND generation=?').run(runtime.ref.runtimeId, sessionKey(ref), proposed.runtimeId, worker.workerId, worker.generation);
      this.db.prepare('INSERT OR IGNORE INTO runtime_producers(session_key,runtime_id,worker_id,generation) VALUES(?,?,?,?)').run(sessionKey(ref), runtime.ref.runtimeId, worker.workerId, worker.generation);
      return result.runtime ?? runtime;
    });
  }
  deferEvent(ref: ContractSessionRef, bindingId: string, eventId: string, sequence: number, message: unknown): void {
    this.db.prepare('INSERT OR IGNORE INTO deferred_events(session_key,binding_id,event_id,sequence,value) VALUES(?,?,?,?,?)').run(sessionKey(ref), bindingId, eventId, sequence, JSON.stringify(message));
  }
  deferredEvents<T>(ref: ContractSessionRef, bindingId: string): T[] {
    return (this.db.prepare('SELECT value FROM deferred_events WHERE session_key=? AND binding_id=? ORDER BY sequence,event_id').all(sessionKey(ref), bindingId) as Array<{ value: string }>).map(row => JSON.parse(row.value));
  }
  acknowledgeDeferred(ref: ContractSessionRef, eventId: string): void {
    this.db.prepare('DELETE FROM deferred_events WHERE session_key=? AND event_id=?').run(sessionKey(ref), eventId);
  }
  binding(ref: ContractSessionRef, bindingId: string): RuntimeContract | undefined {
    const row = this.db.prepare('SELECT runtime_id FROM runtime_bindings WHERE session_key=? AND binding_id=?').get(sessionKey(ref), bindingId) as { runtime_id: string } | undefined;
    return row ? this.runtime(ref, row.runtime_id) : undefined;
  }
  bindingProducer(ref: ContractSessionRef, bindingId: string, worker: WorkerRef): boolean {
    return !!this.db.prepare('SELECT binding_id FROM runtime_bindings WHERE session_key=? AND binding_id=? AND worker_id=? AND generation=?').get(sessionKey(ref), bindingId, worker.workerId, worker.generation);
  }
  authorizedProducer(ref: ContractSessionRef, runtime: RuntimeRef, worker: WorkerRef): boolean {
    const known = this.runtime(ref, runtime.runtimeId);
    return sameRuntime(known?.ref, runtime) && !!this.db.prepare('SELECT worker_id FROM runtime_producers WHERE session_key=? AND runtime_id=? AND worker_id=? AND generation=?').get(sessionKey(ref), runtime.runtimeId, worker.workerId, worker.generation);
  }
  admitExecution(ref: ContractSessionRef, turnId: string, dispatchAttempt?: number, admissionId?: string): ExecutionContract {
    return this.transaction(() => {
      const session = this.read(ref); if (!session) throw new Error('contract_session_missing');
      const executionId = createHash('sha256').update(JSON.stringify([ref, admissionId ?? turnId, dispatchAttempt ?? null])).digest('hex');
      const existing = this.execution(ref, executionId); if (existing) return existing;
      const execution: ExecutionContract = { ref: { executionId, turnId, ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}) }, phase: 'queued', deliveries: [], cancelRequested: false, revision: 0 };
      const result = this.applyInside(ref, { type: 'execution_admitted', execution }, `admission:${executionId}`);
      if (result.decision !== 'applied') throw new Error('execution_admission_failed'); return execution;
    });
  }
  bindQueuedExecution(ref: ContractSessionRef, execution: ExecutionRef, runtime: RuntimeRef): ExecutionContract {
    return this.transaction(() => {
      const value = this.execution(ref, execution.executionId); if (!value) throw new Error('execution_missing');
      if (value.ref.turnId !== execution.turnId || value.ref.dispatchAttempt !== execution.dispatchAttempt || !sameRuntime(this.runtime(ref, runtime.runtimeId)?.ref, runtime)) throw new Error('execution_binding_unproven');
      if (value.runtime && !sameRuntime(value.runtime, runtime)) throw new Error('execution_runtime_conflict');
      value.runtime = runtime; this.saveEntity(ref, 'execution', value.ref.executionId, value.phase, value); return value;
    });
  }
  beginOperation(ref: ContractSessionRef, kind: ControlKind, options: { operationId?: string; runtime?: RuntimeRef; execution?: ExecutionRef; proposedRuntime?: RuntimeRef } = {}): { operation: ControlOperation; joined: boolean } {
    return this.transaction(() => {
      const session = this.read(ref); if (!session) throw new Error('contract_session_missing');
      const active = this.operation(ref);
      if (active && kind !== 'close') {
        if (active.kind !== kind || (options.execution && active.targetExecution?.executionId !== options.execution.executionId)) throw new Error('control_operation_in_progress');
        return { operation: active, joined: true };
      }
      if (active?.kind === 'close' && kind === 'close') return { operation: active, joined: true };
      const operation: ControlOperation = { operationId: options.operationId ?? randomUUID(), kind, phase: 'planned', targetRuntime: options.runtime ?? session.activeRuntime, targetExecution: options.execution, proposedRuntime: options.proposedRuntime, expectedRevision: session.revision, previousLifecycle: session.lifecycle };
      const result = this.applyInside(ref, { type: 'control_requested', operation }, `operation:${operation.operationId}`, session.revision);
      if (result.decision !== 'applied') throw new Error(`control_request_${result.decision}`); return { operation, joined: false };
    });
  }
  markUnresolvedExecutions(ref: ContractSessionRef, runtime: RuntimeRef): void {
    for (const execution of this.executions(ref).filter(e => sameRuntime(e.runtime, runtime) && !terminalPhase(e.phase))) {
      this.apply(ref, { type: 'execution_terminal', execution: execution.ref, runtime, status: 'reconciling', evidence: 'observer_loss' });
    }
  }
}
const stores = new Map<string, SessionContractStore>();
export function sessionContractStore(dataDir: string, appId: string): SessionContractStore {
  const key = `${dataDir}:${appId}`;
  let store = stores.get(key); if (!store) { store = new SessionContractStore(dataDir, appId); stores.set(key, store); } return store;
}
