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
import { readFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface NativeExecutionStart {
  workerGeneration: number;
  nativeSessionId: string;
  nativeTurnId: string;
  startedAtMs: number;
  proofKind: 'codex_transcript_start' | 'codex_rpc_turn_start';
}
const validExecutionStart = (value: unknown): value is NativeExecutionStart => {
  if (!value || typeof value !== 'object') return false;
  const v = value as NativeExecutionStart;
  return Number.isSafeInteger(v.workerGeneration) && v.workerGeneration > 0
    && typeof v.nativeSessionId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v.nativeSessionId)
    && typeof v.nativeTurnId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v.nativeTurnId)
    && Number.isFinite(v.startedAtMs) && v.startedAtMs > 0
    && ['codex_transcript_start','codex_rpc_turn_start'].includes(v.proofKind);
};
export interface PersistedAsyncTriggerResult {
  /** Frozen at admission; an absent value preserves historical caller-only delivery. */
  resultDelivery?: 'conversation';
  executionStarted?: NativeExecutionStart;
  /** Receiver ACK, independent of IM reply anchors or an optional dedupe key. */
  inputCommit?: { workerGeneration: number; observedAt: number };
  /** Exact Worker terminal observed before its output was durably captured.
   * Read-side convergence survives restart; it never submits another input. */
  outputPendingTerminal?: { workerGeneration: number; observedAt: number; drainUntil: number };

  status: 'pending' | 'completed' | 'failed' | 'interrupted';
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
  /** A caller-authorized turn-level interrupt was delivered to the exact live
   * worker turn. The session deliberately remains open. */
  interruptedAt?: number;
  /** Per-turn token usage captured at completion (codex-app). Optional — omitted
   *  when the turn produced no coherent usage. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  };
  /** Set ONLY on a still-`pending` result. A codex-app steer group member that
   *  settled as `steer_superseded` (its content merged into a later turn via
   *  native turn/steer) waits for the group's real final instead of completing
   *  empty or hanging. This points at the IMMEDIATE successor's turnId (FIFO
   *  order; N steers form a chain T1→T2→…→Tn). Poll/boot resolution walks the
   *  chain to the first terminal record and mirrors it back onto this turn. The
   *  live daemon normally fans the real final out in-memory before any poll;
   *  this marker is solely the daemon-restart insurance. */
  steerParkedBy?: string;
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
  if (value.resultDelivery !== undefined && value.resultDelivery !== 'conversation') return false;
  if (value.inputCommit !== undefined && (!isPlainObject(value.inputCommit)
    || !Number.isSafeInteger(value.inputCommit.workerGeneration) || Number(value.inputCommit.workerGeneration) <= 0
    || typeof value.inputCommit.observedAt !== 'number' || !Number.isFinite(value.inputCommit.observedAt)
    || !Number.isFinite(new Date(value.inputCommit.observedAt).getTime()))) return false;
  if (value.outputPendingTerminal !== undefined) {
    const terminal = value.outputPendingTerminal;
    if (!isPlainObject(terminal) || !Number.isSafeInteger(terminal.workerGeneration)
      || Number(terminal.workerGeneration) <= 0 || typeof terminal.observedAt !== 'number'
      || !Number.isFinite(terminal.observedAt) || typeof terminal.drainUntil !== 'number'
      || !Number.isFinite(terminal.drainUntil) || terminal.drainUntil !== terminal.observedAt + ASYNC_OUTPUT_DRAIN_MS
      || value.inputCommit && Number(value.inputCommit.workerGeneration) > Number(terminal.workerGeneration)) return false;
  }
  if (value.executionStarted !== undefined && (!validExecutionStart(value.executionStarted)
    || value.inputCommit && (value.inputCommit as {workerGeneration: number}).workerGeneration > value.executionStarted.workerGeneration
    || value.outputPendingTerminal && (value.outputPendingTerminal as {workerGeneration: number}).workerGeneration < value.executionStarted.workerGeneration)) return false;
  const status = value.status;
  if (status !== 'pending' && status !== 'completed' && status !== 'failed' && status !== 'interrupted') return false;
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
  if (status === 'interrupted' && typeof value.interruptedAt !== 'number') return false;
  // steerParkedBy only makes sense on a parked-pending steer member; a present
  // non-string/empty value is a corrupt marker (fail-closed, like the fields
  // above), and it must never ride a terminal record.
  if (value.steerParkedBy !== undefined) {
    if (status !== 'pending' || typeof value.steerParkedBy !== 'string' || value.steerParkedBy.length === 0) return false;
  }
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
  try {
    atomicWriteFileSync(getFilePath(sessionId), JSON.stringify(file, null, 2), { followTargetSymlink: false });
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
export function recordPending(sessionId: string, triggerId: string, createdAt: number, ownerLarkAppId: string, durable = false, resultDelivery?: 'conversation'): void {
  const write = () => {
    const file = durable ? loadStrict(sessionId) : load(sessionId);
    if (durable) {
      if (!ownerLarkAppId || file.ownerLarkAppId && file.ownerLarkAppId !== ownerLarkAppId) {
        throw new Error('async_pending_owner_mismatch');
      }
      const prior = file.results[triggerId];
      if (prior !== undefined) {
        if (!isValidPersistedResult(prior) || prior.status !== 'pending' || prior.createdAt !== createdAt
          || prior.resultDelivery !== resultDelivery) {
          throw new Error('async_pending_identity_conflict');
        }
        return;
      }
    }
    if (ownerLarkAppId) file.ownerLarkAppId = ownerLarkAppId;
    file.results[triggerId] = { status: 'pending', createdAt, ...(resultDelivery ? { resultDelivery } : {}) };
    file.latestTriggerId = triggerId;
    if (durable) saveStrict(sessionId, file);
    else save(sessionId, file);
  };
  if (durable) { ensureDir(); withFileLockSync(getFilePath(sessionId), write); }
  else write();
}

/** Called only after the live Worker's exact input-queue ACK. A missing,
 * foreign or terminal trigger cannot acquire new acceptance evidence. Preserve
 * the first generation; a repeated ACK is observation, never another dispatch. */
export function recordInputCommit(sessionId: string, triggerId: string, ownerLarkAppId: string,
  workerGeneration: number, observedAt = Date.now()): boolean {
  if (!ownerLarkAppId || !Number.isSafeInteger(workerGeneration) || workerGeneration <= 0
    || !Number.isFinite(observedAt) || !Number.isFinite(new Date(observedAt).getTime())) throw new Error('invalid input commit');
  ensureDir();
  return withFileLockSync(getFilePath(sessionId), () => {
    const file = loadStrict(sessionId), prior = file.results[triggerId];
    if (file.ownerLarkAppId !== ownerLarkAppId || !prior) return false;
    if (!isValidPersistedResult(prior)) throw new Error('invalid original trigger');
    if (prior.executionStarted && prior.executionStarted.workerGeneration < workerGeneration) return false;
    if (prior.outputPendingTerminal && prior.outputPendingTerminal.workerGeneration < workerGeneration) return false;
    if (prior.inputCommit) return prior.inputCommit.workerGeneration === workerGeneration;
    if (prior.status !== 'pending') return false;
    file.results[triggerId] = { ...prior, inputCommit: { workerGeneration, observedAt } };
    saveStrict(sessionId, file);
    return true;
  });
}

/** Native start evidence belongs to an exact trigger, not the session's latest
 * status. Queue ACKs and transcript history alone cannot produce this record.
 * The current live worker is attested at IPC admission. A queued input can be
 * admitted by an older worker, so preserve that receipt and bind the separate
 * first execution proof to its actual (same or newer) worker generation. */
export function recordExecutionStarted(sessionId: string, triggerId: string, ownerLarkAppId: string,
  proof: NativeExecutionStart): boolean {
  if (!ownerLarkAppId || !validExecutionStart(proof)) throw new Error('invalid native start');
  ensureDir();
  return withFileLockSync(getFilePath(sessionId), () => {
    const file=loadStrict(sessionId), prior=file.results[triggerId];
    if (file.ownerLarkAppId!==ownerLarkAppId || !prior) return false;
    if (!isValidPersistedResult(prior)) throw new Error('invalid original trigger');
    if (prior.executionStarted) return prior.executionStarted.workerGeneration===proof.workerGeneration
      && prior.executionStarted.nativeSessionId===proof.nativeSessionId && prior.executionStarted.nativeTurnId===proof.nativeTurnId;
    if (prior.status!=='pending' || prior.steerParkedBy
      || prior.inputCommit && prior.inputCommit.workerGeneration>proof.workerGeneration
      || prior.outputPendingTerminal && prior.outputPendingTerminal.workerGeneration<proof.workerGeneration) return false;
    file.results[triggerId]={...prior,executionStarted:{...proof}};saveStrict(sessionId,file);return true;
  });
}

/** Native completion is stronger than screen-idle, but does not prove silence.
 * Wait a bounded period for final-output hydration, then expose an ambiguous
 * no-output outcome from this durable record. A later real final still wins. */
export const ASYNC_OUTPUT_DRAIN_MS = 30_000;
export function recordOutputPendingTerminal(
  sessionId: string, triggerId: string, ownerLarkAppId: string,
  workerGeneration: number, observedAt = Date.now(),
): boolean {
  if (!ownerLarkAppId || !Number.isSafeInteger(workerGeneration) || workerGeneration <= 0
    || !Number.isFinite(observedAt)) throw new Error('invalid output terminal');
  ensureDir();
  return withFileLockSync(getFilePath(sessionId), () => {
    const file = loadStrict(sessionId), prior = file.results[triggerId];
    if (file.ownerLarkAppId !== ownerLarkAppId || !prior) return false;
    if (!isValidPersistedResult(prior)) throw new Error('invalid original trigger');
    if (prior.status !== 'pending' || prior.steerParkedBy) return false;
    if (prior.inputCommit && prior.inputCommit.workerGeneration > workerGeneration) return false;
    if (prior.executionStarted && prior.executionStarted.workerGeneration > workerGeneration) return false;
    if (prior.outputPendingTerminal) return prior.outputPendingTerminal.workerGeneration === workerGeneration;
    file.results[triggerId] = { ...prior, outputPendingTerminal: {
      workerGeneration, observedAt, drainUntil: observedAt + ASYNC_OUTPUT_DRAIN_MS,
    } };
    saveStrict(sessionId, file); return true;
  });
}
function withOutputDrainOutcome(result: PersistedAsyncTriggerResult): PersistedAsyncTriggerResult {
  const terminal = result.outputPendingTerminal;
  if (result.status !== 'pending' || result.steerParkedBy || !terminal || Date.now() < terminal.drainUntil) return result;
  return { ...result, status: 'failed', failedAt: terminal.drainUntil,
    errorCode: 'no_output', reason: 'dispatch_unknown' };
}

/** Commit the original final before publishing an in-memory terminal. Throws on
 * unreadable/corrupt state, foreign ownership or any durable write failure.
 * Returning the canonical record prevents late finals from resurrecting an
 * explicit interrupt/failure, or rewriting an already committed final. */
export function recordCompleted(
  sessionId: string,
  triggerId: string,
  content: string,
  completedAt: number,
  ownerLarkAppId: string,
  usage?: PersistedAsyncTriggerResult['usage'],
): PersistedAsyncTriggerResult {
  ensureDir();
  return withFileLockSync(getFilePath(sessionId), () => {
    const file = loadStrict(sessionId);
    if (ownerLarkAppId && file.ownerLarkAppId && file.ownerLarkAppId !== ownerLarkAppId) {
      throw new Error('async_completion_owner_mismatch');
    }
    if (ownerLarkAppId) file.ownerLarkAppId = ownerLarkAppId;
    const prev = file.results[triggerId];
    if (prev && !isValidPersistedResult(prev)) throw new Error('invalid original trigger');
    if (prev?.status === 'interrupted'
      || (prev?.status === 'failed' && prev.reason === 'turn_terminal')) return prev;
    if (prev?.status === 'completed') {
      if (prev.content !== content) throw new Error('async_completion_content_conflict');
      return prev;
    }
    const result: PersistedAsyncTriggerResult = {
      status: 'completed',
      createdAt: prev?.createdAt ?? completedAt,
      ...(prev?.resultDelivery ? { resultDelivery: prev.resultDelivery } : {}),
      ...(prev?.inputCommit ? { inputCommit: prev.inputCommit } : {}),
      ...(prev?.executionStarted ? { executionStarted: prev.executionStarted } : {}),
      ...(prev?.outputPendingTerminal ? { outputPendingTerminal: prev.outputPendingTerminal } : {}),
      completedAt,
      content,
      ...(usage ? { usage } : {}),
    };
    file.results[triggerId] = result;
    if (!file.latestTriggerId) file.latestTriggerId = triggerId;
    saveStrict(sessionId, file);
    return result;
  });
}

/** Park a PENDING steer-group member behind its immediate FIFO successor.
 *  Restart insurance for HTTP `options.steer` (codex-app native turn/steer):
 *  the live daemon fans the group's merged real final out in-memory; if it dies
 *  in the superseded→real-final window, this durable chain lets the next
 *  trigger-result poll resolve the parked turn by walking `steerParkedBy`.
 *
 *  Completed/failed is stronger evidence and always wins: a non-pending record
 *  is never overwritten. Best-effort save (same durability tier as
 *  recordPending); serialized under the per-session lock against
 *  recordCompleted/recordFailedStrict. */
export function recordSteerParked(
  sessionId: string,
  triggerId: string,
  successorTurnId: string,
  now: number,
  ownerLarkAppId: string,
  requireOriginal = false,
): void {
  ensureDir();
  withFileLockSync(getFilePath(sessionId), () => {
    const file = requireOriginal ? loadStrict(sessionId) : load(sessionId);
    const prev = file.results[triggerId];
    if (requireOriginal) {
      if (!ownerLarkAppId || file.ownerLarkAppId !== ownerLarkAppId || !prev
        || !isValidPersistedResult(prev)) throw new Error('async_steer_recipient_unverified');
      const successor = file.results[successorTurnId];
      if (!successor || !isValidPersistedResult(successor) || successorTurnId === triggerId) {
        throw new Error('async_steer_successor_unverified');
      }
      if (prev.steerParkedBy && prev.steerParkedBy !== successorTurnId) throw new Error('async_steer_successor_changed');
    }
    if (prev && prev.status !== 'pending') return;
    if (ownerLarkAppId) file.ownerLarkAppId = ownerLarkAppId;
    file.results[triggerId] = {
      status: 'pending',
      createdAt: prev?.createdAt ?? now,
      ...(prev?.resultDelivery ? { resultDelivery: prev.resultDelivery } : {}),
      ...(prev?.inputCommit ? { inputCommit: prev.inputCommit } : {}),
      ...(prev?.executionStarted ? { executionStarted: prev.executionStarted } : {}),
      steerParkedBy: successorTurnId,
    };
    if (requireOriginal) saveStrict(sessionId, file);
    else save(sessionId, file);
  });
}

export type SupersedePendingTriggerOutcome =
  | 'superseded'
  | 'already_superseded'
  | 'predecessor_steer_parked'
  | 'predecessor_not_pending'
  | 'successor_not_completed';

/**
 * Terminalize one exact pending trigger only when one exact successor trigger in
 * the same session is durably completed. The caller owns proof of the external
 * causal link (for example a handoff receipt's predecessorReceiptFile); this
 * store deliberately never infers causality from timestamps or trigger order.
 * Later authoritative worker completion or terminal failure may replace this
 * marker through the normal completed-wins persistence contract.
 */
export function supersedePendingTriggerByCompletedSuccessorStrict(
  sessionId: string,
  predecessorTriggerId: string,
  successorTriggerId: string,
  supersededAt: number,
  ownerLarkAppId: string,
): SupersedePendingTriggerOutcome {
  if (!ownerLarkAppId) throw new Error('supersedePendingTriggerByCompletedSuccessorStrict requires ownerLarkAppId');
  if (!predecessorTriggerId || !successorTriggerId || predecessorTriggerId === successorTriggerId) {
    throw new Error('supersedePendingTriggerByCompletedSuccessorStrict requires distinct trigger ids');
  }
  ensureDir();
  return withFileLockSync(getFilePath(sessionId), () => {
    const file = loadStrict(sessionId);
    if (file.ownerLarkAppId && file.ownerLarkAppId !== ownerLarkAppId) {
      throw new Error(`supersedePendingTriggerByCompletedSuccessorStrict owner mismatch: file owned by ${file.ownerLarkAppId}, caller ${ownerLarkAppId}`);
    }
    const predecessor = file.results[predecessorTriggerId];
    const successor = file.results[successorTriggerId];
    if (!isValidPersistedResult(successor) || successor.status !== 'completed') return 'successor_not_completed';
    if (predecessor?.status === 'failed'
      && predecessor.reason === 'turn_terminal'
      && predecessor.terminalErrorCode === `superseded_by_completed_successor:${successorTriggerId}`) {
      return 'already_superseded';
    }
    // Steer owns the parked member's final result, including after a restart.
    if (predecessor?.status === 'pending' && predecessor.steerParkedBy) {
      return 'predecessor_steer_parked';
    }
    const replaceableAmbiguousFailure = predecessor?.status === 'failed'
      && predecessor.reason === 'dispatch_unknown';
    if (predecessor?.status !== 'pending' && !replaceableAmbiguousFailure) return 'predecessor_not_pending';
    file.ownerLarkAppId = ownerLarkAppId;
    file.results[predecessorTriggerId] = {
      status: 'failed',
      createdAt: predecessor.createdAt,
      ...(predecessor.resultDelivery ? { resultDelivery: predecessor.resultDelivery } : {}),
      ...(predecessor.inputCommit ? { inputCommit: predecessor.inputCommit } : {}),
      ...(predecessor.executionStarted ? { executionStarted: predecessor.executionStarted } : {}),
      failedAt: supersededAt,
      errorCode: 'trigger_failed',
      reason: 'turn_terminal',
      terminalErrorCode: `superseded_by_completed_successor:${successorTriggerId}`,
    };
    saveStrict(sessionId, file);
    return 'superseded';
  });
}

/**
 * Record a durable `failed` async outcome (STRICT). This is the authoritative
 * terminal state the idempotency reconcile/barrier writes for a
 * `dispatch_unknown` turn — an at-most-once ambiguous crash that must NOT be
 * re-run. Unlike recordPending's best-effort save, this:
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
    if (prev?.status === 'interrupted') return 'written_failed';
    // An explicit worker terminal is stronger than a later worker-exit
    // `dispatch_unknown`; keep the precise failure while reporting terminal
    // convergence to the caller.
    if (prev?.status === 'failed' && prev.reason === 'turn_terminal') return 'written_failed';
    file.ownerLarkAppId = ownerLarkAppId;
    file.results[triggerId] = {
      status: 'failed',
      createdAt: prev?.createdAt ?? failedAt,
      ...(prev?.resultDelivery ? { resultDelivery: prev.resultDelivery } : {}),
      ...(prev?.inputCommit ? { inputCommit: prev.inputCommit } : {}),
      ...(prev?.executionStarted ? { executionStarted: prev.executionStarted } : {}),
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
    if (prev?.status === 'interrupted') return 'written_failed';
    file.ownerLarkAppId = ownerLarkAppId;
    file.results[triggerId] = {
      status: 'failed',
      createdAt: prev?.createdAt ?? failedAt,
      ...(prev?.resultDelivery ? { resultDelivery: prev.resultDelivery } : {}),
      ...(prev?.inputCommit ? { inputCommit: prev.inputCommit } : {}),
      ...(prev?.executionStarted ? { executionStarted: prev.executionStarted } : {}),
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

/** Persist a user-requested interrupt after the worker has positively confirmed
 * it matched and delivered Ctrl+C to the exact live turn. Completion remains
 * stronger evidence: an already captured final is never replaced. */
export function recordInterruptedStrict(
  sessionId: string,
  triggerId: string,
  interruptedAt: number,
  ownerLarkAppId: string,
): RecordFailedStrictOutcome {
  if (!ownerLarkAppId) throw new Error('recordInterruptedStrict requires ownerLarkAppId');
  ensureDir();
  return withFileLockSync(getFilePath(sessionId), () => {
    const file = loadStrict(sessionId);
    if (file.ownerLarkAppId && file.ownerLarkAppId !== ownerLarkAppId) {
      throw new Error(`recordInterruptedStrict owner mismatch: file owned by ${file.ownerLarkAppId}, caller ${ownerLarkAppId}`);
    }
    const prev = file.results[triggerId];
    if (prev?.status === 'completed') return 'already_completed';
    if (prev?.status === 'interrupted') return 'written_failed';
    file.ownerLarkAppId = ownerLarkAppId;
    file.results[triggerId] = {
      status: 'interrupted',
      createdAt: prev?.createdAt ?? interruptedAt,
      ...(prev?.resultDelivery ? { resultDelivery: prev.resultDelivery } : {}),
      ...(prev?.inputCommit ? { inputCommit: prev.inputCommit } : {}),
      ...(prev?.executionStarted ? { executionStarted: prev.executionStarted } : {}),
      interruptedAt,
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
  return { triggerId: resolved, result: withOutputDrainOutcome(result), ownerLarkAppId: file.ownerLarkAppId };
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
  return { triggerId: resolved, result: withOutputDrainOutcome(result), ownerLarkAppId: file.ownerLarkAppId };
}

/** Walk a durable steer-park chain (T1→T2→…→Tn) from `firstSuccessorTurnId`
 *  to the first TERMINAL successor. Returns undefined when the chain is absent,
 *  ends in a pending record without a pointer, or a hop is missing — the caller
 *  then keeps reporting `running` (the group's real final may simply not be on
 *  disk yet).
 *
 *  No hop COUNT limit: a legitimate steer group can have arbitrarily many
 *  members, and capping the restart-insurance walk would strand early members
 *  (running until session close) only when the daemon restarted mid-group.
 *  Termination is guaranteed instead by a VISITED set: FIFO successors are
 *  always distinct later turns, so a revisit can only come from a corrupt
 *  on-disk cycle, which fails closed (undefined → stay running, never loop). */
export function followSteerParkedChain(
  sessionId: string,
  firstSuccessorTurnId: string,
): {
  triggerId: string;
  result: PersistedAsyncTriggerResult;
  ownerLarkAppId?: string;
} | undefined {
  const visited = new Set<string>();
  let next: string | undefined = firstSuccessorTurnId;
  while (next !== undefined) {
    if (visited.has(next)) return undefined;
    visited.add(next);
    const hit = lookup(sessionId, next);
    if (!hit) return undefined;
    if (hit.result.status === 'completed' || hit.result.status === 'failed' || hit.result.status === 'interrupted') return hit;
    next = hit.result.steerParkedBy;
  }
  return undefined;
}

/** Delete a session's persisted async results (called on session close). */
export function deleteResults(sessionId: string): void {
  const fp = getFilePath(sessionId);
  try { if (existsSync(fp)) unlinkSync(fp); } catch { /* ignore */ }
}
