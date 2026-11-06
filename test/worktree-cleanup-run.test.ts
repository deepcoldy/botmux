/** Offering and running durable worktree cleanup jobs (shared by /cleanup-wt and the /dismiss receipt). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeCleanupJob } from '../src/services/worktree-cleanup-store.js';

const h = vi.hoisted(() => ({
  linked: new Set<string>(),
  active: new Map<string, number>(),
  fingerprint: 'fp-1',
  jobs: new Map<string, WorktreeCleanupJob>(),
  remove: vi.fn(async () => {}),
  lock: vi.fn(async (_dir: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../src/config.js', () => ({ config: { session: { dataDir: '/data' } } }));
vi.mock('../src/services/git-worktree.js', () => ({
  // Sub-dirs of /wt/a resolve to the /wt/a worktree root; /gone has no repo.
  worktreeRootFor: vi.fn(async (dir: string) => dir === '/gone' ? null : dir.replace(/^(\/wt\/[a-z]+).*$/, '$1')),
  isLinkedWorktree: vi.fn(async (dir: string) => h.linked.has(dir)),
  mainWorktreeFor: vi.fn(async () => '/repo'),
  worktreeSafetyStatus: vi.fn(async (dir: string) => {
    if (dir === '/wt/broken') throw new Error('git status failed');
    return { dirty: false, dirtyCount: 0, dirtyFiles: [], uncommittedCount: 0, uncommittedFiles: [], ignoredCount: 0, ignoredFiles: [], ahead: 0, unpushedCommits: [], fingerprint: h.fingerprint };
  }),
  withWorktreeTargetLock: h.lock,
  removeRepoWorktree: h.remove,
}));
vi.mock('../src/services/session-store.js', () => ({
  findActiveSessionsByWorkingDirStrict: (dir: string) => Array.from({ length: h.active.get(dir) ?? 0 }, () => ({})),
}));
vi.mock('../src/services/worktree-cleanup-store.js', () => ({
  putWorktreeCleanupJob: vi.fn((_data: string, input: Omit<WorktreeCleanupJob, 'id' | 'createdAt' | 'updatedAt'>) => {
    const job = { ...input, id: `job-${input.worktreeDir.split('/').pop()}`, createdAt: 1, updatedAt: 1 };
    h.jobs.set(job.id, job);
    return job;
  }),
  getWorktreeCleanupJob: vi.fn((_data: string, id: string) => {
    if (id === 'corrupt') throw new Error('invalid worktree cleanup job store');
    return h.jobs.get(id);
  }),
  deleteWorktreeCleanupJob: vi.fn((_data: string, id: string) => h.jobs.delete(id)),
}));
import { offerWorktreeCleanup, runWorktreeCleanupJob } from '../src/core/worktree-cleanup-run.js';

const APP = 'cli_app';
beforeEach(() => {
  vi.clearAllMocks();
  h.linked = new Set(['/wt/a', '/wt/b', '/wt/broken']); h.active.clear(); h.fingerprint = 'fp-1'; h.jobs.clear();
  h.remove.mockImplementation(async () => {});
});

describe('offerWorktreeCleanup', () => {
  it('offers each linked worktree once, never a main checkout or a vanished dir', async () => {
    const offers = await offerWorktreeCleanup(APP, ['/wt/a', '/wt/a/pkg', '/repo', '/gone']);
    expect(offers).toEqual([expect.objectContaining({ dir: '/wt/a', status: 'ready', jobId: 'job-a' })]);
    expect(h.jobs.get('job-a')).toMatchObject({ larkAppId: APP, worktreeMain: '/repo', worktreeDir: '/wt/a', safetyFingerprint: 'fp-1' });
  });
  it('reports a worktree still in use without creating a job', async () => {
    h.active.set('/wt/b', 2);
    expect(await offerWorktreeCleanup(APP, ['/wt/b'])).toEqual([{ dir: '/wt/b', status: 'busy', activeCount: 2 }]);
    expect(h.jobs.size).toBe(0);
  });
  it('reports a worktree whose safety cannot be checked without creating a job', async () => {
    expect(await offerWorktreeCleanup(APP, ['/wt/broken'])).toEqual([{ dir: '/wt/broken', status: 'unchecked', error: 'git status failed' }]);
    expect(h.jobs.size).toBe(0);
  });
});

describe('runWorktreeCleanupJob', () => {
  async function offered(): Promise<string> {
    const [offer] = await offerWorktreeCleanup(APP, ['/wt/a']);
    if (offer?.status !== 'ready') throw new Error('not offered');
    return offer.jobId;
  }
  it('removes the offered worktree under its lock and consumes the job', async () => {
    const id = await offered();
    expect(await runWorktreeCleanupJob(APP, id)).toEqual({ status: 'removed', dir: '/wt/a' });
    expect(h.lock).toHaveBeenCalledWith('/wt/a', expect.any(Function));
    expect(h.remove).toHaveBeenCalledWith('/repo', '/wt/a');
    expect(h.jobs.has(id)).toBe(false);
  });
  it('refuses when the content changed after the offer', async () => {
    const id = await offered(); h.fingerprint = 'fp-2';
    expect(await runWorktreeCleanupJob(APP, id)).toEqual({ status: 'changed', dir: '/wt/a' });
    expect(h.remove).not.toHaveBeenCalled(); expect(h.jobs.has(id)).toBe(true);
  });
  it('refuses while a session uses the worktree again', async () => {
    const id = await offered(); h.active.set('/wt/a', 1);
    expect(await runWorktreeCleanupJob(APP, id)).toEqual({ status: 'busy', dir: '/wt/a', activeCount: 1 });
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('refuses when the path is no longer the same linked worktree', async () => {
    const id = await offered(); h.linked.delete('/wt/a');
    expect(await runWorktreeCleanupJob(APP, id)).toEqual({ status: 'identity_changed', dir: '/wt/a' });
    expect(h.remove).not.toHaveBeenCalled();
  });
  it('keeps the job when removal fails', async () => {
    const id = await offered(); h.remove.mockRejectedValueOnce(new Error('busy device'));
    expect(await runWorktreeCleanupJob(APP, id)).toEqual({ status: 'failed', dir: '/wt/a', error: 'busy device' });
    expect(h.jobs.has(id)).toBe(true);
  });
  it('does not run another bot\'s job, a missing job, or an unreadable store', async () => {
    const id = await offered();
    expect(await runWorktreeCleanupJob('cli_other', id)).toEqual({ status: 'not_found' });
    expect(await runWorktreeCleanupJob(APP, 'missing')).toEqual({ status: 'not_found' });
    expect(await runWorktreeCleanupJob(APP, 'corrupt')).toEqual({ status: 'unreadable', error: 'invalid worktree cleanup job store' });
    expect(h.remove).not.toHaveBeenCalled();
  });
});
