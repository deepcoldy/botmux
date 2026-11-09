import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';
import { mergeOutputReplay, validateOutputSnapshot, isOutputJournalAppId, type OutputSnapshot } from './universal-output-handoff.js';
import type { FrozenSessionReplyContext } from '../types.js';

export type OutputSink =
  | { kind: 'im'; context: FrozenSessionReplyContext; chatId: string; chatType: 'group' | 'p2p'; privateReply?: boolean }
  | { kind: 'http'; mode: 'wait' | 'async' }
  | { kind: 'doc'; context: Record<string, unknown> }
  | { kind: 'managed' }
  | { kind: 'suppressed'; reason: string };

export interface OutputProviderEffectHooks {
  beforeProviderEffect(): void;
  providerRequestStarted(): void;
  providerRequestNotDelivered(): void;
}

export interface OutputReceipt {
  status: 'delivered' | 'captured' | 'suppressed' | 'delegated';
  messageId?: string;
  owner?: string;
}
export interface OutputDeliveryRecord extends OutputSnapshot {
  sink: OutputSink;
  /** rejected = terminal: the frozen destination structurally cannot accept
   *  this output (original chat/type/private-reply policy changed, HTTP owner
   *  gone). Never retried or re-settled; retained for human inspection. */
  state: 'pending' | 'processing' | 'settled' | 'blocked' | 'rejected';
  receipt?: OutputReceipt;
  reason?: string;
}

/** All output adapters retain their native authorization and settlement.
 * This journal records the shared recovery owner and frozen destination. */
export class OutputDeliveryJournal {
  private readonly db: DatabaseSyncLike;
  private readonly scanCursors = new Map<string, { after: { createdAt: number; id: string }; upperRowId: number }>();
  readonly filename: string;
  constructor(dataDir: string, readonly appId: string) {
    if (!isOutputJournalAppId(appId)) throw new Error('invalid_output_app');
    const directory = join(dataDir, 'output-delivery-journals');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filename = join(directory, `${appId}.db`);
    if (lstatSync(directory).isSymbolicLink() || (existsSync(this.filename) && lstatSync(this.filename).isSymbolicLink())) throw new Error('unsafe_output_delivery_journal');
    this.db = openDatabaseSyncOrThrow(this.filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS outputs(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        value TEXT NOT NULL, state TEXT NOT NULL, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ); CREATE INDEX IF NOT EXISTS outputs_pending ON outputs(state,lease_until);
      CREATE INDEX IF NOT EXISTS outputs_turn ON outputs(session_id,turn_id);
      CREATE TABLE IF NOT EXISTS output_sinks(session_id TEXT NOT NULL,turn_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(session_id,turn_id));
      CREATE TABLE IF NOT EXISTS output_transports(output_id TEXT NOT NULL,transport_key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(output_id,transport_key));
      CREATE TABLE IF NOT EXISTS output_effects(output_id TEXT NOT NULL,effect_key TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,PRIMARY KEY(output_id,effect_key));`);
    chmodSync(this.filename, 0o600);
  }
  close(): void { this.db.close(); }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  read(id: string): OutputDeliveryRecord | undefined {
    const row = this.db.prepare('SELECT value,state FROM outputs WHERE id=?').get(id) as { value: string; state: OutputDeliveryRecord['state'] } | undefined;
    if (!row) return undefined;
    const record = JSON.parse(row.value) as OutputDeliveryRecord;
    validateOutputSnapshot(this.appId, record);
    if (record.id !== id) throw new Error('output_delivery_identity_mismatch');
    return { ...record, state: row.state };
  }
  accept(snapshot: OutputSnapshot, sink: OutputSink): OutputDeliveryRecord {
    const value = validateOutputSnapshot(this.appId, snapshot);
    return this.transaction(() => {
      const previous = this.read(value.id);
      if (previous) {
        if (previous.fingerprint !== value.fingerprint) throw new Error('output_delivery_payload_conflict');
        if (value.output.codexAppSettlement && previous.output.codexAppSettlement) {
          previous.output = mergeOutputReplay(previous, value).output;
          this.db.prepare('UPDATE outputs SET value=?,updated_at=? WHERE id=?').run(JSON.stringify(previous), Date.now(), previous.id);
        }
        return previous;
      }
      const record: OutputDeliveryRecord = { ...value, sink: structuredClone(sink), state: 'pending' };
      this.db.prepare('INSERT INTO outputs(id,session_id,turn_id,value,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(record.id, record.output.sessionId, record.output.turnId, JSON.stringify(record), record.state, value.createdAt, Date.now());
      return record;
    });
  }
  claim(id: string, owner: string, now = Date.now(), leaseMs = 60_000): boolean {
    return Number(this.db.prepare("UPDATE outputs SET state='processing',owner=?,lease_until=?,updated_at=? WHERE id=? AND state!='settled' AND state!='rejected' AND lease_until<=?")
      .run(owner, now + leaseMs, now, id, now).changes) === 1;
  }
  newOwner(): string { return randomUUID(); }
  renew(id: string, owner: string, now = Date.now()): boolean {
    return Number(this.db.prepare("UPDATE outputs SET lease_until=? WHERE id=? AND owner=? AND state='processing' AND lease_until>?")
      .run(now + 60_000, id, owner, now).changes) === 1;
  }
  owns(id: string, owner: string, now = Date.now()): boolean {
    return !!this.db.prepare("SELECT id FROM outputs WHERE id=? AND owner=? AND lease_until>? AND state='processing'").get(id, owner, now);
  }
  complete(id: string, owner: string, receipt: OutputReceipt): boolean {
    return this.transaction(() => {
      const record = this.read(id);
      if (!record || !this.owns(id, owner)) return false;
      record.receipt = receipt;
      return Number(this.db.prepare("UPDATE outputs SET value=?,state='settled',owner=NULL,lease_until=0,updated_at=? WHERE id=? AND owner=?")
        .run(JSON.stringify(record), Date.now(), id, owner).changes) === 1;
    });
  }
  block(id: string, owner: string, reason: string): void {
    this.transaction(() => {
      const record = this.read(id);
      if (!record) return;
      record.reason = reason.slice(0, 256);
      this.db.prepare("UPDATE outputs SET value=?,state='blocked',owner=NULL,lease_until=?,updated_at=? WHERE id=? AND owner=?")
        .run(JSON.stringify(record), Date.now() + 5_000, Date.now(), id, owner);
    });
  }
  /** Terminal rejection for a frozen destination that can NEVER accept the
   *  output (original channel/policy changed, HTTP owner gone). The row leaves
   *  the retry loop permanently and is retained as human-inspection evidence;
   *  the worker copy is never ACKed. Only the live processing owner can file
   *  it, so a stale/late owner cannot terminalise a row a newer owner holds. */
  rejectTerminal(id: string, owner: string, reason: string): boolean {
    return this.transaction(() => {
      const record = this.read(id);
      if (!record || record.state === 'settled' || record.state === 'rejected') return false;
      record.reason = reason.slice(0, 256);
      return Number(this.db.prepare("UPDATE outputs SET value=?,state='rejected',owner=NULL,lease_until=0,updated_at=? WHERE id=? AND owner=?")
        .run(JSON.stringify(record), Date.now(), id, owner).changes) === 1;
    });
  }
  pending(sessionId?: string): OutputDeliveryRecord[] {
    const key = sessionId ?? '';
    const scope = sessionId ?? null;
    const captureUpper = (): number | undefined => {
      const row = this.db.prepare("SELECT MAX(rowid) AS upper FROM outputs WHERE state!='settled' AND state!='rejected' AND (? IS NULL OR session_id=?)").get(scope, scope) as { upper: number | null };
      return row.upper === null ? undefined : Number(row.upper);
    };
    const select = (upper: number, after?: { createdAt: number; id: string }) => this.db.prepare(
      "SELECT id,created_at FROM outputs WHERE state!='settled' AND state!='rejected' AND lease_until<=? AND (? IS NULL OR session_id=?) AND rowid<=? AND (? IS NULL OR created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 128",
    ).all(Date.now(), scope, scope, upper, after?.createdAt ?? null, after?.createdAt ?? null, after?.createdAt ?? null, after?.id ?? null) as Array<{ id: string; created_at: number }>;
    const cursor = this.scanCursors.get(key);
    let upper = cursor?.upperRowId ?? captureUpper();
    let rows = upper === undefined ? [] : select(upper, cursor?.after);
    if (!rows.length && cursor) {
      upper = captureUpper();
      rows = upper === undefined ? [] : select(upper);
    }
    const last = rows.at(-1);
    if (last && upper !== undefined) this.scanCursors.set(key, { after: { createdAt: last.created_at, id: last.id }, upperRowId: upper });
    else this.scanCursors.delete(key);
    // A fixed insertion watermark bounds each round, even when new output
    // arrives with an older timestamp. Expired leases are revisited on wrap.
    return rows.map(row => this.read(row.id)!);
  }
  rememberSink(sessionId: string, turnId: string, sink: OutputSink): void {
    this.transaction(() => {
    if (sink.kind !== 'im' && this.sink(sessionId, turnId)?.kind === 'im') this.db.prepare("DELETE FROM output_sinks WHERE session_id=? AND turn_id=? AND NOT EXISTS(SELECT 1 FROM outputs WHERE session_id=? AND turn_id=?)").run(sessionId, turnId, sessionId, turnId);
    this.db.prepare('INSERT OR IGNORE INTO output_sinks(session_id,turn_id,value) VALUES(?,?,?)').run(sessionId, turnId, JSON.stringify(sink));
    });
  }
  sink(sessionId: string, turnId: string): OutputSink | undefined {
    const row = this.db.prepare('SELECT value FROM output_sinks WHERE session_id=? AND turn_id=?').get(sessionId, turnId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  freezeTransport(id: string, owner: string, key: string, proposed: { content: string; msgType: string; providerUuid: string }): typeof proposed {
    return this.transaction(() => {
      if (!this.owns(id, owner)) throw new Error('output_transport_authority_changed');
      const row = this.db.prepare('SELECT value FROM output_transports WHERE output_id=? AND transport_key=?').get(id, key) as { value: string } | undefined;
      if (row) return JSON.parse(row.value);
      this.db.prepare('INSERT INTO output_transports(output_id,transport_key,value) VALUES(?,?,?)').run(id, key, JSON.stringify(proposed));
      return proposed;
    });
  }
  /** The adapter supplies exact provider boundaries. Token acquisition does
   * not start an effect; only a definite rejection clears its attempt marker. */
  async effect<T>(id: string, owner: string, key: string,
    dispatch: (hooks: OutputProviderEffectHooks) => Promise<T>, beforeEffect: () => void = () => {},
  ): Promise<T> {
    const assertAuthority = (): void => {
      beforeEffect();
      if (!this.owns(id, owner)) throw new Error('output_effect_authority_changed');
    };
    const previous = this.transaction(() => {
      assertAuthority();
      const row = this.db.prepare('SELECT state,receipt FROM output_effects WHERE output_id=? AND effect_key=?').get(id, key) as { state: string; receipt: string | null } | undefined;
      if (!row) return undefined;
      if (row.state !== 'delivered') throw new Error('output_effect_unknown');
      return { value: JSON.parse(row.receipt!) as T };
    });
    if (previous) return previous.value;
    let attempt: string | undefined;
    const receipt = await dispatch({
      beforeProviderEffect: assertAuthority,
      providerRequestStarted: () => {
        this.transaction(() => {
          assertAuthority();
          if (this.db.prepare('SELECT state FROM output_effects WHERE output_id=? AND effect_key=?').get(id, key)) throw new Error('output_effect_unknown');
          attempt = JSON.stringify({ attempt: randomUUID(), owner });
          this.db.prepare("INSERT INTO output_effects(output_id,effect_key,state,receipt) VALUES(?,?,'attempting',?)").run(id, key, attempt);
        });
      },
      providerRequestNotDelivered: () => {
        if (!attempt) return;
        // This HTTP response is evidence even if its lease has expired. The
        // exact token prevents an old response clearing a newer request.
        this.db.prepare("DELETE FROM output_effects WHERE output_id=? AND effect_key=? AND state='attempting' AND receipt=?").run(id, key, attempt);
        attempt = undefined;
      },
    });
    if (!attempt) throw new Error('output_effect_not_started');
    // Returned provider receipts survive cancellation/lease loss. Never
    // overwrite another invocation's receipt or an unrelated attempt.
    const saved = this.db.prepare("UPDATE output_effects SET state='delivered',receipt=? WHERE output_id=? AND effect_key=? AND state='attempting' AND receipt=?").run(JSON.stringify(receipt ?? null), id, key, attempt);
    if (Number(saved.changes) !== 1) throw new Error('output_effect_receipt_conflict');
    return receipt;
  }
  settled(sessionId: string, turnId: string): OutputDeliveryRecord[] {
    return (this.db.prepare("SELECT id FROM outputs WHERE session_id=? AND turn_id=? AND state='settled' ORDER BY created_at")
      .all(sessionId, turnId) as Array<{ id: string }>).map(row => this.read(row.id)!);
  }
  forTurn(sessionId: string, turnId: string): OutputDeliveryRecord[] {
    return (this.db.prepare('SELECT id FROM outputs WHERE session_id=? AND turn_id=? ORDER BY created_at,id').all(sessionId, turnId) as Array<{ id: string }>).map(row => this.read(row.id)!).filter(Boolean);
  }
  /** A still-self-healing row (pending/processing/blocked) for a session.
   *  Terminal `rejected` rows are NOT counted: their answer can never be
   *  delivered to the frozen target and they no longer churn recovery; they
   *  await a human resolve path and are reported separately. Does not advance
   *  the recovery scan watermark. */
  hasUnsettled(sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM outputs WHERE session_id=? AND state IN ('pending','processing','blocked') LIMIT 1").get(sessionId);
  }
  /** A terminal rejected row for a session — evidence of an answer that
   *  structurally cannot reach its frozen target, held for human inspection. */
  hasTerminalRejection(sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM outputs WHERE session_id=? AND state='rejected' LIMIT 1").get(sessionId);
  }
}

const journals = new Map<string, OutputDeliveryJournal>();
export function outputDeliveryJournal(dataDir: string, appId: string): OutputDeliveryJournal {
  const key = `${dataDir}:${appId}`;
  let journal = journals.get(key);
  if (!journal) { journal = new OutputDeliveryJournal(dataDir, appId); journals.set(key, journal); }
  return journal;
}
