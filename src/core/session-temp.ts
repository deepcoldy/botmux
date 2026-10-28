import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function sessionTempSegment(sessionId: string): string {
  if (SAFE_SESSION_SEGMENT.test(sessionId) && sessionId !== '.' && sessionId !== '..') {
    return sessionId;
  }
  return `sha256-${createHash('sha256').update(sessionId).digest('hex')}`;
}

function sessionTempRoot(): string {
  return join(homedir(), '.cache', 'botmux', 'session-tmp');
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
 * cache tree, keyed by SESSION_DATA_DIR, rather than in the host's /tmp:
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

/** Pre-shortening layout, still owned by sessions created before the change. */
function legacySessionTempDir(dataDir: string, sessionId: string): string {
  return join(sessionTempRoot(), sessionTempProfile(dataDir, 16), sessionTempSegment(sessionId));
}

/** Create and validate the session scratch directory before exposing it. */
export function ensureSessionTempDir(dataDir: string, sessionId: string, root: string = sessionTempRoot()): string {
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
  await retireSessionTempPath(sessionTempDir(dataDir, sessionId));
  await retireSessionTempPath(legacySessionTempDir(dataDir, sessionId));
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
  /** Defaults to ~/.cache/botmux/session-tmp. */
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
  const root = opts.root ?? sessionTempRoot();
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
    const live = await opts.liveReferences(candidates.map(c => c.path));
    for (const { path, detached } of live ? candidates : []) {
      // Re-read the mtime at removal time: a resume that landed after the
      // probe (its worker spawns the CLI later) refreshed it on claim.
      if (live!.has(path) || !isOld(path)) continue;
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
  const root = sessionTempRoot();
  for (const key of SESSION_TEMP_ENV_KEYS) {
    const value = env[key]?.trim();
    if (!value) continue;
    const path = resolve(value);
    if (path === root || path.startsWith(`${root}${sep}`)) delete env[key];
  }
}
