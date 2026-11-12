import { mkdirSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';
import { isOutputJournalAppId } from './universal-output-handoff.js';
import type { TurnResultBinding, TurnResult, TurnDeliveryReceipt } from './turn-result.js';
import {
  reduceSessionContract, reusableRuntimeIdentity, sameRuntime, sameWorker, sameExecution, samePhysicalRuntimeIdentity, canSupersedeControlOperation,
  type ContractSessionRef, type SessionContract, type RuntimeContract, type RuntimeIdentity, type RuntimeRef,
  type ExecutionContract, type ExecutionRef, type ControlOperation, type ControlKind, type ContractEvent,
  type ContractTransition, type ContractTransitionInput, type WorkerRef, type RuntimeExecutionContinuation, type RuntimeExecutionContinuationResult,
  type RuntimeExecutionContinuationFailure,
} from './session-contract.js';

export class SessionContractConflict extends Error {
  constructor(readonly currentRevision: number) { super('session_contract_revision_conflict'); }
}
interface PlannedExecutionContinuation extends RuntimeExecutionContinuation {
  target: RuntimeRef;
  executionRuntime: RuntimeRef;
  worker: WorkerRef;
  status: 'planned' | 'approved' | 'rejected';
  consumed?: true;
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
  if (event.type === 'execution_phase' || event.type === 'execution_continued' || event.type === 'execution_terminal' || event.type === 'execution_output') return event.execution;
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
// Recovery replays these records to prove a runtime interval; never pruned.
const structuralEvents = ['runtime_bound', 'runtime_reserved'];
const retention = { events: 1024, executions: 256, results: 256, operations: 128, interval: 128 };
function eventRecord(event: ContractEvent, json = JSON.stringify(event)): string {
  return structuralEvents.includes(event.type) ? json : `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

const contractSchema = `
      CREATE TABLE IF NOT EXISTS contracts(session_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities(session_key TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,phase TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(session_key,kind,id));
      CREATE INDEX IF NOT EXISTS contract_entities_phase ON entities(session_key,kind,phase);
      CREATE INDEX IF NOT EXISTS contract_execution_turns ON entities(session_key,kind,json_extract(value,'$.ref.turnId'));
      CREATE TABLE IF NOT EXISTS deferred_events(session_key TEXT NOT NULL,binding_id TEXT NOT NULL,event_id TEXT NOT NULL,sequence INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(session_key,event_id));
      CREATE TABLE IF NOT EXISTS observation_watermarks(session_key TEXT NOT NULL,producer TEXT NOT NULL,runtime_id TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(session_key,producer,runtime_id));
      CREATE TABLE IF NOT EXISTS events(session_key TEXT NOT NULL,event_id TEXT NOT NULL,type TEXT NOT NULL,decision TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(session_key,event_id));
      CREATE TABLE IF NOT EXISTS runtime_bindings(session_key TEXT NOT NULL,binding_id TEXT NOT NULL,runtime_id TEXT NOT NULL,worker_id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(session_key,binding_id));
      CREATE TABLE IF NOT EXISTS runtime_producers(session_key TEXT NOT NULL,runtime_id TEXT NOT NULL,worker_id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(session_key,runtime_id,worker_id,generation));`;

/** One transaction commits identity/state facts and the compatible read model.
 * Historic entities remain separate from the current runtime selection. */
export class SessionContractStore {
  readonly filename: string;
  private connection: DatabaseSyncLike;
  private readonly ownedDatabase: DatabaseSyncLike;
  private databaseIdentity?: { device: bigint; inode: bigint };
  private closed = false;
  private readonly epochFloors = new Map<string, number>();
  private readonly writesSincePrune = new Map<string, number>();
  private get db(): DatabaseSyncLike {
    if (this.closed) throw new Error('session_contract_store_closed');
    if (this.connection === this.ownedDatabase && this.databaseIdentity && !this.isCurrentDatabase()) {
      throw new Error('session_contract_database_replaced');
    }
    return this.connection;
  }
  private set db(value: DatabaseSyncLike) { this.connection = value; }
  private transactionDepth = 0;
  constructor(dataDir: string, readonly appId: string) {
    sessionKey({ appId, sessionId: 'check' });
    const dir = join(dataDir, 'session-stores', appId); mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.filename = join(dir, 'sessions.db');
    this.connection = this.ownedDatabase = openDatabaseSyncOrThrow(this.filename);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(contractSchema);
    chmodSync(this.filename, 0o600);
    const identity = statSync(this.filename, { bigint: true });
    this.databaseIdentity = { device: identity.dev, inode: identity.ino };
  }
  isCurrentDatabase(): boolean {
    if (this.closed || !this.databaseIdentity) return false;
    try {
      const current = statSync(this.filename, { bigint: true });
      return current.dev === this.databaseIdentity.device && current.ino === this.databaseIdentity.inode;
    } catch { return false; }
  }
  close(): void { if (!this.closed) { this.closed = true; this.ownedDatabase.close(); } }
  knownEpochFloors(): ReadonlyMap<string, number> { return new Map(this.epochFloors); }
  private rememberEpoch(ref: ContractSessionRef, epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('invalid_contract_epoch');
    const key = sessionKey(ref);
    this.epochFloors.set(key, Math.max(epoch, this.epochFloors.get(key) ?? 0));
  }
  retainEpochFloors(floors: ReadonlyMap<string, number>): void {
    // Carry allocator knowledge only, never an old worker, binding or attempt.
    for (const [key, epoch] of floors) {
      const [appId, sessionId] = JSON.parse(key) as [string, string];
      if (appId !== this.appId) throw new Error('contract_app_mismatch');
      const ref = { appId, sessionId }; this.rememberEpoch(ref, epoch);
      const state = this.read(ref);
      const floor = this.epochFloors.get(key)!;
      if (state && state.runtimeEpoch < floor) this.apply(ref, { type: 'runtime_epoch_floor', epoch: floor });
    }
  }
  /** Borrow the owned Session transaction so row, event, revision and intent
   * commit together. The callback is synchronous and never crosses an await. */
  usingDatabase<T>(db: DatabaseSyncLike, work: () => T): T {
    const previous = this.db; this.db = db; this.transactionDepth++;
    // A borrowed Session connection may have been recreated. Schema creation
    // participates in the caller's transaction and is retried after rollback.
    try { this.db.exec(contractSchema); return work(); } finally { this.transactionDepth--; this.db = previous; }
  }
  atomic<T>(work: () => T): T { return this.transaction(work); }
  snapshot(ref: ContractSessionRef): SessionContractSnapshot {
    return this.transaction(() => {
      const session = this.read(ref); if (!session) throw new Error('contract_session_missing');
      const tables = Object.fromEntries(snapshotTables.map(table => [table,
        this.db.prepare(`SELECT * FROM ${table} WHERE session_key=? ORDER BY rowid`).all(sessionKey(ref)) as Array<Record<string, unknown>>]));
      return structuredClone({ version: 2, session, tables });
    });
  }
  restore(snapshot: SessionContractSnapshot): void {
    const ref = snapshot.session.ref; const key = sessionKey(ref);
    if (snapshot.version !== 2 || ref.appId !== this.appId) throw new Error('invalid_contract_checkpoint');
    this.transaction(() => {
      const allocatedEpoch = Math.max(this.read(ref)?.runtimeEpoch ?? 0, this.epochFloors.get(key) ?? 0);
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
      this.rememberEpoch(ref, restored.runtimeEpoch);
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
    if (!row) return undefined;
    const value = { ...JSON.parse(row.value), revision: Number(row.revision) } as SessionContract;
    this.rememberEpoch(ref, value.runtimeEpoch); return value;
  }
  ensure(ref: ContractSessionRef, legacy?: { closed?: boolean; suspended?: boolean; readinessSequence?: number }): SessionContract {
    if (ref.appId !== this.appId) throw new Error('contract_app_mismatch');
    return this.transaction(() => {
      const current = this.read(ref); if (current) return current;
      const state: SessionContract = { ref, revision: 0, lifecycle: legacy?.closed ? 'closed' : legacy?.suspended ? 'suspended' : 'active', workerOnline: false, runtimeEpoch: this.epochFloors.get(sessionKey(ref)) ?? 0, readinessSequence: legacy?.readinessSequence ?? 0 };
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
  hasPendingRuntimeReplacement(ref: ContractSessionRef, origin: RuntimeRef): boolean {
    const worker = this.read(ref)?.worker;
    if (!worker) return false;
    // Check bindings still owned by the selected worker. Allocator high water
    // and orphaned reservation entities survive a successful identity reuse.
    const rows = this.db.prepare("SELECT e.value FROM runtime_bindings b JOIN entities e ON e.session_key=b.session_key AND e.id=b.runtime_id AND e.kind='runtime' WHERE b.session_key=? AND b.worker_id=? AND b.generation=? AND e.phase='starting'")
      .all(sessionKey(ref), worker.workerId, worker.generation) as Array<{ value: string }>;
    return rows.some(row => {
      const runtime = JSON.parse(row.value) as RuntimeContract;
      return !runtime.identity && runtime.ref.epoch > origin.epoch;
    });
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
    const rows = (turnId === undefined
      ? this.db.prepare("SELECT value FROM entities WHERE session_key=? AND kind='execution'").all(sessionKey(ref))
      : this.db.prepare("SELECT value FROM entities WHERE session_key=? AND kind='execution' AND json_extract(value,'$.ref.turnId')=?").all(sessionKey(ref), turnId)) as Array<{ value: string }>;
    return rows.map(row => JSON.parse(row.value) as ExecutionContract).filter(value => !turnId || (value.ref.turnId === turnId && value.ref.dispatchAttempt === dispatchAttempt));
  }
  pendingOperations(ref: ContractSessionRef): ControlOperation[] {
    return (this.db.prepare("SELECT value FROM entities WHERE session_key=? AND kind='operation' AND phase IN ('planned','applying','uncertain')").all(sessionKey(ref)) as Array<{ value: string }>).map(row => JSON.parse(row.value));
  }
  private saveEntity(ref: ContractSessionRef, kind: string, id: string, phase: string, value: unknown): void {
    this.db.prepare('INSERT INTO entities(session_key,kind,id,phase,value) VALUES(?,?,?,?,?) ON CONFLICT(session_key,kind,id) DO UPDATE SET phase=excluded.phase,value=excluded.value').run(sessionKey(ref), kind, id, phase, JSON.stringify(value));
  }
  /** Continuation decisions are checkpointed authority, not an auxiliary
   * cache. Advance the version in the same transaction as the entity write. */
  private saveExecutionContinuation(ref: ContractSessionRef, bindingId: string, value: PlannedExecutionContinuation): void {
    this.saveVersionedEntity(ref, 'execution_continuation', bindingId, value.status, value);
  }
  private saveVersionedEntity(ref: ContractSessionRef, kind: string, id: string, phase: string, value: unknown): void {
    this.transaction(() => {
      const previous = this.entity<unknown>(ref, kind, id);
      if (JSON.stringify(previous) === JSON.stringify(value)) return;
      const state = this.read(ref); if (!state) throw new Error('contract_session_missing');
      this.saveEntity(ref, kind, id, phase, value);
      const updated = { ...state, revision: state.revision + 1 };
      const changed = this.db.prepare('UPDATE contracts SET revision=?,value=? WHERE session_key=? AND revision=?')
        .run(updated.revision, JSON.stringify(updated), sessionKey(ref), state.revision);
      if (Number(changed.changes) !== 1) throw new SessionContractConflict(state.revision);
      this.projectSession(ref, updated);
    });
  }
  private projectSession(ref: ContractSessionRef, state: SessionContract): void {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get()) return;
    const hit = this.db.prepare('SELECT row FROM sessions WHERE session_id=?').get(ref.sessionId) as { row: string } | undefined;
    if (!hit) return;
    const row = JSON.parse(hit.row);
    row.sessionContractRevision = state.revision;
    row.sessionLifecycle = state.lifecycle;
    row.status = state.lifecycle === 'closed' ? 'closed' : 'active';
    if (row.status === 'closed') row.closedAt ??= new Date().toISOString();
    this.db.prepare('UPDATE sessions SET status=?,row=? WHERE session_id=?').run(row.status, JSON.stringify(row), ref.sessionId);
  }
  apply(ref: ContractSessionRef, event: ContractEvent, eventId: string = randomUUID(), expectedRevision?: number): ContractTransition {
    return this.transaction(() => this.applyInside(ref, event, eventId, expectedRevision));
  }
  private applyInside(ref: ContractSessionRef, event: ContractEvent, eventId: string, expectedRevision?: number): ContractTransition {
    const session = this.read(ref); if (!session) throw new Error('contract_session_missing');
    const seen = this.db.prepare('SELECT value FROM events WHERE session_key=? AND event_id=?').get(sessionKey(ref), eventId) as { value: string } | undefined;
    const json = JSON.stringify(event);
    if (seen) {
      if (seen.value !== json && seen.value !== eventRecord(event, json)) throw new Error('contract_event_conflict');
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
      this.projectSession(ref, result.session);
    }
    // Observation sequences are already watermarked; an unchanged readiness
    // sample needs no dedup record.
    if (!changed && (event.type === 'runtime_busy' || event.type === 'runtime_ready')) return result;
    this.db.prepare('INSERT INTO events(session_key,event_id,type,decision,value,revision) VALUES(?,?,?,?,?,?)').run(sessionKey(ref), eventId, event.type, result.decision, eventRecord(event, json), result.session.revision);
    this.rememberEpoch(ref, result.session.runtimeEpoch);
    const writes = (this.writesSincePrune.get(sessionKey(ref)) ?? 0) + 1;
    this.writesSincePrune.set(sessionKey(ref), writes % retention.interval);
    if (writes >= retention.interval) this.prune(ref);
    return result;
  }
  /** Bounded history: recent dedup records, recent settled attempts and their
   * result facts. Recovery records and unsettled work are retained. */
  prune(ref: ContractSessionRef): void {
    this.transaction(() => {
      const key = sessionKey(ref); const structural = structuralEvents.map(type => `'${type}'`).join(',');
      this.db.prepare(`DELETE FROM events WHERE session_key=? AND type NOT IN (${structural}) AND rowid NOT IN (SELECT rowid FROM events WHERE session_key=? AND type NOT IN (${structural}) ORDER BY rowid DESC LIMIT ?)`)
        .run(key, key, retention.events);
      const older = (kind: string, keep: number, phases: string[]) => this.db.prepare(`DELETE FROM entities WHERE session_key=? AND kind=? AND phase IN (${phases.map(() => '?').join(',')}) AND rowid NOT IN (SELECT rowid FROM entities WHERE session_key=? AND kind=? ORDER BY rowid DESC LIMIT ?)`)
        .run(key, kind, ...phases, key, kind, keep);
      older('execution', retention.executions, ['succeeded', 'failed', 'cancelled']);
      older('continuation_failure_delivery', retention.executions, ['delivered']);
      older('operation', retention.operations, ['confirmed', 'failed_before_effect', 'rejected']);
      this.db.prepare(`DELETE FROM entities WHERE session_key=? AND kind='execution_observer'
        AND NOT EXISTS (SELECT 1 FROM entities x WHERE x.session_key=entities.session_key AND x.kind='execution'
          AND x.id=json_extract(entities.value,'$.execution.executionId'))`).run(key);
      // A turn whose attempt is still unsettled may yet deliver its result.
      for (const kind of ['result_binding', 'result_delivery', 'result_revision']) {
        this.db.prepare(`DELETE FROM entities WHERE session_key=? AND kind=? AND rowid NOT IN (SELECT rowid FROM entities WHERE session_key=? AND kind=? ORDER BY rowid DESC LIMIT ?)
          AND NOT EXISTS (SELECT 1 FROM entities x WHERE x.session_key=entities.session_key AND x.kind='execution' AND x.phase NOT IN ('succeeded','failed','cancelled')
            AND json_extract(x.value,'$.ref.turnId')=json_extract(entities.id,'$[0]'))`).run(key, kind, key, kind, retention.results);
      }
    });
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
  /** Freeze the one ordinary execution before its replacement is bound. A
   * runtime reservation alone never authorizes another execution submission. */
  planExecutionContinuation(ref: ContractSessionRef, bindingId: string, target: RuntimeRef,
    worker: WorkerRef, request: RuntimeExecutionContinuation): void {
    this.transaction(() => {
      const prior = this.entity<PlannedExecutionContinuation>(ref, 'execution_continuation', bindingId);
      if (prior) {
        if (!sameWorker(prior.worker, worker) || !sameRuntime(prior.target, target)
          || !sameRuntime(prior.from, request.from) || !sameExecution(prior.execution, request.execution)
          || prior.nativeSessionId !== request.nativeSessionId) throw new Error('execution_continuation_conflict');
        return;
      }
      const state = this.read(ref);
      const source = request.from && this.runtime(ref, request.from.runtimeId);
      const proposed = this.runtime(ref, target.runtimeId);
      const execution = request.execution && this.execution(ref, request.execution.executionId);
      const belongsHere = (value: ExecutionContract): boolean => sameRuntime(value.runtime, request.from)
        || (!!value.runtime && this.continuedExecution(ref, value.runtime, worker, value.ref));
      const running = this.executions(ref).filter(value => belongsHere(value)
        && !terminalPhase(value.phase) && value.phase !== 'queued');
      if (request.reason !== 'traex-auto-model' || !request.nativeSessionId
        || request.execution?.dispatchAttempt !== undefined
        || !state || state.lifecycle !== 'active' || state.activeOperationId || !sameWorker(state.worker, worker)
        || !sameRuntime(state.activeRuntime, request.from) || !source || !sameWorker(source.worker, worker)
        || source.identity?.proof !== 'process_start' || source.identity.nativeSessionId !== request.nativeSessionId
        || !proposed || !sameRuntime(proposed.ref, target) || proposed.phase !== 'starting'
        || !sameWorker(proposed.worker, worker) || target.epoch <= source.ref.epoch
        || !execution || !sameExecution(execution.ref, request.execution) || !execution.runtime || !belongsHere(execution)
        || !['submitting', 'accepted', 'running'].includes(execution.phase) || execution.cancelRequested || execution.terminal
        || running.length !== 1 || !sameExecution(running[0]!.ref, request.execution)) {
        throw new Error('execution_continuation_unproven');
      }
      this.saveExecutionContinuation(ref, bindingId, {
        ...structuredClone(request), target, executionRuntime: execution.runtime, worker, status: 'planned',
      } satisfies PlannedExecutionContinuation);
    });
  }
  /** Commit only after the new process proves the exact native conversation.
   * Its old execution identity is retained, but old-runtime events cannot
   * mutate the newly bound attempt. Retries never reset an approved attempt. */
  commitExecutionContinuation(ref: ContractSessionRef, bindingId: string, worker: WorkerRef): void {
    this.transaction(() => {
      const plan = this.entity<PlannedExecutionContinuation>(ref, 'execution_continuation', bindingId);
      if (!plan || plan.status !== 'planned') return;
      const state = this.read(ref);
      const target = this.binding(ref, bindingId);
      const source = this.runtime(ref, plan.from.runtimeId);
      const execution = this.execution(ref, plan.execution.executionId);
      const reject = (): void => this.saveExecutionContinuation(ref, bindingId, { ...plan, status: 'rejected' });
      if (!state || state.lifecycle !== 'active' || state.activeOperationId || !sameWorker(state.worker, worker)
        || !sameWorker(plan.worker, worker) || !target || !sameRuntime(target.ref, plan.target)
        || !sameRuntime(state.activeRuntime, target.ref) || !sameWorker(target.worker, worker)
        || !['starting', 'ready'].includes(target.phase) || !source || !sameWorker(source.worker, worker)
        || !execution || !sameExecution(execution.ref, plan.execution) || !sameRuntime(execution.runtime, plan.executionRuntime)
        || !['submitting', 'accepted', 'running'].includes(execution.phase) || execution.cancelRequested || execution.terminal) { reject(); return; }
      // PID/native identity may be learned after the first registration. Keep
      // the intent and the worker's pending input until that proof arrives.
      if (!target.identity || target.identity.proof === 'opaque' || !target.identity.nativeSessionId) return;
      if (target.identity.proof !== 'process_start' || target.identity.backend !== source.identity?.backend
        || target.identity.physicalId === source.identity?.physicalId
        || target.identity.nativeSessionId !== plan.nativeSessionId) { reject(); return; }
      const result = this.applyInside(ref, { type: 'execution_continued', execution: execution.ref,
        from: plan.executionRuntime, runtime: target.ref }, `continuation:${bindingId}`);
      if (result.decision !== 'applied') { reject(); return; }
      this.saveExecutionContinuation(ref, bindingId, { ...plan, status: 'approved' });
    });
  }
  /** A launcher/native-id enrichment keeps the physical CLI. Preserve an
   * unconsumed permit without granting it to a different native conversation. */
  inheritExecutionContinuation(ref: ContractSessionRef, fromBindingId: string, bindingId: string, worker: WorkerRef): void {
    const plan = this.entity<PlannedExecutionContinuation>(ref, 'execution_continuation', fromBindingId);
    const target = this.binding(ref, bindingId);
    if (!plan || plan.status === 'rejected' || !target || !sameWorker(plan.worker, worker)
      || this.entity(ref, 'execution_continuation', bindingId)) return;
    const execution = this.execution(ref, plan.execution.executionId);
    if (plan.status === 'approved' && (plan.consumed || execution?.phase !== 'accepted')) return;
    const rejected = target.identity?.nativeSessionId !== plan.nativeSessionId || !!execution?.terminal || !!execution?.cancelRequested;
    this.saveExecutionContinuation(ref, bindingId, {
      ...plan, ...(plan.status === 'planned' ? { target: target.ref } : {}), status: rejected ? 'rejected' : plan.status,
    });
  }
  rejectExecutionContinuation(ref: ContractSessionRef, bindingId: string): void {
    this.transaction(() => {
      const plan = this.entity<PlannedExecutionContinuation>(ref, 'execution_continuation', bindingId);
      const execution = plan && this.execution(ref, plan.execution.executionId);
      if (!plan || plan.status === 'rejected' || (plan.status === 'approved' && execution?.phase !== 'accepted' && !execution?.terminal)) return;
      this.saveExecutionContinuation(ref, bindingId, { ...plan, status: 'rejected' });
    });
  }
  consumeExecutionContinuation(ref: ContractSessionRef, worker: WorkerRef, execution: ExecutionRef, runtime: RuntimeRef): void {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT id,value FROM entities WHERE session_key=? AND kind='execution_continuation' AND phase='approved' AND json_extract(value,'$.execution.executionId')=?")
        .all(sessionKey(ref), execution.executionId) as Array<{ id: string; value: string }>;
      for (const row of rows) {
        const plan = JSON.parse(row.value) as PlannedExecutionContinuation;
        if (plan.consumed || !sameWorker(plan.worker, worker) || !sameExecution(plan.execution, execution)
          || !sameRuntime(plan.target, runtime)) continue;
        this.saveExecutionContinuation(ref, row.id, { ...plan, consumed: true });
      }
    });
  }
  executionContinuationFailureRuntime(ref: ContractSessionRef, worker: WorkerRef,
    failure: RuntimeExecutionContinuationFailure, origin: RuntimeRef, errorCode: string): RuntimeRef | undefined {
    const request = failure?.continuation;
    if (typeof failure?.bindingId !== 'string' || !failure.bindingId || request?.reason !== 'traex-auto-model'
      || !request.execution?.executionId || request.execution.dispatchAttempt !== undefined || !request.from?.runtimeId) return;
    const state = this.read(ref);
    const source = this.runtime(ref, request.from.runtimeId);
    const execution = this.execution(ref, request.execution.executionId);
    if (!sameWorker(state?.worker, worker) || !source || !sameWorker(source.worker, worker)
      || !sameRuntime(source.ref, request.from) || source.identity?.proof !== 'process_start'
      || !request.nativeSessionId || source.identity.nativeSessionId !== request.nativeSessionId
      || !execution?.runtime || !sameExecution(execution.ref, request.execution)
      || !this.authorizedProducer(ref, origin, worker)
      || (execution.terminal && (execution.phase !== 'failed' || execution.terminal.errorCode !== errorCode))) return;
    const plan = this.entity<PlannedExecutionContinuation>(ref, 'execution_continuation', failure.bindingId);
    if (plan) {
      if (plan.consumed || !this.bindingProducer(ref, failure.bindingId, worker) || !sameWorker(plan.worker, worker)
        || !sameRuntime(plan.from, request.from) || !sameExecution(plan.execution, request.execution)
        || plan.nativeSessionId !== request.nativeSessionId || !sameRuntime(origin, plan.executionRuntime)) return;
      if (!sameRuntime(execution.runtime, plan.executionRuntime)
        && (!sameRuntime(execution.runtime, plan.target)
          || (!execution.terminal && (plan.status !== 'approved' || execution.phase !== 'accepted')))) return;
    } else if (this.binding(ref, failure.bindingId) || !sameRuntime(execution.runtime, origin)
      || (!sameRuntime(origin, request.from) && !this.continuedExecution(ref, origin, worker, execution.ref))) return;
    return execution.runtime;
  }
  continuationFailureDelivered(ref: ContractSessionRef, execution: ExecutionRef, errorCode: string): boolean {
    const receipt = this.entity<{ execution: ExecutionRef; errorCode: string }>(ref, 'continuation_failure_delivery', execution.executionId);
    return !!receipt && sameExecution(receipt.execution, execution) && receipt.errorCode === errorCode;
  }
  confirmContinuationFailureDelivery(ref: ContractSessionRef, execution: ExecutionRef, errorCode: string): void {
    const current = this.execution(ref, execution.executionId);
    if (!sameExecution(current?.ref, execution) || current?.terminal?.status !== 'failed' || current.terminal.errorCode !== errorCode) {
      throw new Error('execution_continuation_failure_unproven');
    }
    this.saveVersionedEntity(ref, 'continuation_failure_delivery', execution.executionId, 'delivered', { execution, errorCode });
  }
  executionContinuation(ref: ContractSessionRef, bindingId: string): RuntimeExecutionContinuationResult | undefined {
    const plan = this.entity<PlannedExecutionContinuation>(ref, 'execution_continuation', bindingId);
    if (!plan || plan.status === 'planned') return;
    const execution = this.execution(ref, plan.execution.executionId);
    const rejected = !execution || !!execution.terminal || execution.cancelRequested
      || ['reconciling', 'blocked', 'waiting_input'].includes(execution.phase);
    return { execution: plan.execution, status: rejected ? 'rejected' : plan.status };
  }
  reserveRuntime(ref: ContractSessionRef, worker: WorkerRef, bindingId?: string): RuntimeRef {
    return this.transaction(() => {
      const bound = bindingId ? this.binding(ref, bindingId) : undefined;
      if (bound) return bound.ref;
      const state = this.read(ref); if (!state) throw new Error('contract_session_missing');
      const epoch = Math.max(state.runtimeEpoch, this.epochFloors.get(sessionKey(ref)) ?? 0) + 1;
      const runtime: RuntimeContract = { ref: { runtimeId: randomUUID(), epoch }, worker, phase: 'starting', promptReady: false, promptReadySequence: 0 };
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
      if (!reserved.identity && ['stopped', 'retiring'].includes(reserved.phase)) throw new Error('runtime_reservation_abandoned');
      if (reserved.identity && reusableRuntimeIdentity(reserved.identity, identity) && reserved.worker.workerId === worker.workerId) return reserved;
      if (reserved.identity && reserved.worker.workerId === worker.workerId && reserved.identity.proof !== 'opaque') {
        const old = reserved.identity;
        if (old.backend !== identity.backend || old.physicalId !== identity.physicalId || old.proof !== identity.proof
          || (old.nativeSessionId !== undefined && old.nativeSessionId !== identity.nativeSessionId)
          || (old.nativeGeneration !== undefined && old.nativeGeneration !== identity.nativeGeneration)) throw new Error('runtime_identity_changed');
      }
      const enriching = !!reserved.identity && reserved.worker.workerId === worker.workerId;
      let reuse = previous && !['retiring', 'stopped'].includes(previous.phase) && reusableRuntimeIdentity(previous.identity, identity) ? previous : undefined;
      if (!reuse && !reserved.identity && identity.proof === 'process_start' && identity.nativeSessionId
        && previous?.identity && previous.identity.nativeSessionId === undefined
        && samePhysicalRuntimeIdentity(previous.identity, identity)) {
        // Repair an unbound/bare intermediate observation only on a NEW binding.
        // Proven transitions or outstanding work in that interval prevent reuse.
        const history = (this.db.prepare("SELECT value FROM entities WHERE session_key=? AND kind='runtime'").all(sessionKey(ref)) as Array<{ value: string }>).map(row => JSON.parse(row.value) as RuntimeContract);
        const executions = this.executions(ref);
        if (executions.some(execution => !terminalPhase(execution.phase) && sameRuntime(execution.runtime, previous.ref))) {
          // Work still open on the selected bare observation keeps the older
          // runtime out of reach. The complete identity is that same live
          // process, so it completes the selected runtime: refusing the binding
          // would leave a re-attached worker, and that work, with no runtime.
          if (['retiring', 'stopped'].includes(previous.phase)) throw new Error('runtime_recovery_has_active_execution');
          reuse = previous;
        }
        const records = (this.db.prepare("SELECT value FROM events WHERE session_key=? AND type IN ('runtime_bound','runtime_reserved')").all(sessionKey(ref)) as Array<{ value: string }>).map(row => JSON.parse(row.value) as Extract<ContractEvent, { type: 'runtime_bound' | 'runtime_reserved' }>);
        const candidates = reuse ? [] : history.filter(runtime => runtime.phase === 'unresolved'
          && runtime.ref.epoch < previous.ref.epoch && reusableRuntimeIdentity(runtime.identity, identity));
        if (candidates.length === 1) {
          const candidate = candidates[0];
          const interval = history.filter(runtime => runtime.ref.epoch > candidate.ref.epoch
            && runtime.ref.epoch < proposed.epoch);
          const proven = records.filter(event => event.type === 'runtime_bound').map(event => event.runtime)
            .filter(runtime => runtime.ref.epoch > candidate.ref.epoch && runtime.ref.epoch < proposed.epoch);
          const uncertainOnly = [...interval, ...proven].every(runtime => !runtime.identity || (samePhysicalRuntimeIdentity(runtime.identity, identity)
            && runtime.identity.nativeSessionId === undefined && runtime.identity.nativeGeneration === undefined));
          const outstanding = executions.some(execution => !terminalPhase(execution.phase)
            && interval.some(runtime => sameRuntime(runtime.ref, execution.runtime)));
          if (outstanding) throw new Error('runtime_recovery_has_active_execution');
          const candidateProofs = records.filter(event => event.type === 'runtime_bound' && sameRuntime(event.runtime.ref, candidate.ref));
          const complete = interval.length === proposed.epoch - candidate.ref.epoch - 1
            && new Set(interval.map(runtime => runtime.ref.epoch)).size === interval.length
            && interval.every(runtime => Number.isSafeInteger(runtime.ref.epoch)
              && records.some(event => event.type === 'runtime_reserved' && sameRuntime(event.runtime.ref, runtime.ref)))
            && candidateProofs.some(event => reusableRuntimeIdentity(event.runtime.identity, identity))
            && candidateProofs.every(event => !event.runtime.identity || event.runtime.identity.proof === 'opaque'
              || (samePhysicalRuntimeIdentity(event.runtime.identity, identity)
                && (event.runtime.identity.nativeSessionId === undefined || event.runtime.identity.nativeSessionId === identity.nativeSessionId)
                && (event.runtime.identity.nativeGeneration === undefined || event.runtime.identity.nativeGeneration === identity.nativeGeneration)));
          if (uncertainOnly && complete) reuse = candidate;
        }
      }
      const runtime: RuntimeContract = { ...(reuse ?? reserved), worker, identity,
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
  discardDeferred(ref: ContractSessionRef, bindingId: string): void {
    this.db.prepare('DELETE FROM deferred_events WHERE session_key=? AND binding_id=?').run(sessionKey(ref), bindingId);
  }
  acknowledgeDeferred(ref: ContractSessionRef, eventId: string, rejectedMessage?: unknown): void {
    if (rejectedMessage !== undefined) {
      this.db.prepare('DELETE FROM deferred_events WHERE session_key=? AND event_id=? AND value=?').run(sessionKey(ref), eventId, JSON.stringify(rejectedMessage));
    } else this.db.prepare('DELETE FROM deferred_events WHERE session_key=? AND event_id=?').run(sessionKey(ref), eventId);
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
  authorizeExecutionObserver(ref: ContractSessionRef, worker: WorkerRef, execution: ExecutionRef): boolean {
    return this.transaction(() => {
      const state = this.read(ref); const current = this.runtime(ref);
      const attempt = this.execution(ref, execution.executionId);
      const source = attempt?.runtime && this.runtime(ref, attempt.runtime.runtimeId);
      if (!state || state.lifecycle !== 'active' || state.activeOperationId || !sameWorker(state.worker, worker)
          || !current || !sameWorker(current.worker, worker) || !['starting', 'ready'].includes(current.phase)
          || !sameExecution(attempt?.ref, execution) || attempt?.phase !== 'reconciling'
          || !source || !sameRuntime(attempt.runtime, source.ref) || source.phase !== 'unresolved' || sameRuntime(source.ref, current.ref)
          || !current.identity?.nativeSessionId || !reusableRuntimeIdentity(source.identity, current.identity)) return false;
      if (this.authorizedExecutionObserver(ref, source.ref, worker, execution)) return true;
      this.saveEntity(ref, 'execution_observer', JSON.stringify([worker.workerId, worker.generation, execution.executionId]),
        'authorized', { worker, execution, runtime: source.ref });
      // Observer grants are part of the revision-gated primary snapshot.
      const updated = { ...state, revision: state.revision + 1 };
      this.db.prepare('UPDATE contracts SET revision=?,value=? WHERE session_key=? AND revision=?')
        .run(updated.revision, JSON.stringify(updated), sessionKey(ref), state.revision);
      this.projectSession(ref, updated);
      return true;
    });
  }
  authorizedExecutionObserver(ref: ContractSessionRef, runtime: RuntimeRef, worker: WorkerRef, execution?: ExecutionRef): boolean {
    if (!execution) return false;
    const value = this.entity<{ worker: WorkerRef; execution: ExecutionRef; runtime: RuntimeRef }>(ref,
      'execution_observer', JSON.stringify([worker.workerId, worker.generation, execution.executionId]));
    return !!value && sameWorker(value.worker, worker) && sameExecution(value.execution, execution)
      && sameRuntime(value.runtime, runtime) && sameRuntime(this.execution(ref, execution.executionId)?.runtime, runtime);
  }
  /** The live CLI of `from` became `to` without restarting. Attempts already
   * bound to `from` keep running in that process and stay on their runtime. */
  continueRuntime(ref: ContractSessionRef, from: RuntimeRef, to: RuntimeRef, worker: WorkerRef): void {
    this.saveEntity(ref, 'runtime_continuation', from.runtimeId, 'active', { from, to, worker });
  }
  /** Runtimes the live CLI of `from` became through `worker`'s in-process continuations, in order. */
  continuedRuntimes(ref: ContractSessionRef, from: RuntimeRef, worker: WorkerRef): RuntimeRef[] {
    const chain: RuntimeRef[] = [];
    let current = from;
    for (let hops = 0; hops < 16; hops++) {
      const link = this.entity<{ from: RuntimeRef; to: RuntimeRef; worker: WorkerRef }>(ref, 'runtime_continuation', current.runtimeId);
      if (!link || !sameRuntime(link.from, current) || !sameWorker(link.worker, worker)) break;
      chain.push(link.to); current = link.to;
    }
    return chain;
  }
  /** `from` is `to`, or became it through `worker`'s in-process continuations. */
  runtimeContinues(ref: ContractSessionRef, from: RuntimeRef, to: RuntimeRef, worker: WorkerRef): boolean {
    return sameRuntime(from, to) || this.continuedRuntimes(ref, from, worker).some(runtime => sameRuntime(runtime, to));
  }
  /** An attempt bound to a runtime its own worker continued into the active one. */
  continuedExecution(ref: ContractSessionRef, runtime: RuntimeRef, worker: WorkerRef, execution?: ExecutionRef): boolean {
    const active = this.read(ref)?.activeRuntime;
    const attempt = execution ? this.execution(ref, execution.executionId) : undefined;
    if (!active || !attempt || !sameExecution(attempt.ref, execution) || !sameRuntime(attempt.runtime, runtime)) return false;
    return !sameRuntime(runtime, active) && this.runtimeContinues(ref, runtime, active, worker);
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
      const supersedes = !!active && canSupersedeControlOperation(active, kind);
      if (active && !supersedes) {
        if (active.kind !== kind || (options.execution && active.targetExecution?.executionId !== options.execution.executionId)) throw new Error('control_operation_in_progress');
        return { operation: active, joined: true };
      }
      if (active?.kind === 'close' && kind === 'close') return { operation: active, joined: true };
      const operation: ControlOperation = { operationId: options.operationId ?? randomUUID(), kind, phase: 'planned', targetRuntime: options.runtime ?? session.activeRuntime, targetExecution: options.execution, proposedRuntime: options.proposedRuntime, expectedRevision: session.revision, previousLifecycle: supersedes && kind === 'restart' ? active!.previousLifecycle ?? 'active' : session.lifecycle };
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
  const previous = stores.get(key);
  if (previous?.isCurrentDatabase()) return previous;
  const floors = previous?.knownEpochFloors();
  previous?.close();
  const store = new SessionContractStore(dataDir, appId);
  try {
    if (floors) store.retainEpochFloors(floors);
  } catch (error) {
    try { store.close(); } catch { /* preserve the failed refresh cause */ }
    // Keep the closed predecessor's allocator knowledge for the next retry.
    throw error;
  }
  stores.set(key, store);
  return store;
}
