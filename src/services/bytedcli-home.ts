import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { isUsableOpenId } from '../utils/user-token.js';
import { readCliAuthEpoch } from './cli-auth-epoch.js';

/** Host credentials and detached execution state share a fixed authority root,
 * independent of SESSION_DATA_DIR / core-only routing configuration. */
export const BYTEDCLI_HOME_ROOT = join(homedir(), '.botmux', 'data', 'bytedcli-home');
export const BACKGROUND_JOBS_HOME_ROOT = join(dirname(BYTEDCLI_HOME_ROOT), 'background-jobs');
/** Each person's Meego login, shared by every session of theirs on this host
 * (services/meego-auth.ts). */
export const MEEGO_HOME_ROOT = join(dirname(BYTEDCLI_HOME_ROOT), 'meego-home');
/** Where the official meegle CLI keeps its login: `$HOME/.meegle`, resolved
 * through the OS home directory with no override. */
export const MEEGO_STORE_DIR = '.meegle';
/** Meego credentials bytedcli takes from the environment ahead of the HOME's
 *  login. Inherited, they are the host operator's, never the person's. */
/** bytedcli's only non-default Meego tenant; no tenant is the default one. */
export type MeegoTenant = 'dcar';
export const MEEGO_TENANTS: readonly MeegoTenant[] = ['dcar'];
export const MEEGO_ENV_CREDENTIALS = ['MEEGLE_USER_ACCESS_TOKEN', 'BYTEDCLI_MEEGO_ACCESS_TOKEN', 'BYTEDCLI_MEEGO_COOKIE'] as const;

/** Everything this host keeps for one person's Meego login, all epochs. */
export function meegoPersonRoot(openId: string): string {
  // Concatenated into a path: a `../`-shaped id must not reach another directory.
  if (!isUsableOpenId(openId)) throw new Error(`[meego-home] unusable open_id: ${JSON.stringify(openId)}`);
  return join(MEEGO_HOME_ROOT, openId);
}

/**
 * The HOME whose `.meegle` holds this person's current Meego login.
 *
 * Keyed by the revocation epoch: revoking bumps it, so a meegle process that
 * was refreshing at that moment can only write under a directory that is never
 * handed out again.
 */
export function meegoHomeFor(openId: string, epoch = readCliAuthEpoch(openId)): string {
  return join(meegoPersonRoot(openId), `epoch-${epoch}`);
}

/** Create this person's Meego store (0700 throughout) and return its HOME.
 *  The session wrapper only links to it; it never creates it. */
export function ensureMeegoStore(openId: string, epoch = readCliAuthEpoch(openId)): string {
  const home = meegoHomeFor(openId, epoch);
  mkdirSync(join(home, MEEGO_STORE_DIR), { recursive: true, mode: 0o700 });
  return home;
}

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function backgroundJobHome(jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new Error('invalid_background_job_id');
  return join(BACKGROUND_JOBS_HOME_ROOT, jobId);
}

export function ensureBackgroundJobHome(jobId: string): string {
  const home = backgroundJobHome(jobId);
  for (const dir of [BACKGROUND_JOBS_HOME_ROOT, home]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_background_home');
    chmodSync(dir, 0o700);
  }
  return home;
}

/** Tombstone first, then best-effort removal of this job only. Reads retry a
 * failed cleanup; a filesystem error must never roll back durable revocation. */
export function cleanupBackgroundJobHome(jobId: string): void {
  try { rmSync(backgroundJobHome(jobId), { recursive: true, force: true }); }
  catch (error) {
    logger.warn(`[background-execution] state cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
