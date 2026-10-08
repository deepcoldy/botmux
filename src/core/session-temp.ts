import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function sessionTempSegment(sessionId: string): string {
  if (SAFE_SESSION_SEGMENT.test(sessionId) && sessionId !== '.' && sessionId !== '..') {
    return sessionId;
  }
  return `sha256-${createHash('sha256').update(sessionId).digest('hex')}`;
}

/**
 * Stable scratch path owned by one logical session. It lives in the user's
 * cache tree, keyed by SESSION_DATA_DIR, rather than in the host's /tmp:
 * production Linux hosts commonly mount /tmp as tmpfs, while agent turns clone
 * repositories and build dependency trees that can be many GiB.
 */
export function sessionTempDir(dataDir: string, sessionId: string): string {
  // Keep scratch outside BOTMUX_HOME. Core-only sandboxes deliberately freeze
  // that whole authority root, so placing temp under ~/.botmux would either be
  // denied or require a dangerous writable carve-out beside credentials.
  const profile = createHash('sha256')
    .update(resolve(dataDir))
    .digest('hex')
    .slice(0, 16);
  return join(homedir(), '.cache', 'botmux', 'session-tmp', profile, sessionTempSegment(sessionId));
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
  const path = sessionTempDir(dataDir, sessionId);
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
