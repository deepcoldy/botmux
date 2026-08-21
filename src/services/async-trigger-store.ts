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
   *  ambiguous-crash outcome written by the idempotency reconcile/barrier;
   *  `turn_terminal` is an explicit failed/ambiguous terminal emitted by the
   *  still-live worker. */
  failedAt?: number;
  errorCode?: 'no_output' | 'trigger_failed';
  reason?: 'dispatch_unknown' | 'turn_terminal';
  /** Original structured worker terminal code retained for programmatic
   *  callers without widening TriggerResponse.errorCode with provider values. */
  terminalErrorCode?: string;
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

/** True for a real plain object (rejects arrays and null — both pass a bare
 *  `typeof x === 'object'`). Used by the strict loader/lookup so a JSON file that
 *  is syntactically valid but structurally wrong (`results: []`, a non-object
 *  result) is treated as CORRUPT and throws, rather than silently read as
 *  "no such trigger" and driving a fail-open action (codex #818 strict-shape). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Runtime shape guard for one persisted result. The strict lookup must not read
 *  a `null` / malformed / invalid-status entry as a usable terminal — nor fold it
 *  into "absent". Present-but-malformed → THROWS (fail-closed).
 *
 *  Validates the STATUS-CONDITIONAL fields too (codex #818 strict-schema): a
 *  `failed` result must be one of the two writer-owned shapes below. A failed
 *  hit with a missing/other `reason` is therefore CORRUPT — and
 *  must throw here rather than pass `status`/`createdAt` only, because a
 *  downstream reader that gates on `reason==='dispatch_unknown'` (the recovery
 *  fence) would otherwise silently treat it as "not the terminal I care about"
 *  and fail-OPEN (replay the turn) instead of fail-closed. `completed` timestamp
 *  fields are likewise type-checked when present. */
function isValidPersistedResult(value: unknown): value is PersistedAsyncTriggerResult {
  if (!isPlainObject(value)) return false;
  const status = value.status;
  if (status !== 'pending' && status !== 'completed' && status !== 'failed') return false;
  if (typeof value.createdAt !== 'number') return false;
  if (status === 'failed') {
    if (typeof value.failedAt !== 'number') return false;
    if (value.reason === 'dispatch_unknown') {
      if (value.errorCode !== 'no_output') return false;
      if (value.terminalErrorCode !== undefined) return false;
    } else if (value.reason === 'turn_terminal') {
      if (value.errorCode !== 'trigger_failed') return false;
      if (typeof value.terminalErrorCode !== 'string' || value.terminalErrorCode.length === 0) return false;
    } else {
      return false;
    }
  }
  if (status === 'completed' && typeof value.completedAt !== 'number') return false;
  return true;
}

/** STRICT loader for the authoritative failed-evidence RMW: ONLY a genuinely
 *  absent file (ENOENT) is treated as empty. A present-but-unreadable file
 *  (EIO/EACCES), corrupt JSON, or invalid shape THROWS — the soft `load()` would
 *  fold these into `{results:{}}`, and recordFailedStrict would then durably
 *  OVERWRITE a file that might hold a `completed` proof or another owner's data
 *  (finding: strict write over a soft read defeats completed-wins/owner-proof).
 *  Shape check is strict about PLAIN objects: `results: []` (an array — also
 *  `typeof === 'object'`) or a non-string owner/latest is corrupt, not empty
 *  (codex #818 strict-shape: an array `results` slipped through the bare
 *  `typeof` gate and was misread as "no trigger"). */
function loadStrict(sessionId: string): AsyncTriggerFile {
  const fp = getFilePath(sessionId);
  try { readFileSync(fp, 'utf-8'); }
  catch (err: any) {
    if (err?.code === 'ENOENT') return { results: {} };
    throw err; // EIO/EACCES/… — do NOT treat as empty
  }
  const data = JSON.parse(readFileSync(fp, 'utf-8')) as AsyncTriggerFile; // corrupt → throw
  if (!isPlainObject(data) || !isPlainObject(data.results)) {
    throw new Error(`corrupt async-trigger file (invalid shape): ${fp}`);
  }
  if (data.ownerLarkAppId !== undefined && typeof data.ownerLarkAppId !== 'string') {
    throw new Error(`corrupt async-trigger file (invalid ownerLarkAppId): ${fp}`);
  }
  if (data.latestTriggerId !== undefined && typeof data.latestTriggerId !== 'string') {
    throw new Error(`corrupt async-trigger file (invalid latestTriggerId): ${fp}`);
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
 * triggerId, this is a no-op and returns `already_completed` (the turn finished;
 * the stronger proof stands). We deliberately do NOT make `failed` irreversible —
 * a completed arriving later still wins via recordCompleted (same lock).
 *
 * Returns a discriminated in-lock outcome so a caller that races a late completion
 * reacts to what ACTUALLY happened under the lock (no TOCTOU): `already_completed`
 * = a completed was on disk, nothing written, the caller must resolve completed;
 * `written_failed` = the durable failed was written (codex #818 P1-8 race).
 */
export type RecordFailedStrictOutcome = 'written_failed' | 'already_completed';
export function recordFailedStrict(
  sessionId: string,
  triggerId: string,
  failedAt: number,
  ownerLarkAppId: string,
  reason: 'dispatch_unknown' = 'dispatch_unknown',
): RecordFailedStrictOutcome {
  if (!ownerLarkAppId) throw new Error('recordFailedStrict requires ownerLarkAppId');
  ensureDir();
  return withFileLockSync(getFilePath(sessionId), () => {
    const file = loadStrict(sessionId); // ONLY ENOENT is empty; corrupt/EIO throws
    // Owner proof: never overwrite another bot's file (a hash/path mixup or a
    // cross-bot mistake must fail-closed, not clobber their evidence).
    if (file.ownerLarkAppId && file.ownerLarkAppId !== ownerLarkAppId) {
      throw new Error(`recordFailedStrict owner mismatch: file owned by ${file.ownerLarkAppId}, caller ${ownerLarkAppId}`);
    }
    const prev = file.results[triggerId];
    if (prev?.status === 'completed') return 'already_completed'; // completed is stronger — keep it
    // An explicit worker terminal is stronger than a later worker-exit
    // `dispatch_unknown`; keep the precise failure while reporting terminal
    // convergence to the caller.
    if (prev?.status === 'failed' && prev.reason === 'turn_terminal') return 'written_failed';
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
    return 'written_failed';
  });
}

/** Persist an explicit failed/ambiguous worker terminal for an async trigger.
 * Uses the same owner-proofed, durable, completed-wins transaction as
 * recordFailedStrict, while retaining the structured terminal code so polling
 * returns an immediate provider failure rather than a generic no-output state. */
export function recordTerminalFailureStrict(
  sessionId: string,
  triggerId: string,
  failedAt: number,
  ownerLarkAppId: string,
  terminalErrorCode: string,
): RecordFailedStrictOutcome {
  if (!ownerLarkAppId) throw new Error('recordTerminalFailureStrict requires ownerLarkAppId');
  if (!terminalErrorCode) throw new Error('recordTerminalFailureStrict requires terminalErrorCode');
  ensureDir();
  return withFileLockSync(getFilePath(sessionId), () => {
    const file = loadStrict(sessionId);
    if (file.ownerLarkAppId && file.ownerLarkAppId !== ownerLarkAppId) {
      throw new Error(`recordTerminalFailureStrict owner mismatch: file owned by ${file.ownerLarkAppId}, caller ${ownerLarkAppId}`);
    }
    const prev = file.results[triggerId];
    if (prev?.status === 'completed') return 'already_completed';
    file.ownerLarkAppId = ownerLarkAppId;
    file.results[triggerId] = {
      status: 'failed',
      createdAt: prev?.createdAt ?? failedAt,
      failedAt,
      errorCode: 'trigger_failed',
      reason: 'turn_terminal',
      terminalErrorCode,
    };
    if (!file.latestTriggerId) file.latestTriggerId = triggerId;
    saveStrict(sessionId, file);
    return 'written_failed';
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

/** STRICT variant of `lookup`: ONLY a genuinely absent file (ENOENT) or an
 *  absent trigger id yields `undefined`. A present-but-unreadable file
 *  (EIO/EACCES), corrupt JSON, or invalid shape THROWS. Use this wherever a
 *  soft "no record" would be misread as "no terminal outcome" and drive a
 *  fail-OPEN action — e.g. the codex-app recovery fence, which must NOT replay a
 *  keyed turn just because its durable `failed(dispatch_unknown)` proof happens
 *  to be transiently unreadable (the soft `load()` folds that into `{}` and the
 *  accepted ledger entry would re-enter the recovery snapshot). Fail-closed:
 *  the caller aborts the fork and retries at the next seam. */
export function lookupStrict(sessionId: string, triggerId?: string): {
  triggerId: string;
  result: PersistedAsyncTriggerResult;
  ownerLarkAppId?: string;
} | undefined {
  const file = loadStrict(sessionId); // ENOENT → empty; present-but-unreadable/corrupt/bad-shape → throws
  const resolved = triggerId || file.latestTriggerId;
  if (!resolved) return undefined;
  const result = file.results[resolved];
  if (result === undefined) return undefined; // plain-object file with no such trigger → genuine absent
  // Present BUT malformed (null / non-object / invalid status) is NOT "absent":
  // reading it as "no terminal" would fail-open and replay. Fail-closed → throw.
  if (!isValidPersistedResult(result)) {
    throw new Error(`corrupt async-trigger result (invalid shape) for ${sessionId}/${resolved}`);
  }
  return { triggerId: resolved, result, ownerLarkAppId: file.ownerLarkAppId };
}

/** Delete a session's persisted async results (called on session close). */
export function deleteResults(sessionId: string): void {
  const fp = getFilePath(sessionId);
  try { if (existsSync(fp)) unlinkSync(fp); } catch { /* ignore */ }
}
