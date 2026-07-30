/**
 * Async trigger result store — durably persists asyncReturnSessionId trigger
 * outcomes so `GET /api/sessions/:id/trigger-result` survives a daemon restart.
 *
 * Background: async trigger state normally lives only in memory on the active
 * DaemonSession (`asyncTriggerResults`). A daemon restart (or idle-suspend)
 * drops that Map, which would make a poller see `session_not_found` for a turn
 * that in fact already completed — a false "task lost" for programmatic callers
 * (e.g. the riff task runner) that reconcile purely off this endpoint.
 *
 * This store mirrors frozen-card-store's on-disk contract (atomic tmp+rename
 * under {dataDir}/async-triggers/{sessionId}.json). It holds the final output
 * text so `completed` can be rebuilt from disk after a restart — the CLI
 * transcript is the ultimate source of truth, but insight-layer projections
 * deliberately scrub raw output, so re-parsing them cannot reproduce
 * output.content. Persisting the captured final_output is both cheaper and
 * strictly more faithful than transcript re-parsing across 20+ CLI formats.
 *
 * The file is keyed by botmux sessionId (1:1 with a virtual async session's
 * single turn) and stores every triggerId seen for that session, so both
 * latest-wins polling (by sessionId) and exact-match polling (by triggerId)
 * resolve after a restart.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface PersistedAsyncTriggerResult {
  status: 'pending' | 'completed';
  createdAt: number;
  completedAt?: number;
  content?: string;
  /** Per-turn token usage captured at completion (codex-app). Optional — omitted
   *  when the turn produced no coherent usage. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  };
}

/** On-disk shape: { ownerLarkAppId, latestTriggerId, results }. ownerLarkAppId
 *  stamps the bot that owns this session so a cross-bot lookup (a request routed
 *  to daemon A carrying a sessionId that belongs to bot B) can be rejected even
 *  after the session record itself is gone. */
interface AsyncTriggerFile {
  ownerLarkAppId?: string;
  latestTriggerId?: string;
  results: Record<string, PersistedAsyncTriggerResult>;
}

function getDir(): string {
  return join(config.session.dataDir, 'async-triggers');
}

function getFilePath(sessionId: string): string {
  return join(getDir(), `${sessionId}.json`);
}

function ensureDir(): void {
  const dir = getDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function load(sessionId: string): AsyncTriggerFile {
  const fp = getFilePath(sessionId);
  if (!existsSync(fp)) return { results: {} };
  try {
    const data = JSON.parse(readFileSync(fp, 'utf-8')) as AsyncTriggerFile;
    if (!data || typeof data !== 'object' || typeof data.results !== 'object') return { results: {} };
    return { ownerLarkAppId: data.ownerLarkAppId, latestTriggerId: data.latestTriggerId, results: data.results ?? {} };
  } catch (err) {
    logger.debug(`Failed to load async trigger results for ${sessionId}: ${err}`);
    return { results: {} };
  }
}

function save(sessionId: string, file: AsyncTriggerFile): void {
  ensureDir();
  const fp = getFilePath(sessionId);
  const tmpFp = fp + '.tmp';
  try {
    writeFileSync(tmpFp, JSON.stringify(file, null, 2), 'utf-8');
    renameSync(tmpFp, fp);
  } catch (err) {
    logger.debug(`Failed to persist async trigger results for ${sessionId}: ${err}`);
  }
}

/** Record a freshly-armed async trigger as pending. Best-effort; a failed write
 *  only loses the restart-recovery guarantee, never the in-memory path.
 *  `ownerLarkAppId` is REQUIRED — it stamps the owning bot so cross-bot lookups
 *  can be rejected fail-closed (an unstamped file would be un-attributable and
 *  therefore un-servable). Pass '' only in tests that deliberately exercise the
 *  legacy-unstamped path. */
export function recordPending(sessionId: string, triggerId: string, createdAt: number, ownerLarkAppId: string): void {
  const file = load(sessionId);
  if (ownerLarkAppId) file.ownerLarkAppId = ownerLarkAppId;
  file.results[triggerId] = { status: 'pending', createdAt };
  file.latestTriggerId = triggerId;
  save(sessionId, file);
}

/** Mark an async trigger completed with its captured final output.
 *  `ownerLarkAppId` is REQUIRED (see recordPending). `usage` optional per-turn tokens. */
export function recordCompleted(
  sessionId: string,
  triggerId: string,
  content: string,
  completedAt: number,
  ownerLarkAppId: string,
  usage?: PersistedAsyncTriggerResult['usage'],
): void {
  const file = load(sessionId);
  if (ownerLarkAppId) file.ownerLarkAppId = ownerLarkAppId;
  const prev = file.results[triggerId];
  file.results[triggerId] = {
    status: 'completed',
    createdAt: prev?.createdAt ?? completedAt,
    completedAt,
    content,
    ...(usage ? { usage } : {}),
  };
  if (!file.latestTriggerId) file.latestTriggerId = triggerId;
  save(sessionId, file);
}

/** Look up a persisted result. With no triggerId, resolves the latest recorded
 *  one (mirrors the in-memory latestAsyncTriggerId semantics). Returns the
 *  stamped `ownerLarkAppId` (if any) so the caller can enforce cross-bot
 *  isolation before trusting the result. */
export function lookup(sessionId: string, triggerId?: string): {
  triggerId: string;
  result: PersistedAsyncTriggerResult;
  ownerLarkAppId?: string;
} | undefined {
  const file = load(sessionId);
  const resolved = triggerId || file.latestTriggerId;
  if (!resolved) return undefined;
  const result = file.results[resolved];
  if (!result) return undefined;
  return { triggerId: resolved, result, ownerLarkAppId: file.ownerLarkAppId };
}

/** Delete a session's persisted async results (called on session close). */
export function deleteResults(sessionId: string): void {
  const fp = getFilePath(sessionId);
  try { if (existsSync(fp)) unlinkSync(fp); } catch { /* ignore */ }
}
