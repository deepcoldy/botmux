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

export interface BridgeTurnJournalEntry {
  turnId: string;
  dispatchAttempt?: number;
  /** Wall-clock millis of the original mark — restored verbatim so the
   *  send-marker window and the split cutoff keep their original bounds. */
  markTimeMs: number;
  fingerprint?: string;
  contentNormalized?: string;
  /** Transcript file the mark was armed against. Restore is scoped to the
   *  SAME file — a rotation between generations makes attribution unsafe. */
  jsonlPath: string;
  /** Consumed transcript offset when the mark was armed. The turn's user
   *  line can only exist at/after this byte, so restore re-drains from here
   *  instead of re-reading the whole file. Always a line boundary. */
  offsetAtMark: number;
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
    && typeof entry?.offsetAtMark === 'number');
}

export function writeBridgeTurnJournal(path: string, pending: BridgeTurnJournalEntry[]): void {
  const bounded = pending.length > MAX_JOURNAL_ENTRIES
    ? pending.slice(pending.length - MAX_JOURNAL_ENTRIES)
    : pending;
  const payload: BridgeTurnJournalFile = { version: 1, pending: bounded };
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o600, followTargetSymlink: false });
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
    !(entry.turnId === turnId
      && (dispatchAttempt === undefined || entry.dispatchAttempt === dispatchAttempt)));
  if (remaining.length === pending.length) return;
  if (remaining.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  writeBridgeTurnJournal(path, remaining);
}

export function clearBridgeTurnJournal(path: string): void {
  rmSync(path, { force: true });
}

/** Pure restore filter: which journal entries may be re-marked on this
 *  worker generation? Scoped to the same transcript file (rotation between
 *  generations makes offset+fingerprint attribution unsafe) and bounded by
 *  age (stale partials are noise). */
export function selectRestorableBridgeTurns(
  entries: readonly BridgeTurnJournalEntry[],
  opts: { currentJsonlPath: string; nowMs?: number; maxAgeMs?: number },
): BridgeTurnJournalEntry[] {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? BRIDGE_TURN_RESTORE_MAX_AGE_MS;
  return entries
    .filter(entry => entry.jsonlPath === opts.currentJsonlPath
      && nowMs - entry.markTimeMs <= maxAgeMs
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
