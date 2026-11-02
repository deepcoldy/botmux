import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';

/** Host credentials and detached execution state share a fixed authority root,
 * independent of SESSION_DATA_DIR / core-only routing configuration. */
export const BYTEDCLI_HOME_ROOT = join(homedir(), '.botmux', 'data', 'bytedcli-home');
export const BACKGROUND_JOBS_HOME_ROOT = join(dirname(BYTEDCLI_HOME_ROOT), 'background-jobs');
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
