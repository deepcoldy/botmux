import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import type { LarkAttachment } from '../types.js';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';

const RETENTION_MS = 30 * 86_400_000;
const MAX_BUNDLES = 1_000;
const MAX_PAYLOAD_BYTES = 512_000;
const MAX_INCLUDED_SEQS = 10_000;

/** Frozen input that was prepared for one turn. Sources may be excerpts;
 * coverage means provided to a completed turn, never read or understood. */

export interface PreparedGroupContext {
  appId: string;
  chatId: string;
  turnId: string;
  createdAt: number;
  body: string;
  includedSeqs: number[];
  /** Exact source revisions already carried by the ordinary native input. */
  nativeInputSeqs?: number[];
  throughSeq: number;
  incomplete: boolean;
  epoch?: string;
  /** Already authorized/downloaded historical attachments; this store does no fetching. */
  attachments?: LarkAttachment[];
  /** Frozen per-source fragments of `body` (body order). Dispatch subtracts the
   * fragments of sources covered after preparation; nothing is re-rendered. */
  sources?: PreparedGroupContextSource[];
  /** What actually crossed the delivery boundary. Recorded once at the first
   * real dispatch; retries and receipts read this, never the live coverage. */
  dispatch?: PreparedGroupContextDispatch;
}

export interface PreparedGroupContextSource {
  seq: number;
  text: string;
  resourceKeys?: string[];
}

export interface PreparedGroupContextDispatch {
  at: number;
  body: string;
  includedSeqs: number[];
  /** Background attachments still referenced by the dispatched sources. */
  attachments?: LarkAttachment[];
}

export interface GroupContextDeliveryBinding {
  appId: string;
  chatId: string;
  turnId: string;
  sessionId: string;
  epoch: string;
  /** Worker generation that received this input; absent evidence cannot be promoted. */
  workerGeneration?: number;
}

/** How a native CLI proved that this exact dispatched input entered its
 * conversation. IPC arrival, queue ownership or an adapter's generic
 * `submitted` flag are never proof kinds. */
export type GroupContextNativeInputProofKind =
  | 'codex_history_match'
  | 'codex_rpc_turn_start'
  | 'claude_transcript_user_record';

export interface GroupContextNativeInputProof {
  kind: GroupContextNativeInputProofKind;
  /** Native turn identity when the CLI exposes one (Codex RPC turn id). */
  nativeTurnId?: string;
}

export const GROUP_CONTEXT_NATIVE_INPUT_PROOF_KINDS: readonly GroupContextNativeInputProofKind[] = [
  'codex_history_match', 'codex_rpc_turn_start', 'claude_transcript_user_record',
];

interface StoredContext {
  app_id: string;
  chat_id: string;
  turn_id: string;
  snapshot_epoch: string;
  created_at: number;
  expires_at: number;
  payload: string;
  session_id: string | null;
  epoch: string | null;
  worker_generation: number | null;
  promoted_from_epoch: string | null;
  promoted_from_worker_generation: number | null;
  confirmed_at: number | null;
  native_consumed_at: number | null;
  native_consumed_proof: string | null;
  dispatched_at: number | null;
  dispatched_payload: string | null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS prepared_contexts (
    app_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    snapshot_epoch TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    payload TEXT NOT NULL,
    session_id TEXT,
    epoch TEXT,
    worker_generation INTEGER CHECK (worker_generation IS NULL OR worker_generation >= 0),
    promoted_from_epoch TEXT,
    promoted_from_worker_generation INTEGER CHECK (promoted_from_worker_generation IS NULL OR promoted_from_worker_generation >= 0),
    confirmed_at INTEGER,
    native_consumed_at INTEGER,
    native_consumed_proof TEXT,
    dispatched_at INTEGER,
    dispatched_payload TEXT,
    PRIMARY KEY (app_id, chat_id, turn_id, snapshot_epoch),
    CHECK ((session_id IS NULL) = (epoch IS NULL)),
    CHECK (confirmed_at IS NULL OR session_id IS NOT NULL),
    CHECK (native_consumed_at IS NULL OR session_id IS NOT NULL),
    CHECK ((native_consumed_at IS NULL) = (native_consumed_proof IS NULL)),
    CHECK (dispatched_at IS NULL OR session_id IS NOT NULL),
    CHECK ((dispatched_at IS NULL) = (dispatched_payload IS NULL))
  );
  CREATE INDEX IF NOT EXISTS group_context_delivery_expiry ON prepared_contexts(expires_at);
  CREATE INDEX IF NOT EXISTS group_context_delivery_consumer
    ON prepared_contexts(app_id, chat_id, session_id, epoch) WHERE confirmed_at IS NOT NULL OR native_consumed_at IS NOT NULL;
  CREATE TABLE IF NOT EXISTS native_output_sequences (
    app_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    snapshot_epoch TEXT NOT NULL DEFAULT '',
    seq INTEGER NOT NULL CHECK (seq > 0 AND seq <= 9007199254740991),
    PRIMARY KEY (app_id, chat_id, turn_id, snapshot_epoch, seq),
    FOREIGN KEY (app_id, chat_id, turn_id, snapshot_epoch)
      REFERENCES prepared_contexts(app_id, chat_id, turn_id, snapshot_epoch) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS confirmed_source_sequences (
    app_id TEXT NOT NULL, chat_id TEXT NOT NULL, session_id TEXT NOT NULL, epoch TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq > 0 AND seq <= 9007199254740991),
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (app_id, chat_id, session_id, epoch, seq)
  );
  CREATE INDEX IF NOT EXISTS group_context_confirmed_expiry ON confirmed_source_sequences(expires_at);
`;

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1_024 && !value.includes('\0');
}

function validateIdentity(...values: unknown[]): void {
  if (!values.every(validIdentity)) throw new Error('Invalid group context identity');
}

function validInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function normalizeNativeSeqs(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > MAX_INCLUDED_SEQS
    || !Array.from(value).every(seq => validInteger(seq, 1))) {
    throw new Error('Invalid native group context sequences');
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

function validateBinding(input: GroupContextDeliveryBinding): void {
  validateIdentity(input.appId, input.chatId, input.turnId, input.sessionId, input.epoch);
  if (input.workerGeneration !== undefined && !validInteger(input.workerGeneration, 0)) {
    throw new Error('Invalid group context worker generation');
  }
}

function validProof(value: unknown): value is GroupContextNativeInputProof {
  if (!value || typeof value !== 'object') return false;
  const proof = value as GroupContextNativeInputProof;
  return GROUP_CONTEXT_NATIVE_INPUT_PROOF_KINDS.includes(proof.kind)
    && (proof.nativeTurnId === undefined || validIdentity(proof.nativeTurnId));
}

function normalizeProof(value: unknown): GroupContextNativeInputProof {
  if (!validProof(value)) throw new Error('Invalid group context native input proof');
  return { kind: value.kind, ...(value.nativeTurnId !== undefined ? { nativeTurnId: value.nativeTurnId } : {}) };
}

function validStoredProof(row: StoredContext): boolean {
  if (row.native_consumed_at === null) return row.native_consumed_proof === null;
  if (!validInteger(row.native_consumed_at, 0) || row.session_id === null || typeof row.native_consumed_proof !== 'string') return false;
  try { return validProof(JSON.parse(row.native_consumed_proof)); } catch { return false; }
}

/** Sources become covered at the first reliable receipt: proven native input
 * consumption, or the completed terminal fallback. */
function validDispatch(value: unknown, prepared: PreparedGroupContext): value is PreparedGroupContextDispatch {
  if (!value || typeof value !== 'object') return false;
  const dispatch = value as PreparedGroupContextDispatch;
  const frozen = new Set(prepared.includedSeqs);
  const frozenPaths = new Set((prepared.attachments ?? []).map(attachment => attachment.path));
  return validInteger(dispatch.at, 0) && typeof dispatch.body === 'string' && dispatch.body.length <= prepared.body.length
    && Array.isArray(dispatch.includedSeqs) && dispatch.includedSeqs.every(seq => frozen.has(seq))
    && new Set(dispatch.includedSeqs).size === dispatch.includedSeqs.length
    && (dispatch.attachments === undefined || (Array.isArray(dispatch.attachments)
      && dispatch.attachments.every(attachment => !!attachment && typeof attachment === 'object' && frozenPaths.has(attachment.path))));
}

function storedDispatch(row: StoredContext, prepared: PreparedGroupContext): PreparedGroupContextDispatch | undefined {
  if (row.dispatched_at === null && row.dispatched_payload === null) return undefined;
  if (!validInteger(row.dispatched_at, 0) || row.session_id === null || typeof row.dispatched_payload !== 'string') {
    throw new Error('Invalid stored group context dispatch');
  }
  const parsed: unknown = JSON.parse(row.dispatched_payload);
  if (!validDispatch(parsed, prepared) || parsed.at !== row.dispatched_at) throw new Error('Invalid stored group context dispatch');
  const kept = new Set((parsed.attachments ?? []).map(attachment => attachment.path));
  const attachments = (prepared.attachments ?? []).filter(attachment => kept.has(attachment.path));
  return { at: parsed.at, body: parsed.body, includedSeqs: [...parsed.includedSeqs].sort((a, b) => a - b),
    ...(parsed.attachments !== undefined ? { attachments } : {}) };
}

/** The sources a receipt for this row may cover: exactly what the recorded
 * dispatch carried. Without a recorded dispatch nothing proves the frozen
 * sources ever reached the native conversation (sharing switched off after
 * preparation, a transport without background), so a receipt covers none of
 * them; repeating is safe, skipping is not. */
function deliveredSeqs(row: StoredContext, prepared: PreparedGroupContext): number[] {
  const dispatch = storedDispatch(row, prepared);
  if (dispatch) return dispatch.includedSeqs;
  // A bundle prepared before dispatch snapshots existed carries no fragments
  // and could never record one; it keeps the terminal-receipt semantics.
  return prepared.sources ? [] : prepared.includedSeqs;
}

/** Pure subtraction over the frozen bundle: drop exactly the fragments of the
 * covered sources from the frozen body, keep every other frozen excerpt,
 * header and gap marker verbatim, and keep only attachments still referenced.
 * Nothing is re-rendered or re-read. Undefined when the bundle carries no
 * fragments or they cannot be located exactly once in the body. */
export function subtractCoveredGroupContextSources(
  prepared: PreparedGroupContext, coveredSeqs: ReadonlySet<number>,
): { body: string; includedSeqs: number[]; attachments?: LarkAttachment[] } | undefined {
  const sources = prepared.sources;
  if (!sources?.length) return undefined;
  const frozen = new Set(prepared.includedSeqs);
  if (sources.length !== frozen.size || sources.some(source => !frozen.has(source.seq))) return undefined;
  const joined = sources.map(source => source.text).join('\n');
  const at = prepared.body.indexOf(joined);
  if (at < 0 || prepared.body.indexOf(joined, at + 1) >= 0) return undefined;
  const remaining = sources.filter(source => !coveredSeqs.has(source.seq));
  // Nothing left to share: omit the block entirely rather than send an empty wrapper.
  const body = remaining.length
    ? prepared.body.slice(0, at) + remaining.map(source => source.text).join('\n') + prepared.body.slice(at + joined.length)
    : '';
  const keys = new Set(remaining.flatMap(source => source.resourceKeys ?? []));
  const attachments = (prepared.attachments ?? []).filter(attachment => !attachment.resourceKey || keys.has(attachment.resourceKey));
  return {
    body, includedSeqs: remaining.map(source => source.seq).sort((a, b) => a - b),
    ...(attachments.length ? { attachments } : {}),
  };
}

/** What a dispatch of this bound consumer turn would carry right now: the
 * recorded snapshot when one real dispatch already crossed the boundary,
 * otherwise the frozen bundle minus the sources covered in the same native
 * epoch at this moment. Read-only; nothing is recorded. Fails closed
 * (undefined) without a matching binding. */
export function planGroupContextDispatch(
  input: GroupContextDeliveryBinding, dataDir: string = config.session.dataDir,
): { dispatch: PreparedGroupContextDispatch; recorded: boolean } | undefined {
  try {
    validateBinding(input);
    return withStore(dataDir, false, (db, now) => {
      const row = selectPrepared(db, input.appId, input.chatId, input.turnId, input.epoch);
      if (!row) return undefined;
      const prepared = decodeRow(row);
      if (!bindingMatches(row, input)) return undefined;
      const existing = storedDispatch(row, prepared);
      if (existing) return { dispatch: existing, recorded: true };
      const covered = new Set(coveredSeqsOf(db, input));
      const subtracted = prepared.includedSeqs.some(seq => covered.has(seq))
        ? subtractCoveredGroupContextSources(prepared, covered) : undefined;
      return {
        recorded: false,
        dispatch: subtracted
          ? { at: now, body: subtracted.body, includedSeqs: subtracted.includedSeqs, attachments: subtracted.attachments ?? [] }
          : { at: now, body: prepared.body, includedSeqs: prepared.includedSeqs, attachments: prepared.attachments ?? [] },
      };
    });
  } catch {
    return undefined;
  }
}

/** Record the snapshot that actually crossed the delivery boundary. The first
 * record wins: a concurrent or repeated dispatch gets the stored snapshot back
 * and must carry that one. Fails closed without a matching binding. */
export function recordGroupContextDispatch(
  input: GroupContextDeliveryBinding, dispatch: PreparedGroupContextDispatch, dataDir: string = config.session.dataDir,
): PreparedGroupContextDispatch | undefined {
  try {
    validateBinding(input);
    return withStore(dataDir, false, (db, now) => {
      const row = selectPrepared(db, input.appId, input.chatId, input.turnId, input.epoch);
      if (!row) return undefined;
      const prepared = decodeRow(row);
      if (!bindingMatches(row, input)) return undefined;
      const existing = storedDispatch(row, prepared);
      if (existing) return existing;
      const snapshot: PreparedGroupContextDispatch = {
        at: now, body: dispatch.body, includedSeqs: [...new Set(dispatch.includedSeqs)].sort((a, b) => a - b),
        attachments: (dispatch.attachments ?? []).map(attachment => ({ ...attachment })),
      };
      if (!validDispatch(snapshot, prepared)) throw new Error('Dispatch snapshot does not derive from the frozen bundle');
      const result = db.prepare(`UPDATE prepared_contexts SET dispatched_at = ?, dispatched_payload = ?
        WHERE app_id = ? AND chat_id = ? AND turn_id = ? AND snapshot_epoch = ? AND session_id = ? AND epoch = ? AND dispatched_at IS NULL`)
        .run(now, JSON.stringify(snapshot), input.appId, input.chatId, input.turnId, row.snapshot_epoch, input.sessionId, input.epoch);
      if (Number(result.changes) !== 1) {
        const current = selectPrepared(db, input.appId, input.chatId, input.turnId, input.epoch);
        return current ? storedDispatch(current, decodeRow(current)) : undefined;
      }
      return snapshot;
    });
  } catch {
    return undefined;
  }
}

function coveredSeqsOf(db: DatabaseSyncLike, input: { appId: string; chatId: string; sessionId: string; epoch: string }): number[] {
  const covered = db.prepare(`SELECT seq FROM confirmed_source_sequences
    WHERE app_id = ? AND chat_id = ? AND session_id = ? AND epoch = ? ORDER BY seq`)
    .all(input.appId, input.chatId, input.sessionId, input.epoch) as { seq: number }[];
  if (!covered.every(source => validInteger(source.seq, 1))) throw new Error('Invalid confirmed source sequence');
  return covered.map(source => source.seq);
}

function rowCovers(row: StoredContext): boolean {
  return row.confirmed_at !== null || row.native_consumed_at !== null;
}

function bindingMatches(row: StoredContext, input: GroupContextDeliveryBinding): boolean {
  return row.session_id === input.sessionId && row.epoch === input.epoch
    && row.worker_generation === (input.workerGeneration ?? null);
}

function epochParts(epoch: string): [string, string, string] | undefined {
  try {
    const parts: unknown = JSON.parse(epoch);
    return Array.isArray(parts) && parts.length === 3 && parts.every(validIdentity)
      ? parts as [string, string, string] : undefined;
  } catch { return undefined; }
}

function isPromotedEpoch(from: string, to: string, sessionId: string, turnId: string): boolean {
  const source = epochParts(from);
  const target = epochParts(to);
  return !!source && !!target && source[0] === sessionId && target[0] === sessionId
    && source[1] === target[1] && source[2] === `fresh:${turnId}` && !target[2].startsWith('fresh:');
}

function validPromotionProvenance(row: StoredContext): boolean {
  return validIdentity(row.promoted_from_epoch) && validInteger(row.promoted_from_worker_generation, 0)
    && row.session_id !== null && row.epoch !== null
    && isPromotedEpoch(row.promoted_from_epoch, row.epoch, row.session_id, row.turn_id)
    && (row.worker_generation === row.promoted_from_worker_generation
      || (row.promoted_from_worker_generation === 0 && row.worker_generation === 1));
}

function normalizePrepared(value: unknown): PreparedGroupContext {
  if (!value || typeof value !== 'object') throw new Error('Invalid prepared group context');
  const input = value as PreparedGroupContext;
  validateIdentity(input.appId, input.chatId, input.turnId);
  if (input.epoch !== undefined) validateIdentity(input.epoch);
  if (!validInteger(input.createdAt, 0)
    || typeof input.body !== 'string' || input.body.length > 100_000
    || typeof input.incomplete !== 'boolean'
    || !validInteger(input.throughSeq, 0)
    || !Array.isArray(input.includedSeqs) || input.includedSeqs.length > MAX_INCLUDED_SEQS
    || !input.includedSeqs.every(seq => validInteger(seq, 1) && seq <= input.throughSeq)) {
    throw new Error('Invalid prepared group context fields or sequences');
  }
  let attachments: LarkAttachment[] | undefined;
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments) || input.attachments.length > 128) {
      throw new Error('Invalid prepared group context attachments');
    }
    attachments = input.attachments.map(attachment => {
      if (!attachment || !['image', 'file'].includes(attachment.type)
        || !validIdentity(attachment.path) || typeof attachment.name !== 'string'
        || (attachment.resourceKey !== undefined && typeof attachment.resourceKey !== 'string')
        || (attachment.mimeType !== undefined && typeof attachment.mimeType !== 'string')) {
        throw new Error('Invalid prepared group context attachment');
      }
      return {
        type: attachment.type, path: attachment.path, name: attachment.name,
        ...(attachment.resourceKey !== undefined ? { resourceKey: attachment.resourceKey } : {}),
        ...(attachment.mimeType !== undefined ? { mimeType: attachment.mimeType } : {}),
      };
    });
  }
  const includedSeqs = [...new Set(input.includedSeqs)].sort((a, b) => a - b);
  let sources: PreparedGroupContextSource[] | undefined;
  if (input.sources !== undefined) {
    const included = new Set(includedSeqs);
    if (!Array.isArray(input.sources) || input.sources.length !== included.size
      || !input.sources.every(source => !!source && typeof source === 'object' && included.has(source.seq)
        && typeof source.text === 'string' && source.text.length > 0 && source.text.length <= input.body.length
        && (source.resourceKeys === undefined || (Array.isArray(source.resourceKeys) && source.resourceKeys.every(key => validIdentity(key)))))
      || new Set(input.sources.map(source => source.seq)).size !== input.sources.length) {
      throw new Error('Invalid prepared group context sources');
    }
    sources = input.sources.map(source => ({
      seq: source.seq, text: source.text,
      ...(source.resourceKeys?.length ? { resourceKeys: [...source.resourceKeys] } : {}),
    }));
  }
  const prepared: PreparedGroupContext = {
    appId: input.appId, chatId: input.chatId, turnId: input.turnId,
    createdAt: input.createdAt, body: input.body,
    includedSeqs,
    ...(input.nativeInputSeqs !== undefined ? { nativeInputSeqs: normalizeNativeSeqs(input.nativeInputSeqs) } : {}),
    throughSeq: input.throughSeq, incomplete: input.incomplete,
    ...(input.epoch !== undefined ? { epoch: input.epoch } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(sources !== undefined ? { sources } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(prepared), 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error('Prepared group context exceeds storage limit');
  }
  return prepared;
}

function decodeRow(row: StoredContext): PreparedGroupContext {
  if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error('Invalid stored group context payload');
  }
  const prepared = normalizePrepared(JSON.parse(row.payload));
  if (prepared.appId !== row.app_id || prepared.chatId !== row.chat_id || prepared.turnId !== row.turn_id
    || (row.snapshot_epoch !== '' && !validIdentity(row.snapshot_epoch))
    || (prepared.epoch !== undefined && prepared.epoch !== row.snapshot_epoch)
    || !validInteger(row.created_at, 0) || row.created_at > prepared.createdAt
    || row.expires_at !== row.created_at + RETENTION_MS
    || ((row.session_id === null) !== (row.epoch === null))
    || (row.session_id !== null && (!validIdentity(row.session_id) || !validIdentity(row.epoch)))
    || (row.worker_generation !== null && (!validInteger(row.worker_generation, 0) || row.session_id === null))
    || ((row.promoted_from_epoch !== null || row.promoted_from_worker_generation !== null) && !validPromotionProvenance(row))
    || (row.epoch !== null && prepared.epoch !== undefined && row.epoch !== prepared.epoch
      && !(validInteger(row.worker_generation, 1) && row.session_id !== null
        && isPromotedEpoch(prepared.epoch, row.epoch, row.session_id, row.turn_id)))
    || (row.confirmed_at !== null && (!validInteger(row.confirmed_at, 0) || row.session_id === null))
    || !validStoredProof(row)) {
    throw new Error('Invalid stored group context identity or delivery binding');
  }
  const dispatch = storedDispatch(row, prepared);
  return dispatch ? { ...prepared, dispatch } : prepared;
}

/** Add nullable provenance first, then atomically expand the old turn-only key.
 * Payload bytes and delivery receipts are copied unchanged; output rows follow
 * their exact parent snapshot. A failed migration rolls the entire open back. */
function ensureSchema(db: DatabaseSyncLike): void {
  const columns = db.prepare('PRAGMA table_info(prepared_contexts)').all() as { name: string }[];
  if (!columns.length) { db.exec(SCHEMA); return; }
  const additions = [
    ['worker_generation', 'INTEGER CHECK (worker_generation IS NULL OR worker_generation >= 0)'],
    ['promoted_from_epoch', 'TEXT'],
    ['promoted_from_worker_generation', 'INTEGER CHECK (promoted_from_worker_generation IS NULL OR promoted_from_worker_generation >= 0)'],
    ['native_consumed_at', 'INTEGER'],
    ['native_consumed_proof', 'TEXT'],
    ['dispatched_at', 'INTEGER'],
    ['dispatched_payload', 'TEXT'],
  ];
  for (const [name, definition] of additions) {
    if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE prepared_contexts ADD COLUMN ${name} ${definition}`);
  }
  if (columns.some(column => column.name === 'snapshot_epoch')) { db.exec(SCHEMA); return; }
  const outputsExist = (db.prepare('PRAGMA table_info(native_output_sequences)').all() as unknown[]).length > 0;
  db.exec(`ALTER TABLE prepared_contexts RENAME TO prepared_contexts_legacy;
    DROP INDEX IF EXISTS group_context_delivery_expiry;
    DROP INDEX IF EXISTS group_context_delivery_consumer;`);
  if (outputsExist) db.exec('ALTER TABLE native_output_sequences RENAME TO native_output_sequences_legacy');
  db.exec(SCHEMA);
  const oldRows = db.prepare('SELECT * FROM prepared_contexts_legacy').all() as StoredContext[];
  const insert = db.prepare(`INSERT INTO prepared_contexts
    (app_id, chat_id, turn_id, snapshot_epoch, created_at, expires_at, payload, session_id, epoch,
      worker_generation, promoted_from_epoch, promoted_from_worker_generation, confirmed_at,
      native_consumed_at, native_consumed_proof)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of oldRows) {
    let snapshotEpoch = row.epoch ?? '';
    try {
      const original = JSON.parse(row.payload)?.epoch;
      if (typeof original === 'string') snapshotEpoch = original;
    } catch { /* Preserve corrupted payload bytes; normal decode remains fail-closed. */ }
    insert.run(row.app_id, row.chat_id, row.turn_id, snapshotEpoch, row.created_at, row.expires_at,
      row.payload, row.session_id, row.epoch, row.worker_generation, row.promoted_from_epoch,
      row.promoted_from_worker_generation, row.confirmed_at, row.native_consumed_at ?? null, row.native_consumed_proof ?? null);
  }
  if (outputsExist) {
    db.exec(`INSERT INTO native_output_sequences (app_id, chat_id, turn_id, snapshot_epoch, seq)
      SELECT old.app_id, old.chat_id, old.turn_id, parent.snapshot_epoch, old.seq
      FROM native_output_sequences_legacy old JOIN prepared_contexts parent
        ON parent.app_id = old.app_id AND parent.chat_id = old.chat_id AND parent.turn_id = old.turn_id;
      DROP TABLE native_output_sequences_legacy;`);
  }
  db.exec('DROP TABLE prepared_contexts_legacy');
}

function nativeOutputSeqs(db: DatabaseSyncLike, row: StoredContext): number[] {
  const outputs = db.prepare(`SELECT seq FROM native_output_sequences
    WHERE app_id = ? AND chat_id = ? AND turn_id = ? AND snapshot_epoch = ?`)
    .all(row.app_id, row.chat_id, row.turn_id, row.snapshot_epoch) as { seq: number }[];
  return normalizeNativeSeqs(outputs.map(output => output.seq));
}

function recordConfirmedSources(db: DatabaseSyncLike, row: StoredContext, seqs: readonly number[]): void {
  if (row.session_id === null || row.epoch === null) throw new Error('Missing confirmed source consumer');
  const insert = db.prepare(`INSERT OR IGNORE INTO confirmed_source_sequences
    (app_id, chat_id, session_id, epoch, seq, expires_at) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const seq of new Set(seqs)) {
    if (!validInteger(seq, 1)) throw new Error('Invalid confirmed source sequence');
    insert.run(row.app_id, row.chat_id, row.session_id, row.epoch, seq, row.expires_at);
  }
}

function seedConfirmedSources(db: DatabaseSyncLike): void {
  const rows = db.prepare('SELECT * FROM prepared_contexts WHERE confirmed_at IS NOT NULL OR native_consumed_at IS NOT NULL').all() as StoredContext[];
  // Earliest source expiry wins; retries and duplicate coverage never extend it.
  rows.sort((left, right) => left.expires_at - right.expires_at);
  for (const row of rows) {
    const input = decodeRow(row);
    recordConfirmedSources(db, row, [...input.includedSeqs, ...(input.nativeInputSeqs ?? []), ...nativeOutputSeqs(db, row)]);
  }
}

/** SQLite serializes first-write/bind/confirm across processes. Handles are closed
 * after every operation so persisted state is authoritative after a restart.
 * Expired input and coverage are removed on every access. A 1,000-bundle cap,
 * 512 KB payload cap and bounded identities also cap retained storage. */
function withStore<T>(dataDir: string, create: boolean, operation: (db: DatabaseSyncLike, now: number) => T): T | undefined {
  const dir = join(dataDir, 'group-context-delivery');
  const path = join(dir, 'store.db');
  if (!create && !existsSync(path)) return undefined;
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = openDatabaseSyncOrThrow(path);
  let transaction = false;
  try {
    // Set timeout before the first page access, including concurrent cold starts.
    db.exec('PRAGMA busy_timeout = 2000; PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;');
    db.exec('BEGIN IMMEDIATE');
    transaction = true;
    // Idempotently add new ledger tables even when an old store is first opened
    // by a read/confirmation after upgrade, before any new bundle is prepared.
    const hadConfirmedLedger = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'confirmed_source_sequences'").get();
    ensureSchema(db);
    if (!hadConfirmedLedger) seedConfirmedSources(db);
    if (create) chmodSync(path, 0o600);
    const now = Date.now();
    db.prepare('DELETE FROM prepared_contexts WHERE expires_at <= ?').run(now);
    db.prepare('DELETE FROM confirmed_source_sequences WHERE expires_at <= ?').run(now);
    const result = operation(db, now);
    db.exec('COMMIT');
    transaction = false;
    return result;
  } finally {
    try {
      if (transaction) db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  }
}

function selectPrepared(
  db: DatabaseSyncLike, appId: string, chatId: string, turnId: string, expectedEpoch?: string, allowPredecessor = false,
): StoredContext | undefined {
  const rows = db.prepare('SELECT * FROM prepared_contexts WHERE app_id = ? AND chat_id = ? AND turn_id = ?')
    .all(appId, chatId, turnId) as StoredContext[];
  if (expectedEpoch === undefined) return rows.length === 1 ? rows[0] : undefined;
  const exact = rows.filter(row => row.snapshot_epoch === expectedEpoch);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const aliases = rows.filter(row => row.epoch === expectedEpoch
    || (allowPredecessor && row.promoted_from_epoch === expectedEpoch && validPromotionProvenance(row)));
  if (aliases.length) return aliases.length === 1 ? aliases[0] : undefined;
  const unbound = rows.filter(row => row.snapshot_epoch === '' && row.session_id === null);
  return unbound.length === 1 ? unbound[0] : undefined;
}

/** First write wins for app/chat/turn/native epoch, including retries with recomputed bodies.
 * Throws on invalid data or persistence failure; callers can omit context safely. */
export function writePreparedGroupContext(input: PreparedGroupContext, dataDir: string = config.session.dataDir): PreparedGroupContext {
  const prepared = normalizePrepared(input);
  return withStore(dataDir, true, (db, now) => {
    const existing = selectPrepared(db, prepared.appId, prepared.chatId, prepared.turnId, prepared.epoch ?? '');
    if (existing) return decodeRow(existing);
    const createdAt = Math.min(prepared.createdAt, now);
    if (createdAt + RETENTION_MS <= now) throw new Error('Prepared group context has expired');
    db.prepare(`INSERT INTO prepared_contexts (app_id, chat_id, turn_id, snapshot_epoch, created_at, expires_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      prepared.appId, prepared.chatId, prepared.turnId, prepared.epoch ?? '', createdAt, createdAt + RETENTION_MS, JSON.stringify(prepared),
    );
    // Late turns do not displace newer bundles. Ties are deterministic by identity.
    db.prepare(`DELETE FROM prepared_contexts WHERE rowid IN (
      SELECT rowid FROM prepared_contexts ORDER BY created_at DESC, app_id, chat_id, turn_id, snapshot_epoch LIMIT -1 OFFSET ?
    )`).run(MAX_BUNDLES);
    if (!selectPrepared(db, prepared.appId, prepared.chatId, prepared.turnId, prepared.epoch ?? '')) {
      throw new Error('Prepared group context is older than the storage retention limit');
    }
    return prepared;
  })!;
}

/** Whether any bundle (any epoch) was prepared for this turn; a cheap gate so
 * dispatch paths without shared background do no further work. */
export function hasPreparedGroupContext(appId: string, chatId: string, turnId: string, dataDir: string = config.session.dataDir): boolean {
  try {
    validateIdentity(appId, chatId, turnId);
    return withStore(dataDir, false, db => {
      const row = db.prepare('SELECT 1 AS present FROM prepared_contexts WHERE app_id = ? AND chat_id = ? AND turn_id = ? LIMIT 1')
        .get(appId, chatId, turnId) as { present: number } | undefined;
      return !!row;
    }) ?? false;
  } catch {
    return false;
  }
}

export function readPreparedGroupContext(appId: string, chatId: string, turnId: string, dataDir: string = config.session.dataDir, expectedEpoch?: string): PreparedGroupContext | undefined {
  try {
    validateIdentity(appId, chatId, turnId);
    if (expectedEpoch !== undefined) validateIdentity(expectedEpoch);
    return withStore(dataDir, false, db => {
      const row = selectPrepared(db, appId, chatId, turnId, expectedEpoch);
      return row ? decodeRow(row) : undefined;
    });
  } catch {
    return undefined;
  }
}

/** Associate the frozen bundle with its actual consumer before CLI input.
 * Binding never covers sources. A conflicting retry cannot change the consumer. */
export function bindGroupContextDelivery(input: GroupContextDeliveryBinding, dataDir: string = config.session.dataDir): void {
  validateBinding(input);
  const bound = withStore(dataDir, false, db => {
    const row = selectPrepared(db, input.appId, input.chatId, input.turnId, input.epoch);
    if (!row) throw new Error('Prepared group context is missing');
    const prepared = decodeRow(row);
    if (row.session_id !== null) {
      if (!bindingMatches(row, input)) {
        throw new Error('Group context is already bound to another consumer');
      }
      return true;
    }
    if (prepared.epoch !== undefined && prepared.epoch !== input.epoch) {
      throw new Error('Prepared group context epoch does not match consumer');
    }
    db.prepare('UPDATE prepared_contexts SET session_id = ?, epoch = ?, worker_generation = ? WHERE app_id = ? AND chat_id = ? AND turn_id = ? AND snapshot_epoch = ?')
      .run(input.sessionId, input.epoch, input.workerGeneration ?? null, input.appId, input.chatId, input.turnId, row.snapshot_epoch);
    return true;
  });
  if (!bound) throw new Error('Prepared group context is missing');
}

export function readGroupContextDeliveryBinding(appId: string, chatId: string, turnId: string, dataDir: string = config.session.dataDir, expectedEpoch?: string): GroupContextDeliveryBinding | undefined {
  try {
    validateIdentity(appId, chatId, turnId);
    if (expectedEpoch !== undefined) validateIdentity(expectedEpoch);
    return withStore(dataDir, false, db => {
      const row = selectPrepared(db, appId, chatId, turnId, expectedEpoch);
      if (!row) return undefined;
      decodeRow(row);
      if (row.session_id === null || row.epoch === null) return undefined;
      return { appId, chatId, turnId, sessionId: row.session_id, epoch: row.epoch,
        ...(row.worker_generation !== null ? { workerGeneration: row.worker_generation } : {}) };
    });
  } catch {
    return undefined;
  }
}

/** Call only after reliable evidence that this exact consumer turn completed.
 * Returns true for a matching confirmation, including an identical retry.
 * Missing, corrupt, expired or differently bound input fails closed. */
export function confirmGroupContextDelivery(input: GroupContextDeliveryBinding, dataDir: string = config.session.dataDir): boolean {
  try {
    validateBinding(input);
    return withStore(dataDir, false, (db, now) => {
      const row = selectPrepared(db, input.appId, input.chatId, input.turnId, input.epoch);
      if (!row) return false;
      decodeRow(row);
      if (!bindingMatches(row, input)) return false;
      if (row.confirmed_at === null) {
        db.prepare(`UPDATE prepared_contexts SET confirmed_at = ?
          WHERE app_id = ? AND chat_id = ? AND turn_id = ? AND snapshot_epoch = ? AND session_id = ? AND epoch = ?`)
          .run(now, input.appId, input.chatId, input.turnId, row.snapshot_epoch, input.sessionId, input.epoch);
        const prepared = decodeRow(row);
        // Repeated coverage of an already consumed input is idempotent.
        recordConfirmedSources(db, row, [...deliveredSeqs(row, prepared), ...(prepared.nativeInputSeqs ?? []), ...nativeOutputSeqs(db, row)]);
      }
      return true;
    }) ?? false;
  } catch {
    return false;
  }
}

/** Record that the native CLI accepted this exact dispatched input into the
 * bound conversation, so the next turn in the same native epoch does not repeat
 * these sources even if this turn never reaches a terminal (steering, worker
 * replacement, daemon restart). Requires the same consumer, native epoch and
 * worker generation as the binding; a replacement generation or a different
 * native conversation fails closed. Repeated receipts are idempotent and the
 * first proof is retained. */
export function confirmGroupContextNativeInput(
  input: GroupContextDeliveryBinding, proof: GroupContextNativeInputProof, dataDir: string = config.session.dataDir,
): boolean {
  try {
    validateBinding(input);
    if (!validInteger(input.workerGeneration, 1)) return false;
    const normalizedProof = normalizeProof(proof);
    return withStore(dataDir, false, (db, now) => {
      const row = selectPrepared(db, input.appId, input.chatId, input.turnId, input.epoch);
      if (!row) return false;
      decodeRow(row);
      if (!bindingMatches(row, input)) return false;
      if (row.native_consumed_at === null) {
        const result = db.prepare(`UPDATE prepared_contexts SET native_consumed_at = ?, native_consumed_proof = ?
          WHERE app_id = ? AND chat_id = ? AND turn_id = ? AND snapshot_epoch = ? AND session_id = ? AND epoch = ?
            AND worker_generation = ? AND native_consumed_at IS NULL`)
          .run(now, JSON.stringify(normalizedProof), input.appId, input.chatId, input.turnId, row.snapshot_epoch,
            input.sessionId, input.epoch, input.workerGeneration);
        if (Number(result.changes) !== 1) return false;
        const prepared = decodeRow(row);
        recordConfirmedSources(db, row, [...deliveredSeqs(row, prepared), ...(prepared.nativeInputSeqs ?? []), ...nativeOutputSeqs(db, row)]);
      }
      return true;
    }) ?? false;
  } catch {
    return false;
  }
}

/** Receipt state for one bound turn; absent when nothing is prepared or bound. */
export function readGroupContextDeliveryReceipt(
  appId: string, chatId: string, turnId: string, dataDir: string = config.session.dataDir, expectedEpoch?: string,
): { nativeConsumedAt?: number; proof?: GroupContextNativeInputProof; confirmedAt?: number; dispatchedAt?: number } | undefined {
  try {
    validateIdentity(appId, chatId, turnId);
    if (expectedEpoch !== undefined) validateIdentity(expectedEpoch);
    return withStore(dataDir, false, db => {
      const row = selectPrepared(db, appId, chatId, turnId, expectedEpoch);
      if (!row) return undefined;
      decodeRow(row);
      if (row.session_id === null) return undefined;
      return {
        ...(row.native_consumed_at !== null ? { nativeConsumedAt: row.native_consumed_at, proof: normalizeProof(JSON.parse(row.native_consumed_proof!)) } : {}),
        ...(row.confirmed_at !== null ? { confirmedAt: row.confirmed_at } : {}),
        ...(row.dispatched_at !== null ? { dispatchedAt: row.dispatched_at } : {}),
      };
    });
  } catch {
    return undefined;
  }
}

/** Called at actual worker reservation, before native input dispatch. A new
 * generation invalidates pending output evidence from the previous worker;
 * completion itself must never manufacture this dispatch proof. */
export function bindGroupContextWorkerGeneration(
  input: GroupContextDeliveryBinding, workerGeneration: number, dataDir: string = config.session.dataDir,
): GroupContextDeliveryBinding | undefined {
  try {
    validateBinding(input);
    if (!validInteger(workerGeneration, 1)) return undefined;
    return withStore(dataDir, false, db => {
      const row = selectPrepared(db, input.appId, input.chatId, input.turnId, input.epoch);
      if (!row || !bindingMatches(row, input)) return undefined;
      decodeRow(row);
      if (row.worker_generation === workerGeneration) return { ...input, workerGeneration };
      if (rowCovers(row) || (row.worker_generation !== null && row.worker_generation > workerGeneration)) return undefined;
      const result = db.prepare(`UPDATE prepared_contexts
        SET worker_generation = ?, promoted_from_epoch = NULL, promoted_from_worker_generation = NULL
        WHERE app_id = ? AND chat_id = ? AND turn_id = ? AND snapshot_epoch = ? AND session_id = ? AND epoch = ?
          AND worker_generation IS ? AND confirmed_at IS NULL AND native_consumed_at IS NULL`)
        .run(workerGeneration, input.appId, input.chatId, input.turnId, row.snapshot_epoch, input.sessionId, input.epoch, input.workerGeneration ?? null);
      if (Number(result.changes) !== 1) return undefined;
      db.prepare('DELETE FROM native_output_sequences WHERE app_id = ? AND chat_id = ? AND turn_id = ? AND snapshot_epoch = ?')
        .run(input.appId, input.chatId, input.turnId, row.snapshot_epoch);
      return { ...input, workerGeneration };
    });
  } catch {
    return undefined;
  }
}

/** Resolve only the initial unknown native identity, fenced to the exact input
 * worker generation. This never rebinds an established native session or changes
 * the frozen prompt; native output rows follow their unchanged turn identity. */
export function promoteGroupContextDeliveryEpoch(
  input: GroupContextDeliveryBinding, nativeSessionId: string, workerGeneration: number,
  dataDir: string = config.session.dataDir,
): GroupContextDeliveryBinding | undefined {
  try {
    validateBinding(input);
    validateIdentity(nativeSessionId);
    if (nativeSessionId.startsWith('fresh:') || !validInteger(workerGeneration, 1)
      || !validInteger(input.workerGeneration, 0)) return undefined;
    const source = epochParts(input.epoch);
    if (!source || source[0] !== input.sessionId || source[2] !== `fresh:${input.turnId}`) return undefined;
    if (input.workerGeneration !== workerGeneration && !(input.workerGeneration === 0 && workerGeneration === 1)) return undefined;
    const epoch = JSON.stringify([source[0], source[1], nativeSessionId]);
    return withStore(dataDir, false, db => {
      const row = selectPrepared(db, input.appId, input.chatId, input.turnId, input.epoch);
      if (!row || !bindingMatches(row, input) || rowCovers(row)) return undefined;
      decodeRow(row);
      const result = db.prepare(`UPDATE prepared_contexts SET epoch = ?, worker_generation = ?, promoted_from_epoch = ?, promoted_from_worker_generation = ?
        WHERE app_id = ? AND chat_id = ? AND turn_id = ? AND snapshot_epoch = ? AND session_id = ? AND epoch = ?
          AND worker_generation = ? AND confirmed_at IS NULL AND native_consumed_at IS NULL`)
        .run(epoch, workerGeneration, input.epoch, input.workerGeneration,
          input.appId, input.chatId, input.turnId, row.snapshot_epoch, input.sessionId, input.epoch, input.workerGeneration);
      return Number(result.changes) === 1 ? { ...input, epoch, workerGeneration } : undefined;
    });
  } catch {
    return undefined;
  }
}

/** Register successful native-authored output without confirming delivery of
 * the frozen input. Coverage becomes visible only once this bound turn is
 * confirmed; later output publications can append exact revisions afterwards. */
export function recordNativeGroupContextDelivery(
  input: GroupContextDeliveryBinding, seqs: readonly number[], dataDir: string = config.session.dataDir,
): boolean {
  try {
    validateBinding(input);
    const normalized = normalizeNativeSeqs(seqs);
    return withStore(dataDir, false, db => {
      const row = selectPrepared(db, input.appId, input.chatId, input.turnId, input.epoch, true);
      if (!row) return false;
      decodeRow(row);
      // A provider ACK can arrive after terminal settlement promoted the
      // provisional binding captured before the send. Accept only the exact
      // persisted predecessor, never an invented fresh epoch for a real turn.
      const promotedPredecessor = validPromotionProvenance(row) && row.session_id === input.sessionId
        && row.promoted_from_epoch === input.epoch && row.promoted_from_worker_generation === input.workerGeneration;
      if (!bindingMatches(row, input) && !promotedPredecessor) return false;
      const existing = new Set(nativeOutputSeqs(db, row));
      const combined = new Set([...existing, ...normalized]);
      if (combined.size > MAX_INCLUDED_SEQS) return false;
      const insert = db.prepare(`INSERT OR IGNORE INTO native_output_sequences (app_id, chat_id, turn_id, snapshot_epoch, seq)
        VALUES (?, ?, ?, ?, ?)`);
      for (const seq of normalized) insert.run(input.appId, input.chatId, input.turnId, row.snapshot_epoch, seq);
      if (rowCovers(row)) recordConfirmedSources(db, row, normalized.filter(seq => !existing.has(seq)));
      return true;
    }) ?? false;
  } catch {
    return false;
  }
}

/** Exact covered source identities for one native session epoch. throughSeq is
 * metadata only: it must never become a cursor that silently skips source holes.
 * Confirmed receipts survive retry-bundle eviction until their original TTL. */
export function getDeliveredGroupContextSeqs(appId: string, chatId: string, sessionId: string, epoch: string, dataDir: string = config.session.dataDir): number[] {
  try {
    validateIdentity(appId, chatId, sessionId, epoch);
    return withStore(dataDir, false, db => {
      const rows = db.prepare(`SELECT * FROM prepared_contexts
        WHERE app_id = ? AND chat_id = ? AND session_id = ? AND epoch = ? AND (confirmed_at IS NOT NULL OR native_consumed_at IS NOT NULL)`)
        .all(appId, chatId, sessionId, epoch) as StoredContext[];
      // While retained, malformed input evidence still fails closed. Evicting a
      // valid retry payload must not erase its independent confirmed receipt.
      for (const row of rows) decodeRow(row);
      return coveredSeqsOf(db, { appId, chatId, sessionId, epoch });
    }) ?? [];
  } catch {
    return [];
  }
}
