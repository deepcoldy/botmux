/**
 * Durable worktree cleanup jobs: offering them and running them.
 *
 * A job pins one linked worktree to the safety fingerprint the operator saw.
 * Running it re-proves identity, idleness and that fingerprint under the
 * worktree target lock before `git worktree remove --force`, so `/cleanup-wt`
 * and the `/dismiss` receipt button delete through this one path.
 */
import { resolve } from 'node:path';
import { config } from '../config.js';
import {
  isLinkedWorktree,
  mainWorktreeFor,
  removeRepoWorktree,
  withWorktreeTargetLock,
  worktreeRootFor,
  worktreeSafetyStatus,
  type WorktreeSafetyStatus,
} from '../services/git-worktree.js';
import { deleteWorktreeCleanupJob, getWorktreeCleanupJob, putWorktreeCleanupJob } from '../services/worktree-cleanup-store.js';
import * as sessionStore from '../services/session-store.js';

export type WorktreeCleanupRun =
  | { status: 'unreadable'; error: string }
  | { status: 'not_found' }
  | { status: 'identity_changed' | 'changed' | 'removed'; dir: string }
  | { status: 'busy'; dir: string; activeCount: number }
  | { status: 'failed'; dir: string; error: string };

const message = (err: unknown) => err instanceof Error ? err.message : String(err);

/** Run one job owned by `larkAppId`; the job is kept unless the worktree is removed. */
export async function runWorktreeCleanupJob(larkAppId: string, id: string): Promise<WorktreeCleanupRun> {
  let job;
  try {
    job = getWorktreeCleanupJob(config.session.dataDir, id);
  } catch (err) {
    return { status: 'unreadable', error: message(err) };
  }
  if (!job || job.larkAppId !== larkAppId) return { status: 'not_found' };
  const dir = job.worktreeDir;
  try {
    const containingRoot = await worktreeRootFor(dir);
    const main = containingRoot ? await mainWorktreeFor(containingRoot) : undefined;
    if (!containingRoot || resolve(containingRoot) !== resolve(dir)
      || resolve(main ?? '') !== resolve(job.worktreeMain)
      || !(await isLinkedWorktree(containingRoot))) {
      return { status: 'identity_changed', dir };
    }
    return await withWorktreeTargetLock(dir, async (): Promise<WorktreeCleanupRun> => {
      const active = sessionStore.findActiveSessionsByWorkingDirStrict(dir);
      if (active.length > 0) return { status: 'busy', dir, activeCount: active.length };
      const safety = await worktreeSafetyStatus(dir);
      if (safety.fingerprint !== job.safetyFingerprint) return { status: 'changed', dir };
      await removeRepoWorktree(job.worktreeMain, dir);
      deleteWorktreeCleanupJob(config.session.dataDir, job.id);
      return { status: 'removed', dir };
    });
  } catch (err) {
    return { status: 'failed', dir, error: message(err) };
  }
}

export type WorktreeCleanupOffer =
  | { dir: string; status: 'ready'; jobId: string; safety: WorktreeSafetyStatus }
  | { dir: string; status: 'busy'; activeCount: number }
  | { dir: string; status: 'unchecked'; error: string };

/**
 * Turn the working dirs of just-closed sessions into cleanup offers. Only
 * linked worktrees qualify (never a main checkout); one still used by an
 * active session is reported but gets no job.
 */
export async function offerWorktreeCleanup(larkAppId: string, workingDirs: readonly string[]): Promise<WorktreeCleanupOffer[]> {
  const offers = new Map<string, WorktreeCleanupOffer>();
  for (const workingDir of workingDirs) {
    let root: string | null;
    try {
      root = await worktreeRootFor(workingDir);
      if (!root || offers.has(root) || !(await isLinkedWorktree(root))) continue;
    } catch {
      continue;
    }
    try {
      const active = sessionStore.findActiveSessionsByWorkingDirStrict(root);
      if (active.length > 0) {
        offers.set(root, { dir: root, status: 'busy', activeCount: active.length });
        continue;
      }
      const safety = await worktreeSafetyStatus(root);
      const job = putWorktreeCleanupJob(config.session.dataDir, {
        larkAppId,
        worktreeMain: await mainWorktreeFor(root),
        worktreeDir: root,
        safetyFingerprint: safety.fingerprint,
        error: 'offered after /dismiss',
      });
      offers.set(root, { dir: root, status: 'ready', jobId: job.id, safety });
    } catch (err) {
      offers.set(root, { dir: root, status: 'unchecked', error: message(err) });
    }
  }
  return [...offers.values()];
}
