/**
 * v3 journal — append-only event stream (the run's audit truth).
 *
 * Codex's v1-review blocker #1: v3 is NOT a "only-mutable-STATE" recoverable
 * system.  `journal.ndjson` is the append-only source of audit truth (one JSON
 * object per line, `ts`-stamped) from which `state.ts` materializes the STATE
 * checkpoint.  Concurrency / retry / gate / cancel / failure-root-cause all
 * leave an ordered trail here.
 *
 * Append-only + line-oriented is crash-tolerant only when the next writer
 * repairs an interrupted FINAL line first. Read-only projections may ignore
 * that tail, but appending after it would concatenate two JSON objects and
 * permanently corrupt the history. Every mutation therefore takes the same
 * cross-process journal lock and repairs an unterminated tail before writing
 * the next event.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { fsyncDirectorySyncPortable } from '../../utils/fs-durability.js';
import { withFileLockSync } from '../../utils/file-lock.js';
import type { JournalMutation, StoredEvent, V3Event } from './event-contract.js';
export type {
  GoalAsk,
  GoalAnswer,
  JournalMutation,
  StoredEvent,
  V3ErrorClass,
  V3BlockedRecovery,
  V3Event,
  V3LoopRef,
  V3RunFailureReason,
  V3UncertainHostEffect,
} from './event-contract.js';

function fsyncFile(journalPath: string): void {
  const fd = openSync(journalPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Parse NDJSON while optionally tolerating only the physical unterminated tail. */
function parseJournalText(
  raw: string,
  journalPath: string,
  tolerateTornFinal: boolean,
): StoredEvent[] {
  const lines = raw.split('\n');
  const out: StoredEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as StoredEvent);
    } catch (err) {
      // Only the physical final segment can be torn. An invalid line followed
      // by a newline is committed corruption even when trailing whitespace
      // makes it the last non-empty line.
      if (tolerateTornFinal && i === lines.length - 1 && !raw.endsWith('\n')) break;
      throw new Error(
        `v3 journal corrupted at line ${i + 1} of ${journalPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/**
 * Validate committed records and normalize an unterminated tail before a
 * writer appends. A syntactically complete JSON tail is preserved and sealed
 * with `\n`; an incomplete tail is truncated to the last newline. Repair
 * bytes are fsynced before the next append, and any already-terminated corrupt
 * record fails closed.
 */
function repairJournalTailForMutation(journalPath: string): void {
  if (!existsSync(journalPath)) return;
  // The healthy hot path reads one byte, not the full journal. Runtime and
  // host control paths already replay before deciding what to append; this
  // boundary's extra responsibility is preventing a torn physical tail from
  // being glued to the next record.
  const probeFd = openSync(journalPath, 'r');
  try {
    const size = fstatSync(probeFd).size;
    if (size === 0) return;
    const lastByte = Buffer.allocUnsafe(1);
    readSync(probeFd, lastByte, 0, 1, size - 1);
    if (lastByte[0] === 0x0a) return;
  } finally {
    closeSync(probeFd);
  }

  // Recovery is exceptional, so a full validation/read here is intentional:
  // it proves every committed prefix line before repairing only the tail.
  const raw = readFileSync(journalPath);
  parseJournalText(raw.toString('utf-8'), journalPath, true);
  const lastNewline = raw.lastIndexOf(0x0a);
  const tail = raw.subarray(lastNewline + 1).toString('utf-8');
  let completeJson = false;
  if (tail.trim()) {
    try {
      JSON.parse(tail.trim());
      completeJson = true;
    } catch {
      // A read-only projection may ignore this tail; mutation removes it so
      // the next JSON object can never be glued onto the interrupted record.
    }
  }

  if (completeJson) {
    appendFileSync(journalPath, '\n');
    fsyncFile(journalPath);
  } else {
    const fd = openSync(journalPath, 'r+');
    try {
      ftruncateSync(fd, lastNewline + 1);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  // Conservative: explicitly persist the repair boundary as a whole, even
  // though truncating an existing inode does not normally change its dirent.
  fsyncDirectorySyncPortable(dirname(journalPath));
}

/**
 * Run one read/check/append mutation under the journal's sole lock. Callers
 * such as start-intent use this instead of nesting a file lock around
 * appendEvent (the generic file lock is deliberately non-reentrant).
 */
export function withJournalMutationSync<T>(
  journalPath: string,
  fn: (mutation: JournalMutation) => T,
): T {
  const dir = dirname(journalPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return withFileLockSync(journalPath, () => {
    repairJournalTailForMutation(journalPath);
    let eventsSnapshot: StoredEvent[] | undefined;
    let appended = false;
    let journalExisted = existsSync(journalPath);
    const append = (event: V3Event, options: { durable?: boolean } = {}): StoredEvent => {
      const stored: StoredEvent = { ts: Date.now(), ...event };
      const created = !journalExisted;
      appendFileSync(journalPath, JSON.stringify(stored) + '\n');
      appended = true;
      journalExisted = true;
      if (options.durable) {
        fsyncFile(journalPath);
        if (created) fsyncDirectorySyncPortable(dirname(journalPath));
      }
      return stored;
    };
    return fn({
      get events() {
        // Generic appendEvent never pays a full replay. Atomic read/check/
        // append callers opt in by accessing this lazy snapshot.
        if (appended && eventsSnapshot === undefined) {
          throw new Error('journal mutation events must be read before the first append');
        }
        return eventsSnapshot ??= readJournal(journalPath);
      },
      append,
    });
  });
}

/**
 * Append one event as a single NDJSON line.  Stamps `ts` (epoch ms) at write
 * time.  Creates the parent directory if missing so the very first
 * `runStarted` doesn't require the caller to pre-create the runDir.
 *
 * Synchronous on purpose: the runtime loop must observe its own writes in
 * order, and the journal is the linearization point — an async append would
 * open a window where `decideNext` runs against stale state.
 */
export function appendEvent(journalPath: string, event: V3Event): StoredEvent {
  return withJournalMutationSync(journalPath, ({ append }) => append(event));
}

/**
 * Append an event and force both its bytes and a newly-created journal dirent
 * to stable storage before returning. Reserved for host acknowledgement
 * boundaries (for example `/start` returning HTTP 202) and resource-close
 * proofs that must reach disk before a worker fence is removed. Other hot
 * runtime transitions keep using {@link appendEvent}.
 */
export function appendEventDurable(journalPath: string, event: V3Event): StoredEvent {
  return withJournalMutationSync(journalPath, ({ append }) => append(event, { durable: true }));
}

// ─── Read / replay ────────────────────────────────────────────────────────

/**
 * Read every event in append order.  Tolerates a torn FINAL line (crash
 * mid-append) but throws on any earlier unparseable line — a mid-file parse
 * failure is real corruption, and silently dropping a middle event would
 * desync the replayed state (e.g. a lost `nodeSucceeded` leaves the node
 * looking pending forever), so fail loud instead (codex hardening #11).
 * Returns `[]` if the file does not exist yet (a run that never started).
 */
export function readJournal(journalPath: string): StoredEvent[] {
  if (!existsSync(journalPath)) return [];
  return parseJournalText(readFileSync(journalPath, 'utf-8'), journalPath, true);
}
