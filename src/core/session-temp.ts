import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function sessionTempSegment(sessionId: string): string {
  if (SAFE_SESSION_SEGMENT.test(sessionId) && sessionId !== '.' && sessionId !== '..') {
    return sessionId;
  }
  return `sha256-${createHash('sha256').update(sessionId).digest('hex')}`;
}

function sessionTempCacheRoot(): string {
  return join(homedir(), '.cache', 'botmux', 'session-tmp');
}

/**
 * uid-wide hub that holds one short alias per cache root: `/tmp/bm<uid>`.
 *
 * Private (0700) because it is shared by every cache root the same uid uses
 * (one per HOME, see {@link sessionTempRoot}) and names them in the clear:
 * another user who could list it would learn which HOMEs this uid serves, and
 * could pre-create an alias name to redirect a session into their own tree.
 */
function sessionTempHub(): string | undefined {
  if (!process.getuid) return undefined;
  return join('/tmp', `bm${process.getuid()}`);
}

/**
 * Short lexical path for one cache root: `<hub>/<8-hex of the cache path>`.
 *
 * Without a uid there is no shared /tmp to be careful about, so the cache root
 * itself is used and no alias exists.
 */
function sessionTempRoot(): string {
  const hub = sessionTempHub();
  if (!hub) return sessionTempCacheRoot();
  return join(hub, createHash('sha256').update(resolve(sessionTempCacheRoot())).digest('hex').slice(0, 8));
}

/**
 * Make `/tmp/bm<uid>` exist and be private to this uid.
 *
 * WRITERS OTHER THAN THIS FUNCTION CREATE IT TOO. The identity wrapper
 * (`renderIdentityWrapper`, cli-identity.ts) `mkdir -p`s a per-person HOME that
 * lexically passes through this hub, and `mkdir -p -m` applies the mode to the
 * LAST component only: with the usual umask 022 every intermediate level lands
 * 0755 — including this hub — before any daemon code has run since the last
 * /tmp wipe. So "it exists but is not 0700" is an EXPECTED state that this
 * function repairs, not evidence of tampering: the hub is ours, nobody else can
 * write into a 0700-only-ours path for long, and the entry mode carries no
 * secrets (the alias it holds does). Only the three facts that would mean
 * someone else owns the path stay fatal — see below.
 */
function ensureSessionTempHub(hub: string): void {
  const uid = process.getuid!();
  try { mkdirSync(hub, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const entry = lstatSync(hub);
  // Someone else's directory, or a symlink to one: fail closed rather than
  // chmod a path we do not own (and rather than write aliases through a link).
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid) {
    throw new Error(`session temp alias parent is not a private owned directory: ${hub}`);
  }
  // Widened by the wrapper's `mkdir -p`: ours to tighten back down.
  if ((entry.mode & 0o777) !== 0o700) chmodSync(hub, 0o700);
}

/**
 * Create the short alias for this cache root if it is missing, and check that
 * whatever is there points at the cache root.
 *
 * A REAL DIRECTORY where the alias belongs means the wrapper got there first:
 * its `mkdir -p` crossed this name while creating a per-person HOME, so the
 * subtree under it was created in `/tmp` rather than in the cache tree. That
 * defeats the reason for the alias — on the Linux hosts this targets `/tmp` is
 * tmpfs, and agent turns clone repositories and build dependency trees of many
 * GiB — so the subtree has to move to the cache root before the alias is put in
 * place over its name.
 *
 * Everything under such a directory was created by our own wrapper moments ago:
 * nothing is executing from it yet (the exec that would have created it did not
 * get this far, and a session that finished would have had its scratch retired),
 * and `ensureSessionTempDir` recreates whatever a caller then asks for. So this
 * renames the contents away rather than failing or silently leaving them on
 * tmpfs.
 */
function ensureSessionTempAlias(alias: string, cache: string): void {
  const uid = process.getuid!();
  const target = resolve(cache);
  // Two processes can race here on their first boot: one creates the link while
  // the other is still deciding what the entry is. Re-observe instead of
  // failing on the transient ENOENT that a rename/rmdir in between produces.
  for (let attempt = 0; attempt < 5; attempt++) {
    try { symlinkSync(target, alias, 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    let entry;
    try { entry = lstatSync(alias); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      // A link that does not name this cache root is a redirect someone else set
      // up: writing sessions through it would put this uid's scratch wherever it
      // points. A broken link we own can be relinked; a link to a DIFFERENT place
      // is not ours to repoint.
      let pointsTo: string | undefined;
      try { pointsTo = readlinkSync(alias); } catch { pointsTo = undefined; }
      if (pointsTo === undefined) continue; // unlinked mid-read: observe again
      if (entry.uid !== uid || pointsTo !== target) {
        throw new Error(`session temp alias does not point to its cache directory: ${alias}`);
      }
      return;
    }
    if (!entry.isDirectory() || entry.uid !== uid) {
      throw new Error(`session temp alias does not point to its cache directory: ${alias}`);
    }
    adoptDirectoryOntoCacheRoot(alias, target);
    return;
  }
  throw new Error(`session temp alias could not be settled: ${alias}`);
}

/**
 * Move a wrapper-created subtree off `/tmp` into the cache root, then link the
 * alias to the cache root.
 *
 * SERIALISED PER HUB. Several processes boot at once (a daemon and the CLIs it
 * spawns, or a test runner's forks) and all of them reach this on their first
 * session; without a lock two of them walk the same `/tmp` tree while the other
 * renames entries out of it, which showed up as ENOENT inside lstat/rename and
 * as entries silently lost. The lock is a `mkdir` — atomic on every filesystem
 * this runs on, and unlike a lock FILE it needs no cleanup contract: a crashed
 * holder's directory is cleared by the next one that notices it is stale.
 */
function adoptDirectoryOntoCacheRoot(alias: string, target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  withAdoptionLock(alias, () => {
    // Another process may have finished the whole adoption while we waited.
    const entry = lstatSync(alias);
    if (entry.isSymbolicLink()) return;
    mergeIntoCacheRoot(alias, target);
    try { rmdirSync(alias); } catch { /* not empty (a concurrent writer won): reported below */ }
    // A concurrent first-writer may have linked it (or re-created the directory)
    // between the rmdir and here; EEXIST is not an error, the check follows.
    try { symlinkSync(target, alias, 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  });
  const link = lstatSync(alias);
  if (!link.isSymbolicLink() || link.uid !== process.getuid!() || readlinkSync(alias) !== target) {
    throw new Error(`session temp alias does not point to its cache directory: ${alias}`);
  }
}

const ADOPTION_LOCK_STALE_MS = 60_000;

/** Run `body` holding an exclusive lock next to the alias. */
function withAdoptionLock(alias: string, body: () => void): void {
  const lock = `${alias}.adopt-lock`;
  const deadline = Date.now() + ADOPTION_LOCK_STALE_MS;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A holder that died mid-adoption must not wedge every future boot.
      // Its tree is the one under `alias`, so anything older than the window
      // below belongs to a process that is gone (adoption is a local rename or
      // copy, not a network wait).
      let ageMs = 0;
      try { ageMs = Date.now() - lstatSync(lock).mtimeMs; } catch { continue; }
      if (ageMs > ADOPTION_LOCK_STALE_MS) {
        try { rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`session temp alias adoption is locked: ${lock}`);
      // Short spins: the critical section is a handful of renames.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { body(); }
  finally { try { rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ } }
}

/** Merge every entry under `from` into `to`, recursing where both are dirs. */
function mergeIntoCacheRoot(from: string, to: string): void {
  let names: string[];
  try { names = readdirSync(from); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    const source = join(from, name);
    const destination = join(to, name);
    // `from` can resolve INTO `to` if a concurrent adoption already replaced
    // the alias with a symlink to the cache root while this walk was running:
    // the two names are then the same entry, and "merge source into itself"
    // would delete what it was carrying. Stop instead — the other process has
    // finished the job.
    if (resolve(source) === resolve(destination)) continue;
    if (!existsSync(destination)) {
      moveEntry(source, destination);
      continue;
    }
    // Both names exist. Two directories still have to be merged, or the /tmp
    // side's children are lost with the directory that held them.
    let sourceEntry, destinationEntry;
    try { sourceEntry = lstatSync(source); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (existsSync(destination)) { destinationEntry = lstatSync(destination); } else continue;
    if (sourceEntry.isDirectory() && !sourceEntry.isSymbolicLink()
      && destinationEntry.isDirectory() && !destinationEntry.isSymbolicLink()) {
      // Same hazard one level down: the resolved paths can coincide here too.
      if (resolve(source) === resolve(destination)) continue;
      mergeIntoCacheRoot(source, destination);
      try { rmdirSync(source); } catch { /* raced with a writer; the parent rmdir reports leftovers */ }
      continue;
    }
    // A genuine name collision at the same level (a file, a symlink, or
    // dir-vs-file): the cache copy is the one published paths point at.
    try { rmSync(source, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Move one entry to the cache root. `rename` is the fast path and preserves
 * everything, but it cannot cross filesystems — which is exactly the case here
 * on the hosts this targets (`/tmp` is tmpfs, the cache root is disk) — so an
 * EXDEV falls back to copy-then-remove.
 *
 * Deliberately verbose over clever: the source tree is one a wrapper created
 * seconds ago and never executed anything from, so a reflink-less copy costs
 * nothing that matters, and a failure here must not leave the caller believing
 * a tmpfs tree is the session's home.
 */
function moveEntry(from: string, to: string): void {
  try { renameSync(from, to); return; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Gone already: another process adopted it. Nothing left to do.
    if (code === 'ENOENT') return;
    if (code !== 'EXDEV') throw error;
  }
  copyEntry(from, to);
  try { rmSync(from, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Copy one entry across filesystems, preserving its TYPE.
 *
 * A session scratch is not just files. It is the CLI's TMPDIR, so it holds unix
 * sockets (a listener's `SingletonSocket`, ad-hoc servers) and can hold FIFOs
 * (a tool's named pipe). Neither can be copied as a regular file:
 *
 *  - `copyFileSync` on a FIFO OPENS it and blocks until a writer appears —
 *    measured: `rc=124` after a 12s timeout, with no end in sight. Worse, that
 *    happens inside the adoption lock, so every other first-boot on the host
 *    queues behind it.
 *  - `copyFileSync` on a unix socket throws ENXIO (measured), which used to
 *    abort adoption and leave the real-directory alias in place — so every
 *    later boot hit the same entry and failed again, with no self-healing path.
 *
 * What to do with each is decided by what the thing IS after the move:
 *
 *  - a FIFO is SKIPPED. Recreating one (`mkfifo`) would not restore anything:
 *    a FIFO carries no data outside a live reader/writer pair, and both ends
 *    hold fds on the OLD inode, so a new empty FIFO at the new path has no
 *    peer. The tool that made it re-creates it if it still needs one, exactly
 *    as after a /tmp wipe.
 *  - a socket is SKIPPED for the same reason: its endpoint lives in the kernel
 *    bound to the old path, and the listener rebinds once it notices.
 *  - a device or anything else non-regular is skipped too: opening one to copy
 *    it is exactly the blocking/block-device hazard above.
 *
 * Skipping is the safe direction here because the whole subtree is a scratch
 * tree belonging to processes that are not running (adoption happens at boot,
 * before the session's CLI starts). The one thing that must never happen is
 * blocking inside the adoption lock or failing the adoption — that is what
 * turned a stale entry into a permanently unbootable host.
 */
function copyEntry(from: string, to: string): void {
  const entry = lstatSync(from);
  if (entry.isDirectory()) {
    mkdirSync(to, { mode: entry.mode & 0o777 });
    for (const name of readdirSync(from)) copyEntry(join(from, name), join(to, name));
    return;
  }
  // Symlinks inside a session scratch are the CLI's own (a sandbox view);
  // copy the link, never what it points at.
  if (entry.isSymbolicLink()) {
    try { symlinkSync(readlinkSync(from), to); } catch { /* destination raced in; keep it */ }
    return;
  }
  if (!entry.isFile()) return; // FIFO, socket, device: see above
  copyFileSync(from, to);
  try { chmodSync(to, entry.mode & 0o777); } catch { /* best effort */ }
}

function ensureSessionTempRoot(): void {
  // Keep large scratch trees on the cache filesystem, but expose a bounded
  // lexical path to tools. Chrome appends ~40 bytes for its SingletonSocket;
  // shortening only the session/profile segments cannot bound a long HOME.
  const hub = sessionTempHub();
  if (!hub) return;
  ensureSessionTempHub(hub);
  const cache = sessionTempCacheRoot();
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  ensureSessionTempAlias(sessionTempRoot(), cache);
}

/**
 * Put the short-alias layout in place: `/tmp/bm<uid>` at 0700 and the per-cache
 * alias pointing at the cache root. Idempotent and cheap; safe to call from
 * anything that is about to name a path inside the scratch.
 *
 * Callers that only COMPUTE a path (rather than create the leaf) still need it:
 * `bytedcliTurnHome` resolves the lexical path through realpath, and with the
 * alias missing the realpath of every existing ancestor stops at the hub — the
 * published HOME would then be the long `/tmp/bm<uid>/<hash>/…` spelling and the
 * executor's `mkdir -p` would be the thing that creates the layout, at umask
 * modes. Creating it first keeps the published path short, disk-backed, and
 * made by this code rather than by a shell.
 *
 * THROWS when the hub is not ours to fix (foreign owner, symlink planted at it).
 * Callers MUST NOT fall back to a lexical `<hub>/...` path: the hub is then a
 * link somebody else controls, and `mkdir -p` follows links — the write would
 * land in their tree. See {@link sessionTempDirWithoutAlias}.
 */
export function ensureSessionTempLayout(): void {
  ensureSessionTempRoot();
}

/**
 * The same path {@link sessionTempDir} would produce, spelled through the cache
 * root instead of the short alias — i.e. never through `/tmp/bm<uid>`.
 *
 * This is the fail-closed fallback for a caller whose alias layout could not be
 * trusted. It trades path length for the guarantee that no component can be a
 * link someone else planted: the cache root is under the user's own HOME.
 */
export function sessionTempDirWithoutAlias(dataDir: string, sessionId: string): string {
  return sessionTempDir(dataDir, sessionId, sessionTempCacheRoot());
}

function sessionTempProfile(dataDir: string, length: number): string {
  return createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, length);
}

function sessionTempKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

/** Records which SESSION_DATA_DIR a profile belongs to. The profile name is a
 *  one-way hash, so without it another daemon can never tell that a profile's
 *  data dir (and with it every session row that could resume into it) is gone. */
const PROFILE_DATA_DIR_MARKER = '.data-dir';

/**
 * Stable scratch path owned by one logical session. It lives in the user's
 * cache tree, keyed by SESSION_DATA_DIR, through a short private /tmp alias:
 * production Linux hosts commonly mount /tmp as tmpfs, while agent turns clone
 * repositories and build dependency trees that can be many GiB.
 *
 * The path becomes the CLI's TMPDIR, and tools create Unix sockets under it
 * (Python multiprocessing, ad-hoc servers, …). AF_UNIX paths are capped at
 * 104 bytes on macOS (108 on Linux), so both segments are short hashes: a raw
 * UUID session id here left too little room for any socket name.
 */
export function sessionTempDir(dataDir: string, sessionId: string, root: string = sessionTempRoot()): string {
  // Keep scratch outside BOTMUX_HOME. Core-only sandboxes deliberately freeze
  // that whole authority root, so placing temp under ~/.botmux would either be
  // denied or require a dangerous writable carve-out beside credentials.
  return join(root, sessionTempProfile(dataDir, 8), sessionTempKey(sessionId));
}

/** Create and validate the session scratch directory before exposing it. */
export function ensureSessionTempDir(dataDir: string, sessionId: string, root: string = sessionTempRoot()): string {
  if (root === sessionTempRoot()) ensureSessionTempRoot();
  const path = sessionTempDir(dataDir, sessionId, root);
  let existed = true;
  try {
    const existing = lstatSync(path);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`session temp path is not a real directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    existed = false;
  }
  if (existed) {
    // Fresh mtime = "just claimed": the orphan sweep's grace window then covers
    // a resume that lands after the sweep read the store.
    try { const now = new Date(); utimesSync(path, now, now); } catch { /* best-effort */ }
  } else {
    try { mkdirSync(path, { recursive: true, mode: 0o700 }); }
    catch (error) {
      // The sweep may rmdir an empty profile between our parent and leaf mkdir.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`session temp path is not a real directory: ${path}`);
    }
  }
  writeProfileDataDirMarker(dirname(path), dataDir);
  return path;
}

function writeProfileDataDirMarker(profileDir: string, dataDir: string): void {
  const marker = join(profileDir, PROFILE_DATA_DIR_MARKER);
  if (existsSync(marker)) return;
  try { writeFileSync(marker, `${resolve(dataDir)}\n`, { mode: 0o600, flag: 'wx' }); }
  catch { /* best-effort: a concurrent writer won; without a marker only emptiness is decidable */ }
}

/** Best-effort caller decides when the logical session is durably closed. */
export async function cleanupSessionTempDir(dataDir: string, sessionId: string): Promise<void> {
  let cache: string;
  try { cache = realpathSync(sessionTempCacheRoot()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  // A short alias can be replaced while asynchronous removal is in progress.
  // Delete through the fixed backing path, including the pre-shortening layout.
  await retireSessionTempPath(sessionTempDir(dataDir, sessionId, cache));
  await retireSessionTempPath(join(cache, sessionTempProfile(dataDir, 16), sessionTempSegment(sessionId)));
}

async function retireSessionTempPath(path: string): Promise<void> {
  const retiredPath = `${path}.retired-${process.pid}-${randomBytes(8).toString('hex')}`;
  // Claim the old tree synchronously. A resume during asynchronous removal
  // recreates `path`, and the remover can only traverse the detached tree.
  try { renameSync(path, retiredPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await rm(retiredPath, { recursive: true, force: true });
}

/** Cleanup must wait for actual worker exit: its close ACK precedes teardown.
 *  `alsoRemove` runs synchronously behind the same ownership check, for other
 *  per-session runtime state with the same lifetime (the Gateway directory). */
export function cleanupSessionTempDirAfterExit(
  dataDir: string,
  sessionId: string,
  worker: ChildProcess | undefined,
  onError: (error: unknown) => void,
  mayCleanup: () => boolean = () => true,
  alsoRemove?: () => void,
): void {
  const cleanup = () => {
    try {
      if (!mayCleanup()) return;
      void cleanupSessionTempDir(dataDir, sessionId).catch(onError);
      alsoRemove?.();
    } catch (error) { onError(error); }
  };
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    worker.once('exit', cleanup);
  } else {
    cleanup();
  }
}

export interface SessionTempSweepOptions {
  /** Defaults to a short alias of ~/.cache/botmux/session-tmp. */
  root?: string;
  now?: number;
  /** Directories touched more recently than this are never removed. */
  graceMs?: number;
  /** Which of `paths` a live process still uses (see findLiveProcessReferences);
   *  `null` = cannot tell, and then nothing is removed this round. */
  liveReferences: (paths: readonly string[]) => Promise<ReadonlySet<string> | null>;
}

const SESSION_TEMP_SWEEP_GRACE_MS = 60_000;
const RETIRED_ENTRY = /\.retired-\d+-[0-9a-f]{16}$/;

function isRealDir(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch { return false; }
}

/** The data dir a foreign profile recorded is gone, so no session row can ever
 *  resume into it. Any other answer (no marker, unreadable, still there) keeps it. */
function profileDataDirGone(profileDir: string): boolean {
  let recorded: string;
  try { recorded = readFileSync(join(profileDir, PROFILE_DATA_DIR_MARKER), 'utf8').trim(); }
  catch { return false; }
  if (!recorded.startsWith('/')) return false;
  try { statSync(recorded); return false; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

/**
 * Reconcile session scratch trees against the session store (#1748). Normal
 * close removes a session's scratch once its worker exits, but a daemon crash
 * or SIGKILL, and close paths that bypass the worker pool, leave trees behind
 * that nothing would ever collect.
 *
 * A session directory of THIS data dir (current and pre-shortening layout) is
 * removed only when its session is not in `protectedSessionIds` (every active
 * row of every bot — a worker:null row still resumes into its scratch), it is
 * older than the grace window, and no live process references it. A closed
 * session loses nothing it needs: resume recreates an empty directory.
 *
 * Other profiles belong to other data dirs, whose rows this daemon cannot see.
 * They are touched only when that is decidable without the rows: the profile's
 * recorded data dir no longer exists, an entry is an already-detached
 * `.retired-*` tree a crashed remover left, or the profile is empty.
 */
export async function sweepOrphanSessionTempDirs(
  dataDir: string,
  protectedSessionIds: ReadonlySet<string>,
  opts: SessionTempSweepOptions,
): Promise<string[]> {
  if (opts.root === undefined) ensureSessionTempRoot();
  let root: string;
  try { root = realpathSync(opts.root ?? sessionTempCacheRoot()); } catch { return []; }
  const now = opts.now ?? Date.now();
  const graceMs = opts.graceMs ?? SESSION_TEMP_SWEEP_GRACE_MS;
  let profiles: string[];
  try { profiles = readdirSync(root); } catch { return []; }
  const isOld = (path: string): boolean => {
    try { return now - lstatSync(path).mtimeMs > graceMs; } catch { return false; }
  };
  const keepByProfile = new Map<string, Set<string>>([
    [sessionTempProfile(dataDir, 8), new Set([...protectedSessionIds].map(sessionTempKey))],
    [sessionTempProfile(dataDir, 16), new Set([...protectedSessionIds].map(sessionTempSegment))],
  ]);
  const candidates: { path: string; detached: boolean }[] = [];
  const profileDirs: string[] = [];
  for (const profile of profiles) {
    const profileDir = join(root, profile);
    if (!isRealDir(profileDir)) continue;
    profileDirs.push(profileDir);
    let entries: string[];
    try { entries = readdirSync(profileDir); } catch { continue; }
    const keep = keepByProfile.get(profile);
    const foreignGone = !keep && profileDataDirGone(profileDir);
    for (const entry of entries) {
      if (entry === PROFILE_DATA_DIR_MARKER) continue;
      const path = join(profileDir, entry);
      if (!isRealDir(path) || !isOld(path)) continue;
      if (RETIRED_ENTRY.test(entry)) candidates.push({ path, detached: true });
      else if (keep ? !keep.has(entry) : foreignGone) candidates.push({ path, detached: false });
    }
  }
  const removed: string[] = [];
  if (candidates.length > 0) {
    // A session without a store row (a v3 workflow attempt) is protected only
    // by its running CLI; when no process can be seen, nothing is provably dead.
    const spellings = new Map(candidates.map(({ path }) => [path, opts.root === undefined
      ? [...new Set([path, join(sessionTempRoot(), relative(root, path)), join(sessionTempCacheRoot(), relative(root, path))])]
      : [path]]));
    const live = await opts.liveReferences([...new Set([...spellings.values()].flat())]);
    for (const { path, detached } of live ? candidates : []) {
      // Re-read the mtime at removal time: a resume that landed after the
      // probe (its worker spawns the CLI later) refreshed it on claim.
      if (spellings.get(path)!.some(spelling => live!.has(spelling)) || !isOld(path)) continue;
      try {
        if (detached) await rm(path, { recursive: true, force: true });
        else await retireSessionTempPath(path);
        removed.push(path);
      } catch { /* best-effort: the next round retries */ }
    }
  }
  for (const profileDir of profileDirs) {
    let entries: string[];
    try { entries = readdirSync(profileDir); } catch { continue; }
    if (entries.some(entry => entry !== PROFILE_DATA_DIR_MARKER) || !isOld(profileDir)) continue;
    try {
      if (entries.length > 0) unlinkSync(join(profileDir, PROFILE_DATA_DIR_MARKER));
      rmdirSync(profileDir);
    } catch { /* a session claimed it meanwhile */ }
  }
  return removed;
}

export function applySessionTempEnv(env: NodeJS.ProcessEnv, path: string): void {
  env.TMPDIR = path;
  env.TMP = path;
  env.TEMP = path;
}

const SESSION_TEMP_ENV_KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const;

/**
 * Drop TMPDIR/TMP/TEMP values that point into the session scratch tree.
 *
 * A `botmux restart` run from a session shell inherits that session's scratch
 * as TMPDIR. Carried into the fleet, every worker would pin it as its Gateway
 * socket root and g.sock would again exceed the AF_UNIX limit. Only scratch
 * paths are removed: an operator's own short TMPDIR is kept.
 */
export function scrubSessionTempEnv(env: NodeJS.ProcessEnv): void {
  const roots = [sessionTempRoot(), sessionTempCacheRoot()];
  for (const key of SESSION_TEMP_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value) continue;
    const path = resolve(value);
    if (roots.some(root => path === root || path.startsWith(`${root}${sep}`))) delete env[key];
  }
}
