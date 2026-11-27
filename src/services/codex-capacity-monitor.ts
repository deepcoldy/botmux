/**
 * Read-only tail of Codex's native `logs_<N>.sqlite` for live capacity retries.
 *
 * When OpenAI responds to a Codex sampling request with HTTP 503
 * (`Selected model is at capacity. Please try a different model.` /
 * `server_overloaded`), Codex's `codex_core::responses_retry` enters up to five
 * multi-minute backoff sleeps (~300s-370s each, 25-30 minutes total) without
 * writing any error line to `rollout-*.jsonl` until all retries exhaust.
 *
 * Codex writes a `WARN` row to `<CODEX_HOME>/logs_2.sqlite` (indexed on
 * `thread_id`) at the start of retry 1/5. Polling that table read-only while a
 * turn is active surfaces capacity congestion within seconds instead of half an
 * hour, allowing the daemon to ask the user whether to downgrade models.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabaseSyncNow, type DatabaseSyncLike } from './sqlite-compat.js';
import { MODEL_SLUG_PATTERN } from '../core/model-value-pattern.js';

export const CODEX_CAPACITY_POLL_INTERVAL_MS = 2_500;
const CODEX_LOGS_DB_RE = /^logs_(\d+)\.sqlite$/;
const CODEX_RESPONSES_RETRY_TARGET = 'codex_core::responses_retry';
const CODEX_CAPACITY_MESSAGE_RE = /selected model is at capacity\b|server_?overloaded\b/i;
const CODEX_NON_CAPACITY_ERROR_RE = /usage_limit_exceeded|rate_limit_exceeded|insufficient_quota|invalid_api_key|unauthorized/i;
const SAMPLING_MODEL_RE = /\brun_sampling_request\{[^}]*\bmodel=([^\s,}]+)/;
const TURN_MODEL_RE = /\bturn\{[^}]*\bmodel=([^\s,}]+)/;
const TURN_ID_RE = /\bturn_id=([^\s,}]+)/;
const RETRY_PROGRESS_RE = /retrying sampling request\s*\((\d+)\/(\d+)(?:\s+in\s+(\d+(?:\.\d+)?)s)?\)/i;
const RETRIES_KV_RE = /\bretries=(\d+)\b/;
const MAX_RETRIES_KV_RE = /\bmax_retries=(\d+)\b/;

export interface CodexLogsRow {
  id: number;
  ts: number;
  target: string;
  thread_id: string | null;
  feedback_log_body: string | null;
}

export interface CodexCapacityRetryEvent {
  rowId: number;
  tsMs: number;
  threadId: string;
  model?: string;
  codexTurnId?: string;
  retryAttempt?: number;
  maxRetries?: number;
  retryDelaySec?: number;
  errorMessage: string;
}

/** Locate the newest versioned Codex logs SQLite database under `codexHomeDir`. */
export function resolveCodexLogsDbPath(codexHomeDir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(codexHomeDir);
  } catch {
    return undefined;
  }
  let bestVersion = -1;
  let bestName: string | undefined;
  for (const name of names) {
    const match = CODEX_LOGS_DB_RE.exec(name);
    if (!match) continue;
    const version = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(version) && version > bestVersion) {
      bestVersion = version;
      bestName = name;
    }
  }
  if (!bestName) return undefined;
  const fullPath = join(codexHomeDir, bestName);
  return existsSync(fullPath) ? fullPath : undefined;
}

/** Parse one `logs` row into a structured capacity-retry event, or undefined. */
export function parseCodexCapacityRetryRow(row: CodexLogsRow): CodexCapacityRetryEvent | undefined {
  if (!row || typeof row.id !== 'number' || !Number.isFinite(row.id)) return undefined;
  if (row.target !== CODEX_RESPONSES_RETRY_TARGET) return undefined;
  const threadId = typeof row.thread_id === 'string' ? row.thread_id.trim() : '';
  const body = typeof row.feedback_log_body === 'string' ? row.feedback_log_body : '';
  if (!threadId || !body) return undefined;
  if (!CODEX_CAPACITY_MESSAGE_RE.test(body) || CODEX_NON_CAPACITY_ERROR_RE.test(body)) return undefined;

  const rawModel = (SAMPLING_MODEL_RE.exec(body)?.[1] ?? TURN_MODEL_RE.exec(body)?.[1])?.trim();
  const model = rawModel && MODEL_SLUG_PATTERN.test(rawModel) ? rawModel : undefined;
  const codexTurnId = TURN_ID_RE.exec(body)?.[1]?.trim() || undefined;

  const progress = RETRY_PROGRESS_RE.exec(body);
  const retryAttemptRaw = progress?.[1] ?? RETRIES_KV_RE.exec(body)?.[1];
  const maxRetriesRaw = progress?.[2] ?? MAX_RETRIES_KV_RE.exec(body)?.[1];
  const retryDelayRaw = progress?.[3];
  const retryAttempt = retryAttemptRaw ? Number.parseInt(retryAttemptRaw, 10) : undefined;
  const maxRetries = maxRetriesRaw ? Number.parseInt(maxRetriesRaw, 10) : undefined;
  const retryDelaySec = retryDelayRaw ? Math.round(Number.parseFloat(retryDelayRaw)) : undefined;

  const tsMs = typeof row.ts === 'number' && Number.isFinite(row.ts)
    ? (row.ts > 1e12 ? row.ts : row.ts * 1_000)
    : Date.now();

  return {
    rowId: row.id,
    tsMs,
    threadId,
    ...(model ? { model } : {}),
    ...(codexTurnId ? { codexTurnId } : {}),
    ...(retryAttempt !== undefined && Number.isFinite(retryAttempt) ? { retryAttempt } : {}),
    ...(maxRetries !== undefined && Number.isFinite(maxRetries) ? { maxRetries } : {}),
    ...(retryDelaySec !== undefined && Number.isFinite(retryDelaySec) ? { retryDelaySec } : {}),
    errorMessage: 'Selected model is at capacity. Please try a different model.',
  };
}

export interface CodexCapacityMonitorDeps {
  resolveDbPath?: (codexHomeDir: string) => string | undefined;
  openReadonlyDb?: (dbPath: string) => DatabaseSyncLike | null;
  pollIntervalMs?: number;
}

/** Per-worker incremental observer for Codex capacity retries on one thread. */
export class CodexCapacityMonitor {
  private readonly resolveDbPath: (codexHomeDir: string) => string | undefined;
  private readonly openReadonlyDb: (dbPath: string) => DatabaseSyncLike | null;
  private readonly pollIntervalMs: number;

  private codexHomeDir: string | undefined;
  private threadId: string | undefined;
  private lastRowId = 0;
  private lastPollAtMs = 0;

  constructor(deps: CodexCapacityMonitorDeps = {}) {
    this.resolveDbPath = deps.resolveDbPath ?? resolveCodexLogsDbPath;
    this.openReadonlyDb = deps.openReadonlyDb ?? (dbPath => openDatabaseSyncNow(dbPath, { readOnly: true }));
    this.pollIntervalMs = deps.pollIntervalMs ?? CODEX_CAPACITY_POLL_INTERVAL_MS;
  }

  /** Bind to one active Codex thread and baseline past rows so old retries never replay.
   *  When `sinceMs` is provided, rows logged at or after `sinceMs` remain eligible so a
   *  capacity retry that fired milliseconds before the rollout bound is still caught. */
  bind(codexHomeDir: string, threadId: string, opts?: { sinceMs?: number }): void {
    const normalizedHome = codexHomeDir.trim();
    const normalizedThread = threadId.trim();
    if (!normalizedHome || !normalizedThread) return;
    if (this.codexHomeDir === normalizedHome && this.threadId === normalizedThread) return;
    this.codexHomeDir = normalizedHome;
    this.threadId = normalizedThread;
    this.lastPollAtMs = 0;
    this.lastRowId = this.readBaselineRowId(normalizedHome, normalizedThread, opts?.sinceMs);
  }

  /** Poll for newly logged capacity retries on the bound thread. */
  poll(nowMs = Date.now()): CodexCapacityRetryEvent[] {
    if (!this.codexHomeDir || !this.threadId) return [];
    if (this.lastPollAtMs > 0 && nowMs - this.lastPollAtMs < this.pollIntervalMs) return [];
    this.lastPollAtMs = nowMs;

    const dbPath = this.resolveDbPath(this.codexHomeDir);
    if (!dbPath) return [];

    let db: DatabaseSyncLike | null | undefined;
    try {
      db = this.openReadonlyDb(dbPath);
      if (!db) return [];
      const rows = db.prepare(
        `SELECT id, ts, target, thread_id, feedback_log_body
         FROM logs
         WHERE thread_id = ? AND id > ? AND target = ?
         ORDER BY id ASC
         LIMIT 16`,
      ).all(this.threadId, this.lastRowId, CODEX_RESPONSES_RETRY_TARGET) as CodexLogsRow[];

      const events: CodexCapacityRetryEvent[] = [];
      for (const row of rows) {
        if (typeof row.id === 'number' && row.id > this.lastRowId) {
          this.lastRowId = row.id;
        }
        const parsed = parseCodexCapacityRetryRow(row);
        if (parsed) events.push(parsed);
      }
      return events;
    } catch {
      return [];
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  clear(): void {
    this.codexHomeDir = undefined;
    this.threadId = undefined;
    this.lastRowId = 0;
    this.lastPollAtMs = 0;
  }

  private readBaselineRowId(codexHomeDir: string, threadId: string, sinceMs?: number): number {
    const dbPath = this.resolveDbPath(codexHomeDir);
    if (!dbPath) return 0;
    let db: DatabaseSyncLike | null | undefined;
    try {
      db = this.openReadonlyDb(dbPath);
      if (!db) return 0;
      const row = (sinceMs !== undefined && Number.isFinite(sinceMs)
        ? db.prepare(
            `SELECT COALESCE(MAX(id), 0) AS maxId
             FROM logs
             WHERE thread_id = ?
               AND ((ts > 1000000000000 AND ts < ?) OR (ts <= 1000000000000 AND ts < ?))`,
          ).get(threadId, Math.floor(sinceMs), Math.floor(sinceMs / 1_000))
        : db.prepare(
            'SELECT COALESCE(MAX(id), 0) AS maxId FROM logs WHERE thread_id = ?',
          ).get(threadId)) as { maxId?: number } | undefined;
      return typeof row?.maxId === 'number' && Number.isFinite(row.maxId) ? row.maxId : 0;
    } catch {
      return 0;
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
}
