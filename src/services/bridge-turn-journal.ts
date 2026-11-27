/**
 * Durable journal of PENDING (not yet terminalized) Lark bridge turns.
 *
 * The Claude-bridge attribution queue (`BridgeTurnQueue`) lives in worker
 * memory: when the worker dies mid-turn (daemon restart / upgrade / crash),
 * every pending mark is lost, and on respawn the bridge baselines the
 * transcript to EOF — so the interrupted turn's user line AND whatever
 * assistant text the model produced before the kill are silently skipped.
 * The user gets neither a `botmux send` (the model never reached it) nor the
 * transcript-driven fallback (nothing left to harvest). This journal closes
 * that gap:
 *
 *   - the worker appends an entry when it marks a Lark turn (delivery time),
 *     recording everything the queue needs to re-create the mark PLUS the
 *     consumed transcript offset at that moment;
 *   - the entry is removed at every turn-terminal outcome (emitted,
 *     suppressed, dropped, expired);
 *   - on respawn, `bridgeAbsorbBaseline` consults the journal instead of
 *     blindly baselining to EOF: surviving entries are re-marked and the
 *     transcript is re-drained from the recorded offset, so the interrupted
 *     turn's output is attributed and delivered through the NORMAL fallback
 *     gate (send-marker dedup still applies — `turn-sends` markers persist
 *     across restarts).
 *
 * Removal happens BEFORE the final_output IPC is sent (clear-at-pop): if the
 * worker dies in between, the answer is lost rather than duplicated — the
 * daemon-side dedupe key does not survive restarts, so duplicating would be
 * the worse failure.
 *
 * The whole file is rewritten atomically (tmp + rename) on every mutation;
 * the pending set is tiny (type-ahead depth, single digits), so this is
 * cheaper and simpler than an append-only log with compaction.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { isJsonObject, readJsonFileSoft } from '../utils/json-file.js';
import { canHandoffFinalOutput, type FinalOutputSnapshot } from './final-output-handoff.js';
import type { TrustedCaller } from '../types.js';
import { sameTrustedPrincipal } from '../core/active-turn-authority.js';

export interface BridgeTurnJournalEntry {
  turnId: string;
  /** Admission identity only; the original full-input hash still has to match
   * a real user record before this restored member gains native settlement. */
  nativeInstantInputCaller?: TrustedCaller;
  /** A native first input was marked before its lazy rollout existed. This
   * is admission data only and is excluded from ordinary transcript recovery. */
  nativeInstantPendingProcess?: { pid: number; birth: string };
  /** Exact native user record already attributed before a persistent reattach. */
  nativeUserProof?: { uuid: string; hash: string; timestampMs: number; trajectoryOffset: number };
  /** Only newly admitted turns under the negotiated protocol opt in. */
  handoffVersion?: 1;
  pendingFinal?: FinalOutputSnapshot;
  /** Ordinary missing-final warning awaiting daemon persistence/delivery ACK.
   * Such an entry is recovery-only and must never restore a CLI business turn. */
  pendingNotice?: {
    noticeId: string;
    message: string;
    createdAtMs: number;
    /** Display-only retirement after an already delivered/submit-noticed turn. */
    silent?: boolean;
  };
  dispatchAttempt?: number;
  /** Admission-frozen mode for this exact turn. Absence is disabled and keeps
   *  journals written by older Botmux versions byte-compatible on read. */
  linkRefMode?: 'observe' | 'enabled';
  /** Wall-clock millis of the original mark — restored verbatim so the
   *  send-marker window and the split cutoff keep their original bounds. */
  markTimeMs: number;
  fingerprint?: string;
  /** Full-input digest for driver-proved spelling aliases. Older journals
   * omit it and cannot use an alias as exact-input evidence. */
  inputTextHash?: string;
  /** Digest of the whole normalised input, so a restored mark can still prove
   * a record is exactly its input. Older journals omit it. */
  wholeInputHash?: string;
  /** A later whole-input record already passed this unstarted mark. Recovery
   * restores the mark as passed (so the successor cannot be replayed into it)
   * and uses this observed transcript floor plus the advanced byte cursor to
   * distinguish old rows from its own still-late record. */
  passedBySuccessor?: { replayFloorMs: number };
  contentNormalized?: string;
  /** Transcript file the mark was armed against. Restore is scoped to the
   *  SAME file — a rotation between generations makes attribution unsafe. */
  jsonlPath: string;
  /** Consumed transcript offset when the mark was armed. The turn's user
   *  line can only exist at/after this byte, so restore re-drains from here
   *  instead of re-reading the whole file. Always a line boundary. */
  offsetAtMark: number;
  /** Set when a later CLI generation of the same worker process took the
   *  entry over: the turn's in-memory carryover or restart note is queued to
   *  be written into that generation, and is marked again when it is. Until
   *  then this entry is the turn's only durable record, so a restore treats it
   *  as written into the claiming generation (#2727). */
  claimedAtMs?: number;
  /** Plain IM inputs proven to share one native execution. This attribution
   * survives a checkpoint after the earlier queue heads were superseded. It
   * is revalidated against the native transcript identity when restored. */
  mergedExecution?: {
    sourceTurnId: string;
    sourceSessionId?: string;
    supersededTurnIds: string[];
    nativeInstantSupersededTurns?: Array<{
      turnId: string;
      nativeInstantInputCaller: TrustedCaller;
      nativeUserProof: { uuid: string; hash: string; timestampMs: number };
    }>;
  };
}

/** Persist no credentials or envelope fields and never turn a scheduled/bot
 * identity into an ordinary human by stripping its source. */
export function nativeInstantJournalCaller(value: unknown): TrustedCaller | undefined {
  if (!isJsonObject(value) || value.senderType !== 'user' || value.source !== undefined
    || value.taskContinuation !== undefined || value.taskId !== undefined) return;
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256;
  if (!validId(value.requestLarkAppId)
    || (value.requestUserOpenId !== undefined && !validId(value.requestUserOpenId))
    || (value.requestUserUnionId !== undefined && !validId(value.requestUserUnionId))
    || (!validId(value.requestUserOpenId) && !validId(value.requestUserUnionId))) return;
  return Object.freeze({ senderType: 'user', requestLarkAppId: value.requestLarkAppId,
    ...(value.requestUserOpenId ? { requestUserOpenId: value.requestUserOpenId } : {}),
    ...(value.requestUserUnionId ? { requestUserUnionId: value.requestUserUnionId } : {}) });
}

/** Entries older than this are dropped at restore instead of re-marked: a
 *  partial answer from days ago posted into a thread that has long moved on
 *  is noise, not recovery. */
export const BRIDGE_TURN_RESTORE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Restart recovery is a best-effort fallback, not permission to load an
 * arbitrarily large append-only transcript into one JavaScript string. Keep
 * the replay window well below V8's platform-dependent MAX_STRING_LENGTH and
 * let the worker baseline to EOF with an explicit warning when an old journal
 * cannot provide a sufficiently recent byte offset. */
export const BRIDGE_TURN_RECOVERY_MAX_BYTES = 64 * 1024 * 1024;

export type BridgeTurnRecoveryPlan =
  | { kind: 'recover'; fromOffset: number; recoveryBytes: number }
  | {
      kind: 'skip';
      reason: 'no-restorable-turns' | 'invalid-file-size' | 'invalid-offset' | 'range-too-large';
      fromOffset: number;
      recoveryBytes: number;
      maxBytes: number;
    };

/** Decide whether the worker may safely drain the journal recovery range in
 * one pass. New journals capture the transcript cursor at mark time, so even a
 * multi-gigabyte rollout normally replays only the current turn's tail. Old
 * journals used offset zero; those fail open to an EOF baseline instead of
 * crashing the worker while converting a >512 MiB Buffer to a V8 string. */
export function planBridgeTurnRecovery(
  entries: readonly BridgeTurnJournalEntry[],
  fileSize: number,
  maxBytes: number = BRIDGE_TURN_RECOVERY_MAX_BYTES,
): BridgeTurnRecoveryPlan {
  const safeFileSize = Number.isSafeInteger(fileSize) && fileSize >= 0 ? fileSize : 0;
  const safeMaxBytes = Number.isSafeInteger(maxBytes) && maxBytes >= 0
    ? maxBytes
    : BRIDGE_TURN_RECOVERY_MAX_BYTES;
  if (entries.length === 0) {
    return {
      kind: 'skip', reason: 'no-restorable-turns', fromOffset: safeFileSize,
      recoveryBytes: 0, maxBytes: safeMaxBytes,
    };
  }
  if (safeFileSize !== fileSize) {
    return {
      kind: 'skip', reason: 'invalid-file-size', fromOffset: safeFileSize,
      recoveryBytes: 0, maxBytes: safeMaxBytes,
    };
  }
  const offsets = entries.map(entry => entry.offsetAtMark);
  if (offsets.some(offset => !Number.isSafeInteger(offset) || offset < 0 || offset > fileSize)) {
    return {
      kind: 'skip', reason: 'invalid-offset', fromOffset: fileSize,
      recoveryBytes: 0, maxBytes: safeMaxBytes,
    };
  }
  const fromOffset = Math.min(...offsets);
  const recoveryBytes = fileSize - fromOffset;
  if (recoveryBytes > safeMaxBytes) {
    return {
      kind: 'skip', reason: 'range-too-large', fromOffset, recoveryBytes,
      maxBytes: safeMaxBytes,
    };
  }
  return { kind: 'recover', fromOffset, recoveryBytes };
}

/** Bound on tracked entries — pathological mark storms must not grow the
 *  journal unboundedly. Oldest entries are shed first (they are also the
 *  first to fail the restore age gate). */
const MAX_JOURNAL_ENTRIES = 32;

interface BridgeTurnJournalFile {
  version: 1;
  pending: BridgeTurnJournalEntry[];
}

export function readBridgeTurnJournal(path: string): BridgeTurnJournalEntry[] {
  // 缺失 / 损坏 / 形状不符 → []。损坏的文件被隔离为 .corrupt-*（而不是被下一次
  // writeBridgeTurnJournal 覆盖），见 utils/json-file.ts。
  const parsed = readJsonFileSoft<BridgeTurnJournalFile | null>(path, {
    fallback: () => null,
    validate: (v): v is BridgeTurnJournalFile =>
      isJsonObject(v) && v.version === 1 && Array.isArray(v.pending),
    label: 'bridge-turn-journal',
  });
  if (!parsed) return [];
  return parsed.pending.filter(entry =>
    typeof entry?.turnId === 'string'
    && typeof entry?.markTimeMs === 'number'
    && typeof entry?.jsonlPath === 'string'
    && typeof entry?.offsetAtMark === 'number'
    // Invalid passed metadata must drop the entry, never sanitize it into an
    // ordinary old-cursor mark that could replay and duplicate its successor.
    && (entry?.passedBySuccessor === undefined
      || (isJsonObject(entry.passedBySuccessor)
        && Number.isFinite(entry.passedBySuccessor.replayFloorMs)
        && entry.passedBySuccessor.replayFloorMs >= 0))
    && (entry?.linkRefMode === undefined
      || entry.linkRefMode === 'observe'
      || entry.linkRefMode === 'enabled'))
    .map(entry => {
      if (entry.pendingFinal && (!canHandoffFinalOutput(entry.pendingFinal.output)
        || !/^[a-f0-9]{64}$/.test(entry.pendingFinal.intentId)
        || !/^[a-f0-9]{64}$/.test(entry.pendingFinal.fingerprint)
        || entry.pendingFinal.output.turnId !== entry.turnId)) {
        throw new Error('Invalid pending final handoff journal');
      }
      if (entry.pendingNotice && (!/^[a-f0-9]{32}$/.test(entry.pendingNotice.noticeId)
        || typeof entry.pendingNotice.message !== 'string'
        || (!entry.pendingNotice.message && entry.pendingNotice.silent !== true)
        || Buffer.byteLength(entry.pendingNotice.message) > 8 * 1024
        || !Number.isFinite(entry.pendingNotice.createdAtMs))) {
        throw new Error('Invalid pending bridge notice journal');
      }
      const { mergedExecution, claimedAtMs, inputTextHash, wholeInputHash, nativeInstantInputCaller, nativeInstantPendingProcess, ...rest } = entry;
      const nativeCaller = entry.dispatchAttempt === undefined ? nativeInstantJournalCaller(nativeInstantInputCaller) : undefined;
      const pendingProcess = nativeCaller && entry.turnId.startsWith('om_') && entry.jsonlPath === ''
        && entry.offsetAtMark === 0 && isJsonObject(nativeInstantPendingProcess)
        && Number.isSafeInteger(nativeInstantPendingProcess.pid) && nativeInstantPendingProcess.pid > 0
        && typeof nativeInstantPendingProcess.birth === 'string' && /^[0-9]+$/.test(nativeInstantPendingProcess.birth)
        && typeof wholeInputHash === 'string' && /^[a-f0-9]{64}$/.test(wholeInputHash)
        ? { pid: nativeInstantPendingProcess.pid as number, birth: nativeInstantPendingProcess.birth } : undefined;
      const plain = {
        ...rest,
        ...(nativeCaller ? { nativeInstantInputCaller: nativeCaller } : {}),
        ...(pendingProcess ? { nativeInstantPendingProcess: pendingProcess } : {}),
        ...(typeof inputTextHash === 'string' && /^[a-f0-9]{64}$/.test(inputTextHash) ? { inputTextHash } : {}),
        ...(typeof wholeInputHash === 'string' && /^[a-f0-9]{64}$/.test(wholeInputHash) ? { wholeInputHash } : {}),
        ...(typeof claimedAtMs === 'number' && Number.isFinite(claimedAtMs) ? { claimedAtMs } : {}),
      };
      // Invalid optional merge evidence must not discard the pending answer
      // or invent delivery credit. Older journals have no such field.
      if (!isJsonObject(mergedExecution)
        || typeof mergedExecution.sourceTurnId !== 'string' || !mergedExecution.sourceTurnId
        || (mergedExecution.sourceSessionId !== undefined && typeof mergedExecution.sourceSessionId !== 'string')
        || !Array.isArray(mergedExecution.supersededTurnIds)
        || !mergedExecution.supersededTurnIds.length
        || !mergedExecution.supersededTurnIds.every(id => typeof id === 'string' && id.length > 0)) return plain;
      const nativeInstantSupersededTurns = nativeCaller && mergedExecution.sourceSessionId
        && Array.isArray(mergedExecution.nativeInstantSupersededTurns)
        && mergedExecution.nativeInstantSupersededTurns.length <= MAX_JOURNAL_ENTRIES
        ? mergedExecution.nativeInstantSupersededTurns.flatMap(member => {
          if (!isJsonObject(member) || !mergedExecution.supersededTurnIds.includes(member.turnId)) return [];
          const caller = nativeInstantJournalCaller(member.nativeInstantInputCaller);
          const proof = member.nativeUserProof;
          if (!caller || !sameTrustedPrincipal(nativeCaller, caller) || !isJsonObject(proof)
            || typeof proof.uuid !== 'string' || !proof.uuid || proof.uuid.length > 2_048
            || typeof proof.hash !== 'string' || !/^[a-f0-9]{64}$/.test(proof.hash)
            || typeof proof.timestampMs !== 'number' || !Number.isFinite(proof.timestampMs) || proof.timestampMs < 0) return [];
          return [{ turnId: member.turnId as string, nativeInstantInputCaller: caller,
            nativeUserProof: { uuid: proof.uuid, hash: proof.hash, timestampMs: proof.timestampMs } }];
        }) : [];
      return { ...plain, mergedExecution: {
        sourceTurnId: mergedExecution.sourceTurnId,
        ...(mergedExecution.sourceSessionId ? { sourceSessionId: mergedExecution.sourceSessionId } : {}),
        supersededTurnIds: [...new Set(mergedExecution.supersededTurnIds)],
        ...(nativeInstantSupersededTurns.length ? { nativeInstantSupersededTurns } : {}),
      } };
    });
}

export function writeBridgeTurnJournal(path: string, pending: BridgeTurnJournalEntry[], acknowledgedIntentId?: string, acknowledgedNoticeId?: string): void {
  // Takeover/pruning callers may know only CLI marks. Until their exact ACK,
  // persisted final snapshots and notice obligations survive those operations.
  // ACKs settle obligations independently. If one obligation on a combined
  // entry is acknowledged, pin only the other one; re-pinning the old row
  // wholesale would resurrect the acknowledged final/notice on the next ACK.
  const pinned = readBridgeTurnJournal(path).flatMap(entry => {
    if (!entry.pendingFinal && !entry.pendingNotice) return [];
    const remaining = { ...entry };
    if (remaining.pendingFinal?.intentId === acknowledgedIntentId) delete remaining.pendingFinal;
    if (remaining.pendingNotice?.noticeId === acknowledgedNoticeId) delete remaining.pendingNotice;
    return remaining.pendingFinal || remaining.pendingNotice ? [remaining] : [];
  });
  pending = [...pending];
  for (const entry of pinned) {
    const index = pending.findIndex(item => item.turnId === entry.turnId && item.dispatchAttempt === entry.dispatchAttempt);
    if (index < 0) pending.push(entry);
    else pending[index] = { ...entry, ...pending[index] };
  }
  const retained = pending.filter(entry => !!entry.pendingFinal || !!entry.pendingNotice || entry.handoffVersion === 1);
  if (retained.length > MAX_JOURNAL_ENTRIES) throw new Error('final_output_handoff_backpressure');
  const slots = MAX_JOURNAL_ENTRIES - retained.length;
  const ordinary = pending.filter(entry => !entry.pendingFinal && !entry.pendingNotice && entry.handoffVersion !== 1);
  const selected = new Set([...retained, ...(slots > 0 ? ordinary.slice(-slots) : [])]);
  const bounded = pending.filter(entry => selected.has(entry));
  const payload: BridgeTurnJournalFile = { version: 1, pending: bounded };
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o600, followTargetSymlink: false,
    durable: pending.some(entry => entry.handoffVersion === 1 || entry.pendingNotice) });
}

export function stageBridgeFinalOutput(path: string, snapshot: FinalOutputSnapshot, allowFinalSnapshot = false): void {
  const entries = readBridgeTurnJournal(path);
  let entry = entries.find(item => item.turnId === snapshot.output.turnId && item.dispatchAttempt === undefined);
  // Capacity may have prevented the original mark from reaching disk. The
  // completed native output itself is sufficient recovery data; never replay
  // this final-only entry as a business input or transcript mark.
  if (!entry && allowFinalSnapshot) {
    entry = { turnId: snapshot.output.turnId, handoffVersion: 1, markTimeMs: Date.now(), jsonlPath: 'final-output-snapshot', offsetAtMark: 0, pendingFinal: snapshot };
    entries.push(entry);
  }
  if (!entry || entry.handoffVersion !== 1) throw new Error('final_output_handoff_missing_admission');
  if (entry.pendingFinal && entry.pendingFinal.fingerprint !== snapshot.fingerprint) throw new Error('final_output_handoff_conflict');
  entry.pendingFinal = snapshot;
  writeBridgeTurnJournal(path, entries);
}

export function acknowledgeBridgeFinalOutput(path: string, snapshot: FinalOutputSnapshot): void {
  const entries = readBridgeTurnJournal(path);
  const entry = entries.find(item => item.pendingFinal?.intentId === snapshot.intentId);
  if (!entry) return;
  if (entry.pendingFinal?.fingerprint !== snapshot.fingerprint) throw new Error('final_output_handoff_ack_mismatch');
  writeBridgeTurnJournal(path, entries.filter(item => item !== entry), snapshot.intentId);
}

/** Atomically turn a missing-final owner into a durable notice obligation.
 * The entry remains pinned until the daemon acknowledges its own durable record. */
export function stageBridgeTurnNotice(
  path: string,
  input: { turnId: string; noticeId: string; message: string; createdAtMs: number; silent?: boolean },
): void {
  if (!/^[a-f0-9]{32}$/.test(input.noticeId) || (!input.message && input.silent !== true) || Buffer.byteLength(input.message) > 8 * 1024
    || !Number.isFinite(input.createdAtMs)) throw new Error('invalid_bridge_notice');
  const entries = readBridgeTurnJournal(path);
  const index = entries.findIndex(item => item.turnId === input.turnId && item.dispatchAttempt === undefined);
  const existing = index >= 0 ? entries[index] : undefined;
  if (existing?.pendingNotice && existing.pendingNotice.noticeId !== input.noticeId) throw new Error('bridge_notice_conflict');
  const pendingNotice = { noticeId: input.noticeId, message: input.message, createdAtMs: input.createdAtMs,
    ...(input.silent ? { silent: true } : {}) };
  if (existing?.pendingFinal) {
    existing.pendingNotice = pendingNotice;
  } else {
    // A notice-only entry must be unusable by every business recovery path,
    // including Doubao's direct nativeUserProof lookup during live-pane attach.
    const noticeOnly: BridgeTurnJournalEntry = {
      turnId: input.turnId, markTimeMs: existing?.markTimeMs ?? input.createdAtMs,
      jsonlPath: 'structured-notice', offsetAtMark: 0, pendingNotice,
    };
    if (index < 0) entries.push(noticeOnly);
    else entries[index] = noticeOnly;
  }
  writeBridgeTurnJournal(path, entries);
}

/** ACK cleanup is replay-safe. A failed write leaves the worker copy pending. */
export function acknowledgeBridgeTurnNotice(path: string, turnId: string, noticeId: string): void {
  const entries = readBridgeTurnJournal(path);
  const entry = entries.find(item => item.pendingNotice?.noticeId === noticeId);
  if (!entry) return;
  if (entry.turnId !== turnId) throw new Error('bridge_notice_ack_mismatch');
  let remaining = entries.filter(item => item !== entry);
  if (entry.pendingFinal) {
    const finalOnly = { ...entry };
    delete finalOnly.pendingNotice;
    remaining.push(finalOnly);
  }
  if (remaining.length === 0) { rmSync(path, { force: true }); return; }
  writeBridgeTurnJournal(path, remaining, entry.pendingFinal?.intentId, noticeId);
}

export function appendBridgeTurnJournalEntry(path: string, entry: BridgeTurnJournalEntry): void {
  const pending = readBridgeTurnJournal(path)
    .filter(existing => !(existing.turnId === entry.turnId && existing.dispatchAttempt === entry.dispatchAttempt));
  pending.push(entry);
  writeBridgeTurnJournal(path, pending);
}

export function removeBridgeTurnJournalEntry(
  path: string,
  turnId: string,
  dispatchAttempt?: number,
): void {
  const pending = readBridgeTurnJournal(path);
  const remaining = pending.filter(entry =>
    entry.pendingFinal || entry.pendingNotice || !(entry.turnId === turnId
      && (dispatchAttempt === undefined || entry.dispatchAttempt === dispatchAttempt)));
  if (remaining.length === pending.length) return;
  if (remaining.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  writeBridgeTurnJournal(path, remaining);
}

export function clearBridgeTurnJournal(path: string): void {
  const pinned = readBridgeTurnJournal(path).filter(entry => !!entry.pendingFinal || !!entry.pendingNotice);
  if (pinned.length > 0) { writeBridgeTurnJournal(path, pinned); return; }
  rmSync(path, { force: true });
}

/** Slack for comparing a mark against a process start read from the OS: Linux
 *  derives it from whole-second `btime` plus clock ticks, `ps -o lstart=` has
 *  one-second resolution. A mark is taken right before its input is written
 *  into a running CLI, seconds after that process started, so the slack only
 *  ever keeps a borderline entry. */
export const LIVE_CLI_START_TOLERANCE_MS = 2_000;

/** Pure restore filter: which journal entries may be re-marked on this
 *  worker generation? Scoped to the same transcript file (rotation between
 *  generations makes offset+fingerprint attribution unsafe) and bounded by
 *  age (stale partials are noise).
 *
 *  `liveCliStartedAtMs`: when the worker re-attaches a CLI that survived the
 *  previous worker, an entry marked before that process started was written
 *  into an earlier CLI generation that was replaced inside the old worker.
 *  Unless that replacement claimed it (its takeover was still queued when the
 *  old worker died), nothing will ever answer it again; restoring it would
 *  rewind the replay to that old mark and re-deliver everything the session
 *  answered since (#2727). */
export function selectRestorableBridgeTurns(
  entries: readonly BridgeTurnJournalEntry[],
  opts: { currentJsonlPath: string; nowMs?: number; maxAgeMs?: number; liveCliStartedAtMs?: number },
): BridgeTurnJournalEntry[] {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? BRIDGE_TURN_RESTORE_MAX_AGE_MS;
  const liveCliStartedAtMs = opts.liveCliStartedAtMs;
  return entries
    .filter(entry => !entry.pendingNotice && !entry.nativeInstantPendingProcess && !!entry.jsonlPath
      && entry.jsonlPath === opts.currentJsonlPath
      && nowMs - entry.markTimeMs <= maxAgeMs
      && (liveCliStartedAtMs === undefined
        || (entry.claimedAtMs ?? entry.markTimeMs) >= liveCliStartedAtMs - LIVE_CLI_START_TOLERANCE_MS)
      // Only PLAIN Lark IM turns are restorable. Durable turns
      // (dispatchAttempt set) have their own cross-restart recovery owner (the
      // daemon's persisted queuedActivation* write-ahead + receipt
      // auto-redispatch); restoring one from the journal would double-deliver
      // (recovered partial + re-dispatched attempt share a turnId but carry
      // different lastUuids, so the daemon dedupe can't collapse them). The
      // write side already skips journaling them; this is belt-and-braces for a
      // journal file left behind by a pre-fix build across an upgrade.
      && entry.dispatchAttempt === undefined)
    .sort((a, b) => a.markTimeMs - b.markTimeMs);
}

/** A new CLI generation starts in the same worker process: every entry the
 *  retired generation(s) left — marked, or last claimed, at or before the
 *  retirement — is claimed by the new one at `claimedAtMs`. Nothing is
 *  dropped here: until the new generation writes the carried-over input or
 *  restart note (which marks the turn again), the entry is the turn's only
 *  durable record, and a worker killed in that window must leave it to the
 *  next process. Returns the entries and how many were claimed. */
export function claimRetiredGenerationEntries(
  entries: readonly BridgeTurnJournalEntry[],
  retiredAtMs: number,
  claimedAtMs: number,
): { entries: BridgeTurnJournalEntry[]; claimed: number } {
  let claimed = 0;
  const next = entries.map(entry => {
    if ((entry.claimedAtMs ?? entry.markTimeMs) > retiredAtMs) return entry;
    claimed++;
    return { ...entry, claimedAtMs };
  });
  return { entries: next, claimed };
}

/** After the claiming generation wrote an input: a claimed entry whose turn
 *  is no longer queued in memory was either taken over — its re-mark already
 *  replaced it — or never will be (no carryover, no restart note under its
 *  id). Left on disk, the latter would be restored by the next worker process
 *  as a turn IT interrupted, rewinding the replay to its old mark (#2727).
 *  Keeps unclaimed entries and claims whose turn is still waiting to be
 *  written. */
export function entriesStillOwned(
  entries: readonly BridgeTurnJournalEntry[],
  queuedTurnIds: ReadonlySet<string>,
): BridgeTurnJournalEntry[] {
  return entries.filter(entry => entry.claimedAtMs === undefined || queuedTurnIds.has(entry.turnId));
}

/**
 * One-shot latch that confines journal restore to a worker process's FIRST
 * bridge baseline. Extracted from worker.ts (like InflightInputTracker) so the
 * "restore at most once, only on the first baseline" rule is unit-testable.
 *
 * Why it exists: the journal recovers a plain-IM turn orphaned by a
 * CROSS-process death (daemon restart / worker crash) — there the whole worker
 * is new and no other recovery owner survives. But an IN-worker CLI restart
 * (crash-respawn / cwd-move / durable lease expiry) keeps the process alive, so
 * its InflightInputTracker carryover ALREADY re-delivers the interrupted plain
 * IM input as a full fresh answer. If the journal ALSO restored that turn on the
 * post-restart baseline, the recovered partial and the fresh answer — same
 * turnId, different lastUuid — would both reach Lark (the daemon dedupe can't
 * collapse them). The worker arms this latch on every watcher teardown, so only
 * the first baseline (the one with no competing recovery owner) may restore.
 */
export class BridgeRestoreGate {
  private consumed = false;

  /** True only on the first call after construction — the process's first
   *  baseline. Every later call (a post-restart baseline) returns false. Does
   *  NOT itself consume the latch: an empty-journal first baseline must still
   *  arm it via markGenerationRetired so a later restart can't restore. */
  mayRestoreOnThisBaseline(): boolean {
    return !this.consumed;
  }

  /** Arm the latch: a CLI generation has ended (watcher torn down), so any
   *  future baseline is an in-worker restart, never first-baseline recovery.
   *  Idempotent. */
  markGenerationRetired(): void {
    this.consumed = true;
  }
}
