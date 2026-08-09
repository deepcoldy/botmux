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
import { withFileLockSync } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface PersistedAsyncTriggerResult {
  status: 'pending' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
  content?: string;
  /** Set only when status==='failed'. `dispatch_unknown` is the at-most-once
   *  ambiguous-crash outcome written by the idempotency reconcile/barrier: a
   *  turn whose dispatch may or may not have executed and must NOT be re-run. */
  failedAt?: number;
  errorCode?: 'no_output';
  reason?: 'dispatch_unknown';
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

/** STRICT loader for the authoritative failed-evidence RMW: ONLY a genuinely
 *  absent file (ENOENT) is treated as empty. A present-but-unreadable file
 *  (EIO/EACCES), corrupt JSON, or invalid shape THROWS — the soft `load()` would
 *  fold these into `{results:{}}`, and recordFailedStrict would then durably
 *  OVERWRITE a file that might hold a `completed` proof or another owner's data
 *  (finding: strict write over a soft read defeats completed-wins/owner-proof). */
function loadStrict(sessionId: string): AsyncTriggerFile {
  const fp = getFilePath(sessionId);
  try { readFileSync(fp, 'utf-8'); }
  catch (err: any) {
    if (err?.code === 'ENOENT') return { results: {} };
    throw err; // EIO/EACCES/… — do NOT treat as empty
  }
  const data = JSON.parse(readFileSync(fp, 'utf-8')) as AsyncTriggerFile; // corrupt → throw
  if (!data || typeof data !== 'object' || typeof data.results !== 'object') {
    throw new Error(`corrupt async-trigger file (invalid shape): ${fp}`);
  }
  return { ownerLarkAppId: data.ownerLarkAppId, latestTriggerId: data.latestTriggerId, results: data.results ?? {} };
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

/** Crash-durable, THROWING save for authoritative failed evidence. Unlike
 *  `save` (best-effort), a write failure here propagates so the caller can treat
 *  a lost dispatch_unknown record as a hard error. */
function saveStrict(sessionId: string, file: AsyncTriggerFile): void {
  ensureDir();
  atomicWriteFileSync(getFilePath(sessionId), JSON.stringify(file, null, 2), {
    durable: true,
    followTargetSymlink: false,
  });
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
  // Serialize with recordFailedStrict on the same per-session lock so a
  // completed proof and a dispatch_unknown failure can't interleave-clobber.
  // Completed is the STRONGER evidence: it always wins (a late completed
  // overwrites a previously-written dispatch_unknown — the turn did finish).
  ensureDir();
  withFileLockSync(getFilePath(sessionId), () => {
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
  });
}

/**
 * Record a durable `failed` async outcome (STRICT). This is the authoritative
 * terminal state the idempotency reconcile/barrier writes for a
 * `dispatch_unknown` turn — an at-most-once ambiguous crash that must NOT be
 * re-run. Unlike recordPending/recordCompleted's best-effort save, this:
 *   - takes the per-session cross-process lock (serialized with recordCompleted),
 *   - writes crash-durable (fsync temp + rename), and
 *   - THROWS on any I/O error (the caller must treat a failed persist as a hard
 *     failure — the whole point is that this evidence is authoritative).
 *
 * Completed-wins invariant: if a `completed` result is ALREADY on disk for this
 * triggerId, this is a no-op (the turn finished; the stronger proof stands). We
 * deliberately do NOT make `failed` irreversible — a completed arriving later
 * still wins via recordCompleted (same lock).
 */
export function recordFailedStrict(
  sessionId: string,
  triggerId: string,
  failedAt: number,
  ownerLarkAppId: string,
  reason: 'dispatch_unknown' = 'dispatch_unknown',
): void {
  if (!ownerLarkAppId) throw new Error('recordFailedStrict requires ownerLarkAppId');
  ensureDir();
  withFileLockSync(getFilePath(sessionId), () => {
    const file = loadStrict(sessionId); // ONLY ENOENT is empty; corrupt/EIO throws
    // Owner proof: never overwrite another bot's file (a hash/path mixup or a
    // cross-bot mistake must fail-closed, not clobber their evidence).
    if (file.ownerLarkAppId && file.ownerLarkAppId !== ownerLarkAppId) {
      throw new Error(`recordFailedStrict owner mismatch: file owned by ${file.ownerLarkAppId}, caller ${ownerLarkAppId}`);
    }
    const prev = file.results[triggerId];
    if (prev?.status === 'completed') return; // completed is stronger — keep it
    file.ownerLarkAppId = ownerLarkAppId;
    file.results[triggerId] = {
      status: 'failed',
      createdAt: prev?.createdAt ?? failedAt,
      failedAt,
      errorCode: 'no_output',
      reason,
    };
    if (!file.latestTriggerId) file.latestTriggerId = triggerId;
    saveStrict(sessionId, file); // durable + throws
  });
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
