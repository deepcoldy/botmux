import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteWorktreeCleanupJob,
  getWorktreeCleanupJob,
  putWorktreeCleanupJob,
} from '../src/services/worktree-cleanup-store.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'worktree-cleanup-store-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('worktree cleanup store', () => {
  it('persists one restart-safe job keyed by normalized worktree path', () => {
    const first = putWorktreeCleanupJob(dataDir, {
      larkAppId: 'app-1',
      worktreeMain: '/repo',
      worktreeDir: '/repo-wt/../repo-wt',
      safetyFingerprint: 'fp-1',
      error: 'busy',
    }, 100);

    const second = putWorktreeCleanupJob(dataDir, {
      larkAppId: 'app-1',
      worktreeMain: '/repo',
      worktreeDir: '/repo-wt',
      safetyFingerprint: 'fp-2',
      error: 'still busy',
    }, 200);

    expect(second.id).toBe(first.id);
    expect(getWorktreeCleanupJob(dataDir, first.id)).toMatchObject({
      worktreeDir: '/repo-wt',
      safetyFingerprint: 'fp-2',
      error: 'still busy',
      createdAt: 100,
      updatedAt: 200,
    });
  });

  it('deletes a completed job durably', () => {
    const job = putWorktreeCleanupJob(dataDir, {
      larkAppId: 'app-1', worktreeMain: '/repo', worktreeDir: '/repo-wt',
      safetyFingerprint: 'fp', error: 'busy',
    });

    expect(deleteWorktreeCleanupJob(dataDir, job.id)).toBe(true);
    expect(getWorktreeCleanupJob(dataDir, job.id)).toBeUndefined();
  });
});
