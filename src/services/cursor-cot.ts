/**
 * Cursor CoT (thinking process) side-channel reader.
 *
 * Cursor Agent's agent-transcript JSONL carries only user prompts and the
 * final reply — no reasoning, no tool calls/results. The model-visible
 * timeline persists in the per-chat SQLite store:
 *   ~/.cursor/chats/<projectHash>/<chatId>/store.db   (table: blobs)
 *
 * Each blob row is one provider message: `assistant` rows hold reasoning /
 * tool-call / text blocks, `tool` rows hold tool-result blocks. The reader
 * runs ONCE for the whole session (started as soon as the chatId/store is
 * discovered), so every input-delivery mode is covered — ordinary queued
 * turns, argv-baked first prompts (`passesInitialPromptViaArgs`), adopted
 * sessions, and autonomous Goal turns — no per-turn arm hook needed.
 *
 * NOTE: blobs are NOT strictly append-only — rowid holes from deletes are
 * normal and a new row can reuse a rowid at/below an earlier max. Each tick
 * reads the head row (pk + rowid); it re-sweeps only when a NEW head sits
 * at/below the cursor, so an idle session — head unchanged — never
 * materializes the whole table. Startup seeds every pre-baseline row's pk
 * into a non-evicting history set, so a sweep from rowid 0 never re-delivers
 * history (B4), regardless of store size; only genuinely new rows render.
 *
 * F1 guard: only `assistant` and `tool` rows produce nodes. `user` rows
 * (which include botmux's hidden injection envelope and the raw prompt) and
 * `system` rows never enter the bubble. Entries observed while no botmux turn
 * is active are dropped by the callback, so blobs from startup / between
 * turns never render. Purely cosmetic: every error is caught locally.
 *
 * Read-only access via sqlite-compat (bun:sqlite on the compiled binary,
 * node:sqlite under Node).
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDatabaseSyncNow } from './sqlite-compat.js';
import { boundSubjectForTransport, subjectFromArgsString, subjectFromInputObject } from './cot-subject.js';

const COT_TOOL_ARGS_MAX_CHARS = 600;
const COT_TOOL_RESULT_MAX_CHARS = 800;
const BATCH_LIMIT = 500;
const POLL_INTERVAL_MS = 1_000;
const SEEN_KEYS_MAX = 4_000;

export type CursorCotEntry =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | {
    kind: 'tool_call'; id: string; name: string; args: string;
    subject?: string;
  }
  | { kind: 'tool_result'; id: string; result: string };

interface ReaderState {
  chatId: string;
  timer: NodeJS.Timeout;
  lastRowid: number;
  chatsRoot?: string;
  /** First successfully resolved store.db, reused on later ticks. */
  resolvedDbPath?: string;
  /** SQL primary key of the current head row; a re-sweep is needed only
   *  when the head identity changes while its rowid is at/below cursor. */
  lastMaxPk?: string;
  /** SQL primary keys of entry-producing blobs observed after baseline,
   *  FIFO-bounded. */
  seenKeys: Set<string>;
  seenKeyOrder: string[];
  /** Primary keys of rows present at/before the startup baseline. Seeded
   *  once and deliberately NOT FIFO-evicted: a re-sweep from rowid 0 must
   *  never re-deliver history into the active turn (B4), regardless of how
   *  large the store is. */
  historyKeys: Set<string>;
}

const readers = new Map<string, ReaderState>();

/** Cursor encodes a tool call id as `<providerCallId>\n<functionCallId>` — a
 *  literal newline that must not reach the AG-UI node id. Normalize to a safe
 *  token; tool-call and tool-result derive from the same raw id, so pairing
 *  stays consistent. */
function sanitizeToolId(rawId: unknown): string {
  return String(rawId ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function truncateForCot(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function toolCallEntry(block: any): CursorCotEntry | null {
  const id = sanitizeToolId(block?.toolCallId);
  const name = typeof block?.toolName === 'string' ? block.toolName : 'tool';
  if (!id) return null;
  let args = '';
  let rawSubject = '';
  if (typeof block.args === 'string') {
    args = block.args;
    rawSubject = subjectFromArgsString(args);
  } else if (block.args !== undefined) {
    rawSubject = subjectFromInputObject(block.args);
    try { args = JSON.stringify(block.args); } catch { /* unserialisable — show none */ }
  }
  const subject = boundSubjectForTransport(rawSubject);
  return {
    kind: 'tool_call', id, name,
    args: truncateForCot(args, COT_TOOL_ARGS_MAX_CHARS),
    ...(subject ? { subject } : {}),
  };
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined || result === null) return '';
  try { return JSON.stringify(result); } catch { return ''; }
}

function toolResultEntry(block: any): CursorCotEntry | null {
  const id = sanitizeToolId(block?.toolCallId);
  if (!id) return null;
  const result = truncateForCot(stringifyToolResult(block?.result), COT_TOOL_RESULT_MAX_CHARS);
  return { kind: 'tool_result', id, result };
}

/** Map one parsed blob's content blocks to CoT entries, in block order.
 *  F1: `user` rows (hidden envelope + raw prompt) and `system` rows never
 *  produce entries. */
function entriesFromBlob(blob: any): CursorCotEntry[] {
  if (!blob || typeof blob !== 'object') return [];
  if (blob.role !== 'assistant' && blob.role !== 'tool') return [];
  const content = blob.content;
  if (!Array.isArray(content)) return [];
  const entries: CursorCotEntry[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'reasoning':
        if (typeof block.text === 'string' && block.text.trim().length > 0) {
          entries.push({ kind: 'thinking', text: block.text });
        }
        break;
      case 'text':
        if (typeof block.text === 'string' && block.text.trim().length > 0) {
          entries.push({ kind: 'text', text: block.text });
        }
        break;
      case 'tool-call': {
        const entry = toolCallEntry(block);
        if (entry) entries.push(entry);
        break;
      }
      case 'tool-result': {
        const entry = toolResultEntry(block);
        if (entry) entries.push(entry);
        break;
      }
    }
  }
  return entries;
}

function blobText(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  return undefined;
}

function rememberSeenKey(state: ReaderState, key: string): void {
  if (state.seenKeys.has(key)) return;
  state.seenKeys.add(key);
  state.seenKeyOrder.push(key);
  if (state.seenKeyOrder.length > SEEN_KEYS_MAX) {
    const drop = state.seenKeyOrder.splice(0, state.seenKeyOrder.length - SEEN_KEYS_MAX);
    for (const k of drop) state.seenKeys.delete(k);
  }
}

/** Read and map new blobs since `state.lastRowid`. Binary / encrypted rows
 *  that fail to parse advance the cursor but produce no entries. The dedup
 *  key is the SQL primary key (`pk`): the JSON body's own `id` is not unique
 *  — assistant rows almost always carry the literal "1". Returns false when
 *  the blobs table is not ready yet. */
function readNewEntries(state: ReaderState, dbPath: string, onEntries: (entries: readonly CursorCotEntry[]) => void): boolean {
  const db = openDatabaseSyncNow(dbPath, { readOnly: true });
  if (!db) return false;
  try {
    let rows: Array<{ pk: string; rowid: number | bigint; data: unknown }>;
    try {
      rows = db
        .prepare('SELECT id AS pk, rowid AS rowid, data AS data FROM blobs WHERE rowid > ? ORDER BY rowid LIMIT ?')
        .all(state.lastRowid, BATCH_LIMIT) as typeof rows;
    } catch {
      // Table not created yet — next tick retries; never throw.
      return false;
    }
    for (const row of rows) {
      state.lastRowid = Number(row.rowid);
      const text = blobText(row.data);
      if (text === undefined) continue;
      let blob: any;
      try { blob = JSON.parse(text); } catch { continue; }
      const entries = entriesFromBlob(blob);
      if (entries.length === 0) continue;
      if (state.historyKeys.has(row.pk) || state.seenKeys.has(row.pk)) continue;
      rememberSeenKey(state, row.pk);
      try { onEntries(entries); } catch { /* cosmetic channel — never break the read loop */ }
    }
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return true;
}

/** Register primary keys of every row at/below the startup baseline into
 *  `historyKeys` (id-only index read; data is never materialized). Runs
 *  once so a later re-sweep from rowid 0 cannot re-deliver pre-baseline
 *  history into the active turn (B4) — including on large stores, since
 *  this set is not FIFO-evicted. */
function seedHistoryKeys(state: ReaderState, dbPath: string, upTo: number): void {
  if (upTo <= 0) return;
  const db = openDatabaseSyncNow(dbPath, { readOnly: true });
  if (!db) return;
  try {
    let rows: Array<{ pk: string }>;
    try {
      rows = db.prepare('SELECT id AS pk FROM blobs WHERE rowid <= ?').all(upTo) as typeof rows;
    } catch {
      // Table not ready yet — no history to seed; ticks handle startup.
      return;
    }
    for (const row of rows) state.historyKeys.add(String(row.pk));
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** Resolve the store.db: reuse a previously resolved path, else scan the
 *  chats root for `<projectHash>/<chatId>/store.db`. */
function resolveDbPath(chatId: string, chatsRoot: string, cached?: string): string | undefined {
  if (cached && existsSync(cached)) return cached;
  if (!existsSync(chatsRoot)) return undefined;
  for (const projectHash of readdirSync(chatsRoot)) {
    const candidate = join(chatsRoot, projectHash, chatId, 'store.db');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface StartCursorCotOptions {
  /** Override the ~/.cursor/chats root (tests point this at a temp dir). */
  chatsRoot?: string;
  /** Explicit store.db path; skips the root scan when provided. */
  dbPath?: string;
}

/** Start the session-long CoT reader for a chat, baselined at the current
 *  max rowid. Returns false (and registers nothing) when the store cannot be
 *  resolved/opened, so the caller never believes a reader is running. The
 *  timer is unref'd so it can never hold the process alive. */
export function startCursorCot(
  chatId: string,
  onEntries: (entries: readonly CursorCotEntry[]) => void,
  options: StartCursorCotOptions = {},
): boolean {
  if (!chatId) return false;
  let existing = readers.get(chatId);
  if (existing) {
    clearInterval(existing.timer);
    readers.delete(chatId);
  }
  const chatsRoot = options.chatsRoot ?? join(homedir(), '.cursor', 'chats');
  const initialPath = options.dbPath ?? resolveDbPath(chatId, chatsRoot);
  if (!initialPath) return false;
  const probe = openDatabaseSyncNow(initialPath, { readOnly: true });
  let baseline = 0;
  let baselinePk: string | undefined;
  if (probe) {
    try {
      try {
        const head = probe
          .prepare('SELECT id AS pk, rowid AS rowid FROM blobs ORDER BY rowid DESC LIMIT 1')
          .get() as { pk?: string; rowid?: number | bigint };
        baseline = Number(head?.rowid ?? 0);
        baselinePk = head?.pk;
      } catch {
        // Store file exists before the blobs table is created (normal Cursor
        // startup ordering): start anyway at 0; ticks wait for the table.
      }
    } finally {
      try { probe.close(); } catch { /* ignore */ }
    }
  }
  const state: ReaderState = {
    chatId, timer: undefined as unknown as NodeJS.Timeout,
    lastRowid: baseline, chatsRoot: options.chatsRoot,
    resolvedDbPath: initialPath, lastMaxPk: baselinePk,
    seenKeys: new Set(), seenKeyOrder: [], historyKeys: new Set(),
  };
  seedHistoryKeys(state, initialPath, baseline);
  state.timer = setInterval(() => {
    const db = openDatabaseSyncNow(state.resolvedDbPath!, { readOnly: true });
    if (!db) {
      // Store may have moved/rotated: rescan root, then retry next tick.
      state.resolvedDbPath = resolveDbPath(chatId, chatsRoot, state.resolvedDbPath);
      return;
    }
    try {
      let head: { pk?: string; rowid?: number | bigint };
      try {
        head = db
          .prepare('SELECT id AS pk, rowid AS rowid FROM blobs ORDER BY rowid DESC LIMIT 1')
          .get() as typeof head;
      } catch {
        // blobs table not ready yet — skip this tick, never throw (B2).
        return;
      }
      const headRowid = Number(head.rowid ?? 0);
      const headPk = head.pk;
      if (headRowid <= state.lastRowid && state.lastMaxPk !== undefined && headPk !== state.lastMaxPk) {
        // A delete left a NEW head at/below the cursor (a row reusing the
        // max rowid, or max dropped): re-sweep. Same pk means plain idle —
        // do nothing, so steady state never materializes the whole table
        // (B3). SQL pk dedup prevents replay on the sweep.
        state.lastRowid = 0;
      }
      state.lastMaxPk = headPk;
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
    try {
      readNewEntries(state, state.resolvedDbPath!, onEntries);
    } catch { /* cosmetic channel */ }
  }, POLL_INTERVAL_MS);
  if (typeof state.timer.unref === 'function') state.timer.unref();
  readers.set(chatId, state);
  return true;
}

/** Stop the CoT reader for a chat, if any. */
export function stopCursorCot(chatId: string): void {
  const state = readers.get(chatId);
  if (!state) return;
  clearInterval(state.timer);
  readers.delete(chatId);
}

/** Stop every active CoT reader (full teardown). */
export function stopAllCursorCot(): void {
  for (const state of readers.values()) clearInterval(state.timer);
  readers.clear();
}
