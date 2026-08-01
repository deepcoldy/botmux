/**
 * Ops-declared CLI spawn barrier.
 *
 * A maintenance script — credential refresh, `claude` upgrade, workspace
 * rebuild — declares a freeze by writing `<dataDir>/spawn-freeze.json`, and
 * every daemon reads that declaration immediately before it would start a CLI.
 * While the declaration is effective `forkWorker` parks a session's cold spawn
 * and replays it on release.
 *
 * What that does and does NOT guarantee, precisely — this is a delay, not a
 * drop:
 *
 *  - the FIRST message that would have started a CLI in a session is replayed
 *    after release, so it is delayed rather than dropped;
 *  - a promptless spawn (restore re-attach, warm-up, a start that only exists so
 *    a queued raw command can be written once the CLI is ready) parks like any
 *    other, but a payload-bearing turn SUPERSEDES it, so a warm-up cannot
 *    consume the slot the first real turn needs;
 *  - SUBSEQUENT payload-bearing messages to that same session in the same window
 *    are FOLDED into that one parked spawn (blank-line separated, in arrival
 *    order): only one fork may be replayed — a second would kill and replace the
 *    first new worker — so the turns are merged into it rather than dropped. The
 *    replayed opening therefore carries every message the user sent while
 *    frozen; per-message turn-id attribution collapses to the first turn, which
 *    is the same shape the repo already uses for messages buffered behind a
 *    pending /repo card;
 *  - a daemon restart inside the window loses the parked spawn. The declaration
 *    is on disk; the parked closure is not.
 *
 * Persisting the folded turns across a restart (so even a mid-window daemon
 * bounce loses nothing) would need durable per-turn storage; that is a possible
 * later step, called out rather than papered over. Keep maintenance windows
 * short regardless.
 *
 * `pid` is a cooperative identity, not a security boundary: it is only checked
 * for liveness, so a same-user caller could name somebody else's pid (and one
 * that can write this file could equally pass `--force`). It exists to keep an
 * operator's own scripts from disarming each other, nothing more.
 *
 * Out of scope by definition: `/adopt` sessions. Botmux never started those
 * CLIs (the user did, outside botmux) and re-attaching to one starts no new CLI,
 * so a maintenance window has nothing to protect there.
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
import { linkSync, lstatSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBotmuxDataDir } from './data-dir.js';
import type { CliTurnPayload } from '../types.js';

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

export interface SpawnFreezeDeferral {
  freeze: ActiveSpawnFreeze;
  /** How this request was absorbed:
   *   - `'parked'`      — it became the session's single parked spawn;
   *   - `'folded'`      — the session already had a payload-bearing spawn parked,
   *                       so this turn's content was merged into it (replayed as
   *                       one opening turn, nothing dropped);
   *   - `'superseded'`  — it displaced a promptless spawn (warm-up / re-attach)
   *                       that carried no user turn;
   *   - `'waiting'`     — a promptless spawn arrived behind one already parked;
   *                       nothing to fold, nothing displaced, no user turn to
   *                       acknowledge — the caller stays silent. */
  disposition: 'parked' | 'folded' | 'superseded' | 'waiting';
}

interface DeferredSpawn {
  larkAppId?: string;
  /** A promptless spawn (empty prompt, no structured input) carries no user turn
   *  and may be displaced by one that does. */
  hasPayload: boolean;
  /** Extra payload-bearing turns that arrived while this spawn was parked, in
   *  arrival order. The replay folds them into the opening turn so nothing the
   *  user sent during the window is dropped. Full payloads (not just text) so a
   *  codex-app structured sidecar folds too — it, not `.content`, is what that
   *  CLI actually consumes. */
  foldedTurns: CliTurnPayload[];
  replay: (foldedTurns: CliTurnPayload[]) => void;
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
    const folded = entry.foldedTurns;
    setImmediate(() => entry.replay(folded));
  }
  if (deferredSpawns.size === 0) stopPoll();
}

function ensurePoll(deps: SpawnFreezeDeps = {}): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => flushReleasedSpawns(deps), resolveDeps(deps).pollMs);
  pollTimer.unref?.();
}

/**
 * Park a cold spawn while a freeze applies. Returns null when not frozen (the
 * caller proceeds to spawn), otherwise the freeze plus how THIS request was
 * absorbed.
 *
 * Only one fork per logical session may ever be replayed — replaying two would
 * kill and replace the first new worker. So the FIRST payload-bearing request is
 * parked, and every payload-bearing request after it is FOLDED into that parked
 * spawn (arrival order). The parked replay is handed the folded turns so the
 * opening it replays carries everything the user sent during the window — the
 * same "buffer-then-fold-into-one-opening" shape the /repo-pending path uses.
 *
 * A promptless spawn (warm-up / re-attach) still parks, but it carries no user
 * turn, so the first payload-bearing request DISPLACES it (its payload becomes
 * the new parked spawn; nothing is folded because a promptless spawn has no
 * content worth keeping).
 */
export function deferSpawnDuringFreeze(
  input: {
    sessionId: string;
    larkAppId?: string;
    hasPayload: boolean;
    /** This turn's payload, folded into an already-parked spawn when one exists.
     *  Omitted for promptless spawns. */
    foldTurn?: CliTurnPayload;
    replay: (foldedTurns: CliTurnPayload[]) => void;
  },
  deps: SpawnFreezeDeps = {},
): SpawnFreezeDeferral | null {
  const freeze = activeSpawnFreezeFor(input.larkAppId, deps);
  if (!freeze) return null;
  const existing = deferredSpawns.get(input.sessionId);
  ensurePoll(deps);

  // Nothing parked yet: this request becomes the parked spawn.
  if (existing === undefined) {
    deferredSpawns.set(input.sessionId, {
      larkAppId: input.larkAppId,
      hasPayload: input.hasPayload,
      foldedTurns: [],
      replay: input.replay,
    });
    return { freeze, disposition: 'parked' };
  }

  // A payload-bearing request that arrives behind a promptless one takes over:
  // the warm-up/re-attach carried no user turn, so replacing it loses nothing
  // and guarantees the first REAL turn owns the replay slot.
  if (!existing.hasPayload && input.hasPayload) {
    deferredSpawns.set(input.sessionId, {
      larkAppId: input.larkAppId,
      hasPayload: true,
      foldedTurns: [],
      replay: input.replay,
    });
    return { freeze, disposition: 'superseded' };
  }

  // The slot is already held by a payload-bearing spawn. Fold this turn's
  // payload into it so it is delayed, not dropped. A promptless spawn arriving
  // behind a real one adds nothing to fold (and must not displace it).
  if (existing.hasPayload && input.hasPayload && input.foldTurn) {
    existing.foldedTurns.push(input.foldTurn);
    return { freeze, disposition: 'folded' };
  }

  // A promptless spawn behind an already-parked spawn (of either kind): keep
  // waiting on what is parked, fold nothing, displace nothing. There is no user
  // turn here to acknowledge, so the caller must NOT emit a "message received"
  // notice for it.
  return { freeze, disposition: 'waiting' };
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
 * One-shot gate for a "maintenance in progress" reply: true the first time a
 * given anchor asks during a given declaration, per `kind`. Without it a busy
 * chat gets one notice per message; with it it is told once and then waits.
 * State resets when the declaration changes, so the next window speaks again.
 *
 * `anchor` must be the same key the notice is delivered to (the session's reply
 * anchor, NOT its chat id): keyed by chat, a second topic in the same group
 * would be silenced even though a different person is waiting in it.
 *
 * `kind` separates the two things worth saying once each: the first turn is
 * "parked, it continues by itself after release"; a later turn is "folded" —
 * also received and delayed, worth one distinct acknowledgement so the user
 * knows the follow-up landed too.
 */
export function shouldAnnounceSpawnFreeze(
  freeze: ActiveSpawnFreeze,
  anchor: string,
  kind: 'parked' | 'folded' = 'parked',
): boolean {
  if (!freeze.notify) return false;
  if (noticeFreezeId !== freeze.freezeId) {
    noticeFreezeId = freeze.freezeId;
    noticedChats.clear();
  }
  const key = `${kind}:${anchor}`;
  if (noticedChats.has(key)) return false;
  noticedChats.add(key);
  return true;
}

export class SpawnFreezeConflictError extends Error {
  constructor(public readonly active: ActiveSpawnFreeze) {
    super(`another spawn freeze is active: ${active.reason}`);
    this.name = 'SpawnFreezeConflictError';
  }
}

/**
 * Publish a declaration. A reader never observes a half-written file: the
 * content is written to a same-directory temp and then linked/renamed into
 * place.
 *
 * Refuses to clobber a declaration that is still in effect and belongs to
 * somebody else. There is exactly one declaration file, so an unconditional
 * write let two overlapping maintenance scripts silently disarm each other —
 * the later writer erasing the earlier one's scope, then the earlier one's
 * cleanup deleting the later one's freeze. Making that a visible failure (so the
 * second script decides what to do) is worth the code; a multi-record lease
 * protocol is not, so overlapping windows from DIFFERENT owners stay
 * unsupported.
 *
 * Three cases are allowed through:
 *  - nothing in effect (missing / expired / dead declarer / unparseable);
 *  - same `pid` — an owner extending or amending its own window (both sides must
 *    name a pid; two anonymous declarations are two owners, not one);
 *  - `force` — an explicit operator takeover.
 *
 * The create path uses `link()`, which fails if the destination exists, so the
 * check and the publish are one atomic step rather than a TOCTOU pair: two
 * scripts racing from scratch cannot both win.
 */
export function writeSpawnFreeze(
  declaration: SpawnFreezeDeclaration,
  deps: SpawnFreezeDeps = {},
  opts: { force?: boolean } = {},
): string {
  const parsed = parseSpawnFreezeDeclaration(declaration);
  const path = spawnFreezePath(deps);
  const body = `${JSON.stringify(parsed, null, 2)}\n`;
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    // Inside the try: a partial write (disk full, EIO) must not leave the temp
    // behind either.
    writeFileSync(tmp, body, { mode: 0o600 });
    if (opts.force) {
      renameSync(tmp, path);
      return path;
    }
    // Bounded retry: each round either wins the atomic create, hands back a
    // real conflict, or removes exactly one superseded declaration.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, path);
        return path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      }
      const active = readActiveSpawnFreeze(deps);
      // Same owner requires BOTH sides to actually name one: two declarations
      // that simply omit `pid` are not "the same owner", they are two anonymous
      // writers, and treating undefined === undefined as a match let every racer
      // replace every other one (verified: 10 concurrent writers all succeeded).
      const sameOwner = active !== null
        && parsed.pid !== undefined
        && active.declaredByPid === parsed.pid;
      if (active && !sameOwner) throw new SpawnFreezeConflictError(active);
      // Ours to replace (same owner), or nothing in effect: drop the stale file
      // and try the atomic create again.
      try { unlinkSync(path); } catch { /* somebody else removed it first */ }
    }
    throw new Error('spawn-freeze declaration is being rewritten concurrently');
  } finally {
    try { unlinkSync(tmp); } catch { /* already linked away or gone */ }
  }
}

export type ClearSpawnFreezeResult = 'cleared' | 'absent' | 'not_owner';

/**
 * Remove the declaration. Idempotent — releasing a freeze that already expired
 * must not fail a maintenance script's cleanup trap.
 *
 * With `ownerPid`, only a declaration made by that pid is removed: a script's
 * EXIT trap must never delete somebody else's freeze. A declaration written
 * without a pid has no owner to check and stays removable by anyone.
 */
export function clearSpawnFreeze(
  deps: SpawnFreezeDeps = {},
  opts: { ownerPid?: number } = {},
): ClearSpawnFreezeResult {
  const path = spawnFreezePath(deps);
  try {
    // lstat for the same reason the reader uses it: "exists" must include a
    // dangling symlink, which statSync would report as absent and leave behind.
    lstatSync(path);
  } catch {
    return 'absent';
  }
  if (opts.ownerPid !== undefined) {
    // Read the raw declaration rather than `readActiveSpawnFreeze`: an EXPIRED
    // declaration must still be removable by its owner, and one we cannot parse
    // carries no ownership claim to respect.
    let declaredPid: number | undefined;
    try {
      declaredPid = parseSpawnFreezeDeclaration(JSON.parse(readFileSync(path, 'utf-8'))).pid;
    } catch {
      declaredPid = undefined;
    }
    if (declaredPid !== undefined && declaredPid !== opts.ownerPid) return 'not_owner';
  }
  rmSync(path, { force: true });
  return 'cleared';
}

/** Test-only: production state is driven entirely by the file and the timer. */
export function resetSpawnFreezeStateForTest(): void {
  deferredSpawns.clear();
  stopPoll();
  noticeFreezeId = null;
  noticedChats.clear();
}
