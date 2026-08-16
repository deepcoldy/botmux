/**
 * Idempotency dispatch lease keyed by a caller-provided `options.idempotencyKey`
 * (scoped per owning bot). The lease answers exactly ONE question: "may I
 * dispatch this turn?" — it does NOT define what a caller sees as the terminal
 * outcome. That terminal outcome lives in async-trigger-store (pending /
 * completed / failed:dispatch_unknown), which trigger-result reads directly.
 * Separating the two means correctness never depends on closeSession succeeding
 * or on a second tombstone file (see PR #776 review 4878071011).
 *
 * States: reserved (claimed, not yet dispatched) → attempting (durably written
 * BEFORE any fork/worker IPC side effect — commit-unknown). There is no
 * "dispatched"/"completed" lease state: completion is proven by async-trigger
 * store, and an attempting lease is a permanent "do-not-redispatch" fence.
 *
 * CONCURRENCY. rename(2) gives an atomic REPLACE, not a compare-and-swap. Every
 * mutation therefore runs inside withFileLockSync(recordPath) (cross-process,
 * per-key): read → verify full immutable identity + revision/state → durable
 * atomic write, all under the lock. `atomicWriteFileSync` (tmp+fsync+rename,
 * failure PRESERVES the old file) is used everywhere — never unlink→link, which
 * could erase the only commit-unknown fence on an I/O failure.
 *
 * OWNERSHIP. (ownerLarkAppId, key) scoping + `ownerBootId` (this daemon process)
 * + monotonic `revision`. Cross-bot reads are rejected fail-closed. Older-boot
 * takeover of a `reserved` lease is safe under the repo's "one daemon per bot"
 * invariant (daemon.ts): a different ownerBootId for the same bot means the
 * previous process, which cannot still be advancing this lease.
 *
 * FAIL-CLOSED. Any ambiguous I/O / corruption on the claim path THROWS — the
 * caller rolls back the just-created session and returns 5xx before dispatch.
 */
import { readFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export type IdempotencyState = 'reserved' | 'attempting';

/** Which dispatch seam a lease governs. `fresh` = a fresh async-virtual session
 *  (one lease → one throwaway session, #776). `turn` = a follow-up turn on an
 *  EXISTING, potentially long-lived SHARED session (#71). The kind is an
 *  UNFORGEABLE domain separator baked into the on-disk key derivation, NOT a
 *  user-supplied string: a caller cannot craft a `fresh` key that collides with
 *  a `turn` lease (or vice-versa) because the kind participates in the file hash.
 *  Reconcile also reads it to avoid fresh-only teardown (closeSession) on a turn
 *  lease whose session is shared and must survive. Absent on disk = legacy
 *  pre-#71 record → treated as `fresh` (the only kind that existed then). */
export type IdempotencyKind = 'fresh' | 'turn';

export interface IdempotencyRecord {
  ownerLarkAppId: string;
  sessionId: string;
  triggerId: string;
  requestHash: string;
  ownerBootId: string;
  revision: number;
  state: IdempotencyState;
  createdAt: number;
  updatedAt: number;
  /** Dispatch seam this lease governs (see IdempotencyKind). Omitted on legacy
   *  pre-#71 records → read as 'fresh'. */
  kind?: IdempotencyKind;
}

export type ClaimResult =
  | { kind: 'won'; record: IdempotencyRecord }
  | { kind: 'existing'; record: IdempotencyRecord };

export class IdempotencyConflictError extends Error {
  constructor(public readonly existing: IdempotencyRecord) {
    super('idempotency key already used with a different request payload');
    this.name = 'IdempotencyConflictError';
  }
}

function baseDir(): string {
  return join(config.session.dataDir, 'idempotency');
}

/** Per-owner subdirectory: sha256(owner). Owner-PARTITIONED layout so a boot
 *  reconcile can enumerate ONLY its own bot's leases — a foreign (other-bot)
 *  corrupt lease then lives under a different subdir and can never block this
 *  bot's startup (the filename `sha256(owner\0key)` alone can't recover the
 *  owner from unparseable JSON, so a flat dir + throwOnCorrupt was a cross-bot
 *  startup DoS — codex #776 round-4 finding #4). */
function ownerDir(ownerLarkAppId: string): string {
  const ownerHash = createHash('sha256').update(ownerLarkAppId).digest('hex');
  return join(baseDir(), ownerHash);
}

/** Filename = <ownerDir>/sha256(owner \0 [kind \0] key).json. The kind participates
 *  in the digest as an UNFORGEABLE domain separator: a `fresh` key and a `turn`
 *  key with the same string land on DIFFERENT files, so a caller cannot forge a
 *  fresh `idempotencyKey` that collides with a `turn:` lease (codex #818 P1). The
 *  NUL separators keep the digest collision-free.
 *
 *  BACKWARD COMPAT: `fresh` reproduces the EXACT pre-#71 digest `sha256(owner \0
 *  key)` (no kind segment at all), so leases written by older builds keep their
 *  path across upgrade. Only the new `turn` kind inserts a `kind \0` segment. A
 *  user-supplied fresh key can't reach the turn keyspace because it never gets
 *  the `turn\0` prefix injected here — the kind is a trusted call-site argument,
 *  not derived from the key string. */
function fileFor(ownerLarkAppId: string, key: string, kind: IdempotencyKind = 'fresh'): string {
  const h = createHash('sha256').update(ownerLarkAppId).update('\0');
  if (kind !== 'fresh') h.update(kind).update('\0');
  const digest = h.update(key).digest('hex');
  return join(ownerDir(ownerLarkAppId), `${digest}.json`);
}

function ensureDirFor(fp: string): void {
  const dir = dirname(fp);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Acquire the per-key file lock, ensuring the record's OWNER subdir exists
 *  first so withFileLockSync can create its `<path>.lock` sibling there. All
 *  mutators route through here so the lock and the record live in a
 *  materialized directory. */
function withKeyLock<T>(fp: string, fn: () => T): T {
  ensureDirFor(fp);
  return withFileLockSync(fp, fn);
}

/** Read + validate. undefined only when ABSENT. Present-but-corrupt THROWS
 *  (on the claim path an unreadable record is NOT provably absent). */
function readRecord(fp: string): IdempotencyRecord | undefined {
  if (!existsSync(fp)) return undefined;
  const data = JSON.parse(readFileSync(fp, 'utf-8')) as IdempotencyRecord;
  if (
    !data || typeof data !== 'object'
    || typeof data.ownerLarkAppId !== 'string'
    || typeof data.sessionId !== 'string'
    || typeof data.triggerId !== 'string'
    || typeof data.requestHash !== 'string'
    || typeof data.ownerBootId !== 'string'
    || typeof data.revision !== 'number'
    || (data.state !== 'reserved' && data.state !== 'attempting')
  ) {
    throw new Error(`corrupt idempotency record: ${fp}`);
  }
  return data;
}

function writeRecord(fp: string, rec: IdempotencyRecord): void {
  ensureDirFor(fp);
  atomicWriteFileSync(fp, JSON.stringify(rec, null, 2), { durable: true, followTargetSymlink: false });
}

/** True iff two records share the immutable identity fields (everything a CAS
 *  must pin besides the mutable state/revision/updatedAt). */
function sameIdentity(a: IdempotencyRecord, b: {
  ownerLarkAppId: string; sessionId: string; triggerId: string; requestHash: string; ownerBootId: string;
}): boolean {
  return a.ownerLarkAppId === b.ownerLarkAppId
    && a.sessionId === b.sessionId
    && a.triggerId === b.triggerId
    && a.requestHash === b.requestHash
    && a.ownerBootId === b.ownerBootId;
}

/** Non-locking read for the pre-check in trigger-session (a fast reject before
 *  creating a session). Owner mismatch → undefined. Corrupt → THROWS. The
 *  authoritative decision is always re-taken under the lock in claim/takeover. */
export function lookup(ownerLarkAppId: string, key: string, kind: IdempotencyKind = 'fresh'): IdempotencyRecord | undefined {
  const rec = readRecord(fileFor(ownerLarkAppId, key, kind));
  if (!rec) return undefined;
  if (rec.ownerLarkAppId !== ownerLarkAppId) return undefined;
  return rec;
}

/**
 * Claim (owner, key) for a fresh `reserved` lease, or return the existing one —
 * all inside the per-key lock (read → decide → durable write is atomic wrt other
 * daemons/boots). Throws on corrupt/IO (fail-closed) and on payload conflict.
 */
export function claim(input: {
  ownerLarkAppId: string; sessionId: string; triggerId: string;
  requestHash: string; ownerBootId: string; key: string; now: number; kind?: IdempotencyKind;
}): ClaimResult {
  const kind: IdempotencyKind = input.kind ?? 'fresh';
  const fp = fileFor(input.ownerLarkAppId, input.key, kind);
  return withKeyLock(fp, () => {
    const existing = readRecord(fp);
    if (existing) {
      if (existing.ownerLarkAppId !== input.ownerLarkAppId) throw new Error('idempotency record owner mismatch');
      if (existing.requestHash !== input.requestHash) throw new IdempotencyConflictError(existing);
      return { kind: 'existing', record: existing };
    }
    const rec: IdempotencyRecord = {
      ownerLarkAppId: input.ownerLarkAppId, sessionId: input.sessionId, triggerId: input.triggerId,
      requestHash: input.requestHash, ownerBootId: input.ownerBootId,
      revision: 1, state: 'reserved', createdAt: input.now, updatedAt: input.now,
      ...(kind !== 'fresh' ? { kind } : {}),
    };
    writeRecord(fp, rec);
    return { kind: 'won', record: rec };
  });
}

/**
 * Take over an OLDER-boot `reserved` lease with a fresh reserved lease (new
 * session/trigger), OR return the existing record if it's no longer a takeover
 * target — all under the lock, re-reading current state (never trusting the
 * caller's stale `from`). Returns won|existing so the caller handles a loss like
 * a claim loss (close its new session, don't fork). Throws on conflict/IO.
 *
 *  - absent now → won (fresh claim).
 *  - present, still the SAME older-boot reserved (identity+revision match) → won (replace).
 *  - present, same payload but changed (attempting / newer revision / different
 *    boot) → existing (someone advanced it; reuse, don't take over).
 *  - present, different payload → conflict.
 */
export function takeover(input: {
  ownerLarkAppId: string; key: string; expect: IdempotencyRecord;
  sessionId: string; triggerId: string; requestHash: string; ownerBootId: string; now: number; kind?: IdempotencyKind;
}): ClaimResult {
  const kind: IdempotencyKind = input.kind ?? 'fresh';
  const fp = fileFor(input.ownerLarkAppId, input.key, kind);
  return withKeyLock(fp, () => {
    const current = readRecord(fp);
    if (!current) {
      const rec: IdempotencyRecord = {
        ownerLarkAppId: input.ownerLarkAppId, sessionId: input.sessionId, triggerId: input.triggerId,
        requestHash: input.requestHash, ownerBootId: input.ownerBootId,
        revision: 1, state: 'reserved', createdAt: input.now, updatedAt: input.now,
        ...(kind !== 'fresh' ? { kind } : {}),
      };
      writeRecord(fp, rec);
      return { kind: 'won', record: rec };
    }
    if (current.ownerLarkAppId !== input.ownerLarkAppId) throw new Error('idempotency record owner mismatch');
    if (current.requestHash !== input.requestHash) throw new IdempotencyConflictError(current);
    // Only replace the EXACT older-boot reserved lease we saw. Anything else
    // (advanced to attempting, bumped revision, or now owned by a live boot) is
    // reused, not seized.
    const stillTakeoverTarget =
      current.state === 'reserved'
      && current.revision === input.expect.revision
      && current.ownerBootId === input.expect.ownerBootId
      && current.ownerBootId !== input.ownerBootId
      && sameIdentity(current, input.expect);
    if (!stillTakeoverTarget) {
      return { kind: 'existing', record: current };
    }
    const rec: IdempotencyRecord = {
      ownerLarkAppId: input.ownerLarkAppId, sessionId: input.sessionId, triggerId: input.triggerId,
      requestHash: input.requestHash, ownerBootId: input.ownerBootId,
      revision: current.revision + 1, state: 'reserved', createdAt: current.createdAt, updatedAt: input.now,
      ...(kind !== 'fresh' ? { kind } : {}),
    };
    writeRecord(fp, rec);
    return { kind: 'won', record: rec };
  });
}

/** CAS a record to a new state under the lock. Verifies full identity + revision
 *  before writing (rejects a stale/foreign writer). Returns the written record. */
export function transition(
  ownerLarkAppId: string, key: string, from: IdempotencyRecord,
  patch: { state: IdempotencyState; now: number }, kind: IdempotencyKind = 'fresh',
): IdempotencyRecord {
  const fp = fileFor(ownerLarkAppId, key, kind);
  return withKeyLock(fp, () => {
    const current = readRecord(fp);
    if (!current) throw new Error('idempotency transition: record vanished');
    if (current.revision !== from.revision || !sameIdentity(current, from)) {
      throw new Error(`idempotency CAS conflict: on-disk record changed under expected revision ${from.revision}`);
    }
    const next: IdempotencyRecord = { ...current, state: patch.state, revision: current.revision + 1, updatedAt: patch.now };
    writeRecord(fp, next);
    return next;
  });
}

/** Delete a file, treating ONLY ENOENT as "already gone". EIO/EROFS/EACCES etc.
 *  mean the file may still exist — the caller must NOT proceed as if released,
 *  so we throw (finding: a swallowed unlink error left a reserved lease stuck to
 *  a closed session). */
function strictUnlink(fp: string): void {
  try { unlinkSync(fp); }
  catch (err: any) { if (err?.code !== 'ENOENT') throw err; }
}

/** Compare-and-remove: delete the lease ONLY if it still matches `expect`
 *  (identity + revision + state) under the lock. Used to release a `reserved`
 *  lease we created but abandoned before dispatch. Returns a discriminated
 *  RemoveByPathResult (removed | absent | changed) — NOT a boolean — so the
 *  barrier-release caller can tell a clean release (retryable) apart from "the
 *  disk already advanced to attempting under me" (must durably terminalize, not
 *  delete) instead of swallowing both (finding #1). A lock-internal re-read
 *  corruption or an ambiguous unlink error (EIO/EROFS/…) THROWS — the caller
 *  must be able to trust that `removed` means the lease is truly released. */
export function compareAndRemove(ownerLarkAppId: string, key: string, expect: IdempotencyRecord, kind: IdempotencyKind = 'fresh'): RemoveByPathResult {
  return compareAndRemoveByPath(fileFor(ownerLarkAppId, key, kind), expect);
}

/** Enumerate the leases owned by a SINGLE bot (boot reconcile is owner-scoped).
 *  Reads only `idempotency/<sha256(owner)>/` — a foreign bot's corrupt lease
 *  lives under a different subdir and is never even opened here, so it can't
 *  block this owner's startup (finding #4). By default a corrupt file under THIS
 *  owner is logged + skipped; with `throwOnCorrupt`, a corrupt OWN lease THROWS
 *  (the reconcile can't prove it converged, so it must fail-closed rather than
 *  silently skip a possibly-unconverged attempting fence). */
export function listAllForOwner(
  ownerLarkAppId: string,
  opts: { throwOnCorrupt?: boolean } = {},
): Array<{ file: string; record: IdempotencyRecord }> {
  const dir = ownerDir(ownerLarkAppId);
  if (!existsSync(dir)) return [];
  const out: Array<{ file: string; record: IdempotencyRecord }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const fp = join(dir, name);
    try {
      const rec = readRecord(fp);
      // Defence-in-depth: the dir is already owner-partitioned, but a stray file
      // whose stamped owner disagrees is not ours to touch — skip it.
      if (rec && rec.ownerLarkAppId === ownerLarkAppId) out.push({ file: fp, record: rec });
    } catch (err) {
      if (opts.throwOnCorrupt) throw new Error(`unreadable idempotency lease ${fp}: ${(err as Error).message}`);
      logger.warn(`[idempotency] skipping unreadable lease ${fp}: ${err}`);
    }
  }
  return out;
}

/** Result of a reconcile-time compare-and-remove-by-path:
 *  - removed:  on-disk record matched the snapshot and was deleted (converged).
 *  - absent:   nothing on disk (already gone — converged, nothing to do).
 *  - changed:  the record advanced/changed under us (carries the CURRENT record
 *              so the caller can RECLASSIFY it by its real identity/state/boot
 *              instead of falsely declaring the sweep converged). `sameIdentity`
 *              distinguishes "MY exact lease merely advanced its state/revision"
 *              (e.g. reserved→attempting: a crossed commit-unknown fence I own)
 *              from "a DIFFERENT winner replaced it" (takeover/re-claim: a new
 *              session/trigger/boot). The two demand opposite handling — the
 *              former is a local terminal, the latter must be deferred to the
 *              actual winner and never faked as a local terminal (codex #776
 *              round-6 findings #2/#3). */
export type RemoveByPathResult =
  | { kind: 'removed' }
  | { kind: 'absent' }
  | { kind: 'changed'; current: IdempotencyRecord; sameIdentity: boolean };

/** Reconcile-only compare-and-remove BY PATH (reconcile enumerated the file via
 *  listAllForOwner and holds a snapshot record; the plaintext key isn't
 *  recoverable from the hashed filename). Re-reads under the lock and removes
 *  ONLY if the on-disk record still matches the snapshot's full identity +
 *  revision + state — so a stale reserved snapshot can NOT delete a fence that
 *  has since advanced to `attempting` (finding: old sweep erasing a crossed
 *  commit-unknown barrier).
 *
 *  Returns a discriminated result rather than a boolean so the reconcile can
 *  tell "converged (removed/absent)" apart from "changed under me" and act on
 *  the latter (finding #2: a bare `false` folded both the changed case AND a
 *  lock-internal corruption into a single value the caller ignored, declaring a
 *  non-convergence a success). The `changed` result carries `sameIdentity` so
 *  the caller never mistakes a DIFFERENT winner's record for its own advanced
 *  fence (findings #2/#3). A lock-internal re-read corruption or an ambiguous
 *  unlink error THROWS (fail-closed — the reconcile aborts startup rather than
 *  bind while a lease is in an unprovable state). */
export function compareAndRemoveByPath(fp: string, expect: IdempotencyRecord): RemoveByPathResult {
  return withKeyLock(fp, () => {
    const current = readRecord(fp); // corrupt now → THROWS (never blind-delete, never fold to a success)
    if (!current) return { kind: 'absent' };
    if (current.revision !== expect.revision || current.state !== expect.state || !sameIdentity(current, expect)) {
      // Advanced/changed under us — hand it back for reclassification, marking
      // whether it is STILL our exact immutable identity (only the mutable
      // state/revision moved) or a wholly different winner replaced the slot.
      return { kind: 'changed', current, sameIdentity: sameIdentity(current, expect) };
    }
    strictUnlink(fp); // throws on EIO/EROFS/… (never a silent success)
    return { kind: 'removed' };
  });
}
