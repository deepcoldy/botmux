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
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

/** Bound on tracked entries — pathological mark storms must not grow the
 *  journal unboundedly. Oldest entries are shed first (they are also the
 *  first to fail the restore age gate). */
const MAX_JOURNAL_ENTRIES = 32;

interface BridgeTurnJournalFile {
  version: 1;
  pending: BridgeTurnJournalEntry[];
}

export function readBridgeTurnJournal(path: string): BridgeTurnJournalEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as BridgeTurnJournalFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.pending)) return [];
    return parsed.pending.filter(entry =>
      typeof entry?.turnId === 'string'
      && typeof entry?.markTimeMs === 'number'
      && typeof entry?.jsonlPath === 'string'
      && typeof entry?.offsetAtMark === 'number');
  } catch {
    return [];
  }
}

export function writeBridgeTurnJournal(path: string, pending: BridgeTurnJournalEntry[]): void {
  const bounded = pending.length > MAX_JOURNAL_ENTRIES
    ? pending.slice(pending.length - MAX_JOURNAL_ENTRIES)
    : pending;
  const payload: BridgeTurnJournalFile = { version: 1, pending: bounded };
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  renameSync(tmpPath, path);
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
