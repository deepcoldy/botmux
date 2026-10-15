import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
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
export function sessionTempDir(dataDir: string, sessionId: string): string {
  // Keep scratch outside BOTMUX_HOME. Core-only sandboxes deliberately freeze
  // that whole authority root, so placing temp under ~/.botmux would either be
  // denied or require a dangerous writable carve-out beside credentials.
  const key = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  return join(sessionTempRoot(), sessionTempProfile(dataDir, 8), key);
}

/** Pre-shortening layout, still owned by sessions created before the change. */
function legacySessionTempDir(dataDir: string, sessionId: string): string {
  return join(sessionTempRoot(), sessionTempProfile(dataDir, 16), sessionTempSegment(sessionId));
}

/** Create and validate the session scratch directory before exposing it. */
export function ensureSessionTempDir(dataDir: string, sessionId: string): string {
  const path = sessionTempDir(dataDir, sessionId);
  try {
    const existing = lstatSync(path);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`session temp path is not a real directory: ${path}`);
    }
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`session temp path is not a real directory: ${path}`);
  }
  return path;
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

/** Cleanup must wait for actual worker exit: its close ACK precedes teardown. */
export function cleanupSessionTempDirAfterExit(
  dataDir: string,
  sessionId: string,
  worker: ChildProcess | undefined,
  onError: (error: unknown) => void,
  mayCleanup: () => boolean = () => true,
): void {
  const cleanup = () => {
    try {
      if (mayCleanup()) void cleanupSessionTempDir(dataDir, sessionId).catch(onError);
    } catch (error) { onError(error); }
  };
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    worker.once('exit', cleanup);
  } else {
    cleanup();
  }
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
