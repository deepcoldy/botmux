import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';
import { validateFinalOutputSnapshot, type FinalOutputSnapshot } from './final-output-handoff.js';
import { isOutputJournalAppId } from './universal-output-handoff.js';
import type { FrozenSessionReplyTarget } from '../types.js';

export type FinalHandoffState = 'prepared' | 'attempting' | 'delivered' | 'suppressed' | 'cancelled' | 'ambiguous' | 'rejected';
export interface StoredFinalOutput extends FinalOutputSnapshot {
  appId: string;
  state: FinalHandoffState;
  target: FrozenSessionReplyTarget;
  actorOpenId: string;
  chatId?: string;
  chatType?: 'group' | 'p2p';
  createdAt: number;
  claim?: string;
  leaseUntil?: number;
  messageId?: string;
  reason?: string;
  transport?: { content: string; msgType: string; providerUuid: string };
  firstAttemptAt?: number;
}

export class FinalOutputHandoffStore {
  private readonly db: DatabaseSyncLike;
  static path(dataDir: string, appId: string): string {
    if (!isOutputJournalAppId(appId)) throw new Error('invalid_handoff_app');
    return join(dataDir, 'final-output-handoffs', `${appId}.db`);
  }
  static exists(dataDir: string, appId: string): boolean { return isOutputJournalAppId(appId) && existsSync(this.path(dataDir, appId)); }
  constructor(dataDir: string, readonly appId: string) {
    const path = FinalOutputHandoffStore.path(dataDir, appId);
    const directory = join(dataDir, 'final-output-handoffs');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink() || (existsSync(path) && lstatSync(path).isSymbolicLink())) {
      throw new Error('unsafe_final_output_store');
    }
    this.db = openDatabaseSyncOrThrow(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS final_outputs (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, value TEXT NOT NULL,
        state TEXT NOT NULL, claim TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ); CREATE INDEX IF NOT EXISTS final_outputs_pending ON final_outputs(state, lease_until);
      CREATE TABLE IF NOT EXISTS final_output_origins (
        session_id TEXT NOT NULL, turn_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id,turn_id)
      );`);
      chmodSync(path, 0o600);
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  read(id: string): StoredFinalOutput | undefined {
    const row = this.db.prepare('SELECT value, state, claim, lease_until FROM final_outputs WHERE id=?').get(id) as
      { value: string; state: FinalHandoffState; claim?: string; lease_until: number } | undefined;
    if (!row) return undefined;
    const record = JSON.parse(row.value) as StoredFinalOutput;
    validateFinalOutputSnapshot(this.appId, record);
    if (record.appId !== this.appId || record.intentId !== id) throw new Error('corrupt_final_output_record');
    return { ...record, state: row.state, claim: row.claim ?? undefined, leaseUntil: row.lease_until };
  }
  rememberOrigin(sessionId: string, turnId: string, target: FrozenSessionReplyTarget, actorOpenId: string, now = Date.now(), channel: { chatId?: string; chatType?: 'group' | 'p2p' } = {}): void {
    if (!actorOpenId.startsWith('ou_') || !turnId.startsWith('om_')) throw new Error('final_output_origin_invalid');
    const value = JSON.stringify({ target, actorOpenId, ...channel });
    this.transaction(() => {
      const prior = this.readOrigin(sessionId, turnId);
      if (prior && JSON.stringify(prior) !== value) throw new Error('final_output_origin_conflict');
      this.db.prepare('INSERT OR IGNORE INTO final_output_origins(session_id,turn_id,value,created_at) VALUES(?,?,?,?)').run(sessionId, turnId, value, now);
      this.db.prepare('DELETE FROM final_output_origins WHERE created_at<?').run(now - 30 * 24 * 60 * 60_000);
    });
  }
  readOrigin(sessionId: string, turnId: string): { target: FrozenSessionReplyTarget; actorOpenId: string; chatId?: string; chatType?: 'group' | 'p2p' } | undefined {
    const row = this.db.prepare('SELECT value FROM final_output_origins WHERE session_id=? AND turn_id=?').get(sessionId, turnId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  attentionPending(sessionId: string): StoredFinalOutput | undefined {
    const row = this.db.prepare("SELECT id FROM final_outputs WHERE state IN ('ambiguous','rejected') AND json_extract(value,'$.output.sessionId')=? ORDER BY created_at,id LIMIT 1")
      .get(sessionId) as { id: string } | undefined;
    return row ? this.read(row.id) : undefined;
  }
  accept(snapshot: FinalOutputSnapshot, target: FrozenSessionReplyTarget, actorOpenId: string, now = Date.now(), channel: { chatId?: string; chatType?: 'group' | 'p2p' } = {}): StoredFinalOutput {
    const verified = validateFinalOutputSnapshot(this.appId, snapshot);
    if (!actorOpenId.startsWith('ou_')) throw new Error('final_output_actor_unproven');
    return this.transaction(() => {
      const prior = this.read(verified.intentId);
      if (prior) {
        if (prior.fingerprint !== verified.fingerprint) throw new Error('final_output_handoff_conflict');
        return prior; // The first trusted target wins; retries cannot readdress.
      }
      const record: StoredFinalOutput = { ...verified, appId: this.appId, state: 'prepared', target: structuredClone(target), actorOpenId, ...channel, createdAt: now };
      this.db.prepare('INSERT INTO final_outputs(id,fingerprint,value,state,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(record.intentId, record.fingerprint, JSON.stringify(record), 'prepared', now, now);
      return record;
    });
  }
  pending(now = Date.now(), after?: { createdAt: number; intentId: string }): StoredFinalOutput[] {
    return (this.db.prepare("SELECT id FROM final_outputs WHERE state IN ('prepared','attempting') AND lease_until<=? AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 32")
      .all(now, after?.createdAt ?? -1, after?.createdAt ?? -1, after?.intentId ?? '') as Array<{ id: string }>).map(row => this.read(row.id)!);
  }
  claim(id: string, now = Date.now(), leaseMs = 60_000): StoredFinalOutput | undefined {
    const token = randomUUID();
    const result = this.db.prepare("UPDATE final_outputs SET claim=?,lease_until=?,updated_at=? WHERE id=? AND state IN ('prepared','attempting') AND lease_until<=?")
      .run(token, now + leaseMs, now, id, now);
    return Number(result.changes) === 1 ? this.read(id) : undefined;
  }
  renew(id: string, claim: string, now = Date.now(), leaseMs = 60_000): boolean {
    return Number(this.db.prepare("UPDATE final_outputs SET lease_until=?,updated_at=? WHERE id=? AND claim=? AND lease_until>? AND state IN ('prepared','attempting')")
      .run(now + leaseMs, now, id, claim, now).changes) === 1;
  }
  owns(id: string, claim: string, now = Date.now()): boolean {
    const row = this.read(id);
    return !!row && row.claim === claim && (row.leaseUntil ?? 0) > now && ['prepared', 'attempting'].includes(row.state);
  }
  freezeTransport(id: string, claim: string, proposed: NonNullable<StoredFinalOutput['transport']>, now = Date.now()): NonNullable<StoredFinalOutput['transport']> {
    return this.transaction(() => {
      if (!this.owns(id, claim, now)) throw new Error('final_output_attempt_stale');
      const record = this.read(id)!;
      if (record.transport) return record.transport;
      record.transport = { ...proposed };
      this.db.prepare('UPDATE final_outputs SET value=? WHERE id=? AND claim=?').run(JSON.stringify(record), id, claim);
      return record.transport;
    });
  }
  attempting(id: string, claim: string, now = Date.now()): void {
    this.transaction(() => {
      if (!this.owns(id, claim, now)) throw new Error('final_output_attempt_stale');
      const record = this.read(id)!;
      record.firstAttemptAt ??= now;
      this.db.prepare("UPDATE final_outputs SET value=?,state='attempting',updated_at=? WHERE id=? AND claim=?")
        .run(JSON.stringify(record), now, id, claim);
    });
  }
  release(id: string, claim: string, visibleAt: number): void {
    this.db.prepare("UPDATE final_outputs SET claim=NULL,lease_until=? WHERE id=? AND claim=? AND state IN ('prepared','attempting')")
      .run(visibleAt, id, claim);
  }
  settle(id: string, claim: string, state: Exclude<FinalHandoffState, 'prepared' | 'attempting'>, result: { messageId?: string; reason?: string } = {}, now = Date.now()): boolean {
    return this.transaction(() => {
      const prior = this.read(id);
      if (!prior || prior.claim !== claim || !['prepared', 'attempting'].includes(prior.state)) return false;
      const record = { ...prior, state, ...result };
      return Number(this.db.prepare('UPDATE final_outputs SET value=?,state=?,claim=NULL,lease_until=0,updated_at=? WHERE id=? AND claim=?')
        .run(JSON.stringify(record), state, now, id, claim).changes) === 1;
    });
  }
}
