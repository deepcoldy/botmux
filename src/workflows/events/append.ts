import { promises as fs, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  INLINE_PAYLOAD_MAX_BYTES,
  PayloadRefSchema,
  isPayloadRef,
  parseEvent,
} from './schema.js';
import type { WorkflowEvent } from './schema.js';
import { withFileLock } from '../../utils/file-lock.js';

// ─── Mutex (per-runId append serialization, in-process) ─────────────────────

/**
 * Minimal promise-chain mutex.  Single-process serialization layer.
 */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    try {
      await prior;
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Module-level mutex map keyed by runId.  Codex round 4 fix: a single
 * instance's mutex doesn't protect against two `new EventLog(runId, base)`
 * instances inside the same process — they would each hold a fresh mutex
 * and race on seq assignment.  Sharing the mutex per-runId at module scope
 * closes that hole.  Cross-process is closed by `withFileLock` (below).
 */
const RUN_MUTEXES = new Map<string, Mutex>();
function getRunMutex(runId: string): Mutex {
  let m = RUN_MUTEXES.get(runId);
  if (!m) {
    m = new Mutex();
    RUN_MUTEXES.set(runId, m);
  }
  return m;
}

// ─── Event draft (what callers pass into append) ────────────────────────────

/**
 * What the runtime supplies to `append`.  The append path fills in
 * `eventId` and `schemaVersion`.  Callers must supply `runId`, `type`,
 * `actor`, `payload`, and may optionally pass `timestamp` (defaults to
 * Date.now()) and/or `payloadHash` (only when payload is a ref — see
 * events doc §1.1).
 *
 * The discriminated union over WorkflowEvent distributes through Omit, so
 * each event type's payload shape is preserved at the call site.
 */
export type EventDraft = Omit<WorkflowEvent, 'eventId' | 'schemaVersion' | 'timestamp'> & {
  timestamp?: number;
};

// ─── EventLog ───────────────────────────────────────────────────────────────

export class EventLog {
  readonly runId: string;
  readonly runDir: string;
  readonly eventsFile: string;
  readonly blobDir: string;

  // Cached seq + file metadata for cross-process change detection.
  private seq = 0;
  private seqLoaded = false;
  private cachedMtimeMs = 0;
  private cachedSize = 0;

  constructor(runId: string, baseDir: string) {
    if (!runId) throw new Error('EventLog: runId required');
    if (!baseDir) throw new Error('EventLog: baseDir required');
    this.runId = runId;
    this.runDir = join(baseDir, runId);
    this.eventsFile = join(this.runDir, 'events.ndjson');
    this.blobDir = join(this.runDir, 'blobs');
    if (!existsSync(this.runDir)) mkdirSync(this.runDir, { recursive: true });
    if (!existsSync(this.blobDir)) mkdirSync(this.blobDir, { recursive: true });
  }

  /**
   * Append one event.  Atomic across:
   *   1. all EventLog instances for the same runId in this process
   *      (module-level mutex map), and
   *   2. other OS processes touching the same events file
   *      (`withFileLock` over `events.ndjson.lock`).
   *
   * Codex round 4 finding 1: payload envelope MUST be inline.  Large
   * business data goes through `OutputRef`-shaped fields (e.g.
   * `runCreated.inputRef`, `activitySucceeded.outputRef`); the caller is
   * responsible for writing the blob and passing a fully-formed
   * `OutputRef` inline.  The append path no longer auto-spills payloads —
   * doing so silently broke replay for any ref-payload event because the
   * existing replay projection unconditionally skipped the ref branch.
   *
   * Payload-ref payloads (`{ ref, bytes, schemaVersion }`) are still
   * supported for callers who genuinely need to ref-out the envelope
   * payload (e.g. a custom dashboard projection), but the caller must
   * supply both the blob and `payloadHash` upfront; this path is not
   * exercised by the v0 runtime.
   */
  async append(draft: EventDraft): Promise<WorkflowEvent> {
    return getRunMutex(this.runId).run(() =>
      withFileLock(this.eventsFile, () => this.appendLocked(draft)),
    );
  }

  private async appendLocked(draft: EventDraft): Promise<WorkflowEvent> {
    await this.refreshSeqIfStale();

    const nextSeq = this.seq + 1;
    const timestamp = draft.timestamp ?? Date.now();
    const candidate: Record<string, unknown> = {
      eventId: `${this.runId}-${nextSeq}`,
      runId: this.runId,
      timestamp,
      type: draft.type,
      schemaVersion: 1,
      actor: draft.actor,
      payload: draft.payload,
    };
    if ('payloadHash' in draft && draft.payloadHash !== undefined) {
      candidate.payloadHash = draft.payloadHash;
    }

    // Reject inline payloads that exceed the cap.  The runtime should
    // restructure to use `OutputRef`-shaped fields for large business
    // data; envelope payloads are metadata + small refs only.
    if (!isPayloadRef(draft.payload)) {
      const inlineSize = Buffer.byteLength(JSON.stringify(draft.payload), 'utf-8');
      if (inlineSize > INLINE_PAYLOAD_MAX_BYTES) {
        throw new Error(
          `EventLog(${this.runId}).append: inline payload (${inlineSize} bytes) exceeds ` +
            `INLINE_PAYLOAD_MAX_BYTES (${INLINE_PAYLOAD_MAX_BYTES}).  Restructure large fields ` +
            `to use OutputRef-shaped fields (events doc v0.1.2 §3.1) instead of stuffing them ` +
            `into the envelope payload.`,
        );
      }
    }

    const parsed = parseEvent(candidate);

    const line = JSON.stringify(parsed) + '\n';
    await fs.appendFile(this.eventsFile, line, 'utf-8');

    // Cache update — we just wrote, so size grew.  Stat would also work.
    const stat = await fs.stat(this.eventsFile);
    this.seq = nextSeq;
    this.cachedMtimeMs = stat.mtimeMs;
    this.cachedSize = stat.size;
    this.seqLoaded = true;
    return parsed;
  }

  /**
   * Read all events in append order.  Used by replay (events doc §5.2)
   * and seq recovery on restart.  Returns [] if the log doesn't exist
   * yet.
   *
   * Throws if any line fails schema validation — events doc treats the
   * log as authoritative and corruption should fail loud, not silently
   * skip lines.
   */
  async readAll(): Promise<WorkflowEvent[]> {
    if (!existsSync(this.eventsFile)) return [];
    const content = await fs.readFile(this.eventsFile, 'utf-8');
    const events: WorkflowEvent[] = [];
    let lineNo = 0;
    for (const raw of content.split('\n')) {
      lineNo++;
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
        events.push(parseEvent(obj));
      } catch (err) {
        throw new Error(
          `EventLog(${this.runId}): corrupt event at line ${lineNo}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return events;
  }

  /**
   * Read the blob referenced by a ref-payload event.  Used when a caller
   * elected to spill their own OutputRef payload to disk; not used by
   * envelope-payload paths since v0.1.2 round-4 disallows envelope spill.
   */
  async readBlob(ref: string): Promise<Buffer> {
    return fs.readFile(ref);
  }

  /** Current seq counter — exposed for tests / dashboard. */
  async currentSeq(): Promise<number> {
    return getRunMutex(this.runId).run(() =>
      withFileLock(this.eventsFile, async () => {
        await this.refreshSeqIfStale();
        return this.seq;
      }),
    );
  }

  /**
   * Refresh `this.seq` if the events file has changed since we last loaded.
   * Stat is cheap; full re-scan only fires when the cached mtime/size differ
   * from disk — protects against another process having appended since our
   * last write.
   */
  private async refreshSeqIfStale(): Promise<void> {
    if (!existsSync(this.eventsFile)) {
      this.seq = 0;
      this.seqLoaded = true;
      this.cachedMtimeMs = 0;
      this.cachedSize = 0;
      return;
    }
    const stat = await fs.stat(this.eventsFile);
    if (
      this.seqLoaded &&
      stat.mtimeMs === this.cachedMtimeMs &&
      stat.size === this.cachedSize
    ) {
      return;
    }
    // Rescan from disk.  Linear in events for v0; future optimization
    // could read from end-of-file backwards to find the last seq line.
    const events = await this.readAll();
    let maxSeq = 0;
    for (const e of events) {
      const m = e.eventId.match(/-(\d+)$/);
      if (m) {
        const s = parseInt(m[1], 10);
        if (s > maxSeq) maxSeq = s;
      }
    }
    this.seq = maxSeq;
    this.cachedMtimeMs = stat.mtimeMs;
    this.cachedSize = stat.size;
    this.seqLoaded = true;
  }
}

// ─── Reexport schemas the EventLog returns, for ergonomic call sites ────────

export { PayloadRefSchema, INLINE_PAYLOAD_MAX_BYTES };
export type { WorkflowEvent };
