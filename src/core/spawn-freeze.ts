/**
 * Ops-declared CLI spawn barrier.
 *
 * A maintenance script — credential refresh, `claude` upgrade, workspace
 * rebuild — declares a freeze by writing `<dataDir>/spawn-freeze.json`, and
 * every daemon reads that declaration immediately before it would start a CLI.
 * While the declaration is effective `forkWorker` queues at most one cold spawn
 * per logical session and replays it on release, so a user's message is delayed
 * instead of lost.
 *
 * The file is data, never code: a declaration can only ask for "no new CLI
 * until T", it can never make the daemon execute anything. That keeps the
 * barrier usable by plain shell scripts and keeps its blast radius shaped like
 * a timeout instead of an extension point.
 *
 * Three independent expiries bound it, and every read failure is fail-open:
 *
 *  1. the declared `deadline`,
 *  2. the declaring process (`pid`) exiting, and
 *  3. a hard cap measured from the file's mtime.
 *
 * The cap deserves a note on what it can and cannot do. mtime is not content,
 * but it is still writable by whoever owns the file (`touch -t`), and a symlink
 * would let the declaration borrow some other file's timestamps — so the reader
 * refuses symlinks and refuses a future mtime outright instead of clamping it
 * (clamping to `now` would slide the window forward on every read, i.e. exactly
 * the permanent freeze the cap exists to prevent). What remains is that a live
 * process can keep re-declaring; that is not a hole, it is the same authority
 * as holding a legitimate freeze. The cap's job is bounding an ABANDONED
 * declaration — `kill -9` before the cleanup trap, power loss — and it does.
 *
 * A freeze must never be able to wedge the fleet. Not starting CLIs for a few
 * seconds is cheap; never starting them again is an outage — so anything
 * ambiguous (missing file, unreadable, unparseable, out-of-range) resolves to
 * "no freeze".
 *
 * Unlike the device-isolation lease (`device-isolation-activation.ts`), which
 * is an in-memory lease acquired over authenticated IPC from every ONLINE
 * daemon, this barrier lives on disk. That is deliberate: a daemon that boots
 * *during* the window reads the same file and freezes itself, which a lease
 * handed out before the boot can never cover. The two compose — `forkWorker`
 * defers when either one applies.
 */
import { lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBotmuxDataDir } from './data-dir.js';

export const SPAWN_FREEZE_FILENAME = 'spawn-freeze.json';

/** Upper bound on how long one declaration may hold the barrier, measured from
 *  the file's mtime. A script that dies between writing the file and its own
 *  cleanup trap — `kill -9`, power loss — cannot freeze the fleet for longer
 *  than this even if it declared a deadline years out. */
export const SPAWN_FREEZE_HARD_CAP_MS = 10 * 60_000;

/** How far ahead of `now` an mtime may sit before we stop believing it. Covers
 *  ordinary clock skew / filesystem timestamp granularity; anything beyond it is
 *  a timestamp nobody legitimately produces, and honoring it would hand the
 *  writer an unbounded freeze. */
export const SPAWN_FREEZE_MTIME_SKEW_MS = 60_000;

/** How often a deferred spawn re-checks the declaration. Polling (rather than
 *  fs.watch) keeps this portable and cheap: the timer only runs while at least
 *  one spawn is actually parked. */
export const SPAWN_FREEZE_POLL_MS = 1_000;

/** Longest `reason` we accept. It lands in logs, cards and `--status`. */
const MAX_REASON_LENGTH = 120;
const MAX_SCOPE_ENTRIES = 64;
const MAX_FILE_BYTES = 8 * 1024;

/** On-disk shape. Written by `botmux freeze`, read by every daemon. */
export interface SpawnFreezeDeclaration {
  /** Why new CLIs are blocked. Shown to operators; never parsed for meaning. */
  reason: string;
  /** Epoch ms after which the declaration stops applying. */
  deadline: number;
  /** Declaring process. When it is gone the barrier lifts immediately, so a
   *  crashed script self-heals long before `deadline`. */
  pid?: number;
  /** Reply once per chat while deferring, instead of silently delaying. Worth
   *  it for multi-minute windows, noise for a five-second one. */
  notify?: boolean;
  /** Absent / empty `larkAppIds` = every bot on this host. */
  scope?: { larkAppIds?: string[] };
}

/** A declaration that has been read, validated and found to still apply. */
export interface ActiveSpawnFreeze {
  reason: string;
  /** As declared. */
  deadline: number;
  /** `min(deadline, mtime + hard cap)` — when the barrier really lifts. */
  effectiveUntil: number;
  notify: boolean;
  /** Undefined = fleet-wide. */
  larkAppIds?: string[];
  declaredByPid?: number;
  /** Identity of this declaration, used to scope one-shot notices. */
  freezeId: string;
}

export interface SpawnFreezeDeps {
  dataDir?: () => string;
  now?: () => number;
  /** EPERM means "exists but not ours to signal" — that is still alive. */
  processAlive?: (pid: number) => boolean;
  /** Release-poll interval. Only tests override it (production always uses
   *  `SPAWN_FREEZE_POLL_MS`); a tiny value keeps them on real timers, which is
   *  what the replay path — `setInterval` handing off to `setImmediate` —
   *  actually runs on. */
  pollMs?: number;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function resolveDeps(deps: SpawnFreezeDeps = {}): Required<SpawnFreezeDeps> {
  return {
    dataDir: deps.dataDir ?? (() => resolveBotmuxDataDir()),
    now: deps.now ?? (() => Date.now()),
    processAlive: deps.processAlive ?? defaultProcessAlive,
    pollMs: deps.pollMs && deps.pollMs > 0 ? deps.pollMs : SPAWN_FREEZE_POLL_MS,
  };
}

export function spawnFreezePath(deps: SpawnFreezeDeps = {}): string {
  return join(resolveDeps(deps).dataDir(), SPAWN_FREEZE_FILENAME);
}

function normalizeScope(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('scope.larkAppIds must be an array');
  const ids = value
    .filter((id): id is string => typeof id === 'string')
    .map(id => id.trim())
    .filter(id => id.length > 0 && id.length <= 64);
  if (ids.length !== value.length) throw new Error('scope.larkAppIds has invalid entries');
  if (ids.length > MAX_SCOPE_ENTRIES) throw new Error('scope.larkAppIds too long');
  // An explicitly empty array means the same thing as no scope at all
  // (fleet-wide); collapsing it here keeps `spawnFreezeApplies` trivial.
  return ids.length > 0 ? ids : undefined;
}

/**
 * Validate a parsed declaration. Throws on anything malformed so the single
 * catch in `readActiveSpawnFreeze` can turn every failure into fail-open.
 */
export function parseSpawnFreezeDeclaration(value: unknown): SpawnFreezeDeclaration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('declaration must be an object');
  }
  const record = value as Record<string, unknown>;
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  if (!reason || reason.length > MAX_REASON_LENGTH) throw new Error('invalid reason');
  const deadline = record.deadline;
  if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline <= 0) {
    throw new Error('invalid deadline');
  }
  if (record.notify !== undefined && typeof record.notify !== 'boolean') {
    throw new Error('invalid notify');
  }
  let pid: number | undefined;
  if (record.pid !== undefined) {
    if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
      throw new Error('invalid pid');
    }
    pid = record.pid;
  }
  const scopeValue = record.scope;
  let larkAppIds: string[] | undefined;
  if (scopeValue !== undefined && scopeValue !== null) {
    if (typeof scopeValue !== 'object' || Array.isArray(scopeValue)) throw new Error('invalid scope');
    larkAppIds = normalizeScope((scopeValue as Record<string, unknown>).larkAppIds);
  }
  return {
    reason,
    deadline,
    ...(pid !== undefined ? { pid } : {}),
    ...(record.notify === true ? { notify: true } : {}),
    ...(larkAppIds ? { scope: { larkAppIds } } : {}),
  };
}

/**
 * Read the declaration and decide whether it still applies. Returns null — "no
 * freeze" — for a missing file and for every possible failure: an unreadable
 * or oversized file, malformed JSON, a passed deadline, a dead declarer, or a
 * declaration held past the hard cap.
 */
export function readActiveSpawnFreeze(deps: SpawnFreezeDeps = {}): ActiveSpawnFreeze | null {
  const { dataDir, now, processAlive } = resolveDeps(deps);
  const path = join(dataDir(), SPAWN_FREEZE_FILENAME);
  try {
    // lstat, not stat: a symlink would let the declaration inherit an arbitrary
    // file's mtime (and thus escape the hard cap), so it is refused outright.
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const at = now();
    // A future mtime cannot be honored and must not be clamped to `now` either:
    // clamping would re-anchor the cap on every read and never expire.
    if (stat.mtimeMs > at + SPAWN_FREEZE_MTIME_SKEW_MS) return null;
    const declaration = parseSpawnFreezeDeclaration(JSON.parse(readFileSync(path, 'utf-8')));
    const effectiveUntil = Math.min(declaration.deadline, stat.mtimeMs + SPAWN_FREEZE_HARD_CAP_MS);
    if (effectiveUntil <= at) return null;
    if (declaration.pid !== undefined && !processAlive(declaration.pid)) return null;
    return {
      reason: declaration.reason,
      deadline: declaration.deadline,
      effectiveUntil,
      notify: declaration.notify === true,
      ...(declaration.scope?.larkAppIds ? { larkAppIds: declaration.scope.larkAppIds } : {}),
      ...(declaration.pid !== undefined ? { declaredByPid: declaration.pid } : {}),
      freezeId: `${declaration.reason}:${declaration.deadline}:${Math.round(stat.mtimeMs)}`,
    };
  } catch {
    // Fail-open, deliberately silent: this runs on every spawn, and a missing
    // file is the overwhelmingly common case.
    return null;
  }
}

/** True when a freeze covers this bot (no scope = the whole host). */
export function spawnFreezeApplies(freeze: ActiveSpawnFreeze, larkAppId?: string): boolean {
  if (!freeze.larkAppIds) return true;
  if (!larkAppId) return false;
  return freeze.larkAppIds.includes(larkAppId);
}

/** The freeze in effect for one bot, or null. */
export function activeSpawnFreezeFor(
  larkAppId?: string,
  deps: SpawnFreezeDeps = {},
): ActiveSpawnFreeze | null {
  const freeze = readActiveSpawnFreeze(deps);
  if (!freeze) return null;
  return spawnFreezeApplies(freeze, larkAppId) ? freeze : null;
}

interface DeferredSpawn {
  larkAppId?: string;
  replay: () => void;
}

const deferredSpawns = new Map<string, DeferredSpawn>();
let pollTimer: NodeJS.Timeout | null = null;
let noticeFreezeId: string | null = null;
const noticedChats = new Set<string>();

function stopPoll(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function flushReleasedSpawns(deps: SpawnFreezeDeps = {}): void {
  for (const [sessionId, entry] of [...deferredSpawns.entries()]) {
    // Per-entry, because a scoped freeze can lift for one bot while another
    // declaration still covers a different one.
    if (activeSpawnFreezeFor(entry.larkAppId, deps)) continue;
    deferredSpawns.delete(sessionId);
    setImmediate(entry.replay);
  }
  if (deferredSpawns.size === 0) stopPoll();
}

function ensurePoll(deps: SpawnFreezeDeps = {}): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => flushReleasedSpawns(deps), resolveDeps(deps).pollMs);
  pollTimer.unref?.();
}

/**
 * Park a cold spawn while a freeze applies, and return the freeze that caused
 * it (null = not frozen, caller proceeds).
 *
 * Only the FIRST request per logical session is queued: later turns are
 * already retained by the session's own pending-input machinery, and replaying
 * several fork requests would kill and replace the first new worker. Same
 * invariant as `deferWorkerSpawnDuringDeviceIsolation`.
 */
export function deferSpawnDuringFreeze(
  input: { sessionId: string; larkAppId?: string; replay: () => void },
  deps: SpawnFreezeDeps = {},
): ActiveSpawnFreeze | null {
  const freeze = activeSpawnFreezeFor(input.larkAppId, deps);
  if (!freeze) return null;
  if (!deferredSpawns.has(input.sessionId)) {
    deferredSpawns.set(input.sessionId, { larkAppId: input.larkAppId, replay: input.replay });
  }
  ensurePoll(deps);
  return freeze;
}

/** Drop a parked spawn without replaying it (session closed while frozen). */
export function forgetDeferredSpawn(sessionId: string): void {
  deferredSpawns.delete(sessionId);
  if (deferredSpawns.size === 0) stopPoll();
}

export function deferredSpawnCount(): number {
  return deferredSpawns.size;
}

/**
 * One-shot gate for the "maintenance in progress" reply: true the first time a
 * given chat asks during a given declaration. Without this a busy group gets
 * one notice per message; with it the group is told once and then simply waits.
 * State resets when the declaration changes, so the next window speaks again.
 */
export function shouldAnnounceSpawnFreeze(freeze: ActiveSpawnFreeze, chatKey: string): boolean {
  if (!freeze.notify) return false;
  if (noticeFreezeId !== freeze.freezeId) {
    noticeFreezeId = freeze.freezeId;
    noticedChats.clear();
  }
  if (noticedChats.has(chatKey)) return false;
  noticedChats.add(chatKey);
  return true;
}

/** Atomically publish a declaration. Same-directory temp + rename so a reader
 *  never observes a half-written file. */
export function writeSpawnFreeze(
  declaration: SpawnFreezeDeclaration,
  deps: SpawnFreezeDeps = {},
): string {
  const parsed = parseSpawnFreezeDeclaration(declaration);
  const path = spawnFreezePath(deps);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** Remove the declaration. Idempotent — releasing a freeze that already
 *  expired must not fail a maintenance script's cleanup trap. */
export function clearSpawnFreeze(deps: SpawnFreezeDeps = {}): boolean {
  const path = spawnFreezePath(deps);
  try {
    statSync(path);
  } catch {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}

/** Test-only: production state is driven entirely by the file and the timer. */
export function resetSpawnFreezeStateForTest(): void {
  deferredSpawns.clear();
  stopPoll();
  noticeFreezeId = null;
  noticedChats.clear();
}
