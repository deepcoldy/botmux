import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDatabaseSyncNow, type DatabaseSyncLike } from './sqlite-compat.js';

const BOTMUX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NATIVE_ID = /^sess_[A-Za-z0-9_-]{1,120}$/;
const MAX_MARKER_BYTES = 65_536;

export interface ZcodeSubmissionReceipt {
  sha256: string;
  submittedAt: number;
  turnId?: string;
  cliSessionId: string;
}

export interface ZcodeSessionMarker {
  version: 1;
  botmuxSessionId: string;
  cliSessionId: string;
  updatedAt: number;
  source?: string;
  model?: string;
  cwd?: string;
  submission?: ZcodeSubmissionReceipt;
  lastStopAt?: number;
  bindingSource?: 'hook' | 'legacy-exact-identity';
}

export interface ZcodeSessionReadOptions {
  dataDir?: string;
}

export function isZcodeNativeSessionId(value: unknown): value is string {
  return typeof value === 'string' && NATIVE_ID.test(value);
}

export function zcodeSessionMarkerPath(botmuxSessionId: string, options: ZcodeSessionReadOptions = {}): string {
  if (!BOTMUX_ID.test(botmuxSessionId)) throw new Error('Invalid botmux session id');
  return join(options.dataDir ?? join(homedir(), '.botmux', 'data'), 'zcode-runtime', botmuxSessionId, 'native-session.json');
}

function readSmallJson(path: string): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readZcodeSessionMarker(botmuxSessionId: string, options: ZcodeSessionReadOptions = {}): ZcodeSessionMarker | null {
  try {
    const marker = readSmallJson(zcodeSessionMarkerPath(botmuxSessionId, options)) as Partial<ZcodeSessionMarker> | null;
    if (!marker || marker.version !== 1 || marker.botmuxSessionId !== botmuxSessionId
      || !isZcodeNativeSessionId(marker.cliSessionId) || !Number.isFinite(marker.updatedAt)) return null;
    return marker as ZcodeSessionMarker;
  } catch { return null; }
}

/**
 * Move this botmux session's native-session evidence aside before a FRESH spawn.
 *
 * A fresh demotion means the recorded native conversation could not be resumed
 * (deleted, or two consecutive resume failures). The hook pins the root identity
 * and refuses a different one — correct while the old conversation is the
 * session's, wrong once the host has decided to start over: every later hook
 * event of the NEW native session would be discarded, so no identity and no
 * submit receipt could ever be recorded. The host therefore archives the old
 * evidence (recoverable on disk, not deleted) and lets the hook bind the new id.
 * The hook itself keeps refusing arbitrary replacement.
 */
export function archiveZcodeSessionMarker(
  botmuxSessionId: string,
  options: ZcodeSessionReadOptions & { reason: string } = { reason: 'fresh-demotion' },
): string | null {
  try {
    const marker = zcodeSessionMarkerPath(botmuxSessionId, options);
    const directory = join(marker, '..');
    if (!existsSync(marker) && !existsSync(join(directory, 'native-session.id'))) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let target = join(directory, `superseded-${stamp}`);
    for (let suffix = 1; existsSync(target); suffix++) target = join(directory, `superseded-${stamp}-${suffix}`);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of ['native-session.json', 'native-session.id', 'submissions']) {
      const from = join(directory, name);
      if (existsSync(from)) renameSync(from, join(target, name));
    }
    writeFileSync(join(target, 'reason.json'), `${JSON.stringify({ reason: options.reason, archivedAt: Date.now() })}\n`, { mode: 0o600 });
    return target;
  } catch { return null; }
}

export function zcodeInputSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** A receipt is scoped to an exact botmux id, native id, input digest and send epoch.
 * Identical text from an earlier turn cannot prove a new submit succeeded. */
export function readZcodeSubmissionReceipt(
  botmuxSessionId: string,
  sha256: string,
  options: ZcodeSessionReadOptions & { afterMs?: number; cliSessionId?: string } = {},
): ZcodeSubmissionReceipt | null {
  if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
  try {
    const marker = readZcodeSessionMarker(botmuxSessionId, options);
    if (!marker || (options.cliSessionId && marker.cliSessionId !== options.cliSessionId)) return null;
    const directory = join(zcodeSessionMarkerPath(botmuxSessionId, options), '..', 'submissions');
    let found: ZcodeSubmissionReceipt | null = null;
    for (const name of readdirSync(directory)) {
      if (!name.startsWith(`${sha256}-`) || !name.endsWith('.json')) continue;
      const receipt = readSmallJson(join(directory, name)) as ZcodeSubmissionReceipt | null;
      if (!receipt || receipt.sha256 !== sha256 || receipt.cliSessionId !== marker.cliSessionId
        || !Number.isFinite(receipt.submittedAt) || receipt.submittedAt < (options.afterMs ?? 0)) continue;
      if (!found || receipt.submittedAt > found.submittedAt) found = receipt;
    }
    return found;
  } catch { return null; }
}

/**
 * Every receipt recorded for this session AFTER an epoch, newest first.
 * Used only to confirm THIS write when the CLI normalised the prompt text
 * (the epoch is the ownership proof; the digest is a fast path).
 */
export function readZcodeSubmissionReceiptsAfter(
  botmuxSessionId: string,
  options: ZcodeSessionReadOptions & { afterMs: number; cliSessionId?: string } ,
): ZcodeSubmissionReceipt[] {
  try {
    const marker = readZcodeSessionMarker(botmuxSessionId, options);
    if (!marker || (options.cliSessionId && marker.cliSessionId !== options.cliSessionId)) return [];
    const directory = join(zcodeSessionMarkerPath(botmuxSessionId, options), '..', 'submissions');
    const found: ZcodeSubmissionReceipt[] = [];
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json')) continue;
      const receipt = readSmallJson(join(directory, name)) as ZcodeSubmissionReceipt | null;
      if (!receipt || receipt.cliSessionId !== marker.cliSessionId) continue;
      if (!Number.isFinite(receipt.submittedAt) || receipt.submittedAt < options.afterMs) continue;
      found.push(receipt);
    }
    return found.sort((a, b) => b.submittedAt - a.submittedAt);
  } catch { return []; }
}

export function zcodeSessionDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ZCODE_SESSION_DB_PATH?.trim() || env.ZCODE_SESSION_DB?.trim();
  if (!configured) return join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
  return configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured;
}

function withReadOnlyDb<T>(path: string, read: (db: DatabaseSyncLike) => T): T | null {
  if (!existsSync(path)) return null;
  const db = openDatabaseSyncNow(path, { readOnly: true });
  if (!db) return null;
  try { return read(db); } catch { return null; } finally { db.close(); }
}

export function zcodeNativeSessionExists(cliSessionId: string, dbPath = zcodeSessionDbPath()): boolean {
  if (!isZcodeNativeSessionId(cliSessionId)) return false;
  return withReadOnlyDb(dbPath, db => Boolean(db.prepare('SELECT id FROM session WHERE id = ? AND parent_id IS NULL').get(cliSessionId))) ?? false;
}

export interface ZcodeModelSelection {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string };
}

export function readZcodeSessionModelSelection(cliSessionId: string, dbPath = zcodeSessionDbPath()): ZcodeModelSelection | null {
  if (!isZcodeNativeSessionId(cliSessionId)) return null;
  return withReadOnlyDb(dbPath, db => {
    const row = db.prepare('SELECT data FROM session_entry WHERE session_id = ? AND type = ? ORDER BY time_updated DESC LIMIT 1')
      .get(cliSessionId, 'runtime/model_selection') as { data?: string } | undefined;
    const selection = row?.data ? JSON.parse(row.data)?.modelSelection : null;
    return selection && typeof selection.providerId === 'string' && typeof selection.modelId === 'string' ? selection : null;
  });
}

/** Execution facts, excluding title-generation and subagent model calls. */
export function readZcodeActualModel(cliSessionId: string, dbPath = zcodeSessionDbPath()):
  { providerId: string; modelId: string; status: string; usedAt: number } | null {
  if (!isZcodeNativeSessionId(cliSessionId)) return null;
  return withReadOnlyDb(dbPath, db => {
    const row = db.prepare('SELECT provider_id, model_id, status, started_at FROM model_usage WHERE session_id = ? AND query_source = ? ORDER BY started_at DESC LIMIT 1')
      .get(cliSessionId, 'main_turn') as { provider_id?: string; model_id?: string; status?: string; started_at?: number } | undefined;
    return row && typeof row.provider_id === 'string' && typeof row.model_id === 'string'
      ? { providerId: row.provider_id, modelId: row.model_id, status: row.status ?? 'unknown', usedAt: row.started_at ?? 0 } : null;
  });
}

/** One-time legacy binding: exact identity in a root session's user text.
 * Never infer identity from recency, cwd, model names or assistant/tool output. */
export function findZcodeSessionByBotmuxIdentity(botmuxSessionId: string, dbPath = zcodeSessionDbPath()): string | null {
  if (!BOTMUX_ID.test(botmuxSessionId)) return null;
  return withReadOnlyDb(dbPath, db => {
    const rows = db.prepare('SELECT p.session_id, p.data AS part_data, m.data AS message_data FROM part p JOIN message m ON m.id = p.message_id JOIN session s ON s.id = p.session_id WHERE s.parent_id IS NULL AND instr(p.data, ?) > 0')
      .all(botmuxSessionId) as { session_id: string; part_data: string; message_data: string }[];
    const identities = new Set<string>();
    for (const row of rows) {
      const part = JSON.parse(row.part_data);
      const message = JSON.parse(row.message_data);
      if (message.role !== 'user' || part.type !== 'text' || typeof part.text !== 'string') continue;
      let index = part.text.indexOf(botmuxSessionId);
      while (index >= 0) {
        const prefix = part.text.slice(Math.max(0, index - 160), index);
        if (/(?:BOTMUX_SESSION_ID|session[_ -]?id|会话)[^\n]{0,120}$/i.test(prefix)
          && isZcodeNativeSessionId(row.session_id)) identities.add(row.session_id);
        index = part.text.indexOf(botmuxSessionId, index + botmuxSessionId.length);
      }
    }
    return identities.size === 1 ? [...identities][0]! : null;
  });
}
